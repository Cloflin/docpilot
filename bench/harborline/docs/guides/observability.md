---
title: Observability
description: Monitor queues and jobs with Prometheus metrics, job logs, trace propagation and the dashboard — queue depth, latency, failures and dead jobs.
---

# Observability

Harborline shows what is happening in your queues in four ways: Prometheus metrics for dashboards and alerts, job logs for debugging, W3C trace context for following a job from the request that created it to the worker that ran it, and the dashboard for a quick look.

## Prometheus metrics

`GET /v3/metrics` returns every metric of the project in the Prometheus text exposition format. It needs an API key with the `metrics:read` scope; create a separate key with only that scope for your monitoring system.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: harborline
    scheme: https
    metrics_path: /v3/metrics
    scrape_interval: 30s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/harbor-metrics-key
    static_configs:
      - targets: ['api.eu-central-1.harborline.dev']
```

Each scrape is one API request against the project's rate limit. Scraping every 30 seconds is plenty, because the values are refreshed every 15 seconds.

## Metric series

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `harbor_queue_depth` | gauge | `queue`, `state` | Jobs in the queue by state: `scheduled`, `queued`, `reserved`, `failed` |
| `harbor_job_latency_seconds` | histogram | `queue` | Time from enqueue to start: from the moment a job is `queued` until a worker reserves it |
| `harbor_job_duration_seconds` | histogram | `queue`, `outcome` | Time from reserve to acknowledgement or failure |
| `harbor_job_attempts_total` | counter | `queue`, `outcome` | Finished attempts by outcome: `succeeded`, `failed`, `expired` |
| `harbor_dead_jobs_total` | counter | `queue` | Jobs that became `dead` |

Dead-letter queues appear in `harbor_queue_depth` under their own names, such as `emails.dead`. Latency starts when a job becomes `queued`, so the latency of a delayed job starts at its run time, not at the moment it was enqueued.

## Alerts worth setting

```text
# Jobs are dying
increase(harbor_dead_jobs_total[15m]) > 0

# Workers are falling behind
histogram_quantile(0.95, sum by (le, queue) (rate(harbor_job_latency_seconds_bucket[5m]))) > 60

# A backlog is building up
harbor_queue_depth{state="queued"} > 10000
```

Alert on latency rather than on depth alone: a deep queue that is worked off quickly is fine, while a short queue whose jobs wait for minutes is not. Watch `harbor_job_attempts_total{outcome="expired"}` too — expired leases mean that handlers run longer than their visibility timeout without sending heartbeats.

## Job logs

Harborline keeps a log for every job: a line for each state change — enqueued, reserved, succeeded, failed with its error message, dead, canceled — plus the lines your handler writes with `job.log()` and the output of CLI workers. Stream the logs with the CLI:

```bash
harbor logs tail --queue=emails --level=warn
```

`--queue` limits the stream to one queue, and `--level` to lines at or above `debug`, `info`, `warn` or `error`. Without flags the command streams every queue of the project at `info` and above.

How long logs are kept depends on the plan: 3 days on Free, 14 days on Team, 30 days on Scale. The `HARBOR_LOG_LEVEL` environment variable is unrelated: it sets how much the CLI and the SDKs print about their own requests, not which job logs you see. For a worked example, see [Read a failed job's log](/help/troubleshooting#read-a-failed-jobs-log).

## Trace propagation

Harborline passes W3C trace context through a job. If the job's headers contain a `traceparent` (and, optionally, a `tracestate`) at enqueue, the worker receives them unchanged in `job.headers`, so the span that runs the job can be a child of the span that enqueued it. The SDKs do not create spans themselves; inject and extract the context with OpenTelemetry:

```ts
import { context, propagation, trace } from '@opentelemetry/api'

// producer
const headers: Record<string, string> = {}
propagation.inject(context.active(), headers)
await harbor.queue('emails').enqueue(payload, { headers })

// worker
harbor.worker('emails', async (job) => {
  const parent = propagation.extract(context.active(), job.headers)
  await trace.getTracer('worker').startActiveSpan('send-email', {}, parent, async (span) => {
    try { await send(job.payload) } finally { span.end() }
  })
})
```

Headers count toward the 4 KB metadata limit; a `traceparent` takes 55 bytes.

## The dashboard

The dashboard shows each queue's depth, throughput and latency, and lists the **last 1,000 jobs** of each queue with their state, attempts and last error. You can filter that list by state and search it by payload content. Payloads encrypted with [client-side encryption](/guides/encryption) cannot be searched.

For jobs beyond the last 1,000, use the API or `harbor jobs list --queue=<name> --state=<state>`, which pages through everything within your plan's history window: succeeded jobs are kept for 1 day on Free, 7 days on Team and 30 days on Scale.
