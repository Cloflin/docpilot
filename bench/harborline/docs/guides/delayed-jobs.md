---
title: Delayed jobs
description: Run a background job later — after a delay or at an exact time up to 30 days ahead — and cancel or reschedule it before it runs.
---

# Delayed jobs

A delayed job is a job that should not run yet. You enqueue it now with a delay or a run time; Harborline keeps it in the `scheduled` state, moves it to `queued` when its time comes, and a worker picks it up like any other job. Use delayed jobs for one-off follow-ups: a reminder in three days, a payment retry tomorrow morning, a clean-up after a trial ends.

## Delay a job by a duration

Pass `delay` with a duration string:

```ts
await harbor.queue('reminders').enqueue({ userId: 42, kind: 'trial-ending' }, { delay: '3d' })
```

```python
harbor.queue("reminders").enqueue({"user_id": 42, "kind": "trial-ending"}, delay="3d")
```

A duration is a number followed by a unit: `ms`, `s`, `m`, `h` or `d` — for example `90s`, `10m`, `36h` or `3d`. The Python SDK also accepts a `datetime.timedelta`. The delay counts from the moment Harborline accepts the job, not from the moment your code called `enqueue`.

## Run a job at a specific time

Pass `runAt` with an RFC 3339 timestamp instead:

```ts
await harbor.queue('reports').enqueue({ reportId: 'q3' }, { runAt: '2026-11-02T08:00:00Z' })
```

```python
from datetime import datetime, timezone

harbor.queue("reports").enqueue(
    {"report_id": "q3"},
    run_at=datetime(2026, 11, 2, 8, 0, tzinfo=timezone.utc),
)
```

Timestamps without a UTC offset are rejected, so a job never runs an hour off because a server's local time zone was different. A `runAt` in the past is accepted, and the job is `queued` at once. Over HTTP the fields are `delay` and `run_at`.

## How far ahead you can schedule

`delay` and `runAt` can be at most **30 days** in the future. A job further ahead is rejected with `HL1001 invalid_payload` (HTTP 400), and the error message names the field. A job can use only one of the two; passing both is rejected the same way.

For something that should happen in three months, store the date in your own database and let a daily [schedule](/guides/schedules) enqueue whatever is due, or enqueue a job that enqueues the next one. A task that repeats should always be a schedule rather than a chain of delayed jobs: a chain breaks for good the first time one link dies.

## Delayed jobs versus schedules

Both run work later, but they answer different needs:

| | Delayed job | Schedule |
|---|---|---|
| Runs | once | at every match of a cron expression |
| Defined by | `delay` or `runAt` on one job | a cron expression and a time zone |
| Furthest ahead | 30 days | no limit; it repeats |
| Payload | set per job | fixed in the schedule |
| Created with | `enqueue` | `harbor schedules create` or `POST /v3/schedules` |
| Plan limit | none | 5, 100 or 1000 schedules per project |

A schedule creates an ordinary job at each run, and that job can be retried and can die like any other. A delayed job is itself the job: once it is `queued`, nothing distinguishes it from a job enqueued without a delay.

## Cancel or reschedule a delayed job

Cancel a delayed job before it runs:

```bash
harbor jobs cancel job_01JBR2K7M9P1Q3S5T7V9X1Z3B5
```

The API call is `POST /v3/jobs/{id}/cancel`, and the Node.js SDK has `harbor.jobs.cancel(id)`. The job becomes `canceled` and never runs. Cancel works for jobs that are `scheduled`, `queued` or `failed`; a job that a worker holds cannot be canceled.

There is no way to change the run time of an existing job. To reschedule, cancel the job and enqueue a new one with the new time. If the job had an idempotency key, give the new job a different key: the canceled job still holds the old key until the key's window ends, and an enqueue with that key would return the canceled job.
