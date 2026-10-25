---
title: CLI reference
description: Every harbor command and flag — queues, jobs, dead-letter queues, schedules, workers, keys, logs and migrate — with global flags and exit codes.
---

# CLI reference

`harbor` is the Harborline command-line tool. Install it with `npm i -g @harborline/cli` or `brew install harborline/tap/harbor`; see [Install the CLI](/getting-started/install-cli). Every command accepts `--help`.

## Global flags

| Flag | Description |
|---|---|
| `--project=<id>` | The project to act on (`prj_…`). Environment variable: `HARBOR_PROJECT` |
| `--region=<region>` | The project's region. Environment variable: `HARBOR_REGION` |
| `--profile=<name>` | The login profile to use. Environment variable: `HARBOR_PROFILE` |
| `--output=table\|json` | Output format: `table` is the default, `json` is for scripts |
| `--yes` | Answer yes to every confirmation prompt, for example before a purge |

A flag wins over its environment variable, which wins over `harbor.toml`, which wins over the profile's defaults. With `HARBOR_API_KEY` set, the CLI uses that key instead of the login token and acts on the key's project.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error: the API refused the request, or something else failed |
| `2` | Usage error: an unknown command, a missing argument or an invalid flag |
| `3` | Not found: the queue, job, schedule or key does not exist |
| `4` | Rate limited: the API answered `HL2001`; try again later |

Scripts can branch on them:

```bash
harbor jobs get "$JOB_ID" --output=json > job.json
case $? in
  0) jq -r .state job.json ;;
  3) echo "no such job" ;;
  4) sleep 5 && exec "$0" "$@" ;;
  *) exit 1 ;;
esac
```

## Login and setup commands

| Command | Description |
|---|---|
| `harbor login [--profile=<name>]` | Log in with a browser device flow; stores a token in `~/.config/harbor/credentials` |
| `harbor logout [--profile=<name>]` | Delete the stored token |
| `harbor init` | Write a `harbor.toml` for the current directory |
| `harbor --version` | Print the CLI version |

`harbor keys` and `harbor migrate` need a login. Every other command also works with an API key in `HARBOR_API_KEY`, which is how CI pipelines use the CLI.

## Queue commands

| Command | Description |
|---|---|
| `harbor queues create <name> [settings]` | Create a queue, or update the settings of an existing one |
| `harbor queues list` | List queues with their depth and state |
| `harbor queues get <name>` | Show a queue's settings and counts |
| `harbor queues pause <name>` | Workers receive no jobs; enqueue still works |
| `harbor queues resume <name>` | Undo a pause or a drain |
| `harbor queues drain <name>` | Refuse new jobs with `HL1005`, hand out the rest |
| `harbor queues purge <name>` | Delete all `queued` and `scheduled` jobs; asks first unless `--yes` |
| `harbor queues delete <name>` | Delete the queue, its jobs and its dead-letter queue |

The settings flags of `create` are `--concurrency=<n>`, `--rate-limit=<limit>/<period>`, `--visibility-timeout=<duration>`, `--max-attempts=<n>`, `--backoff=<strategy>`, `--base-delay=<duration>`, `--max-delay=<duration>`, `--jitter=<full or none>`, `--group-concurrency=<n>` and `--dead-letter=<true or false>`. Settings you do not pass come from `harbor.toml` — `[queues.<name>]`, then `[queue.defaults]` — and then from Harborline's defaults.

## Job commands

| Command | Description |
|---|---|
| `harbor jobs enqueue <queue> --payload=<json>` | Enqueue a job; `--payload-file=<path>` reads the payload from a file |
| `harbor jobs get <job-id>` | Show a job: state, attempts, last error and payload |
| `harbor jobs list --queue=<name> [--state=<state>] [--limit=<n>]` | List jobs, newest first |
| `harbor jobs cancel <job-id>` | Cancel a `scheduled`, `queued` or `failed` job |
| `harbor jobs retry <job-id>` | Run a `failed` or `dead` job again now |

`enqueue` also takes `--delay=<duration>`, `--run-at=<timestamp>`, `--idempotency-key=<key>`, `--max-attempts=<n>` and `--group-key=<key>`, and prints the id of the new job:

```bash
harbor jobs enqueue emails --payload='{"to":"ada@example.com"}' --delay=10m --idempotency-key=welcome-42
# job_01JBQ8Z6X4M2N7P3R5T9V1W0YA
```

## Dead-letter commands

| Command | Description |
|---|---|
| `harbor dlq list <queue>` | List the dead jobs of a queue, newest first |
| `harbor dlq replay <queue> [--since=<duration>] [--limit=<n>]` | Replay dead jobs into the queue |
| `harbor dlq purge <queue>` | Delete every dead job of the queue; asks first unless `--yes` |

`--since` replays only jobs that died within that duration, and `--limit` caps how many one run replays:

```bash
harbor dlq replay emails --since=24h --limit=500
# replayed 312 jobs from emails.dead to emails
```

How a replay treats each job, and how long dead jobs are kept, is explained in [Dead-letter queue](/guides/dead-letter).

## Schedule commands

| Command | Description |
|---|---|
| `harbor schedules create <name> --queue=<queue> --cron=<expression>` | Create a schedule |
| `harbor schedules list` | List schedules with their next run time |
| `harbor schedules pause <name-or-id>` | Pause a schedule; runs while it is paused are skipped |
| `harbor schedules resume <name-or-id>` | Resume a schedule |
| `harbor schedules delete <name-or-id>` | Delete a schedule |

`create` also takes `--timezone=<iana-name>` (default `UTC`), `--payload=<json>` and `--overlap=<allow or skip>` (default `allow`). Quote the cron expression so that the shell does not expand its asterisks: `--cron="*/15 * * * *"`.

## Worker command

```bash
harbor workers start --queue=<name> [--concurrency=<n>] -- <command> [args...]
```

Runs `<command>` once per job, with the job's payload as JSON on standard input. Exit code `0` acknowledges the job; any other exit code fails the attempt. `--concurrency` (default 1) sets how many commands run at once. The command's environment holds `HARBOR_JOB_ID`, `HARBOR_JOB_ATTEMPT` and `HARBOR_QUEUE`, and its standard output and standard error go to the job's log. The CLI sends heartbeats while the command runs and, on SIGTERM, stops reserving and waits for running commands as set in the `[worker]` table of [harbor.toml](/reference/config#the-worker-table). See [Write a worker](/guides/workers#run-a-worker-from-the-cli).

## Key commands

| Command | Description |
|---|---|
| `harbor keys create --name=<name> [--scopes=<list>] [--test]` | Create a key and print it once |
| `harbor keys list` | List keys with their scopes and last use; never prints a key |
| `harbor keys rotate <key-id>` | Create a replacement key; the old key keeps working for 24 hours |
| `harbor keys revoke <key-id>` | Revoke a key immediately |

`--scopes` is a comma-separated list such as `jobs:read,jobs:write`; without it the key has every scope. `--test` creates an `hl_test_` key for the sandbox. Key commands need a login (`harbor login`); they do not work with an API key.

## Logs and migration

| Command | Description |
|---|---|
| `harbor logs tail [--queue=<name>] [--level=<level>]` | Stream job logs live; `--level` is `debug`, `info`, `warn` or `error` |
| `harbor migrate --to-project=<id>` | Copy pending jobs and schedules to another project |

`logs tail` runs until you press Ctrl+C. `migrate` uses the project from `--project`, or from your configuration, as the source. It needs a login, and it does not move succeeded-job history. See [Regions and migration](/guides/regions#use-harbor-migrate).
