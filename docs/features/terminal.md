---
title: The terminal
description: The DocPilot command line shows the numbers — a home screen with a menu of next steps, docpilot status for the state of a project, docpilot monitor for a live server, progress bars, an eval scorecard, and colour rules that never break a log.
---

# The terminal

Run `npx docpilot` in a terminal and it shows where your project stands and what to do next. Three parts make that up: the **home screen**, `docpilot status` and `docpilot monitor`. The progress bars and the eval scorecard that the other commands draw follow the same rules.

This page is about what you see and when. Every flag is in the [CLI reference](/reference/cli).

**Availability.** The home screen, `status`, the progress bars and the scorecard work with both installs. `monitor` reads a running server, so it needs the [server install](/install/choose). All of it is new in 2.0, and none of it changes what a reader sees.

## The home screen {#home-screen}

```bash
npx docpilot
```

On a terminal it prints the picture of the project that `status` prints, then a menu of the commands that make sense now. The first entry is the project's next step, so Enter runs it.

| key | does |
|---|---|
| ↑ and ↓, or `k` and `j` | Move |
| a digit | Pick that entry |
| Enter | Run the selected command |
| Esc or `q` | Back out |
| Ctrl-C or Ctrl-D | Exit with code `130` |

Each entry runs the real command in your terminal, with its own questions and its own exit code.

**The menu appears only when stdin and stdout are both a terminal and `CI` is not set.** Anything else — a pipe, a CI job, `--help` — prints the help exactly as 1.x did. A script that ran `npx docpilot` before still gets the same text. See [the home screen](/reference/cli#home-screen).

## docpilot status {#status}

```bash
npx docpilot status
npx docpilot status --json
```

`status` is one picture of the project and the one command to run next. It reads files on disk and talks to no network unless you pass `--url` or the project runs `runtime: 'server'`.

| block | tells you |
|---|---|
| project | The runtime, the config path, where the docs, the index and the eval sets live |
| index | Fresh or stale, the hash, chunks and pages, the embedder, and the size on disk and over brotli |
| guard | `guard.mode`, the thresholds the index ships and where they came from |
| eval sets | Counts of golden records by `expect`, `split` and `level`, and of the other sets |
| last eval | The newest report as a scorecard: each metric, its move since the last comparable run, and a sparkline |
| server | Whether the server answers, the round trip, the index it serves and its metrics |
| next | The command to run, and why |

**Fresh means the hash the build would write.** `status` chunks the docs again, offline, and compares the hash with the manifest's. A site with imported pages, OpenAPI specs or a built-HTML source is reported *unverified*, not stale, because `status` cannot re-read those sources.

**It always exits `0` when it ran.** A stale index is a finding, not a failure. [`doctor`](/reference/cli#doctor) is the command a CI job exits on.

`--json` prints one object, `{"kind": "docpilot.status", "v": 1, …}`, and nothing else. `next.rule` names the rule that chose the next step, so a script or an agent branches on a name and not on a sentence. The rules, and the keys of the object, are in the [`status` reference](/reference/cli#status).

## docpilot monitor {#monitor}

```bash
npx docpilot monitor --url=https://docs.example.com/ai/turn --token=$DOCPILOT_METRICS_TOKEN
```

`monitor` polls a running server's `GET {endpoint}/metrics?format=json` and redraws one block in place: turns per minute with a sparkline of the last thirty minutes, latency percentiles, first-token time, the time each stage took, a bar for each outcome, errors and rate-limited turns, tokens, and the model and index the server runs. `q` quits.

- **Off a terminal it prints one JSON line per poll**, so the same command feeds a log: `npx docpilot monitor --interval=10s >> metrics.jsonl`.
- **`--once`** polls one time, prints the snapshot as a JSON line and exits `0`, or `1` with the reason on stderr.
- **A field that is missing is drawn as `—`.** A server that has answered no turn has no p95.
- **A server without a metrics route** answers `404` and `monitor` says *metrics unavailable* instead of failing. A server that wants a token answers `401`, and off loopback with no token `403`. For both, `monitor` names the variable to set.

What the numbers mean, and the setting that turns the route off, are in [Server operations](/guide/server-operations#metrics). The flags are in the [`monitor` reference](/reference/cli#monitor).

## Progress and the scorecard

Long commands show where they are.

- `index`, `eval`, `calibrate` and `tune` draw a progress bar with an ETA.
- `eval` ends with a **scorecard**: each metric, its move since the run `eval` compared it with, and a sparkline across earlier comparable runs. A metric that moved the good way is green, whichever way that is: up for recall, down for latency.
- A warning that repeats prints once, followed by `×N`, so a log shows what happened and how often and not three hundred lines of it.

[Measure](/guide/measure) explains the metrics in the scorecard.

## Colour {#colour}

Colour carries meaning — green for good, yellow for a warning, red for a failure — and never carries a fact alone. The words are the same with the colour off.

A stream is coloured when all of these hold, checked in this order:

1. `NO_COLOR` is not set to a non-empty value. If it is, there is no colour, whatever else is set.
2. `FORCE_COLOR` is not set. If it is set to an empty string, `1`, `2`, `3` or `true`, colour is on, even through a pipe. Any other value, `0` and `false` included, turns it off.
3. Otherwise, the stream is a terminal and `TERM` is not `dumb`.

So piped output has no colour escape codes and is the 1.x output, and a CI log stays readable. Set `FORCE_COLOR=1` to keep colour through a pager or a CI log that renders it.

## Related

- [CLI reference](/reference/cli) — every command and flag.
- [Server operations](/guide/server-operations) — the metrics `monitor` reads.
- [Improve answers](/guide/improving) — the loop that `status` points to once a site is measured.
