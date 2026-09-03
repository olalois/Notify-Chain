# Listener Configuration Guide

> Complete reference for configuring the Notify-Chain off-chain listener (`listener/`).

Configuration is loaded primarily by `loadConfig()` in [`listener/src/config.ts`](../listener/src/config.ts) from process environment variables (typically a `.env` file loaded via `dotenv`). Related loaders also read environment variables outside `loadConfig()`:

| Source | File |
|--------|------|
| Core listener config | `listener/src/config.ts` → `loadConfig()` |
| Archive worker | `listener/src/services/archive-config.ts` → `loadArchiveConfig()` |
| Logging | `listener/src/utils/logger.ts` |
| Notification retry backoff | `listener/src/config.ts` (`RETRY_*`) |
| Payload integrity HMAC | `PAYLOAD_INTEGRITY_SECRET` (scheduler / repository) |
| Env template | [`listener/.env.example`](../listener/.env.example) |

For secrets-handling guidance (what must not be committed), also see [ENVIRONMENT_VARIABLES_AND_SECRETS.md](../ENVIRONMENT_VARIABLES_AND_SECRETS.md).

---

## Table of Contents

1. [Quick start](#quick-start)
2. [How configuration is loaded](#how-configuration-is-loaded)
3. [Required vs optional](#required-vs-optional)
4. [Configuration reference](#configuration-reference)
5. [Environment configuration matrix](#environment-configuration-matrix)
6. [Examples](#examples)
7. [Environment differences](#environment-differences)
8. [Recommended values (operational guidance)](#recommended-values-operational-guidance)
9. [Troubleshooting](#troubleshooting)
10. [Related documentation](#related-documentation)

---

## Environment configuration matrix

For a single consolidated master table specifying all environment variables, their types, required/optional status, defaults, sensitivity classifications, and environment applicability, consult [docs/ENVIRONMENT_MATRIX.md](ENVIRONMENT_MATRIX.md).

---

## Quick start

```bash
cd listener
cp .env.example .env
# Edit CONTRACT_ADDRESSES and optional Discord / secrets
npm install
npm run dev
```

At minimum you typically set:

- `STELLAR_RPC_URL` / `STELLAR_NETWORK` / `STELLAR_NETWORK_PASSPHRASE` for the target network
- `CONTRACT_ADDRESSES` with at least one contract to monitor (default is `[]`, which means **no contracts are polled**)
- Optional `DISCORD_WEBHOOK_URL` **and** `DISCORD_WEBHOOK_ID` together if you want Discord delivery

---

## How configuration is loaded

1. Process environment variables (and `.env` when started via the listener entrypoint).
2. `loadConfig()` parses integers/JSON, applies defaults, and validates shapes.
3. Invalid integers or invalid JSON throw `ConfigError` and prevent startup.
4. Boolean-like flags use **opt-out** semantics: enabled unless the value is exactly `false` (after trim). Examples: `SCHEDULER_ENABLED`, `RETRY_SCHEDULER_ENABLED`, `RATE_LIMIT_ENABLED`, `ANALYTICS_ENABLED`, `ARCHIVE_ENABLED`, `RETRY_JITTER`.

There are **no CLI flags** for listener configuration today. Docker / Compose examples in installation docs pass the same environment variables.

---

## Required vs optional

| Category | Status | Notes |
|----------|--------|-------|
| Stellar network / RPC / passphrase | Optional (defaults to **testnet**) | Override for public network or private RPC |
| `CONTRACT_ADDRESSES` | Optional syntactically (default `[]`) | **Operationally required** to observe any on-chain events |
| `EVENTS_API_*`, `DATABASE_PATH`, polling | Optional | Sensible local defaults |
| Discord webhook pair | Optional | Both URL and ID required together, or neither |
| Schedulers, retry, rate limit, analytics, archive, cleanup | Optional | Enabled with defaults unless set to `false` |
| `WEBHOOK_SECRETS`, `API_KEYS`, `PAYLOAD_INTEGRITY_SECRET` | Optional | Secrets; inject via a secrets manager in production |

---

## Configuration reference

Legend for **Required**:

- **No (defaulted)** — optional; code supplies a default
- **Pair** — required only when the sibling setting is present
- **Operational** — not enforced by the parser, but needed for useful behavior

### Logging

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `LOG_LEVEL` | string | `info` | No (defaulted) | Winston level (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`) |
| `NODE_ENV` | string | unset | No | When `production`, logs use newline-delimited JSON; otherwise human-readable |

**Recommended (guidance):** keep `info` in production; use `debug` temporarily when diagnosing polling or delivery issues.

### Stellar / network

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `STELLAR_NETWORK` | string | `testnet` | No (defaulted) | Network label used by components that need a network name |
| `STELLAR_RPC_URL` | string | `https://soroban-testnet.stellar.org:443` | No (defaulted) | Soroban RPC base URL for `getEvents` polling |
| `STELLAR_NETWORK_PASSPHRASE` | string | `Test SDF Network ; September 2015` | No (defaulted) | Must match the target network |

**Accepted values (common):** `STELLAR_NETWORK` = `testnet` or `public`. Passphrase for public network: `Public Global Stellar Network ; September 2015`.

**Recommended (guidance):** point `STELLAR_RPC_URL` at a reliable dedicated RPC for production; public testnet defaults are fine for local development.

### Contract selection

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `CONTRACT_ADDRESSES` | JSON array | `[]` | Operational | Contracts to poll and which event names to accept |

**Shape:**

```json
[
  {
    "address": "<contractId>",
    "events": ["TaskCreated", "WorkSubmitted"]
  }
]
```

- `address` — non-empty string (trimmed)
- `events` — array of strings; use `"*"` (or an empty list in filter logic) to accept all event names from that contract (see `matchesEventFilter` in `listener/src/utils/event-utils.ts`)
- Optional `userId` is supported on the `ContractConfig` type for preference gating, but is not required by `validateContractAddresses`

### Polling / reconnect

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `POLL_INTERVAL_MS` | integer (ms) | `30000` | No (defaulted) | How often `EventSubscriber` polls RPC |
| `MAX_RECONNECT_ATTEMPTS` | integer | `5` | No (defaulted) | Max reconnect attempts after poll failures |
| `RECONNECT_DELAY_MS` | integer (ms) | `5000` | No (defaulted) | Base delay between reconnect attempts (scaled by attempt count) |

**Recommended (guidance):** `30000` ms is the coded default and matches `.env.example`. Lower values increase RPC load; raise only if your RPC rate limits require it.

### Events HTTP API

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `EVENTS_API_PORT` | integer | `8787` | No (defaulted) | Listener HTTP listen port |
| `EVENTS_API_CORS_ORIGIN` | string | `http://localhost:5173` | No (defaulted) | CORS origin allowed for the events API |

**Recommended (guidance):** set `EVENTS_API_CORS_ORIGIN` to your real dashboard origin in production; avoid `*`.

### Database

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `DATABASE_PATH` | string | `./data/notifications.db` | No (defaulted) | SQLite file for dedup, cursors, scheduled notifications, archive, metrics |

**Recommended (guidance):** use a persistent writable volume path in deployed environments.

### Discord delivery

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `DISCORD_WEBHOOK_URL` | string | unset | Pair | Discord webhook URL |
| `DISCORD_WEBHOOK_ID` | string | unset | Pair | Discord webhook ID (must accompany URL) |
| `NOTIFICATION_DEDUPLICATION_WINDOW_MS` | integer (ms) | `60000` | No (defaulted; Discord only) | In-memory notification dedup window |
| `NOTIFICATION_DEDUPLICATION_MAX_SIZE` | integer | `10000` | No (defaulted; Discord only) | Max dedup cache entries |
| `DISCORD_RETRY_COUNT` | integer | unset → service default (`5` when unset in Discord service) | No | Per-delivery HTTP retry count override (read in `index.ts`) |

If only one of `DISCORD_WEBHOOK_URL` / `DISCORD_WEBHOOK_ID` is set, `loadConfig()` throws `ConfigError`.

### Webhook secrets and API keys

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `WEBHOOK_SECRETS` | JSON array | `[]` | No (defaulted) | `{ "id", "secret" }` pairs for webhook verification |
| `API_KEYS` | JSON array | intended `[]` | No | `{ "key", "name?" }` objects for API authentication |

**`WEBHOOK_SECRETS` shape:**

```json
[{ "id": "default", "secret": "whsec_your_secret_here" }]
```

**`API_KEYS` shape** (from `validateApiKeys` / `.env.example`):

```json
[{ "key": "sk_live_abc123", "name": "dashboard-prod" }]
```

> **Implementation note:** `loadConfig()` calls `validateApiKeys(rawApiKeys)` but does not currently declare/parse `rawApiKeys` from `API_KEYS` in `config.ts` on `main`. Treat `API_KEYS` as the documented intended interface (see `.env.example` and `validateApiKeys`); verify startup after enabling it until that loader path is fixed.

### Payload integrity

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `PAYLOAD_INTEGRITY_SECRET` | string | unset | No | HMAC secret for scheduled notification payload integrity checks |

When unset, integrity hashing/verification paths that depend on this secret are inactive.

### In-memory retry queue (Discord send failures)

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `RETRY_BASE_DELAY_MS` | integer (ms) | `5000` | No (defaulted) | Shared base delay for notification exponential backoff |
| `RETRY_MAX_RETRIES` | integer | `5` | No (defaulted) | Max in-memory retries before giving up |
| `RETRY_MULTIPLIER` | number | `2` | No (defaulted) | Shared backoff multiplier, must be at least 1 |
| `RETRY_MAX_DELAY_MS` | integer (ms) | `3600000` (1h) | No (defaulted) | Shared maximum delay cap; must be at least the base delay |
| `RETRY_JITTER` | boolean-like | enabled unless `false` | No (defaulted) | Randomize delay |
| `RETRY_QUEUE_PROCESS_INTERVAL_MS` | integer (ms) | `5000` | No (defaulted) | How often the in-memory retry queue is drained |

These settings are used by both the in-memory queue and DB-backed retry scheduler, independently of the notification provider. `RETRY_MAX_DELAY_MS` is a hard upper bound, including when jitter is enabled.

### Database-backed retry scheduler

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `RETRY_SCHEDULER_ENABLED` | boolean-like | enabled unless `false` | No (defaulted) | Run `RetryScheduler` |
| `RETRY_SCHEDULER_POLL_INTERVAL_MS` | integer (ms) | `15000` | No (defaulted) | Poll interval for due retries |
| `RETRY_SCHEDULER_LOCK_TIMEOUT_MS` | integer (ms) | `60000` | No (defaulted) | Worker lock timeout |
| `RETRY_SCHEDULER_PROCESSOR_ID` | string | unset | No | Worker identity (useful with multiple instances) |
| `RETRY_SCHEDULER_BATCH_SIZE` | integer | `10` | No (defaulted) | Jobs per tick |

### Scheduled notification scheduler

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `SCHEDULER_ENABLED` | boolean-like | enabled unless `false` | No (defaulted) | Run `NotificationScheduler` |
| `SCHEDULER_POLL_INTERVAL_MS` | integer (ms) | `10000` | No (defaulted) | Poll interval for due notifications |
| `SCHEDULER_LOCK_TIMEOUT_MS` | integer (ms) | `60000` | No (defaulted) | Worker lock timeout |
| `SCHEDULER_PROCESSOR_ID` | string | unset | No | Worker identity |
| `SCHEDULER_BATCH_SIZE` | integer | `10` | No (defaulted) | Notifications per tick |
| `SCHEDULER_TIMING_BUFFER_MS` | integer (ms) | `60000` | No (defaulted) | Timing buffer around `execute_at` |

### Event processing queue

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `EVENT_QUEUE_MAX_CONCURRENCY` | integer | `1` | No (defaulted) | Max concurrent event processors |
| `EVENT_QUEUE_MAX_RETRIES` | integer | `3` | No (defaulted) | Retries per event before permanent failure |
| `EVENT_QUEUE_BASE_DELAY_MS` | integer (ms) | `2000` | No (defaulted) | Base delay for event-queue backoff |
| `EVENT_QUEUE_POLL_INTERVAL_MS` | integer (ms) | `1000` | No (defaulted) | Queue poll interval |

### Rate limiting (HTTP API)

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `RATE_LIMIT_ENABLED` | boolean-like | enabled unless `false` | No (defaulted) | Enable API rate limiting |
| `RATE_LIMIT_WINDOW_MS` | integer (ms) | `60000` | No (defaulted) | Window size |
| `RATE_LIMIT_MAX_REQUESTS` | integer | `60` | No (defaulted) | Max requests per window |
| `RATE_LIMIT_CLIENT_OVERRIDES` | JSON object | `{}` | No (defaulted) | Per-client `{ maxRequests, windowMs? }` |

### Cleanup / retention

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `CLEANUP_INTERVAL_MS` | integer (ms) | `3600000` (1h) | No (defaulted) | Cleanup job interval |
| `NOTIFICATION_RETENTION_MS` | integer (ms) | `604800000` (7d) | No (defaulted) | Notification retention |
| `RATE_LIMIT_EVENT_RETENTION_MS` | integer (ms) | `86400000` (24h) | No (defaulted) | Rate-limit audit retention |
| `EVENT_RETENTION_MS` | integer (ms) | `86400000` (24h) | No (defaulted) | In-memory event registry TTL source |
| `EXECUTION_LOG_RETENTION_MS` | integer (ms) | `7776000000` (90d) | No (defaulted) | Execution log retention |

### Archive worker

Loaded by `loadArchiveConfig()` (not nested inside `loadConfig()`):

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `ARCHIVE_ENABLED` | boolean-like | enabled unless `false` | No (defaulted) | Background archiver on/off |
| `ARCHIVE_INTERVAL_MS` | integer (ms) | `21600000` (6h) | No (defaulted) | Archive cycle interval |
| `ARCHIVE_AFTER_MS` | integer (ms) | `604800000` (7d) | No (defaulted) | Move completed rows to archive after this age |
| `ARCHIVE_DELETE_AFTER_MS` | integer (ms) | `7776000000` (90d) | No (defaulted) | Permanently delete archive rows; `0` = never |
| `ARCHIVE_BATCH_SIZE` | integer | `500` | No (defaulted) | Max rows per cycle |

### Analytics

| Name | Type | Default | Required | Purpose / effect |
|------|------|---------|----------|------------------|
| `ANALYTICS_ENABLED` | boolean-like | enabled unless `false` | No (defaulted) | In-process analytics aggregator |
| `ANALYTICS_MAX_RECORDS` | integer | `10000` | No (defaulted) | Max in-memory analytics records |
| `ANALYTICS_MAX_BUCKETS` | integer | `168` | No (defaulted) | Max time buckets (default ≈ 7 days hourly) |
| `ANALYTICS_BUCKET_SIZE_MS` | integer (ms) | `3600000` (1h) | No (defaulted) | Bucket width |
| `ANALYTICS_PERSIST_INTERVAL_MS` | integer (ms) | `300000` (5m) | No (defaulted) | Snapshot persist interval |
| `ANALYTICS_SNAPSHOT_RETENTION_DAYS` | integer (days) | `30` | No (defaulted) | Persisted snapshot retention |

---

## Examples

### Local development (testnet + dashboard)

Matches the defaults in `loadConfig()` and `listener/.env.example`:

```bash
LOG_LEVEL=info

STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

CONTRACT_ADDRESSES=[{"address":"CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX","events":["*"]}]

POLL_INTERVAL_MS=30000
MAX_RECONNECT_ATTEMPTS=5
RECONNECT_DELAY_MS=5000

EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=http://localhost:5173

DATABASE_PATH=./data/notifications.db

# Optional Discord (both required together)
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
# DISCORD_WEBHOOK_ID=YOUR_WEBHOOK_ID

WEBHOOK_SECRETS=[{"id":"default","secret":"whsec_your_secret_here"}]

SCHEDULER_ENABLED=true
RETRY_SCHEDULER_ENABLED=true
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
RATE_LIMIT_CLIENT_OVERRIDES={}
```

### Production-like (public network)

Operational guidance based on coded defaults plus production practices in `.env.example` / secrets docs:

```bash
LOG_LEVEL=info
NODE_ENV=production

STELLAR_NETWORK=public
STELLAR_RPC_URL=https://your-rpc.example.com
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

CONTRACT_ADDRESSES=[{"address":"<contract-id>","events":["TaskCreated","WorkSubmitted","SubmissionApproved"]}]

EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=https://your-dashboard.example.com
DATABASE_PATH=/var/lib/notifychain/notifications.db

DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_ID=...

WEBHOOK_SECRETS=[{"id":"prod","secret":"<rotated-secret>"}]
PAYLOAD_INTEGRITY_SECRET=<rotated-hmac-secret>

SCHEDULER_ENABLED=true
SCHEDULER_PROCESSOR_ID=worker-a
RETRY_SCHEDULER_ENABLED=true
RETRY_SCHEDULER_PROCESSOR_ID=worker-a

RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=60
RATE_LIMIT_CLIENT_OVERRIDES={"dashboard":{"maxRequests":120,"windowMs":60000}}
```

### Discord-only delivery tuning

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/token
DISCORD_WEBHOOK_ID=123
NOTIFICATION_DEDUPLICATION_WINDOW_MS=60000
NOTIFICATION_DEDUPLICATION_MAX_SIZE=10000
DISCORD_RETRY_COUNT=5
DISCORD_BACKOFF_BASE_SECONDS=1
RETRY_BASE_DELAY_MS=5000
RETRY_MAX_RETRIES=5
RETRY_MULTIPLIER=2
RETRY_JITTER=true
```

---

## Environment differences

| Concern | Local / testnet | Staging / production |
|---------|-----------------|----------------------|
| Network | Defaults (`testnet` + public testnet RPC) | Override RPC + passphrase for target network |
| `CONTRACT_ADDRESSES` | Placeholder / lab contracts | Real deployed contract IDs + explicit event allow-lists |
| Discord | Often omitted | Set URL+ID via secrets manager |
| `DATABASE_PATH` | `./data/notifications.db` | Persistent volume |
| `EVENTS_API_CORS_ORIGIN` | `http://localhost:5173` | Real dashboard origin |
| Processor IDs | Optional | Set distinct `SCHEDULER_PROCESSOR_ID` / `RETRY_SCHEDULER_PROCESSOR_ID` per instance |
| Logging | Pretty logs (unset `NODE_ENV`) | `NODE_ENV=production` for JSON logs |

**Note on `listener/.env.staging`:** that sample file currently sets `PORT` and `RPC_URL`, which are **not** read by `loadConfig()`. Prefer `EVENTS_API_PORT` and `STELLAR_RPC_URL`.

---

## Recommended values (operational guidance)

Unless noted, these match **code defaults**. Items marked *guidance* are operational suggestions, not separate hard-coded constants.

| Setting | Recommendation | Basis |
|---------|----------------|-------|
| `POLL_INTERVAL_MS` | `30000` | Code default / `.env.example` |
| `EVENT_QUEUE_MAX_CONCURRENCY` | `1` | Code default (safe ordering) |
| `RETRY_MAX_RETRIES` | `5` | Code default |
| `EVENT_QUEUE_MAX_RETRIES` | `3` | Code default |
| `RATE_LIMIT_MAX_REQUESTS` | `60` / window `60000` | Code default; raise per client via overrides if the dashboard needs more (*guidance*) |
| `SCHEDULER_BATCH_SIZE` / `RETRY_SCHEDULER_BATCH_SIZE` | `10` | Code default |
| Archive defaults | 6h cycle / 7d archive / 90d delete | `archive-config.ts` defaults |
| Secrets | Never commit real Discord URLs or webhook secrets | `.env.example` warnings + secrets guide |

---

## Troubleshooting

| Symptom | Likely misconfiguration | What to check |
|---------|-------------------------|---------------|
| Listener starts but never sees events | Empty or wrong `CONTRACT_ADDRESSES` | Default is `[]`; confirm address and event names / `*` |
| `ConfigError` on boot about Discord | Only one of URL/ID set | Provide both or neither |
| `ConfigError` … must be valid JSON | Bad `CONTRACT_ADDRESSES`, `WEBHOOK_SECRETS`, or `RATE_LIMIT_CLIENT_OVERRIDES` | Validate JSON quoting in `.env` |
| `ConfigError` … must be a valid integer | Non-numeric poll/port/retry values | Use base-10 integers only |
| Dashboard CORS failures | Wrong `EVENTS_API_CORS_ORIGIN` | Must match the browser origin exactly |
| No Discord messages | Discord unset or dedup/preferences | Confirm webhook pair; check logs; dedup window may suppress repeats |
| Staging RPC ignored | Using `RPC_URL` from `.env.staging` | Use `STELLAR_RPC_URL` |
| Wrong listen port in staging | Using `PORT` | Use `EVENTS_API_PORT` (default `8787`) |
| Dual processing with multiple replicas | Missing processor IDs / shared DB locks | Set unique `*_PROCESSOR_ID` values and understand lock timeouts |

---

## Related documentation

- Env template: [`listener/.env.example`](../listener/.env.example)
- Secrets overview: [ENVIRONMENT_VARIABLES_AND_SECRETS.md](../ENVIRONMENT_VARIABLES_AND_SECRETS.md)
- Failure / retry behavior: [NOTIFICATION_FAILURE_RECOVERY.md](../NOTIFICATION_FAILURE_RECOVERY.md)
- Notification lifecycle: [NOTIFICATION_LIFECYCLE.md](../NOTIFICATION_LIFECYCLE.md)
- Listener installation: [`listener/INSTALLATION.md`](../listener/INSTALLATION.md)
- Logging: [`listener/LOGGING.md`](../listener/LOGGING.md)

---

## Validation notes

Defaults and option names in this guide were cross-checked against:

- `listener/src/config.ts` (`loadConfig`, `loadDiscordConfig`, `loadCleanupConfig`, `loadAnalyticsConfig`, `loadRetrySchedulerConfig`)
- `listener/src/services/archive-config.ts`
- `listener/src/utils/logger.ts`
- `listener/src/index.ts` (Discord retry overrides)
- `listener/.env.example`
