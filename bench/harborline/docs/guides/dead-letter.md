---
title: Dead-letter queue
---

# Dead-letter queue

A job that has no attempts left is not deleted. Harborline moves it to the dead-letter queue that belongs to its queue, where it waits for you to inspect it, fix the cause and replay it — or to delete it. This page covers when jobs move there, how long they stay, and the operations on a dead-letter queue.

## When a job moves to the dead-letter queue

A job becomes `dead` and moves to the dead-letter queue when:

- its last attempt fails, that is, the attempt number reached the queue's `maxAttempts` (default 5);
- its handler throws `PermanentError` in Node.js, or raises it in Python, which skips the remaining attempts;
- a worker calls `POST /v3/jobs/{id}/nack` with `{"permanent": true}`;
- the lease of its last attempt expires before the worker acknowledges it.

Harborline then sends a `job.dead` [webhook event](/reference/webhook-events#jobdead) and increments the `harbor_dead_jobs_total` metric for the queue. The job keeps its id, payload, headers and attempt history, and its `last_error` holds the error message of the final attempt.

## Naming and retention

Every queue `q` has a dead-letter queue named `q.dead`: the dead-letter queue of `emails` is `emails.dead`. Harborline creates it together with the queue. Names ending in `.dead` are reserved, so you cannot create a queue with such a name yourself. The dead-letter queue appears under its name in the dashboard, in `harbor jobs list --queue=emails.dead`, and in the `queue` label of metrics such as `harbor_queue_depth`.

Jobs stay in the dead-letter queue for **14 days**, on every plan. After 14 days a dead job is deleted for good, so replay or export anything you need before then.

Nothing reads from a dead-letter queue on its own: workers cannot reserve from it, and jobs leave it only when you replay them, when you delete them, or when their 14 days end.

## Inspect dead jobs

Before you replay anything, find out why the jobs died. Each dead job carries its `last_error` and its attempt count. In the dashboard, open the queue and choose the **Dead** tab. With the SDKs or the API:

```ts
const page = await harbor.queue('emails').dead.list({ limit: 50 })
for (const job of page.data) {
  console.log(job.id, job.attempt, job.lastError?.message)
}
```

```python
page = harbor.queue("emails").dead.list(limit=50)
for job in page.data:
    print(job.id, job.attempt, job.last_error.message if job.last_error else None)
```

```http
GET /v3/queues/emails/dead?limit=50
Authorization: Bearer hl_live_xxx
```

The list is paginated like every other list in the API: pass the `next_cursor` of one page as `cursor` to get the next one. Reading needs the `jobs:read` scope.

## Replay dead jobs

Replaying moves dead jobs back to their original queue as `queued`, with their attempt counter **reset to 0**, so each one gets the queue's full `maxAttempts` again. Jobs keep their ids and payloads. Deploy the fix first: a job that died because of a bug dies again.

```ts
// replay what died in the last 24 hours, at most 500 jobs
const { replayed } = await harbor.queue('emails').dead.replay({ since: '24h', limit: 500 })
```

```python
result = harbor.queue("emails").dead.replay(since="24h", limit=500)
print(result.replayed)
```

```http
POST /v3/queues/emails/dead/replay
Content-Type: application/json

{ "since": "24h", "limit": 500 }
```

Both filters are optional: `since` replays only jobs that died within that duration, and `limit` caps how many jobs one call replays. Without them, every job in the dead-letter queue is replayed. Replaying needs the `queues:admin` scope, and it fails with `HL1005 queue_draining` while the original queue is draining. The `harbor` CLI has the same operation; see the [CLI reference](/reference/cli#dead-letter-commands).

## Delete dead jobs

To get rid of dead jobs you never want to run again, delete them:

```ts
await harbor.queue('emails').dead.purge()
```

```http
DELETE /v3/queues/emails/dead
```

This deletes every job in the dead-letter queue at once and cannot be undone. It needs the `queues:admin` scope. Deleting dead jobs does not affect the queue itself: its `queued`, `scheduled` and `reserved` jobs stay where they are.

Deleting the dead-letter queue's jobs is not the same as purging the queue. A [queue purge](/guides/queue-control#purge-a-queue) deletes `queued` and `scheduled` jobs and leaves the dead-letter queue alone; this operation does the reverse.

## Turn the dead-letter queue off

Set `deadLetter: false` on a queue when dead jobs are worthless to you — cache warm-ups, metrics pings, anything the next run replaces anyway:

```bash
harbor queues create cache-warmup --dead-letter=false
```

```toml
[queues.cache-warmup]
dead_letter = false
```

With the dead-letter queue off, a job that runs out of attempts still becomes `dead` and still sends a `job.dead` webhook event, but it is deleted at once instead of being kept for 14 days, and you cannot replay it later. Turning the setting back on affects only jobs that die from then on.
