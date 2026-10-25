---
title: Limits
---

# Limits

## Jobs and retries

| Limit | Value |
|---|---|
| Payload size | 256 KB of UTF-8 JSON; the encrypted size when client-side encryption is on |
| Headers (job metadata) | 4 KB |
| Job id | ULID with the `job_` prefix |
| `maxAttempts` default | 5, the first attempt included |
| `backoff` default | `exponential`; also `linear` and `fixed` |
| `baseDelay` default | 2 s |
| `maxDelay` default | 15 min |
| `jitter` default | `full` |
| `delay` and `runAt` | at most 30 days ahead |
| Idempotency key | up to 255 characters, kept for 24 hours |

## Leases and workers

| Limit | Value |
|---|---|
| Visibility timeout | default 60 s, minimum 5 s, maximum 12 h |
| Heartbeat (`touch`) | at most every half visibility timeout |
| SDK `heartbeatInterval` default | one third of the visibility timeout |
| Reserve long-poll `wait` | up to 20 s |
| Jobs per reserve call | up to 50 |
| Worker `concurrency` default | 1 in the Node.js SDK, 4 in the Python SDK, 1 for `harbor workers start` |
| Worker `shutdownGrace` default | 30 s |

## Queues

| Limit | Value |
|---|---|
| Queue name | `^[a-z0-9][a-z0-9._-]{0,62}$`, at most 63 characters; `.dead` suffix reserved |
| `concurrency` default | 10 jobs reserved at once, across all workers |
| `groupConcurrency` default | 1 job per `groupKey` at once |
| `rateLimit` | none by default; `<limit>/<period>`, period `s`, `m` or `h` |
| `visibilityTimeout` default | 60 s |
| `deadLetter` default | `true` |
| Dead-letter queue name | `<queue>.dead` |
| Dead-letter retention | 14 days |
| Queues per project | 3 on Free, 50 on Team, unlimited on Scale |

## Batches, lists and the dashboard

| Limit | Value |
|---|---|
| Jobs per batch | 500 |
| Batch request body | 5 MB |
| Batch response | `201` when every item is accepted, `207` with per-item results otherwise |
| List page size (`limit`) | 1 to 100, default 20 |
| List cursor | `next_cursor` in the body, `null` on the last page |
| Jobs listed per queue in the dashboard | the last 1,000 |
| Succeeded-job history | 1 day on Free, 7 days on Team, 30 days on Scale |
| Job logs | 3 days on Free, 14 days on Team, 30 days on Scale |

## Schedules and webhooks

| Limit | Value |
|---|---|
| Schedules per project | 5 on Free, 100 on Team, 1000 on Scale |
| Shortest schedule interval | 1 minute on every plan |
| Cron fields | 5, no seconds field; macros `@hourly`, `@daily`, `@weekly`, `@monthly` |
| Webhook endpoints per project | 10 |
| Webhook response time | 2xx within 10 s |
| Webhook delivery attempts | up to 8 over 24 hours |
| Failed webhook events kept | 7 days |
| Signature timestamp tolerance | 5 minutes |

## API and accounts

| Limit | Value |
|---|---|
| API rate limit per project | 20 req/s on Free, 200 req/s on Team, 1000 req/s on Scale |
| Burst | 2× the rate limit for up to 10 s |
| Over the rate limit | HTTP 429, `HL2001 rate_limited`, `Retry-After` in seconds |
| Sandbox (`hl_test_` keys) | 20 req/s; executions not billed |
| Job executions per month | 10,000 on Free, 2,000,000 on Team, 25,000,000 on Scale |
| Key rotation overlap | 24 hours |
| Signing secret roll overlap | 24 hours |
| Audit log | 90 days on Team, 1 year on Scale |
