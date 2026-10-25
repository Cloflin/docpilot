---
title: Webhooks
description: Get notified in your own app when jobs succeed, fail or die, when queues are paused or drained, and when schedules miss a run — delivery, retries and limits.
---

# Webhooks

Webhooks let Harborline call your application when something happens in a project: a job succeeds, fails or goes dead, a queue is paused or drained, a schedule misses a run. Harborline sends each event as an HTTPS `POST` to the endpoints you register. Use webhooks for alerting, for dashboards of your own, and for follow-up work that should start when a job ends.

## Add an endpoint

In the dashboard, open **Project settings → Webhooks**, select **Add endpoint**, enter an HTTPS URL and pick the events it should receive. Over the API:

```bash
curl https://api.us-east-1.harborline.dev/v3/webhooks \
  -H "Authorization: Bearer $HARBOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/harbor", "events": ["job.dead", "schedule.missed"] }'
```

The response contains the endpoint's signing secret, `whsec_…`. It is shown only once: store it where your webhook handler can read it, and use it to [verify every request](/guides/webhook-signatures). Managing endpoints needs the `webhooks:admin` scope.

A project can have up to **10** webhook endpoints. Each endpoint receives only the events it subscribes to; subscribe with `["*"]` to receive all of them. The CLI has no webhook commands.

## Event types

There are six event types:

| Event | Sent when |
|---|---|
| `job.succeeded` | A worker acknowledged a job |
| `job.failed` | An attempt failed and the job will be retried |
| `job.dead` | A job has no attempts left |
| `queue.paused` | A queue was paused |
| `queue.drained` | A draining queue has no jobs left |
| `schedule.missed` | Schedule runs did not happen (since 3.4.0) |

Events never include the job's payload — only its id, queue, state and attempt numbers, plus the error message for failures. Fetch the job with `GET /v3/jobs/{id}` if your handler needs more. `job.succeeded` fires for every acknowledged job, so on a busy queue subscribe to it only if you use it. The fields of each event are in the [webhook events reference](/reference/webhook-events).

## Delivery

Harborline sends each event as a `POST` with a JSON body and these headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Harbor-Signature` | `t=<unix-seconds>,v1=<hex>`; see [Verify webhook signatures](/guides/webhook-signatures) |
| `Harbor-Delivery-Attempt` | `1` for the first delivery, up to `8` |

Your endpoint must answer with a 2xx status within **10 seconds**. Any other status, a redirect, a TLS error, or no answer within 10 seconds counts as a failed delivery. The response body is ignored.

Answer first and work later: verify the signature, store the event or enqueue a Harborline job for it, and return `200` straight away. An endpoint that does its real work inside the request sooner or later takes longer than 10 seconds and receives the same event again.

## Delivery retries

A failed delivery is retried with exponential backoff: up to **8 attempts over 24 hours**, with gaps that grow from about a minute to several hours. After the eighth failed attempt the event is marked failed. Failed events stay visible in the dashboard, under **Webhooks → Deliveries**, for **7 days**, with the status code and the first bytes of each response, and you can redeliver one from there by hand.

These delivery retries have nothing to do with job retries. They cannot be configured, they are not billed as executions, and they never change the job they are about. A job can be `succeeded` while the webhook that reports it is still being retried. See [Retries and backoff](/guides/retries#job-retries-and-webhook-retries).

## Handle events reliably

Build the handler for the way webhooks actually arrive:

- **More than once.** A delivery that timed out on your side may have been handled anyway, and Harborline sends it again. Every event has a unique `id` (`evt_…`) that stays the same across delivery attempts; store the ids you have handled and skip repeats.
- **Out of order.** Retries and parallel deliveries mean that a `job.succeeded` can arrive before the `job.failed` of an earlier attempt. Use each event's `created_at`, or fetch the job's current state, instead of assuming an order.
- **Signed.** Reject every request whose `Harbor-Signature` does not verify; anyone can send a `POST` to a public URL.
- **Late.** An event can arrive up to 24 hours after it happened if your endpoint was down. Check its `created_at` before you act on it.
