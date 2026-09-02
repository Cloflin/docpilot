# DocPilot eval — (gate only)

- index `08e7a87e` · 484 chunks · embed `nvidia/nemotron-3-embed-1b:free`
- prompt `df00ecbc` · records 56 · maxIterations 2
- transport native tools, think on, num_ctx `8192`
- guard mode `cosine` tau `0.69` source `transferred-window` calibratedAt `08e7a87e`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | — | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.358 |
| recall8 | 0.925 |
| mrr | 0.762 |
| negativesCaughtRate | 0.125 |
| noAnswerPrecision | 0.125 |
| scopeContainment | 1 |
| gateOverRefusal | 0 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| tokensPerAcceptedAnswer | 0 |
| latencyP50 | 0 |
| latencyP95 | 0 |

## Change since the previous run

| metric | before | after | Δ | |
|---|---|---|---|---|
| retrievalF1 | 0.317 | 0.358 | +0.041 | better |
| recall8 | 0.912 | 0.925 | +0.013 | better |
| mrr | 0.669 | 0.762 | +0.092 | better |
| negativesCaughtRate | 0.438 | 0.125 | -0.313 | worse |
| noAnswerPrecision | 0.438 | 0.125 | -0.313 | worse |
| gateOverRefusal | 1 | 0 | -1 | better |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-24 | 0.750 | pass | answer | Почему шлюз отказывает до вызова модели? |
| q-32 | 0.750 | pass | answer | Что хранится в истории переписки и где? |
| q-22 | 0.833 | pass | answer | How do I mount DocPilot in React? |
| q-11 | 0.917 | pass | answer | Why are the vectors quantised, and what does it cost? |
| q-15 | 0.917 | pass | answer | How does the i18n fallback work? |
| q-21 | 0.917 | pass | answer | How do I quote a passage into the composer? |
| q-18 | 0.938 | pass | answer | How does retrieval fuse its two channels? |
| q-23 | 0.938 | pass | answer | Which syntax highlighter does DocPilot use by default? |
| q-27 | 0.938 | pass | answer | What happens to retrieval when the embedder is unreachable? |
| q-33 | 0.938 | pass | answer | What does the credential check deliberately not match, and w |

## Misses

- n-01(answer)
- n-02(answer)
- n-03(answer)
- n-04(answer)
- n-05(answer)
- n-06(answer)
- n-07(answer)
- n-10(answer)
- n-11(answer)
- n-12(answer)
- n-13(answer)
- n-14(answer)
- n-15(answer)
- n-16(answer)
