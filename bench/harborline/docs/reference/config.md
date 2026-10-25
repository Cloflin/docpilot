---
title: harbor.toml
description: Reference for the harbor.toml project file — project, queue defaults, per-queue settings, worker options, and how its values combine with flags and environment variables.
---

# harbor.toml

`harbor.toml` is the project file of the `harbor` CLI. `harbor init` writes one; commit it next to your code. It holds ids and settings, never keys or tokens. The CLI looks for it in the current directory and then in each parent directory, and uses the first one it finds. The SDKs do not read it.

## Example

```toml
[project]
id = "prj_01HZX8K2M4N6P8R0T2V4W6Y8Z0"
region = "eu-central-1"

[queue.defaults]
visibility_timeout = "60s"
max_attempts = 5
backoff = "exponential"

[queues.emails]
concurrency = 20
rate_limit = "100/m"

[worker]
heartbeat_interval = "20s"
shutdown_grace = "30s"
```

This file points the CLI at one project in `eu-central-1`, gives every queue a 60-second visibility timeout, 5 attempts and exponential backoff, lets the `emails` queue run 20 jobs at once and start at most 100 per minute, and sets the heartbeat interval and the shutdown grace of `harbor workers start`.

## The [project] table

| Key | Type | Description |
|---|---|---|
| `id` | string | The project id, `prj_…`. Same as `--project` and `HARBOR_PROJECT` |
| `region` | string | `us-east-1`, `eu-central-1` or `ap-southeast-2`. Same as `--region` and `HARBOR_REGION` |

Both keys are needed when the CLI runs with a login token, and `region` must be the project's own region. With `HARBOR_API_KEY` set, the key already names its project; `id` must then match it or the command stops with an error, which protects you from running a production key inside the wrong repository.

## Queue settings

`[queue.defaults]` applies to every queue, and `[queues.<name>]` applies to one queue and wins over the defaults. Both accept the same keys:

| Key | Default | Example |
|---|---|---|
| `concurrency` | `10` | `20` |
| `rate_limit` | none | `"100/m"` |
| `visibility_timeout` | `"60s"` | `"5m"`, between `5s` and `12h` |
| `max_attempts` | `5` | `8` |
| `backoff` | `"exponential"` | `"linear"` or `"fixed"` |
| `base_delay` | `"2s"` | `"5s"` |
| `max_delay` | `"15m"` | `"1h"` |
| `jitter` | `"full"` | `"none"` |
| `group_concurrency` | `1` | `3` |
| `dead_letter` | `true` | `false` |

These values take effect when you run `harbor queues create <name>`; editing the file alone changes nothing in Harborline. Run `harbor queues create` again after an edit to apply the new values to an existing queue.

## The [worker] table

| Key | Default | Description |
|---|---|---|
| `heartbeat_interval` | one third of the visibility timeout | How often `harbor workers start` extends the lease of a running command |
| `shutdown_grace` | `"30s"` | How long it waits for running commands after SIGTERM |
| `concurrency` | `1` | Commands run at once; the `--concurrency` flag wins |

The `[worker]` table is read only by `harbor workers start`. SDK workers take the same options in code: `heartbeatInterval` and `shutdownGrace` in Node.js, `heartbeat_interval` and `shutdown_grace` in Python. Keep `heartbeat_interval` at or below half the visibility timeout; with the default 60 seconds, the `"20s"` of the example is a safe value.

## Precedence

A setting can come from four places, and the first one found wins:

1. a command-line flag, such as `--region=ap-southeast-2`;
2. an environment variable, such as `HARBOR_REGION`;
3. `harbor.toml`;
4. the defaults of the active profile, stored by `harbor login`.

For example, with `region = "eu-central-1"` in `harbor.toml` and `HARBOR_REGION=us-east-1` in the shell, the CLI uses `us-east-1`: the variable beats the file. Adding `--region=ap-southeast-2` to the command beats both. Queue settings have no environment variables; they come from flags, then from the file, then from Harborline's defaults.

## Durations and formats

Durations are strings with a unit — `ms`, `s`, `m`, `h` or `d` — such as `"500ms"`, `"60s"`, `"15m"` or `"12h"`. Bare numbers are rejected, so `visibility_timeout = 60` is an error; write `"60s"`. Rate limits are written `"<limit>/<period>"`, with `s`, `m` or `h` as the period: `"10/s"`, `"100/m"`, `"5000/h"`.

Queue names in table headers follow the queue naming rules; quote a name that contains a dot, as in `[queues."billing.v2"]`. Unknown keys are reported as errors, so a typo such as `max_attempt` does not go unnoticed.
