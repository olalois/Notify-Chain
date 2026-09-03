import * as StellarSDK from '@stellar/stellar-sdk';
import { ContractConfig } from '../types';
import logger from '../utils/logger';
import { generateCorrelationId } from '../utils/request-id';
import { getEventName } from '../utils/event-utils';
import { getNotificationAnalyticsAggregator, NotificationAnalyticsAggregator } from './notification-analytics-aggregator';
import { NotificationType } from '../types/scheduled-notification';
import { calculateBackoffDelay } from './retry-backoff';

export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}

export interface RetryQueueOptions {
  baseDelayMs?: number;
  multiplier?: number;
  jitter?: boolean;
  maxDelayMs?: number;
  maxRetries?: number;
  processIntervalMs?: number;
  priorityWeights?: { high: number; medium: number; low: number };
}

interface RetryItem {
  event: StellarSDK.rpc.Api.EventResponse;
  contractConfig: ContractConfig;
  retryCount: number;
  nextRetryAt: number;
  requestId?: string;
  priority: Priority;
  enqueuedAt: number;
}

const DEFAULTS = {
  baseDelayMs: 5_000,
  multiplier: 2,
  jitter: true,
  maxDelayMs: 60 * 60 * 1_000,
  maxRetries: 5,
  processIntervalMs: 5_000,
  priorityWeights: { high: 5, medium: 2, low: 1 },
};

export type NotificationFn = (
  event: StellarSDK.rpc.Api.EventResponse,
  contractConfig: ContractConfig,
  requestId?: string
) => Promise<boolean>;

export class NotificationRetryQueue {
  private queue: RetryItem[] = [];
  private readonly queuedFingerprints: Set<string> = new Set();
  private readonly baseDelayMs: number;
  private readonly multiplier: number;
  private readonly jitter: boolean;
  private readonly maxDelayMs: number;
  private readonly maxRetries: number;
  private readonly processIntervalMs: number;
  private readonly priorityWeights: { high: number; medium: number; low: number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly notificationFn: NotificationFn;
  private readonly analytics: NotificationAnalyticsAggregator | null;
  private priorityCounters: { high: number; medium: number; low: number } = { high: 0, medium: 0, low: 0 };

  // Metrics
  private metrics = {
    totalEnqueued: 0,
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    processingTimes: [] as number[],
  };

  constructor(notificationFn: NotificationFn, options?: RetryQueueOptions) {
    this.notificationFn = notificationFn;
    this.baseDelayMs = options?.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.multiplier = options?.multiplier ?? DEFAULTS.multiplier;
    this.jitter = options?.jitter ?? DEFAULTS.jitter;
    this.maxDelayMs = options?.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.maxRetries = options?.maxRetries ?? DEFAULTS.maxRetries;
    this.processIntervalMs = options?.processIntervalMs ?? DEFAULTS.processIntervalMs;
    this.priorityWeights = options?.priorityWeights ?? DEFAULTS.priorityWeights;
    this.analytics = getNotificationAnalyticsAggregator();
  }

  enqueue(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId?: string,
    priority: Priority = Priority.Medium
  ): void {
    const correlationId = requestId ?? generateCorrelationId();
    const fingerprint = buildRetryFingerprint(event, contractConfig.address);

    if (this.queuedFingerprints.has(fingerprint)) {
      logger.info('Skipping duplicate retry queue entry', {
        requestId: correlationId,
        correlationId,
        eventId: event.id,
        contractAddress: contractConfig.address,
        fingerprint,
      });
      return;
    }

    const delayMs = this.calculateDelay(0);
    const nextRetryAt = Date.now() + delayMs;

    logger.info('Notification queued for retry', {
      requestId: correlationId,
      correlationId,
      eventId: event.id,
      contractAddress: contractConfig.address,
      delayMs,
      nextRetryAt: new Date(nextRetryAt).toISOString(),
      maxRetries: this.maxRetries,
      priority: Priority[priority],
    });

    this.queuedFingerprints.add(fingerprint);
    this.queue.push({ event, contractConfig, retryCount: 0, nextRetryAt, requestId, priority, enqueuedAt: Date.now() });
    this.metrics.totalEnqueued++;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.processQueue().catch((err) =>
        logger.error('Unexpected error in retry queue processor', { error: err })
      );
    }, this.processIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  size(): number {
    return this.queue.length;
  }

  private async processQueue(): Promise<void> {
    const now = Date.now();
    const due = this.queue
      .filter((item) => item.nextRetryAt <= now)
      .sort((a, b) => {
        const priorityA = this.getWeightedPriority(a);
        const priorityB = this.getWeightedPriority(b);
        if (priorityB !== priorityA) return priorityB - priorityA;
        return a.enqueuedAt - b.enqueuedAt;
      });

    this.queue = this.queue.filter((item) => item.nextRetryAt > now);

    for (const item of due) {
      if (item.priority === Priority.High) this.priorityCounters.high++;
      else if (item.priority === Priority.Medium) this.priorityCounters.medium++;
      else this.priorityCounters.low++;
    }

    for (const item of due) {
      await this.retryItem(item);
    }
  }

  private getWeightedPriority(item: RetryItem): number {
    const basePriority = item.priority;
    const age = Date.now() - item.enqueuedAt;
    const ageBonus = Math.floor(age / 60000);

    let weight = 0;
    if (item.priority === Priority.High) weight = this.priorityWeights.high;
    else if (item.priority === Priority.Medium) weight = this.priorityWeights.medium;
    else weight = this.priorityWeights.low;

    return basePriority + ageBonus + weight;
  }

  private async retryItem(item: RetryItem): Promise<void> {
    const attempt = item.retryCount + 1;
    const fingerprint = buildRetryFingerprint(item.event, item.contractConfig.address);
    const retryStart = Date.now();

    logger.info('Retrying failed notification', {
      requestId: item.requestId,
      correlationId: item.requestId,
      eventId: item.event.id,
      contractAddress: item.contractConfig.address,
      attempt,
      maxRetries: this.maxRetries,
    });

    this.analytics?.record({
      notificationType: NotificationType.DISCORD,
      contractAddress: item.contractConfig.address,
      outcome: 'retry',
      durationMs: 0,
      timestamp: retryStart,
    });

    const success = await this.notificationFn(item.event, item.contractConfig, item.requestId);
    const duration = Date.now() - retryStart;

    if (success) {
      this.queuedFingerprints.delete(fingerprint);
      this.metrics.totalProcessed++;
      this.metrics.totalSucceeded++;
      this.metrics.processingTimes.push(duration);
      this.analytics?.record({
        notificationType: NotificationType.DISCORD,
        contractAddress: item.contractConfig.address,
        outcome: 'success',
        durationMs: Date.now() - retryStart,
        timestamp: Date.now(),
      });
      logger.info('Retry succeeded', {
        requestId: item.requestId,
        correlationId: item.requestId,
        eventId: item.event.id,
        contractAddress: item.contractConfig.address,
        attempt,
      });
      return;
    }

    if (attempt >= this.maxRetries) {
      this.queuedFingerprints.delete(fingerprint);
      this.metrics.totalProcessed++;
      this.metrics.totalFailed++;
      this.metrics.processingTimes.push(duration);
      this.analytics?.record({
        notificationType: NotificationType.DISCORD,
        contractAddress: item.contractConfig.address,
        outcome: 'failure',
        durationMs: duration,
        errorReason: `exhausted ${this.maxRetries} retries`,
        timestamp: Date.now(),
      });
      logger.error('Notification permanently failed after max retries', {
        requestId: item.requestId,
        correlationId: item.requestId,
        eventId: item.event.id,
        contractAddress: item.contractConfig.address,
        totalAttempts: attempt,
      });
      return;
    }

    const delayMs = this.calculateDelay(attempt);
    const nextRetryAt = Date.now() + delayMs;

    logger.warn('Retry failed, scheduling next attempt', {
      requestId: item.requestId,
      correlationId: item.requestId,
      eventId: item.event.id,
      contractAddress: item.contractConfig.address,
      attempt,
      delayMs,
      nextRetryAt: new Date(nextRetryAt).toISOString(),
    });

    this.queue.push({ ...item, retryCount: attempt, nextRetryAt });
  }

  getMetrics() {
    const times = this.metrics.processingTimes;
    const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const min = times.length > 0 ? Math.min(...times) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;

    return {
      queueSize: this.queue.length,
      ...this.metrics,
      processingTime: {
        min,
        max,
        avg,
      },
    };
  }

  private calculateDelay(retryCount: number): number {
    return calculateBackoffDelay(retryCount, {
      baseDelayMs: this.baseDelayMs,
      multiplier: this.multiplier,
      maxDelayMs: this.maxDelayMs,
      jitter: this.jitter,
    });
  }
}

function buildRetryFingerprint(
  event: StellarSDK.rpc.Api.EventResponse,
  contractAddress: string
): string {
  const eventName =
    getEventName(event.topic) ?? event.topic.map((entry) => entry.toString()).join('|');
  return `${contractAddress}:${event.id}:${eventName}:${event.txHash ?? ''}`;
}
