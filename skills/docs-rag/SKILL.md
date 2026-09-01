---
name: docs-rag
description: >-
  Build, measure and tune the DocPilot RAG pipeline, and edit the documentation
  corpus so the assistant can answer from it. Use when running or reading
  `npx docpilot eval`, `calibrate`, `index`, `bench` or `tune`; when editing the
  golden or calibration set, or choosing the level a new record enters at; when
  choosing the questions the empty state offers, with or without reader data; when
  tuning retrieval (RRF weights, MMR lambda, `topK`/GATE_K, chunking); when
  cutting tokens or latency per answer; when diagnosing why a
  golden record failed or why the gate refused a real question; when proposing
  documentation edits (`<llm-only>` hints, frontmatter `description`) that make a
  page answerable; or when making the docs consumable by other people's agents
  (llms.txt, robots, per-route markdown); and when building or rebuilding the
  index, where the embedder has to be shown to the user and chosen before the
  build runs. Triggers: "build the index", "index the docs", "rebuild the index",
  "which embedder", "which provider should index this", "собери индекс",
  "переиндексируй", "run the eval", "why did q-08
  fail", "tune retrieval", "docpilot tune", "tune retrieval levers", "run the
  smoke level", "grow the golden set", "calibrate the gate", "fewer tokens per
  answer", "the assistant can't answer X", "improve the docs for the AI",
  "llms.txt", "choose the openers", "what should the suggestion chips say", "the
  empty state questions", "propose openers from the corpus", "opener candidates",
  "cold start openers".
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

`docpilot index` chunks `<docsDir>/**/*.{md,mdx}` — plus `<importDir>`, the
OpenAPI specs `docPilot.openapi` names, and, with `--html-dir`, a directory of
already-built HTML — into the index directory (manifest, shards, int8 vectors, df; no vectors
when the site declared `embed: false`). It then resolves
`suggestions.questions` against the index it just built and ships the result as
`openers.<hash>.json`, so the panel's openers cost no embedding request.
In the
browser, `retriever.js` fuses BM25 and dense retrieval — on the thresholds
`calibrate` measured and the levers `tune` measured, both of which ride in the
manifest — and its gate decides, before any model call, whether there is evidence
to answer at all. `harness.js`
then runs a short tool loop over the retriever and nothing else. `docpilot eval`
drives exactly those production modules; nothing is stubbed.

## Modes

### `index` — choose the embedder, then build

**Never run `npx docpilot index` without first showing the user what it is about
to build with.** The choice was always being made and never being said: the
provider chain resolves silently from `.env.local`, so a project with
`OPENAI_API_KEY` in it built with OpenAI and nobody was told, and a project with
nothing anywhere fell through to a provider it had no key for and found out on
the first chunk. Ask first.

```bash
npx docpilot doctor --embed        # the list — no metered request, localhost only
```

It prints every embedder this project could build with, one numbered row each,
with the source of the row underneath and the exact command that picks it:

* what `docPilot.embed` in the config file names — **first, and the default**
* every provider the environment carries a key for, named by the variable
  (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …) so the user can check their own file
* a local Ollama, when one answered `/api/tags` — the answer when the config
  names nothing and the environment carries nothing
* `embed: false`, lexical-only, which needs neither

A row marked `✗ cannot run here` has no key in this environment. Say so rather
than proposing it: the shipped fallback appears there whether or not a key for it
exists, and running it spends a build to reach a 401.

**Show the list, ask which one, then run the command that row printed.** It
carries `--embed-model` and, for a local server, `--embed-base-url` — an address
dropped from that line silently sends the build to `localhost` instead of the
host the environment named.

```bash
npx docpilot index --embed-provider=ollama --embed-model=bge-m3 \
  --embed-base-url=http://gpu.internal:11434 \
  --index-dir=docs/public/rag-ollama-bge-m3
```

**`--index-dir` is not optional on an override, and this is the part to
understand rather than copy.** Rebuilding at the current path with an embedder
the config does not name leaves the deployed panel reading an index its own
config does not describe. Two outcomes, and neither is acceptable:

* **The config names a model.** `embedderMatchesIndex` in `session.js` compares
  it against `manifest.embedModel`, logs the mismatch and drops retrieval to
  lexical-only. Loud — and the panel is degraded until somebody reads a console.
* **The config leaves the model to a pool or to `'auto'`.** There is no name on
  the config side, so that check returns true and never fires. What remains is
  the retriever's vector-width check, which two 1024-dimensional models pass
  identically — and the panel scores queries against a foreign vector space with
  **nothing anywhere reporting it**.

`doctor --embed` prints the separate directory on every override row for that
reason, and the config block below names the model for the same one: an unnamed
model is exactly the case the runtime cannot check.

**Then propose the config edit; do not make it.** Same rule as the openers and
`llms.txt` below — this skill proposes and the user decides. The interactive form
of `index` prints the exact block; reproduce it:

```js
embed: {
  provider: 'ollama',
  model: 'bge-m3',
  baseURL: 'http://gpu.internal:11434',
},
indexDir: 'docs/public/rag-ollama-bge-m3',
```

Until that is pasted, the deployed site keeps reading the index it already has —
which is the safe outcome, not a broken one.

**What to do with no key and no local server.** Two honest answers, and they are
the user's to choose between: `ollama serve` plus `ollama pull bge-m3`, which
costs nothing and needs no account; or a provider key in `.env.local`. Do not
default to the second because it is fewer steps.

**Swapping embedder invalidates the measurements, not just the index.**
`calibrate --transfer` is the check — see "the thresholds do not transfer" below —
and the golden set's `gold_chunks` are repointed by `lint` after chunk ids move.
Running `index` with a new embedder and then reading an old report is comparing
two different pipelines.

### `eval` — run and read

```bash
npx docpilot eval --gate-only                          # retrieval + gate, seconds
npx docpilot eval --models=qwen3:8b,phi4:14b           # the matrix
npx docpilot eval --limit=3                            # short loop
npx docpilot eval --level=low                          # the smoke pool, a declared subset
npx docpilot eval --resume                             # skip models already reported
```

Reads `<evalDir>/reports/report-<indexHash>-<model>-<promptHash>.{json,md}`. The
markdown sibling carries the hard gates, the metric table, the change since the
previous run and the over-refusal backlog. State a verdict and stop: this mode
edits nothing.

**`--level=low|medium|high|xhigh|max|ultra` scores one tier of the golden set**,
and it is not `--limit`. The six are **cumulative** — `--level=medium` runs low +
medium — so every larger pool contains every smaller one and a `--level=low`
regression is a regression in the full set too. `--limit=N` is a head-slice of
whatever the author happened to write first and explains nothing. A record
carries the tier at which it **enters** the pool (`levels.js`); **a record with no
`level` reads as `high`**, because `high` is defined as roughly the set that
already existed, so a golden file that predates levels scores identically under
`--level=high` and under no flag at all. **A run with no `--level` is `ultra`**,
i.e. everything, which is what every run did before the flag existed. `--level`
is applied first and `--limit` second, so `--level=low --limit=5` is five records
of the smoke pool and not five records of the file.

**Write the `=`.** Every value-taking flag on `eval`, `bench` and `tune` now dies
with `--level takes a value: --level=low` rather than reading a bare `--level low`
as absent — which meant `ultra`, so the run scored the whole set, stamped
`meta.level: 'ultra'` and overwrote the unfiltered baseline it then diffed itself
against, in silence. The boolean flags (`--gate-only`, `--lexical`, `--resume`,
`--dry`) are unaffected: for them the bare form is the form.

Three things to check before believing a delta:

- **`incomparable`** in the report. A prompt, lever, golden-set or `num_ctx`
  change makes the comparison meaningless, and the report says which.
- **the hard gates**: `hallucinated == 0` and `scopeContainment == 1.0`. Either
  one failing fails the whole run regardless of every other number.
- **a delta exists only WITHIN one level.** A level-filtered run scores a
  different population, not a smaller sample of the same one — `--level=low` is
  ten smoke lookups and its answerF1 is not commensurable with the full set's.
  `report.js` refuses to pair a report with a previous report or a sibling at
  another level, so **the first run at a new tier has no baseline, and that is
  correct rather than a bug**: run it twice. A historical report with no
  `meta.level` reads as `ultra`, so pre-level history keeps pairing with today's
  unflagged runs. `run.js` stamps `meta.level` on every report and puts
  `-lvl-<level>` in the report filename for every level except `ultra`, whose
  name stays byte-identical to the one it has always had.

`<evalDir>/reports/latest.json` **means the last UNFILTERED run.** A narrowed run
writes `latest.<level>.json` instead. Quote a number from `latest.json` only as
the project's number, and read `meta.level` before quoting anything: an
unpartitioned `latest.json` used to end up holding a ten-question smoke score
where the full-set number was half of it, with nothing at the fixed path saying so.

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

**Which tier a new record enters at.** `level` is a claim about what the record is
FOR, not about how hard it is. The counts below are the shape of a healthy set,
not a quota — the pool a tier yields is cumulative, so each line adds to the one
above it. `npx docpilot lint` prints the histogram and the cumulative pool size
per tier, errors on a `level` that is not one of the six, and warns on a record
that has none.

- **`low` ~10 — the smoke pool.** The handful of questions whose failure means the
  system is broken: the flagship how-to, the flagship identifier, one page pin.
  **Plus at least one negative** — a pool that can only pass is not a smoke test,
  it is a liveness check, and a gate wired to `pass` unconditionally would score
  100%.
- **`medium` +15 — the common how-tos.** The questions a reader actually asks in
  the first week. **The first scoped record and the first follow-up belong here**,
  so the two harder channels — scope filtering and `composeQuery` — are exercised
  before anyone calls the pool healthy.
- **`high` +35 — full breadth.** Identifiers, both languages the site serves, a
  negative per section. Roughly the set this package was developed against, which
  is why an absent `level` reads as `high`.
- **`xhigh` +60 — paraphrase and depth.** The same answers asked in the *reader's*
  words rather than the doc's headings, and harder scoped records and longer
  follow-up chains. This is the tier that catches a corpus answering its own
  table of contents.
- **`max` +130 — the long tail.** Sections nobody thought to ask about, and
  multi-hop questions whose answer spans two pages.
- **`ultra` +250 — scale.** Paraphrase sweeps, adversarial negatives, follow-ups
  at volume. This is what a run with no `--level` scores.

**A record is never re-tiered downward.** The field is written once, at authoring
time. Moving a question from `high` to `low` changes what every smoke run
measures without changing a single answer, and the two sides of that commit stop
being comparable — as does every historical report at both tiers. The set grows
at the top.

A `level` that is none of the six is not dropped. It ranks below `low` and so
falls into **every** pool, the smoke one included: `ultra` has to mean everything,
so a typo may never delete a record from a run, and surfacing the stray in the
fastest pool is what gets it noticed. Turning it into an error is `lint`'s job,
not the filter's.

### `bench` — A/B two retrieval configs with no API key

`docpilot eval` needs an HTTP endpoint. `docpilot bench` does not: it runs the
retrieval half in-process and hands the **forced final call** to subagents, which
is how a retrieval change gets an answer-side reading when there is no key and no
local model worth waiting three hours for.

```bash
npx docpilot bench emit  --config=base
npx docpilot bench emit  --config=base --level=low     # one tier, same six as eval
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

### `tune` — sweep the levers, then propose edits

Input: the latest report plus recorded reader feedback. Output: a list of edits,
each naming **the file, the concrete change, and the expected effect on a named
metric**. An edit with no metric attached does not reach the output.

Levers, in increasing order of risk:

1. RRF weights and MMR λ — `retriever.js`
2. `topK` (= `GATE_K`), chunk size, the merge rule, `MAX_CHUNK_CHARS`
3. the system prompt blocks — `prompt.js`
4. the tool descriptions
5. `maxIterations` and the degradation rules

**Two of those constants are no longer proposed by eye — `npx docpilot tune`
measures them.** `MMR_LAMBDA` and `GATE_K`, the latter being the config key `topK`
under its internal name, are swept against the golden set as a grid:

```bash
npx docpilot tune                          # λ 0.5:1.0:0.05 × k 4:12, the default grid
npx docpilot tune --level=medium           # a smaller pool — REPORT ONLY
npx docpilot tune --lambda=0.2:0.8:0.02    # a corpus whose plateau sits elsewhere
npx docpilot tune --k=5                    # a bare lo pins the axis to one value
npx docpilot tune --dry                    # write the report, leave tuning.json alone
npx docpilot tune --limit=20               # head-slice the pool — REPORT ONLY too
```

**`--level` and `--limit` both narrow the pool, and a narrowed sweep writes NO
`tuning.json`.** It writes its report under a name of its own —
`tuning-lvl-medium.report.md`, `tuning-n20.report.md`, `tuning-lvl-low-n5.report.md`
— and leaves the levers in force untouched. The asymmetry against `eval` and
`bench emit`, which merely suffix their outputs, is deliberate: a report is
reading material, so a suffix is enough, while `tuning.json` exists **only** to be
read back by `docpilot index` from one fixed path and inlined into every reader's
bundle. A suffixed copy is either never read or ships a smoke-pool answer anyway.
**So: to change the levers, sweep the whole pool.** Read a narrowed grid as a
shape, never as a decision.

The loop, and every step of it is required:

1. **sweep** — `npx docpilot tune`.
2. **read `<evalDir>/tuning.report.md`** — written on every run, `--dry` included,
   under the narrowed name above when the pool was narrowed.
   The grid table, the chosen-vs-baseline deltas, the gate-invariance sanity row
   and the ten records that moved most in each direction. **Read the movers before
   the headline**: +0.02 mean F1 over 60 records is one record going 0 → 1 as often
   as it is a broad shift, and those two have opposite readings — the first is a
   gold-chunk authoring artefact, the second is a lever.
3. **`<evalDir>/tuning.json`** — written unless `--dry`, and unless the pool was
   narrowed by `--level` or `--limit`. It is written even when the sweep chose the
   levers already in force, and that is deliberate: an unwritten winner survives
   only as a literal in `retriever.js`, and the next release that moves that
   literal would move this corpus without anyone deciding to. It carries
   `MMR_LAMBDA` and `GATE_K` and nothing else — see the binding rules.
4. **`npx docpilot index`** — the step that actually delivers it. `tuningFor()`
   validates the file against this build (version, index hash, embed model) and
   inlines the levers into `manifest.tuning`. **Until index runs, a swept lever is
   a file on disk and nothing more.**
5. **`npx docpilot eval`** to confirm, at the same level as the baseline.

**It costs embeddings and nothing else.** Stage A embeds once per record (plus one
per follow-up, for the composed channel); stage B sweeps the whole grid in process
with nothing re-embedded. No chat model is contacted, there is no LLM judge, and
the selection is argmax mean retrieval F1 → recall@8 → MRR → proximity to the
levers already in force.

**The gate is invariant under this grid, so a sweep cannot change a refusal
decision.** `evaluate()` takes `D` from `dense.scopedMax` (the best cosine over the
whole scope) and `L` from `lexIds.slice(0, 3)`; λ and `GATE_K` reach only `mmr()`
and `rank({k})`, i.e. which excerpts are handed over once the turn is already
admitted. That is why pure retrieval metrics are sufficient here and why no cell
can buy F1 by refusing the questions it is bad at. It is a property of today's
code rather than a law, so every cell measures the over-refusal count anyway and
the report prints it as a sanity row — **if that row says MOVED, do not inline the
result; find what made `evaluate()` depend on λ or `GATE_K` first.**

Two bounds the command enforces. `--k`'s ceiling is the resolved `FUSED` (12),
because a k above the fused pool selects the whole pool and every larger k
measures the identical cell. And a `GATE_K` above 8 is legal but partial: it
widens the excerpts that PRIME the turn, which is what retrieval F1 is measured
on, while a `search_docs` call the model makes for itself stays clamped 1..8 by
`search()`.

**The six levers `tune` does NOT own are still swept by hand**, and `--gate-only`
is that loop — it measures a candidate in seconds:

```bash
DOCPILOT_RRF_K=3 DOCPILOT_FUSED=8 npx docpilot eval --gate-only
```

Available: `DOCPILOT_RRF_K`, `DOCPILOT_W_LEXICAL_RRF`, `DOCPILOT_W_DENSE_RRF`,
`DOCPILOT_CANDIDATES`, `DOCPILOT_FUSED`, `DOCPILOT_EXPAND_BELOW_TOKENS` — plus
`DOCPILOT_MMR_LAMBDA` and `DOCPILOT_GATE_K`, which override the swept values for
an exploratory run and are the reason the precedence has to be stated:

**env > `tuning.json` (via `manifest.tuning`) > the shipped defaults, and env
never ships.** `resolveLevers()` in `retriever.js` is the only implementation of
that rule; `run.js`, `calibrate.js` and `tune.js` all call it rather than
re-deriving it, so a report cannot name a value the retrieval did not use. "Set"
means parses as a finite number: `DOCPILOT_MMR_LAMBDA=high` is not a value, and it
leaves the env layer out of the precedence rather than pinning the corpus to our
default. A `DOCPILOT_*` variable is a sweep running on somebody's shell and cannot
ship: `globalThis.process` is undefined in the browser, where the rule collapses
to `tuning ?? constant`, and `session.js` deliberately does not read the
environment at all.

**The env layer is read AT CALL TIME and resolves to the value it read, which is
what makes `.env.local` work.** Every CLI entry point loads `.env.local` into
`process.env` AFTER the module graph is imported — `tune.js` at its own top level,
`run.js` and `calibrate.js` through `cli-context` — and `.env.local` is where every
DocPilot doc tells a consumer to put these keys. A layer answering out of the
module constants was therefore reading a fold taken before the file was loaded:
`DOCPILOT_GATE_K=9` in `.env.local` counted as set, resolved to the package
literal 5, and discarded its own value AND `manifest.tuning` on the way past. All
eight variables now take effect from `.env.local`; six of them never did on that
path. Put them in `.env.local` or export them in the shell — both work now, and
they are the same layer.

**`npx docpilot tune` REFUSES to run when `DOCPILOT_MMR_LAMBDA` or
`DOCPILOT_GATE_K` is set** — from the shell or from `.env.local`, which it loads
before it checks. This is not a restatement of the bug above; it survives the fix
and follows from it. Env correctly outranks the per-cell tuning object the sweep
varies, so a pinned axis makes every one of the ~99 cells measure the identical
retrieval, all three metrics tie everywhere, `chooseCell` falls through to its
proximity tie-break, and the winner is a value **nothing on the grid scored** — then
written to `tuning.json` and inlined into every reader's bundle, which is a shell
variable shipping. The command names the variable and stops rather than unsetting
it for you. Remedy: `unset` it, or pin the axis where a pin is legible —
`--lambda=0.3`, `--k=5`. The other six are reported, not refused: `DOCPILOT_FUSED=20`
is a real thing to measure, and the note exists because `tuning.json` will record
only λ and `GATE_K`, so the answer was measured under a pool the file never mentions.

### `faq` — choose the openers, and freeze them

The empty state offers three to five questions. They are the most-asked
questions on the site by construction — every reader who opens the panel without
one of their own sees them — and `docpilot index` resolves them ahead of time, so
a click costs no embedding request (engine-specs/009, ui-specs/013).

**Two ways in, and which one you have depends on whether anyone has used the
panel yet.** Both end at the same place: you edit, then `index` decides.

#### Path A — the cold start, with no reader data

```bash
node .claude/skills/docs-rag/scripts/opener-candidates.js
#   ...you EDIT, then paste into docPilot.suggestions.questions...
npx docpilot index                                # resolve them, and report
```

`feedback faq` below needs an export of real votes, which a site that has not
shipped does not have. This reads the **index** instead — the questions the
corpus already phrases, and the pages it has the text to answer — and it makes
**no request at all**.

**It proposes and never writes**, on the same terms as `feedback faq` and with
more force: that command has a biased sample, this one has no sample. A corpus
knows what it can ANSWER; it does not know what anybody wants to ask.

**Its `✓` is not a pass and its `✗` is not a refusal.** The script assembles the
lexical twin of your index — `manifest.vectors` nulled, which `assembleIndex`
reads as "no dense channel" — and runs the real retriever and the real gate over
it, so the score is `G = L` against `guard.tauLexical`. The panel's gate is
hybrid against `guard.tau`, and `assertWeights` guarantees `wLexical < tau`, so
the lexical channel can never clear it alone. Read a `✓` as a floor: the corpus
contains the question's rare wording. Read a `✗` as a warning. **The verdict is
the `openers` block of `npx docpilot index`.**

**The edit pass is mandatory, and the `template` rows are why.** Three tiers come
out, in descending order of "a human already wrote this": a `<FaqAccordion>`
question the author typed (`kind: 'faq'`), a heading that is already a question,
and — for everything else — the one template the panel already ships for
follow-ups, `Tell me about {heading}`, over a page title. That third tier emits a
**subject, not a sentence**. `followUps` gets away with the same wording because
the reader is mid-conversation and just saw the page; an empty state is a first
impression and does not. A corpus with FAQ islands should run `--tiers=faq`
first and will need no rewriting at all.

**One candidate per section, and the arithmetic is worse at five than at sixty.**
`sample-chunks.js` records a corpus where one section held 916 of 1191 chunks, so
proportional sampling would have made 77% of a golden set about one part of the
site. Five chips have no room for that at all — a pure score ranking would put
four of them in the largest section, and the empty state would advertise a
quarter of the docs. `--per-section=` raises the allowance where a site is too
narrow to fill five under it.

**A candidate that would swallow a probe is rejected with the probe named.** The
script cross-scores every proposal against `docpilot/calibration.jsonl` with the
same `similarity()` at the same `matchTau` that `opener-collisions.js` uses, so
the two agree by construction and you do not have to run the second one to
discover the first proposed a trap.

#### Path B — with reader data

```bash
npx docpilot feedback faq --from ./export.jsonl   # what readers actually ask
#   ...you edit docPilot.suggestions.questions...
npx docpilot index                                # resolve them, and report
```

**`feedback faq` proposes and never writes.** It clusters candidates with the
same symmetric coverage scorer the panel matches a paraphrase with, at this
site's own `matchTau`, so a cluster is exactly what one opener would catch at
runtime. It drops questions asked once, questions the corpus refused, and
questions readers complained about — that last one because promoting a
`downRate` of a third would put the site's weakest answer where every reader's
first click lands. Read `reports/faq-latest.md` before touching the config: the
sample is voted turns, not questions, and on a `feedback.send: 'down'` project it
is complaints only.

**Read the `openers` block `index` prints.** It is the only place a refused
opener is visible before a reader finds it:

```
  openers          5 question(s) · configHash 3f1c9a02 · 1 embedded, 4 cached
    ✓ 0.71  "How do I get started?"  4 chunk(s)  answer 412 B
    ✓ 0.68  "How do I build a custom extension?"  6 chunk(s)  answer 508 B
    ✓ 0.63  "What does the assistant refuse to answer?"  3 chunk(s)  answer 331 B
    ✓ 0.59  "How do I change the panel's colours?"  5 chunk(s)  answer 402 B
    ✗ 0.22  "How do I authenticate requests?"  0 chunk(s)
    REFUSED  "How do I authenticate requests?" scores 0.22 against tau 0.57.
```

A `REFUSED` line is a **documentation** defect, not a threshold defect. The fix
is `corpus` mode — write the page, or rewrite the question to name what the
corpus calls the thing — and never lowering `tau`, which governs every reader's
every question in order to rescue one chip.

A `COLLIDES` line means two openers score at or above `matchTau` against each
other, so a reader's paraphrase could land on either and the panel will refuse
the tie rather than guess. Rename one, or set `suggestions.matchTau: false`.

**When to turn `suggestions.answers` on.** It bakes the answer as well as the
evidence, so a matching question costs nothing at all — but it spends one model
request per opener whenever the corpus hash moves, against the same allowance
your readers draw on. Worth it on a stable corpus or a funded key; not worth it
on a docs site rebuilt several times an afternoon against a free tier. Answers
are cached on `(question, index hash, prompt hash, model)`, so a rebuild that
moves none of the four spends nothing.

**`matchTau` is not a calibrated threshold, but it is measured.** It is a config
constant — `calibrate` never touches it and `tuning.json` never carries it — and
the measurement behind it is a pure lexical sweep that costs nothing:

```bash
node .claude/skills/docs-rag/scripts/opener-collisions.js
```

It scores every probe in `calibration.jsonl` against every configured opener. A
probe is not an opener, so **every score it produces is a false positive waiting
to happen**, and the highest of them is the floor `matchTau` has to sit above.

Measured on this project's corpus, 597 probes × 3 openers = 1,791 pairs:

```
    0.500  "What claims will this documentation not make?"
           would match "What is this documentation about?"     [s-06/S]
    0.500  "Is that requests or tokens?"
           would match "How do I authenticate requests?"       [f-16/F]
    0.333  "Is the limit on requests or on tokens?"            [s-27/S]

    threshold   probes wrongly captured
    0.500              2
    0.600              0
    0.650              0   <- shipped default
```

Nothing reaches 0.6. A real paraphrase covering two of three key words scores
0.667, and the subset trap `"gate"` against `"How do I configure the refusal
gate?"` scores 0.333 — one-directional coverage would have scored it 1.000, which
is why the measure is symmetric. **0.65 is the shipped default because it sits
above every measured false positive and below the paraphrases the feature exists
to catch.**

Re-run it after a corpus change or an opener rewrite. The numbers above are this
corpus and these three questions; yours are yours. Both proposers emit the same
paste-able block and score with the same `similarity()` at the same `matchTau`,
so a site with reader data can run both and read the union.

**Three to five, and five is the ceiling.** The panel shows what you configure;
`resolveSuggestions` drops and names anything past `SUGGESTION_LIMIT`. The
built-in fallback is still three, so a site that configures none pays what it
always paid. **Five is not free**: five embedding requests plus, with
`suggestions.answers` on, five model requests — and they are spent again whenever
the corpus hash moves *or you edit one opener*, because the bundle is
fingerprinted over the whole list rather than per question. On a fifty-a-day free
tier that is ten. Four good ones beat five where the fifth is a `template` row you
did not rewrite.

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
   compare against the same level's baseline → **revert anything that regresses a
   metric by more than 2 percentage points.**

**The build's chunker warnings are corpus diagnoses, which is this mode's whole
job.** Read them off `npx docpilot index`, not off a report.

What the chunker guarantees, and no more than this. A section over
`MAX_CHUNK_CHARS` (8000, `normalise.js`) is split at the coarsest boundary that
fits: between whole blocks first — a block being a paragraph, a fenced code block
or a GFM table — then inside the one block that is over the ceiling on its own,
between rows in a table and between lines in a fence or a paragraph, and at a
code-point boundary only when a single line or row is over the limit by itself.
**Every part of a split fence is closed and the next reopened with the same fence
character, run length, indent and info string**, so the language survives the cut
and no chunk holds code outside a fence. **Every part of a split table re-emits
the header and delimiter rows**, because a continuation without them is a grid of
values whose columns are unnamed — to the embedder and to the model that later
reads the chunk as context.

Which tables that applies to — `scanBlocks` in `src/build/lib/chunker.js`, and
read it rather than this paragraph if the two disagree. A table is a line whose
**next** line is a delimiter row of the same cell count. The delimiter is the
discriminator, never the header: it must hold at least one unescaped pipe,
contain nothing but pipes, colons, dashes and whitespace, and every cell must
match `:?-+:?`. Outer pipes are optional on both rows, so `a | b` and `| a | b |`
are two spellings of the same two cells, and a one-column `| a |` is a legal
header. `\|` is an escaped pipe and not a separator — `html-to-md.js` writes it
for a pipe inside a cell. The table then runs to the first blank line or the
first line with no live pipe. Consequences worth knowing before diagnosing: a
pipe line with no delimiter under it is **prose**, so a shell pipeline or a
grammar alternation is never given a header; a setext heading (`Introduction` over
`---`) is not a table, because the delimiter must contain a pipe; and a fence is
consumed first, so a table drawn inside a code sample is code. **Anything that
fails these tests is ordinary text**: it packs by line, a cut through it re-emits
no header, and no warning fires — which is the failure to suspect when a chunk
turns out to carry columns nobody named.

Three warning strings, three different diagnoses:

- **`code block split by MAX_CHUNK_CHARS in <path>`** — a single code sample is
  bigger than a chunk. The repair fired, so the index is sound; the page is not.
  A sample that long is usually a whole file pasted in, and the edit is to show
  the part the reader needs. Fires **if and only if** a fence's interior was
  actually cut.
- **`table split at row boundaries by MAX_CHUNK_CHARS in <path>`** — a table is
  bigger than a chunk. The rows were kept whole and every part got its header, so
  again nothing is broken, but **a table that big is usually a table that should
  be a section**: a reader's question is about one row, and one row's worth of
  prose under a heading of its own retrieves far better than being row 340 of a
  grid.
- **`table row longer than MAX_CHUNK_CHARS cut mid-row in <path>`** — one single
  row is over the ceiling, or the header and delimiter alone fill a chunk and
  leave no room for a row. This is the only one of the three where structure was
  genuinely lost: the row was cut at a code-point boundary like any other text.
  **That row should be prose** — a cell holding a base64 payload or three
  paragraphs of explanation is not a cell.

**The upgrade consequence.** The block-aware repack changes where boundaries fall.
Measured over the 205 markdown pages of the two corpora this package develops
against: 45 pages chunk to different text and 24 of those to a different set of
chunk ids (23 to a different number of parts). **Chunk ids are what `gold_chunks`
pins**, and a page that repacks into a different number of parts moves its
`#anchor~2`, `#anchor~3` continuation ids. So **`npx docpilot index` then
`npx docpilot lint` is required after upgrading**: lint is the step that says
which `gold_chunks` entry now matches nothing in the index, and an unrepointed
pin scores a flat 0 that reads as a retrieval regression.

**And this release renames every one of them, on every corpus.** A continuation
part is now `#anchor~2`, not `#anchor-2`. `-N` is what VitePress — and
`chunker.js`, matching it — uses to disambiguate a REPEATED HEADING: the second
`### Parameters` on a page is `#parameters-1`. One namespace with two meanings
collided outright (a page with three `## Parameters`, the first packing into five
parts, emitted `parameters-2` twice and killed the build on `duplicate chunk id`,
an id appearing nowhere in the source) and, quietly, inflated every retrieval
number: `underPath` reads a trailing suffix on anchored gold as "a continuation of
this section", so gold pinned at `api/users#parameters` scored a perfect hit for
retrieving `api/users#parameters-1` — a DIFFERENT endpoint's section, which could
not have carried the answer. recall@8, MRR, retrieval F1 and citation precision
were all credited for it, and `docpilot tune` optimises against exactly that
objective. `~` is used because `slug()` strips it, so the two namespaces are
disjoint by construction; the citation href is built from the `anchor` field,
which every part of a section shares, so no URL changes. **Every `gold_chunks`
entry pinned at a continuation part must be repointed** — `lint` names each one.

**The hard content rule.** `<llm-only>` text is indexed, can be cited, and can be
shown to a reader. It must be true, publishable documentation. **It must never
address the model or contain an instruction.** `prompt.js`'s `OBS_NOTE` guarantees
that corpus text is data and never a directive; an imperative written into
`<llm-only>` is a self-inflicted injection attempt that the host is designed to
ignore anyway.

`<llm-exclude>` is the opposite tool: wrap navigational or marketing prose that
dilutes a chunk's embedding. `normalise.js` honours both tags, so one edit moves
the published artefacts and the index together.

**Both tags cover the FAQ path too, which is where the promise used to be false.**
`normaliseMarkdown` runs `applyLlmTags` FIRST and extracts `<FaqAccordion>` Q&A
pairs from its OUTPUT, so an island wrapped in `<llm-exclude>` is excluded for
real. It used to be lifted off the raw page one line earlier: the tag pass never
saw the island, `stripVue` then deleted the tag from the prose stream so the page
looked correctly redacted, and the Q&A was already in `faq[]` on its way to an
indexed, citable `#faq-n` chunk. And `extractFaq` now scans only the UNFENCED runs
of a page, so a page documenting the component no longer turns its own fenced
`vue` sample into a real FAQ chunk — a fabricated Q&A that nothing downstream can
tell from an authored one. **If either ordering is disturbed, an
author's redaction silently stops working; keep the FAQ extraction after
`applyLlmTags` and before `stripVue`.**

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

- **Thresholds are `calibrate`'s, levers are `tune`'s, and the two do not cross.**
  - **`tau`, `tauLexical`, `wDense` and `wLexical` are not levers.** The only legal
    way to change any of them is `npx docpilot calibrate`. A hand-set
    `docPilot.guard.*` is honoured but stamps `gate.source: "config"` on every
    record of the session.
  - **`MMR_LAMBDA` and `GATE_K` — the config key `topK` — are not thresholds.** The
    measured way to change either is `npx docpilot tune`. A hand-set
    `docPilot.topK` is honoured, clamped to 1..12 and stamps `source: "config"` on
    the resolved tuning, exactly as a hand-set `tau` does.
  - The wall is built twice on purpose, and the first course is **narrower than
    "a lever"**. `tuningFor()` in `build-rag-index.js` allowlists `tuning.json` to
    `MEASURED_LEVER_NAMES` — `MMR_LAMBDA` and `GATE_K`, the two the sweep measures
    — and drops everything else **loudly**, naming it, in one of three sentences: a
    guard threshold (`tau`, `tauLexical`, `wDense`, `wLexical`) is `calibrate`'s;
    one of the other six lever names was never measured on this corpus; anything
    else is unknown. `resolveLevers()` then reads only the eight `LEVER_NAMES` out
    of whatever reaches the browser, which is the second course.
  - **Why the six are walled off, given they resolve fine at runtime.**
    `tuning.json` is a file a consumer commits and may hand-edit, and it rides
    into the manifest the guard rides in. `evaluate()` builds the gate's lexical
    evidence from `lexIds.slice(0, 3)`, and `lexIds` is `lexical(query,
    CANDIDATES)` — so a hand-written `CANDIDATES: 1` starves that evidence and
    flips an answerable question from answer to refusal without naming a
    threshold, calling a model, or printing anything. A refusal verdict is
    `calibrate`'s to move. **Keep `MEASURED_LEVER_NAMES` in step with
    `buildTuningDoc` in `eval/tune.js`: what the sweep cannot measure must not be
    inlinable.** Sweep the other six in the environment, where they cannot ship.
- **`topK` was dead until this release and is now live.** It was documented from
  the first release and read by nothing — the gate's k was the `GATE_K` literal —
  so the two defaults that existed for it (12 in `config.js`, 5 in `session.js`)
  were never in force and never agreed with each other. Both are now `null`,
  meaning "use what this corpus measured". **A site that already sets `topK` will
  see its retrieval change for the first time on upgrade**; that is the intended
  behaviour, and the number to check it against is a same-level eval.
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
  than 2 percentage points on any metric is reverted — against the same level's
  baseline.** A cross-level delta is not a comparison at all: the two runs scored
  different populations, and `report.js` refuses to pair them for that reason. If
  the tier has no baseline yet, establish one before reading the edit.

## Invariants an edit must not break

- `npm run check` (`scripts/check-docpilot.sh`) plus the design rules that moved into
  the test suite. Two bite here: `harness.js` may never contain the bare token
  `index`, and `search_docs fetch_section expand_section list_pages maxIterations
  qwen3 threshold topK` may never appear in `DocPilot.vue`.
- `systemText()` takes no addendum parameter, and the test suite asserts the
  system message is byte-identical with and without a reader instruction.
- `assertWeights` throws unless `wLexical < tau`.
- **A chunk never contains code outside an open fence, and never contains table
  rows without their header.** The ceiling wins over both, but it wins by
  repairing: `splitFence` closes and reopens, `splitTable` re-emits the header and
  delimiter. A change to `chunker.js` that cuts a fence or a table without the
  repair breaks this even when every test that counts chunks still passes.
- `chunkMarkdown` throws rather than emitting a chunk over `MAX_CHUNK_CHARS` or
  over the embed context. A splitter whose output is not exact — its repair
  counted, not just its payload — turns into a thrown build.
- No LLM judge may become a gate — `metrics.js` is pure and deterministic by
  contract. An advisory judge beside a deterministic metric is allowed; a judge
  that decides pass/fail is not. **`docpilot tune` obeys this**: it optimises
  `retrievalF1Loose`, `recallAtK` and `mrr` from `metrics.js`, contacts no chat
  model, and its report is reproducible from the same index and golden set.
- **The opener match path never embeds.** `theme/docpilot/openers.js` may not
  import `embed.js`, `llm.js`, `providers.js` or `harness.js`. "A click costs no
  embedding request" is a property of what that file can reach, not a promise
  about how it is called, and the test suite greps its import list.
- **A baked entry is only ever served for the question it was baked for.** The
  key is `normalise(q)` and the bundle carries a fingerprint of the whole
  configured list; an edited question moves the fingerprint and retires the
  bundle. Nothing may key an entry by array position.
- **The opener short-circuit introduces no second ranking path.** A match hands
  `createRetrieval` a vector through the same `queryVec` parameter a live
  embedding enters by, so `manifest.tuning`, a config `guard.tau` and the scope
  mask all still apply. Serving the baked `ids` directly would bypass all three
  and is a change to the gate, not an optimisation.
- **`gate.channel` never gains a value for this path.** `feedback/stratum.js`
  routes on it, and an unfamiliar value enters the calibration proposal as a
  stratum nobody measured. The marker is `turn.opener`.
- **A baked answer with no citations is never written.** Same floor as a live
  answer, and stronger: a live uncited answer is a turn the reader can retry, a
  baked one is a turn every reader gets until the next build.
- **Neither opener proposer edits the site config.** `docpilot feedback faq`
  never does, on the terms below; `scripts/opener-candidates.js` never does
  either, and with more force rather than less: that command has a sample biased
  towards readers who pressed a thumb, this one has no sample at all. Every
  candidate it prints is derived from the corpus, and a corpus knows what it can
  answer, not what anybody wants to ask.
- **The candidate script's gate verdict is lexical-only and is not the panel's.**
  In that mode `verdict()` returns `G = L` against `guard.tauLexical`; the shipped
  gate is `wDense·D + wLexical·L` against `guard.tau`, and `assertWeights`
  guarantees `wLexical < tau`, so lexical alone can never clear it. Never quote a
  `✓` from the script as a pass, and never drop a candidate on a `✗` alone.
  `npx docpilot index` decides.
- **`docpilot feedback faq` never edits the site config**, on the same terms as
  `pull` and `report` — and with more force, because these three strings are the
  first thing every reader sees and the sample behind them is biased.
- Every reader-facing string goes through the i18n table. A new literal in a
  component fails `i18n — the components go through the table`.
- **Only a full-pool sweep may write `tuning.json`.** `--level` or `--limit` makes
  the run report-only, checked by `isNarrowed()` in `eval/tune.js` before stage A
  embeds anything. The artefact is written from the whole golden set or not at
  all, because one fixed path is what `docpilot index` reads and inlines.
- **Only what `docpilot tune` measured may be inlined.** `MEASURED_LEVER_NAMES` in
  `build-rag-index.js` and `buildTuningDoc`'s `levers` in `eval/tune.js` are the
  same pair of names, and a change to one without the other opens the hole again:
  a lever the sweep never measured reaching a bundle through a committed file, and
  `CANDIDATES` alone can flip a gate verdict from answer to refusal.
- **A swept axis may not be env-pinned.** `assertNoPinnedAxis()` refuses the run
  when `DOCPILOT_MMR_LAMBDA` or `DOCPILOT_GATE_K` is set, because env outranks the
  per-cell tuning object and every cell would measure the same retrieval. It uses
  the exported `envPin()` rather than re-parsing the variable, so there is one
  opinion about which runs are degenerate.
- **The env layer resolves to the value it read, at call time.** `resolveLevers()`
  must never answer out of the module constants for a name the environment set:
  those constants folded `process.env` at import, `.env.local` lands after it, and
  answering from them turns a set variable into the package literal and drops
  `manifest.tuning` on the way past.
- **The skill's scripts never reach the network.** `opener-collisions.js` and
  `opener-candidates.js` may import `text.js`, `gate.js`, `openers.js`,
  `switches.js`, `store.js` and `retriever.js` out of `dist/` and nothing else —
  never `embed.js`, `llm.js`, `providers.js` or `harness.js`. The same rule the
  opener match path keeps, applied to the tooling, and for a sharper reason: both
  scripts print "0 requests" in their own headers, and a script that claims it and
  then makes one is worse than a script that never claimed it. The test suite
  greps both import lists, static and dynamic.
- **`SUGGESTION_LIMIT` has one spelling and two readers.** `DocPilot.vue` may not
  repeat the number as a literal. It did — `.slice(0, 3)` against `questionsOf`'s
  `slice(0, SUGGESTION_LIMIT)` — so the warning an author read and the list a
  reader saw were free to disagree, and nothing was watching.
- New tests go in `test/docpilot.test.js`. One file is the repo convention. The
  two invariants above live in `test/openers.test.js` beside the match-path grep
  they are siblings of.

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
  the RRF weights had to come level. **Do not re-derive this sweep by hand.** It
  is the shipped default, measured on OUR corpus; `npx docpilot tune` is how you
  measure λ on yours, and the answer belongs in `tuning.json`, not in this
  constant.
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
- **The embedder is not the chat model.** `--gate-only`, `calibrate` and `bench`
  are embed-only and never contact a chat model. **`index` is no longer among
  them**: engine-spec 009 has it resolve the empty state's openers at build time,
  which embeds each question AND has the shipped harness write its answer, so a
  build spends chat requests as well as embedding ones. That is the trade the
  spec argues — the answer is bought once at build rather than on every reader's
  first click — and it is stated here because this line said the opposite for two
  releases. `suggestions.answers: false` turns the answer half off and leaves the
  embed half; the other three commands are unchanged. Anthropic has no
  embeddings API, so an Anthropic key covers the answer side only: `embed: 'auto'`
  borrows OpenRouter's free embedding pool for the retrieval half, and `embed:
  {provider: 'anthropic'}` — naming it explicitly — is the build-stopping error.
  The third answer is `embed: false`, which retrieves lexically and asks nobody;
  read the recall numbers above before choosing it.
- **`underPath` had no page pin, and every retrieval number this package printed
  was about seven points low.** The rule above — pin a class-overview question to
  `path#` and it prefix-matches every anchor of that page — was documented and not
  implemented. `underPath` tested `id === p || startsWith(p + '#') ||
  startsWith(p + '/')`, and for `ExtensionBuilder#` the middle arm builds
  `ExtensionBuilder##`, which nothing begins with. So a page pin matched the lead
  chunk alone, and retrieving the right page and the right section of it scored a
  miss. Fourteen of the 33 distinct gold entries in the development set are page
  pins or split sections (`#anchor~2`, which `chunker.js` emits for the second
  part of one heading and which gold pinned to `#anchor` must accept — spelled
  `#anchor-2` when this was measured, which is the collision described under the
  upgrade consequence above). Measured over the 44 answerable records:
  **recall@8 0.761 → 0.830.**

  Two consequences worth carrying. First, every absolute retrieval figure recorded
  before this fix is understated — deltas measured with one matcher are still
  valid, absolutes are not. Second, the ancestor project's reports use a
  boundary-free `id.startsWith(g)`: right about page pins, wrong about siblings
  (`guide/scope` swallowing `guide/scoped-page`). Its higher numbers were read as
  generosity when they were half correctness, and **a cross-report comparison
  against that project is not a baseline** — two investigations in this repo have
  already drawn a wrong conclusion from one. Pinned by `matches the three gold
  shapes and nothing between them`.
- **THE DENSE CHANNEL CARRIES THE SYSTEM; BM25 IS THE ACCESSORY.** Measured
  `--gate-only` on the 60-record set over 1216 chunks, three configurations:

  | configuration | recall@8 | MRR | retrieval F1 | gate over-refusal |
  |---|---|---|---|---|
  | hybrid (shipped) | 0.784 | 0.473 | 0.298 | 0/44 |
  | dense only (`DOCPILOT_W_LEXICAL_RRF=0`) | 0.739 | 0.467 | 0.296 | 0/44 |
  | lexical only (`--lexical`, no embedder) | 0.534 | 0.338 | 0.208 | **11/44** |

  Turning BM25 off costs about four points of recall and refuses nothing extra.
  Turning the EMBEDDER off costs twenty-five points and **refuses a quarter of the
  answerable questions before a model is ever called** — and every one of those 11
  refusals is a Russian question against an English corpus, each with lexical
  coverage `L = 0.000`, i.e. 11 of the 12 Russian positives in the set. BM25 shares
  no term across languages, and no threshold fixes a zero: `tauLexical` is 0.21
  here and the scores were 0.000.

  **So the embedder is not a ranking refinement, it is the entire cross-language
  capability.** Split the same two runs by the language of the question and the
  whole effect separates:

  | questions | n | recall@8 hybrid → lexical | refused by the gate |
  |---|---|---|---|
  | English (corpus language) | 32 | 0.828 → 0.703 | 0/32 |
  | Russian (not the corpus language) | 12 | 0.667 → **0.083** | **11/12** |

  Which gives the decision rule. **If the corpus and the readers share a language,
  dropping the embedder costs about twelve points of recall and refuses nothing** —
  worse, and survivable. **If they do not, it ends the feature for everyone who
  does not speak the corpus.** This corpus is 99.975% non-Cyrillic — 268 Cyrillic
  characters in 1216 chunks, all of them sample strings — so a Russian question has
  nothing to match on at all.

  Quote this before anyone proposes dropping the embedder to save a provider, and
  ask which of the two rows their site is in. It is a supported configuration —
  `embed: false`, or `docpilot index --no-embed` for a look at it — with its own
  calibration path, its own doctor line and its own gate mode, so the answer to
  "can we" is yes. The question worth asking is the one above: whether every
  reader of this corpus types in the language it is written in.

  **And weigh it against what the embedder actually costs, which is almost
  nothing.** Corpus embedding is a BUILD cost paid once. The only runtime cost is
  one query embedding per turn: measured against `text-embedding-3-small`,
  **212 ms mean** (156–359 ms over four queries, the high one being connection
  setup) for a payload of about ten tokens — on the order of a dollar a year at
  ten thousand questions a day. Every alternative that replaces it with a chat
  model trades that for a request out of a 50-per-day free tier and seconds of
  latency, and — because `evaluate()` runs before any model call — makes an
  off-topic question cost a request where today it costs zero.
- **The lexical channel's tokenizer is now `terms()`, and it must stay
  asymmetric.** MiniSearch's default splitter breaks at every non-alphanumeric,
  so `window.initEditor` was two ordinary words. Indexing with `terms()` — which
  keeps `.`, `/`, `#`, `-` inside a token — lifts the LEXICAL CHANNEL ALONE from
  about recall@8 0.32 to 0.42 and MRR 0.16 to 0.27, and builds ~7× faster because
  the stop words leave the index. **The shipped pipeline gains part of that**: on
  the 60-record set, recall@8 0.7386 → 0.7841 (+4.5pp, per-record 2 wins and 0
  losses, both extension-API questions whose gold page is named by a dotted
  identifier), MRR 0.4857 → 0.4734 (−1.2pp), retrieval F1 0.3012 → 0.2975. The
  dense channel was already finding much of the rest.

  Used symmetrically it breaks the common case — a bare `initEditor` cannot reach
  the compound term, and hits fell 14 → 1 — so the index emits the compound AND
  its parts while the query side stays plain `terms()`. Pinned by `finds a
  compound identifier by either half or whole`. **Do not re-derive this, and do
  not "simplify" it to one tokenizer.**

  Two cautions. MRR pays a point, and `evaluate()` builds L's evidence out of the
  TOP 3 of this list, so rank feeds the gate as well as the answer. And an earlier
  version of this entry reported +2.3pp with "2 wins, 1 loss" and blamed a
  stop-word regression on q-26 — that loss was the broken `underPath` scoring a
  split section as a miss. There was no stop-word regression.

- **An exact-identifier RRF channel is not supported by this corpus — measured
  and reverted.** The idea: a third fused list of chunks containing the question's
  identifiers verbatim, fuzzy and prefix off. It measured a wash (recall@8
  unchanged, 1 win 1 loss; retrieval F1 −0.008) and the reason is in the golden
  set, not the weight: **only 7 of 44 positives contain anything the RAG-SPEC 5.3
  grammar calls an identifier, and six of those seven are English acronyms** —
  `API`, `HTML`, `CSS`, `SVG` — caught by the `constant` rule. Searching those
  alone promotes whatever page says "HTML" most, which is how the one loss
  happened. The grammar is right for its own job, scoring an ANSWER's identifiers
  against cited chunks; it is not a query-side selector. Sweeping the weight would
  not have found this.
- **A cosine WINDOW does not survive an embedder swap; a normalised tau does.**
  `denseFromCosine` maps a raw cosine affinely into [0,1], so `cosFloor` and
  `cosCeil` are the only two guard numbers that describe an embedder — `tau`,
  `tauLexical` and the weights are in normalised units and describe the corpus.
  The chunk hash covers the corpus, not the vector space, so `calibrate` records
  `embedModel` and `index` refuses a mismatch. **That check is unconditional and
  stays that way.** What `npx docpilot calibrate --transfer` adds is the one
  legal route across it: assert the corpus hash, the vocabulary and the levers
  are identical — under which `L`, `admissible` and `n` are bit-identical and
  only the cosines moved — then re-fit the window on the target's own cosines at
  an anchor set sized by the strata's own bounds, and keep tau. It stamps
  `source: "transferred-window"`, nulls `overRefusalUB95` and `gatePrecision`
  because no full-set sweep produced them, and refuses outright when no window
  carries the inherited tau without over-refusing. **A window is never
  inherited, only tau is.**
  Measured here bge-m3 → qwen3-embedding, 271 anchors of 597, then scored on all
  597: the transfer put the decision boundary at cosine 0.5560 against a full
  calibration's 0.5600, cost 0.8 points of negative-catch (40.0% against 40.8%)
  and no over-refusal at all (U 0/169, F 0/60, S 1/128 against 2/128). It is
  still weaker evidence than the calibration it came from — prefer a real one
  wherever the endpoint allows it.
  The window is swept beside tau in a normal run for the same underlying reason: `[0.44, 0.64]` was measured on bge-m3
  and lands inside the positive distribution on `text-embedding-3-small`.
