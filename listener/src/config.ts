import { Config, ContractConfig, DiscordConfig, WebhookSecret, AppCleanupConfig, EventQueueConfig, RetrySchedulerOptions, AnalyticsConfig, ExpirationConfig, ApiKey } from './types';
import { validateCorsOrigin, CorsValidationError } from './utils/cors-validator';
import { ConfigurationSchemaValidator, APP_CONFIG_SCHEMA } from './config-schema';
import { Config, ContractConfig, DiscordConfig, WebhookSecret, AppCleanupConfig, EventQueueConfig, RetrySchedulerOptions, AnalyticsConfig, ExpirationConfig, ApiKey, BackfillConfig, LoggingConfig, ApiConfig } from './types';
import {
  SUPPORTED_LOG_FORMATS,
  SUPPORTED_LOG_LEVELS,
  parseLogFormat,
  parseLogLevel,
} from './utils/logger';
import { DEFAULT_MAX_BODY_BYTES } from './middleware/body-limit';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function trimEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

// Environment variables the listener cannot safely start without.
// Keep this list in sync with the "Required" column in
// ENVIRONMENT_VARIABLES_AND_SECRETS.md.
const REQUIRED_ENV_VARS = ['CONTRACT_ADDRESSES'];

function validateRequiredEnvVars(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !trimEnv(name));

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and set them before starting the listener.'
    );
  }
}

function parseIntegerEnv(name: string, defaultValue: string): number {
  const rawValue = trimEnv(name);
  const value = rawValue !== undefined ? rawValue : defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${name} must be a valid integer, got "${value}"`);
  }
  return parsed;
}

function parseJsonEnv<T>(name: string, defaultValue: string): T {
  const rawValue = trimEnv(name) ?? defaultValue;
  try {
    return JSON.parse(rawValue) as T;
  } catch {
    throw new ConfigError(`${name} must be valid JSON. Received: ${rawValue}`);
  }
}

function validateContractAddresses(value: unknown): ContractConfig[] {
  if (!Array.isArray(value)) {
    throw new ConfigError('CONTRACT_ADDRESSES must be a JSON array of contract objects.');
  }

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new ConfigError(`CONTRACT_ADDRESSES[${index}] must be an object with address and events.`);
    }

    const address = (item as any).address;
    const events = (item as any).events;

    if (typeof address !== 'string' || !address.trim()) {
      throw new ConfigError(`CONTRACT_ADDRESSES[${index}].address must be a non-empty string.`);
    }

    if (!Array.isArray(events) || events.some((event) => typeof event !== 'string')) {
      throw new ConfigError(
        `CONTRACT_ADDRESSES[${index}].events must be an array of string event names.`
      );
    }

    return {
      address: address.trim(),
      events: events.map((event) => event.trim()),
    };
  });
}

function loadDiscordConfig(): DiscordConfig | undefined {
  const webhookUrl = trimEnv('DISCORD_WEBHOOK_URL');
  const webhookId = trimEnv('DISCORD_WEBHOOK_ID');

  if (!webhookUrl && !webhookId) {
    return undefined;
  }

  if (!webhookUrl) {
    throw new ConfigError('DISCORD_WEBHOOK_URL is required when DISCORD_WEBHOOK_ID is provided.');
  }

  if (!webhookId) {
    throw new ConfigError('DISCORD_WEBHOOK_ID is required when DISCORD_WEBHOOK_URL is provided.');
  }

  return {
    webhookUrl,
    webhookId,
    deduplicationWindowMs: parseIntegerEnv('NOTIFICATION_DEDUPLICATION_WINDOW_MS', '60000'),
    deduplicationMaxSize: parseIntegerEnv('NOTIFICATION_DEDUPLICATION_MAX_SIZE', '10000'),
  };
}

function validateWebhookSecrets(value: unknown): WebhookSecret[] {
  if (!Array.isArray(value)) {
    throw new ConfigError('WEBHOOK_SECRETS must be a JSON array of secret objects.');
  }

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new ConfigError(
        `WEBHOOK_SECRETS[${index}] must be an object with id and secret.`
      );
    }

    const id = (item as any).id;
    const secret = (item as any).secret;

    if (typeof id !== 'string' || !id.trim()) {
      throw new ConfigError(`WEBHOOK_SECRETS[${index}].id must be a non-empty string.`);
    }

    if (typeof secret !== 'string' || !secret.trim()) {
      throw new ConfigError(`WEBHOOK_SECRETS[${index}].secret must be a non-empty string.`);
    }

    return { id: id.trim(), secret: secret.trim() };
  });
}

function validateApiKeys(value: unknown): ApiKey[] {
  if (!Array.isArray(value)) {
    throw new ConfigError('API_KEYS must be a JSON array of key objects.');
  }

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new ConfigError(
        `API_KEYS[${index}] must be an object with key (and optional name).`
      );
    }

    const key = (item as any).key;
    const name = (item as any).name;

    if (typeof key !== 'string' || !key.trim()) {
      throw new ConfigError(`API_KEYS[${index}].key must be a non-empty string.`);
    }

    return { key: key.trim(), name: name?.trim() };
  });
}

function loadCleanupConfig(): AppCleanupConfig {
  return {
    intervalMs: parseIntegerEnv('CLEANUP_INTERVAL_MS', String(60 * 60 * 1000)),
    notificationRetentionMs: parseIntegerEnv('NOTIFICATION_RETENTION_MS', String(7 * 24 * 60 * 60 * 1000)),
    rateLimitEventRetentionMs: parseIntegerEnv('RATE_LIMIT_EVENT_RETENTION_MS', String(24 * 60 * 60 * 1000)),
    eventRetentionMs: parseIntegerEnv('EVENT_RETENTION_MS', String(24 * 60 * 60 * 1000)),
    processedEventRetentionMs: parseIntegerEnv(
      'PROCESSED_EVENT_RETENTION_MS',
      String(30 * 24 * 60 * 60 * 1000),
    ),
    executionLogRetentionMs: parseIntegerEnv(
      'EXECUTION_LOG_RETENTION_MS',
      String(90 * 24 * 60 * 60 * 1000),
    ),
  };
}

function loadAnalyticsConfig(): AnalyticsConfig {
  return {
    enabled: trimEnv('ANALYTICS_ENABLED') !== 'false',
    maxRecords: parseIntegerEnv('ANALYTICS_MAX_RECORDS', '10000'),
    maxBuckets: parseIntegerEnv('ANALYTICS_MAX_BUCKETS', '168'),
    bucketSizeMs: parseIntegerEnv('ANALYTICS_BUCKET_SIZE_MS', String(60 * 60 * 1000)),
    persistIntervalMs: parseIntegerEnv('ANALYTICS_PERSIST_INTERVAL_MS', '300000'),
    snapshotRetentionDays: parseIntegerEnv('ANALYTICS_SNAPSHOT_RETENTION_DAYS', '30'),
  };
}

function loadRetrySchedulerConfig(): RetrySchedulerOptions {
  return {
    enabled: trimEnv('RETRY_SCHEDULER_ENABLED') !== 'false',
    pollIntervalMs: parseIntegerEnv('RETRY_SCHEDULER_POLL_INTERVAL_MS', '15000'),
    lockTimeoutMs: parseIntegerEnv('RETRY_SCHEDULER_LOCK_TIMEOUT_MS', '60000'),
    processorId: trimEnv('RETRY_SCHEDULER_PROCESSOR_ID'),
    batchSize: parseIntegerEnv('RETRY_SCHEDULER_BATCH_SIZE', '10'),
    baseDelayMs: parseIntegerEnv('RETRY_BASE_DELAY_MS', '5000'),
    multiplier: parseIntegerEnv('RETRY_MULTIPLIER', '2'),
    maxDelayMs: parseIntegerEnv('RETRY_MAX_DELAY_MS', String(60 * 60 * 1000)),
    jitter: trimEnv('RETRY_JITTER') !== 'false',
  };
}

function loadExpirationConfig(): ExpirationConfig {
  const defaultExpirationMs = parseIntegerEnv('EXPIRATION_DEFAULT_MS', String(24 * 60 * 60 * 1000));
  const perEventTypeExpirationJson = trimEnv('EXPIRATION_PER_EVENT_TYPE');
  let perEventTypeExpiration: Record<string, number> | undefined;
  
  if (perEventTypeExpirationJson) {
    try {
      perEventTypeExpiration = JSON.parse(perEventTypeExpirationJson);
      if (typeof perEventTypeExpiration !== 'object' || perEventTypeExpiration === null || Array.isArray(perEventTypeExpiration)) {
        throw new ConfigError('EXPIRATION_PER_EVENT_TYPE must be a valid JSON object');
      }
    } catch (e) {
      if (e instanceof ConfigError) {
        throw e;
      }
      throw new ConfigError(`EXPIRATION_PER_EVENT_TYPE must be valid JSON. Received: ${perEventTypeExpirationJson}`);
    }
  }
  
  return {
    defaultExpirationMs,
    perEventTypeExpiration,
    enabled: trimEnv('EXPIRATION_ENABLED') !== 'false',
  };
}

/**
 * Load backfill safety configuration.
 *
 * BACKFILL_MAX_LEDGERS controls how many ledgers behind the network tip the
 * listener will start from when it has no persisted cursor (cold start or
 * after downtime).  Setting it to 0 restores the original unlimited behaviour.
 *
 * Default: 10 000 ledgers (~14 hours at ~5 s/ledger on Stellar).
 */
function loadBackfillConfig(): BackfillConfig {
  return {
    maxLedgers: parseIntegerEnv('BACKFILL_MAX_LEDGERS', '10000'),
  };
}

export function loadConfig(): Config {
  validateRequiredEnvVars();

  const discord = loadDiscordConfig();
  const rawContractAddresses = parseJsonEnv<unknown>('CONTRACT_ADDRESSES', '[]');
  const rawWebhookSecrets = parseJsonEnv<unknown>('WEBHOOK_SECRETS', '[]');
  const rawApiKeys = parseJsonEnv<unknown>('API_KEYS', '[]');
  const clientOverrides = parseJsonEnv<Record<string, { maxRequests: number; windowMs?: number }>>(
    'RATE_LIMIT_CLIENT_OVERRIDES',
    '{}'
  );

  return {
    stellarNetwork: trimEnv('STELLAR_NETWORK') || 'testnet',
    stellarRpcUrl:
      trimEnv('STELLAR_RPC_URL') || 'https://soroban-testnet.stellar.org:443',
    stellarNetworkPassphrase: trimEnv('STELLAR_NETWORK_PASSPHRASE') || 'Test SDF Network ; September 2015',
    contractAddresses: validateContractAddresses(rawContractAddresses),
    pollIntervalMs: parseIntegerEnv('POLL_INTERVAL_MS', '30000'),
    eventBatchSize: parseIntegerEnv('EVENT_BATCH_SIZE', '100'),
    maxReconnectAttempts: parseIntegerEnv('MAX_RECONNECT_ATTEMPTS', '5'),
    reconnectDelayMs: parseIntegerEnv('RECONNECT_DELAY_MS', '5000'),
    eventsApiPort: parseIntegerEnv('EVENTS_API_PORT', '8787'),
    eventsApiCorsOrigin: trimEnv('EVENTS_API_CORS_ORIGIN') || 'http://localhost:5173',
    databasePath: trimEnv('DATABASE_PATH') || './data/notifications.db',
    discord,
    retryQueue: {
      baseDelayMs: parseIntegerEnv('RETRY_BASE_DELAY_MS', '5000'),
      maxRetries: parseIntegerEnv('RETRY_MAX_RETRIES', '5'),
      multiplier: parseIntegerEnv('RETRY_MULTIPLIER', '2'),
      jitter: trimEnv('RETRY_JITTER') !== 'false',
      maxDelayMs: parseIntegerEnv('RETRY_MAX_DELAY_MS', String(60 * 60 * 1000)),
      processIntervalMs: parseIntegerEnv('RETRY_QUEUE_PROCESS_INTERVAL_MS', '5000'),
    },
    eventQueue: {
      maxConcurrency: parseIntegerEnv('EVENT_QUEUE_MAX_CONCURRENCY', '1'),
      maxRetries: parseIntegerEnv('EVENT_QUEUE_MAX_RETRIES', '3'),
      baseDelayMs: parseIntegerEnv('EVENT_QUEUE_BASE_DELAY_MS', '2000'),
      pollIntervalMs: parseIntegerEnv('EVENT_QUEUE_POLL_INTERVAL_MS', '1000'),
    },
    webhookSecrets: validateWebhookSecrets(rawWebhookSecrets),
    apiKeys: validateApiKeys(rawApiKeys),
    scheduler: {
      enabled: trimEnv('SCHEDULER_ENABLED') !== 'false',
      pollIntervalMs: parseIntegerEnv('SCHEDULER_POLL_INTERVAL_MS', '10000'),
      lockTimeoutMs: parseIntegerEnv('SCHEDULER_LOCK_TIMEOUT_MS', '60000'),
      processorId: trimEnv('SCHEDULER_PROCESSOR_ID'),
      batchSize: parseIntegerEnv('SCHEDULER_BATCH_SIZE', '10'),
      timingBufferMs: parseIntegerEnv('SCHEDULER_TIMING_BUFFER_MS', '60000'),
    },
    retryScheduler: loadRetrySchedulerConfig(),
    rateLimit: {
      enabled: trimEnv('RATE_LIMIT_ENABLED') !== 'false',
      windowMs: parseIntegerEnv('RATE_LIMIT_WINDOW_MS', '60000'),
      maxRequests: parseIntegerEnv('RATE_LIMIT_MAX_REQUESTS', '60'),
      clientOverrides,
    },
    cleanup: loadCleanupConfig(),
    analytics: loadAnalyticsConfig(),
    expiration: loadExpirationConfig(),
    backfill: loadBackfillConfig(),
    logging: loadLoggingConfig(),
    api: loadApiConfig(),
  };
}

/**
 * Observability settings.
 *
 * Raw strings are carried through and validated in `validateConfig`, matching
 * how the rest of this loader works: collect everything, then report every
 * problem at once rather than throwing on the first bad field.
 */
function loadLoggingConfig(): LoggingConfig {
  return {
    level: trimEnv('LOG_LEVEL') || 'info',
    // Preserves the previous implicit behaviour when LOG_FORMAT is unset:
    // JSON in production, human-readable elsewhere.
    format:
      trimEnv('LOG_FORMAT') ||
      (process.env.NODE_ENV === 'production' ? 'json' : 'pretty'),
  };
}

/** HTTP surface settings. */
function loadApiConfig(): ApiConfig {
  return {
    maxBodyBytes: parseIntegerEnv('API_MAX_BODY_BYTES', String(DEFAULT_MAX_BODY_BYTES)),
  };
}

/**
 * Validate a fully-loaded Config object and throw a descriptive ConfigError
 * for every invalid value found.  Call this immediately after `loadConfig()`
 * so that misconfigured services never start processing events (#494).
 *
 * All violations are collected before throwing so operators see every problem
 * in a single error message rather than having to fix-and-restart repeatedly.
 */
export function validateConfig(config: Config): void {
  const errors: string[] = [];

  // ── Network ────────────────────────────────────────────────────────────────
  // Validate RPC URL format
  if (!config.stellarRpcUrl) {
    errors.push('STELLAR_RPC_URL must be a non-empty string.');
  } else {
    try {
      const url = new URL(config.stellarRpcUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.push(
          `STELLAR_RPC_URL must use HTTP or HTTPS protocol (received: "${url.protocol}").`,
        );
      }
    } catch {
      errors.push(
        `STELLAR_RPC_URL is not a valid URL (received: "${config.stellarRpcUrl}").`,
      );
    }
  }

  if (!config.stellarNetworkPassphrase || config.stellarNetworkPassphrase.trim() === '') {
    errors.push('STELLAR_NETWORK_PASSPHRASE must be a non-empty string.');
  }

  // Validate network passphrase matches common Stellar networks
  if (config.stellarNetworkPassphrase) {
    const knownPassphrases = [
      'Test SDF Network ; September 2015',
      'Public Global Stellar Network ; September 2015',
    ];
    const isKnown = knownPassphrases.some(
      (known) => config.stellarNetworkPassphrase.trim() === known,
    );
    if (!isKnown && config.stellarNetwork !== 'standalone') {
      errors.push(
        `STELLAR_NETWORK_PASSPHRASE does not match known Stellar networks. ` +
          `Expected one of: ${knownPassphrases.join(', ')} ` +
          `(received: "${config.stellarNetworkPassphrase}").`,
      );
    }
  }

  // ── Database path ──────────────────────────────────────────────────────────
  if (!config.databasePath || config.databasePath.trim() === '') {
    errors.push('DATABASE_PATH must be a non-empty string.');
  }

  // ── Polling ────────────────────────────────────────────────────────────────
  if (config.pollIntervalMs < 1000) {
    errors.push(
      `POLL_INTERVAL_MS must be at least 1000 ms to avoid excessive RPC load ` +
        `(received: ${config.pollIntervalMs}).`,
    );
  }

  if (config.eventBatchSize < 1) {
    errors.push(`EVENT_BATCH_SIZE must be >= 1 (received: ${config.eventBatchSize}).`);
  }

  if (config.maxReconnectAttempts < 1) {
    errors.push(
      `MAX_RECONNECT_ATTEMPTS must be >= 1 (received: ${config.maxReconnectAttempts}).`,
    );
  }

  if (config.reconnectDelayMs < 0) {
    errors.push(
      `RECONNECT_DELAY_MS must be >= 0 (received: ${config.reconnectDelayMs}).`,
    );
  }

  // ── API server ─────────────────────────────────────────────────────────────
  if (config.eventsApiPort < 1 || config.eventsApiPort > 65535) {
    errors.push(
      `EVENTS_API_PORT must be between 1 and 65535 (received: ${config.eventsApiPort}).`,
    );
  }

  // Validate CORS configuration during startup (#689)
  if (config.eventsApiCorsOrigin) {
    try {
      validateCorsOrigin({
        corsOrigin: config.eventsApiCorsOrigin,
        nodeEnv: process.env.NODE_ENV,
      });
    } catch (corsErr) {
      if (corsErr instanceof CorsValidationError) {
        errors.push(`EVENTS_API_CORS_ORIGIN: ${corsErr.message}`);
      } else {
        errors.push(`EVENTS_API_CORS_ORIGIN invalid: ${String(corsErr)}`);
      }
    }
  }

  // ── Contract addresses ─────────────────────────────────────────────────────
  if (!Array.isArray(config.contractAddresses)) {
    errors.push('CONTRACT_ADDRESSES must be a JSON array.');
  } else {
    if (config.contractAddresses.length === 0) {
      errors.push(
        'CONTRACT_ADDRESSES is empty. The listener requires at least one contract to monitor. ' +
          'Add contract configurations or the service will not process any events.',
      );
    }
    
    config.contractAddresses.forEach((contract, index) => {
      if (!contract.address || typeof contract.address !== 'string') {
        errors.push(`CONTRACT_ADDRESSES[${index}].address must be a non-empty string.`);
      } else {
        // Validate Stellar contract address format (starts with 'C' and is 56 chars)
        const trimmedAddress = contract.address.trim();
        if (trimmedAddress.length !== 56) {
          errors.push(
            `CONTRACT_ADDRESSES[${index}].address must be exactly 56 characters ` +
              `(received: ${trimmedAddress.length} characters).`,
          );
        }
        if (!trimmedAddress.startsWith('C')) {
          errors.push(
            `CONTRACT_ADDRESSES[${index}].address must start with 'C' for Stellar contracts ` +
              `(received: "${trimmedAddress.substring(0, 1)}").`,
          );
        }
      }
      
      if (!Array.isArray(contract.events) || contract.events.length === 0) {
        errors.push(
          `CONTRACT_ADDRESSES[${index}].events must be a non-empty array of event names.`,
        );
      } else {
        // Validate event names are not empty
        contract.events.forEach((event, eventIndex) => {
          if (typeof event !== 'string' || event.trim() === '') {
            errors.push(
              `CONTRACT_ADDRESSES[${index}].events[${eventIndex}] must be a non-empty string.`,
            );
          }
        });
      }
    });
  }

  // ── Discord ────────────────────────────────────────────────────────────────
  if (config.discord) {
    if (!config.discord.webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      errors.push(
        'DISCORD_WEBHOOK_URL must start with "https://discord.com/api/webhooks/". ' +
          'Verify the URL copied from Discord server settings.',
      );
    }
    if (!config.discord.webhookId || config.discord.webhookId.trim() === '') {
      errors.push('DISCORD_WEBHOOK_ID must be a non-empty string.');
    }
    if (
      config.discord.deduplicationWindowMs !== undefined &&
      config.discord.deduplicationWindowMs < 0
    ) {
      errors.push(
        `NOTIFICATION_DEDUPLICATION_WINDOW_MS must be >= 0 ` +
          `(received: ${config.discord.deduplicationWindowMs}).`,
      );
    }
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────
  if (config.scheduler) {
    if (config.scheduler.pollIntervalMs < 1000) {
      errors.push(
        `SCHEDULER_POLL_INTERVAL_MS must be >= 1000 ms ` +
          `(received: ${config.scheduler.pollIntervalMs}).`,
      );
    }
    if (config.scheduler.lockTimeoutMs < config.scheduler.pollIntervalMs) {
      errors.push(
        'SCHEDULER_LOCK_TIMEOUT_MS must be >= SCHEDULER_POLL_INTERVAL_MS to avoid ' +
          'premature lock expiry. Increase SCHEDULER_LOCK_TIMEOUT_MS or reduce ' +
          'SCHEDULER_POLL_INTERVAL_MS.',
      );
    }
    if (config.scheduler.batchSize < 1) {
      errors.push(`SCHEDULER_BATCH_SIZE must be >= 1 (received: ${config.scheduler.batchSize}).`);
    }
  }

  // ── Retry scheduler ────────────────────────────────────────────────────────
  const retryBackoff = config.retryQueue;
  if (retryBackoff) {
    if (retryBackoff.baseDelayMs !== undefined && retryBackoff.baseDelayMs < 0) {
      errors.push(`RETRY_BASE_DELAY_MS must be >= 0 (received: ${retryBackoff.baseDelayMs}).`);
    }
    if (retryBackoff.multiplier !== undefined && retryBackoff.multiplier < 1) {
      errors.push(`RETRY_MULTIPLIER must be >= 1 (received: ${retryBackoff.multiplier}).`);
    }
    if (retryBackoff.maxDelayMs !== undefined && retryBackoff.maxDelayMs <= 0) {
      errors.push(`RETRY_MAX_DELAY_MS must be > 0 (received: ${retryBackoff.maxDelayMs}).`);
    }
    if (
      retryBackoff.baseDelayMs !== undefined &&
      retryBackoff.maxDelayMs !== undefined &&
      retryBackoff.maxDelayMs < retryBackoff.baseDelayMs
    ) {
      errors.push(
        'RETRY_MAX_DELAY_MS must be >= RETRY_BASE_DELAY_MS. ' +
          `Received max=${retryBackoff.maxDelayMs}, base=${retryBackoff.baseDelayMs}.`,
      );
    }
  }

  if (config.retryScheduler) {
    if (config.retryScheduler.pollIntervalMs < 1000) {
      errors.push(
        `RETRY_SCHEDULER_POLL_INTERVAL_MS must be >= 1000 ms ` +
          `(received: ${config.retryScheduler.pollIntervalMs}).`,
      );
    }
    if (config.retryScheduler.baseDelayMs < 0) {
      errors.push(
        `RETRY_BASE_DELAY_MS must be >= 0 (received: ${config.retryScheduler.baseDelayMs}).`,
      );
    }
    if (config.retryScheduler.multiplier < 1) {
      errors.push(
        `RETRY_MULTIPLIER must be >= 1 (received: ${config.retryScheduler.multiplier}). ` +
          'A multiplier below 1 would cause retry delays to shrink, not grow.',
      );
    }
    if (config.retryScheduler.maxDelayMs < config.retryScheduler.baseDelayMs) {
      errors.push(
        'RETRY_MAX_DELAY_MS must be >= RETRY_BASE_DELAY_MS. ' +
          `Received max=${config.retryScheduler.maxDelayMs}, base=${config.retryScheduler.baseDelayMs}.`,
      );
    }
    if (config.retryScheduler.batchSize < 1) {
      errors.push(
        `RETRY_SCHEDULER_BATCH_SIZE must be >= 1 (received: ${config.retryScheduler.batchSize}).`,
      );
    }
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────
  if (config.rateLimit) {
    if (config.rateLimit.windowMs < 1000) {
      errors.push(
        `RATE_LIMIT_WINDOW_MS must be >= 1000 ms (received: ${config.rateLimit.windowMs}).`,
      );
    }
    if (config.rateLimit.maxRequests < 1) {
      errors.push(
        `RATE_LIMIT_MAX_REQUESTS must be >= 1 (received: ${config.rateLimit.maxRequests}).`,
      );
    }
  }

  // ── Analytics ─────────────────────────────────────────────────────────────
  if (config.analytics) {
    if (config.analytics.maxRecords < 1) {
      errors.push(
        `ANALYTICS_MAX_RECORDS must be >= 1 (received: ${config.analytics.maxRecords}).`,
      );
    }
    if (config.analytics.bucketSizeMs < 60_000) {
      errors.push(
        `ANALYTICS_BUCKET_SIZE_MS must be >= 60000 ms (1 minute) ` +
          `(received: ${config.analytics.bucketSizeMs}).`,
      );
    }
    if (config.analytics.snapshotRetentionDays < 1) {
      errors.push(
        `ANALYTICS_SNAPSHOT_RETENTION_DAYS must be >= 1 ` +
          `(received: ${config.analytics.snapshotRetentionDays}).`,
      );
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  if (config.cleanup) {
    if (config.cleanup.intervalMs < 60_000) {
      errors.push(
        `CLEANUP_INTERVAL_MS must be >= 60000 ms (1 minute) ` +
          `(received: ${config.cleanup.intervalMs}).`,
      );
    }
    if (config.cleanup.notificationRetentionMs < 60_000) {
      errors.push(
        `NOTIFICATION_RETENTION_MS must be >= 60000 ms ` +
          `(received: ${config.cleanup.notificationRetentionMs}).`,
      );
    }
    if (config.cleanup.processedEventRetentionMs < 60_000) {
      errors.push(
        `PROCESSED_EVENT_RETENTION_MS must be >= 60000 ms ` +
          `(received: ${config.cleanup.processedEventRetentionMs}).`,
      );
    }
  }

  // ── Backfill ───────────────────────────────────────────────────────────────
  if (config.backfill) {
    if (config.backfill.maxLedgers < 0) {
      errors.push(
        `BACKFILL_MAX_LEDGERS must be >= 0 (0 = unlimited). ` +
          `(received: ${config.backfill.maxLedgers}).`,
      );
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────────
  // Rejected rather than silently downgraded: a typo in LOG_LEVEL that quietly
  // resolves to "info" hides debug output an operator explicitly asked for, and
  // they have no signal that the setting did not take.
  if (config.logging) {
    if (parseLogLevel(config.logging.level) === null) {
      errors.push(
        `LOG_LEVEL must be one of: ${SUPPORTED_LOG_LEVELS.join(', ')} ` +
          `(received: "${config.logging.level}").`,
      );
    }

    if (parseLogFormat(config.logging.format) === null) {
      errors.push(
        `LOG_FORMAT must be one of: ${SUPPORTED_LOG_FORMATS.join(', ')} ` +
          `(received: "${config.logging.format}").`,
      );
    }
  }

  // ── API surface ────────────────────────────────────────────────────────────
  if (config.api) {
    if (!Number.isInteger(config.api.maxBodyBytes) || config.api.maxBodyBytes <= 0) {
      errors.push(
        `API_MAX_BODY_BYTES must be a positive integer ` +
          `(received: ${config.api.maxBodyBytes}).`,
      );
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `Configuration validation failed with ${errors.length} error(s):\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n'),
    );
  }

  // Schema-based validation check (#694)
  const schemaErrors = ConfigurationSchemaValidator.validate(config as any, APP_CONFIG_SCHEMA);
  if (schemaErrors.length > 0) {
    throw new ConfigError(
      `Configuration schema validation failed with ${schemaErrors.length} error(s):\n` +
        schemaErrors.map((e, i) => `  ${i + 1}. [${e.field}] ${e.message}`).join('\n'),
    );
  }
  // ── Secret validation (#692) ───────────────────────────────────────────────
  // Run after structural checks so operators see both structural and secret
  // problems in a single pass.  Errors are reported by field name only; the
  // actual secret values are never included in any message.
  validateSecrets([
    {
      fieldName: 'DISCORD_WEBHOOK_URL',
      value: config.discord?.webhookUrl,
      required: false,
    },
    {
      fieldName: 'DISCORD_WEBHOOK_ID',
      value: config.discord?.webhookId,
      required: false,
    },
    // Webhook signing secrets
    ...((config.webhookSecrets ?? []).map((ws, i) => ({
      fieldName: `WEBHOOK_SECRETS[${i}].secret`,
      value: ws.secret,
      required: true,
    }))),
    // API keys
    ...((config.apiKeys ?? []).map((ak, i) => ({
      fieldName: `API_KEYS[${i}].key`,
      value: ak.key,
      required: true,
    }))),
  ]);
}

