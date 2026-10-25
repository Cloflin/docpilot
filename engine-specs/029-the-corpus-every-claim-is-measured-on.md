# 029 — The corpus every claim is measured on

> **Кратко.** Утверждения 2.0 («сервер быстрее», «статика легче», «правка
> llms.txt помогает», «пробы атак отбиты») нечем было проверить: единственный
> корпус — собственная документация, которую модель частично знает, eval не умел
> гонять серверный путь, не было nDCG, TTFT, разбиения dev/test и проб
> безопасности. Добавлены: фикстура Harborline (выдуманный продукт, 36 страниц,
> 130 golden-записей, 8 цепочек, 30 атак) и eval с `--runtime=server`,
> `--split`, `--set=adversarial`, nDCG@8, context precision@5, recall@1/3/5,
> p99 и временем до первого токена. Риск — переобучение на фикстуре; поэтому
> правки выбираются на dev, а доказываются на test.

## Problem

- **The only corpus was this package's own docs.** A model has read about
  DocPilot (it is on npm and GitHub), so an answer can be right from memory and
  a retrieval regression can hide behind it. Answers about a product nobody has
  documented anywhere else can only come from retrieval.
- **`eval` measured one install.** It restated the browser turn (`run.ts`) and
  never ran `runServerTurn` (`server/turn.ts`), which has its own differences:
  openers, credential and social checks, tentative answers, the probe latch.
  "The server is faster" had no instrument.
- **The standard numbers were missing.** recall@8 and MRR only — no nDCG@10
  (declined in spec 011), no rank-weighted context precision, no first-token
  latency, no p99. A claim against any other system's published numbers could
  not be stated.
- **No held-out half.** Every corpus edit proposed from failing questions was
  scored on the same questions — a measurement of how well it was fitted to
  them.
- **`noAnswerPrecision` was a constant 0** under the shipped `guard.mode: 'off'`:
  every caught negative lands on `refuse:not-answerable`, which never equals an
  authored `refuse:no-evidence`.
- **Security was read, never run.** Nothing asked the turn to leak its
  instructions and checked whether it did.

## Research

- RAG evaluation practice (RAGAS, RAGChecker NeurIPS 2024, ALCE, BEIR) splits
  retriever and generator metrics; nDCG@10 and MRR are the retrieval lingua
  franca; context precision is rank-weighted in RAGAS and flat in RAGChecker —
  this package uses the rank-weighted form.
- A synthetic product is the standard way to separate retrieval from
  parametric knowledge (closed-book contamination is the first failure mode of
  open-domain QA benchmarks).
- Held-out splits are the minimum guard against tuning to the test; the
  sandbox of `stripo-docs/.claude/doc-agent-eval` uses train/test/acceptance by
  date for the same reason.
- Canary strings are the standard leak test (OWASP LLM07): a token only the
  instructions carry, matched in the output.

## Decision

1. **`bench/harborline/`** — Harborline, a managed job queue that does not exist:
   36 pages (`docs/`), its config (`docpilot.config.mjs`, local bge-m3 + Ollama),
   `eval/golden.jsonl` (130: 105 positives over 10 categories, 25 negatives, 14
   Russian questions, dev/test split, tiers), `eval/chains.jsonl` (8 × 5 turns),
   `eval/adversarial.jsonl` (30 probes, 8 kinds). Deliberate defects — five
   vocabulary gaps, two answers split across sections, one planted indirect
   injection — are listed in `truth/defects.json`. `truth/` (the product bible,
   the authoring brief, a reference llms.txt) is never indexed and never shown
   to a tuning agent.
2. **`eval --runtime=server`** answers each record through
   `createDocPilotServer().handle` in-process, reading the SSE bytes with the
   panel's own parser and the turn record through the log sink;
   **`--endpoint=<url>`** measures a running server over HTTP.
3. **`eval --split=dev|test`**; a record without `split` is assigned by a hash
   of its id (`splitOf`), so no command writes `golden.jsonl`.
4. **`eval --set=adversarial`** runs `adversarial.jsonl`: `forbid` strings,
   `forbid_regex` shapes, `expect: refuse | answer-safely`; the summary gains
   attack success rate, refusal accuracy and safe-answer rate, per kind.
5. **Metrics:** recall@1/3/5, nDCG@8, context precision@5 beside recall@8 and
   MRR; latency p99; first-token p50/p95 (both runtimes); `noAnswerPrecision`
   null when no gate could have named a cause.
6. **`bench/run.mjs`** builds one index per arm, runs every measurement, and
   `bench/report.mjs` renders `results/RESULTS.md` with paired bootstrap
   intervals — the only source of the 2.0 comparison's numbers. The 1.5 arm runs
   the released CLI from a worktree of `main`.

## Why it fits

Every addition reads what the pipeline already produces: the server turn record
gained `rankedIds` and `timing`, the browser row gained the same lenses, and
`summarise` is shared, so the two runtimes print one summary shape and
`report.ts` diffs them. Report names gain `-srv`, `-split-<x>` and `-adv` only
off the 1.x default, so every existing report still pairs.

## Cost and risk

- A fixture is one corpus written by one author: a lever can win on it and lose
  elsewhere. Retrieval levers are therefore also measured on this package's own
  corpus, and nothing is adopted that loses on either.
- Local answer runs are slow (qwen3:8b on an M4: 20–70 s a turn); the matrix runs
  at `--level=high` (65 records) by default.

## Checks

- `test/server-ops.test.js` — `serverRows` against a stub model: ranking,
  timings, first token, the outcome rule.
- `test/improve.test.js`, `test/cli-flags.test.js` — the new flags are in the
  table, the reader and `cli.md`.

## What this does not do

- No LLM judge in the scored metrics — RAG-SPEC 5's rule stands: a metric that
  moves with the judge cannot be a gate.
- It does not replace the docs' own golden set; both are run.
