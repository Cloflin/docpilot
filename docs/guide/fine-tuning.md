---
description: Build training sets from your readers' turns and votes, fingerprint the weights you train, and prove a checkpoint is better before it ships.
---

# Fine-tuning

DocPilot does not train models. It gives the loop around training the three things that are easy to get wrong: data that does not leak into the eval, a record of **which** weights were measured, and a comparison that says when a difference is real.

```
turn log + votes ──► docpilot dataset ──► train.jsonl ──► your trainer
                          │                                   │
             golden excluded                          checkpoint
                                                              │
docpilot model contamination ◄── train.jsonl                  ▼
docpilot model fingerprint ──► manifest    serve it (vLLM, llama.cpp, Ollama)
                                                              │
docpilot eval (base) + docpilot eval (candidate) ──► docpilot model compare
```

## Datasets {#datasets}

Needs the [server runtime](/guide/server) with a turn log, and ideally `feedbackEndpoint` for votes.

```bash
npx docpilot dataset kto --from=docpilot/turns --feedback=./votes.jsonl
npx docpilot dataset sft --from=docpilot/turns --feedback=./votes.jsonl --include-unvoted
npx docpilot dataset dpo --from=docpilot/turns --feedback=./votes.jsonl
```

| mode | format | from |
|---|---|---|
| `kto` | TRL `{prompt, completion, label}` | every voted answer — up is `true`, down is `false` |
| `sft` | chat `{messages: [system, user, assistant]}` | up-voted answers; with `--include-unvoted`, also cited, supported, unhedged ones |
| `dpo` | TRL `{prompt, chosen, rejected}` | questions with both an up-voted and a down-voted answer |

**Start with KTO.** A thumb is an unpaired binary signal, which is exactly what KTO learns from. DPO needs two answers to one question, one liked and one not, and a documentation site rarely has many.

The prompt is the one the answer was written from when the log kept it (`log.prompts`); otherwise it is rebuilt from the cited chunks and the question. Either way the context is in it — a model trained on answers without their evidence learns to answer without evidence.

**Earlier turns are left out.** The earlier questions and answers in a logged prompt come from the reader's browser, and the server cannot prove it wrote them; a forged answer up-voted by its author would otherwise become a training target. A follow-up row holds the system message, the current question with its quote, the retrieved passages and the answer. Single-turn rows are unchanged. The summary line prints `client-sent history removed N` when it removed any.

Every record whose question matches a golden question is dropped, and the count is printed. `--holdout=0.1` splits by conversation, so the turns of one conversation never land on both sides.

## Fingerprinting the weights

```bash
npx docpilot model fingerprint ./checkpoints/step-2000 --out=cand-manifest.json
npx docpilot model verify --manifest=cand-manifest.json
```

A model name says nothing about the weights behind it — two runs of `qwen3:8b-ft` can be two different checkpoints. `fingerprint` hashes every weight, adapter, config and tokenizer file and reads the safetensors and GGUF headers without loading a tensor: parameter count, dtypes, architecture, and for a LoRA adapter its base model. The manifest's `digest` is one hash for the whole set.

## Comparing checkpoints

Serve each checkpoint behind an OpenAI-compatible endpoint, and run the same eval against each:

```bash
# vLLM: --served-model-name names it; a LoRA is --lora-modules cand=./adapter
DOCPILOT_PROVIDER=openai DOCPILOT_BASE_URL=http://gpu:8000 DOCPILOT_EVAL_SEED=1 npx docpilot eval --model=base
DOCPILOT_PROVIDER=openai DOCPILOT_BASE_URL=http://gpu:8000 DOCPILOT_EVAL_SEED=1 npx docpilot eval --model=cand

npx docpilot model compare \
  --base=docpilot/reports/history/<base>.json \
  --candidate=docpilot/reports/history/<cand>.json \
  --base-manifest=base-manifest.json --candidate-manifest=cand-manifest.json
```

`compare` pairs the two reports record by record and tests the **difference**, not two averages: McNemar's exact test on whether each record's outcome was right, and a paired bootstrap on answer F1, citation precision and recall, recall@8, latency and tokens. It refuses when the index, the prompt or the golden set differ between the two runs, because then it would measure more than the model.

It also says what it **cannot** see. Fifty records cannot tell a 5-point difference from noise, and the report states the smallest change this set could detect. A regression exits `1`, so the command can gate a release.

## Leakage

```bash
npx docpilot model contamination --train=train.jsonl
```

Flags every golden record whose 13-grams appear in the training set. A leaked record measures memory, not answering. `dataset` already excludes golden questions; run this on any training set you assembled yourself.
