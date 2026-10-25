---
title: Choose your install
description: Static or server — where a DocPilot turn runs, what each install makes public, what each one needs from you, and how to change your mind later.
---

# Choose your install

**Use the static install if your pages are public. Use the server install if the corpus, the prompt or the thresholds must stay on your side, or if you need rate limits and metrics.** The reader sees the same chat in both. Only the place where the turn runs changes.

A turn is everything between the question and the answer: embedding the question, searching the index, scoring the gate, running the tool loop, building the prompt and calling the model.

```
static   runtime: 'browser'                 server   runtime: 'server'
──────────────────────────────────          ──────────────────────────────────
reader's browser                            reader's browser
  downloads the index                         sends the question
  searches, gates, builds the prompt          draws the stream
  calls /ai/v1/*  ──┐                              │
                    ▼                              ▼
your server: attaches the key               your server: @cloflin/docpilot/server
  forwards to the provider                    index, gate, loop, prompt, keys,
                                              limits, metrics, turn log
```

## Side by side

| | static (`runtime: 'browser'`, the default) | server (`runtime: 'server'`) |
|---|---|---|
| where the turn runs | the reader's browser | `@cloflin/docpilot/server` on your server |
| what the page gets | the index (shards, vectors, df), the prompt, the thresholds | a shell manifest (pages, sections) and the SSE stream |
| model key | behind the `/ai` proxy | on the server only |
| process you run | none: the proxy that already serves the site forwards model calls | one: `npx docpilot serve` or `createDocPilotServer` |
| set up | `npx docpilot index` and the proxy | `npx docpilot serve --dir=<site>` or `createDocPilotServer` |
| rate limits | yours, in the proxy | built in and on by default — see [Server operations](/guide/server-operations#limits) |
| metrics | none | `GET {endpoint}/metrics`, and [`docpilot monitor`](/reference/cli#monitor) |
| turn log | none | optional, one record per turn |
| follow-up chips | yes | no — they read the corpus, and the browser does not have it |

The measured comparison between the two installs is on the [benchmark page](/guide/benchmarks). What changed for a site owner in 2.0 is on [Migrate to 2.0](/guide/migrate-2).

## What each install makes public {#public}

**Static.** Everything the browser needs to run a turn is downloadable by anyone who opens the site:

- the index in `/rag/*`: your page text, the vectors, the manifest;
- the instruction the model runs under, including `prompt.override` and `prompt.extend`;
- the gate thresholds and the retrieval levers;
- the routes `/ai/v1/embeddings` and `/ai/v1/chat/completions`. They are public on purpose; the proxy bounds what a call can cost. Your key is not in any of them. [Security](/guide/security) lists the exact rules.

**Server.** The page receives a small part of that:

- the page list and the sections, for the scope picker;
- the text of the chunks an answer cites, so a source row can show its passage;
- the stream of the answer.

These stay on your server: the instruction, the thresholds and levers, every API key, the vectors and the corpus, and the turn log.

Two limits of the server install:

- **Answers quote your pages.** A reader can still read any passage that an answer cites. The server install keeps the index from being downloaded in bulk. It does not make the content secret.
- **The index must not be published.** A site built from `public/` copies `public/rag/` into its output. `serve --dir` refuses to serve a directory that holds an index manifest. Behind your own static server, exclude the index there. See [The server runtime](/guide/server#setting-it-up).

## Who each install is for

**Static fits** a documentation site, a landing page or a help centre whose pages are already public, where you want nothing extra to run and keep. The cost is that the prompt and the thresholds are visible to a reader who looks.

**Server fits** one or more of these:

- a corpus you do not want to ship as files;
- a prompt, a canary or an internal reference that must not reach the browser — the [leak guard](/guide/server-operations#leak-guard) also stops it leaving in an answer;
- per-client limits, a daily cap and a deadline per turn without a proxy rule;
- metrics you can scrape, and a turn log that feeds [`traffic`](/guide/improving#traffic) and [`dataset`](/guide/fine-tuning#datasets).

The server install adds a process to run, monitor and restart. Limits and caches live in the memory of that process.

## What changes for the reader

Nothing in how the chat works. Two differences, both on the server install:

- there are no follow-up chips;
- the first question waits for your server instead of the index download.

A pasted key and a greeting are still caught in the browser, before anything is sent.

## Start with one

1. Run `npx docpilot init`. It asks which install and prints the block to paste. For the server install it also prints how to run the server and the two secrets to set. The flag is [`--runtime=browser|server`](/reference/cli#init).
2. Follow the guide for your install: the [quick start](/guide/) for static, [The server runtime](/guide/server) for server.
3. Build the index with `npx docpilot index`. Both installs use the same command and the same index.

## Change later

Both installs read the same index, built by the same command, so the choice is one setting:

```js
export const docPilot = {
  runtime: 'server', // or 'browser'
  server: { endpoint: '/ai/turn' },
}
```

To compare them on your own corpus before you switch, score the same golden set through each:

```bash
npx docpilot eval --runtime=browser --quiet
npx docpilot eval --runtime=server --quiet
```

Moving to the server install also means: stop publishing the index, run the server behind the proxy that serves your site, and set `DOCPILOT_SERVER_SECRET` and `DOCPILOT_METRICS_TOKEN`. Moving back means the index must be published again, and the `/ai/v1/*` proxy must be in place. [Production](/guide/production) has the proxy rules.
