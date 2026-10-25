---
title: REST API
description: Reference for the Harborline v3 REST API — base URLs per region, authentication, every endpoint with its scope, pagination and the error format.
---

# REST API

The Harborline API is a JSON API over HTTPS. The SDKs and the CLI are built on it; use it directly from any language that can send HTTP requests.

## Base URL and conventions

Each region has its own base URL:

```text
https://api.<region>.harborline.dev/v3
```

for example `https://api.eu-central-1.harborline.dev/v3`. Use the region of your project; a key is accepted only by its own region.

- Request and response bodies are JSON with snake_case field names.
- Timestamps are RFC 3339 strings in UTC, such as `2026-10-25T09:12:44Z`.
- Durations are strings with a unit: `500ms`, `30s`, `10m`, `2h`, `7d`.
- Ids carry a type prefix: `job_`, `sch_`, `whe_`, `evt_`, `prj_`, `key_`, `req_`.
- Every response has a `Harbor-Request-Id` header. Quote it when you contact support.

The v2 API under `/v2` is gone: it has answered `410 Gone` since 2026-07-01.

## Authentication

Send an API key as a bearer token on every request:

```http
GET /v3/jobs/job_01JBQ8Z6X4M2N7P3R5T9V1W0YA HTTP/1.1
Host: api.eu-central-1.harborline.dev
Authorization: Bearer hl_live_xxx
```

A missing, invalid or revoked key — or a key sent to the wrong region — is answered with `401` and `HL4001 unauthorized`. A valid key without the scope an endpoint needs gets `403` and `HL4003 forbidden_scope`. The tables below give the scope of every endpoint; a key created without scopes has all of them. There is no OAuth: API access uses keys only. See [API keys and scopes](/account/api-keys).

## Job endpoints

| Method and path | Scope | Description |
|---|---|---|
| `POST /v3/queues/{queue}/jobs` | `jobs:write` | Enqueue a job: `201` with the job, or `200` when the idempotency key matched an existing job |
| `POST /v3/queues/{queue}/jobs:batch` | `jobs:write` | Enqueue up to 500 jobs or 5 MB: `201`, or `207` with per-item results |
| `GET /v3/jobs/{id}` | `jobs:read` | Get a job |
| `GET /v3/jobs` | `jobs:read` | List jobs; filter with `queue` and `state` |
| `POST /v3/jobs/{id}/cancel` | `jobs:write` | Cancel a `scheduled`, `queued` or `failed` job |
| `POST /v3/jobs/{id}/retry` | `jobs:write` | Run a `failed` or `dead` job again now |

Enqueue body fields: `payload` (required), `delay` or `run_at`, `idempotency_key`, `max_attempts`, `visibility_timeout`, `group_key` and `headers`. The job object has `id`, `queue`, `state`, `payload`, `headers`, `attempt`, `max_attempts`, `group_key`, `idempotency_key`, `run_at`, `created_at`, `updated_at`, `last_error`, and `next_attempt_at` while the job is `failed`.

## Worker endpoints

| Method and path | Scope | Body |
|---|---|---|
| `POST /v3/queues/{queue}/reserve` | `jobs:write` | `{"wait": 20, "max": 10}` |
| `POST /v3/jobs/{id}/ack` | `jobs:write` | none |
| `POST /v3/jobs/{id}/nack` | `jobs:write` | `{"delay": "30s", "permanent": false, "error": "…"}`, every field optional |
| `POST /v3/jobs/{id}/touch` | `jobs:write` | `{"visibility_timeout": "5m"}`, optional |

`reserve` leases up to `max` jobs (1–50, default 1) and long-polls for up to `wait` seconds (0–20, default 0). It returns `{"jobs": [...]}`, each job with a `lease_expires_at`; the list is empty when nothing arrived within `wait`. `ack` marks the job `succeeded`. `nack` fails the attempt: with `delay` it replaces the backoff of that retry, and with `permanent: true` it sends the job straight to `dead`. `touch` restarts the lease for a full visibility timeout, or for `visibility_timeout` when given. A call on a lease that has expired gets `409 HL3001 lease_expired`; a call on a job that is not reserved gets `409 HL3002 job_not_reserved`.

## Queue endpoints

| Method and path | Scope | Description |
|---|---|---|
| `POST /v3/queues` | `queues:admin` | Create a queue: `name` plus any settings |
| `GET /v3/queues` | `jobs:read` | List queues |
| `GET /v3/queues/{queue}` | `jobs:read` | Get a queue's settings and state |
| `PATCH /v3/queues/{queue}` | `queues:admin` | Change settings |
| `DELETE /v3/queues/{queue}` | `queues:admin` | Delete the queue, its jobs and its dead-letter queue |
| `POST /v3/queues/{queue}/pause`, `/resume` | `queues:admin` | Hold or restart delivery to workers |
| `POST /v3/queues/{queue}/drain` | `queues:admin` | Refuse new jobs, finish existing ones |
| `POST /v3/queues/{queue}/purge` | `queues:admin` | Delete all `queued` and `scheduled` jobs |
| `GET /v3/queues/{queue}/stats` | `jobs:read` | Counts by state |

Queue settings: `concurrency`, `rate_limit` (`{"limit": 100, "period": "1m"}`), `visibility_timeout`, `max_attempts`, `backoff`, `base_delay`, `max_delay`, `jitter`, `group_concurrency` and `dead_letter`. `stats` returns the counts `queued`, `scheduled`, `reserved`, `failed` and `dead`.

## Dead-letter endpoints

| Method and path | Scope | Description |
|---|---|---|
| `GET /v3/queues/{queue}/dead` | `jobs:read` | List the dead jobs of a queue, newest first |
| `POST /v3/queues/{queue}/dead/replay` | `queues:admin` | Replay dead jobs into the queue; optional `since` and `limit` |
| `DELETE /v3/queues/{queue}/dead` | `queues:admin` | Delete every dead job of the queue |

Replay accepts `{"since": "24h", "limit": 500}`: `since` keeps only jobs that died within that duration, and `limit` caps how many one call replays. It answers with the number of jobs replayed, and with `409 HL1005 queue_draining` when the queue is draining. See [Dead-letter queue](/guides/dead-letter) for what replay does to a job.

## Schedule, webhook and metrics endpoints

| Method and path | Scope | Description |
|---|---|---|
| `POST /v3/schedules` | `schedules:write` | Create: `name`, `queue`, `cron`, `timezone`, `payload`, `overlap` |
| `GET /v3/schedules` | `jobs:read` | List schedules with their next run time |
| `PATCH /v3/schedules/{id}` | `schedules:write` | Change a schedule |
| `POST /v3/schedules/{id}/pause`, `/resume` | `schedules:write` | Pause or resume a schedule |
| `DELETE /v3/schedules/{id}` | `schedules:write` | Delete a schedule |
| `POST /v3/webhooks` | `webhooks:admin` | Add an endpoint: `url`, `events`; returns the signing secret once |
| `GET /v3/webhooks` | `webhooks:admin` | List endpoints |
| `DELETE /v3/webhooks/{id}` | `webhooks:admin` | Remove an endpoint |
| `POST /v3/webhooks/{id}/roll-secret` | `webhooks:admin` | Issue a new signing secret |
| `GET /v3/metrics` | `metrics:read` | Prometheus metrics |

API keys are managed in the dashboard and with `harbor keys`; the API has no key endpoints.

## Pagination

List endpoints use cursors. Pass `limit` (1–100, default 20) and, for every page after the first, the `cursor` from the previous response:

```http
GET /v3/jobs?queue=emails&state=dead&limit=100
```

```json
{
  "data": [{ "id": "job_01JC4D8F2H6K0M4P8R2T6W0Y4A", "queue": "emails", "state": "dead" }],
  "next_cursor": "c_9f2a71e4"
}
```

`next_cursor` is `null` on the last page. Cursors are opaque: do not build or change them. Results are ordered newest first. A `limit` above 100 is rejected with `HL1001 invalid_payload`.

## Errors and rate limits

Every error uses one envelope:

```json
{
  "error": {
    "code": "HL1003",
    "name": "queue_not_found",
    "message": "queue \"emials\" does not exist in project prj_01HZX8K2M4N6P8R0T2V4W6Y8Z0",
    "request_id": "req_01JC8K2M4P6R8T0V2X4Z6B8D0F"
  }
}
```

`code` is stable and safe to branch on; `message` is written for people and may change. Over the project's rate limit, the API answers `429` with `HL2001 rate_limited` and a `Retry-After` header in seconds. Every code is listed in [Error codes](/reference/errors).
