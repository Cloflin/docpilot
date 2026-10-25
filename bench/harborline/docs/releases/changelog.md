---
title: Changelog
description: Release notes for Harborline v3 — new features, changes and fixes in 3.4.0, 3.3.0, 3.2.0, 3.1.0 and 3.0.0, and the v2 end of life.
---

# Changelog

Harborline releases the platform, the SDKs and the CLI together, under one version number. Minor releases add features and never break v3 code; the API path stays `/v3` for the whole major version.

## 3.4.0 — 2026-08-12

- **New webhook event `schedule.missed`.** Sent when runs of a schedule did not happen, because of a Harborline outage or because the schedule was paused. One event lists the missed run times. Missed runs are still not backfilled. See [Schedules](/guides/schedules#missed-runs).
- `harbor schedules list` shows the next run time of each schedule.
- The job list in the dashboard can be filtered by `groupKey`.
- Node.js SDK: `job.log()` accepts a level, as in the Python SDK.
- Fixed: `harbor workers start` did not pass SIGTERM on to the running command, so a command could be killed without its own shutdown handler running.

## 3.3.0 — 2026-05-19

- **New region `eu-central-1`** (Frankfurt), at `https://api.eu-central-1.harborline.dev/v3`. Existing projects stay where they are, because the region of a project cannot change.
- **`harbor migrate`** copies pending jobs and schedules from one project to another, for example into a new project in `eu-central-1`. It does not move succeeded-job history. See [Regions and migration](/guides/regions).
- Audit log entries can be exported as CSV.
- Python SDK: `harbor.run(queues=[...])` starts only some of the registered workers.

## 3.2.0 — 2026-03-10

- **Concurrency keys.** The new `groupKey` of a job and the new `groupConcurrency` of a queue (default 1) limit how many jobs with the same key run at once. With `groupConcurrency` 1, jobs with the same key run in enqueue order. See [Concurrency and rate limits](/guides/concurrency#concurrency-keys).
- Python SDK: `async def` handlers run on an asyncio event loop.
- `--output=json` is available on every CLI command.
- Fixed: queue stats counted jobs that wait for a retry as `queued` instead of `failed`.

## 3.1.0 — 2026-01-20

- **Prometheus metrics** at `GET /v3/metrics`, with the new `metrics:read` scope: queue depth, job latency and duration, attempts and dead jobs. See [Observability](/guides/observability).
- **Schedule overlap.** `overlap: skip` skips a run while the previous job of the schedule has not finished; the default stays `allow`.
- Webhook deliveries carry a `Harbor-Delivery-Attempt` header.
- `harbor logs tail` takes `--level`.
- Fixed: `harbor jobs list --state=dead` returned jobs from every queue when `--queue` was missing; it now asks for a queue.

## 3.0.0 — 2025-11-04

The first release of v3. Its breaking changes from v2 are all covered in [Migrate from v2](/releases/migrate-v2):

- New packages and per-region API hosts: `@harborline/sdk` replaces `@harborline/client`, and the API lives at `https://api.<region>.harborline.dev/v3`.
- Several job and queue options were renamed.
- The payload limit went up from 64 KB to 256 KB, and the default visibility timeout from 30 to 60 seconds.
- Webhooks are signed with `Harbor-Signature` (HMAC-SHA256 with a timestamp); `X-Harbor-Sig` (HMAC-SHA1) was removed.

v2 was deprecated with this release, with an end-of-life date of 2026-06-30.

## v2 end of life

Harborline v2 reached end of life on 2026-06-30. Since 2026-07-01:

- every request to a `/v2` endpoint answers `410 Gone`;
- `@harborline/client` and `harborline` 2.x receive no updates, security fixes included;
- the v2 documentation is no longer published.

Workspaces, projects, queues, keys and webhook endpoints were not affected; they work with v3 clients. If you are still on v2, follow [Migrate from v2](/releases/migrate-v2), which lists every renamed option and changed default.
