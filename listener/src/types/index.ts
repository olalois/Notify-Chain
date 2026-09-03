export interface ContractConfig {
  address: string;
  events: string[];
  /** Optional user ID for per-user notification preference gating */
  userId?: string;
}

export interface DiscordConfig {
  webhookUrl: string;
  webhookId: string;
  retryCount?: number;
  backoffBaseSeconds?: number;
  deduplicationWindowMs?: number;
  deduplicationMaxSize?: number;
  timeoutMs?: number;
}

export interface RetryQueueConfig {
  baseDelayMs?: number;
  multiplier?: number;
  jitter?: boolean;
  maxDelayMs?: number;
  maxRetries?: number;
  processIntervalMs?: number;
}

export interface WebhookSecret {
  id: string;
  secret: string;
}  
  
export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
  clientOverrides: Record<string, { maxRequests: number; windowMs?: number }>;
}

export interface ApiKey {
  key: string;
  name?: string;
}

export interface Config {
  stellarNetwork: string;
  stellarRpcUrl: string;
  stellarNetworkPassphrase: string;
  contractAddresses: ContractConfig[];
  pollIntervalMs: number;
  /** Maximum number of blockchain events fetched per polling cycle (default: 100). */
  eventBatchSize: number;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  eventsApiPort: number;
  eventsApiCorsOrigin: string;
  discord?: DiscordConfig;
  retryQueue?: RetryQueueConfig;
  eventQueue?: EventQueueConfig;
  webhookSecrets?: WebhookSecret[];
  apiKeys?: ApiKey[];
  scheduler?: SchedulerConfig;
  retryScheduler?: RetrySchedulerOptions;
  databasePath?: string;
  rateLimit?: RateLimitConfig;
  cleanup?: AppCleanupConfig;
  analytics?: AnalyticsConfig;
  expiration?: ExpirationConfig;
  backfill?: BackfillConfig;
  logging?: LoggingConfig;
  api?: ApiConfig;
}

/** Observability settings, sourced from LOG_LEVEL / LOG_FORMAT. */
export interface LoggingConfig {
  /** `error | warn | info | debug`. Defaults to `info`. */
  level: string;
  /**
   * `json` for aggregator-friendly newline-delimited JSON, `pretty` for the
   * colourised human format. Defaults to `json` in production and `pretty`
   * elsewhere.
   */
  format: string;
}

/** HTTP surface settings for the events API. */
export interface ApiConfig {
  /**
   * Largest request body accepted, in bytes. Oversized requests are answered
   * with 413 and their payload is never parsed.
   */
  maxBodyBytes: number;
}

export interface SchedulerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  processorId?: string;
  batchSize: number;
  timingBufferMs: number;
}

export interface EventQueueConfig {
  /** Maximum number of events to process concurrently (default: 1, must be >= 1). */
  maxConcurrency?: number;
  /** Maximum retry attempts per event (default: 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 2000). */
  baseDelayMs?: number;
  /** How often to poll the queue for due events in ms (default: 1000). */
  pollIntervalMs?: number;
}

export interface AppCleanupConfig {
  /** How often to run cleanup jobs (ms). */
  intervalMs: number;
  /** Retain completed/failed/cancelled notifications for this long (ms). */
  notificationRetentionMs: number;
  /** Retain rate-limit audit rows for this long (ms). */
  rateLimitEventRetentionMs: number;
  /** Retain in-memory events for this long (ms). */
  eventRetentionMs: number;
  /** Retain processed event metadata for this long (ms). Default: 30 days. */
  processedEventRetentionMs: number;
  /** Retain notification execution log rows for this long (ms). */
  executionLogRetentionMs: number;
}

export interface RetrySchedulerOptions {
  enabled: boolean;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  processorId?: string;
  batchSize: number;
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface AnalyticsConfig {
  enabled: boolean;
  maxRecords: number;
  maxBuckets: number;
  bucketSizeMs: number;
  /** How often to persist summarized snapshots (ms). */
  persistIntervalMs: number;
  /** How long to retain persisted snapshots (days). */
  snapshotRetentionDays: number;
}

export interface ExpirationConfig {
  /** Default expiration time in milliseconds (default: 24 hours = 86400000). */
  defaultExpirationMs: number;
  /** Per-event-type expiration times in milliseconds. */
  perEventTypeExpiration?: Record<string, number>;
  /** Whether expiration checking is enabled (default: true). */
  enabled: boolean;
}

/**
 * Safety limits for the historical backfill that runs when the listener
 * starts without a stored cursor (first boot or after downtime).
 */
export interface BackfillConfig {
  /**
   * Maximum number of ledgers to replay from the network tip on a cold start.
   *
   * When the subscriber has no persisted cursor for a contract it would
   * normally request events from ledger 1, which can be an arbitrarily large
   * range after downtime or a configuration change.  This limit caps the
   * range to the most recent `maxLedgers` ledgers instead.
   *
   * Set to `0` to disable the limit and allow full historical replay
   * (the previous default behaviour).  Default: 10 000.
   */
  maxLedgers: number;
}

