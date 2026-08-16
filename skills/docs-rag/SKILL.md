---
name: docs-rag
description: >-
  Build, measure and tune the DocPilot RAG pipeline, and edit the documentation
  corpus so the assistant can answer from it. Use when running or reading
  `npx docpilot eval`, `calibrate`, `index` or `bench`; when editing the golden or
  calibration set; when tuning retrieval (RRF weights, MMR lambda, topK,
  chunking); when cutting tokens or latency per answer; when diagnosing why a
  golden record failed or why the gate refused a real question; when proposing
  documentation edits (`<llm-only>` hints, frontmatter `description`) that make a
  page answerable; or when making the docs consumable by other people's agents
  (llms.txt, robots, per-route markdown). Triggers: "run the eval", "why did q-08
  fail", "tune retrieval", "calibrate the gate", "fewer tokens per answer", "the
  assistant can't answer X", "improve the docs for the AI", "llms.txt".
---

# docs-rag

The measurement and tuning loop for DocPilot.

This skill is deliberately thin. General agent-harness reasoning — context
compaction, prompt caching, tool design, eval theory — is not restated here. What
lives here is what is specific to *this* pipeline, *these* thresholds and *these*
levers.

Numbers quoted below were measured on the corpus this package was developed
against. They are kept because each one records a decision that is baked into the
shipped defaults, and re-deriving them costs hours. Treat them as "this has been
tried, here is what happened", not as predictions for your corpus.

## The pipeline in one paragraph

`docpilot index` chunks `<docsDir>/**/*.md` — plus `<importDir>` and any OpenAPI
YAML — into the index directory (manifest, shards, int8 vectors, df). In the
browser, `retriever.js` fuses BM25 and dense retrieval, and its gate decides —
before any model call — whether there is evidence to answer at all. `harness.js`
then runs a short tool loop over the retriever and nothing else. `docpilot eval`
drives exactly those production modules; nothing is stubbed.

## Modes

### `eval` — run and read

```bash
npx docpilot eval --gate-only                          # retrieval + gate, seconds
npx docpilot eval --models=qwen3:8b,phi4:14b           # the matrix
npx docpilot eval --limit=3                            # short loop
npx docpilot eval --resume                             # skip models already reported
```

Reads `<evalDir>/reports/report-<indexHash>-<model>-<promptHash>.{json,md}`. The
markdown sibling carries the hard gates, the metric table, the change since the
previous run and the over-refusal backlog. State a verdict and stop: this mode
edits nothing.

Two things to check before believing a delta:

- **`incomparable`** in the report. A prompt, lever, golden-set or `num_ctx`
  change makes the comparison meaningless, and the report says which.
- **the hard gates**: `hallucinated == 0` and `scopeContainment == 1.0`. Either
  one failing fails the whole run regardless of every other number.

### `generate` — the golden set

1. Sample from the index's chunk shards, stratified by `kind`, section and path
   depth — `scripts/sample-chunks.js` does this. Every section must contribute at
   least one candidate, and the largest section must be capped: documentation is
   never evenly sized, and an unweighted sample measures whichever corner happens
   to have the most pages.
2. A small local model drafts two questions per sampled chunk.
3. **A careful editing pass is mandatory** — a draft never reaches the golden set
   raw. Discard questions answerable without the docs and quotation questions;
   rewrite into how a real reader asks; verify `gold_chunks` **by running the
   retriever**; mark `identifiers`; author the negatives and scoped records.

Two rules that decide whether the metrics mean anything:

- **`gold_answer` is written at the length and shape the product produces** — one
  short paragraph, an optional list, a fenced block only where the gold chunks
  contain code, 90–160 words. With a 25-word gold against a 150-word answer,
  `P = overlap/|pred|` caps token-F1 near 0.29 whatever the model writes. A low
  measured answer-F1 is mostly that ceiling, not the model.
- **`gold_chunks` are authored as anchored chunk ids**; page-level gold is derived
  by stripping `#…`. Page-level F1 stays the historical diagnostic; Recall and MRR
  are the metrics that get thresholds.

Two things measured about the *grain* of a gold:

- **A class-overview question is answered by a page, not a section.** Pin it to
  the lead chunk `path#`, which prefix-matches every anchor of that page and
  nothing else. A bare `path` is not the same thing and is a trap: it also
  prefix-matches a sibling page whose route extends it.
- **If the top hit is a different page that answers better, the question was
  wrong.** Rewrite the record and re-pin it. A quarter of newly authored records
  moved this way after their first retriever run, which is why the run is
  mandatory before a record is kept.

A record with `promptStock: false` never becomes a golden record.

### `bench` — A/B two retrieval configs with no API key

`docpilot eval` needs an HTTP endpoint. `docpilot bench` does not: it runs the
retrieval half in-process and hands the **forced final call** to subagents, which
is how a retrieval change gets an answer-side reading when there is no key and no
local model worth waiting three hours for.

```bash
npx docpilot bench emit  --config=base
DOCPILOT_RRF_K=5 … npx docpilot bench emit --config=swept
npx docpilot bench shard --tasks=<file> --stage=2 --shards=5
npx docpilot bench score --tasks=a,b --answers=a,b
npx docpilot bench judge-emit --tasks=a,b --answers=a,b
npx docpilot bench judge-score --verdicts=… --key=…
```

Answering agents get [answerer-protocol.md](./answerer-protocol.md); the judge
gets [judge-protocol.md](./judge-protocol.md). Both are checked in — a protocol
that lives in a chat message is one nobody can reproduce.

**What it measures.** Retrieval, the gate and the primed observation are the
production modules with the production constants, and `buildMessages()` builds
the transcript, so the evidence the answerer sees is byte-identical to the
shipped turn's. Scoring is `metrics.js` — pure, deterministic, the same functions
`eval` uses.

**What it does not measure, and must never be quoted as.** The agent loop, tool
calls, iterations per answer, latency, tokens per answer. It is a comparison
instrument for two retrieval configurations, not a source of production numbers.
The answerer is a subagent under its own harness, not the shipped model on the
shipped transport — both sides get identical treatment, which is what makes the
*difference* readable and the absolute values not.

Two rules the modes enforce rather than request:

- **A shard carries `id`, `prompt` and `citable`, and nothing else.** `emit` keeps
  `gold_answer`, `identifiers` and `gold_chunks` in the task file. An answerer
  that can see the gold rewrites it, and every metric downstream then measures
  the copy.
- **A follow-up needs two passes.** Pass 1 emits its previous question as
  `<id>#prev`; pass 2 takes `--history=<those answers>` and emits the real record.
  Without it the prompt is missing the turn that makes it a follow-up.

The judge is **advisory and never gates** — see the binding rules below.

### `tune` — propose edits

Input: the latest report plus recorded reader feedback. Output: a list of edits,
each naming **the file, the concrete change, and the expected effect on a named
metric**. An edit with no metric attached does not reach the output.

Levers, in increasing order of risk:

1. RRF weights and MMR λ — `retriever.js`
2. `topK`, chunk size, the merge rule, `MAX_CHUNK_CHARS`
3. the system prompt blocks — `prompt.js`
4. the tool descriptions
5. `maxIterations` and the degradation rules

Every constant in lever 1 is sweepable from the environment without editing a
file, which is what makes `--gate-only` the loop:

```bash
DOCPILOT_MMR_LAMBDA=1.0 DOCPILOT_FUSED=8 npx docpilot eval --gate-only
```

Available: `DOCPILOT_RRF_K`, `DOCPILOT_W_LEXICAL_RRF`, `DOCPILOT_W_DENSE_RRF`,
`DOCPILOT_MMR_LAMBDA`, `DOCPILOT_CANDIDATES`, `DOCPILOT_FUSED`,
`DOCPILOT_EXPAND_BELOW_TOKENS`, `DOCPILOT_GATE_K`.

### `corpus` — edit the documentation, not the code

The lever most tuning discussions miss. When an answer is wrong because the
*page* is thin, no retrieval constant fixes it.

Inputs: a report from `<evalDir>/reports/`, and — if the site publishes them —
`llms.txt`, `llms-full.txt` and the per-route `.md` files, which are the
LLM-facing rendering of a page and therefore what an edit here actually changes.

1. Select failing records: `observed !== expect`; `recall8 < 1` on a positive;
   low `answerF1`; `identifierRecall < 0.8`.
2. Walk `gold_chunks` → page path → the page source.
3. Classify into exactly one of three causes. **Only two are actionable.**
   - **vocabulary gap** — the words a reader would use never appear on the page.
     Add a frontmatter `description`, or an `<llm-only>` line naming the task.
   - **structure** — the answer exists but is split so no single chunk carries it.
     Add an `<llm-only>` summary at the top of the section.
   - **content gap** — the documentation does not contain the answer. **No edit.**
     The record becomes `refuse:no-evidence`, or a human writes a real page.
     Never invent product behaviour.
4. Loop: `npx docpilot index` → `npx docpilot eval --gate-only` → a full model run →
   compare → **revert anything that regresses a metric by more than 2 percentage
   points.**

**The hard content rule.** `<llm-only>` text is indexed, can be cited, and can be
shown to a reader. It must be true, publishable documentation. **It must never
address the model or contain an instruction.** `prompt.js`'s `OBS_NOTE` guarantees
that corpus text is data and never a directive; an imperative written into
`<llm-only>` is a self-inflicted injection attempt that the host is designed to
ignore anyway.

`<llm-exclude>` is the opposite tool: wrap navigational or marketing prose that
dilutes a chunk's embedding. `normalise.js` honours both tags, so one edit moves
the published artefacts and the index together.

### `llms` — make the docs consumable by other people's agents

DocPilot answers from a private index. This is the other half: the plain-text
surface an agent that is *not* this panel can read. The two share a corpus and
nothing else, and improving one does not improve the other.

**VitePress is the only baseline this package supports.** If `vitepress` is not a
dependency of the project, say so and stop — the steps below do not transfer, and
guessing at another generator's plugin API produces a config that silently emits
nothing.

1. **Check for `vitepress-plugin-llms`** in `package.json`.
2. **If it is absent, PROPOSE it — never install it.** Print the command and the
   config block and let the user decide; adding a build-time dependency to
   somebody's docs site is their call:

   ```bash
   npm i -D vitepress-plugin-llms      # or: npx -y vitepress-plugin-llms
   ```

   ```js
   import llmstxt from 'vitepress-plugin-llms'
   import { absoluteSidebar } from '@cloflin/docpilot/sidebar'

   export default defineConfig({
     vite: {
       plugins: [
         llmstxt({
           domain: 'https://docs.example.com',
           generateLLMsTxt: true,
           generateLLMsFullTxt: true,
           generateLLMFriendlyDocsForEachPage: true,
           stripHTML: true,
           sidebar: (s) => absoluteSidebar(s),
         }),
       ],
     },
   })
   ```

   `absoluteSidebar` is not decoration. VitePress prefixes a group's items with
   its `base`; the llms plugin joins the two differently and emits links like
   `/getting-started/getting-started/creating-an-application.md`. llms.txt exists
   so that another agent can FOLLOW those links, so a doubled segment is the
   whole file failing at its job. **Delete the import the moment upstream fixes
   the join.**

3. **If the generator is not VitePress** — Docusaurus, Mintlify, Starlight,
   Scalar, MkDocs — name the equivalent for that generator and stop. No
   installation, no config edit: this package has not measured any of them.

4. **Serving.** `llms.txt`, `llms-full.txt` and the per-route `.md` files are
   only useful if they are served as `text/plain` and `text/markdown` with
   `Access-Control-Allow-Origin: *`. A static host that serves `.md` as
   `application/octet-stream` makes an agent download them instead of reading
   them. This is the same layer as the DocPilot proxy — see the deployment page in
   this package's docs, and `npx docpilot doctor --proxy` for the resolved
   contract.

5. **Crawlers.** A `robots.txt` that allows the AI crawlers you want (GPTBot,
   ChatGPT-User, Claude-Web, anthropic-ai, PerplexityBot, Applebot, CCBot,
   cohere-ai) and names the sitemap is a two-minute edit with no downside for a
   public docs site. It is the user's decision, so propose it and say what each
   agent does with the access.

Nothing in this section touches the RAG index. `llms.txt` is not read by DocPilot
and never will be — DocPilot reads its own manifest, and a change here moves no
metric in any report.

## Binding rules

- **`tau`, `tauLexical`, `wDense` and `wLexical` are not levers.** The only legal
  way to change any of them is `npx docpilot calibrate`. A hand-set `docPilot.guard.*`
  is honoured but stamps `gate.source: "config"` on every record of the session.
- **Scope has no threshold to tune** — it is an allowlist.
- Records with `promptStock: false` are discarded before any analysis, and the
  exclusion count is printed.
- **When `stockPromptShare` falls below 0.70, lever-3 and lever-4 edits may not be
  proposed at all**, and the skill says so. Levers 1, 2 and 5 are unaffected: a
  reader instruction cannot reach the retriever.
- Retrieval-only levers are measured `--gate-only` before any model is started. A
  lever that does not move a gate-only metric has not earned a matrix run.
- An edit to `CORE`, `TOOLS`, `OBS_NOTE`, `FINAL_NOTE` or `docPilot.product` changes
  `PROMPT_HASH` and invalidates every cross-report comparison. Apply it **alone**,
  then run the full matrix.
- After applying any edit, re-running `eval` is mandatory. **A regression of more
  than 2 percentage points on any metric is reverted.**

## Invariants an edit must not break

- `npm run check` (`scripts/check-docpilot.sh`) plus the design rules that moved into
  the test suite. Two bite here: `harness.js` may never contain the bare token
  `index`, and `search_docs fetch_section list_pages maxIterations qwen3 threshold
  topK` may never appear in `DocPilot.vue`.
- `systemText()` takes no addendum parameter, and the test suite asserts the
  system message is byte-identical with and without a reader instruction.
- `assertWeights` throws unless `wLexical < tau`.
- No LLM judge may become a gate — `metrics.js` is pure and deterministic by
  contract. An advisory judge beside a deterministic metric is allowed; a judge
  that decides pass/fail is not.
- Every reader-facing string goes through the i18n table. A new literal in a
  component fails `i18n — the components go through the table`.
- New tests go in `test/docpilot.test.js`. One file is the repo convention.

## Things already measured — do not re-derive them

- **Ollama's default context is 4096 tokens**, and a primed turn exceeds it after
  the second tool call, which silently drops the system block off the front.
  `docPilot.chat.numCtx` defaults to 8192 and the eval pins its own. Any number
  measured before that fix was measured under truncation.
- **A model can advertise tools it does not have.** `detectCapabilities()` reads
  the model's own metadata and routes a model without them onto the text fallback
  transport; `think` must not be sent to a model that does not support it.
- **MMR diversity was costing retrieval quality.** λ 0.7 → 0.9 → 1.0 improved
  retrieval F1 monotonically with no gate regression, because the diversity
  penalty was evicting further sections *of the correct page*. Shipped together
  with the rest of lever 1: `RRF_K` 60 → 5, `W_DENSE_RRF` 1.2 → 1.0,
  `MMR_LAMBDA` 0.9 → 1.0, `CANDIDATES` 20 → 30. At λ 1.0 `mmr()` is a
  dense-cosine re-rank of the fused pool, not a diversity filter — which is why
  the RRF weights had to come level. **Do not re-derive this sweep.**
- **Retrieval F1 is a precision-capped instrument.** It can sit near 0.5 while
  recall@8 is 0.96: the gold pages are being found. Read recall and MRR first.
- **The answer bench needs three runs, not one.** Every answer-side metric sat
  inside its own config's run-to-run spread across 3×44 answers; the single-run
  "win" was a favourable draw. What three runs establish is the negative —
  nothing moves outside noise in either direction — which is what the 2-point
  rule actually asks for.
- **Score the FILTERED citation list, not the model's raw one.** `harness.js`
  drops citations outside the emitted set and reports them as `phantom`, so
  `hallucinatedCitationRate` is structurally 0. Any new instrument that scores raw
  output invents a hallucination rate production cannot produce.
- **`citationPrecision` measures citation COUNT at |gold| = 1.** It divides by how
  many citations the answerer chose, so the same retrieval scores 1.00 or 0.33
  depending on terseness. Read `citationRecall` beside it, always.
- **Heading ancestors in the chunk context line do NOT help — measured and
  reverted.** `chunker.js` builds its breadcrumb from `h1` alone. Adding the
  ancestor cost recall@8 0.966 → 0.920 and MRR 0.629 → 0.600 and did not move the
  record it was written for. An ancestor like *Methods* or *Properties* dilutes a
  level-3 chunk's vector more than it sharpens it. **Do not re-derive this.**
- **Renaming a generic heading moved nothing.** A generic `### Parameters` is a
  real defect for a human reader; it is not a retrieval lever.
- **Frontmatter `description` is a real dense lever, and it lands on the page's
  FIRST chunk only** (`chunker.js`). On one page it moved that chunk's cosine
  0.426 → 0.556 for the reader's phrasing. It works because it says what the page
  is for in the words a question uses, while every heading on the page is phrased
  as a topic. **Read a lone low positive as a documentation bug before treating it
  as evidence about the gate** — the one that pinned tau in the case above was a
  page that never stated its allowed values in a sentence.
- **Excerpt size 1200 → 2400 does NOT improve the answer — measured, 3 runs.**
  Every metric inside its own config's run-to-run spread while the prompt grows
  14.1%.
- **Two process failures worth not repeating.** (1) Bench shard filenames are
  stable across sessions, so a fresh run silently overwrites the previous run's
  committed answers — write to a scratch directory and aggregate under a
  run-specific name. (2) Hold the answerer prompt byte-identical across runs;
  paraphrasing it between runs adds a confound the three-run rule cannot absorb.
- **The embedder is not the chat model.** `--gate-only`, `calibrate`, `index` and
  `bench` are embed-only and never contact a chat model. Anthropic has no
  embeddings API, so an Anthropic key covers the answer side only and the embed
  half must point somewhere else — `embed: 'auto'` will refuse the build and say
  so.
- **A cosine threshold does not survive an embedder swap.** The chunk hash covers
  the corpus, not the vector space, so `calibrate` records `embedModel` and
  `index` refuses a calibration measured with a different one. The cosine WINDOW
  is swept beside tau for the same reason: `[0.44, 0.64]` was measured on bge-m3
  and lands inside the positive distribution on `text-embedding-3-small`.
