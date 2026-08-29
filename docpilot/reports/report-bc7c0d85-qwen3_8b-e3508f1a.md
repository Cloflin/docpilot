# DocPilot eval — qwen3:8b

- index `bc7c0d85` · 452 chunks · embed `bge-m3`
- prompt `e3508f1a` · records 56 · maxIterations 2
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
| retrievalF1 | 0.333 |
| recall8 | 0.925 |
| mrr | 0.674 |
| answerF1 | 0.363 |
| identifierRecall | 0.594 |
| citationPrecision | 0.558 |
| supportPrecision | 0.917 |
| language | 1 |
| negativesCaughtRate | 0.750 |
| noAnswerPrecision | 0.438 |
| scopeContainment | 1 |
| unsupportedAnswerRate | 0.026 |
| hallucinated | 0 |
| gateOverRefusal | 1 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| promptTokens | 5909 |
| outputTokens | 478 |
| tokensPerAcceptedAnswer | 7860 |
| promptChars | 21046 |
| promptCharsPeak | 9088 |
| observationChars | 6865 |
| iterationsPerAnswer | 1.692 |
| latencyP50 | 70448 |
| latencyP95 | 123622 |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-15 | 0.669 | **refused** | refuse:out-of-scope | How does the i18n fallback work? |
| q-24 | 0.697 | pass | answer | Почему шлюз отказывает до вызова модели? |
| q-32 | 0.711 | pass | answer | Что хранится в истории переписки и где? |
| q-22 | 0.833 | pass | answer | How do I mount DocPilot in React? |
| q-33 | 0.876 | pass | answer | What does the credential check deliberately not match, and w |
| q-40 | 0.902 | pass | answer | Why does a greeting never reach a model? |
| q-11 | 0.917 | pass | answer | Why are the vectors quantised, and what does it cost? |
| q-21 | 0.917 | pass | answer | How do I quote a passage into the composer? |
| q-39 | 0.927 | pass | answer | Which providers in the chain cannot embed? |
| q-09 | 0.938 | pass | answer | What exactly is stored in conversation history, and where? |

## Misses

- n-02(answer)
- q-15(refuse:out-of-scope)
- n-06(answer)
- n-11(answer)
- n-14(answer)
