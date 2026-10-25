---
title: Webhook events
description: Reference for every Harborline webhook event — job.succeeded, job.failed, job.dead, queue.paused, queue.drained and schedule.missed — with the envelope and example payloads.
---

# Webhook events

Harborline sends six event types to your [webhook endpoints](/guides/webhooks). Every event is a JSON object with the same envelope; only the `data` field differs by type. Events never contain job payloads.

## Event envelope

```json
{
  "id": "evt_01JC9R5T7V9X1Z3B5D7F9H1K3M",
  "type": "job.failed",
  "created_at": "2026-10-25T09:14:03Z",
  "project": "prj_01HZX8K2M4N6P8R0T2V4W6Y8Z0",
  "data": {}
}
```

| Field | Description |
|---|---|
| `id` | Unique event id, `evt_…`. The same on every delivery attempt; use it to skip events you have already handled |
| `type` | One of the six types below |
| `created_at` | When the event happened, not when it was delivered |
| `project` | The project the event belongs to |
| `data` | The details of the event |

Every request carries the `Harbor-Signature` header, which you must [verify](/guides/webhook-signatures), and `Harbor-Delivery-Attempt`, from 1 to 8.

## job.succeeded

Sent when a worker acknowledges a job.

```json
"data": {
  "job": { "id": "job_01JBQ8Z6X4M2N7P3R5T9V1W0YA", "queue": "emails", "state": "succeeded", "attempt": 1, "max_attempts": 5 },
  "duration_ms": 842
}
```

`duration_ms` is the time from reserve to acknowledgement of the successful attempt. A job that succeeded after retries has also sent one `job.failed` for each earlier attempt. This event fires for every successful job, so on high-volume queues subscribe only the endpoints that need it.

## job.failed

Sent when an attempt fails and the job will be retried: the job is in the `failed` state and waits for its backoff delay.

```json
"data": {
  "job": { "id": "job_01JBR2K7M9P1Q3S5T7V9X1Z3B5", "queue": "payments", "state": "failed", "attempt": 2, "max_attempts": 8 },
  "error": { "message": "upstream timeout after 30s" },
  "next_attempt_at": "2026-10-25T09:14:07Z"
}
```

`error.message` is the error the handler threw, or the `error` given to `nack`; for an expired lease it is `lease expired`. The last attempt does not send `job.failed`: a job without attempts left sends `job.dead` instead.

## job.dead

Sent when a job has no attempts left: its last attempt failed, it threw `PermanentError`, or it was nacked with `permanent: true`.

```json
"data": {
  "job": { "id": "job_01JC4D8F2H6K0M4P8R2T6W0Y4A", "queue": "emails", "state": "dead", "attempt": 5, "max_attempts": 5 },
  "error": { "message": "SMTP 550: mailbox unavailable" },
  "reason": "attempts_exhausted",
  "dead_letter": true
}
```

`reason` is `attempts_exhausted` or `permanent`. `dead_letter` is `true` when the job was kept in the queue's dead-letter queue, and `false` when the queue has `deadLetter: false` and the job was deleted. This is the event to alert on.

## queue.paused

Sent when a queue is paused, from the dashboard, the CLI or the API.

```json
"data": {
  "queue": "emails",
  "actor": { "type": "key", "id": "key_01JB5M7P9R1T3V5X7Z9B1D3F5H" }
}
```

`actor.type` is `key` for an API key or `member` for a dashboard user, with the key id or the member's email address as `id`. Resuming a queue sends no event. Use `queue.paused` to notice a queue that somebody paused and forgot about: while it stays paused, its jobs pile up in `queued`.

## queue.drained

Sent when a draining queue has no jobs left: nothing `queued`, `scheduled`, `reserved` or waiting for a retry.

```json
"data": {
  "queue": "legacy-imports",
  "drain_started_at": "2026-10-24T22:00:00Z"
}
```

The queue stays in the draining state after this event, and it keeps refusing new jobs with `HL1005 queue_draining` until it is resumed or deleted. If you drain a queue to retire it, this event is the signal that deleting it loses nothing.

## schedule.missed

Since 3.4.0. Sent when runs of a schedule did not happen, because of a Harborline outage or because the schedule was paused. The event is sent once, when the schedule runs again, and lists what was missed. Missed runs are not backfilled.

```json
"data": {
  "schedule": { "id": "sch_01JB7W3Y5A7C9E1G3J5K7M9N1P", "name": "nightly-report", "queue": "reports" },
  "reason": "paused",
  "missed_runs": ["2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z"],
  "missed_count": 2
}
```

`reason` is `outage` or `paused`. `missed_runs` holds up to 100 run times, and `missed_count` is the full number. Runs skipped because of `overlap: skip` are not missed runs and send no event.
