---
title: Glossary
description: Definitions of the terms used across the Harborline docs — attempts, executions, leases, visibility timeout, dead-letter queue, drain, purge, concurrency keys, scopes and more.
---

# Glossary

Terms are grouped by topic. Each entry links to the page that explains it in full.

## Jobs and attempts

**Job** — a unit of work: a JSON payload of up to 256 KB plus options, stored in a queue. Its id is a ULID with the `job_` prefix. See [Enqueue jobs](/guides/enqueue).

**Payload** — the JSON data of a job, handed to the worker unchanged.

**Headers** — string metadata on a job, up to 4 KB in total, such as a `traceparent`.

**Attempt** — one run of a job by a worker. `maxAttempts` (default 5) counts every attempt, the first one included.

**Execution** — the billing unit: one attempt. Retries are executions too. See [Plans and pricing](/account/plans).

**Backoff** — the wait between a failed attempt and the next one: `exponential` (the default), `linear` or `fixed`, from `baseDelay` up to `maxDelay`. See [Retries and backoff](/guides/retries).

**Jitter** — randomness added to backoff delays so that retries spread out; `full` by default.

**Permanent error** — an error thrown as `PermanentError`, which sends a job straight to `dead` without further attempts.

## Job states

**scheduled** — the job waits for its `delay` or its `runAt` time.

**queued** — the job is ready and waits for a worker.

**reserved** — the job is leased to a worker that is running it.

**succeeded** — a worker acknowledged the job.

**failed** — an attempt failed, and the job waits for its next attempt.

**dead** — the job has no attempts left and sits in the dead-letter queue.

**canceled** — the job was canceled before it could finish.

See [Core concepts](/getting-started/concepts#job-states) for how a job moves between these states.

## Queues

**Queue** — a named list of jobs in a project, with its own settings. Names match `^[a-z0-9][a-z0-9._-]{0,62}$`.

**Concurrency** — on a queue, the most jobs reserved at once across all workers (default 10); on a worker, the number of jobs one process runs at once.

**Rate limit** — on a queue, the most jobs started per period, such as 100 per minute. Not the same as the API rate limit, which counts requests.

**Concurrency key** — a job's `groupKey`. Together with the queue's `groupConcurrency` (default 1) it limits how many jobs with the same key run at once.

**Dead-letter queue** — the queue `<name>.dead`, where jobs with no attempts left are kept. See [Dead-letter queue](/guides/dead-letter).

**Pause, drain, purge** — hold delivery to workers; refuse new jobs and finish the rest; delete all queued and scheduled jobs. See [Pause, drain and purge](/guides/queue-control).

## Workers and leases

**Worker** — your process that reserves jobs and runs them. See [Write a worker](/guides/workers).

**Reserve** — the call that hands jobs to a worker: up to 50 jobs per call, with a long-poll of up to 20 seconds.

**Lease** — a worker's exclusive hold on a reserved job, for the length of the visibility timeout.

**Visibility timeout** — the length of a lease: 60 seconds by default, from 5 seconds to 12 hours.

**Heartbeat, touch** — extending a lease while a job runs. Send one at most every half visibility timeout.

**Ack, nack** — acknowledging a job, which then succeeded, or failing an attempt, after which the job is retried or dies.

**Shutdown grace** — how long a worker waits for running jobs after SIGTERM before it nacks them; 30 seconds by default.

## Scheduling

**Delayed job** — a job with a `delay` or a `runAt`, at most 30 days ahead. See [Delayed jobs](/guides/delayed-jobs).

**Schedule** — creates a job on a cron expression, in an IANA time zone that defaults to `UTC`. See [Schedules](/guides/schedules).

**Cron expression** — five fields (minute, hour, day of month, month, day of week) or one of the macros `@hourly`, `@daily`, `@weekly` and `@monthly`.

**Overlap** — what a schedule does when the job of its previous run has not finished: `allow` (the default) or `skip`.

**Missed run** — a run that did not happen during an outage or a pause. It is not backfilled, and `schedule.missed` reports it.

## Accounts, access and webhooks

**Workspace** — your organisation: members, billing and the plan.

**Project** — the unit your code talks to: one region, and its own keys, queues, schedules and webhook endpoints.

**Region** — where a project runs: `us-east-1`, `eu-central-1` or `ap-southeast-2`, fixed at creation.

**Sandbox** — a separate copy of a project that only `hl_test_` keys reach.

**API key** — `hl_live_…` or `hl_test_…`, sent as `Authorization: Bearer <key>`. See [API keys and scopes](/account/api-keys).

**Scope** — a permission on a key, such as `jobs:write`; a key without scopes has all of them.

**Webhook endpoint** — a URL that Harborline sends events to; up to 10 per project.

**Signing secret** — `whsec_…`, the secret of one endpoint, used to verify `Harbor-Signature`.
