# Harborline — the product bible

Harborline does not exist. It is documented as if it did, so that every answer a
model gives about it must come from retrieval: no model has seen it in training.
This file is the single source of truth the fixture docs and the eval sets are
written from. **It is never indexed and never shown to the tuning agent** — the
`docs/` tree is what readers (and the agent) see.

Rule for authors: every fact a gold answer states must be stated in `docs/`.
A fact that is only here is a *content gap* on purpose, and questions about it
are negatives (`refuse:no-evidence`).

## Identity

- Harborline is a managed job queue and scheduler for web applications. You push
  jobs over an HTTP API or an SDK; Harborline stores them and hands them to your
  workers; workers acknowledge, fail or extend them.
- Current major version: **v3** (3.4.0, released 2026-08-12). v3.0.0 was released
  2025-11-04. **v2 reaches end of life on 2026-06-30** (already past: v2 API
  answers `410 Gone` since 2026-07-01).
- Delivery guarantee: **at-least-once**. Handlers must be idempotent.
- Hierarchy: Workspace → Project → Queue → Job.

## Jobs

- Payload: JSON, **max 256 KB** in v3 (v2: 64 KB). Job metadata (headers): max 4 KB.
- Job id: ULID, prefixed `job_`.
- States: `scheduled` (delayed or future `runAt`), `queued`, `reserved` (leased to a
  worker), `succeeded`, `failed` (attempt failed, will retry), `dead` (no attempts
  left → moved to the dead-letter queue), `canceled`.
- Visibility timeout (the lease): **default 60 s in v3** (v2: 30 s), minimum 5 s,
  maximum 12 h. A worker extends a lease with `touch` (heartbeat). Recommended
  heartbeat: at most half the visibility timeout. If the lease expires the job
  returns to `queued` and its attempt counter is incremented (error `HL3001
  lease_expired` on a late ack).
- Retries: `maxAttempts` **default 5** (counts the first attempt). Backoff
  `exponential` (default) | `fixed` | `linear`; `baseDelay` default 2 s;
  `maxDelay` default 15 min; jitter `full` by default. A handler can throw a
  `PermanentError` (Node) / `raise PermanentError` (Python) to skip retries and go
  straight to `dead`.
- v2's `retries: N` meant N retries after the first attempt, i.e. N+1 attempts;
  v3's `maxAttempts` counts all attempts. Migration: `maxAttempts = retries + 1`.
- Delayed jobs: `delay` (duration) or `runAt` (timestamp), **max 30 days** ahead.
- Idempotency: `idempotencyKey`, dedup window **24 h**. A duplicate enqueue returns
  the existing job with HTTP 200 and error-less body, header
  `Harbor-Idempotent-Replay: true` (not an error; `HL1004` is only returned when
  the same key is reused with a DIFFERENT payload).
- Batch enqueue: `enqueueBatch`, **max 500 jobs or 5 MB per call**, whichever comes
  first. Partial failure: per-item results, the call itself is 207.
- Priorities: **Harborline has no job priorities.** Use separate queues with
  different concurrency. (Documented in the FAQ.)
- Ordering: no FIFO guarantee across a queue; FIFO **within a `groupKey`** when the
  group's concurrency is 1 (see concurrency keys).

## Queues

- Name regex `^[a-z0-9][a-z0-9._-]{0,62}$`.
- Per-queue settings: `concurrency` (max jobs reserved at once, default 10),
  `rateLimit` (`{limit, period}` e.g. 100 per minute), `visibilityTimeout`,
  `maxAttempts`, `backoff`, `deadLetter` (bool, default true).
- Concurrency keys (3.2.0): `groupKey` on a job + `groupConcurrency` on the queue
  (default 1) limit how many jobs with the same key run at once.
- Pause vs drain vs purge (the neighbour trap):
  - **pause** — stop handing jobs to workers; enqueue still accepted; resume with
    `resume`.
  - **drain** — stop ACCEPTING new jobs (enqueue answers `HL1005 queue_draining`),
    keep handing out the ones already queued until empty.
  - **purge** — delete every `queued` and `scheduled` job immediately. Irreversible.
    Reserved jobs are not touched.
- Dead-letter queue: each queue `q` has `q.dead`. Dead jobs retained **14 days**.
  Replay: `harbor dlq replay <queue> [--since=<duration>] [--limit=N]`; replay
  resets attempts to 0. Purge: `harbor dlq purge <queue>`.

## Schedules

- Cron schedules create a job on a cron expression. Standard 5-field cron plus
  macros `@hourly`, `@daily`, `@weekly`, `@monthly`. No seconds field.
- `timezone`: IANA name, default `UTC`. DST: a local time that does not exist is
  skipped; a repeated local time fires once.
- Minimum interval: **1 minute** on every plan.
- Schedules per project: Free 5, Team 100, Scale 1000.
- Missed runs (Harborline outage or paused schedule): **not backfilled**; a
  `schedule.missed` webhook event fires (3.4.0).
- `overlap`: `allow` (default) | `skip` (skip a run while the previous job of the
  same schedule is still not finished).

## Workers

- Pull model: `POST /v3/queues/{queue}/reserve` with long-poll `wait` up to 20 s,
  batch reserve up to 50 jobs.
- SDK worker options: `concurrency` (default 1 in Node SDK worker, 4 in Python),
  `heartbeatInterval` (default: one third of the visibility timeout),
  `shutdownGrace` (default 30 s: on SIGTERM stop reserving, wait for running jobs,
  then nack the rest so they return immediately).
- CLI worker: `harbor workers start --queue=<q> --concurrency=N -- <command>` runs a
  shell command per job with the payload on stdin.

## Webhooks

- Events: `job.succeeded`, `job.failed`, `job.dead`, `queue.paused`,
  `queue.drained`, `schedule.missed`.
- Signature: header `Harbor-Signature: t=<unix-seconds>,v1=<hex>`; HMAC-SHA256 with
  the endpoint's signing secret (`whsec_…`) over `"<t>.<raw body>"`. Tolerance
  **5 minutes**. Compare in constant time. Use the RAW body.
- v2 header was `X-Harbor-Sig` (HMAC-SHA1). Removed in v3.
- Delivery: endpoint must answer 2xx within **10 s**. Retries: up to **8 attempts
  over 24 h** (exponential). After that the event is marked failed and visible in
  the dashboard for 7 days.
- Webhook endpoints per project: 10.

## Auth

- API keys: `hl_live_…` and `hl_test_…` (test keys reach a sandbox project only).
- Header: `Authorization: Bearer <key>`.
- Scoped tokens: scopes `jobs:read`, `jobs:write`, `queues:admin`,
  `schedules:write`, `webhooks:admin`, `metrics:read`. A key created without
  scopes has all scopes.
- Key rotation: `harbor keys rotate` creates a new key; the old one keeps working
  for **24 h** (overlap window), then is revoked.
- No OAuth, no SAML for API access. (SAML SSO exists for the DASHBOARD on Scale only.)

## Regions

- `us-east-1` (default), `eu-central-1` (3.3.0), `ap-southeast-2`.
- Region is set at project creation and **cannot be changed**; migrate by creating a
  new project and replaying jobs with `harbor migrate` (exports pending jobs and
  schedules; does not move succeeded history).
- Endpoint per region: `https://api.<region>.harborline.dev/v3` (e.g.
  `https://api.eu-central-1.harborline.dev/v3`).

## Plans and limits

| | Free | Team | Scale |
|---|---|---|---|
| price | $0 | $49 / month | $499 / month |
| job executions / month | 10,000 | 2,000,000 | 25,000,000 |
| overage | none (hard stop, `HL2002`) | $0.40 per 10k | $0.25 per 10k |
| queues | 3 | 50 | unlimited |
| succeeded-job history | 1 day | 7 days | 30 days |
| logs retention | 3 days | 14 days | 30 days |
| API rate limit | 20 req/s | 200 req/s | 1000 req/s |
| audit log | — | 90 days | 1 year |
| IP allowlist | — | — | yes |
| SSO (dashboard) | — | — | SAML |
| SLA | — | 99.9 % | 99.95 % |
| support | community | email (1 business day) | dedicated, 1 h P1 |

- Burst: 2× the API rate limit for up to 10 s.
- An "execution" is one attempt (a retry counts again).
- Rate limit answer: HTTP 429, `HL2001 rate_limited`, `Retry-After` seconds.

## Errors

| code | name | HTTP |
|---|---|---|
| HL1001 | invalid_payload | 400 |
| HL1002 | payload_too_large | 413 |
| HL1003 | queue_not_found | 404 |
| HL1004 | idempotency_conflict | 409 |
| HL1005 | queue_draining | 409 |
| HL2001 | rate_limited | 429 |
| HL2002 | quota_exceeded | 402 |
| HL3001 | lease_expired | 409 |
| HL3002 | job_not_reserved | 409 |
| HL4001 | unauthorized | 401 |
| HL4003 | forbidden_scope | 403 |
| HL5000 | internal | 500 |

## CLI `harbor`

- Install: `npm i -g @harborline/cli` or `brew install harborline/tap/harbor`.
- `harbor login` (browser device flow, stores a token in `~/.config/harbor/credentials`).
- `harbor init` writes `harbor.toml`.
- `harbor queues create|list|get|pause|resume|drain|purge|delete`
- `harbor jobs enqueue|get|list|cancel|retry`
- `harbor dlq list|replay|purge`
- `harbor schedules create|list|pause|resume|delete`
- `harbor workers start`
- `harbor keys create|list|rotate|revoke`
- `harbor logs tail [--queue] [--level]`
- `harbor migrate --to-project=<id>`
- Global flags: `--project`, `--region`, `--profile`, `--output=table|json`, `--yes`.
- Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 rate limited.

## `harbor.toml`

```toml
[project]
id = "prj_01HZX…"
region = "eu-central-1"

[queue.defaults]
visibility_timeout = "60s"
max_attempts = 5
backoff = "exponential"

[queues.emails]
concurrency = 20
rate_limit = "100/m"

[worker]
heartbeat_interval = "20s"
shutdown_grace = "30s"
```

Env vars: `HARBOR_API_KEY`, `HARBOR_PROJECT`, `HARBOR_REGION`, `HARBOR_ENDPOINT`,
`HARBOR_PROFILE`, `HARBOR_LOG_LEVEL` (`debug|info|warn|error`, default `info`).
Precedence: flag > env > `harbor.toml` > profile defaults.

## SDKs

- Node: `@harborline/sdk` (v2 was `@harborline/client`). Node 18+.

```ts
import { Harbor, PermanentError } from '@harborline/sdk'
const harbor = new Harbor({ apiKey: process.env.HARBOR_API_KEY, region: 'eu-central-1' })
await harbor.queue('emails').enqueue({ to: 'a@b.c' }, { delay: '10m', idempotencyKey: 'welcome-42' })
harbor.worker('emails', async (job) => { /* … */ }, { concurrency: 10 })
```

- Python: `harborline` on PyPI, Python 3.9+.

```python
from harborline import Harbor, PermanentError
harbor = Harbor(api_key=os.environ["HARBOR_API_KEY"])
harbor.queue("emails").enqueue({"to": "a@b.c"}, delay="10m")

@harbor.worker("emails", concurrency=10)
def send(job): ...
```

## REST API (v3)

- `POST /v3/queues/{queue}/jobs` enqueue; `POST /v3/queues/{queue}/jobs:batch`
- `GET /v3/jobs/{id}`; `POST /v3/jobs/{id}/cancel`; `POST /v3/jobs/{id}/retry`
- `POST /v3/queues/{queue}/reserve`; `POST /v3/jobs/{id}/ack`;
  `POST /v3/jobs/{id}/nack` (`{delay?, permanent?}`); `POST /v3/jobs/{id}/touch`
- `GET /v3/queues/{queue}/stats`
- Pagination: cursor; `limit` max 100 (default 20); `next_cursor` in the body.

## Observability

- Metrics endpoint: `GET /v3/metrics` in Prometheus text format, needs `metrics:read`.
  Series: `harbor_queue_depth`, `harbor_job_latency_seconds` (histogram, enqueue →
  start), `harbor_job_duration_seconds`, `harbor_job_attempts_total`,
  `harbor_dead_jobs_total`.
- Trace propagation: a W3C `traceparent` passed in job headers at enqueue is handed
  to the worker.
- Dashboard shows the last 1,000 jobs per queue.

## Security

- Encryption at rest AES-256; TLS 1.2+ only.
- Client-side payload encryption: SDK `encrypt: { key }` option (AES-256-GCM); the
  key never leaves your servers; Harborline cannot read encrypted payloads, so
  payload search in the dashboard is unavailable for them.
- IP allowlist on Scale.
- Audit log on Team (90 days) and Scale (1 year).

## Deliberate CONTENT gaps (questions about these are negatives)

- On-premise / self-hosted Harborline: not documented anywhere.
- Kafka / AMQP protocol compatibility: not documented.
- A GraphQL API: not documented.
- Job priorities beyond "no priorities, use queues": no numeric priority docs.
- Go / Ruby / Java SDKs: not documented.
- HIPAA / SOC 2 report details: not documented.
- Price for Enterprise / custom contracts: not documented.
- Windows service install for workers: not documented.
