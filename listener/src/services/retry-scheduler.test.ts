import { calculateBackoffDelay, RetryScheduler, RETRY_SCHEDULER_DEFAULTS } from './retry-scheduler';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../utils/request-id', () => ({ generateRequestId: () => 'test-req-id' }));

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRepo(overrides: Partial<ReturnType<typeof buildMockRepo>> = {}) {
  return { ...buildMockRepo(), ...overrides };
}

function buildMockRepo() {
  return {
    recoverStaleLocks: jest.fn().mockResolvedValue(0),
    fetchDueRetries: jest.fn().mockResolvedValue([]),
    markAsCompleted: jest.fn().mockResolvedValue(undefined),
    markAsFailedOrRetry: jest.fn().mockResolvedValue(undefined),
    logExecution: jest.fn().mockResolvedValue(undefined),
    // other methods not exercised by RetryScheduler
    create: jest.fn(),
    fetchAndLockPendingNotifications: jest.fn(),
    getById: jest.fn(),
    cancel: jest.fn(),
    getStats: jest.fn(),
    fetchDueRetriesMock: jest.fn(),
  } as any;
}

function makeNotification(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    payload: JSON.stringify({ event: {}, contractConfig: {} }),
    notificationType: NotificationType.DISCORD,
    targetRecipient: 'user-1',
    executeAt: new Date(),
    status: NotificationStatus.PROCESSING,
    retryCount: 1,
    maxRetries: 3,
    priority: 5,
    ...overrides,
  };
}

// ─── calculateBackoffDelay ───────────────────────────────────────────────────

describe('calculateBackoffDelay', () => {
  it('returns base * multiplier^attempt without jitter', () => {
    expect(calculateBackoffDelay(0, 1000, 2, 60_000, false)).toBe(1000);
    expect(calculateBackoffDelay(1, 1000, 2, 60_000, false)).toBe(2000);
    expect(calculateBackoffDelay(2, 1000, 2, 60_000, false)).toBe(4000);
    expect(calculateBackoffDelay(3, 1000, 2, 60_000, false)).toBe(8000);
  });

  it('respects maxDelayMs cap', () => {
    expect(calculateBackoffDelay(10, 1000, 2, 5000, false)).toBe(5000);
  });

  it('with jitter returns value within [75 %, 125 %] of base delay', () => {
    const base = calculateBackoffDelay(1, 1000, 2, 60_000, false); // 2000
    for (let i = 0; i < 20; i++) {
      const jittered = calculateBackoffDelay(1, 1000, 2, 60_000, true);
      expect(jittered).toBeGreaterThanOrEqual(base * 0.75);
      expect(jittered).toBeLessThanOrEqual(base * 1.25);
    }
  });

  it('uses custom multiplier', () => {
    expect(calculateBackoffDelay(2, 1000, 3, 100_000, false)).toBe(9000); // 1000*3^2
  });

  it('never exceeds the configured cap when jitter is enabled', () => {
    jest.spyOn(Math, 'random').mockReturnValue(1);
    expect(calculateBackoffDelay(10, 1000, 2, 5000, true)).toBe(5000);
    jest.restoreAllMocks();
  });
});

// ─── RetryScheduler ──────────────────────────────────────────────────────────

describe('RetryScheduler', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('start / stop', () => {
    it('does not start when disabled', async () => {
      const repo = makeRepo();
      const scheduler = new RetryScheduler(repo, { enabled: false });
      await scheduler.start();
      expect(repo.recoverStaleLocks).not.toHaveBeenCalled();
    });

    it('recovers stale locks on start', async () => {
      const repo = makeRepo();
      const scheduler = new RetryScheduler(repo, { enabled: true, pollIntervalMs: 999_999 });
      await scheduler.start();
      expect(repo.recoverStaleLocks).toHaveBeenCalledTimes(1);
      await scheduler.stop();
    });

    it('calling start twice is idempotent', async () => {
      const repo = makeRepo();
      const scheduler = new RetryScheduler(repo, { enabled: true, pollIntervalMs: 999_999 });
      await scheduler.start();
      await scheduler.start();
      expect(repo.recoverStaleLocks).toHaveBeenCalledTimes(1);
      await scheduler.stop();
    });
  });

  describe('runOnce – success path', () => {
    it('marks notification as completed when delivery succeeds', async () => {
      const notification = makeNotification();
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockResolvedValue([notification]) });
      const discordService = { sendEventNotification: jest.fn().mockResolvedValue(true) } as any;

      const scheduler = new RetryScheduler(repo, { ...RETRY_SCHEDULER_DEFAULTS }, discordService);
      await scheduler.runOnce();

      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(1);
      expect(repo.markAsCompleted).toHaveBeenCalledWith(1, 'test-req-id');
      expect(repo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'SUCCESS', scheduledNotificationId: 1 })
      );
    });
  });

  describe('runOnce – failure path', () => {
    it('schedules next retry with backoff when delivery fails and retries remain', async () => {
      const notification = makeNotification({ retryCount: 1, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockResolvedValue([notification]) });
      const discordService = { sendEventNotification: jest.fn().mockResolvedValue(false) } as any;

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, baseDelayMs: 1000, multiplier: 2, jitter: false },
        discordService
      );
      await scheduler.runOnce();

      expect(repo.markAsFailedOrRetry).toHaveBeenCalledWith(
        1,
        expect.any(Error),
        1, // currentRetryCount = notification.retryCount
        3,
        expect.any(Date) // nextRetryAt must be set
      );

      const [, , , , nextRetryAt] = (repo.markAsFailedOrRetry as jest.Mock).mock.calls[0];
      expect(nextRetryAt).toBeInstanceOf(Date);
      expect(nextRetryAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('marks notification as permanently failed when max retries exhausted', async () => {
      const notification = makeNotification({ retryCount: 2, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockResolvedValue([notification]) });
      const discordService = { sendEventNotification: jest.fn().mockResolvedValue(false) } as any;

      const scheduler = new RetryScheduler(repo, { ...RETRY_SCHEDULER_DEFAULTS }, discordService);
      await scheduler.runOnce();

      expect(repo.markAsFailedOrRetry).toHaveBeenCalledWith(
        1,
        expect.any(Error),
        2,
        3,
        undefined // no nextRetryAt when permanently failed
      );
      expect(repo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'FAILED' })
      );
    });

    it('logs error and does not throw when delivery throws', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const notification = makeNotification({ retryCount: 1, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockResolvedValue([notification]) });
      const discordService = {
        sendEventNotification: jest.fn().mockRejectedValue(new Error('network timeout')),
      } as any;

      const scheduler = new RetryScheduler(repo, { ...RETRY_SCHEDULER_DEFAULTS }, discordService);
      await expect(scheduler.runOnce()).resolves.not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        'Retry failed, scheduling next attempt',
        expect.objectContaining({ id: 1 })
      );
    });
  });

  describe('duplicate prevention (distributed lock)', () => {
    it('does not process the same notification twice in the same cycle', async () => {
      // fetchDueRetries returns same notification twice (simulates two schedulers racing)
      const notification = makeNotification();
      let callCount = 0;
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => {
          callCount++;
          // Only first call returns the notification; second call returns empty (lock held)
          return Promise.resolve(callCount === 1 ? [notification] : []);
        }),
      });
      const discordService = { sendEventNotification: jest.fn().mockResolvedValue(true) } as any;

      const s1 = new RetryScheduler(repo, { ...RETRY_SCHEDULER_DEFAULTS }, discordService);
      const s2 = new RetryScheduler(repo, { ...RETRY_SCHEDULER_DEFAULTS }, discordService);

      await Promise.all([s1.runOnce(), s2.runOnce()]);

      // Delivery should have been called only once (second scheduler got empty batch)
      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(1);
    });
  });
});
