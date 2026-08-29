# DocPilot eval — qwen3:8b

- index `bc7c0d85` · 452 chunks · embed `bge-m3`
- prompt `e3508f1a` · records 10 · level `low` · maxIterations 2
- transport native tools, think on, num_ctx `8192`
- guard mode `cosine` tau `0.69` source `calibrated-reduced` calibratedAt `bc7c0d85`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | 0 | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.402 |
| recall8 | 0.929 |
| mrr | 0.687 |
| answerF1 | 0.335 |
| identifierRecall | 0.400 |
| citationPrecision | 0.471 |
| supportPrecision | 0.968 |
| language | 1 |
| negativesCaughtRate | 0.667 |
| noAnswerPrecision | 0.333 |
| scopeContainment | 1 |
| unsupportedAnswerRate | 0 |
| hallucinated | 0 |
| gateOverRefusal | 0 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| promptTokens | 5238 |
| outputTokens | 490 |
| tokensPerAcceptedAnswer | 7365 |
| promptChars | 17883 |
| promptCharsPeak | 8700 |
| observationChars | 6556 |
| iterationsPerAnswer | 1.571 |
| latencyP50 | 9306 |
| latencyP95 | 32164 |

> **Levers changed · num_ctx changed: null → 8192** — every delta below is against a different setup.

## Change since the previous run

| metric | before | after | Δ | |
|---|---|---|---|---|
| answerF1 | 0.374 | 0.335 | -0.039 | worse |
| citationPrecision | 0.548 | 0.471 | -0.076 | worse |
| supportPrecision | 0.960 | 0.968 | +0.008 | better |
| promptTokens | 5248 | 5238 | -10.333 | better |
| outputTokens | 502 | 490 | -11.778 | better |
| tokensPerAcceptedAnswer | 7393 | 7365 | -28.429 | better |
| latencyP50 | 9109 | 9306 | +197 | worse |
| latencyP95 | 30260 | 32164 | +1904 | worse |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-03 | 0.950 | pass | answer | Is the free tier limited by requests or by tokens? |
| q-07 | 0.965 | pass | answer | What is the answer ladder? |
| q-01 | 1 | pass | answer | What is the refusal gate? |
| q-02 | 1 | pass | answer | What are the two channels the gate scores a question on? |
| q-04 | 1 | pass | answer | What does the docpilot index command do? |
| q-05 | 1 | pass | answer | How do I install DocPilot in a VitePress site? |
| q-06 | 1 | pass | answer | Where should the API key live? |

## Misses

- n-02(answer)
