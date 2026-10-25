---
title: Plans and pricing
description: Compare the Free, Team and Scale plans — prices, monthly job executions, queues, history and log retention, API rate limits, SLA and support — and see how usage is billed.
---

# Plans and pricing

Harborline has three plans: Free, Team and Scale. A plan belongs to a workspace and covers all of its projects. This page compares the plans, explains what counts as an execution, and describes how billing works.

## Compare plans

| | Free | Team | Scale |
|---|---|---|---|
| Price | $0 | $49 / month | $499 / month |
| Job executions / month | 10,000 | 2,000,000 | 25,000,000 |
| Queues per project | 3 | 50 | unlimited |
| Schedules per project | 5 | 100 | 1000 |
| Succeeded-job history | 1 day | 7 days | 30 days |
| Logs retention | 3 days | 14 days | 30 days |
| API rate limit per project | 20 req/s | 200 req/s | 1000 req/s |
| Audit log | — | 90 days | 1 year |
| IP allowlist | — | — | yes |
| SSO for the dashboard | — | — | SAML |
| SLA | — | 99.9 % | 99.95 % |
| Support | community | email (1 business day) | dedicated, 1 h response for P1 |

Everything else is the same on every plan: all three regions, webhooks with up to 10 endpoints per project, schedules, client-side encryption and metrics. The execution allowance is counted per workspace; the other limits apply to each project.

## What counts as an execution

An execution is one attempt of one job. Every time a worker reserves a job and runs it, that is an execution, whether the attempt succeeds, fails or ends with an expired lease. A retry is a new attempt, so it counts again: a job that succeeds on its third attempt uses three executions, and a job that goes dead after 5 attempts uses five.

These do not count: enqueueing a job; jobs that are canceled or purged before they run; API requests such as reads; webhook deliveries; and jobs in the sandbox, reached with `hl_test_` keys.

To keep executions down, make permanent failures permanent. Throw `PermanentError` for errors that a retry cannot fix, so that the job goes to the dead-letter queue after one attempt instead of five. See [Retries and backoff](/guides/retries).

## API rate limits and bursts

Each project can make a number of API requests per second set by its plan: 20 on Free, 200 on Team, 1,000 on Scale. For short peaks a project can burst to twice its limit — 40, 400 or 2,000 requests per second — for up to 10 seconds.

A request over the limit gets HTTP 429 with `HL2001 rate_limited` and a `Retry-After` header that holds the number of seconds to wait. The SDKs wait and retry on their own.

Reserve calls with a long-poll `wait`, batch enqueues of up to 500 jobs and batch reserves of up to 50 jobs keep request counts low. The rate limit counts requests, not jobs. A queue's own `rateLimit` setting, which limits job starts, is a different thing; see [Concurrency and rate limits](/guides/concurrency).

## Change plans

Upgrade at any time in **Workspace settings → Billing**. An upgrade takes effect immediately, and you pay the difference for the rest of the billing month. A downgrade takes effect at the end of the current billing month.

Before a downgrade, bring the workspace within the smaller plan's limits — for example, delete the queues above the plan's queue count — or the downgrade is refused with a list of what to change. History and logs older than the new plan's retention are deleted when the downgrade takes effect, so export what you need first.

## Billing details

Harborline bills each workspace monthly, in US dollars, by card, or on Scale by invoice if you prefer. The plan price is charged at the start of each billing month, and usage above the allowance at its end.

Overage is what happens when a month's executions go above the allowance of the plan:

- **Free** has no overage. When the allowance is used up, Harborline stops: enqueue requests fail with `HL2002 quota_exceeded` (HTTP 402), and queued jobs wait until the next billing month starts or you upgrade.
- **Team** charges $0.40 per 10,000 executions above the allowance.
- **Scale** charges $0.25 per 10,000 executions above the allowance.

Overage is billed in blocks of 10,000 executions; a partial block is billed as a whole one. The dashboard shows the month's executions so far under **Workspace settings → Usage**, and Harborline emails the workspace owners when usage reaches 80 % and 100 % of the allowance.
