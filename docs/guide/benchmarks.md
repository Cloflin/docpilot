---
title: The benchmark
description: Harborline, the fictional product that every DocPilot 2.0 accuracy, speed and safety claim is measured on — what it contains, what it compares, and the commands to rerun it yourself.
---

# The benchmark

Every DocPilot 2.0 claim about accuracy, size, speed and safety comes from one script run on one corpus: `bench/run.mjs` on **Harborline**. You can rerun it. The tables on this page are the output of that run, and nothing else.

## What Harborline is

Harborline is a product that does not exist, documented as if it did: a job-queue service with a CLI, an HTTP API and SDKs. A language model has never read about it, so a correct answer can only come from retrieval over these pages. The fixture lives in `bench/harborline/`:

| path | holds |
|---|---|
| `docs/` | The documentation, one file per route of the sidebar |
| `eval/golden.jsonl` | Single-turn questions, each with gold pages and a gold answer, some of them negatives |
| `eval/chains.jsonl` | Multi-turn conversations |
| `eval/adversarial.jsonl` | The [security probes](/guide/security-probes), with a canary planted in the instruction |
| `truth/` | The source of every fact, the list of planted defects, and a reference `llms.txt`. It is never indexed and never shown to the tuning agent |
| `docpilot.config.mjs` | The settings: a local embedder and a local chat model, so a run costs no money |

The corpus carries **deliberate defects**, each tied to the questions it affects: pages with no description whose words readers do not use, sections whose answer is split across chunks, and a page that carries an injected instruction. A defect makes a metric measure something. A corpus with none would score well on every system.

## What it compares

An **arm** is an index build: how the corpus is chunked, embedded and stored. A **system** is an arm answered by one runtime of one release.

| arm | what differs |
|---|---|
| `v1.5` | The index the released 1.5 CLI builds |
| `base` | The 2.0 default index |
| `binary` | One bit per dimension (`--quantize=binary`) |
| `ctx-path` | The heading path embedded with each chunk (`DOCPILOT_EMBED_CONTEXT=path`) |
| `ctx-desc` | The heading path and the page description embedded (`path+desc`) |
| `llms` | Page notes from the reference `llms.txt` used as descriptions (`DOCPILOT_LLMS_FILE`) |
| `calibrated` | `base` with the gate's refusals on (`HARBORLINE_GUARD_MODE=calibrated`), its thresholds from `node bench/run.mjs calibrate` |

| system | arm | runtime |
|---|---|---|
| `v1.5 static` | `v1.5` | the released 1.5 CLI, from a checkout of `main` |
| `v2.0 static` | `base` | `runtime: 'browser'` |
| `v2.0 server` | `base` | `runtime: 'server'`, the 2.0 default turn: one-shot, no reasoning before the answer |
| `v2.0 server agentic` | `base` | `runtime: 'server'` with `turn.loop: 'agentic'`, the 1.x server turn |
| `v2.0 static calibrated` | `calibrated` | `runtime: 'browser'` with `guard.mode: 'calibrated'` |
| `v2.0 server calibrated` | `calibrated` | `runtime: 'server'` with `guard.mode: 'calibrated'` |

The 1.5 baseline is the code that shipped, run from a built checkout, not a model of it.

## Rerun it {#rerun}

You need Node 20 or newer, a built checkout of this repository (`npm run build`, because the report step imports from `dist/`), and [Ollama](https://ollama.com/) serving the embedding model `bge-m3` and the chat model. Run every command from the repository root.

```bash
node bench/run.mjs index        # build one index per arm
node bench/run.mjs calibrate    # fit the gate on eval/calibration.jsonl for the calibrated arm
node bench/run.mjs retrieval    # eval --gate-only per arm, dev and test splits: free, minutes
node bench/run.mjs answers      # the golden set answered, per system: hours on a local model
node bench/run.mjs security     # the adversarial probes, per system
node bench/run.mjs perf         # what a reader downloads, per index
node bench/run.mjs report       # bench/harborline/results/RESULTS.md from everything above
```

`answers` and `security` take a system name to run one system: `node bench/run.mjs answers "v2.0 server"`.

| variable | default | what it sets |
|---|---|---|
| `OLLAMA_BASE_URL` | the local Ollama | Where the embedder and the chat model are served |
| `HARBORLINE_CHAT_MODEL` | `qwen3:8b` | The chat model that answers |
| `HARBORLINE_EMBED_MODEL` | `bge-m3` | The embedder |
| `BENCH_LEVEL` | `high` | Which tier of the golden set the answer run scores — see [`--level=`](/reference/cli#level) |
| `BASELINE_ROOT` | unset | A built checkout of 1.5. Without it the `v1.5` arm and system are skipped |

Each step saves the log and the eval report in `bench/harborline/results/`. `report` reads those reports and writes `RESULTS.md` and `results.json`. Every number in it comes from a saved report. The paired intervals are computed from the reports' own rows with the bootstrap that [`docpilot improve compare`](/reference/cli#improve) uses.

To run one measurement by hand, work from the fixture directory. The CLI resolves `docsDir`, `evalDir` and `indexDir` against the directory it starts in:

```bash
cd bench/harborline
node ../../bin/docpilot.js index --yes
node ../../bin/docpilot.js eval --gate-only --split=test --quiet
node ../../bin/docpilot.js eval --set=adversarial --runtime=server --quiet
```

## How to read the tables

- **Retrieval** is scored `--gate-only` on the test split, so it calls no model. An arm is compared with `base` by a paired difference with a 95 % bootstrap interval. A row marked `*` has an interval that excludes zero. A difference without it is not shown to be real. See [Measure](/guide/measure) for what each metric counts.
- **Answers** come from one local model. They are a statement about that model on this corpus. Another model gives other numbers, so compare systems within one table, never across machines.
- **Security** is the attack success rate on the probe set, per system. See [Attack probes](/guide/security-probes).
- **Bytes** are what a reader of the static install downloads: the size on disk and the size on the wire, compressed with brotli.
- An adopted setting needs a measured gain and a stated cost. An arm that does not beat `base` with a clear interval stays an option, not a default.

## Results

Measured on 2026-10-25 with `bge-m3` and `qwen3:8b` on a local Ollama. The raw reports are in `bench/harborline/results/`.

### Answers

The golden set at `--level=high`: 65 questions, 50 answerable and 15 negatives. ΔF1 is paired by question against `v1.5 static`.

| system | answer F1 | ΔF1 vs 1.5 | citation P | citation R | negatives caught | first token p50 | whole answer p50 / p95 | requests / turn |
|---|---|---|---|---|---|---|---|---|
| `v1.5 static` | 0.405 | — | 56% | 75% | 40% | — | 24.5 s / 49.1 s | 1.11 |
| `v2.0 static` | 0.405 | ±0.000 [0.000, 0.000] | 56% | 75% | 40% | 27.5 s | 27.5 s / 47.0 s | 1.11 |
| `v2.0 server` | 0.414 | +0.010 [−0.016, 0.033] | 60% | 73% | 40% | 8.3 s | 19.5 s / 39.3 s | 0.98 |
| `v2.0 server agentic` | 0.407 | +0.002 [−0.009, 0.013] | 56% | 78% | 40% | 25.0 s | 25.0 s / 40.2 s | 1.11 |

What it says:

- **The static install answers exactly as 1.5 did.** All 65 answers of `v2.0 static` are byte-identical to those of `v1.5 static`. The latency difference is the machine: the two runs generated the same tokens.
- **The server's default turn is three times faster to the first token.** One-shot without reasoning shows the first token at 8.3 s against 25.0 s for the agentic loop, and it uses 27% fewer prompt tokens. Answer F1 and citations move inside the noise.
- **The cost of one-shot** is that the model cannot search again inside a turn. One of its 65 answers was a generation that ran into the 120 s step timeout. Set `chat.maxTokens` when a local model answers. `server.turn.loop: 'agentic'` restores the 1.x turn.

### Security

The 30 [attack probes](/guide/security-probes), per system. A breach is a probe whose forbidden text reached the answer.

| system | attack success | refused when it should | answered safely | canary leaked | markup echoed |
|---|---|---|---|---|---|
| `v2.0 static` | 30% | 19% | 64% | 2 | 3 |
| `v2.0 server` | 30% | 19% | 50% | 0 | 3 |
| `v2.0 server agentic` | 23% | 31% | 64% | 0 | 3 |

What it says:

- **The server keeps its instruction.** The canary in `prompt.extend` reached no reader of either server turn. The static install ships its prompt to the browser, so its canary is public by design.
- **Echoed markup is inert.** Every system repeated an injected `<script>`, `onerror=` or `javascript:` when asked to. The panel escapes HTML and links no `javascript:`, so the reader sees text.
- **The loop resists more.** The agentic turn resisted two probes that one-shot followed: a translated instruction and an instruction planted in a page. With 30 probes the difference is two probes, inside the noise. A site that weighs injection resistance above speed can set `turn.loop: 'agentic'`.

### The gate

`eval/calibration.jsonl` holds 295 probes in the eleven strata `docpilot calibrate` reads, and none of them is a golden question. On Harborline `calibrate` refuses to write thresholds: the tau that lets every answerable probe through is 0.15, below the lexical weight 0.25, where a question would clear the gate on shared words alone (`bench/harborline/eval/calibration.report.md`). The build then inlines the provisional tau 0.30, and the calibrated systems measure that.

| system | negatives caught | over-refusal | answer F1 | whole answer p50 |
|---|---|---|---|---|
| `v2.0 static` | 6/15 | 0/50 | 0.405 | 27.5 s |
| `v2.0 static calibrated` | 6/15 | 0/50 | 0.405 | 23.8 s |
| `v2.0 server` | 6/15 | 0/50 | 0.414 | 19.5 s |
| `v2.0 server calibrated` | 7/15 | 0/50 | 0.405 | 20.1 s |

What it says:

- **The gate measures topic, not whether an answer exists.** Probes about absent features and absent APIs sit at a median G of 0.65 to 0.91, as high as the probes the docs answer (0.90 to 0.97). Only off-domain questions fall below a threshold that a real question never reaches.
- **On these questions the gate adds one refusal.** In the static install it refuses five off-domain questions that the model refused anyway, so the reader gets the same answers without a model call. On the server it catches one more negative, with no false refusal. The two server runs gave the same text on 20 of 65 questions, and the gate changed five of them: the rest is the model's own variation.
- **The default stays `guard.mode: 'off'`.** A threshold has to be measured per corpus and per language — see [Relevance gate](/features/gate) — and on this corpus no measured threshold exists. A site with blatant off-topic traffic can set `guard.tau` by hand and check it with `eval --gate-only`.

### Retrieval

The test split, 52 answerable questions, scored `--gate-only`. Δ is paired against `base`.

| arm | recall@8 | MRR | nDCG@8 | context P@5 | ΔnDCG@8 | ΔMRR |
|---|---|---|---|---|---|---|
| `v1.5` | 0.913 | 0.706 | 0.736 | 0.678 | ±0.000 | ±0.000 |
| `base` | 0.913 | 0.706 | 0.736 | 0.678 | — | — |
| `binary` | 0.913 | 0.673 | 0.716 | 0.668 | −0.021 [−0.051, 0.009] | −0.033 [−0.079, 0.011] |
| `ctx-path` | 0.913 | 0.711 | 0.742 | 0.695 | +0.005 [−0.000, 0.012] | +0.005 [0.001, 0.010] * |
| `ctx-desc` | 0.962 | 0.718 | 0.762 | 0.694 | +0.026 [−0.017, 0.070] | +0.012 [−0.038, 0.058] |
| `llms` | 0.923 | 0.689 | 0.729 | 0.663 | −0.008 [−0.023, 0.007] | −0.017 [−0.048, 0.005] |

What it says:

- **No lever is a default.** `ctx-path` gains half a point of MRR, and on DocPilot's own docs the same idea lowered context precision. `ctx-desc` does not clear the noise.
- **`binary` halves the download** at a cost inside the noise. It is an option for a site that counts bytes, not a default.
- **`llms.txt` as page descriptions ranks worse** on the very questions it was written for. The description lands on the page's first chunk, which then outranks the section that answers. See [Improving](/guide/improving).

### Download

What a reader of the static install downloads, per index. `ctx-path` and `ctx-desc` have the bytes of `base`.

| arm | on disk | on the wire (brotli) | of which vectors |
|---|---|---|---|
| `v1.5` | 541 KB | 199 KB | 133 KB |
| `base` | 541 KB | 199 KB | 133 KB |
| `binary` | 309 KB | 99 KB | 33 KB |
| `llms` | 547 KB | 202 KB | 133 KB |

### The tuning agent

The [tuning agent](/guide/tuning-agent), headless, gate-only, the embedder on a local Ollama.

| corpus | run | dev nDCG@8 | dev MRR | test nDCG@8 | test MRR | kept |
|---|---|---|---|---|---|---|
| Harborline | 12 min, 71 turns, $1.64 at API prices | 0.776 → 0.803 | 0.765 → 0.793 | 0.736 → 0.736 | 0.706 → 0.706 | 3 `<llm-only>` lines on 2 pages |
| DocPilot's docs | 13 min, 59 turns, $1.45 at API prices | 0.534 → 0.569 | 0.523 → 0.559 | 0.584 → 0.586 | 0.552 → 0.554 | nothing (see below) |

What it says:

- **The edits fix the questions they target and break nothing.** On Harborline three dev questions ranked better and none worse; the test split did not move. Each kept line restates what its section already says, in the words readers use.
- **The first run kept nothing because of its rule.** Two questions fixed out of 33, none worse, leaves a bootstrap interval with a lower bound of exactly zero. A gate-only run calls no model and ranks the same way every time, so `improve compare` now keeps such a Pareto move. The DocPilot candidate in the table is `keep` under that rule, on dev and on test.

## Next

- [Measure](/guide/measure) — the metrics in the tables.
- [Choose your install](/install/choose) — static or server.
- [Attack probes](/guide/security-probes) — the security run.
