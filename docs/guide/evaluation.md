# Calibration and evaluation

## Calibrate before you ship

```bash
npx docpilot calibrate
```

The gate decides whether to call the model at all. Its thresholds are **a statement about one corpus** — how well retrieval separates questions your docs answer from questions they do not — and that separation depends on your writing, your vocabulary and your embedding model. Copying thresholds between projects is the mistake this command exists to prevent.

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

Write them the way readers ask, and take the ones readers actually asked: `npx docpilot feedback pull` turns what your [feedback endpoint](/reference/config#feedbackendpoint-and-feedback) collected into candidates with a suggested stratum and the reasoning for it. It never writes here itself — see the [CLI reference](/reference/cli#feedback).

**Read that command's bias note before promoting anything.** A vote is not a turn: a satisfied reader usually presses nothing, so production feedback is a sample of people who felt strongly, narrowed again by which verdicts you transmit. Under `feedback.send: 'down'` it is a purely negative sample, and calibrating against one moves the gate toward refusing everyone — the exact failure this stratified design exists to prevent. Promote from it deliberately, in both directions.

### What it produces

`docpilot/calibration.json`, read at build time and inlined into the index manifest, carrying the thresholds and the measured expectation ladder the gate uses. It is written only when the run satisfies its bounds; a failing run leaves the previous file untouched rather than shipping a regression.

### It sweeps the window too, not only the threshold

The dense channel maps a raw cosine onto a 0–1 score through a **window** — the cosine at which the score is 0, and the cosine at which it is 1. Where a raw cosine sits is a property of the *embedding model*, not of your corpus, so a window measured on one model is meaningless on another.

That was a real failure, not a hypothetical: a window measured on `bge-m3` landed **inside** the positive distribution of `text-embedding-3-small`. Every positive compressed toward zero, the only feasible threshold fell below the lexical weight, and the run failed outright with `no-feasible-tau` — while the English half of the probe set kept clearing the gate on lexical overlap that a Russian question cannot have.

So the window is now searched beside the threshold, over a grid, and `calibrate` prints its shortlist:

```
  window: [0.42, 0.50] from 272 candidates — 63 viable, 41 non-degenerate
           window        tau   gatePrec  blatant  ramp
           [0.42, 0.50]  0.65   41.2%     100%     87%
```

Only windows that clear the hard refusal floor with a threshold above the lexical weight are considered, and among those the one that catches the most negatives wins. A window narrower than the spread it is mapping is rejected even when it scores well: it saturates every probe to 0 or 1 and turns the gate into a step function that one embedder revision flips wholesale.

`--sweep-only` re-runs the search over the cached probe scores and embeds nothing, which makes trying a different rule free.

### The embedder is recorded, and checked

`calibration.json` carries the model it was measured with, and `docpilot index` refuses to inline it onto an index built with a different one. Without that check a calibration measured on `bge-m3` inlines itself onto an OpenAI index in silence — which is what shipped, once.

## Evaluate

```bash
npx docpilot eval
npx docpilot eval --gate-only    # retrieval and refusal only; no model calls
```

`--gate-only` is the fast loop. It measures recall, MRR and gate behaviour without spending a token, which is what you want while tuning chunking or thresholds.

### The golden set

`docpilot/golden.jsonl`:

```jsonl
{"id":"q-01","question":"How do I connect the editor to my app?","kind":"guide",
 "gold_chunks":["getting-started/connecting#"],
 "gold_answer":"Connecting takes three steps. First …"}
```

Write questions the way readers ask them, not the way headings are worded. Include questions your docs **cannot** answer, marked to expect a refusal — a golden set of only answerable questions cannot detect a gate that has stopped refusing anything.

Ask in every language your readers use. A gate tuned on one language can refuse another outright: an English corpus offers no lexical overlap to a question in Russian, so that question rests entirely on the dense channel and has no margin to spare.

### Lint it first

```bash
npx docpilot lint
```

A `gold_chunks` entry naming a page that has since been renamed never matches, so its record reports a flat 0 — which reads as a retrieval regression and is actually a stale golden set. Run this after every `index`.

### Reading a report

Reports land in `docpilot/reports/`, named by index hash, model and prompt hash. Two reports built from different instructions are **not comparable** and the tool says so rather than diffing them: change the prompt and the numbers move for reasons that have nothing to do with what you were measuring.

`docPilot.product`, `prompt.override` and `prompt.extend` all move the prompt hash, because all three change what is sent. Setting `product` for the first time therefore makes every earlier report incomparable — once, deliberately, and the report says so.

## Bench two retrieval configurations

```bash
npx docpilot bench emit --config=base
DOCPILOT_MMR_LAMBDA=0.9 npx docpilot bench emit --config=swept
npx docpilot bench score --tasks=… --answers=…
```

`eval` needs an HTTP endpoint for the model. `bench` does not: retrieval, the gate and the primed observation run in-process from the production modules, and the forced final call is handed to agents through a checked-in protocol. It is how a retrieval change gets an answer-side reading with no key.

**What it measures** is the difference between two configurations, scored with the same deterministic functions `eval` uses.

**What it does not measure**, and must never be quoted as: the agent loop, tool calls, iterations per answer, latency, tokens per answer.

**Three runs, not one.** Measured over 3 × 44 answers, every answer-side metric sat inside its own configuration's run-to-run spread — the single-run "win" was a favourable draw. What three runs establish is the negative: nothing moved outside noise in either direction. That is what a two-percentage-point rule actually asks for.

## Check without building

```bash
npx docpilot doctor
```

Prints what was resolved — config file, docs directory, index location — and either confirms the panel will render or lists what is missing. Exits non-zero when not ready, which is the hook for CI.

`npx docpilot doctor --proxy` additionally prints what a production reverse proxy has to do. See [Production](/guide/production).
