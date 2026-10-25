# 032 — The reranker nobody could reach

> **Кратко.** Записано как «измерено/проверено, не построено», по образцу 024.
> Самый сильный известный рычаг точности сервера — cross-encoder rerank поверх
> слитого пула (по данным Anthropic, вместе с контекстным поиском −67% провалов
> извлечения). Ни один путь к нему не прошёл проверку в этой среде: OpenRouter
> `rerank` отклонён настройкой ZDR аккаунта, у Ollama нет rerank API, а обе
> GGUF-сборки Qwen3-Reranker не дают оценку через `generate`. Без измерения
> рычаг не поставляется; спека фиксирует, что проверено и что нужно, чтобы
> вернуться к нему.

## Problem

The server install has no byte budget, so the lever a static index cannot
afford — scoring each candidate against the question with a cross-encoder — is
the obvious accuracy step after hybrid fusion. Spec 031 left the fused pool's
order to dense cosine (`MMR_LAMBDA` 1.0); a reranker would replace that order.

## What was tried, 2026-10-25

| path | result |
|---|---|
| OpenRouter `POST /api/v1/rerank`, `cohere/rerank-v3.5` ($0.001 a search) | 404 `Filter by Guardrails` — "ZDR violation (account settings)"; the account's zero-data-retention setting excludes the only endpoint |
| Ollama 0.40.6 `/api/rerank`, `/v1/rerank` | 404 — no such route |
| `hf.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` on Ollama | loaded as `pooling_type 4` (rank): "does not support generate", and `/api/embed` returns zeros |
| `dengcao/Qwen3-Reranker-0.6B:Q8_0` on Ollama | generates, but the first token is `,` on every pair — no yes/no to read |
| `qwen3:0.6b` as a yes/no judge with logprobs | runs (≈30 ms a pair), but scores 0.95–0.99 for relevant and irrelevant passages alike |

Ollama 0.40.6 does return `logprobs` with `top_logprobs`, which is what a
pointwise yes/no reranker needs — the missing piece is a model build that keeps
its language-model head.

## Decision

Nothing is shipped. A lever that could not be measured on this corpus would be
a claim the benchmark cannot back.

## What brings it back

Any one of: an account setting that admits a rerank endpoint (OpenRouter's
privacy page), a llama.cpp server started with `--reranking` and a rank-pooled
GGUF (it exposes `/v1/rerank`), or an Ollama release with a rerank route. The
shape is then a `server.rerank: {provider, model, topN}` stage between fusion and
the gate's `GATE_K`, measured on Harborline with `eval --runtime=server` against
the same records, latency included.
