---
title: Install the CLI
description: Install the harbor command-line tool with npm or Homebrew, log in, and point it at the right project, region and profile.
---

# Install the CLI

The `harbor` CLI manages queues, jobs, schedules, keys and dead-letter queues from your terminal, runs shell commands as workers, and streams job logs. It talks to the same REST API as the SDKs.

## Install with npm or Homebrew

Install the CLI with npm (Node.js 18 or later):

```bash
npm i -g @harborline/cli
```

or with Homebrew on macOS and Linux:

```bash
brew install harborline/tap/harbor
```

Both install a binary named `harbor`. Check that it is on your `PATH`:

```bash
harbor --version
# harbor 3.4.0
```

The CLI shares the platform's version number. Update it the way you installed it: `npm i -g @harborline/cli@latest` or `brew upgrade harbor`. If your shell cannot find `harbor` after an npm install, the npm global `bin` directory is not on your `PATH`; `npm prefix -g` prints where it is.

## Log in

```bash
harbor login
```

`harbor login` uses a browser device flow. It prints a URL and a short code, opens the URL in your browser, and waits. Sign in to the dashboard, check that the code matches, and approve. The CLI then stores a token in `~/.config/harbor/credentials`, readable only by your user account.

The login token acts as you. It reaches every project in every workspace you belong to, which is why most commands need to know which project you mean (see below). `harbor logout` deletes the stored token.

## Use the CLI in CI and scripts

A CI runner has no browser, so it cannot complete `harbor login`. Set an API key instead:

```bash
export HARBOR_API_KEY=hl_live_xxx
harbor queues list
```

When `HARBOR_API_KEY` is set, the CLI uses the key instead of the login token. Commands then act on the key's project and are limited to the key's scopes. Two command groups need a user login and do not work with an API key: `harbor keys`, because keys can only be managed by a person, and `harbor migrate`, because it reads one project and writes another.

Give the key only what the job needs — for example `queues:admin` for a deploy step that creates queues. See [API keys and scopes](/account/api-keys).

## Choose the project and region

With a login token, tell the CLI which project to use. It looks in these places, in order of precedence:

1. The `--project` and `--region` flags on the command.
2. The `HARBOR_PROJECT` and `HARBOR_REGION` environment variables.
3. The `[project]` table of a `harbor.toml` file.
4. The defaults stored in the active profile.

The first value found wins. The region must be the project's own region: the API of each region lives at `https://api.<region>.harborline.dev/v3`. See [Environment variables](/reference/environment) and [harbor.toml](/reference/config).

## Profiles

A profile is a named login with its own defaults. Use one per workspace or per environment:

```bash
harbor login --profile=staging
harbor queues list --profile=staging
export HARBOR_PROFILE=staging   # make it the default for this shell
```

Each profile stores its own token, default project and default region in `~/.config/harbor/credentials`. Without `--profile` or `HARBOR_PROFILE`, the CLI uses the profile named `default`. `harbor logout --profile=staging` removes one profile and keeps the others.

## Initialise a repository

Run `harbor init` in the root of an application repository:

```bash
harbor init
```

It asks for the project and the region and writes a `harbor.toml` with a `[project]` table and the default queue settings. Commit the file: it holds ids and settings, never keys or tokens. From then on, every `harbor` command run inside the repository uses that project without `--project`, and `harbor queues create` takes the queue settings from the file. [harbor.toml](/reference/config) documents every key the file can hold.
