---
title: Introduction to Harborline
description: What Harborline is, how a background job travels from your app to your workers, and which API version to build against.
---

# Introduction to Harborline

Harborline is a managed job queue and scheduler for web applications. You push jobs over the HTTP API or with an SDK. Harborline stores each job and hands it to one of your workers when it is due. The worker acknowledges the job when the work succeeds, fails it when it does not, or extends it when it needs more time. Harborline takes care of storage, leases, retries, cron schedules and the history of every job; the only code you write is the work itself.

## What you can run on Harborline

Anything that should not happen inside a web request is a good fit:

- **Emails and notifications.** Enqueue a job from the request handler and answer the user right away; a worker talks to your mail provider.
- **Calls to slow or unreliable APIs.** Payment captures, CRM syncs and webhooks to your own customers get retries with backoff instead of an error page.
- **Reports and exports.** Long-running jobs keep their lease alive with heartbeats, so a 20-minute export is as safe as a 2-second one.
- **Follow-ups.** A delayed job runs once, up to 30 days from now: "remind the user in three days".
- **Recurring tasks.** A schedule creates a job on a cron expression in the time zone you choose: nightly clean-ups, hourly syncs, Monday reports.

Harborline does not run your code. Workers run in your own infrastructure — a container, a virtual machine, a function that polls — and pull jobs from Harborline when they have capacity.

## How a job moves through Harborline

```text
enqueue ──► queued ──► reserved ──► succeeded
   │          ▲           │
   │          │           ├──► failed ──(backoff)──► queued
   ▼          │           │
scheduled ────┘           └──► dead ──► <queue>.dead
```

1. Your application enqueues a job with a JSON payload. A job with a delay or a future run time starts as `scheduled`; every other job starts as `queued`.
2. A worker reserves the job. Reserving takes a lease: for the length of the queue's visibility timeout, no other worker can receive the job.
3. The worker acknowledges the job, and it becomes `succeeded`. If the attempt fails instead, the job waits for a backoff delay and is tried again.
4. A job with no attempts left becomes `dead` and moves to the queue's dead-letter queue, where you can inspect it and replay it.

Delivery is at-least-once: a job can reach a worker more than once, so handlers must be idempotent. [Core concepts](/getting-started/concepts) explains why.

## Versions

The current major version is **v3**. The latest release is 3.4.0, published on 2026-08-12; v3.0.0 was released on 2025-11-04. The SDKs and the `harbor` CLI share the platform's version number, so a 3.4 SDK supports every 3.4 feature.

Harborline v2 reached end of life on 2026-06-30. Since 2026-07-01 every v2 endpoint answers `410 Gone`, and the v2 Node.js package `@harborline/client` no longer receives updates. This documentation describes v3 only. If you still run v2 code, follow [Migrate from v2](/releases/migrate-v2); the [changelog](/releases/changelog) lists what changed in each release.

## Where to go next

- [Quickstart](/getting-started/quickstart) — enqueue your first job and process it with a worker in about ten minutes.
- [Core concepts](/getting-started/concepts) — workspaces, projects, queues, job states and leases.
- [Write a worker](/guides/workers) — concurrency, heartbeats and graceful shutdown.
- [Retries and backoff](/guides/retries) — how attempts are counted and spaced out.
- [REST API](/reference/api) and [CLI reference](/reference/cli) — every endpoint and every command.
- [Plans and pricing](/account/plans) — what each plan includes and how executions are counted.
