# 037 — Two installs

> **Кратко.** С 1.5 у DocPilot два способа работать — ход в браузере читателя
> (статика) и ход на сервере владельца, — но выбор был спрятан в ключе
> `runtime`, а `init` о нём не спрашивал. 2.0 делает выбор первым вопросом
> установки: `init` спрашивает (`--runtime=browser|server`) и печатает, что
> вставить и как запустить; документация начинается со страницы выбора; `status`
> показывает выбранную установку. Поведение чата для читателя одинаково в обеих.

## Problem

Two installs with opposite trade-offs, and nothing that asked the owner to
choose:

| | static (`browser`) | server |
|---|---|---|
| the page downloads | the whole index, the prompt, the thresholds | a page list and a stream |
| optimised for | bytes, no server to run | speed, accuracy, privacy, control |
| the owner runs | a key proxy | the turn |

A site owner learned of the second from a guide page, after installing the
first.

## Decision

1. `npx docpilot init` asks "Where should a question be answered?" — `browser`
   (static, the default) or `server` — before the placement questions, and
   prints the `runtime` block. For `server` it also prints the ways to run the
   turn (`docpilot serve`, `createDocPilotServer` on Node, Bun, Deno or Workers)
   and the two secrets (`DOCPILOT_SERVER_SECRET`, `DOCPILOT_METRICS_TOKEN`).
   `--runtime=` answers it non-interactively. `init` still never edits a config.
2. The docs open with the choice (`install/choose`): what each install makes
   public, what the owner runs, and the measured numbers from
   `bench/harborline` for both.
3. The 2.0 defaults per install are the measured ones: the static install keeps
   1.x retrieval (no lever beat it on two corpora — spec 034); the server install
   ships limits and a deadline on (spec 033) and keeps the agentic loop until the
   Harborline matrix decides `server.turn` (spec 031).

## Why it is 2.0

Behaviour a deployment relied on changes without its config changing: a server
install now refuses past its limits and its deadline, unsigned history is
demoted, and every index file name changes. Each is listed in the changelog's
**Breaking** block with the one setting that restores 1.x.

## What this does not do

- No third install. An edge function is the server install with
  `handle(Request)`; a fully offline panel is not a goal.
- No migration tool: there is nothing to migrate in a config — `runtime` keeps
  its meaning, and a rebuilt index is the whole upgrade.
