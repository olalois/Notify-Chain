# Environment Variables and Secrets (NotifyChain)

> Centralized documentation for all environment variables and secret management
> requirements across NotifyChain services.

**Quick links**
- [1. Services covered](#1-services-covered)
- [2. Listener service variables](#2-listener-service-variables)
- [3. Dashboard service variables](#3-dashboard-service-variables)
- [4. Frontend service variables](#4-frontend-service-variables)
- [5. CI/CD secrets (GitHub Actions)](#5-cicd-secrets-github-actions)
- [6. Task Bounty contract deployment (Ethereum)](#6-task-bounty-contract-deployment-ethereum)
- [7. Sample .env files](#7-sample-env-files)
- [8. Security recommendations](#8-security-recommendations)
- [9. Operational notes and troubleshooting](#9-operational-notes-and-troubleshooting)

---

## 1. Services covered

| Service | Path | Runtime | Config source |
|---|---|---|---|
| **Listener** | `listener/` | Node.js / TypeScript | `process.env` — parsed in `listener/src/config.ts` |
| **Dashboard** | `dashboard/` | Vite / React (browser) | `import.meta.env` — `VITE_*` prefix required |
| **Frontend** | `frontend/` | Create React App / React (browser) | `process.env` — `REACT_APP_*` prefix required |
| **Task Bounty** | `Documents/Task Bounty/` | Hardhat deployment scripts | `process.env` / `.env` loaded by `dotenv` |

The Rust smart contracts in `contract/` contain no runtime environment variables — all configuration is on-chain.

---

## 2. Listener service variables

The listener is the only service with server-side secrets. All variables below are read from `process.env` in `listener/src/config.ts` (and supporting files) at startup.

Variables marked **Required** are checked by `validateRequiredEnvVars()` in `listener/src/config.ts` before the rest of the config is loaded. If any are missing, `loadConfig()` throws a `ConfigError` listing every missing variable and the process exits instead of starting with an invalid configuration.

### 2.1 Logging / runtime

| Variable | Default | Required | Description |
|---|---|---|---|
| `LOG_LEVEL` | `info` | No | Log verbosity. Exactly one of: `error` \| `warn` \| `info` \| `debug`. Any other value is **rejected at startup** with a `ConfigError`. |
| `LOG_FORMAT` | *(env-dependent)* | No | Log output format: `json` (newline-delimited JSON for log aggregators) or `pretty` (colourised, human-readable). Defaults to `json` when `NODE_ENV=production`, `pretty` otherwise. Any other value is rejected at startup. |
| `NODE_ENV` | *(unset)* | No | Set to `production` for production defaults. Affects the `LOG_FORMAT` default only when `LOG_FORMAT` is unset; an explicit `LOG_FORMAT` always wins. |

> **Note on log levels.** Earlier revisions of this table listed `http`,
> `verbose` and `silly`. The service has only ever implemented
> `error | warn | info | debug` — the other values were silently downgraded to
> `info`. They are now rejected at startup rather than accepted-and-ignored, so
> a deployment that sets one will fail fast with a message naming the valid
> values instead of running at unexpected verbosity.

**Secret redaction.** Log records are scanned before emission and any field
whose name looks like a credential (`password`, `secret`, `token`, `apiKey`,
`authorization`, `signature`, `cookie`, `privateKey`, and case/underscore
variants) has its value replaced with `[REDACTED]`. Query-string parameters in
logged request URLs are redacted the same way. The field itself is kept so
record shape stays stable for aggregator indexing.

### 2.2 Stellar / chain connectivity

| Variable | Default | Required | Description |
|---|---|---|---|
| `STELLAR_NETWORK` | `testnet` | No | Stellar network label. Common values: `testnet`, `public`. |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org:443` | No | Soroban RPC endpoint. Override in production to a dedicated node. |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | No | Network passphrase used for Stellar SDK and signature context. Must match the target network. Mainnet value: `Public Global Stellar Network ; September 2015`. |

### 2.3 Contract event selection

| Variable | Default | Required | Description |
|---|---|---|---|
| `CONTRACT_ADDRESSES` | *(none — enforced at startup)* | **Yes** | JSON array of contract objects to monitor. Missing this variable prevents the listener from starting; see note above. |

**Shape:**
```json
[
  {
    "address": "<Stellar contract ID>",
    "events": ["EventName1", "EventName2"]
  }
]
```
Use `"*"` as the sole event entry to subscribe to all events from a contract.

### 2.4 Listener HTTP API server

| Variable | Default | Required | Description |
|---|---|---|---|
| `EVENTS_API_PORT` | `8787` | No | Port the listener HTTP server binds to (1–65535). |
| `EVENTS_API_CORS_ORIGIN` | `http://localhost:5173` | No | Allowed CORS origin(s). Explicit URI or comma-separated list in Production/Staging (e.g. `https://dashboard.notifychain.io`). Wildcard `*` is only allowed in local Development/Test environments. |

For a complete reference table across all environments, see [docs/ENVIRONMENT_MATRIX.md](docs/ENVIRONMENT_MATRIX.md).

### 2.5 Database

| Variable | Default | Required | Description |
|---|---|---|---|
| `DATABASE_PATH` | `./data/notifications.db` | No | SQLite database file path. Used for event deduplication, cursor tracking, and scheduler state. Ensure the path is persistent and writable in your deployment. |

### 2.6 Discord delivery

Both variables must be provided together or neither.

| Variable | Default | Required | Description |
|---|---|---|---|
| `DISCORD_WEBHOOK_URL` | *(none)* | Conditional | Full Discord webhook URL from Server Settings → Integrations → Webhooks. ⚠️ Secret. |
| `DISCORD_WEBHOOK_ID` | *(none)* | Conditional | Numeric Discord webhook ID (portion of the URL). ⚠️ Secret. |
| `DISCORD_RETRY_COUNT` | *(uses `RETRY_MAX_RETRIES`)* | No | Override the number of delivery retries specifically for Discord notifications. |
| `NOTIFICATION_DEDUPLICATION_WINDOW_MS` | `60000` | No | Window (ms) within which duplicate Discord sends are suppressed. |
| `NOTIFICATION_DEDUPLICATION_MAX_SIZE` | `10000` | No | Maximum entries held in the Discord deduplication cache. |

Notification retry backoff is configured by the shared `RETRY_*` variables below and applies independently of the provider.

### 2.7 Webhook security

| Variable | Default | Required | Description |
|---|---|---|---|
| `WEBHOOK_SECRETS` | `[]` | No | JSON array of `{id, secret}` objects used to sign and verify outgoing webhook payloads. ⚠️ Secret. |
| `PAYLOAD_INTEGRITY_SECRET` | *(none)* | No | HMAC-SHA256 secret for hashing scheduled notification payloads to detect tampering. ⚠️ Secret. Generate with `openssl rand -base64 32`. |

**`WEBHOOK_SECRETS` shape:**
```json
[
  { "id": "target-1", "secret": "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { "id": "target-2", "secret": "whsec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
]
```

### 2.8 API keys

| Variable | Default | Required | Description |
|---|---|---|---|
| `API_KEYS` | `[]` | No | JSON array of `{key, name?}` objects. Clients must supply a matching key to access protected listener API endpoints. ⚠️ Secret. |

**Shape:**
```json
[
  { "key": "sk_live_abc123", "name": "dashboard-prod" }
]
```

### 2.9 Polling / reconnect

| Variable | Default | Required | Description |
|---|---|---|---|
| `POLL_INTERVAL_MS` | `30000` | No | How often the listener polls Stellar for new contract events (ms). |
| `EVENT_BATCH_SIZE` | `100` | No | Maximum number of blockchain events fetched in each polling cycle. Must be at least `1`. |
| `MAX_RECONNECT_ATTEMPTS` | `5` | No | Maximum number of reconnect attempts when the RPC endpoint fails. |
| `RECONNECT_DELAY_MS` | `5000` | No | Delay between reconnect attempts (ms). |
| `PROCESSED_EVENT_RETENTION_MS` | `2592000000` (30 days) | No | How long processed event metadata is retained for persistent deduplication and operations. Expired records are removed during database cleanup; minimum `60000` ms. |

### 2.10 Retry queue (in-memory)

The in-memory retry queue handles fast retries for transient failures within the current process lifetime.

| Variable | Default | Required | Description |
|---|---|---|---|
| `RETRY_BASE_DELAY_MS` | `5000` | No | Base delay for exponential backoff (ms). |
| `RETRY_MAX_RETRIES` | `5` | No | Maximum retry attempts before a job is marked permanently failed. |
| `RETRY_MULTIPLIER` | `2` | No | Exponential backoff multiplier. Delay = base × multiplier^attempt. |
| `RETRY_MAX_DELAY_MS` | `3600000` | No | Maximum clamped retry delay (ms). Default: 1 hour. |
| `RETRY_JITTER` | `true` | No | Add random jitter to retry delays to avoid thundering-herd. Set to `false` to disable. |
| `RETRY_QUEUE_PROCESS_INTERVAL_MS` | `5000` | No | How often the in-memory retry queue is drained (ms). |

### 2.11 Retry scheduler (database-backed)

The DB-backed retry scheduler persists retry state across process restarts.

| Variable | Default | Required | Description |
|---|---|---|---|
| `RETRY_SCHEDULER_ENABLED` | `true` | No | Enable the database-backed retry scheduler. Set to `false` to disable. |
| `RETRY_SCHEDULER_POLL_INTERVAL_MS` | `15000` | No | How often the retry scheduler checks for due jobs (ms). |
| `RETRY_SCHEDULER_LOCK_TIMEOUT_MS` | `60000` | No | Worker lock timeout (ms). Prevents two instances processing the same job. |
| `RETRY_SCHEDULER_PROCESSOR_ID` | *(unset)* | No | Unique identifier for this worker instance. Useful for multi-instance deployability and observability. |
| `RETRY_SCHEDULER_BATCH_SIZE` | `10` | No | Number of retry jobs to process per tick. |

### 2.12 Scheduled notification scheduler

| Variable | Default | Required | Description |
|---|---|---|---|
| `SCHEDULER_ENABLED` | `true` | No | Enable the scheduled notification dispatcher. Set to `false` to disable. |
| `SCHEDULER_POLL_INTERVAL_MS` | `10000` | No | How often the scheduler polls for due notifications (ms). |
| `SCHEDULER_LOCK_TIMEOUT_MS` | `60000` | No | Worker lock timeout (ms). |
| `SCHEDULER_PROCESSOR_ID` | *(unset)* | No | Unique identifier for this scheduler worker instance. |
| `SCHEDULER_BATCH_SIZE` | `10` | No | Due notifications to dispatch per tick. |
| `SCHEDULER_TIMING_BUFFER_MS` | `60000` | No | Timing buffer (ms) applied around scheduled times to prevent edge-case early or late dispatch. |

### 2.13 Event processing queue

| Variable | Default | Required | Description |
|---|---|---|---|
| `EVENT_QUEUE_MAX_CONCURRENCY` | `1` | No | Maximum number of contract events to process concurrently. |
| `EVENT_QUEUE_MAX_RETRIES` | `3` | No | Maximum retries per event before permanent failure. |
| `EVENT_QUEUE_BASE_DELAY_MS` | `2000` | No | Base delay for event queue retry backoff (ms). |
| `EVENT_QUEUE_POLL_INTERVAL_MS` | `1000` | No | How often the event queue checks for events ready to process (ms). |

### 2.14 Rate limiting

| Variable | Default | Required | Description |
|---|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | No | Enable rate limiting on the events API. Set to `false` to disable. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | No | Rate limit sliding window size (ms). |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | No | Maximum requests allowed per window (applies to all clients unless overridden). |
| `RATE_LIMIT_CLIENT_OVERRIDES` | `{}` | No | Per-client rate limit overrides. JSON object. See shape below. |
| `API_MAX_BODY_BYTES` | `1048576` | No | Largest request body the events API accepts, in bytes (default 1 MiB). Oversized `POST`/`PUT`/`PATCH` requests get `413 Payload Too Large` with code `PAYLOAD_TOO_LARGE`, and the payload is never parsed. Must be a positive integer. |

**`RATE_LIMIT_CLIENT_OVERRIDES` shape:**
```json
{
  "dashboard-dev": { "maxRequests": 120, "windowMs": 60000 },
  "dashboard-prod": { "maxRequests": 60 }
}
```

### 2.15 Cleanup / retention policies

| Variable | Default | Required | Description |
|---|---|---|---|
| `CLEANUP_INTERVAL_MS` | `3600000` | No | How often the cleanup job runs (ms). Default: 1 hour. |
| `NOTIFICATION_RETENTION_MS` | `604800000` | No | How long processed notifications are retained (ms). Default: 7 days. |
| `RATE_LIMIT_EVENT_RETENTION_MS` | `86400000` | No | How long rate-limit tracking records are retained (ms). Default: 24 hours. |
| `EVENT_RETENTION_MS` | `86400000` | No | How long raw contract events are retained (ms). Default: 24 hours. |
| `EXECUTION_LOG_RETENTION_MS` | `7776000000` | No | How long execution log entries are retained (ms). Default: 90 days. |

### 2.16 Notification archive

The archiver moves old completed/failed/cancelled notifications to a separate archive table, then permanently deletes them after a further retention period.

| Variable | Default | Required | Description |
|---|---|---|---|
| `ARCHIVE_ENABLED` | `true` | No | Enable the background archiver. Set to `false` to disable. |
| `ARCHIVE_INTERVAL_MS` | `21600000` | No | How often the archive cycle runs (ms). Default: 6 hours. |
| `ARCHIVE_AFTER_MS` | `604800000` | No | Archive notifications completed more than this many ms ago (ms). Default: 7 days. |
| `ARCHIVE_DELETE_AFTER_MS` | `7776000000` | No | Permanently delete archived records older than this many ms since archiving. Set to `0` to never delete. Default: 90 days. |
| `ARCHIVE_BATCH_SIZE` | `500` | No | Maximum rows moved per archive cycle. Prevents long-running transactions. |

### 2.17 Analytics

| Variable | Default | Required | Description |
|---|---|---|---|
| `ANALYTICS_ENABLED` | `true` | No | Enable the notification analytics aggregator. Set to `false` to disable. |
| `ANALYTICS_MAX_RECORDS` | `10000` | No | Maximum number of in-memory analytics records to retain. |
| `ANALYTICS_MAX_BUCKETS` | `168` | No | Maximum time buckets to keep in memory. Default 168 = 7 days of hourly buckets. |
| `ANALYTICS_BUCKET_SIZE_MS` | `3600000` | No | Size of each analytics time bucket (ms). Default: 1 hour. |
| `ANALYTICS_PERSIST_INTERVAL_MS` | `300000` | No | How often analytics data is flushed to the database (ms). Default: 5 minutes. |
| `ANALYTICS_SNAPSHOT_RETENTION_DAYS` | `30` | No | Days to retain analytics snapshots in the database. |

---

## 3. Dashboard service variables

These are Vite build-time variables. They are embedded into the static bundle at build time and are **not secret**. All variables must be prefixed with `VITE_`.

| Variable | Default | Required | Description |
|---|---|---|---|
| `VITE_EVENTS_API_URL` | `http://localhost:8787/api/events` | **Yes** (for non-local) | Full URL to the listener events API endpoint. The dashboard polls this to display contract events. |
| `VITE_STELLAR_NETWORK` | `TESTNET` | No | Stellar network identifier used for display and Stellar SDK context. Values: `TESTNET` \| `PUBLIC`. |
| `VITE_API_URL` | `http://localhost:3000/api` | No | Alternative API base URL for the template management endpoints. Only needed when templates are served from a different origin than the events API. |
| `VITE_INDEXING_HEALTH_URL` | *(derived)* | No | URL for the indexing service health check. If unset, automatically derived from `VITE_EVENTS_API_URL`. |
| `VITE_NOTIFICATION_HEALTH_URL` | *(derived)* | No | URL for the notification service health check. If unset, automatically derived from `VITE_EVENTS_API_URL`. |
| `VITE_ENV` | *(unset)* | No | Environment label for display or analytics (e.g. `development`, `staging`, `production`). |

---

## 4. Frontend service variables

These are Create React App build-time variables. All must be prefixed with `REACT_APP_`.

| Variable | Default | Required | Description |
|---|---|---|---|
| `REACT_APP_PREFERENCE_CONTRACT_ID` | `""` | **Yes** | Deployed Soroban contract ID for the user preferences contract. Obtain after deploying the contract to your target network. |

---

## 5. CI/CD secrets (GitHub Actions)

These values are stored as [GitHub repository secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets) and injected at CI/CD build time. They are never committed to the repository.

| Secret | Workflow | Description |
|---|---|---|
| `PREVIEW_EVENTS_API_URL` | `preview.yml` | Injected as `VITE_EVENTS_API_URL` when building preview deployments for pull requests. |
| `CLOUDFLARE_API_TOKEN` | `preview.yml`, `preview-cleanup.yml` | Cloudflare API token with Pages write access, used by Wrangler to deploy the dashboard. |
| `CLOUDFLARE_ACCOUNT_ID` | `preview.yml`, `preview-cleanup.yml` | Cloudflare account ID for the Pages project. |

To add or rotate these secrets: GitHub → Repository → Settings → Secrets and variables → Actions.

---

## 6. Task Bounty contract deployment (Ethereum)

These variables are only needed when deploying the Ethereum bounty contracts under `Documents/Task Bounty/`. They are consumed by Hardhat deployment scripts via `dotenv`.

| Variable | Example | Required | Description |
|---|---|---|---|
| `PRIVATE_KEY` | `0xabc123...` | **Yes** | Ethereum deployer private key. ⚠️ Secret — never commit. |
| `MAINNET_RPC_URL` | `https://eth-mainnet.g.alchemy.com/v2/<key>` | Conditional | Ethereum mainnet RPC endpoint (e.g. Alchemy). Required for mainnet deployments. |
| `SEPOLIA_RPC_URL` | `https://eth-sepolia.g.alchemy.com/v2/<key>` | Conditional | Ethereum Sepolia testnet RPC endpoint. Required for testnet deployments. |
| `ETHERSCAN_API_KEY` | `ABCDEF...` | No | Etherscan API key for post-deployment contract verification. |
| `BOUNTY_ADDRESS` | `0x...` | No | Deployed bounty contract address. Populate after deployment. |
| `RESOLVER_ADDRESS` | `0x...` | No | Deployed resolver contract address. Populate after deployment. |
| `FACTORY_ADDRESS` | `0x...` | No | Deployed factory contract address. Populate after deployment. |
| `ARBITRATOR` | `0x...` | No | Arbitrator address. Defaults to the deployer address if not set. |

---

## 7. Sample .env files

### 7.1 Listener — local development

```bash
# Logging
LOG_LEVEL=info
# NODE_ENV=production

# Stellar
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Contracts to monitor
CONTRACT_ADDRESSES='[{"address":"CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX","events":["*"]}]'

# HTTP API
EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=http://localhost:5173

# Database
DATABASE_PATH=./data/notifications.db

# Discord (optional — uncomment and fill both)
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
# DISCORD_WEBHOOK_ID=YOUR_ID

# Webhook secrets
WEBHOOK_SECRETS='[{"id":"default","secret":"whsec_your_secret_here"}]'

# Payload integrity (optional)
# PAYLOAD_INTEGRITY_SECRET=your_hmac_secret_here

# API keys (optional)
# API_KEYS='[{"key":"sk_dev_abc123","name":"local-dashboard"}]'

# Polling
POLL_INTERVAL_MS=30000
MAX_RECONNECT_ATTEMPTS=5
RECONNECT_DELAY_MS=5000

# Retry queue
RETRY_BASE_DELAY_MS=5000
RETRY_MAX_RETRIES=5
RETRY_MULTIPLIER=2
RETRY_MAX_DELAY_MS=3600000
RETRY_JITTER=true

# Retry scheduler
RETRY_SCHEDULER_ENABLED=true
RETRY_SCHEDULER_POLL_INTERVAL_MS=15000
RETRY_SCHEDULER_LOCK_TIMEOUT_MS=60000
RETRY_SCHEDULER_PROCESSOR_ID=local-1
RETRY_SCHEDULER_BATCH_SIZE=10

# Scheduled notifications
SCHEDULER_ENABLED=true
SCHEDULER_POLL_INTERVAL_MS=10000
SCHEDULER_LOCK_TIMEOUT_MS=60000
SCHEDULER_PROCESSOR_ID=local-1
SCHEDULER_BATCH_SIZE=10
SCHEDULER_TIMING_BUFFER_MS=60000

# Rate limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
RATE_LIMIT_CLIENT_OVERRIDES={}
```

### 7.2 Listener — production (key differences highlighted)

```bash
# Logging
LOG_LEVEL=warn
NODE_ENV=production

# Stellar mainnet
STELLAR_NETWORK=public
STELLAR_RPC_URL=https://soroban-mainnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

# Production contracts
CONTRACT_ADDRESSES='[{"address":"<real-contract-id>","events":["TaskCreated","WorkSubmitted"]}]'

# HTTP API — set exact dashboard origin
EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=https://your-dashboard.example.com

# Persistent storage path
DATABASE_PATH=/var/lib/notifychain/notifications.db

# Discord (inject from secrets manager)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_ID=...

# Webhook secrets (inject from secrets manager)
WEBHOOK_SECRETS='[{"id":"prod-target","secret":"<rotated-secret>"}]'
PAYLOAD_INTEGRITY_SECRET=<rotated-hmac-secret>

# API keys (inject from secrets manager)
API_KEYS='[{"key":"<rotated-api-key>","name":"dashboard-prod"}]'

# Worker identity (set per instance in multi-instance deployments)
SCHEDULER_PROCESSOR_ID=worker-a
RETRY_SCHEDULER_PROCESSOR_ID=worker-a

# Tighter rate limits for production
RATE_LIMIT_MAX_REQUESTS=60
RATE_LIMIT_CLIENT_OVERRIDES='{"dashboard":{"maxRequests":120,"windowMs":60000}}'
```

### 7.3 Dashboard — local development

```bash
VITE_EVENTS_API_URL=http://localhost:8787/api/events
VITE_STELLAR_NETWORK=TESTNET
```

### 7.4 Dashboard — production

```bash
VITE_EVENTS_API_URL=https://listener.your-domain.com/api/events
VITE_STELLAR_NETWORK=PUBLIC
VITE_ENV=production
```

### 7.5 Frontend — local development

```bash
REACT_APP_PREFERENCE_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## 8. Security recommendations

### 8.1 Variables that must be treated as secrets

Never commit these to version control. Inject them via a secrets manager or CI/CD secrets:

| Variable | Service |
|---|---|
| `DISCORD_WEBHOOK_URL` | Listener |
| `DISCORD_WEBHOOK_ID` | Listener |
| `WEBHOOK_SECRETS` | Listener |
| `PAYLOAD_INTEGRITY_SECRET` | Listener |
| `API_KEYS` | Listener |
| `PRIVATE_KEY` | Task Bounty (Ethereum) |
| `MAINNET_RPC_URL` / `SEPOLIA_RPC_URL` | Task Bounty (contains API keys) |
| `ETHERSCAN_API_KEY` | Task Bounty |

### 8.2 Use a secrets manager

Prefer one of:
- AWS Secrets Manager / SSM Parameter Store
- GCP Secret Manager
- Azure Key Vault
- HashiCorp Vault
- Kubernetes Secrets backed by an external secrets operator

### 8.3 Avoid logging secrets

- Do not log `process.env` in its entirety.
- Ensure error handlers do not serialize full config objects.
- When using structured logging, explicitly allowlist fields to log.

### 8.4 Rotate secrets safely

1. Add the new secret alongside the old one (overlap period).
2. Deploy the updated configuration.
3. Verify new secret is working.
4. Remove the old secret and redeploy.

For `WEBHOOK_SECRETS`, rotation is keyed by the `id` field — add new entries before removing old ones.

### 8.5 CORS hardening

Set `EVENTS_API_CORS_ORIGIN` to exact origins in production. Never use `*` if the API serves authenticated data.

### 8.6 Do not commit .env files

Only `.env.example` files (templates without real values) should be committed. Verify your `.gitignore` includes:
```
.env
.env.local
.env.*.local
```

### 8.7 JSON-valued variables

`CONTRACT_ADDRESSES`, `WEBHOOK_SECRETS`, `API_KEYS`, and `RATE_LIMIT_CLIENT_OVERRIDES` are parsed as JSON. Use single-quotes around the entire JSON string in bash-style shells to avoid escaping issues:
```bash
export CONTRACT_ADDRESSES='[{"address":"Cxxx","events":["*"]}]'
```

---

## 9. Operational notes and troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `DISCORD_WEBHOOK_URL is required when DISCORD_WEBHOOK_ID is provided` | One of the Discord pair is set but not the other | Provide both or neither |
| `CONTRACT_ADDRESSES must be valid JSON` | Malformed JSON string or shell quoting issue | Validate JSON with `echo $CONTRACT_ADDRESSES \| jq .` |
| `WEBHOOK_SECRETS must be a JSON array` | Same as above | Validate with `jq` |
| Events not appearing in dashboard | Wrong `VITE_EVENTS_API_URL` or CORS mismatch | Ensure `VITE_EVENTS_API_URL` matches the listener host and `EVENTS_API_CORS_ORIGIN` matches the dashboard origin |
| Scheduler not processing jobs | `SCHEDULER_ENABLED=false` or lock timeout too short | Set `SCHEDULER_ENABLED=true`, increase `SCHEDULER_LOCK_TIMEOUT_MS` |
| Duplicate notifications delivered | `NOTIFICATION_DEDUPLICATION_WINDOW_MS` too short | Increase the dedup window |
| `PORT` / `RPC_URL` in `listener/.env.staging` | These aliases do not map to `config.ts` variables | Use `EVENTS_API_PORT` and `STELLAR_RPC_URL` instead |

---

*Last updated: 2026-07-25. Source of truth: `listener/src/config.ts`, `listener/src/services/archive-config.ts`, dashboard source files in `dashboard/src/`, `frontend/src/services/preferenceService.ts`, and CI/CD workflow files in `.github/workflows/`.*
