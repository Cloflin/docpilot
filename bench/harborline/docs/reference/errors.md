---
title: Error codes
description: Every Harborline error code (HL1001–HL5000) with its HTTP status, what causes it and whether to retry — invalid payloads, rate limits, quotas, expired leases and auth errors.
---

# Error codes

Every error from the Harborline API has a stable code of the form `HLnnnn`, a short name and an HTTP status. Branch on the code; the message is written for people and can change.

## Error format

```json
{
  "error": {
    "code": "HL1005",
    "name": "queue_draining",
    "message": "queue \"emails\" is draining and accepts no new jobs",
    "request_id": "req_01JC8K2M4P6R8T0V2X4Z6B8D0F"
  }
}
```

The same request id is in the `Harbor-Request-Id` response header. The SDKs expose the fields as `code`, `type`, `status` and `requestId` in Node.js, or `request_id` in Python. The first digit of a code groups it: `1` for request problems, `2` for limits, `3` for leases, `4` for access, `5` for errors inside Harborline.

## All codes

| Code | Name | HTTP | Meaning |
|---|---|---|---|
| `HL1001` | `invalid_payload` | 400 | The body is not valid JSON, or a field is invalid |
| `HL1002` | `payload_too_large` | 413 | Payload over 256 KB, headers over 4 KB, or a batch over 5 MB |
| `HL1003` | `queue_not_found` | 404 | No queue with that name in the project |
| `HL1004` | `idempotency_conflict` | 409 | The idempotency key was already used with a different payload |
| `HL1005` | `queue_draining` | 409 | The queue is draining and accepts no new jobs |
| `HL2001` | `rate_limited` | 429 | Over the project's API rate limit |
| `HL2002` | `quota_exceeded` | 402 | A plan quota is used up |
| `HL3001` | `lease_expired` | 409 | The lease on the job ended before this call |
| `HL3002` | `job_not_reserved` | 409 | The job is not reserved, so it cannot be acknowledged, failed or touched |
| `HL4001` | `unauthorized` | 401 | Missing, invalid or revoked API key, or the wrong region |
| `HL4003` | `forbidden_scope` | 403 | The key lacks the scope this endpoint needs |
| `HL5000` | `internal` | 500 | An error inside Harborline |

## Request errors

**HL1001 invalid_payload** — the request body is not valid JSON, or a field fails validation: an unknown option, `delay` and `runAt` together, a run time more than 30 days ahead, a batch of more than 500 items, a queue name that breaks the naming rules. The message names the field. Fix the request; sending it again unchanged fails again.

**HL1002 payload_too_large** — a job payload over 256 KB, headers over 4 KB, or a batch request over 5 MB. With client-side encryption the limit applies to the encrypted payload.

**HL1003 queue_not_found** — the queue does not exist in the project the key belongs to. Check the spelling and the project; queues are not created on first use.

**HL1004 idempotency_conflict** — the idempotency key was used within the last 24 hours with a different payload. See [Idempotency](/guides/idempotency).

**HL1005 queue_draining** — the queue is [draining](/guides/queue-control#drain-a-queue). Send the job to another queue, or resume the queue.

## Limit errors

**HL2001 rate_limited** (429) — the project sent more API requests than its plan allows: 20 per second on Free, 200 on Team, 1,000 on Scale, with bursts to twice that for up to 10 seconds. The `Retry-After` header says how many seconds to wait. The SDKs wait and retry on their own; the CLI exits with code 4.

**HL2002 quota_exceeded** (402) — a plan quota is used up. On the Free plan this is the hard stop at 10,000 executions a month: enqueue requests fail with `HL2002`, and queued jobs wait, until the next billing month or an upgrade. It is also the answer when you create more queues, schedules or webhook endpoints than the plan allows. Retrying does not help: upgrade, or delete what you no longer use. See [Plans and pricing](/account/plans).

## Lease errors

**HL3001 lease_expired** (409) — a worker acknowledged, failed or touched a job after its lease had ended. By then the job was back in `queued`, its attempt counter had been incremented, and another worker may already be running it. The call has no effect. Prevent it with heartbeats at most every half visibility timeout, or with a longer visibility timeout; see [Write a worker](/guides/workers#heartbeats-and-long-jobs).

**HL3002 job_not_reserved** (409) — the job is not in the `reserved` state at all: it was already acknowledged, it was canceled, or it was never reserved. A second `ack` for the same job gets this error. It is usually safe to log it and move on.

## Access errors

**HL4001 unauthorized** (401) — no `Authorization` header, a key that does not exist or was revoked, a rotated key after its 24-hour overlap, or a key sent to the endpoint of another region. On a Scale plan with an IP allowlist, requests from addresses outside the list get this error too.

**HL4003 forbidden_scope** (403) — the key is valid but lacks the scope the endpoint needs, for example a key with only `jobs:read` calling enqueue. The message names the missing scope. Use a key with that scope, or a key without scopes, which has all of them. See [API keys and scopes](/account/api-keys#scopes).

## Server errors and retries

**HL5000 internal** (500) — something went wrong inside Harborline. Retry with backoff; the SDKs do so automatically (`maxNetworkRetries`, default 2). If it persists, check `https://status.harborline.dev` and contact support with the request id.

Which errors to retry:

| Retry? | Codes |
|---|---|
| Yes, after `Retry-After` | `HL2001` |
| Yes, with backoff | `HL5000` and network errors |
| No, fix the request | `HL1001`, `HL1002`, `HL1003`, `HL1004`, `HL4001`, `HL4003` |
| No, change the situation first | `HL1005`, `HL2002` |
| No, the job has moved on | `HL3001`, `HL3002` |
