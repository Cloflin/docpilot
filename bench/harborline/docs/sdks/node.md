---
title: Node.js SDK
description: Install and configure @harborline/sdk for Node.js 18+ and TypeScript — client options, queues, jobs, workers, errors and webhook verification.
---

# Node.js SDK

`@harborline/sdk` is the official Harborline client for Node.js 18 and later. It ships ES module and CommonJS builds with TypeScript types, and covers the whole v3 API: enqueueing, workers, queue management, schedules and webhook verification.

## Install

```bash
npm install @harborline/sdk
```

The SDK has the same version number as the platform; version 3.4 supports every 3.4 feature. In v2 the package was called `@harborline/client`. That package no longer receives updates and talks only to the v2 API, which answers `410 Gone` since 2026-07-01; see [Migrate from v2](/releases/migrate-v2) to switch.

```ts
import { Harbor, PermanentError } from '@harborline/sdk'        // ES modules
const { Harbor, PermanentError } = require('@harborline/sdk')  // CommonJS
```

## Create a client

```ts
const harbor = new Harbor({ apiKey: process.env.HARBOR_API_KEY, region: 'eu-central-1' })
```

| Option | Default | Description |
|---|---|---|
| `apiKey` | `HARBOR_API_KEY` | The API key, `hl_live_…` or `hl_test_…` |
| `region` | `HARBOR_REGION`, else `us-east-1` | The project's region |
| `endpoint` | `HARBOR_ENDPOINT` | A full base URL; wins over `region` |
| `encrypt` | none | `{ key, previousKeys }` for [client-side encryption](/guides/encryption) |
| `timeout` | `30s` | Timeout of each HTTP request |
| `maxNetworkRetries` | `2` | Retries of a request after a network error, `HL2001` or `HL5000` |

A client is cheap to keep and safe to share: create one per process and reuse it. Request retries (`maxNetworkRetries`) repeat an HTTP call that did not get through; they are unrelated to job retries, which run a handler again.

## Queues and jobs

```ts
const emails = harbor.queue('emails')

const job = await emails.enqueue({ to: 'ada@example.com' }, { delay: '10m', idempotencyKey: 'welcome-42' })
const results = await emails.enqueueBatch([{ payload: { to: 'a@example.com' } }, { payload: { to: 'b@example.com' } }])
const stats = await emails.stats() // { queued, scheduled, reserved, failed, dead }

await harbor.jobs.get(job.id)
await harbor.jobs.cancel(job.id)
await harbor.jobs.retry(job.id)
const page = await harbor.jobs.list({ queue: 'emails', state: 'failed', limit: 100 })
```

Queue management lives on `harbor.queues` — `create(name, settings)`, `update(name, settings)`, `list()` and `delete(name)` — and on the queue handle: `pause()`, `resume()`, `drain()`, `purge()`, and `dead` for its [dead-letter queue](/guides/dead-letter). Schedules are on `harbor.schedules`: `create`, `list`, `pause`, `resume` and `delete`. Lists return `{ data, nextCursor }`; pass `cursor: nextCursor` to get the next page.

## Workers

```ts
const worker = harbor.worker(
  'emails',
  async (job) => {
    job.log(`sending ${job.payload.template}`)
    await send(job.payload)
  },
  { concurrency: 10, shutdownGrace: '45s' },
)

process.on('SIGUSR2', () => worker.close()) // optional; SIGTERM and SIGINT are handled for you
```

| Job property | Description |
|---|---|
| `id` | The `job_…` id, the same on every attempt |
| `payload` | The decoded, and if needed decrypted, payload |
| `headers` | The metadata given at enqueue |
| `attempt`, `maxAttempts` | The current attempt, starting at 1, and the limit |
| `touch()` | Extend the lease by a full visibility timeout |
| `log(message, level?)` | Add a line to the job's log; `level` defaults to `info` |

Worker options are `concurrency` (default 1), `heartbeatInterval` (default one third of the visibility timeout), `shutdownGrace` (default `30s`) and `handleSignals` (default `true`). See [Write a worker](/guides/workers).

## Errors

Every refused request rejects with a `HarborError`:

```ts
import { HarborError } from '@harborline/sdk'

try {
  await harbor.queue('emails').enqueue(hugePayload)
} catch (err) {
  if (err instanceof HarborError && err.code === 'HL1002') {
    // err.type === 'payload_too_large', err.status === 413
  }
  throw err
}
```

| Property | Example |
|---|---|
| `code` | `'HL1002'` |
| `type` | `'payload_too_large'` |
| `status` | `413` |
| `requestId` | `'req_01JC8K2M4P6R8T0V2X4Z6B8D0F'`; quote it when you contact support |

`PermanentError` is not a `HarborError`: you throw it from a handler to send the job straight to `dead`. `SignatureVerificationError` is thrown by `verifyWebhook`.

## Verify webhooks

`verifyWebhook(rawBody, signatureHeader, secret)` checks a webhook request and returns the parsed event, or throws `SignatureVerificationError`. It needs the raw body, as a `Buffer` or a string, not a parsed object, and it accepts a header with one or two `v1` signatures.

```ts
const event = verifyWebhook(req.body, req.get('Harbor-Signature'), process.env.HARBOR_WEBHOOK_SECRET)
if (event.type === 'job.dead') await alertOnCall(event.data.job.id)
```

Verification needs no API key and makes no network call, so it is safe to run in a function that has only the signing secret. A complete Express example is in [Verify webhook signatures](/guides/webhook-signatures#verify-with-the-sdk).

## TypeScript

Queue handles are generic over the payload type, which checks both the producer and the worker:

```ts
interface WelcomeEmail { to: string; template: 'welcome' | 'reminder' }

const emails = harbor.queue<WelcomeEmail>('emails')
await emails.enqueue({ to: 'ada@example.com', template: 'welcome' }) // checked
harbor.worker<WelcomeEmail>('emails', async (job) => console.log(job.payload.template)) // typed
```

The types describe the shape only; Harborline does not validate payloads against them. The package also exports `Job`, `JobState`, `QueueSettings`, `EnqueueOptions`, `WorkerOptions` and `WebhookEvent`.
