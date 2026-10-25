---
title: Write a worker
description: Run background jobs in your own processes — reserving jobs, concurrency, heartbeats for long jobs, graceful shutdown on deploys, and shell-command workers.
---

# Write a worker

A worker is a process you run that pulls jobs from a Harborline queue and executes them. Harborline never calls your code; your workers ask for work when they have capacity. This page covers the SDK workers for Node.js and Python, the options that control them, and the CLI worker that runs any shell command.

## How workers receive jobs

Workers use a pull model. A worker calls `POST /v3/queues/{queue}/reserve`, and Harborline answers with up to the requested number of jobs, leasing each one to that worker. Two parameters shape the call:

- `wait` — long-poll for up to 20 seconds when no job is ready, instead of answering at once with an empty list. A job that arrives during the wait is returned immediately.
- `max` — reserve up to 50 jobs in one call.

Each reserved job is leased for the queue's visibility timeout, 60 seconds by default. Before the lease runs out, the worker must acknowledge the job (`POST /v3/jobs/{id}/ack`), fail it (`POST /v3/jobs/{id}/nack`) or extend the lease (`POST /v3/jobs/{id}/touch`). The SDK workers make these calls for you; you only write the handler. The raw calls are in the [REST API reference](/reference/api#worker-endpoints).

A reserve call returns no jobs while the queue is paused, while the queue's `concurrency` is reached, or while its rate limit is used up for the current period.

## A Node.js worker

```ts
import { Harbor, PermanentError } from '@harborline/sdk'

const harbor = new Harbor({ apiKey: process.env.HARBOR_API_KEY, region: 'eu-central-1' })

const worker = harbor.worker(
  'emails',
  async (job) => {
    const user = await db.users.find(job.payload.userId)
    if (!user) throw new PermanentError(`user ${job.payload.userId} does not exist`)
    await mailer.send(user.email, job.payload.template)
  },
  { concurrency: 10 },
)
```

`harbor.worker(queue, handler, options)` starts reserving at once and returns a `Worker`. For each job it calls your handler with the job: `job.id`, `job.payload`, `job.headers`, `job.attempt` (1 on the first attempt) and `job.maxAttempts`. What happens next depends on the handler:

- It resolves: the SDK acknowledges the job and it becomes `succeeded`.
- It throws an ordinary error: the attempt fails, the error message is stored as the job's `last_error`, and Harborline retries the job after a backoff delay.
- It throws `PermanentError`: the job skips its remaining attempts and goes straight to `dead`. See [Retries and backoff](/guides/retries).

## A Python worker

```python
import os
from harborline import Harbor, PermanentError

harbor = Harbor(api_key=os.environ["HARBOR_API_KEY"], region="eu-central-1")

@harbor.worker("emails", concurrency=10)
def send(job):
    user = db.users.get(job.payload["user_id"])
    if user is None:
        raise PermanentError(f"user {job.payload['user_id']} does not exist")
    mailer.send(user.email, job.payload["template"])

if __name__ == "__main__":
    harbor.run()
```

The `@harbor.worker` decorator registers a handler, and `harbor.run()` starts every registered worker and blocks until the process receives SIGTERM or SIGINT. Plain functions run in a thread pool sized by `concurrency`. An `async def` handler runs on an asyncio event loop instead, with `concurrency` as the number of jobs in flight. Returning acknowledges the job, raising fails the attempt, and raising `PermanentError` sends the job straight to `dead`, exactly as in Node.js.

## Worker options

| Node.js | Python | Default | Description |
|---|---|---|---|
| `concurrency` | `concurrency` | `1` in Node.js, `4` in Python | Jobs this worker process runs at the same time |
| `heartbeatInterval` | `heartbeat_interval` | one third of the visibility timeout | How often the SDK extends the lease of each running job |
| `shutdownGrace` | `shutdown_grace` | `30s` | How long a shutdown waits for running jobs |
| `handleSignals` | — | `true` | Install SIGTERM and SIGINT handlers that shut the worker down gracefully |

Worker `concurrency` is per process. The queue's own `concurrency` setting caps the total across all worker processes, so ten processes with `concurrency: 10` each still run at most 10 jobs together from a queue whose `concurrency` is 10. See [Concurrency and rate limits](/guides/concurrency).

## Heartbeats and long jobs

A job must finish, or extend its lease, before the visibility timeout runs out. If it does not, the lease expires: the job goes back to `queued`, its attempt counter is incremented, another worker may receive it, and the late acknowledgement from the first worker fails with `HL3001 lease_expired`.

Extending the lease is a heartbeat, or `touch`. Each touch starts a full visibility timeout again from that moment. Send heartbeats at most every half visibility timeout; with the default 60-second lease, that means at least every 30 seconds.

The SDK workers send heartbeats automatically every `heartbeatInterval` while your handler runs — by default every third of the visibility timeout, which is every 20 seconds with the default lease. You only touch by hand when you run the reserve and ack loop yourself:

```ts
await job.touch() // the lease now runs for another full visibility timeout
```

For jobs that always take minutes, also raise the queue's visibility timeout. A crashed worker's jobs then take longer to come back, so choose a lease a little longer than a normal run.

## Graceful shutdown

When an SDK worker receives SIGTERM — a deploy, a scale-down, a container stop — it shuts down in three steps:

1. It stops reserving new jobs.
2. It waits up to `shutdownGrace` (default 30 seconds) for the jobs already running to finish and be acknowledged.
3. It nacks every job still running when the grace period ends, so those jobs return to the queue at once instead of waiting for their leases to expire.

Give the platform more time than the grace period. On Kubernetes, set `terminationGracePeriodSeconds` a few seconds above `shutdownGrace` — 40 seconds for the default — or the pod is killed before step 3 runs and its jobs come back only when their leases expire. In Node.js you can also call `await worker.close()` yourself, for example from your own signal handler with `handleSignals: false`.

## Run a worker from the CLI

```bash
harbor workers start --queue=thumbnails --concurrency=4 -- ./bin/make-thumbnail
```

`harbor workers start` runs a shell command once per job; everything after `--` is the command. For each job the CLI starts the command, writes the job's payload as JSON to its standard input, and waits for it to exit:

- Exit code `0` acknowledges the job.
- Any other exit code fails the attempt, and the job is retried according to the queue's settings.

The CLI sets `HARBOR_JOB_ID`, `HARBOR_JOB_ATTEMPT` and `HARBOR_QUEUE` in the command's environment, sends heartbeats while it runs, and forwards its standard output and standard error to the job's log as `info` and `error` lines. `--concurrency` sets how many commands run at once (default 1). The heartbeat interval and the shutdown grace come from the `[worker]` table in [harbor.toml](/reference/config#the-worker-table); on SIGTERM the CLI follows the same shutdown steps as the SDKs.
