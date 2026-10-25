---
title: Retries and backoff
description: Control how many times a failing job is retried, how long Harborline waits between attempts, and how to skip retries for errors that will never succeed.
---

# Retries and backoff

When an attempt fails, Harborline does not give up on the job. It waits for a backoff delay, puts the job back in the queue and lets a worker try again, until the job succeeds or runs out of attempts. This page explains how attempts are counted, how the delay is calculated, and how to configure both.

## How attempts are counted

`maxAttempts` is the total number of times a job may run, **including the first attempt**. The default is 5: one first attempt and up to four retries. When the last attempt fails, the job becomes `dead` and moves to the queue's [dead-letter queue](/guides/dead-letter).

An attempt fails when:

- the handler throws (Node.js) or raises (Python), or a CLI worker's command exits with a non-zero code;
- the worker calls `nack` on the job;
- the lease expires before the worker acknowledges the job — the attempt counter is incremented as if the attempt had failed.

Inside a handler, `job.attempt` is the number of the current attempt, starting at 1, and `job.maxAttempts` is the limit. Each attempt is one execution for billing, so a job that succeeds on its third attempt counts as three executions; see [Plans and pricing](/account/plans#what-counts-as-an-execution).

> **Note:** Coming from v2? Read [Migrate from v2](/releases/migrate-v2) before you port your retry settings.

## Backoff strategies

Between attempts a job is `failed` and waits for its backoff delay. The queue's `backoff` setting chooses the strategy; `baseDelay` (default 2 s) and `maxDelay` (default 15 min) set the scale and the ceiling. With n as the number of the attempt that just failed:

| Strategy | Delay after attempt n | With the defaults |
|---|---|---|
| `exponential` (default) | `baseDelay × 2^(n−1)` | 2 s, 4 s, 8 s, 16 s |
| `linear` | `baseDelay × n` | 2 s, 4 s, 6 s, 8 s |
| `fixed` | `baseDelay` | 2 s, 2 s, 2 s, 2 s |

No delay is ever longer than `maxDelay`. With exponential backoff and a 2-second base, the 15-minute ceiling first applies after the tenth failed attempt, so it matters only when you raise `maxAttempts` or `baseDelay`. A worker can also choose the delay of one retry: a `nack` with a `delay` replaces the computed backoff for that attempt.

## Jitter

Jitter spreads retries out, so that jobs which failed together — because a downstream API was down for a minute — do not all come back at the same moment and knock it over again. The `jitter` setting has two values:

- `full` (default): the actual delay is a random value between zero and the computed backoff delay.
- `none`: the delay is exactly the computed value.

With `full` jitter and the default exponential strategy, the retry after a second failed attempt happens somewhere between 0 and 4 seconds later. Use `none` only when you need predictable timing, for example in tests, or when every job retries against a different resource.

## Configure retries

Retry settings live on the queue. Set them when you create or update the queue:

```bash
harbor queues create payments --max-attempts=8 --backoff=exponential --base-delay=5s --max-delay=10m
```

```toml
# harbor.toml
[queues.payments]
max_attempts = 8
backoff = "exponential"
base_delay = "5s"
max_delay = "10m"
jitter = "full"
```

```ts
await harbor.queues.update('payments', { maxAttempts: 8, backoff: 'exponential', baseDelay: '5s', maxDelay: '10m' })
```

A job can override the attempt limit when it is enqueued — `enqueue(payload, { maxAttempts: 2 })` — but not the backoff, which is always the queue's. A change to the queue's settings applies to the next retry of every job in it, including jobs that are already waiting.

## Skip retries with PermanentError

Some failures never succeed on a retry: a validation error, a deleted record, a 404 from an API. Retrying them wastes attempts and executions. Throw a `PermanentError` to send the job straight to `dead` without its remaining attempts:

```ts
import { PermanentError } from '@harborline/sdk'

harbor.worker('invoices', async (job) => {
  const invoice = await db.invoices.find(job.payload.invoiceId)
  if (!invoice) throw new PermanentError('invoice not found')
  await charge(invoice)
})
```

```python
from harborline import PermanentError

@harbor.worker("invoices")
def charge_invoice(job):
    invoice = db.invoices.get(job.payload["invoice_id"])
    if invoice is None:
        raise PermanentError("invoice not found")
    charge(invoice)
```

Over HTTP, the same is `POST /v3/jobs/{id}/nack` with `{"permanent": true}`. The job then sends a `job.dead` webhook event like any other dead job.

## Retry a job by hand

`harbor jobs retry <job-id>`, or `POST /v3/jobs/{id}/retry`, runs a job again now:

- For a `failed` job, it skips the rest of the backoff delay. The attempt counter keeps its value.
- For a `dead` job, it moves the job back to `queued` in its original queue with its attempt counter reset to 0, so it gets a full set of attempts.

Canceled and succeeded jobs cannot be retried; enqueue a new job instead. Retrying needs a key with the `jobs:write` scope. To send many dead jobs back at once, replay the dead-letter queue instead of retrying jobs one by one; see [Dead-letter queue](/guides/dead-letter).

## Job retries and webhook retries

Two unrelated retry mechanisms share the word:

- **Job retries**, on this page, run your handler again when an attempt fails. They follow the queue's `maxAttempts` and `backoff`, and every attempt is a billed execution.
- **Webhook delivery retries** send an event to your webhook endpoint again when it does not answer with a 2xx status within 10 seconds. Harborline makes up to 8 delivery attempts over 24 hours. They cannot be configured, they are not executions, and they do not change the job's state.

A job can succeed while the webhook about it is still being retried, and a webhook can be delivered at the first try for a job that is still retrying. See [Webhooks](/guides/webhooks#delivery-retries).
