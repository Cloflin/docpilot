---
title: Environment variables
description: The HARBOR_* environment variables read by the harbor CLI and the Node.js and Python SDKs — API key, project, region, endpoint, profile and log level.
---

# Environment variables

The `harbor` CLI and both SDKs read their configuration from `HARBOR_*` environment variables when it is not given in code or on the command line. This is the usual way to configure them in containers and CI.

## Variables

| Variable | Read by | Description |
|---|---|---|
| `HARBOR_API_KEY` | CLI, SDKs | The API key, `hl_live_…` or `hl_test_…`. The CLI uses it instead of its login token |
| `HARBOR_PROJECT` | CLI | The project id, `prj_…`, for commands run with a login token |
| `HARBOR_REGION` | CLI, SDKs | `us-east-1` (the default), `eu-central-1` or `ap-southeast-2` |
| `HARBOR_ENDPOINT` | CLI, SDKs | A full API base URL; wins over `HARBOR_REGION` |
| `HARBOR_PROFILE` | CLI | The login profile to use; default `default` |
| `HARBOR_LOG_LEVEL` | CLI, SDKs | `debug`, `info`, `warn` or `error`; default `info` |

The SDKs need no project id, because an API key belongs to exactly one project. A variable that is set but empty counts as unset.

## Precedence

For the CLI, a flag wins over its environment variable, the variable wins over `harbor.toml`, and the file wins over the profile's defaults:

```text
flag  >  environment variable  >  harbor.toml  >  profile defaults
```

For the SDKs, an option passed in code wins over the environment variable:

```ts
// HARBOR_REGION=us-east-1 is set, but this client talks to Frankfurt
const harbor = new Harbor({ region: 'eu-central-1' })
```

The SDKs never read `harbor.toml` or the CLI's profiles: code options and environment variables are all they use. See [harbor.toml](/reference/config#precedence) for a worked example with the CLI.

## HARBOR_ENDPOINT

`HARBOR_ENDPOINT` replaces the URL that the SDKs and the CLI would build from the region. Give the full base URL, including `/v3`:

```bash
export HARBOR_ENDPOINT=https://api.eu-central-1.harborline.dev/v3
```

Use it to send traffic through an HTTP proxy or an API gateway of your own, or to point tests at a local mock server. When both are set, `HARBOR_ENDPOINT` wins and `HARBOR_REGION` is ignored. The key must still belong to a project in the region that finally receives the request, or the request fails with `HL4001 unauthorized`.

## HARBOR_LOG_LEVEL

`HARBOR_LOG_LEVEL` controls how much the CLI and the SDKs write to standard error about their own work — requests, request retries, worker start and shutdown:

| Level | Prints |
|---|---|
| `debug` | Every HTTP request with its response status, heartbeats and leases |
| `info` | Worker start and shutdown, and the project and region in use (the default) |
| `warn` | Retried requests, waits after rate limiting, and leases that expired |
| `error` | Only failed requests and crashes of the SDK itself |

It does not change which job logs you see in `harbor logs tail`; that command has its own `--level` flag. Do not run production workers at `debug`: with many jobs it is very verbose.

## In CI and containers

Store the key as a secret of your CI system or orchestrator, never in `harbor.toml` or in an image:

```bash
# set by the CI system or the orchestrator, for example from a secret store
HARBOR_API_KEY=hl_live_xxx
HARBOR_REGION=eu-central-1
```

Give each environment its own key with only the scopes it needs, and use `hl_test_` keys for test suites so that they run against the sandbox. `harbor login` cannot run in CI; the CLI picks up `HARBOR_API_KEY` instead, and then acts on the project of that key.

## Variables set for CLI workers

`harbor workers start` sets three variables in the environment of the command it runs for each job. They are outputs, not configuration:

| Variable | Value |
|---|---|
| `HARBOR_JOB_ID` | The job id, `job_…` |
| `HARBOR_JOB_ATTEMPT` | The number of the attempt, starting at 1 |
| `HARBOR_QUEUE` | The queue name |

The command also inherits the environment of the CLI, including `HARBOR_API_KEY`. Run CLI workers with a key that has only the `jobs:read` and `jobs:write` scopes, so that the commands they start cannot change queues or schedules.
