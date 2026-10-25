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

| system | arm | runtime |
|---|---|---|
| `v1.5 static` | `v1.5` | the released 1.5 CLI, from a checkout of `main` |
| `v2.0 static` | `base` | `runtime: 'browser'` |
| `v2.0 server` | `base` | `runtime: 'server'`, the 2.0 default turn: one-shot, no reasoning before the answer |
| `v2.0 server agentic` | `base` | `runtime: 'server'` with `turn.loop: 'agentic'`, the 1.x server turn |

The 1.5 baseline is the code that shipped, run from a built checkout, not a model of it.

## Rerun it {#rerun}

You need Node 20 or newer, a built checkout of this repository (`npm run build`, because the report step imports from `dist/`), and [Ollama](https://ollama.com/) serving the embedding model `bge-m3` and the chat model. Run every command from the repository root.

```bash
node bench/run.mjs index        # build one index per arm
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

<!-- BENCH-RESULTS -->

## Next

- [Measure](/guide/measure) — the metrics in the tables.
- [Choose your install](/install/choose) — static or server.
- [Attack probes](/guide/security-probes) — the security run.
