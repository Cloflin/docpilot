# 030 — The terminal shows the numbers

> **Кратко.** CLI печатает правильные вещи, но как стену текста: ни цвета, ни
> прогресса, ни одной картины состояния проекта. 2.0 добавляет набор
> терминальных примитивов без зависимостей (`src/cli-ui.ts`), домашний экран
> (`npx docpilot` в терминале), `docpilot status` — состояние индекса, порогов,
> eval-наборов и последнего замера одной картиной, и `docpilot monitor` — живые
> метрики сервера. Вывод в pipe/CI остаётся построчным и не меняется по смыслу;
> всё, что держат тесты, держится.

## Problem

Every command prints correct, carefully worded text, and none of it is easy to
read at a glance:

- **No colour, anywhere.** `grep -rn 'NO_COLOR\|\x1b\[' src/ bin/` finds nothing.
  Verdicts are carried by upper-case words (`MISS`, `HARD GATE FAILED`,
  `CALIBRATION FAILED`) inside long paragraphs.
- **No picture of the project.** "Is my index fresh, is the guard calibrated for
  it, how did the last eval do, is the server up?" takes four commands and a
  JSON file: `index --dry`, `doctor`, reading `docpilot/reports/latest.json`,
  and `curl`. Nothing says what to run next.
- **Progress is a counter.** `tick()` (`src/cli-exit.ts:90`) redraws one line and
  never clears to end of line, so a shorter tick leaves debris; the indexer ends
  its tick line with a newline on STDOUT (`build-rag-index.ts:595`).
- **Repeated warnings.** `index --dry` on this repo prints each of four
  `sections collapsed as set-equal` warnings four times.
- **The server is a black box.** Spec 028 writes a turn log, but nothing shows
  latency, first-token time, outcomes or errors while it runs.
- **Prompts are numbered lists** (`src/cli-ask.ts`): no arrow keys.

## Research

- **clig.dev** (Command Line Interface Guidelines): human-first output by
  default; machine output through stable `--json`; colour only on a TTY, never
  when `NO_COLOR` is set; progress on stderr; "tell the user what to do next".
- **no-color.org**: `NO_COLOR` present and non-empty disables colour.
  `FORCE_COLOR` (Node's own convention, `0` off, `1..3` on) forces it.
- **Node** `util.styleText` exists from 20.12 / 21.7 only, and `engines.node` is
  `>=20`, so the escapes are written by hand; `readline.emitKeypressEvents` +
  `setRawMode` is the dependency-free way to read arrow keys.
- Prior art that sets the expectations of a reader: `gh` (status dashboards),
  `vercel` and `wrangler` (spinners, coloured verdicts), `k9s`/`htop` (live
  views refreshed in place), `@clack/prompts` (arrow-key menus). None is a
  dependency: the package keeps its two runtime dependencies.

## Decision

### 1. `src/cli-ui.ts` — primitives, no dependencies

- `colorEnabled(stream, env)`: `NO_COLOR` non-empty → off; `FORCE_COLOR=0` →
  off; `FORCE_COLOR>=1` → on; otherwise `stream.isTTY && TERM !== 'dumb'`.
- A palette with semantic names (`ok`, `warn`, `fail`, `info`, `muted`,
  `accent`, `bold`) that returns plain text when colour is off.
- Symbols with an ASCII fallback (`✔ ✖ ▲ ▼ ● ◆ ❯` → `+ x ^ v * # >`) when the
  terminal cannot be trusted with Unicode (`TERM=linux`, or a legacy Windows
  console without `WT_SESSION`).
- `visibleWidth`/`stripAnsi`; `table`, `kv`, `box`/`rule`, `bar` (eighth
  blocks), `sparkline` (`▁▂▃▄▅▆▇█`), `delta(value, better)` → `▲ +0.031`
  coloured by whether the move is good, `duration`, `bytes`, `pct`.
- `live(stream)`: a region of N lines redrawn in place on a TTY (cursor up +
  clear line); on a non-TTY it writes nothing until `done()`, which writes the
  final lines once. `spinner` and `progress` (bar, count, elapsed, ETA) are built
  on it.
- `select({message, choices})`: an arrow-key menu (↑/↓, j/k, digits, Enter);
  Esc/q backs out, Ctrl-C and Ctrl-D exit `130` (`CANCELLED`). The terminal mode
  is restored on every exit path. Off a TTY it falls back to `askOne`.

### 2. `docpilot status`

One picture of the project, computed by a pure `collectStatus()` that the home
screen and `--json` share:

| block | from | shows |
|---|---|---|
| project | config path, settings | product, runtime (`static` / `server`), docsDir |
| index | `manifest.json`, the chunker run offline | fresh or stale against the docs, chunks, pages, embedder, dims, quantisation, bytes on disk and brotli estimate |
| guard | `manifest.guard`, `calibration*.json` | mode, tau, source, stale |
| eval sets | `golden.jsonl`, `chains.jsonl`, `adversarial.jsonl`, `calibration.jsonl` | counts by expect, split, level |
| last eval | newest report + its comparable predecessors | model, level, age; a scorecard with deltas and a sparkline per metric |
| server | `server.endpoint` or `--url` | reachable, round trip, and the metrics snapshot when the server exposes one |
| next | rules over the above | the one command to run next, and why |

The freshness check is the same derivation `test/docs-links.test.js` uses:
chunk the docs offline and compare `sha256(ids+texts)` with `manifest.hash`.
No network unless a server URL is configured.

`--json` prints `{kind: 'docpilot.status', v: 1, …}` — the entry point the
tuning agent (spec 036) reads.

### 3. The home screen

`npx docpilot` with no command, when stdin and stdout are both TTYs and `CI` is
unset: the status picture, then `select()` over the actions that make sense now
(the "next" action first), each one running the real command. Anything else —
a pipe, CI, `--help` — prints the global help exactly as before.

### 4. `docpilot monitor`

A live view of a running server (`--url`, default the configured endpoint on
`http://localhost:8787`), polling `GET {endpoint}/metrics?format=json` every
`--interval` (default 2 s): turns per minute with a sparkline, latency
p50/p95/p99, first-token p50/p95, per-stage times, outcome bars, errors and
rate-limited turns, tokens and cache share, the model and index hash. `q` quits.
Off a TTY, or with `--once`, it prints one JSON snapshot per poll — so the same
command feeds a log. The endpoint's shape is spec 031's.

### 5. Commands that already exist

- `help` is grouped — **Set up** (init, update, doctor, status), **Build**
  (index, import, vocabulary), **Measure** (calibrate, lint, eval, bench, tune),
  **Improve** (improve, feedback, traffic, llms), **Operate** (serve, monitor),
  **Train** (dataset, model) — and coloured on a TTY. Its text is the same piped
  or not, colour aside.
- `index`, `eval`, `calibrate`, `tune` show a progress bar with an ETA on a TTY;
  off a TTY they print what they print today.
- `eval` ends with a coloured scorecard (the same numbers its summary already
  prints, with deltas against the previous comparable report).
- `index` prints each distinct warning once, with `×N` when it repeated.
- `tick()` clears to end of line.

## Why it fits

`cli-exit.ts` already owns "may this line redraw" (`redraws()`), and the
`run*` contract already returns exit codes instead of exiting. The UI module
sits beside it, imports nothing, and is pure enough to unit-test every
renderer at a fixed width with colour on and off. Metric directions come from
`report.ts`'s `HIGHER_IS_BETTER` / `LOWER_IS_BETTER`, so "better" is decided in
one place.

## Cost and risk

- Escapes in a log are the classic failure; every writer goes through
  `colorEnabled`, and a test spawns each command piped and asserts no `\x1b`.
- Raw mode left on after a crash leaves the user's terminal broken; `select`
  restores it in `finally` and on `exit`.
- Startup time: `status` runs the chunker over the docs (≈0.3 s on this repo's
  60 pages). The home screen is only for an interactive terminal.
- Revert condition: none needed per command — every TTY-only path has a piped
  path that is the 1.x output.

## Checks

- `test/cli-ui.test.js`: every primitive at a fixed width, colour on and off,
  `NO_COLOR`/`FORCE_COLOR` precedence, ASCII fallback, `visibleWidth` of
  coloured text.
- `test/cli-status.test.js`: `collectStatus` on a temp project (fresh index,
  stale index, no index, no eval sets, a report pair), the `next` rules, and
  `status --json` parsing.
- `test/cli-monitor.test.js`: rendering of a fixed metrics snapshot; `--once`.
- `test/cli-flags.test.js` keeps holding the flag table against `cli.md` for
  the two new commands.
- Every pinned string in `cli-flags`, `cli-doctor`, `cli-init`, `cli-skills`
  and `docpilot.test.js` still passes unchanged.

## What this does not do

- No full-screen TUI and no mouse. A live region of a few lines is the ceiling.
- No new runtime dependency.
- It does not change what any `--json` output contains.
