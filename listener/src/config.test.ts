import { ConfigError, loadConfig, validateConfig } from './config';

describe('Config validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // CONTRACT_ADDRESSES is a required variable; give it a valid default so
    // tests unrelated to required-variable validation aren't affected.
    process.env.CONTRACT_ADDRESSES = JSON.stringify([{ address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] }]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws a descriptive error when DISCORD_WEBHOOK_ID is set without DISCORD_WEBHOOK_URL', () => {
    process.env.DISCORD_WEBHOOK_ID = '123';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(
      'DISCORD_WEBHOOK_URL is required when DISCORD_WEBHOOK_ID is provided.'
    );
  });

  it('throws a descriptive error when DISCORD_WEBHOOK_URL is set without DISCORD_WEBHOOK_ID', () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(
      'DISCORD_WEBHOOK_ID is required when DISCORD_WEBHOOK_URL is provided.'
    );
  });

  it('throws a descriptive error for invalid CONTRACT_ADDRESSES JSON', () => {
    process.env.CONTRACT_ADDRESSES = 'not-json';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('CONTRACT_ADDRESSES must be valid JSON. Received: not-json');
  });

  it('throws a descriptive error when a required environment variable is missing', () => {
    delete process.env.CONTRACT_ADDRESSES;

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(
      'Missing required environment variable(s): CONTRACT_ADDRESSES.'
    );
  });

  it('throws a descriptive error for invalid integer variables', () => {
    process.env.EVENTS_API_PORT = 'eighty';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('EVENTS_API_PORT must be a valid integer, got "eighty"');
  });

  it('loads the default blockchain event batch size', () => {
    delete process.env.EVENT_BATCH_SIZE;

    expect(loadConfig().eventBatchSize).toBe(100);
  });

  it('loads a configured blockchain event batch size', () => {
    process.env.EVENT_BATCH_SIZE = '250';

    expect(loadConfig().eventBatchSize).toBe(250);
  });

  it('rejects a non-integer blockchain event batch size', () => {
    process.env.EVENT_BATCH_SIZE = 'many';

    expect(() => loadConfig()).toThrow(
      'EVENT_BATCH_SIZE must be a valid integer, got "many"'
    );
  });

  it('rejects a non-positive blockchain event batch size', () => {
    process.env.EVENT_BATCH_SIZE = '0';

    const config = loadConfig();

    expect(() => validateConfig(config)).toThrow(
      'EVENT_BATCH_SIZE must be >= 1 (received: 0).'
    );
  });

  it('loads default values when optional environment variables are omitted', () => {
    process.env.CONTRACT_ADDRESSES = JSON.stringify([{ address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] }]);
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_RPC_URL;
    delete process.env.POLL_INTERVAL_MS;
    delete process.env.MAX_RECONNECT_ATTEMPTS;
    delete process.env.RECONNECT_DELAY_MS;
    delete process.env.EVENTS_API_PORT;
    delete process.env.EVENTS_API_CORS_ORIGIN;
    delete process.env.RETRY_BASE_DELAY_MS;
    delete process.env.RETRY_MAX_RETRIES;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_ID;
    delete process.env.NOTIFICATION_DEDUPLICATION_WINDOW_MS;
    delete process.env.NOTIFICATION_DEDUPLICATION_MAX_SIZE;

    const config = loadConfig();

    expect(config).toMatchObject({
      stellarNetwork: 'testnet',
      stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
      contractAddresses: [{ address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] }],
      pollIntervalMs: 30000,
      maxReconnectAttempts: 5,
      reconnectDelayMs: 5000,
      eventsApiPort: 8787,
      eventsApiCorsOrigin: 'http://localhost:5173',
      retryQueue: {
        baseDelayMs: 5000,
        maxRetries: 5,
      },
      analytics: {
        enabled: true,
        maxRecords: 10000,
        maxBuckets: 168,
        persistIntervalMs: 300000,
        snapshotRetentionDays: 30,
      },
      cleanup: {
        intervalMs: 3600000,
        notificationRetentionMs: 604800000,
        rateLimitEventRetentionMs: 86400000,
        eventRetentionMs: 86400000,
        processedEventRetentionMs: 2592000000,
        executionLogRetentionMs: 7776000000,
      },
    });
  });

  it('loads a configured processed event retention duration', () => {
    process.env.PROCESSED_EVENT_RETENTION_MS = '3600000';

    expect(loadConfig().cleanup?.processedEventRetentionMs).toBe(3600000);
  });

  it('rejects invalid processed event retention configuration', () => {
    process.env.PROCESSED_EVENT_RETENTION_MS = 'not-a-duration';

    expect(() => loadConfig()).toThrow(
      'PROCESSED_EVENT_RETENTION_MS must be a valid integer, got "not-a-duration"'
    );
  });

  it('rejects processed event retention shorter than one minute', () => {
    process.env.PROCESSED_EVENT_RETENTION_MS = '59999';

    const config = loadConfig();

    expect(() => validateConfig(config)).toThrow(
      'PROCESSED_EVENT_RETENTION_MS must be >= 60000 ms (received: 59999).'
    );
  });

  it('loads notification deduplication settings when Discord is configured', () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
    process.env.DISCORD_WEBHOOK_ID = '123';
    process.env.NOTIFICATION_DEDUPLICATION_WINDOW_MS = '15000';
    process.env.NOTIFICATION_DEDUPLICATION_MAX_SIZE = '250';

    const config = loadConfig();

    expect(config.discord).toMatchObject({
      webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      webhookId: '123',
      deduplicationWindowMs: 15000,
      deduplicationMaxSize: 250,
    });
  });

  describe('EXPIRATION_CONFIG', () => {
    it('loads default expiration settings when not specified', () => {
      delete process.env.EXPIRATION_ENABLED;
      delete process.env.EXPIRATION_DEFAULT_MS;
      delete process.env.EXPIRATION_PER_EVENT_TYPE;

      const config = loadConfig();

      expect(config.expiration).toMatchObject({
        enabled: true,
        defaultExpirationMs: 86400000, // 24 hours
        perEventTypeExpiration: undefined,
      });
    });

    it('loads custom default expiration time', () => {
      process.env.EXPIRATION_DEFAULT_MS = '3600000'; // 1 hour
      delete process.env.EXPIRATION_PER_EVENT_TYPE;

      const config = loadConfig();

      expect(config.expiration).toMatchObject({
        enabled: true,
        defaultExpirationMs: 3600000,
      });
    });

    it('loads per-event-type expiration settings', () => {
      process.env.EXPIRATION_PER_EVENT_TYPE = JSON.stringify({
        notification_scheduled: 3600000,
        alert: 604800000,
      });

      const config = loadConfig();

      expect(config.expiration?.perEventTypeExpiration).toEqual({
        notification_scheduled: 3600000,
        alert: 604800000,
      });
    });

    it('disables expiration when EXPIRATION_ENABLED is false', () => {
      process.env.EXPIRATION_ENABLED = 'false';

      const config = loadConfig();

      expect(config.expiration?.enabled).toBe(false);
    });

    it('throws ConfigError for invalid EXPIRATION_DEFAULT_MS', () => {
      process.env.EXPIRATION_DEFAULT_MS = 'not-a-number';

      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(
        'EXPIRATION_DEFAULT_MS must be a valid integer, got "not-a-number"'
      );
    });

    it('throws ConfigError for invalid EXPIRATION_PER_EVENT_TYPE JSON', () => {
      process.env.EXPIRATION_PER_EVENT_TYPE = 'not-json';

      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(
        'EXPIRATION_PER_EVENT_TYPE must be valid JSON. Received: not-json'
      );
    });

    it('throws ConfigError when EXPIRATION_PER_EVENT_TYPE is not an object', () => {
      process.env.EXPIRATION_PER_EVENT_TYPE = '["array", "value"]';

      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(
        'EXPIRATION_PER_EVENT_TYPE must be a valid JSON object'
      );
    });
  });

  describe('WEBHOOK_SECRETS', () => {
    it('defaults to an empty array when not set', () => {
      delete process.env.WEBHOOK_SECRETS;
      const config = loadConfig();
      expect(config.webhookSecrets).toEqual([]);
    });

    it('parses valid webhook secrets', () => {
      process.env.WEBHOOK_SECRETS = JSON.stringify([
        { id: 'key-1', secret: 'whsec_abc' },
        { id: 'key-2', secret: 'whsec_def' },
      ]);

      const config = loadConfig();
      expect(config.webhookSecrets).toEqual([
        { id: 'key-1', secret: 'whsec_abc' },
        { id: 'key-2', secret: 'whsec_def' },
      ]);
    });

    it('throws ConfigError for invalid JSON', () => {
      process.env.WEBHOOK_SECRETS = 'not-json';
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow('WEBHOOK_SECRETS must be valid JSON');
    });

    it('throws ConfigError when item is missing id', () => {
      process.env.WEBHOOK_SECRETS = JSON.stringify([{ secret: 'whsec_abc' }]);
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow('WEBHOOK_SECRETS[0].id must be a non-empty string');
    });

    it('throws ConfigError when item is missing secret', () => {
      process.env.WEBHOOK_SECRETS = JSON.stringify([{ id: 'key-1' }]);
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow('WEBHOOK_SECRETS[0].secret must be a non-empty string');
    });

    it('throws ConfigError when value is not an array', () => {
      process.env.WEBHOOK_SECRETS = '"string-value"';
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow('WEBHOOK_SECRETS must be a JSON array');
    });
  });

  describe('CORS and Schema Validation integration (#689, #694)', () => {
    it('rejects wildcard CORS origin in production environment', () => {
      process.env.NODE_ENV = 'production';
      process.env.EVENTS_API_CORS_ORIGIN = '*';

      const config = loadConfig();
      expect(() => {
        const { validateConfig } = require('./config');
        validateConfig(config);
      }).toThrow(ConfigError);
    });

    it('accepts valid HTTPS CORS origin in production environment', () => {
      process.env.NODE_ENV = 'production';
      process.env.EVENTS_API_CORS_ORIGIN = 'https://dashboard.notifychain.io';

      const config = loadConfig();
      const { validateConfig } = require('./config');
      expect(() => validateConfig(config)).not.toThrow();
    });
  describe('validateConfig - Startup Configuration Validation', () => {
    it('passes validation with a complete valid configuration', () => {
      process.env.CONTRACT_ADDRESSES = JSON.stringify([
        { address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['TaskCreated'] }
      ]);
      process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org:443';
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
      process.env.POLL_INTERVAL_MS = '30000';
      process.env.EVENTS_API_PORT = '8787';
      process.env.DATABASE_PATH = './data/notifications.db';

      const config = loadConfig();
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('detects empty CONTRACT_ADDRESSES array', () => {
      process.env.CONTRACT_ADDRESSES = '[]';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'CONTRACT_ADDRESSES is empty. The listener requires at least one contract to monitor'
      );
    });

    it('detects invalid STELLAR_RPC_URL format', () => {
      process.env.STELLAR_RPC_URL = 'not-a-url';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'STELLAR_RPC_URL is not a valid URL'
      );
    });

    it('detects STELLAR_RPC_URL with invalid protocol', () => {
      process.env.STELLAR_RPC_URL = 'ftp://example.com';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'STELLAR_RPC_URL must use HTTP or HTTPS protocol'
      );
    });

    it('detects invalid STELLAR_NETWORK_PASSPHRASE', () => {
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Wrong Network Passphrase';
      process.env.STELLAR_NETWORK = 'testnet';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'STELLAR_NETWORK_PASSPHRASE does not match known Stellar networks'
      );
    });

    it('accepts standalone network with custom passphrase', () => {
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Standalone Network ; February 2017';
      process.env.STELLAR_NETWORK = 'standalone';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('detects invalid contract address length', () => {
      process.env.CONTRACT_ADDRESSES = JSON.stringify([
        { address: 'CSHORT', events: ['*'] }
      ]);
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'CONTRACT_ADDRESSES[0].address must be exactly 56 characters'
      );
    });

    it('detects contract address not starting with C', () => {
      process.env.CONTRACT_ADDRESSES = JSON.stringify([
        { address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] }
      ]);
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        "CONTRACT_ADDRESSES[0].address must start with 'C' for Stellar contracts"
      );
    });

    it('detects empty event name in events array', () => {
      process.env.CONTRACT_ADDRESSES = JSON.stringify([
        { address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['TaskCreated', ''] }
      ]);
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'CONTRACT_ADDRESSES[0].events[1] must be a non-empty string'
      );
    });

    it('detects invalid POLL_INTERVAL_MS (too low)', () => {
      process.env.POLL_INTERVAL_MS = '500';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'POLL_INTERVAL_MS must be at least 1000 ms to avoid excessive RPC load'
      );
    });

    it('detects invalid EVENTS_API_PORT (out of range)', () => {
      process.env.EVENTS_API_PORT = '70000';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'EVENTS_API_PORT must be between 1 and 65535'
      );
    });

    it('detects invalid Discord webhook URL', () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://example.com/webhook';
      process.env.DISCORD_WEBHOOK_ID = '123456';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'DISCORD_WEBHOOK_URL must start with "https://discord.com/api/webhooks/"'
      );
    });

    it('reports multiple configuration errors together', () => {
      process.env.CONTRACT_ADDRESSES = '[]';
      process.env.STELLAR_RPC_URL = 'not-a-url';
      process.env.POLL_INTERVAL_MS = '500';
      process.env.EVENTS_API_PORT = '70000';
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      
      try {
        validateConfig(config);
      } catch (error) {
        if (error instanceof ConfigError) {
          // Verify all 4 errors are reported
          expect(error.message).toContain('Configuration validation failed with 4 error(s)');
          expect(error.message).toContain('STELLAR_RPC_URL is not a valid URL');
          expect(error.message).toContain('POLL_INTERVAL_MS must be at least 1000 ms');
          expect(error.message).toContain('EVENTS_API_PORT must be between 1 and 65535');
          expect(error.message).toContain('CONTRACT_ADDRESSES is empty');
        } else {
          throw error;
        }
      }
    });

    it('detects missing DATABASE_PATH', () => {
      delete process.env.DATABASE_PATH;
      
      const config = loadConfig();
      // DATABASE_PATH has a default, so we need to manually override it
      config.databasePath = '';
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'DATABASE_PATH must be a non-empty string'
      );
    });

    it('detects SCHEDULER_LOCK_TIMEOUT_MS less than POLL_INTERVAL_MS', () => {
      process.env.SCHEDULER_POLL_INTERVAL_MS = '10000';
      process.env.SCHEDULER_LOCK_TIMEOUT_MS = '5000';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'SCHEDULER_LOCK_TIMEOUT_MS must be >= SCHEDULER_POLL_INTERVAL_MS'
      );
    });

    it('detects invalid RETRY_MULTIPLIER (less than 1)', () => {
      process.env.RETRY_MULTIPLIER = '0';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'RETRY_MULTIPLIER must be >= 1'
      );
    });

    it('detects RETRY_MAX_DELAY_MS less than RETRY_BASE_DELAY_MS', () => {
      process.env.RETRY_BASE_DELAY_MS = '10000';
      process.env.RETRY_MAX_DELAY_MS = '5000';
      
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'RETRY_MAX_DELAY_MS must be >= RETRY_BASE_DELAY_MS'
      );
    });

    it('rejects invalid shared retry backoff values', () => {
      process.env.RETRY_BASE_DELAY_MS = '-1';
      process.env.RETRY_MULTIPLIER = '0';
      process.env.RETRY_MAX_DELAY_MS = '0';

      const config = loadConfig();

      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow('RETRY_BASE_DELAY_MS must be >= 0');
      expect(() => validateConfig(config)).toThrow('RETRY_MULTIPLIER must be >= 1');
      expect(() => validateConfig(config)).toThrow('RETRY_MAX_DELAY_MS must be > 0');
    });

    it('rejects non-integer retry backoff environment values', () => {
      process.env.RETRY_BASE_DELAY_MS = '1000.5';

      expect(() => loadConfig()).toThrow(
        'RETRY_BASE_DELAY_MS must be a valid integer, got "1000.5"'
      );
    });
  });
});
