---
title: Regions and migration
description: Choose where a project's jobs are stored and processed — us-east-1, eu-central-1 or ap-southeast-2 — and move a project to another region with harbor migrate.
---

# Regions and migration

Every Harborline project runs in one region. The region decides where the project's jobs, payloads, logs and history are stored, and where its API lives. This page lists the regions, shows how to point your code at the right one, and explains how to move to another region, since a project's region cannot be changed.

## Available regions

| Region | Location | API endpoint | Available since |
|---|---|---|---|
| `us-east-1` | United States (Virginia) | `https://api.us-east-1.harborline.dev/v3` | 3.0.0 |
| `eu-central-1` | Germany (Frankfurt) | `https://api.eu-central-1.harborline.dev/v3` | 3.3.0 |
| `ap-southeast-2` | Australia (Sydney) | `https://api.ap-southeast-2.harborline.dev/v3` | 3.0.0 |

`us-east-1` is the default: a project created without choosing a region, and an SDK client created without a `region` option, use it. Every region offers the same features on every plan. The dashboard at `https://app.harborline.dev` is the same for all regions and shows projects from all of them.

## A project's region is fixed

You choose the region when you create a project, and it cannot be changed afterwards — not in the dashboard, not by the API, not by support. Everything the project holds stays in that region: queued jobs and their payloads, history, logs, schedules and dead-letter queues.

Choose the region closest to the servers that run your producers and workers, because each enqueue and each reserve is a round trip to it. If your job data has to stay in the EU, create the project in `eu-central-1`.

## Point your code at the region

The SDKs and the CLI build the endpoint from the region name. Set it in one of these ways:

```ts
const harbor = new Harbor({ apiKey: process.env.HARBOR_API_KEY, region: 'eu-central-1' })
```

```python
harbor = Harbor(api_key=os.environ["HARBOR_API_KEY"], region="eu-central-1")
```

```bash
export HARBOR_REGION=eu-central-1                                   # SDKs and CLI
export HARBOR_ENDPOINT=https://api.eu-central-1.harborline.dev/v3   # full URL, wins over the region
```

An API key works only at the endpoint of its own project's region. Calling another region with it is answered with `HL4001 unauthorized` (HTTP 401), exactly as if the key did not exist. It is the most common cause of a 401 right after creating a project outside `us-east-1`.

## Move a project to another region

Because the region is fixed, moving means creating a new project in the target region and moving the work into it. There are two ways to do that.

**Drain and switch** is the simplest, when the jobs already in flight can finish where they are:

1. Create the new project in the target region, with the same queues.
2. Point producers at the new project, so new jobs go there.
3. [Drain](/guides/queue-control#drain-a-queue) every queue of the old project, and keep its workers running until each queue sends `queue.drained`.
4. Point the workers at the new project and delete the old one.

**Migrate** is the way when the old project holds work that must not run there, for example months of delayed jobs or a large backlog. Use `harbor migrate`, described below.

## Use harbor migrate

`harbor migrate` copies the pending work of one project into another:

```bash
harbor login
harbor migrate --project=prj_01HZX8K2M4N6P8R0T2V4W6Y8Z0 --to-project=prj_01J9T4B6D8F0H2K4M6P8R0S2V4
```

It exports every pending job — `queued`, `scheduled`, and `failed` jobs waiting for a retry — and every schedule. It creates any missing queues in the target project with the source queue's settings, and enqueues the jobs there with their payloads, headers, run times and attempt counts. It then cancels the copied jobs in the source project and pauses the copied schedules, so that nothing runs twice.

It does **not** move succeeded-job history, logs, dead-letter queues, API keys or webhook endpoints. History stays readable in the old project until its retention ends or you delete the project. Create keys and webhook endpoints in the new project yourself.

Run it with the producers already pointed at the new project and the old queues paused. `harbor migrate` needs a user login (`harbor login`), not an API key, because it reads one project and writes another.
