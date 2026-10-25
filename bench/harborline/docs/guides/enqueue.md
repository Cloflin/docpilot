---
title: Enqueue jobs
description: Add background jobs to a queue from Node.js, Python or plain HTTP, with delays, run times, idempotency keys and per-job overrides.
---

# Enqueue jobs

Enqueueing adds a job to a queue. A job is a JSON payload plus a few options; Harborline stores it, gives it an id, and hands it to a worker when it is due. This page covers enqueueing one job at a time. To add many jobs in one request, see [Batches](/guides/batches).

## Enqueue from Node.js

```ts
import { Harbor } from '@harborline/sdk'

const harbor = new Harbor({ apiKey: process.env.HARBOR_API_KEY, region: 'eu-central-1' })

const job = await harbor.queue('emails').enqueue(
  { to: 'ada@example.com', template: 'welcome' },
  { delay: '10m', idempotencyKey: 'welcome-42' },
)

console.log(job.id)    // job_01JBQ8Z6X4M2N7P3R5T9V1W0YA
console.log(job.state) // scheduled, because it has a delay
```

`enqueue(payload, options)` resolves to the stored job. Its `state` is `queued`, or `scheduled` when you pass `delay` or `runAt`. The promise rejects with a `HarborError` when Harborline refuses the job; `err.code` holds the error code, such as `HL1002`. See [Node.js SDK](/sdks/node).

## Enqueue from Python

```python
import os
from harborline import Harbor

harbor = Harbor(api_key=os.environ["HARBOR_API_KEY"], region="eu-central-1")

job = harbor.queue("emails").enqueue(
    {"to": "ada@example.com", "template": "welcome"},
    delay="10m",
    idempotency_key="welcome-42",
)
print(job.id, job.state)
```

Options are keyword arguments in snake_case: `delay`, `run_at`, `idempotency_key`, `max_attempts`, `visibility_timeout`, `group_key` and `headers`. A refused job raises `harborline.HarborError`, whose `code` attribute holds the error code. See [Python SDK](/sdks/python).

## Enqueue over HTTP

```bash
curl https://api.eu-central-1.harborline.dev/v3/queues/emails/jobs \
  -H "Authorization: Bearer $HARBOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "payload": { "to": "ada@example.com", "template": "welcome" },
        "delay": "10m",
        "idempotency_key": "welcome-42"
      }'
```

A new job is answered with `201 Created` and the job object:

```json
{
  "id": "job_01JBQ8Z6X4M2N7P3R5T9V1W0YA",
  "queue": "emails",
  "state": "scheduled",
  "attempt": 0,
  "max_attempts": 5,
  "run_at": "2026-10-25T09:22:44Z",
  "created_at": "2026-10-25T09:12:44Z"
}
```

The request needs a key with the `jobs:write` scope. The REST API uses snake_case field names; the [REST API reference](/reference/api) lists every field.

## Enqueue options

| Node.js | REST and Python | Description |
|---|---|---|
| `delay` | `delay` | Run after this long, for example `"10m"`. At most 30 days. |
| `runAt` | `run_at` | Run at this RFC 3339 time. At most 30 days ahead. |
| `idempotencyKey` | `idempotency_key` | Identifies the job across repeated requests. See [Idempotency](/guides/idempotency). |
| `maxAttempts` | `max_attempts` | Overrides the queue's attempt limit for this job. |
| `visibilityTimeout` | `visibility_timeout` | Overrides the queue's lease length for this job, 5 s to 12 h. |
| `groupKey` | `group_key` | Concurrency key; see [Concurrency and rate limits](/guides/concurrency). |
| `headers` | `headers` | String metadata for the worker, at most 4 KB, such as a `traceparent`. |

`delay` and `runAt` cannot be combined. Durations are strings with a unit: `500ms`, `30s`, `10m`, `2h`, `7d`. Backoff settings belong to the queue and cannot be set per job.

## Payload and metadata limits

The payload is any JSON value — usually an object — of at most **256 KB**, measured as UTF-8 encoded JSON. Headers, the job's metadata, are a flat object of string values of at most **4 KB** in total. Harborline rejects a larger payload or larger headers with `HL1002 payload_too_large` (HTTP 413), and a body that is not valid JSON with `HL1001 invalid_payload` (HTTP 400).

Keep payloads small: send the ids a worker needs, not the data itself. To process a 20 MB file, upload it to object storage and enqueue its URL or key. Small payloads are faster to enqueue and reserve, cheaper to keep in history, and they do not go stale: the worker reads the current record instead of a copy taken at enqueue time.

If you use [client-side encryption](/guides/encryption), the limit applies to the encrypted payload, which is larger than the plaintext.

## Job ids

Every job id is a ULID with a `job_` prefix, for example `job_01JBQ8Z6X4M2N7P3R5T9V1W0YA`. ULIDs sort by creation time, so ids listed in order are in the order the jobs were created. Log the id when you enqueue; it is the handle for everything else:

```bash
harbor jobs get job_01JBQ8Z6X4M2N7P3R5T9V1W0YA     # state, attempts, last error
harbor jobs cancel job_01JBQ8Z6X4M2N7P3R5T9V1W0YA  # scheduled, queued or failed jobs only
harbor jobs retry job_01JBQ8Z6X4M2N7P3R5T9V1W0YA   # run a failed or dead job again now
```

The REST equivalents are `GET /v3/jobs/{id}`, `POST /v3/jobs/{id}/cancel` and `POST /v3/jobs/{id}/retry`. A job that a worker holds (`reserved`) cannot be canceled; wait for the attempt to finish.

## Errors when enqueueing

| Code | HTTP | Cause |
|---|---|---|
| `HL1001 invalid_payload` | 400 | Not valid JSON, or an invalid option such as a delay over 30 days |
| `HL1002 payload_too_large` | 413 | Payload over 256 KB, or headers over 4 KB |
| `HL1003 queue_not_found` | 404 | The queue does not exist in this project |
| `HL1004 idempotency_conflict` | 409 | The idempotency key was used with a different payload |
| `HL1005 queue_draining` | 409 | The queue is draining and accepts no new jobs |
| `HL2001 rate_limited` | 429 | Too many API requests; wait `Retry-After` seconds |
| `HL2002 quota_exceeded` | 402 | The Free plan's monthly executions are used up |

The SDKs retry `HL2001` and `HL5000` responses on their own. The others need a change to the request or to the queue. [Error codes](/reference/errors) has the full list.
