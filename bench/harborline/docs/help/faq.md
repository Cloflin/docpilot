---
title: FAQ
description: Answers to common Harborline questions — job priorities, ordering, jobs that run twice, retries and billing, regions, the v2 end of life, testing and job history.
---

# FAQ

## Does Harborline support job priorities?

No. Harborline has no job priorities: a job has no priority field, and a queue hands out its jobs without regard to their importance. To make some work go first, give it a queue of its own with its own concurrency:

```ts
await harbor.queues.create('emails-urgent', { concurrency: 50 })
await harbor.queues.create('emails-bulk', { concurrency: 5 })
```

Password resets go to `emails-urgent` and newsletters to `emails-bulk`. Run workers for both — one process can serve several queues — and the urgent queue never waits behind a bulk send, because each queue has its own concurrency and its own backlog. Give the urgent queue more concurrency than you expect to need.

## Why did my job run twice?

Harborline delivers at least once. A job runs again when its lease expired before the worker acknowledged it — a long job without heartbeats — when a worker crashed after the work but before the acknowledgement, or when your code enqueued it twice.

Make handlers idempotent, so that a second run has no effect, and pass an idempotency key at enqueue, so that a retried request does not create a second job. [Idempotency](/guides/idempotency) shows both, and [Troubleshooting](/help/troubleshooting#jobs-run-more-than-once) helps to find the cause when it happens often.

## Are jobs run in the order they were enqueued?

Not across a queue. Harborline does not guarantee first-in, first-out order within a queue: retries, expired leases and parallel workers reorder jobs.

If order matters for related jobs — the events of one order, the syncs of one account — give them the same `groupKey` and set the queue's `groupConcurrency` to 1. Jobs with the same key then run one at a time, in enqueue order, while jobs with different keys still run in parallel. See [Concurrency and rate limits](/guides/concurrency#ordering).

## Do retries count toward my bill?

Yes. Every attempt is an execution, and a retry is an attempt. A job that fails twice and then succeeds uses three executions; a job that uses all 5 default attempts and goes dead uses five.

Throwing `PermanentError` for errors that a retry cannot fix saves both time and executions. Webhook delivery retries are not executions, and jobs in the sandbox, reached with `hl_test_` keys, are never billed. See [Plans and pricing](/account/plans#what-counts-as-an-execution).

## Can I move my project to another region?

Not in place: a project's region is fixed when the project is created. Create a new project in the region you want and move the work to it. Either drain the old queues while new jobs already go to the new project, or copy the pending jobs and schedules with `harbor migrate --to-project=<id>`.

`harbor migrate` does not move the history of succeeded jobs. API keys and webhook endpoints belong to a project, so create new ones in the new project. See [Regions and migration](/guides/regions#move-a-project-to-another-region).

## Is the v2 API still available?

No. Harborline v2 reached end of life on 2026-06-30. Since 2026-07-01 every v2 endpoint answers `410 Gone`, and the v2 packages, such as `@harborline/client`, receive no more updates. Code that still calls v2 has stopped working.

Follow [Migrate from v2](/releases/migrate-v2) to move to v3, whose latest release is 3.4.0. The most common surprise when porting is the way attempts are counted, so read the migration guide's section on behaviour changes before you copy retry settings.

## How do I test without touching production?

Use a test key. Keys that start with `hl_test_` reach only your project's sandbox, a separate copy with its own queues and jobs, so test suites and local development never see or change live data. Sandbox executions are not billed.

Create a test key in **Project settings → API keys**, or with `harbor keys create --test`, and set it as `HARBOR_API_KEY` in your test environment. Queues are not copied between the live project and the sandbox: create the queues your tests need in the sandbox too, for example with `harbor queues create` in your test setup.

## How long are finished jobs kept?

Succeeded and canceled jobs stay readable through the API and `harbor jobs list` for the plan's history window: 1 day on Free, 7 days on Team, 30 days on Scale. Job logs are kept for 3, 14 and 30 days. Dead jobs stay in their dead-letter queue for 14 days on every plan, and pending jobs are kept until they run.

The dashboard lists only the last 1,000 jobs of each queue; use the API for older ones. Nothing is archived after the window ends, so export what you must keep, for example from `job.succeeded` webhook events.

## Can one worker process serve several queues?

Yes. Register one handler per queue in the same process: `harbor.worker('emails', …)` and `harbor.worker('reports', …)` in Node.js, or several `@harbor.worker` functions before `harbor.run()` in Python. Each registration has its own `concurrency`, and the concurrency and rate limit of each queue still apply.

This is the usual way to run the urgent and bulk queues of the pattern for priorities above. For isolation — a memory-hungry report job should not slow down emails — run separate processes instead.
