# DocPilot eval — (gate only)

- index `e313235d` · 476 chunks · embed `bge-m3`
- prompt `df00ecbc` · records 56 · maxIterations 2
- transport native tools, think on, num_ctx `8192`
- guard mode `cosine` tau `0.69` source `calibrated-reduced` calibratedAt `e313235d`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | — | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.317 |
| recall8 | 0.900 |
| mrr | 0.669 |
| negativesCaughtRate | 0.438 |
| noAnswerPrecision | 0.438 |
| scopeContainment | 1 |
| gateOverRefusal | 1 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| tokensPerAcceptedAnswer | 0 |
| latencyP50 | 0 |
| latencyP95 | 0 |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-15 | 0.669 | **refused** | refuse:out-of-scope | How does the i18n fallback work? |
| q-24 | 0.697 | pass | answer | Почему шлюз отказывает до вызова модели? |
| q-32 | 0.707 | pass | answer | Что хранится в истории переписки и где? |
| q-22 | 0.833 | pass | answer | How do I mount DocPilot in React? |
| q-33 | 0.876 | pass | answer | What does the credential check deliberately not match, and w |
| q-40 | 0.902 | pass | answer | Why does a greeting never reach a model? |
| q-11 | 0.917 | pass | answer | Why are the vectors quantised, and what does it cost? |
| q-21 | 0.917 | pass | answer | How do I quote a passage into the composer? |
| q-39 | 0.927 | pass | answer | Which providers in the chain cannot embed? |
| q-18 | 0.938 | pass | answer | How does retrieval fuse its two channels? |

## Misses

- n-01(answer)
- n-02(answer)
- q-15(refuse:out-of-scope)
- n-04(answer)
- n-06(answer)
- n-07(answer)
- n-10(answer)
- n-11(answer)
- n-14(answer)
- n-15(answer)
