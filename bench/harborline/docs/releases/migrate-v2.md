---
title: Migrate from v2
description: Move code from Harborline v2 to v3 after the v2 end of life — new packages and endpoints, renamed options, new limits and defaults, webhook signatures and behaviour changes.
---

# Migrate from v2

Harborline v2 reached end of life on **2026-06-30**. Since 2026-07-01 every v2 endpoint answers `410 Gone`, so code that still uses v2 has stopped working. This guide lists everything that differs in v3, and the order in which to change it. Most applications need a package upgrade, a handful of renamed options and a new webhook verification.

## Before you start

Find every place that talks to Harborline:

- Node.js code that imports `@harborline/client`, Python code on `harborline` 2.x, and direct HTTP calls to paths that start with `/v2`.
- Webhook handlers that check the `X-Harbor-Sig` header.
- Configuration that sets attempt, timeout or delay options — in code, in environment files and in deployment templates.

Your workspace, projects, queues, keys and webhook endpoints carry over unchanged: they are the same objects in v3. Only the API surface and the client libraries change, so the migration is a code change and needs no data export.

## Upgrade the packages and endpoints

| | v2 | v3 |
|---|---|---|
| Node.js package | `@harborline/client` | `@harborline/sdk`, Node.js 18+ |
| Python package | `harborline` 2.x | `harborline` 3.x, Python 3.9+ |
| Base URL | `https://api.harborline.dev/v2` | `https://api.<region>.harborline.dev/v3` |
| CLI | `harbor` 2.x | `harbor` 3.x, from `npm i -g @harborline/cli` |

```bash
npm uninstall @harborline/client && npm install @harborline/sdk
pip install --upgrade "harborline>=3"
```

In Node.js the client class keeps its name, `Harbor`, but the import path changes. v3 hosts are per region, so set `region`, or `HARBOR_REGION`, for every project outside `us-east-1`.

## Renamed options

Several job and queue options have new names in v3. The old names are rejected with `HL1001 invalid_payload`:

| v2 name (Node.js / Python) | v3 name (Node.js) | v3 name (Python, REST, harbor.toml) |
|---|---|---|
| `retries` / `retries` | `maxAttempts` | `max_attempts` |
| `timeout` / `timeout` | `visibilityTimeout` | `visibility_timeout` |
| `delaySeconds` / `delay_seconds` | `delay` | `delay` |
| `uniqueKey` / `unique_key` | `idempotencyKey` | `idempotency_key` |

`delay` takes a duration string such as `"90s"` instead of a number of seconds. Queue settings use the same names as job options, so the same renames apply to queue configuration and to `harbor.toml`.

## New limits and defaults

| | v2 | v3 |
|---|---|---|
| Payload size | 64 KB | 256 KB |
| Default visibility timeout | 30 s | 60 s |
| Webhook signature | `X-Harbor-Sig`, HMAC-SHA1 | `Harbor-Signature`, HMAC-SHA256 with a timestamp |

Larger payloads need no change on your side. Queues that relied on the v2 default lease now hold each job for 60 seconds before it is delivered again after a worker crash; set `visibilityTimeout: '30s'` on the queue if you want the old timing back. Heartbeat intervals that you set by hand for a 30-second lease still work, because they are shorter than half of the new default.

## Webhook signatures

v3 no longer sends `X-Harbor-Sig`. Every delivery carries `Harbor-Signature: t=<unix-seconds>,v1=<hex>`, an HMAC-SHA256 of `"<t>.<raw body>"` keyed with the endpoint's signing secret (`whsec_…`), and requests whose timestamp is more than 5 minutes off must be rejected. Signing secrets carry over from v2 unchanged, so only the verification code changes:

```ts
// v2 — remove
const ok = sha1Hmac(secret, rawBody) === req.get('X-Harbor-Sig')

// v3
const event = verifyWebhook(rawBody, req.get('Harbor-Signature'), secret)
```

See [Verify webhook signatures](/guides/webhook-signatures) for complete examples in Node.js and Python.

## Behaviour changes

Some things behave differently even where the code looks the same.

**Attempt counting.** In v2 the attempt setting counted only the runs that follow a failure: a value of N meant the first run plus N more, so N+1 runs in total. In v3 the setting counts every run, the first one included. When you port a value, add one to it, or every job gets one run fewer than it did on v2.

**Leases after a crash.** With the longer default visibility timeout, a job held by a worker that crashed comes back after 60 seconds instead of 30.

**Gone endpoints.** Requests to `/v2` paths answer `410 Gone` with an empty body. There is no fallback and no redirect to v3, so a forgotten v2 call fails loudly instead of doing something unexpected.

## Migration checklist

1. Upgrade to `@harborline/sdk` or `harborline` 3.x, and the CLI to 3.x.
2. Point every client at its project's region with `region` or `HARBOR_REGION`.
3. Rename options as shown in the table above.
4. Recalculate attempt limits as described under behaviour changes.
5. Replace `X-Harbor-Sig` checks with `Harbor-Signature` verification.
6. Review visibility timeouts that relied on the 30-second default.
7. Replace `/v2` URLs in direct HTTP calls with `/v3` paths; the [REST API reference](/reference/api) lists them.
8. Deploy workers before producers, so that every job enqueued with v3 options meets a v3 worker.
9. Watch `harbor_dead_jobs_total` and the job logs for a day after the switch.
