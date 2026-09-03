export interface RetryBackoffConfig {
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  baseDelayMs: 5_000,
  multiplier: 2,
  maxDelayMs: 60 * 60 * 1_000,
  jitter: true,
};

export function calculateBackoffDelay(attempt: number, config: RetryBackoffConfig): number {
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  const raw = Math.min(
    config.baseDelayMs * Math.pow(config.multiplier, boundedAttempt),
    config.maxDelayMs,
  );
  return config.jitter ? Math.min(raw * (0.75 + Math.random() * 0.5), config.maxDelayMs) : raw;
}