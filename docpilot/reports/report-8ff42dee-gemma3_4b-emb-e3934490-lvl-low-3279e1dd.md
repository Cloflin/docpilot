# DocPilot eval — gemma3:4b

- index `8ff42dee` · 668 chunks · embed `bge-m3`
- prompt `3279e1dd` · records 10 · level `low` · maxIterations 2
- transport **fallback** (no tool calling), think unsupported, num_ctx `8192`
- guard mode `cosine` tau `0.3` source `provisional` calibratedAt `null`
- guard.mode `off`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | 0 | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.318 |
| recall8 | 0.643 |
| mrr | 0.433 |
| answerF1 | 0.306 |
| identifierRecall | 0.333 |
| citationPrecision | 0.315 |
| citationRecall | 0.583 |
| supportPrecision | 0.892 |
| language | 1 |
| negativesCaughtRate | 0.333 |
| noAnswerPrecision | 0 |
| scopeContainment | 1 |
| unsupportedAnswerRate | 0 |
| hallucinated | 0 |
| gateOverRefusal | 0 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| promptTokens | 8989 |
| outputTokens | 1451 |
| tokensPerAcceptedAnswer | 15660 |
| promptChars | 35405 |
| promptCharsPeak | 14794 |
| observationChars | 10625 |
| iterationsPerAnswer | 1.833 |
| latencyP50 | 70043 |
| latencyP95 | 141100 |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-07 | 0.779 | pass | answer | What is the answer ladder? |
| q-03 | 0.786 | pass | answer | Is the free tier limited by requests or by tokens? |
| q-06 | 0.883 | pass | answer | Where should the API key live? |
| q-02 | 0.961 | pass | answer | What are the two channels the gate scores a question on? |
| q-01 | 1 | pass | error | What is the refusal gate? |
| q-04 | 1 | pass | answer | What does the docpilot index command do? |
| q-05 | 1 | pass | answer | How do I install DocPilot in a VitePress site? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| ok | 3 | q-02, q-04, q-05 |
| retrieval-miss | 2 | q-03, q-06 |
| primed-low-f1 | 1 | q-07 |
| neg-caught | 1 | n-01 |
| neg-answered:refuse:no-evidence | 1 | n-02 |
| neg-answered:refuse:out-of-scope | 1 | n-03 |
| error | 1 | q-01 |

## Pages behind the misses that never say what they are for

> A frontmatter `description` lands on the page's FIRST chunk and is
> the one measured dense lever on this pipeline. A lead, not a verdict:
> the answer may simply not be written anywhere.

| page | records |
|---|---|
| `/guide/providers` | q-06 |

## Re-search

2 of 10 turns searched again in the model's own words; **2** of those crossed language.

> A re-search moves the lexical half only: the dense half still scores the reader's original question. Records: q-04, n-03.

## Misses

- q-01(error)
- n-02(answer)
- n-03(answer)
