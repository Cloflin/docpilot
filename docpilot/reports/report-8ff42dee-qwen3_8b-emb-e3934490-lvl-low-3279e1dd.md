# DocPilot eval — qwen3:8b

- index `8ff42dee` · 668 chunks · embed `bge-m3`
- prompt `3279e1dd` · records 10 · level `low` · maxIterations 2
- transport native tools, think on, num_ctx `8192`
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
| answerF1 | 0.382 |
| identifierRecall | 0.333 |
| citationPrecision | 0.500 |
| citationRecall | 0.417 |
| supportPrecision | 0.965 |
| language | 1 |
| negativesCaughtRate | 0.667 |
| noAnswerPrecision | 0 |
| scopeContainment | 1 |
| unsupportedAnswerRate | 0 |
| hallucinated | 0 |
| gateOverRefusal | 0 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| promptTokens | 3881 |
| outputTokens | 292 |
| tokensPerAcceptedAnswer | 6260 |
| promptChars | 12950 |
| promptCharsPeak | 9500 |
| observationChars | 6938 |
| iterationsPerAnswer | 1.167 |
| latencyP50 | 30206 |
| latencyP95 | 373191 |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-07 | 0.779 | pass | error | What is the answer ladder? |
| q-03 | 0.786 | pass | answer | Is the free tier limited by requests or by tokens? |
| q-06 | 0.883 | pass | answer | Where should the API key live? |
| q-02 | 0.961 | pass | answer | What are the two channels the gate scores a question on? |
| q-01 | 1 | pass | answer | What is the refusal gate? |
| q-04 | 1 | pass | answer | What does the docpilot index command do? |
| q-05 | 1 | pass | answer | How do I install DocPilot in a VitePress site? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| ok | 4 | q-01, q-02, q-04, q-05 |
| retrieval-miss | 2 | q-03, q-06 |
| neg-caught | 2 | n-01, n-03 |
| neg-answered:refuse:no-evidence | 1 | n-02 |
| error | 1 | q-07 |

## Pages behind the misses that never say what they are for

> A frontmatter `description` lands on the page's FIRST chunk and is
> the one measured dense lever on this pipeline. A lead, not a verdict:
> the answer may simply not be written anywhere.

| page | records |
|---|---|
| `/guide/providers` | q-06 |

## Misses

- q-07(error)
- n-02(answer)
