---
title: Concurrency and rate limits
description: Limit how many jobs run at once, how fast jobs start, and how many jobs per customer run in parallel — plus how ordering and API rate limits work.
---

# Concurrency and rate limits

Harborline has three controls for how fast a queue's jobs run — queue concurrency, a queue rate limit and concurrency keys — and a separate rate limit on the API itself. Use them to protect the systems your workers call: a database that tolerates 20 connections, an email provider that allows 100 messages a minute, a partner API that must see one request per customer at a time.

## Queue concurrency

A queue's `concurrency` is the maximum number of its jobs that can be `reserved` at the same time, across all workers. The default is 10. When that many jobs are running, reserve calls return nothing until one of them is acknowledged, fails or loses its lease.

```bash
harbor queues create emails --concurrency=20
```

Queue concurrency is different from **worker concurrency**, the number of jobs one worker process runs in parallel — the `concurrency` worker option, 1 by default in Node.js and 4 in Python. The queue value caps the sum of the worker values: with a queue `concurrency` of 20, three Node.js processes with worker `concurrency: 10` run at most 20 jobs together, not 30. Set the queue value from what the downstream system can take, and the worker value from what one process can run.

## Rate limits on a queue

`rateLimit` caps how many jobs of the queue start per period. Jobs over the limit wait in `queued` until the next period begins:

```ts
await harbor.queues.update('emails', { rateLimit: { limit: 100, period: '1m' } })
```

```toml
[queues.emails]
concurrency = 20
rate_limit = "100/m"
```

In `harbor.toml` and on the CLI (`--rate-limit=100/m`) the limit is written `<limit>/<period>`, with `s`, `m` or `h` as the period. A queue's rate limit counts job starts — every attempt, retries included. It has nothing to do with the API rate limit below, which counts HTTP requests.

## Concurrency keys

Some work must be limited per customer, per account or per resource, not per queue. Since 3.2.0 you can give each job a `groupKey` and set `groupConcurrency` on the queue:

```ts
await harbor.queues.update('crm-sync', { concurrency: 50, groupConcurrency: 1 })
await harbor.queue('crm-sync').enqueue({ accountId: 'acc_812' }, { groupKey: 'acc_812' })
```

At most `groupConcurrency` jobs with the same `groupKey` are reserved at once; the default is 1. Jobs with different keys still run in parallel, up to the queue's `concurrency`. Jobs without a key are not limited by any group.

With `groupConcurrency: 1`, the jobs of one group run one at a time, in the order they were enqueued. A job that waits for a retry holds its group: later jobs with the same key wait until it succeeds, goes `dead` or is canceled.

## Ordering

A queue does not guarantee first-in, first-out order. Jobs are usually reserved roughly in the order they became `queued`, but retries, expired leases and many workers reserving in parallel mean that a later job can run before an earlier one.

If order matters, use a concurrency key with `groupConcurrency: 1`: within one `groupKey`, jobs run strictly in enqueue order, one at a time. Order across different keys is still not guaranteed. Choose the narrowest key that captures the dependency — one per order rather than one per shop — or a single busy group holds back everything behind it.

Harborline has no job priorities. To make some work go first, put it in a queue of its own with its own concurrency; the [FAQ](/help/faq#does-harborline-support-job-priorities) shows the pattern.

## API rate limits

Separately from any queue setting, every project has an API rate limit on its requests to the REST API: 20 requests per second on Free, 200 on Team and 1,000 on Scale. A project can burst to twice its limit for up to 10 seconds. Requests over the limit are answered with HTTP 429 and `HL2001 rate_limited`, with a `Retry-After` header that says how many seconds to wait.

The SDKs retry 429 responses on their own and honour `Retry-After`. Reserve calls with a long-poll `wait`, batch enqueues and batch reserves make the most of the limit: one request can move up to 500 jobs in, or 50 jobs out. See [Plans and pricing](/account/plans#api-rate-limits-and-bursts).
