---
title: Pause, drain and purge
---

# Pause, drain and purge

A queue can be paused, drained or purged. The three operations sound alike but do very different things to new jobs, to waiting jobs and to jobs that are running. Pick the wrong one and you either lose jobs or keep accepting work you meant to turn away, so read the comparison before you reach for one.

## Compare the three operations

| | Pause | Drain | Purge |
|---|---|---|---|
| New enqueues | accepted | rejected with `HL1005 queue_draining` | accepted |
| Workers receive jobs | no | yes, until no queued jobs remain | yes, as usual |
| `queued` and `scheduled` jobs | kept, waiting | handed out as usual | deleted |
| `reserved` jobs | finish normally | finish normally | not touched |
| Dead-letter queue | not touched | not touched | not touched |
| Undo | `resume` | `resume` | impossible |
| Webhook event | `queue.paused` | `queue.drained`, when done | none |

All three need a key with the `queues:admin` scope, or a dashboard login, and every use is recorded in the [audit log](/account/security#audit-log) on the plans that have one.

## Pause a queue

Pausing holds delivery: workers receive no jobs from the queue, while producers keep enqueueing as before. New jobs, and delayed jobs whose time arrives, wait in `queued`. Jobs that workers already hold keep running and are acknowledged as usual.

```bash
harbor queues pause emails
harbor queues resume emails
```

```ts
await harbor.queue('emails').pause()
await harbor.queue('emails').resume()
```

Over HTTP: `POST /v3/queues/{queue}/pause` and `POST /v3/queues/{queue}/resume`. Pausing sends a `queue.paused` webhook event.

Pause when a downstream system is down or being upgraded and you want the work to wait for it instead of burning attempts: a paused queue hands out nothing, so its jobs cannot fail and nothing is lost. Schedules that target the queue keep creating jobs, which wait with the rest. When you resume, workers start receiving jobs at once, and the backlog is worked off at the queue's normal concurrency and rate limit.

## Drain a queue

Draining is the opposite of pausing. A draining queue rejects every new enqueue with `HL1005 queue_draining` (HTTP 409), but keeps handing its existing jobs to workers until none are left: queued jobs, delayed jobs as they come due, and retries of jobs that fail along the way.

```bash
harbor queues drain emails
```

```ts
await harbor.queue('emails').drain()
```

Over HTTP: `POST /v3/queues/{queue}/drain`. When the last job is finished — no job left `queued`, `scheduled`, `reserved` or waiting for a retry — Harborline sends a `queue.drained` webhook event. The queue then stays in the draining state and keeps rejecting enqueues until you `resume` it or delete it.

Drain a queue to retire it: point producers somewhere else, drain, wait for `queue.drained`, then delete the queue with nothing lost. Draining is also how you let the work in one project finish before you move to another region; see [Regions and migration](/guides/regions).

## Purge a queue

Purging deletes every `queued` and `scheduled` job in the queue immediately. It is irreversible: there is no undo and no copy, and purged jobs send no webhook events.

```bash
harbor queues purge emails          # asks for confirmation
harbor queues purge emails --yes    # in scripts
```

```ts
const { deleted } = await harbor.queue('emails').purge()
```

Over HTTP: `POST /v3/queues/{queue}/purge`. Jobs that are `reserved` at that moment are not touched: they finish, and if they fail they are retried as usual. Jobs in the `failed` state that wait for a retry are not deleted either; they return to `queued` when their delay ends.

The queue's dead-letter queue is not touched. To delete dead jobs, delete them from the dead-letter queue separately; see [Dead-letter queue](/guides/dead-letter#delete-dead-jobs). The queue itself, its settings and its schedules remain, and new enqueues are accepted at once.

## Choose the right operation

Typical situations:

- **A downstream API is down for an hour.** Pause. Jobs wait instead of spending their attempts, and nothing is lost. Resume when the API is back.
- **You are retiring a queue or moving its traffic elsewhere.** Drain, wait for `queue.drained`, then delete the queue.
- **A bug enqueued 40,000 jobs that must never run.** Pause first, so workers take no more of them while you check what to delete, then purge, then resume.
- **A deploy changes the payload format of a job.** None of the three: deploy workers that understand both formats first, then the producers.

Deleting a queue (`harbor queues delete`) removes the queue, all of its jobs and its dead-letter queue. Harborline refuses to delete a queue while it has `reserved` jobs.
