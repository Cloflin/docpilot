# Calibration and evaluation

The loop is `index` → `calibrate` → `lint` → `eval` → `bench`, with [`tune`](#when-eval-says-retrieval-is-the-problem) where it is retrieval that has to move — and then `index` again, because that is the step which inlines a swept lever into what a reader downloads.

## Calibrate before you ship

```bash
npx docpilot calibrate
```

The gate's verdict is scored and recorded on every turn, whatever [`guard.mode`](/reference/config#guard-mode-guard-supportminidentifiers) says — it is what chooses the lead copy over a weak result list and, on `guard.mode: 'calibrated'` or `'dense-only'`, it decides whether to call the model at all. Its thresholds are **a statement about one corpus** — how well retrieval separates questions your docs answer from questions they do not — and that separation depends on your writing, your vocabulary and your embedding model. Copying thresholds between projects is the mistake this command exists to prevent.

Until it has run, provisional values are used and every record reports `source: "provisional"`. Nothing hides it.

### What it needs

A file of labelled questions at `docpilot/calibration.jsonl`. Each record carries a **stratum** — not a yes/no, but which *kind* of question it is:

```jsonl
{"id":"c-01","question":"How do I authenticate requests?","stratum":"U"}
{"id":"c-02","question":"write me a poem about the sea","stratum":"N4"}
{"id":"c-03","question":"Does the SDK expose a retry callback?","stratum":"N2"}
{"id":"c-04","question":"and where do I put the token?","stratum":"F","prev_question":"How do I authenticate requests?"}
```

`stratum` is required and a record without one is rejected. There are eleven, and they are not interchangeable — a negative that is one word away from your product measures something a negative about borscht never will:

| | | |
|---|---|---|
| `U` | unscoped positives | must be **answered**; bounds over-refusal at 5% |
| `S` | scoped positives | must be answered under a narrowed scope; 5% |
| `F` | follow-up pairs | must be answered using `prev_question`; 8% |
| `N1` | adjacent product, absent here | must be **refused** |
| `N2` | plausible-but-absent API | must be refused |
| `N3` | off-domain technical | must be refused |
| `N4` | off-domain general (blatant) | must be refused — this is what `tauLexical` is measured on |
| `N5` | off-domain after a legitimate previous turn | must be refused |
| `N6` | a docs excerpt plus an off-domain ask | must be refused |
| `X` | scoped, with the answer outside the scope | must be refused |
| `P` | scoped, vocabulary overlap without the answer | must be refused |

Both halves matter. The positive strata bound over-refusal; the negative ones measure whether the floor does anything at all. A set of only the first kind calibrates to a threshold of zero — and a set whose negatives are all `N4` calibrates to a threshold that catches borscht and admits everything that sounds like your product.

### Where the questions come from

Write them the way readers ask, and take the ones readers actually asked: `npx docpilot feedback pull` turns what your [feedback endpoint](/reference/config#feedbackendpoint) collected into candidates with a suggested stratum and the reasoning for it. It never writes here itself — see the [CLI reference](/reference/cli#feedback).

**Read that command's bias note before promoting anything.** A vote is not a turn: a satisfied reader usually presses nothing, so production feedback is a sample of people who felt strongly, narrowed again by which verdicts you transmit. Under `feedback.send: 'down'` it is a purely negative sample, and calibrating against one moves the gate toward refusing everyone — the exact failure this stratified design exists to prevent. Promote from it deliberately, in both directions.

### What it produces

`docpilot/calibration.json`, read at build time and inlined into the index manifest, carrying the thresholds and the measured expectation ladder the gate uses. It is written only when the run satisfies its bounds; a failing run leaves the previous file untouched rather than shipping a regression.

### It sweeps the window too, not only the threshold

The dense channel maps a raw cosine onto a 0–1 score through a **window** — the cosine at which the score is 0, and the cosine at which it is 1. Where a raw cosine sits is a property of the *embedding model*, not of your corpus, so a window measured on one model is meaningless on another.

That was a real failure, not a hypothetical: a window measured on `bge-m3` landed **inside** the positive distribution of `text-embedding-3-small`. Every positive compressed toward zero, the only feasible threshold fell below the lexical weight, and the run failed outright with `no-feasible-tau` — while the English half of the probe set kept clearing the gate on lexical overlap that a Russian question cannot have.

So the window is now searched beside the threshold, over a grid, and `calibrate` prints its shortlist:

```
  window: [0.2, 0.6] from 408 candidates — 241 viable, 93 non-degenerate  (was [0.44, 0.64], provisional)
           window        tau   gatePrec  blatant  ramp
           [0.2, 0.6]  0.69   53.8%     97%     41%
           [0.3, 0.64]  0.57   53.8%     97%     66%
           [0.28, 0.68]  0.54   53.8%     97%     85%
```

Only windows that clear the hard refusal floor with a threshold above the lexical weight are considered, and among those the one that catches the most negatives wins. A window narrower than the spread it is mapping is rejected even when it scores well: it saturates every probe to 0 or 1 and turns the gate into a step function that one embedder revision flips wholesale.

`--sweep-only` re-runs the search over the cached probe scores and embeds nothing, which makes trying a different rule free.

### The embedder is recorded, and checked

`calibration.json` carries the model it was measured with, and `docpilot index` refuses to inline it onto an index built with a different one. Without that check a calibration measured on `bge-m3` inlines itself onto an OpenAI index in silence — which is what shipped, once.

That check is unconditional and stays that way. What follows is the one route across it.

### Carrying a calibration across embedders

Only two numbers in the guard describe an embedder. `denseFromCosine` maps a raw cosine affinely into 0–1, so `cosFloor` and `cosCeil` are where the model puts its cosines, while `tau`, `tauLexical` and the two weights are expressed in that normalised space and describe the **corpus**. The lexical channel is BM25 over text and has no embedder in it at all.

So a threshold can cross where a window cannot:

```bash
DOCPILOT_EMBED_MODEL=big npx docpilot index
npx docpilot calibrate --transfer=docpilot/calibration.json --out=docpilot/calibration.big.json
```

It runs against the **target** index, embeds the anchors with the target's own embedder, keeps the source's `tau` and `tauLexical`, and re-fits the window here. **A window is never inherited — only tau is.**

Three assertions license it, and each one refuses rather than warns: the corpus hash, the vocabulary hash and the resolved levers must be identical. The corpus hash is the load-bearing one and it is an equality rather than a stamp, because `manifest.hash` is taken over chunk text and **does not move with the embedder** — two indexes of one corpus embedded differently carry the same hash. Under those three, `L`, `admissible` and `n` are identical between the two runs and only the cosines moved.

The anchor set is sized by the strata's own ceilings rather than by taste: the smallest n at which `UB95` at zero failures still fits inside a bound is 52 for the 5% strata and 32 for the 8% one. A convenient-looking 120-probe draw gives `U ≈ 34`, where `UB95(0, 34) = 0.074` against a 0.05 ceiling — infeasible before a single probe is scored, so such a run would refuse every window in the grid. `--anchors` therefore takes `bounded` or `full`, not a number.

The window is fitted at the pinned `tau` under the same viability rules a normal sweep uses, with `feasible` kept as a hard filter. That filter is not decoration. Pinning `tau` removes the brake `chooseTau` normally applies, and without it the objective is a monotone reward for refusing everything: measured on this corpus, the unfiltered argmax is `[0.44, 0.84]` at 100% negative-catch and **77.5% over-refusal on `U`**. With the filter, one window of the 408 survives — and applied to the embedder that measured it, the pinned fit returns the joint search's own answer.

**What it costs, measured.** bge-m3 → `qwen3-embedding` (1024 → 4096 dimensions) over one corpus, 271 anchors of 597, then scored on all 597:

| | window | tau | decision cut at `L=0` | U | S | F | negatives caught |
|---|---|---|---|---|---|---|---|
| transferred | `[0.22, 0.62]` | 0.63 | 0.5560 | 0/169 | 1/128 | 0/60 | 40.0% |
| measured here | `[0.24, 0.64]` | 0.60 | 0.5600 | 0/169 | 2/128 | 0/60 | 40.8% |

Four thousandths of a cosine apart, no over-refusal, and 0.8 points of negative-catch given up.

**And what it is not.** The three UB95 bounds are not re-established at anchor size — `overRefusalUB95` and `gatePrecision` are written `null` for that reason, because an anchor-scale figure in those two fields rides into the manifest and every feedback record reading as the corpus's. A transferred guard is a bounded bet, not a measurement, and it is stamped `source: "transferred-window"` so every record of the session says so. Prefer a real `calibrate` wherever the endpoint allows one.

## Evaluate

```bash
npx docpilot eval
npx docpilot eval --gate-only    # retrieval and refusal only; no model calls
npx docpilot eval --level=low    # a declared pool, not the head of the file
```

`--gate-only` is the fast loop. It measures recall, MRR and gate behaviour without spending a token, which is what you want while tuning chunking or thresholds.

`--level` is the other axis. It chooses *which* questions the run is about — see [levels](#how-much-of-the-set-to-run) below.

### The golden set

`docpilot/golden.jsonl`, one JSON object per line:

```jsonl
{"id":"q-01","level":"medium","kind":"guide","expect":"answer",
 "question":"How do I connect the editor to my app?",
 "gold_chunks":["getting-started/connecting#"],
 "gold_answer":"Connecting takes three steps. First …"}
{"id":"n-01","level":"low","expect":"refuse:no-evidence","gold_chunks":[],
 "question":"What is the capital of France?"}
```

`npx docpilot lint` is the authority on this schema — if this page and the linter ever disagree, the linter is right:

| field | required | what `lint` checks |
|---|---|---|
| `id` | yes | unique in the file; two records sharing one is an error |
| `question` | yes | not empty |
| `expect` | yes | exactly `answer`, `refuse:no-evidence` or `refuse:out-of-scope`. `refuse:not-answerable` is an **observed** outcome and is rejected here: it depends on what the model did, so authoring it would grade the model against itself |
| `level` | no — absent reads as `high` | one of the six tiers. An unknown value is an error; an absent one is a warning |
| `gold_chunks` | on `answer` records | every entry must resolve against the index this run measures. A match by prefix only is a warning — anchor it to a chunk id. Illegal on a `refuse:no-evidence` record, which by definition has no evidence |
| `gold_answer` | on `answer` records | 90–160 words. Outside that band is a warning, because token-F1 divides by the length of the *predicted* answer: a 25-word gold against the ~150 words the panel writes caps the metric near 0.29 whatever the model says, and you would be measuring length. On a negative record it is never scored, and lint says to drop it |
| `identifiers` | no | each one must appear in that record's own `gold_answer` — an error if not |
| `scope` | no | `{"kind":"section","paths":["/guide/scope"]}`; scope paths carry a leading slash, chunk ids do not. On a `refuse:out-of-scope` record, a gold chunk **inside** the scope is an error — that record would be expecting a refusal it should never get |
| `prev_questions` | no | the conversation before this one, oldest first: the eval asks each of those turns in order and answers the real question with all of them in history. Two or more let the composed channel reach past the immediately previous turn. A blank entry is an error, and so is carrying `prev_question` beside it — only `prev_questions` is read |
| `prev_question` | no | the one-turn legacy spelling of the same field, legal forever: makes the record a follow-up, and the eval runs that turn first and answers the real question with it in history |
| `kind` | no | a free label. `lint` prints the histogram; nothing validates it |

Anything else in a record is ignored by the linter and by the eval.

The error/warning split is not severity — it is whether the set still *measures* anything. A `gold_chunks` entry that resolves to nothing scores a flat 0 that nothing downstream can tell apart from a real regression, so it fails the lint. A gold answer twenty words short skews one metric and the report says by how much, so it warns.

A `gold_chunks` entry has three legal shapes, and they are not interchangeable:

| | |
|---|---|
| `guide/auth` | the page and everything under it, with a boundary — `guide/scope` must not swallow `guide/scoped-page` |
| `guide/auth#` | a **page-level pin**: every anchor of that page and nothing else. The shape for a question a whole page answers |
| `guide/auth#request` | one section — and the later parts of it, `#request~2`, `#request~3`, which the chunker emits when one heading is split |

**The tilde is load-bearing, and `-N` is a different claim.** `#request~2` is the second *part* of one heading; `#request-1` is the second *heading called Request* on that page, disambiguated exactly the way VitePress disambiguates it. The two used to share the `-N` spelling, and while they did, a gold entry pinned at `#request` scored a perfect hit for a retrieval of `#request-1` — a different section, which could not have carried the answer. That inflated recall@8, MRR, retrieval F1 and citation precision together, and `tune` sweeps against exactly that objective. `~` cannot come out of a heading slug, so nothing but a continuation part ever wears one.

Write questions the way readers ask them, not the way headings are worded. Include questions your docs **cannot** answer, marked to expect a refusal — a golden set of only answerable questions cannot detect a gate that has stopped refusing anything.

Ask in every language your readers use. A gate tuned on one language can refuse another outright: an English corpus offers no lexical overlap to a question in Russian, so that question rests entirely on the dense channel and has no margin to spare. This is exactly the gap `guard.mode: 'off'` ships with by default rather than pretending a threshold can be measured for every language a site's readers might type in — build a probe set per language before turning `'calibrated'` or `'dense-only'` on, or stay on the default and let the model decide instead.

### How much of the set to run

One file, six nested pools. A record's `level` is the tier at which it **enters** the pool, and the pools are **cumulative** — `--level=medium` runs low *and* medium:

```bash
npx docpilot eval --level=low
npx docpilot tune --level=medium
npx docpilot bench emit --config=base --level=low
```

| tier | what enters here |
|---|---|
| `low` | the smoke pool. A handful of lookups **and at least one negative** — a pool that can only pass is not a smoke test, it measures how often the model answers rather than how often it is right to |
| `medium` | the common how-tos, plus the first scoped record and the first follow-up |
| `high` | full breadth: roughly the set this package was developed against |
| `xhigh` | paraphrases, and the first chains deep enough to lose their subject: two prior questions, where the antecedent may be both of them rather than the last one |
| `max` | the long tail, and the longest chains a prompt still carries whole — three prior questions, which is the deepest history that goes out as verbatim pairs |
| `ultra` | paraphrase sweeps, adversarial negatives, follow-ups at scale, and any chain past three priors, where the oldest turns are condensed into one line instead of sent as pairs |

Two defaults, and they are what let tiers arrive on a golden file that already exists without moving a single number:

- **a record with no `level` reads as `high`**, because `high` is *defined* as roughly the set that already exists. A file written before tiers scores identically under `--level=high` and under no flag at all, so nobody has to backfill sixty records to keep their history;
- **a run with no `--level` is `ultra`** — the whole file, which is exactly what every run did before.

Because every larger pool contains every smaller one, a regression at `--level=low` is a regression in the full set too. That is the property `--limit=N` never had: a limit is the head of the file, so the quick run and the full run disagree about which questions matter and neither number explains the other. The two still compose — the level chooses the population, `--limit` then truncates it — but only the level is a claim about *what was measured*.

A tier is written once, at authoring time. Re-tiering a question downward — `high` to `low` — changes what a smoke run measures without changing a single answer, and the two sides of that commit stop being comparable. **The set grows at the top.**

A record whose `level` is none of the six falls into *every* pool, the smoke one included, rather than being dropped: `ultra` has to mean everything, and a typo may never silently delete a question from a run. Turning it into an error is `lint`'s job.

### Lint it first

```bash
npx docpilot lint
```

A `gold_chunks` entry naming a page that has since been renamed never matches, so its record reports a flat 0 — which reads as a retrieval regression and is actually a stale golden set. Run this after every `index`.

Run it after upgrading this package, too. A change to the chunker repacks pages into a different number of parts, and a gold entry pinned at a continuation anchor — `#anchor~3` — then names a part that no longer exists. Nothing else in the pipeline can tell that apart from retrieval having got worse.

This release renames them all at once. Continuation parts moved from `-N` to `~N`, so **every** gold entry pinned at one matches nothing until it is repointed — a one-character edit, once, per entry. Lint is how they are found: it names each id and says so outright.

```
  1 error(s):
    ! q-14: gold_chunks entry "api/users#parameters-2" matches nothing in index 9f2c… — repoint it, or rebuild with npx docpilot index
```

Its summary carries a `by depth` and a `by level` line:

```
  by depth         {"0":52,"1":6,"2":2}
  by level         low 10 (+10) · medium 25 (+15) · high 60 (+35) · ultra 60
```

The bare number is the **pool** — what `--level=medium` actually scores, and the only number two reports may be compared on. `(+n)` is what that tier contributed by itself, which is what you need when deciding where the next twenty questions belong.

`by depth` is how many prior questions each record carries, and it prints on every run — a set with no follow-ups reads `{"0":60}`. The `follow-up` count above it cannot tell one hop from two, and only a record with two priors reaches the second antecedent: a set believed to hold chains and holding none reports the old behaviour under the new records' names, and the run that would show it costs an eval.

### Reading a report

Reports land in `docpilot/reports/`, named by index hash, model and prompt hash. Two reports built from different instructions are **not comparable** and the tool says so rather than diffing them: change the prompt and the numbers move for reasons that have nothing to do with what you were measuring.

`docPilot.product`, `prompt.override` and `prompt.extend` all move the prompt hash, because all three change what is sent. Setting `product` for the first time therefore makes every earlier report incomparable — once, deliberately, and the report says so.

#### A level is a different population, not a smaller sample

Two runs at different tiers are never diffed. A `--level=low` run is ten smoke lookups and its answer-F1 sits wherever ten easy questions put it; read against the full set, every delta in the table would be the difference between two question lists, attributed to whatever was changed in between — and none of it would be real. So the report tool partitions its history by level rather than labelling the comparison — there would be nothing in such a table worth reading. It looks for a previous report of **the same pool**, and by the same rule a run at another tier is not treated as a row of this matrix at all.

The consequence to expect: **the first run at a new tier has no baseline**, and its report has no "changes since the previous run" section. That is correct, and it looks exactly like the first run against a new index.

A narrowed run is filed apart — `-lvl-<level>` in the report name — so a smoke run cannot overwrite the full report it was meant to be read against. A run with no flag keeps the name it has always had, and a report written before levels existed reads as `ultra`, which is what it measured; history keeps pairing across the upgrade.

## When eval says retrieval is the problem

```bash
npx docpilot tune
npx docpilot tune --level=medium            # a smaller pool — report only
npx docpilot tune --lambda=0.5:1.0:0.05     # the MMR relevance/diversity knob
npx docpilot tune --k=4:12                  # how many excerpts prime the turn
npx docpilot tune --dry                     # write the report, not the answer
```

`eval` tells you *whether* retrieval is what failed — a low recall@8, the gold page nowhere in the ranked list. `tune` is what answers it. It sweeps `MMR_LAMBDA` × `GATE_K` over the golden set and scores every cell with the same deterministic retrieval metrics `eval` uses: 11 λ × 9 k = 99 cells by default.

Both axes are written `lo:hi:step`, and a bare `lo` pins one so the other can be swept alone — the grid is an argument because a corpus whose plateau sits somewhere else needs one, not a patch. A malformed range is refused rather than defaulted: a silent fallback would sweep a grid nobody asked for and write its winner into a file that ends up inlined in a bundle. `--k` is capped at the size of the fused pool the re-rank selects from, because above that every k picks the whole pool and measures the identical cell.

**It needs the embed endpoint, and only for the first stage.** Each record is embedded once — plus once more per follow-up, for the composed channel — and then the whole grid runs in process with nothing re-embedded. No chat model is contacted and there is no LLM judge, for the reason `calibrate` gives: a constant chosen by a generator moves when the generator does.

**Neither lever can change a refusal**, which is what makes ninety-nine cells cost one embedding pass. The gate decides on the best cosine in the whole scope and on the top three lexical hits; λ and `GATE_K` reach only the re-rank and the slice — *which* excerpts are handed over once the turn has already been admitted. So pure retrieval metrics are sufficient here, and no cell can buy F1 by refusing the questions it is bad at. That is a property of today's code rather than a law, so every cell measures the over-refusal count anyway and the report prints it as a sanity row.

The winner is argmax mean retrieval F1, then recall@8, then MRR, then **proximity to the levers already in force**. The last tie-break is not cosmetic: a tie decided by float noise would churn a committed file, a rebuilt index and a redeployed bundle for a difference of zero. When the sweep chooses the values already running, it writes them down anyway — a lever that survives only as a literal inside this package moves your corpus the next time the package changes it, without anybody deciding to.

`docpilot/tuning.report.md` is written every run: the grid, the chosen cell against the baseline, and the ten records that moved most in each direction — which is where a headline of +0.02 turns out to be one record going 0 → 1 and fifty-nine going nowhere. `docpilot/tuning.json` is written too, unless `--dry` — and unless the pool was narrowed, which is the next section.

### A narrowed sweep writes no answer, only a report

`--level=<tier>` and `--limit=N` both narrow the pool, and both make the run **report-only**. The report is filed apart — `tuning-lvl-medium.report.md` for a tier, `tuning-n20.report.md` for a limit, `tuning-lvl-low-n5.report.md` for both — and `tuning.json` is left exactly as it was.

The asymmetry is not fussiness about names, it is what the two artefacts are for. A report is reading material: a narrowed one is genuinely useful, it just must not overwrite the full-set one, and a suffix is enough. `tuning.json` has no other purpose than to be read back by `docpilot index` from one fixed path and inlined into every reader's bundle — so a suffixed copy either goes unread or ships a smoke-pool answer anyway, and writing it to the fixed path *is* the defect: ten records silently replacing levers that took the whole golden file to earn, waved through by every check the build has, because the version, the index hash and the embedding model all still match.

The run says so on the way in and on the way out, and the report opens with the same sentence:

```
  narrowed pool — REPORT ONLY, docpilot/tuning.json will not be written
```

Re-run with no `--level` and no `--limit` to turn a shape into a decision.

### The answer only takes effect at the next `index`

```bash
npx docpilot tune && npx docpilot index
```

`tune` writes the file and stops. It is `docpilot index` that reads it and inlines the levers into the manifest a reader downloads, and from there both the panel and the next eval resolve them. Until you rebuild, a swept lever is a file on disk and nothing more. The build prints what it inlined, and the tier the sweep was run at:

```
  tuning: MMR_LAMBDA 0.95, GATE_K 6 — tuned 9f2c… on level ultra (60 records)
```

The build drops that file rather than trusting it when it names another index hash, another embedding model, or a format version this build does not read. A λ weighs relevance against redundancy in the embedder's own vector space, so one measured on `bge-m3` describes nothing about where `text-embedding-3-small` puts its cosines — and the corpus hash cannot catch that, because swapping the embedder leaves the text identical.

It also allows only **two** keys through, and they are the two the sweep measures: `MMR_LAMBDA` and `GATE_K`. Everything else in `tuning.json` is dropped, loudly, and the message tells the cases apart rather than lumping them in with a typo:

- `tau`, `tauLexical`, `wDense` and `wLexical` belong to [`calibrate`](#calibrate-before-you-ship) and to nothing else. **Thresholds are not levers, and levers are not thresholds.**
- the other six lever names — `RRF_K`, `W_LEXICAL_RRF`, `W_DENSE_RRF`, `CANDIDATES`, `FUSED`, `EXPAND_BELOW_TOKENS` — are real levers that this sweep never sweeps, so a value written beside them was never measured on your corpus. They resolve perfectly well at runtime, which is exactly why they need a wall here: a number sitting in a file `tune` wrote *looks* measured.

That second rule closes a hole rather than tidying a list. `tuning.json` is a file you commit and may hand-edit, and the gate builds its lexical evidence from the top three of a candidate list `CANDIDATES` sizes — so a hand-written `CANDIDATES: 1` starves the evidence and turns an answerable question into a refusal, with no threshold touched, no model called and nothing printed. A refusal verdict is `calibrate`'s to move. Anything that can move one has to hit a wall here, whatever else it does.

Precedence is resolved in one place, and reads: a `DOCPILOT_*` variable beats the tuned value, which beats what the package ships. **The environment layer is read at the moment a lever is resolved**, which is what makes `.env.local` work — every CLI entry point loads that file *after* its imports, so a layer that answered out of the module constants would be reading a snapshot taken before your file existed. It did, once: `DOCPILOT_GATE_K=9` in `.env.local` discarded its own value *and* the manifest tuning and pinned the lever to the package literal, on the one path this documentation recommends. All eight levers now take effect from `.env.local`, including the six that were silently dropped on that path.

Which is also why **`docpilot tune` refuses to run when `DOCPILOT_MMR_LAMBDA` or `DOCPILOT_GATE_K` is set.** Env correctly outranks the per-cell tuning object the sweep varies, so a pinned axis makes all ninety-nine cells measure the identical retrieval, every metric ties everywhere, and the winner is a value nothing on the grid scored — on its way into a committed file and a shipped bundle. The command names the variable and stops. `unset` it, or pin the axis on the grid instead, where a bare `lo` does the same job honestly:

```bash
npx docpilot tune --lambda=0.3
```

The one author-side override is [`topK`](/reference/config#topk) — `GATE_K` under its documented name, the number of excerpts the gate hands the model. A number there wins over the measured value, is clamped to 1–12, and marks the resolved levers `source: 'config'`, so what the panel runs on is attributable to you rather than to the sweep. Left `null`, it lets the measured value through.

On an index built with `--no-embed` there are no cosines to weigh, so what gets swept is BM25 order plus `GATE_K`. The report opens by saying so, and the run records the embedding model as `null` — which is what keeps a lexically-measured λ from ever being inlined into a vector build, while still matching the vectorless build it was measured on.

## Bench two retrieval configurations

```bash
npx docpilot bench emit --config=base
DOCPILOT_MMR_LAMBDA=0.9 npx docpilot bench emit --config=swept
npx docpilot bench emit --config=base --level=low
npx docpilot bench score --tasks=… --answers=…
```

`eval` needs an HTTP endpoint for the model. `bench` does not: retrieval, the gate and the primed observation run in-process from the production modules, and the forced final call is handed to agents through a checked-in protocol. It is how a retrieval change gets an answer-side reading with no key. Where `tune` reads a lever change on the retrieval side alone, this is what asks whether the answer got better.

**What it measures** is the difference between two configurations, scored with the same deterministic functions `eval` uses.

`--level=` takes the same six tiers, and adds a `.<level>` segment to the default task path — `docpilot/bench/base.low.tasks.jsonl` — so a smoke emit cannot quietly overwrite the full task file the last comparison was scored on. A bench and an eval at the same tier start from the same records.

**What it does not measure**, and must never be quoted as: the agent loop, tool calls, iterations per answer, latency, tokens per answer.

**Three runs, not one.** Measured over 3 × 44 answers, every answer-side metric sat inside its own configuration's run-to-run spread — the single-run "win" was a favourable draw. What three runs establish is the negative: nothing moved outside noise in either direction. That is what a two-percentage-point rule actually asks for.

## Check without building

```bash
npx docpilot doctor
```

Prints what was resolved — config file, docs directory, index location — and either confirms the panel will render or lists what is missing. Exits non-zero when not ready, which is the hook for CI.

`npx docpilot doctor --proxy` additionally prints what a production reverse proxy has to do. See [Production](/guide/production).
