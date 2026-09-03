# Environment Configuration Matrix

> Single reference matrix documenting all supported environment variables across Notify-Chain, their purpose, required/optional status, default values, sensitivity levels, and applicable environments.

---

## 1. Overview & Sensitivity Classification

- **Public / Non-sensitive (`Public`)**: Safe to commit in example files or pass in plain environment configs.
- **Internal / Configurable (`Internal`)**: Specific to deployment infrastructure; non-secret but environment-dependent.
- **Sensitive / Secret (`Secret`)**: Sensitive credentials, API keys, private webhooks, and cryptographic keys. **Must never be committed or logged**.

---

## 2. Master Configuration Matrix

| Environment Variable | Type | Status | Default Value | Applicable Environments | Sensitive? | Description / Purpose |
|----------------------|------|--------|---------------|-------------------------|------------|-----------------------|
| `CONTRACT_ADDRESSES` | JSON Array | **Required** | *(None)* | All (Dev, Staging, Prod) | No | JSON array of Soroban contract addresses and event names to monitor. Must contain at least 1 entry. |
| `STELLAR_NETWORK` | string | Optional | `testnet` | All | No | Target Stellar network name (`testnet`, `public`, `futurenet`, `standalone`). |
| `STELLAR_RPC_URL` | string (URL) | Optional | `https://soroban-testnet.stellar.org:443` | All | No | Endpoint URL for the Soroban RPC provider. |
| `STELLAR_NETWORK_PASSPHRASE` | string | Optional | `Test SDF Network ; September 2015` | All | No | Stellar network passphrase corresponding to the target chain network. |
| `EVENTS_API_PORT` | integer | Optional | `8787` | All | No | HTTP port for listener API endpoints (`/health`, `/api/events`, `/api/schedule`, etc.). |
| `EVENTS_API_CORS_ORIGIN` | string | Optional | `http://localhost:5173` | All | No | Allowed CORS origin(s). Explicit URL in Staging/Prod; wildcard `*` allowed only in Dev/Test. |
| `DATABASE_PATH` | string | Optional | `./data/notifications.db` | All | No | SQLite database filepath for notifications, cursor persistence, and history. |
| `POLL_INTERVAL_MS` | integer | Optional | `30000` | All | No | Frequency in milliseconds for polling on-chain events via Soroban RPC (min: 1000). |
| `MAX_RECONNECT_ATTEMPTS` | integer | Optional | `5` | All | No | Maximum consecutive connection retry attempts before entering degraded status. |
| `RECONNECT_DELAY_MS` | integer | Optional | `5000` | All | No | Initial delay in ms before retrying dropped RPC connections. |
| `LOG_LEVEL` | string | Optional | `info` | All | No | Logging verbosity (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`). |
| `NODE_ENV` | string | Optional | `development` | All | No | Runtime environment (`development`, `test`, `staging`, `production`). Enables structured JSON logs in production. |
| `DISCORD_WEBHOOK_URL` | string (URL) | Conditional | *(None)* | All | **Yes** (Secret) | Discord webhook endpoint URL for notification delivery. Required if `DISCORD_WEBHOOK_ID` is set. |
| `DISCORD_WEBHOOK_ID` | string | Conditional | *(None)* | All | **Yes** (Secret) | Unique Discord webhook identifier. Required if `DISCORD_WEBHOOK_URL` is set. |
| `DISCORD_RETRY_COUNT` | integer | Optional | `5` (uses `RETRY_MAX_RETRIES`) | All | No | Maximum delivery attempts for Discord webhook notifications. |
| `NOTIFICATION_DEDUPLICATION_WINDOW_MS` | integer | Optional | `60000` | All | No | Time window in milliseconds within which duplicate outgoing messages are suppressed. |
| `NOTIFICATION_DEDUPLICATION_MAX_SIZE` | integer | Optional | `10000` | All | No | Maximum entries maintained in memory for message deduplication. |
| `WEBHOOK_SECRETS` | JSON Array | Optional | `[]` | All | **Yes** (Secret) | Array of `{ id: string, secret: string }` pairs used to generate and verify HMAC signatures. |
| `API_KEYS` | JSON Array | Optional | `[]` | All | **Yes** (Secret) | Array of `{ key: string, name?: string }` objects authorized for protected API operations. |
| `PAYLOAD_INTEGRITY_SECRET` | string | Optional | *(None)* | Staging, Prod | **Yes** (Secret) | Secret key used to compute and verify HMAC-SHA256 checksums over persisted notification payloads. |
| `SCHEDULER_ENABLED` | boolean | Optional | `true` | All | No | Enable background job scheduler for delayed/scheduled notifications. |
| `SCHEDULER_POLL_INTERVAL_MS` | integer | Optional | `10000` | All | No | Frequency in milliseconds for polling pending scheduled notifications. |
| `SCHEDULER_LOCK_TIMEOUT_MS` | integer | Optional | `60000` | All | No | Maximum lock duration in ms for processing workers before releasing claims. |
| `SCHEDULER_BATCH_SIZE` | integer | Optional | `10` | All | No | Maximum number of notifications processed in a single scheduler loop iteration. |
| `SCHEDULER_TIMING_BUFFER_MS` | integer | Optional | `60000` | All | No | Advance lookahead window in ms for querying upcoming due notifications. |
| `RETRY_SCHEDULER_ENABLED` | boolean | Optional | `true` | All | No | Enable automatic retry scheduler for failed deliveries. |
| `RETRY_SCHEDULER_POLL_INTERVAL_MS` | integer | Optional | `15000` | All | No | Frequency in ms to check for failed notifications eligible for retry. |
| `RETRY_BASE_DELAY_MS` | integer | Optional | `5000` | All | No | Base delay in ms used for exponential backoff calculations. |
| `RETRY_MULTIPLIER` | integer | Optional | `2` | All | No | Multiplier applied to consecutive retry attempt backoff intervals. |
| `RETRY_MAX_DELAY_MS` | integer | Optional | `3600000` (1 hour) | All | No | Upper bound cap on exponential backoff delays. |
| `RETRY_JITTER` | boolean | Optional | `true` | All | No | Adds randomized jitter to retry intervals to prevent thundering herd spikes. |
| `RATE_LIMIT_ENABLED` | boolean | Optional | `true` | All | No | Enable rate-limiting middleware on the events API server. |
| `RATE_LIMIT_WINDOW_MS` | integer | Optional | `60000` (1 min) | All | No | Sliding window duration in ms for tracking client request quotas. |
| `RATE_LIMIT_MAX_REQUESTS` | integer | Optional | `60` | All | No | Allowed request count per window before returning HTTP 429 Too Many Requests. |
| `RATE_LIMIT_CLIENT_OVERRIDES` | JSON Object | Optional | `{}` | All | No | Per-client IP/key custom rate limits: `{"<key>": {"maxRequests": 100, "windowMs": 60000}}`. |
| `ANALYTICS_ENABLED` | boolean | Optional | `true` | All | No | Enable metrics collection and analytics aggregation engine. |
| `ANALYTICS_MAX_RECORDS` | integer | Optional | `10000` | All | No | In-memory capacity of the circular analytics event buffer. |
| `ANALYTICS_MAX_BUCKETS` | integer | Optional | `168` | All | No | Maximum hourly time-series buckets maintained in memory. |
| `ANALYTICS_BUCKET_SIZE_MS` | integer | Optional | `3600000` (1 hour) | All | No | Duration of individual analytics aggregation buckets. |
| `ANALYTICS_PERSIST_INTERVAL_MS`| integer | Optional | `300000` (5 mins) | All | No | Frequency of analytics snapshot persistence to disk. |
| `ANALYTICS_SNAPSHOT_RETENTION_DAYS`| integer | Optional| `30` | All | No | Number of days to retain historical metrics snapshots before pruning. |
| `CLEANUP_INTERVAL_MS` | integer | Optional | `3600000` (1 hour) | All | No | Frequency of database housekeeping and expired event pruning tasks. |
| `NOTIFICATION_RETENTION_MS` | integer | Optional | `604800000` (7 days) | All | No | Retention period for completed and failed notification records. |
| `EVENT_RETENTION_MS` | integer | Optional | `86400000` (24 hours) | All | No | Retention period for ingested on-chain events in the active registry. |
| `EXECUTION_LOG_RETENTION_MS`| integer | Optional | `7776000000` (90 days)| All | No | Retention period for detailed notification execution attempt logs. |

---

## 3. Environment-Specific Profiles

### Development (`NODE_ENV=development`)
- Uses local defaults: `EVENTS_API_CORS_ORIGIN="http://localhost:5173"` or `*`.
- `LOG_LEVEL="debug"` or `"info"`.
- Uses Soroban `testnet` RPC.

### Staging (`NODE_ENV=staging`)
- Explicit CORS origins (wildcard `*` rejected).
- Secret injection via secret store (`DISCORD_WEBHOOK_URL`, `WEBHOOK_SECRETS`, `PAYLOAD_INTEGRITY_SECRET`).
- Polling intervals tuned to staging cluster load.

### Production (`NODE_ENV=production`)
- Structured JSON logging enabled automatically.
- Strict schema and CORS validation enforced on startup.
- All secrets injected via production secret manager / KMS.
