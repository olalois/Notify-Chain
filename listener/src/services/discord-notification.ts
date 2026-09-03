import * as StellarSDK from '@stellar/stellar-sdk';
import logger from '../utils/logger';
import { ContractConfig, DiscordConfig } from '../types';
import { getEventName } from '../utils/event-utils';
import { NotificationDeduplicator, generateFingerprint } from './notification-deduplicator';
import { getNotificationAnalyticsAggregator, NotificationAnalyticsAggregator } from './notification-analytics-aggregator';
import { sendWebhook } from './webhook-sender';
import { NotificationType } from '../types/scheduled-notification';
import { generateCorrelationId } from '../utils/request-id';
import { DEFAULT_RETRY_BACKOFF, RetryBackoffConfig, calculateBackoffDelay } from './retry-backoff';

export const MAX_DISCORD_EMBED_LENGTH = 6000;
export const MAX_DISCORD_FIELD_VALUE_LENGTH = 1024;
export const MAX_DISCORD_EMBED_TITLE_LENGTH = 256;
export const MAX_DISCORD_FOOTER_TEXT_LENGTH = 2048;

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

export function createDiscordService(config: DiscordConfig): DiscordNotificationService {
  return new DiscordNotificationService(config);
}

// ---------------------------------------------------------------------------
// Discord content safety
// ---------------------------------------------------------------------------

// Matches @everyone, @here, and all mention syntaxes: <@123>, <@!123>, <@&123>
const MENTION_PATTERN = /@(everyone|here)|<@[!&]?\d+>/g;

// Discord markdown characters that produce unintended formatting in embed content.
// Underscores are intentionally excluded — they are common in Soroban event names
// (e.g. task_created) and only trigger italics in matched-pair contexts.
const MARKDOWN_CHARS = /([*`~|\\])/g;

/**
 * Sanitize user-controlled content before embedding it in a Discord message.
 *
 * - Strips @everyone / @here and all user/role mention syntax so on-chain
 *   string data cannot trigger live Discord pings.
 * - Escapes markdown control characters so the output renders as plain text
 *   rather than accidentally producing bold, code, spoilers, etc.
 *
 * Only needed for content derived from on-chain data. Developer-controlled
 * static strings (embed titles, field labels) don't require it.
 */
export function sanitizeForDiscord(text: string): string {
  return text
    .replace(MENTION_PATTERN, '[mention removed]')
    .replace(MARKDOWN_CHARS, '\\$1');
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP status code into a readable diagnostic category.
 * This keeps log fields actionable without leaking raw status text verbatim.
 */
function classifyHttpStatus(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 404) return 'not_found';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'unexpected';
}

/**
 * Read the response body safely, truncating to avoid bloated logs.
 * Returns null on read failure so callers always get a loggable value.
 */
async function safeReadResponseBody(response: Response, maxLength = 300): Promise<string | null> {
  try {
    const text = await response.text();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return null;
  }
}

export class DiscordNotificationService {
  private config: DiscordConfig;
  private readonly retryBackoff: RetryBackoffConfig;
  private deduplicator: NotificationDeduplicator;
  private timeoutCount: number = 0;
  private readonly analytics: NotificationAnalyticsAggregator | null;

  constructor(
    config: DiscordConfig,
    deduplicator?: NotificationDeduplicator,
    retryBackoff: Partial<RetryBackoffConfig> = {},
  ) {
    this.config = config;
    this.retryBackoff = { ...DEFAULT_RETRY_BACKOFF, ...retryBackoff };
    this.deduplicator =
      deduplicator ??
      new NotificationDeduplicator({
        windowMs: config.deduplicationWindowMs,
        maxSize: config.deduplicationMaxSize,
      });
    this.analytics = getNotificationAnalyticsAggregator();
  }

  async sendEventNotification(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId?: string
  ): Promise<boolean> {
    const correlationId = requestId ?? generateCorrelationId();
    const fingerprint = generateFingerprint(event.id, contractConfig.address);

    if (this.deduplicator.isDuplicate(fingerprint)) {
      this.analytics?.record({
        notificationType: NotificationType.DISCORD,
        contractAddress: contractConfig.address,
        outcome: 'skipped',
        durationMs: 0,
        timestamp: Date.now(),
      });
      logger.info('Skipping duplicate notification', {
        eventId: event.id,
        contractAddress: contractConfig.address,
        requestId: correlationId,
        correlationId,
        fingerprint,
        deduplication: this.deduplicator.getMetrics(),
      });
      return true;
    }
    const logContext = {
      requestId: correlationId,
      correlationId,
      eventId: event.id,
      contractAddress: contractConfig.address,
      webhookId: this.config.webhookId,
    };

    logger.info('Sending Discord notification', logContext);

    const message = this.formatEventMessage(event, contractConfig);
    const maxRetries = this.config.retryCount ?? 5;

    let attempt = 0;
    while (attempt <= maxRetries) {
      const attemptStart = Date.now();
      try {
        const response = await this.sendWebhook(message, logContext);
        const durationMs = Date.now() - attemptStart;

        if (response.ok) {
          this.deduplicator.markSent(fingerprint);
          logger.info('Discord notification sent successfully', {
            eventId: event.id,
            contractAddress: contractConfig.address,
            requestId: correlationId,
            correlationId,
          });
          logger.info('Discord notification delivered', {
            ...logContext,
            durationMs,
            attempt,
          });
          return true;
        }

        const responseCategory = classifyHttpStatus(response.status);
        const errorBody = await safeReadResponseBody(response);
        this.analytics?.record({
          notificationType: NotificationType.DISCORD,
          contractAddress: contractConfig.address,
          outcome: 'failure',
          durationMs,
          errorReason: `HTTP ${response.status}`,
          timestamp: Date.now(),
        });
        logger.error('Discord webhook delivery failed', {
          ...logContext,
          httpStatus: response.status,
          httpCategory: responseCategory,
          ...(responseCategory === 'rate_limited' && { retryAfter: response.headers?.get('retry-after') }),
          errorSummary: errorBody,
          durationMs,
          attempt,
        });
      } catch (error) {
        const durationMs = Date.now() - attemptStart;
        logger.error('Discord webhook request error', {
          ...logContext,
          error,
          durationMs,
          attempt,
        });
      }

      // If we've exhausted retries, break and return false
      if (attempt >= maxRetries) break;

      const delayMs = calculateBackoffDelay(attempt, this.retryBackoff);
      logger.warn('Retrying Discord webhook', {
        ...logContext,
        delayMs,
        attempt,
      });

      await this.delay(delayMs);
      attempt++;
    }

    logger.error('Exceeded max Discord retry attempts', {
      ...logContext,
      maxRetries,
    });
    return false;
  }

  getMetrics() {
    return {
      ...this.deduplicator.getMetrics(),
      timeoutCount: this.timeoutCount,
    };
  }

  getDeduplicationMetrics() {
    return this.deduplicator.getMetrics();
  }

  async sendTestMessage(requestId?: string): Promise<boolean> {
    const message: DiscordMessage = {
      embeds: [
        {
          title: '✅ Test Notification',
          description: 'Discord webhook is working correctly!',
          color: 0x00ff00,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const logContext = { requestId, webhookId: this.config.webhookId };
    logger.info('Sending Discord test message', logContext);

    const startTime = Date.now();

    try {
      const response = await this.sendWebhook(message, logContext);
      const durationMs = Date.now() - startTime;

      if (response.ok) {
        logger.info('Discord test message delivered', { ...logContext, durationMs });
        return true;
      }

      const errorBody = await safeReadResponseBody(response);
      logger.error('Discord test message failed', {
        ...logContext,
        httpStatus: response.status,
        httpCategory: classifyHttpStatus(response.status),
        errorSummary: errorBody,
        durationMs,
      });
      return false;
    } catch (error) {
      logger.error('Discord test message request error', {
        ...logContext,
        error,
        durationMs: Date.now() - startTime,
      });
      return false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendWebhook(message: DiscordMessage, logContext?: Record<string, unknown>): Promise<Response> {
    try {
      const response = await sendWebhook(this.config.webhookUrl, message, {
        timeoutMs: this.config.timeoutMs,
      });
      return response;
    } catch (error: any) {
      if (error && error.name === 'AbortError') {
        this.timeoutCount++;
        logger.error('Discord webhook request timed out', {
          ...logContext,
          webhookId: this.config.webhookId,
          timeoutMs: this.config.timeoutMs ?? 5000,
        });
      }
      throw error;
    }
  }

  private formatEventMessage(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig
  ): DiscordMessage {
    const eventName = sanitizeForDiscord(getEventName(event.topic) ?? 'Unknown Event');
    const embed = this.createEventEmbed(event, contractConfig, eventName);
    const sanitizedEmbed = this.sanitizeEmbed(embed);

    return {
      embeds: [sanitizedEmbed],
    };
  }

  private createEventEmbed(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    eventName: string
  ): DiscordEmbed {
    const fields: { name: string; value: string; inline?: boolean }[] = [
      {
        name: 'Contract',
        value: this.formatAddress(contractConfig.address),
        inline: true,
      },
      {
        name: 'Ledger',
        value: String(event.ledger),
        inline: true,
      },
      {
        name: 'Type',
        value: sanitizeForDiscord(event.type),
        inline: true,
      },
    ];

    if (event.value) {
      fields.push({
        name: 'Value',
        value: this.formatValue(event.value),
        inline: false,
      });
    }

    return {
      title: `📡 Event: ${eventName}`,
      color: this.getEventColor(event.type),
      timestamp: new Date().toISOString(),
      fields,
    };
  }

  private getEventColor(eventType: string): number {
    const colors: Record<string, number> = {
      system: 0x0099ff,
      contract: 0x00ff00,
      transaction: 0xffaa00,
    };
    return colors[eventType] || 0x808080;
  }

  getEmbedLength(embed: DiscordEmbed): number {
    let length = 0;
    if (embed.title) length += embed.title.length;
    if (embed.description) length += embed.description.length;
    if (embed.fields) {
      for (const field of embed.fields) {
        length += field.name.length;
        length += field.value.length;
      }
    }
    if (embed.footer?.text) length += embed.footer.text.length;
    return length;
  }

  sanitizeEmbed(embed: DiscordEmbed): DiscordEmbed {
    let title = embed.title ?? '';
    if (title.length > MAX_DISCORD_EMBED_TITLE_LENGTH) {
      title = title.slice(0, MAX_DISCORD_EMBED_TITLE_LENGTH - 3) + '...';
      logger.warn('Discord embed title truncated', {
        originalLength: embed.title.length,
        maxLength: MAX_DISCORD_EMBED_TITLE_LENGTH,
      });
    }

    const fields = embed.fields?.map(field => {
      let value = field.value;
      if (value.length > MAX_DISCORD_FIELD_VALUE_LENGTH) {
        value = value.slice(0, MAX_DISCORD_FIELD_VALUE_LENGTH - 3) + '...';
        logger.warn('Discord field value truncated', {
          fieldName: field.name,
          originalLength: field.value.length,
          maxLength: MAX_DISCORD_FIELD_VALUE_LENGTH,
        });
      }
      return { ...field, value };
    });

    let footer = embed.footer;
    if (footer?.text && footer.text.length > MAX_DISCORD_FOOTER_TEXT_LENGTH) {
      footer = { text: footer.text.slice(0, MAX_DISCORD_FOOTER_TEXT_LENGTH - 3) + '...' };
      logger.warn('Discord footer text truncated', {
        originalLength: embed.footer.text.length,
        maxLength: MAX_DISCORD_FOOTER_TEXT_LENGTH,
      });
    }

    let sanitized: DiscordEmbed = { ...embed, title, fields, footer };

    const totalLength = this.getEmbedLength(sanitized);
    if (totalLength > MAX_DISCORD_EMBED_LENGTH) {
      const excess = totalLength - MAX_DISCORD_EMBED_LENGTH;
      const valueFieldIndex = sanitized.fields?.findIndex(f => f.name === 'Value');

      if (valueFieldIndex !== undefined && valueFieldIndex >= 0 && sanitized.fields && sanitized.fields[valueFieldIndex]) {
        const currentValue = sanitized.fields[valueFieldIndex].value;
        const newValueLength = Math.max(0, currentValue.length - excess);
        const newValue =
          newValueLength < currentValue.length
            ? currentValue.slice(0, newValueLength - 3) + '...'
            : currentValue;

        sanitized = {
          ...sanitized,
          fields: sanitized.fields.map((f, i) =>
            i === valueFieldIndex ? { ...f, value: newValue } : f
          ),
        };

        logger.warn('Discord embed truncated to fit size limit', {
          originalLength: totalLength,
          maxLength: MAX_DISCORD_EMBED_LENGTH,
        });
      }
    }

    return sanitized;
  }

  private formatAddress(address: string): string {
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-8)}`;
  }

  private formatValue(value: StellarSDK.xdr.ScVal): string {
    try {
      switch (value.switch()) {
        case StellarSDK.xdr.ScValType.scvVoid():
          return '_No data_';
        case StellarSDK.xdr.ScValType.scvU64():
          return String(value.u64());
        case StellarSDK.xdr.ScValType.scvI64():
          return String(value.i64());
        case StellarSDK.xdr.ScValType.scvString(): {
          const strVal = value.str().toString();
          return strVal.length > MAX_DISCORD_FIELD_VALUE_LENGTH ? strVal.slice(0, MAX_DISCORD_FIELD_VALUE_LENGTH) + '...' : strVal;
          const truncated = strVal.length > 500 ? strVal.slice(0, 500) + '...' : strVal;
          return sanitizeForDiscord(truncated);
        }
        case StellarSDK.xdr.ScValType.scvSymbol():
          return `🔹 ${sanitizeForDiscord(value.sym().toString())}`;
        case StellarSDK.xdr.ScValType.scvAddress():
          return this.formatAddress(value.address().toString());
        default:
          return JSON.stringify(value).slice(0, MAX_DISCORD_FIELD_VALUE_LENGTH);
      }
    } catch {
      return String(value);
    }
  }
}

