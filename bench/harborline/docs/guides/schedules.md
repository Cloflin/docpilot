---
title: Schedules
description: Run recurring jobs on a cron expression in your time zone — syntax, daylight saving time, overlapping runs, missed runs and plan limits.
---

# Schedules

A schedule creates a job on a cron expression: every night at 02:00, every Monday at 09:00, every five minutes. At each matching time Harborline enqueues an ordinary job with the schedule's payload into the schedule's queue, and your workers run it like any other job — with retries, backoff and a dead-letter queue.

## Create a schedule

With the CLI:

```bash
harbor schedules create nightly-report \
  --queue=reports \
  --cron="0 2 * * *" \
  --timezone=Europe/Berlin \
  --payload='{"kind":"daily"}'
```

With the Node.js SDK:

```ts
const schedule = await harbor.schedules.create({
  name: 'nightly-report',
  queue: 'reports',
  cron: '0 2 * * *',
  timezone: 'Europe/Berlin',
  payload: { kind: 'daily' },
})
console.log(schedule.id, schedule.nextRunAt) // sch_01JB7W3Y5A7C9E1G3J5K7M9N1P 2026-10-26T01:00:00Z
```

Over HTTP it is `POST /v3/schedules` with the same fields in snake_case, sent with a key that has the `schedules:write` scope. Schedule names are unique within a project. The queue must already exist; a schedule does not create it.

## Cron syntax

Expressions have the standard five fields. There is no seconds field.

```text
┌───────────── minute        0–59
│ ┌─────────── hour          0–23
│ │ ┌───────── day of month  1–31
│ │ │ ┌─────── month         1–12
│ │ │ │ ┌───── day of week   0–6 (Sunday = 0)
│ │ │ │ │
* * * * *
```

Each field takes `*`, a number, a list (`1,15`), a range (`1-5`) or a step (`*/15`). Four macros stand for common expressions: `@hourly` (`0 * * * *`), `@daily` (`0 0 * * *`), `@weekly` (`0 0 * * 0`) and `@monthly` (`0 0 1 * *`).

The shortest interval is **1 minute** on every plan, which is what `* * * * *` gives you. For work that must happen more often than once a minute, run a long-lived worker instead of a schedule.

## Time zones and daylight saving time

A schedule's `timezone` is an IANA time zone name such as `Europe/Berlin` or `America/New_York`; the default is `UTC`. The cron expression is read in that zone's local time, so `0 9 * * 1` with `timezone: America/New_York` runs at 09:00 New York time all year, whether that is 13:00 or 14:00 UTC.

Daylight saving time creates two edge cases, and Harborline handles them like this:

- A local time that does not exist — inside the hour skipped when clocks go forward — is skipped. A schedule for `30 2 * * *` in `Europe/Berlin` does not run on the last Sunday of March.
- A local time that happens twice — inside the hour repeated when clocks go back — fires once, at its first occurrence.

If a job must run every day without exception, schedule it outside the hours in which your time zone changes its clocks, or use `UTC`.

## Overlapping runs

By default a schedule creates its job at every matching time, even when the job from the previous run has not finished yet: `overlap: allow`. For a job that takes longer than its interval, that means two or more of them running at once.

Set `overlap: skip` to skip a run while the previous job of the same schedule is still not finished — still `scheduled`, `queued`, `reserved`, or `failed` and waiting for a retry:

```bash
harbor schedules create sync-crm --queue=sync --cron="*/5 * * * *" --overlap=skip
```

A run skipped because of `overlap: skip` is expected behaviour, not a missed run, and it does not send a `schedule.missed` event. The schedule simply tries again at its next matching time.

## Missed runs

Harborline does not backfill missed runs. If a run time passes while Harborline cannot create the job — during a Harborline outage — or while the schedule is paused, that run is lost, and the schedule continues with its next matching time.

Since 3.4.0 Harborline tells you about it: when the schedule runs again, it sends one `schedule.missed` [webhook event](/reference/webhook-events#schedulemissed) that lists the run times that did not happen. Subscribe to it if a missed run needs a follow-up, and enqueue the work yourself from the webhook handler when you need it done.

```bash
harbor schedules pause nightly-report    # runs are skipped while it is paused
harbor schedules resume nightly-report
```

## Limits

The number of schedules per project depends on the plan:

| Plan | Schedules per project | Shortest interval |
|---|---|---|
| Free | 5 | 1 minute |
| Team | 100 | 1 minute |
| Scale | 1000 | 1 minute |

Creating a schedule beyond the limit fails with `HL2002 quota_exceeded`. Paused schedules count toward the limit, so delete the schedules you no longer need with `harbor schedules delete <name>`. Every job a schedule creates is an execution when it runs, like any other job; see [Plans and pricing](/account/plans).
