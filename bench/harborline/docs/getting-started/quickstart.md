---
title: Quickstart
description: Send your first background job and process it with a worker in about ten minutes, with Node.js or Python.
---

# Quickstart

This guide takes you from a new account to a job that one of your workers has processed. It uses a test key, so everything happens in your project's sandbox and nothing touches production data. Pick Node.js or Python; every step shows both.

## Before you begin

You need:

- A Harborline account. Sign up at `https://app.harborline.dev`; the Free plan is enough for this guide.
- Node.js 18 or later, or Python 3.9 or later.
- A project. The dashboard creates one when you first sign in and asks for its region. Choose the region closest to your servers: the region of a project is fixed when the project is created and cannot be changed later. `us-east-1` is the default; `eu-central-1` and `ap-southeast-2` are also available. See [Regions and migration](/guides/regions).

The guide also uses the `harbor` CLI to create a queue and to look at a job. It is optional — the dashboard can do the same — but you will want it later. [Install the CLI](/getting-started/install-cli) takes a minute.

## Create a test key

In the dashboard, open **Project settings → API keys** and select **Create key**. Choose **Test** as the key type, leave the scopes empty (a key without scopes has every scope), and copy the key. Harborline shows a key only once.

Test keys start with `hl_test_` and reach only your project's sandbox; live keys start with `hl_live_`. Export the key so the SDK and the CLI can find it:

```bash
export HARBOR_API_KEY=hl_test_xxx
# only if your project is not in us-east-1:
export HARBOR_REGION=eu-central-1
```

## Install the SDK and create a queue

Install the SDK for your language:

```bash
npm install @harborline/sdk      # Node.js 18+
pip install harborline           # Python 3.9+
```

Jobs live in queues, and a queue must exist before you can enqueue into it — enqueueing to an unknown queue fails with `HL1003 queue_not_found`. Create a queue named `emails` with the default settings:

```bash
harbor queues create emails
```

In the dashboard, the same is **Queues → New queue**. The defaults are fine for now: 10 jobs at a time, up to 5 attempts per job, exponential backoff between attempts, and a dead-letter queue for jobs that run out of attempts.

## Enqueue a job

Write a script that enqueues one job. The payload can be any JSON value up to 256 KB.

```ts
// enqueue.ts
import { Harbor } from '@harborline/sdk'

const harbor = new Harbor({ apiKey: process.env.HARBOR_API_KEY })

const job = await harbor.queue('emails').enqueue({ to: 'ada@example.com', template: 'welcome' })
console.log(job.id, job.state) // job_01JBQ8Z6X4M2N7P3R5T9V1W0YA queued
```

```python
# enqueue.py
import os
from harborline import Harbor

harbor = Harbor(api_key=os.environ["HARBOR_API_KEY"])

job = harbor.queue("emails").enqueue({"to": "ada@example.com", "template": "welcome"})
print(job.id, job.state)  # job_01JBQ8Z6X4M2N7P3R5T9V1W0YA queued
```

Run it. Every job gets an id that starts with `job_`; keep it, because you will look the job up in a minute. The job is now `queued` and waits for a worker.

## Run a worker

A worker reserves jobs from a queue and runs your handler for each one. If the handler returns, the SDK acknowledges the job and it becomes `succeeded`. If the handler throws, the attempt fails and Harborline retries the job later.

```ts
// worker.ts
import { Harbor } from '@harborline/sdk'

const harbor = new Harbor({ apiKey: process.env.HARBOR_API_KEY })

harbor.worker('emails', async (job) => {
  console.log(`attempt ${job.attempt}: welcome email to ${job.payload.to}`)
  // call your email provider here
})
```

```python
# worker.py
import os
from harborline import Harbor

harbor = Harbor(api_key=os.environ["HARBOR_API_KEY"])

@harbor.worker("emails")
def send_welcome(job):
    print(f"attempt {job.attempt}: welcome email to {job.payload['to']}")
    # call your email provider here

harbor.run()
```

Start the worker and leave it running; it picks up the job you enqueued almost at once. Stop it with Ctrl+C: the SDK lets the job in progress finish before it exits.

## See what happened

Look the job up by its id:

```bash
harbor jobs get job_01JBQ8Z6X4M2N7P3R5T9V1W0YA
```

```text
id          job_01JBQ8Z6X4M2N7P3R5T9V1W0YA
queue       emails
state       succeeded
attempt     1 of 5
created     2026-10-25 09:12:44 UTC
finished    2026-10-25 09:12:45 UTC
```

The dashboard shows the same under **Queues → emails**, next to the queue's other recent jobs. If the state is still `queued`, the worker is not connected to the same project — check that both scripts use the same key and region. If the state is `failed`, the handler threw an error; the job's `last_error` shows the message, and Harborline will try again.

## Next steps

- Read [Core concepts](/getting-started/concepts) to understand job states and leases before you write production handlers.
- Make your handler safe to run twice, because delivery is at-least-once. [Idempotency](/guides/idempotency) shows how.
- Tune [retries and backoff](/guides/retries), and decide what happens to jobs that run out of attempts in the [dead-letter queue](/guides/dead-letter).
- Run jobs later with [delayed jobs](/guides/delayed-jobs), or on a cron expression with [schedules](/guides/schedules).
- Before production, create a live key (`hl_live_…`) with only the scopes your code needs: [API keys and scopes](/account/api-keys).
