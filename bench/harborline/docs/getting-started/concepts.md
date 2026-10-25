---
title: Core concepts
description: How workspaces, projects, queues and jobs fit together, what each job state means, and how leases make at-least-once delivery work.
---

# Core concepts

Harborline organises everything in four levels: **Workspace → Project → Queue → Job**. This page explains each level, the states a job passes through, and the lease mechanism that decides which worker runs a job and what happens when a worker disappears.

## Workspaces and projects

A **workspace** is your organisation in Harborline. It holds the members who can sign in to the dashboard, the billing details and the plan. Execution allowances are counted per workspace.

A **project** lives inside a workspace and is the unit your code talks to. Each project has its own region, API keys, queues, schedules and webhook endpoints. A common layout is one project per environment — `production`, `staging` — or one per product. Project ids start with `prj_`.

The region of a project is chosen when the project is created and cannot be changed afterwards. To move to another region you create a new project there and migrate; see [Regions and migration](/guides/regions).

Every project also has a **sandbox**: a separate copy of the project with its own queues, jobs and schedules. Test keys (`hl_test_…`) reach only the sandbox, so test suites and local development never see live jobs.

## Queues

A **queue** is a named list of jobs inside a project. Queue names must match `^[a-z0-9][a-z0-9._-]{0,62}$`: lowercase letters, digits, dots, underscores and hyphens, starting with a letter or a digit, at most 63 characters. Names ending in `.dead` are reserved for dead-letter queues.

Each queue has its own settings:

| Setting | Default | What it controls |
|---|---|---|
| `concurrency` | `10` | Jobs reserved from the queue at once, across all workers |
| `rateLimit` | none | Jobs started per period, for example 100 per minute |
| `visibilityTimeout` | `60s` | Lease length, see below |
| `maxAttempts` | `5` | Attempts per job, the first one included |
| `backoff` | `exponential` | Delay strategy between attempts |
| `deadLetter` | `true` | Keep jobs that run out of attempts |

A queue must exist before you enqueue into it; enqueueing to an unknown queue fails with `HL1003 queue_not_found`. See [Concurrency and rate limits](/guides/concurrency) and [Retries and backoff](/guides/retries).

## Job states

Every job is in exactly one of seven states:

| State | Meaning |
|---|---|
| `scheduled` | Waiting for its `delay` or a future `runAt` time |
| `queued` | Ready, waiting for a worker |
| `reserved` | Leased to a worker that is running it |
| `succeeded` | The worker acknowledged it |
| `failed` | The last attempt failed; the job will be retried after a backoff delay |
| `dead` | No attempts left; moved to the dead-letter queue |
| `canceled` | Canceled before it could finish |

`succeeded` and `canceled` are final. A `dead` job leaves the dead-letter queue only when you replay it, when you delete it, or when its retention ends. Job ids are ULIDs with a `job_` prefix, such as `job_01JBQ8Z6X4M2N7P3R5T9V1W0YA`.

## Leases and the visibility timeout

When a worker reserves a job, it takes a **lease** on it. For the length of the queue's visibility timeout the job is `reserved`, and no other worker can receive it. The default visibility timeout is 60 seconds; you can set it anywhere from 5 seconds to 12 hours, per queue or per job.

The lease ends in one of three ways:

- The worker **acknowledges** the job (ack): the job is `succeeded`.
- The worker **fails** the job (nack), or its handler throws: the attempt is over, and the job is retried or becomes `dead`.
- The lease **expires** because the worker crashed, hung or was too slow. The job returns to `queued` and its attempt counter is incremented. If the worker later tries to acknowledge it, Harborline answers `HL3001 lease_expired`.

A job that needs longer than its visibility timeout must extend its lease with `touch`, a heartbeat. Send heartbeats at most every half visibility timeout — with the default 60 seconds, at least every 30 seconds. The SDK workers send them for you; see [Write a worker](/guides/workers).

## Delivery guarantee

Harborline delivers every job **at least once**. In normal operation a job runs once, but some failures make it run again even though the work was already done:

- The handler finished, but the worker crashed or lost its network before the acknowledgement reached Harborline.
- The handler took longer than the lease and sent no heartbeats, so the lease expired and another worker received the job.
- Your application retried an enqueue request after a timeout and created a second job.

Because of this, handlers must be idempotent: running a job twice must have the same effect as running it once. Use an idempotency key when you enqueue, and design handlers so that a repeat is harmless; [Idempotency](/guides/idempotency) shows both.

## Schedules, webhooks and the dashboard

A **schedule** creates a job on a cron expression — for example every night at 02:00 in `Europe/Berlin`. See [Schedules](/guides/schedules).

A **webhook endpoint** is a URL in your system that Harborline calls when something happens: a job succeeded, failed or went dead, a queue was paused or drained, or a schedule missed a run. See [Webhooks](/guides/webhooks).

The **dashboard** at `https://app.harborline.dev` shows queues, schedules, keys and webhook deliveries. For each queue it lists the last 1,000 jobs; older jobs are available through the API for as long as your plan keeps job history.
