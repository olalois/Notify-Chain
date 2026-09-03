import * as StellarSDK from '@stellar/stellar-sdk';
import { Config, ContractConfig } from '../types';
import { eventRegistry } from '../store/event-registry';
import { preferenceStore } from '../store/preference-store';
import logger from '../utils/logger';
import { generateCorrelationId, generateRequestId } from '../utils/request-id';
import {
  getEventName,
  matchesEventFilter,
  validateEventPayload,
  validateRpcResponse,
} from '../utils/event-utils';
import { DiscordNotificationService } from './discord-notification';
import { NotificationRetryQueue } from './notification-retry-queue';
import { EventDeduplicationService } from './event-deduplication-service';
import { EventProcessingQueue } from './event-processing-queue';
import { NotificationExpirationService } from './notification-expiration';
import { pollingMetrics } from './polling-metrics';

export class EventSubscriber {
  private config: Config;
  private server: StellarSDK.rpc.Server;
  private isRunning: boolean = false;
  private reconnectAttempts: number = 0;
  private lastCursors: Map<string, string> = new Map();
  private discordService: DiscordNotificationService | null = null;
  private retryQueue: NotificationRetryQueue | null = null;
  private deduplicationService: EventDeduplicationService | null = null;
  private eventQueue: EventProcessingQueue | null = null;
  private expirationService: NotificationExpirationService | null = null;
  private lastSuccessfulPollAt: number | null = null;

  constructor(config: Config, deduplicationService?: EventDeduplicationService) {
    this.config = config;
    this.server = new StellarSDK.rpc.Server(config.stellarRpcUrl);
    this.deduplicationService = deduplicationService ?? null;
    
    // Initialize expiration service if configured
    if (config.expiration) {
      this.expirationService = new NotificationExpirationService(config.expiration);
    }
    
    if (config.discord) {
      this.discordService = new DiscordNotificationService(config.discord, undefined, config.retryQueue);
      this.retryQueue = new NotificationRetryQueue(
        (event, contractConfig, requestId) =>
          this.discordService!.sendEventNotification(event, contractConfig, requestId),
        config.retryQueue
      );
    }
    if (config.eventQueue) {
      this.eventQueue = new EventProcessingQueue(
        (event, contractConfig, requestId) =>
          this.processEvent(event, contractConfig, requestId),
        config.eventQueue
      );
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Event subscriber already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting event subscriber service');
    this.eventQueue?.start();
    this.retryQueue?.start();
    this.poll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.eventQueue?.stop();
    this.retryQueue?.stop();
    logger.info('Stopping event subscriber service');
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      const requestId = generateRequestId();
      const pollStart = Date.now();

      try {
        await this.checkForEvents(requestId);
        this.reconnectAttempts = 0;
        this.lastSuccessfulPollAt = Date.now();

        const durationMs = Date.now() - pollStart;
        pollingMetrics.record(durationMs, true);

        logger.info('Poll cycle complete', {
          requestId,
          durationMs,
        });

        await this.delay(this.config.pollIntervalMs);
      } catch (error) {
        const durationMs = Date.now() - pollStart;
        pollingMetrics.record(durationMs, false);

        logger.error('Error polling for events', {
          requestId,
          error,
          durationMs,
        });
        await this.handleReconnection(requestId);
      }
    }
  }

  private async checkForEvents(requestId: string = generateRequestId()): Promise<void> {
    const totalContracts = this.config.contractAddresses.length;
    let failureCount = 0;

    for (const contractConfig of this.config.contractAddresses) {
      try {
        const response = await this.getContractEvents(contractConfig);

        const responseValidation = validateRpcResponse(response);
        if (!responseValidation.valid) {
          logger.error('Rejecting invalid RPC response, skipping contract', {
            requestId,
            contractAddress: contractConfig.address,
            reason: responseValidation.reason,
          });
          continue;
        }

        const events = response.events || [];
        
        // Detect potential reorg if events exist and we have previous state
        if (this.deduplicationService && events.length > 0) {
          const firstEventLedger = events[0]?.ledger;
          if (firstEventLedger) {
            const reorgDetected = await this.deduplicationService.detectReorg(
              contractConfig.address,
              firstEventLedger
            );
            if (reorgDetected) {
              logger.warn('Potential blockchain reorg detected', {
                requestId,
                contractAddress: contractConfig.address,
                eventLedger: firstEventLedger,
              });
            }
          }
        }

        const processableEvents: Array<{
          event: StellarSDK.rpc.Api.EventResponse;
          correlationId: string;
        }> = [];
        for (const [eventIndex, event] of events.entries()) {
          const correlationId = generateCorrelationId();
          try {
            if (this.shouldProcessEvent(event, contractConfig, requestId, correlationId)) {
              processableEvents.push({ event, correlationId });
            }
          } catch (error) {
            logger.warn('Skipping malformed event', {
              requestId,
              correlationId,
              contractAddress: contractConfig.address,
              eventIndex,
              eventId: event?.id,
              eventType: event?.type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const processableEvents = events.filter((event: StellarSDK.rpc.Api.EventResponse) =>
          this.shouldProcessEvent(event, contractConfig, requestId)
        );

        if (events.length > 0) {
          logger.info('Received events', {
            requestId,
            contractAddress: contractConfig.address,
            count: events.length,
            processed: processableEvents.length,
          });
        }

        for (const [eventIndex, processableEvent] of processableEvents.entries()) {
          const { event, correlationId } = processableEvent;
          try {
            if (this.eventQueue) {
              this.eventQueue.enqueue(event, contractConfig, correlationId);
            } else {
              await this.processEvent(event, contractConfig, correlationId);
            }
          } catch (error) {
            logger.warn('Event processing failed; continuing batch', {
              requestId,
              correlationId,
              contractAddress: contractConfig.address,
              eventIndex,
              eventId: event?.id,
              eventType: event?.type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (response.cursor) {
          this.lastCursors.set(contractConfig.address, response.cursor);
          
          // Update cursor in deduplication service if available
          if (this.deduplicationService) {
            const lastEventLedger = events.length > 0 ? events[events.length - 1].ledger : 0;
            await this.deduplicationService.updatePollingCursor(
              contractConfig.address,
              response.cursor,
              lastEventLedger || 0
            );
          }
        }
      } catch (error) {
        failureCount++;
        logger.error('Error fetching events for contract', {
          requestId,
          contractAddress: contractConfig.address,
          error,
        });
      }
    }

    if (totalContracts > 0 && failureCount === totalContracts) {
      throw new Error(
        `Failed to fetch events for all ${totalContracts} configured contract(s)`
      );
    }
  }

  private shouldProcessEvent(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId: string = '',
    correlationId: string = requestId
  ): boolean {
    // Check if event has expired
    if (this.expirationService && !this.expirationService.shouldProcess(event)) {
      const eventName = getEventName(event.topic);
      logger.warn('Skipping expired notification', {
        requestId,
        contractAddress: contractConfig.address,
        eventId: event.id,
        eventName,
        receivedAt: event.receivedAt,
        currentTime: Date.now(),
        reason: 'expired',
      });
      return false;
    }

    const validation = validateEventPayload(event);
    if (!validation.valid) {
      logger.warn('Skipping invalid event payload', {
        requestId,
        correlationId,
        contractAddress: contractConfig.address,
        eventId: event.id,
        reason: validation.reason,
      });
      return false;
    }

    const eventName = getEventName(event.topic);
    if (!matchesEventFilter(eventName, contractConfig.events)) {
      return false;
    }

    return true;
  }

  /**
   * Resolve the ledger to start from on a cold start (no stored cursor).
   *
   * When `backfill.maxLedgers` is 0 the limit is disabled and we start from
   * ledger 1 (original behaviour).  Otherwise we fetch the current network
   * tip and compute `max(1, tip - maxLedgers)`.  The result is cached for
   * the lifetime of this subscriber instance so all contracts share a
   * consistent baseline and the RPC is only called once.
   *
   * If the tip cannot be fetched (RPC error) we fall back to ledger 1 and
   * log a warning so real-time processing is never blocked.
   */
  private async resolveBackfillStartLedger(): Promise<number> {
    const maxLedgers = this.config.backfill?.maxLedgers ?? 10_000;

    // 0 means unlimited — behave exactly as before.
    if (maxLedgers === 0) {
      return 1;
    }

    // Return the cached value if already resolved for this session.
    if (this.backfillStartLedger !== null) {
      return this.backfillStartLedger;
    }

    try {
      const latest: any = await (this.server as any).getLatestLedger();
      const tip: number | null =
        typeof latest?.sequence === 'number'
          ? latest.sequence
          : typeof latest?.ledger === 'number'
            ? latest.ledger
            : typeof latest?.latestLedger === 'number'
              ? latest.latestLedger
              : null;

      if (tip !== null) {
        const startLedger = Math.max(1, tip - maxLedgers);
        this.backfillStartLedger = startLedger;

        logger.warn('Backfill safety limit applied: starting historical replay from ledger', {
          networkTipLedger: tip,
          backfillMaxLedgers: maxLedgers,
          startLedger,
          skippedLedgers: Math.max(0, startLedger - 1),
        });

        return startLedger;
      }
    } catch (err) {
      logger.warn('Failed to fetch network tip for backfill limit; falling back to ledger 1', {
        error: err instanceof Error ? err.message : String(err),
        backfillMaxLedgers: maxLedgers,
      });
    }

    // Fallback: start from genesis so no events are silently skipped.
    return 1;
  }

  private async getContractEvents(
    contractConfig: ContractConfig
  ): Promise<StellarSDK.rpc.Api.GetEventsResponse> {
    const lastCursor = this.lastCursors.get(contractConfig.address);
    const request: StellarSDK.rpc.Api.GetEventsRequest = lastCursor
      ? {
          filters: [
            {
              contractIds: [contractConfig.address],
              type: 'contract',
            },
          ],
          cursor: lastCursor,
          limit: this.config.eventBatchSize,
        }
      : {
          filters: [
            {
              contractIds: [contractConfig.address],
              type: 'contract',
            },
          ],
          startLedger: 1,
          limit: this.config.eventBatchSize,
        };

    let request: StellarSDK.rpc.Api.GetEventsRequest;

    if (lastCursor) {
      // Normal real-time polling: continue from the last known cursor.
      request = {
        filters: [{ contractIds: [contractConfig.address], type: 'contract' }],
        cursor: lastCursor,
        limit: 100,
      };
    } else {
      // Cold start: apply the backfill safety limit.
      const startLedger = await this.resolveBackfillStartLedger();
      request = {
        filters: [{ contractIds: [contractConfig.address], type: 'contract' }],
        startLedger,
        limit: 100,
      };
    }

    return await this.server.getEvents(request);
  }

  private async processEvent(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId: string = '',
    correlationId: string = ''
  ): Promise<boolean> {
    const eventStart = Date.now();
    const eventName = getEventName(event.topic);

    // Check persistent deduplication first (to catch reorg duplicates)
    if (this.deduplicationService) {
      const duplicate = await this.deduplicationService.isDuplicate(event.id, contractConfig.address);
      if (duplicate.isDuplicate) {
        logger.warn('Skipping event: already processed (persistent deduplication)', {
          requestId: correlationId,
          correlationId,
          eventId: event.id,
          contractAddress: contractConfig.address,
          isReorgDuplicate: duplicate.isReorgDuplicate,
        });
        
        // Record that we detected this duplicate
        await this.deduplicationService.recordProcessedEvent(
          event.id,
          contractConfig.address,
          event.ledger,
          event.txHash,
          event.type,
          false, // No notification sent
          'SKIPPED'
        );
        
        return true;
      }
    }

    const displayEvent = eventRegistry.addFromInput({
      eventId: event.id,
      contractAddress: contractConfig.address,
      eventName,
      ledger: event.ledger,
      type: event.type,
      topic: event.topic,
      value: event.value,
      txHash: event.txHash,
    });

    logger.info('Processing event', {
      requestId: correlationId,
      correlationId,
      contractAddress: displayEvent.contractAddress,
      eventId: displayEvent.eventId,
      eventName: displayEvent.eventName,
      ledger: displayEvent.ledger,
      type: displayEvent.type,
      topic: displayEvent.topic,
      value: displayEvent.value,
    });

    let notificationSent = false;
    let processingError: string | undefined;

    if (this.discordService) {
      const userId = contractConfig.userId ?? 'global';
      if (!preferenceStore.isCategoryEnabled(userId, 'discord')) {
        logger.info('Skipping Discord notification: category disabled by user preferences', {
          eventId: event.id,
          userId,
          correlationId,
        });
      } else {
        try {
          const success = await this.discordService.sendEventNotification(
            event,
            contractConfig,
            requestId
          );
          notificationSent = success;

          if (!success && this.retryQueue) {
            logger.warn('Discord notification failed, adding to retry queue', {
              requestId: correlationId,
              correlationId,
              eventId: event.id,
            });
            this.retryQueue.enqueue(event, contractConfig, requestId);
            processingError = 'Initial notification send failed, queued for retry';
          }
        } catch (error) {
          processingError = error instanceof Error ? error.message : String(error);
          logger.error('Error sending Discord notification', {
              requestId: correlationId,
              correlationId,
            eventId: event.id,
            error: processingError,
          });
        }
      }
    }

    // Record the processed event for persistent deduplication
    if (this.deduplicationService) {
      await this.deduplicationService.recordProcessedEvent(
        event.id,
        contractConfig.address,
        event.ledger,
        event.txHash,
        event.type,
        notificationSent,
        processingError ? 'ERROR' : 'PROCESSED',
        processingError
      );
    }

    logger.info('Event processing complete', {
      requestId: correlationId,
      correlationId,
      eventId: event.id,
      notificationSent,
      outcome: !this.discordService || notificationSent ? 'success' : 'failure',
      durationMs: Date.now() - eventStart,
    });

    if (!this.discordService) return true;
    if (notificationSent) return true;
    if (processingError && this.retryQueue) return true;
    return false;
  }

  private async handleReconnection(requestId?: string): Promise<void> {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error('Max reconnection attempts exceeded, stopping service');
      this.stop();
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelayMs * this.reconnectAttempts;
    logger.warn('Attempting to reconnect', {
      requestId,
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    await this.delay(delay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getQueueMetrics() {
    return {
      eventQueue: this.eventQueue?.getMetrics() || null,
      retryQueue: this.retryQueue?.getMetrics() || null,
    };
  }

  getLastSuccessfulPoll(): number | null {
    return this.lastSuccessfulPollAt;
  }
}