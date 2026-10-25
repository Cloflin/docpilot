---
title: Idempotency
---

# Idempotency

Harborline delivers every job at least once, and your own code may send the same enqueue request more than once — after a timeout, from a retrying HTTP client, or because a user clicked twice. Two tools keep that safe: **idempotency keys**, which make a repeated enqueue return the job that already exists instead of creating a second one, and **idempotent handlers**, which make it harmless when one job runs more than once.

## Idempotency keys

Pass an `idempotencyKey` when you enqueue:

```ts
await harbor.queue('emails').enqueue(
  { userId: 42, template: 'welcome' },
  { idempotencyKey: 'welcome-42' },
)
```

```python
harbor.queue("emails").enqueue({"user_id": 42, "template": "welcome"}, idempotency_key="welcome-42")
```

Over HTTP the field is `idempotency_key`. Harborline remembers each key for **24 hours** from the first enqueue that used it. Within those 24 hours, every enqueue to the same queue with the same key refers to the same job. After 24 hours the key is forgotten, and the next enqueue with it creates a new job.

Keys are scoped to a queue: `welcome-42` in `emails` and `welcome-42` in `sms` are unrelated. A key is any string of up to 255 characters.

## What a repeated enqueue returns

When an enqueue arrives with a key that Harborline already holds, and the payload is the same, Harborline does not create a job. It answers with the job that already exists:

- HTTP status `200 OK` instead of `201 Created`;
- the existing job in the body, in whatever state it is now — it may already be `succeeded`;
- no error object;
- the response header `Harbor-Idempotent-Replay: true`.

```http
HTTP/1.1 200 OK
Content-Type: application/json
Harbor-Idempotent-Replay: true

{ "id": "job_01JBQ8Z6X4M2N7P3R5T9V1W0YA", "queue": "emails", "state": "succeeded", "attempt": 1 }
```

This is not an error, and the SDKs do not throw. On such a response `job.replayed` is `true` in Node.js and `True` in Python. Treat a replay as a success: the work you asked for is already in the queue, or already done.

## When a key conflicts

An error happens in one case only: the same key arrives with a **different** payload. Harborline cannot know which payload you meant, so it refuses the request with `HL1004 idempotency_conflict` (HTTP 409) and leaves the original job unchanged.

Payloads are compared as JSON values, so key order and whitespace do not matter: `{"a":1,"b":2}` and `{ "b": 2, "a": 1 }` are the same payload. Options such as `delay` are not compared.

A conflict almost always means a bug in how keys are built: two different events produced the same key. Fix the key, not the request. Sending the rejected request again keeps failing until the 24 hours of the original key are over.

## Choose a good key

A good key names the business event behind the job, so that the same event always produces the same key and different events never do:

| Job | Good key | Why |
|---|---|---|
| Welcome email | `welcome-<userId>` | One welcome per user |
| Invoice reminder | `invoice-<invoiceId>-reminder-<n>` | One per reminder, several per invoice |
| Fan-out of an incoming webhook | `shop-event-<eventId>` | The upstream event id is already unique |
| Nightly export | `export-<date>` | One per day |

Avoid random values — a new UUID per request makes every request look new — and timestamps with seconds, which give two requests a second apart two different jobs. Do not put secrets or customer data in keys: keys are stored in plaintext and shown in the dashboard, even when the payload uses [client-side encryption](/guides/encryption).

## Make handlers safe to run twice

Keys stop a second job from being created; they do not stop one job from running twice. A lease can expire, or a worker can crash after doing the work but before its acknowledgement arrives, and then the same job runs again. Design every handler so that a second run has no extra effect:

- **Write with upserts** keyed by something stable, instead of blind inserts.
- **Record what you did.** Store the job id in the same transaction as the work, and return early when it is already there.
- **Pass keys downstream.** Many payment and email APIs accept an idempotency key of their own; use `job.id`, which stays the same across every attempt of the job.
- **Check state first.** "Send the reminder if it has not been sent" survives a second run; "send the reminder" does not.

`job.attempt` is greater than 1 on every repeated run, but it cannot tell you how far the previous run got, so check your own records instead.

## Keys in batches

Each item of a [batch](/guides/batches) carries its own key, and keys work per item exactly as they do for single enqueues. That makes a whole batch safe to send again: items that were created the first time come back with status `200` and are not created again, and only the missing ones are added. For a batch that partly failed, sending everything again with the same keys is the simplest correct retry.

The 24-hour window counts separately for each item, from the first time that item's key was used.
