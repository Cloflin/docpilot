# CLI

```bash
npx ask-ai <command>
```

Every command finds `.vitepress/config.mjs` relative to the directory you run it from and reads the `askAI` named export. There is no second place to state which model embeds or where the docs live.

## `index`

```bash
npx ask-ai index
npx ask-ai index -- --dry
```

Builds the retrieval index into `docs/public/rag/`. `--dry` chunks and reports without embedding — no network, no model — which is the loop for tuning chunking.

Idempotent: identical input produces byte-identical output.

## `calibrate`

```bash
npx ask-ai calibrate
```

Measures the refusal thresholds against `ask-ai/calibration.jsonl` and writes `ask-ai/calibration.json`. A run that cannot satisfy its bounds **fails and leaves the previous file untouched** rather than shipping a regression.

## `eval`

```bash
npx ask-ai eval
npx ask-ai eval -- --gate-only
npx ask-ai eval -- --gate-only --lexical
```

Runs `ask-ai/golden.jsonl` and writes a report to `ask-ai/reports/`.

`--gate-only` measures retrieval and refusal without calling a model — fast, free, and the right loop while tuning. `--lexical` additionally disables the dense channel, which is how you measure what the embedder is actually worth on your corpus.

Reports are named by index hash, model and prompt hash. Two reports built from different instructions are not comparable, and the tool says so instead of diffing them.

## `doctor`

```bash
npx ask-ai doctor
```

Prints what was resolved and either confirms the panel will render or lists what is missing, each with the command or variable that fixes it. **Exits non-zero when not ready** — the build never fails for these, so this is the opt-in place to gate CI.

## `init`

```bash
npx ask-ai init
```

Writes `.env.example` if absent and prints the next step. Touches nothing else, and never overwrites.
