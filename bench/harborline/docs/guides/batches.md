---
title: Batches
description: Enqueue up to 500 jobs in one API call, handle per-item failures in a 207 response, and import large backlogs without hitting rate limits.
---

# Batches

A batch enqueues many jobs into one queue with a single API call. It is the efficient way to fan out — a newsletter to 50,000 subscribers, a re-index of every product — because one request carries hundreds of jobs and counts once against your API rate limit.

## Enqueue a batch

```ts
const results = await harbor.queue('newsletter').enqueueBatch(
  subscribers.map((s) => ({
    payload: { subscriberId: s.id, issue: '2026-10' },
    idempotencyKey: `newsletter-2026-10-${s.id}`,
  })),
)
```

```python
results = harbor.queue("newsletter").enqueue_batch([
    {"payload": {"subscriber_id": s.id, "issue": "2026-10"},
     "idempotency_key": f"newsletter-2026-10-{s.id}"}
    for s in subscribers
])
```

```http
POST /v3/queues/newsletter/jobs:batch
Content-Type: application/json

{ "jobs": [
    { "payload": { "subscriber_id": 1, "issue": "2026-10" }, "idempotency_key": "newsletter-2026-10-1" },
    { "payload": { "subscriber_id": 2, "issue": "2026-10" }, "idempotency_key": "newsletter-2026-10-2" }
] }
```

Each item takes the same options as a single enqueue — `delay`, `runAt`, `idempotencyKey`, `maxAttempts`, `groupKey`, `headers` — and every item goes to the same queue. The call needs the `jobs:write` scope.

## Batch limits

One batch call can carry at most **500 jobs or 5 MB** of request body, whichever comes first. Every item is also held to the single-job limits: a payload of at most 256 KB and headers of at most 4 KB.

A call over the batch limits is rejected as a whole, and nothing is enqueued:

| Problem | Error | HTTP |
|---|---|---|
| More than 500 items | `HL1001 invalid_payload` | 400 |
| Request body over 5 MB | `HL1002 payload_too_large` | 413 |
| Queue does not exist | `HL1003 queue_not_found` | 404 |
| Queue is draining | `HL1005 queue_draining` | 409 |

A single item that breaks the per-job limits does not reject the call; it fails on its own, as described below. The SDKs do not split batches for you: `enqueueBatch` with 501 items fails.

## Partial failures

When some items are accepted and others are not, the call answers `207 Multi-Status`. When every item is accepted, it answers `201 Created`. Either way the body holds one result per item, in the order you sent them:

```json
{
  "results": [
    { "status": 201, "job": { "id": "job_01JC4D8F2H6K0M4P8R2T6W0Y4A", "state": "queued" } },
    { "status": 200, "job": { "id": "job_01JCA7N3Q9S5V1X7Z3B9D5F1H7", "state": "succeeded" } },
    { "status": 413, "error": { "code": "HL1002", "name": "payload_too_large", "message": "payload is 301 KB; the limit is 256 KB" } }
  ]
}
```

Status `201` means a new job, `200` means the item's idempotency key matched a job that already exists, and a 4xx status carries the error of that item alone. The SDKs return this list and do not throw on a 207, so check each result for an `error`.

## Retry a partly failed batch

Send only what failed again, or — when every item has an idempotency key — send the whole batch again. Items that were created the first time come back with status `200` and are not created twice; only the missing ones are added.

```ts
const failed = items.filter((_, i) => results[i].error)
if (failed.length) await harbor.queue('newsletter').enqueueBatch(failed)
```

Do not send items that failed with `HL1001` or `HL1002` again unchanged: they fail again. Fix them or drop them. If the whole call fails with `HL2001 rate_limited` (HTTP 429), nothing was enqueued; wait for the number of seconds in the `Retry-After` header and send it again.

## Large imports

To enqueue a backlog larger than 500 jobs, send consecutive batches of up to 500. A batch counts as one request against the project's API rate limit, however many jobs it carries, so large imports rarely meet the limit.

Every job in a batch is still a separate job: it is billed as an execution each time it runs, it retries on its own, and it can die on its own. Batches have no shared state and no "batch finished" event. If you need to know when all the jobs of a batch are done, keep their ids and check them, or count their `job.succeeded` and `job.dead` [webhook events](/guides/webhooks).
