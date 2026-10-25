# 031 — The server turn, fast and watched

> **Кратко.** Серверный ход 1.5 был последовательным от начала до конца, не
> знал, куда уходит время, и ничего не показывал оператору: первый ход каждого
> процесса ждал probe модели и строил BM25 за читателя; на Ollama ответ через
> инструмент `answer` не стримился, и «первый токен» был последним. 2.0: тайминги
> каждой стадии и ранжирование в turn-логе, `GET {endpoint}/metrics`
> (Prometheus и JSON), прогрев при старте, probe параллельно эмбеддингу, кеш
> векторов, опциональный кеш ответов и политика хода `server.turn` — one-shot,
> adaptive, без reasoning перед ответом. Измерено: на корпусе DocPilot one-shot
> без reasoning снижает первый токен p50 с 46.6 до 10.5 с.

## Problem

Measured on this repository's docs with the server runtime and a local qwen3:8b
(Apple M4), before any change:

- **Everything sequential.** credential → social → opener → embedding → dense
  opener → gate → probe → loop → final call; no two network calls overlapped.
- **The first turn paid for everyone.** The capability probe ran in series with
  the first turn of every process, and the BM25 index was built inside it.
- **The answer did not stream.** On Ollama an in-loop `answer` tool call arrives
  as one frame, so on three turns of four the reader saw nothing until the end
  (TTFT = total latency, 18–44 s); on the rest the final call reasoned for ~20 s
  before its first token.
- **Nothing to watch.** No timing per stage in the log, no metrics endpoint;
  "is it fast" took a log parse.

## Research

- Provider prefix caching (DeepSeek, OpenAI, Anthropic) and llama.cpp's slot
  cache all reuse a byte-identical prompt PREFIX. Measured on Ollama: a 5.5k-token
  prompt re-sent with only the question changed re-prefilled in 0.26 s instead
  of 31 s, and a changed tool `enum` cost 0.4 s — the Qwen template renders tools
  after the system text, so the system prefix still hits.
- Per-query configuration adaptation (METIS, 2024): spend the expensive path
  only on the queries that need it.
- OpenTelemetry GenAI semantic conventions name the operator's numbers: operation
  duration, time to first token, token usage — rendered here as Prometheus
  histograms and counters.

## Decision

1. **Timings in the turn record** — `timing: {embedMs, embedRequests, retrieveMs,
   probeMs, probeWaitMs, loop, modelMs, firstThoughtMs, firstTokenMs, totalMs}`
   and `rankedIds` (the ranking the turn ran on). An answer that never streamed
   takes its total latency as its first token.
2. **`GET {endpoint}/metrics`** — Prometheus text or `?format=json`
   (`docpilot.metrics/1`, exact p50/p95/p99 over the last 1000 turns, 30
   one-minute buckets); loopback, or `Authorization: Bearer
   $DOCPILOT_METRICS_TOKEN`. `docpilot monitor` renders it (spec 030).
3. **Warm boot** — the BM25 index built and the probe started at
   `createDocPilotServer`; a turn awaits the shared promise, never starts a
   second probe, and the probe has its own minute and never a reader's signal.
4. **Caches** — query vectors per process (`server.cache.embeddings`, 1000); whole
   first-turn answers, opt-in (`server.cache.answers: {ttlMs, max}`), keyed by
   index hash, prompt hash, model, language and the normalised question.
5. **`server.turn`** — `loop: 'one-shot'` (straight to the answer call with
   the gate's evidence), `'agentic'` (the browser's loop, the 1.x server turn),
   `'adaptive'` (one-shot when `G >= adaptiveG`, 0.6); `finalThink` (reasoning
   before the answer). The browser runtime never reads it. The default, decided
   by the Harborline run below, is one-shot with `finalThink: false`; an
   `'agentic'` or `'adaptive'` turn keeps the model's own reasoning default.

## Measured

DocPilot's own docs, server runtime in-process, qwen3:8b on Ollama, bge-m3, the
22 records at `--level=medium` (16 positives, 6 negatives):

| `server.turn` | answer F1 | citation P / R | negatives caught | latency p50 / p95 | first token p50 / p95 | requests / turn | prompt tokens |
|---|---|---|---|---|---|---|---|
| default (agentic, reasoning) | 0.370 | 0.42 / 0.50 | 3 / 6 | 38.8 s / 75.9 s | 46.6 s / 104 s | 1.41 | 3,965 |
| one-shot, `finalThink: false` | 0.363 | 0.38 / 0.44 | 2 / 6 | 25.9 s / 78.2 s | 10.5 s / 19.3 s | 1.00 | 2,244 |

The first token arrives 4.4× sooner and the median turn ends a third sooner, at
a cost inside the noise of 22 records.

Harborline, the same model, 65 records at `--level=high` (50 positives, 15
negatives), `bench/harborline/results/RESULTS.md`:

| `server.turn` | answer F1 | citation P / R | negatives caught | latency p50 / p95 | first token p50 / p95 | requests / turn | prompt tokens |
|---|---|---|---|---|---|---|---|
| agentic, reasoning (1.x) | 0.407 | 0.56 / 0.78 | 6 / 15 | 25.0 s / 40.2 s | 25.0 s / 40.2 s | 1.11 | 2,757 |
| one-shot, `finalThink: false` | 0.414 | 0.60 / 0.74 | 6 / 15 | 19.5 s / 39.3 s | 8.3 s / 9.8 s | 0.98 | 2,004 |

Paired against the loop, one-shot moved answer F1 by +0.009 [−0.015, 0.031],
citation precision by +0.036 [−0.054, 0.126] and recall by −0.036 [−0.128,
0.056]: no quality change either corpus can show, a first token three times
sooner on both. **Decision: one-shot without reasoning is the 2.0 default**;
`turn: {loop: 'agentic'}` restores the 1.x turn. Its one failure in 65 was a
generation that ran into the 120 s step timeout — an Ollama model has no
output ceiling unless `chat.maxTokens` sets one.

## Why it fits

The policy is two values the harness already understood — `maxIterations: 0`
is how budget mode spells one-shot, and the final call's `enableThink` took a
boolean — so no new code path runs a turn. Timings and metrics read the record
the turn already wrote.

## Cost and risk

- One-shot gives up the model's own re-search; on a corpus where the first
  retrieval misses more often, accuracy falls further. `adaptive` keeps the loop
  for weak evidence.
- An answer cache serves the first wording to every later reader; it is off, and
  keyed so an index or prompt change empties it.

## Checks

`test/server-ops.test.js`: metrics shape and access, timings and ranking in the
record, the answer cache (hit, no hit with history), one-shot spending exactly
the answer call, no policy meaning the browser's turn.

## What this does not do

- No reranker. OpenRouter's rerank endpoint is refused by this account's
  zero-data-retention setting, Ollama has no rerank API, and the two GGUF builds
  of Qwen3-Reranker tried did not score through `generate`. Nothing is shipped
  that could not be measured.
- No change to the browser runtime's loop: chat behaviour there stays 1.x.
