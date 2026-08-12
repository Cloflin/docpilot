# Calibration and evaluation

## Calibrate before you ship

```bash
npx ask-ai calibrate
```

The gate decides whether to call the model at all. Its thresholds are **a statement about one corpus** — how well retrieval separates questions your docs answer from questions they do not — and that separation depends on your writing, your vocabulary and your embedding model. Copying thresholds between projects is the mistake this command exists to prevent.

Until it has run, provisional values are used and every record reports `source: "provisional"`. Nothing hides it.

### What it needs

A file of labelled questions at `ask-ai/calibration.jsonl`:

```jsonl
{"id":"c-01","question":"How do I authenticate requests?","expect":"answerable"}
{"id":"c-02","question":"write me a poem about the sea","expect":"refuse"}
{"id":"c-03","question":"how do I cook borscht","expect":"refuse"}
```

Both halves matter. Questions that must be answered bound over-refusal; questions that must be refused measure whether the floor does anything at all. A set of only the first kind calibrates to a threshold of zero.

### What it produces

`ask-ai/calibration.json`, read at build time and inlined into the index manifest, carrying the thresholds and the measured expectation ladder the gate uses. It is written only when the run satisfies its bounds; a failing run leaves the previous file untouched rather than shipping a regression.

## Evaluate

```bash
npx ask-ai eval
npx ask-ai eval -- --gate-only    # retrieval and refusal only; no model calls
```

`--gate-only` is the fast loop. It measures recall, MRR and gate behaviour without spending a token, which is what you want while tuning chunking or thresholds.

### The golden set

`ask-ai/golden.jsonl`:

```jsonl
{"id":"q-01","question":"How do I connect the editor to my app?","kind":"guide",
 "gold_chunks":["getting-started/connecting#"],
 "gold_answer":"Connecting takes three steps. First …"}
```

Write questions the way readers ask them, not the way headings are worded. Include questions your docs **cannot** answer, marked to expect a refusal — a golden set of only answerable questions cannot detect a gate that has stopped refusing anything.

Ask in every language your readers use. A gate tuned on one language can refuse another outright: an English corpus offers no lexical overlap to a question in Russian, so that question rests entirely on the dense channel and has no margin to spare.

### Reading a report

Reports land in `ask-ai/reports/`, named by index hash, model and prompt hash. Two reports built from different instructions are **not comparable** and the tool says so rather than diffing them: change the prompt and the numbers move for reasons that have nothing to do with what you were measuring.

## Check without building

```bash
npx ask-ai doctor
```

Prints what was resolved — config file, docs directory, index location — and either confirms the panel will render or lists what is missing. Exits non-zero when not ready, which is the hook for CI.
