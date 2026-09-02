# DocPilot eval — qwen3:8b

- index `08e7a87e` · 484 chunks · embed `bge-m3`
- prompt `df00ecbc` · records 70 · maxIterations 2
- transport native tools, think on, num_ctx `8192`
- guard mode `cosine` tau `0.69` source `calibrated-reduced` calibratedAt `08e7a87e`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | 0 | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.315 |
| recall8 | 0.924 |
| mrr | 0.650 |
| answerF1 | 0.340 |
| identifierRecall | 0.637 |
| citationPrecision | 0.540 |
| citationRecall | 0.722 |
| supportPrecision | 0.918 |
| language | 1 |
| negativesCaughtRate | 0.542 |
| noAnswerPrecision | 0.292 |
| scopeContainment | 1 |
| unsupportedAnswerRate | 0 |
| hallucinated | 0 |
| gateOverRefusal | 1 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| promptTokens | 6872 |
| outputTokens | 548 |
| tokensPerAcceptedAnswer | 10223 |
| promptChars | 23619 |
| promptCharsPeak | 9540 |
| observationChars | 7199 |
| iterationsPerAnswer | 1.822 |
| latencyP50 | 18492 |
| latencyP95 | 37535 |

## By language

> The corpus has one language; the readers do not. A mean over the whole
> set describes neither population when they differ.

| lang | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| English | 44 | 24 | 0.943 | 0.657 | 0.344 | 0.646 | 0.542 |
| Russian | 2 | 0 | 0.500 | 0.500 | 0.259 | 0.500 | — |

## Change since the previous run

| metric | before | after | Δ | |
|---|---|---|---|---|
| latencyP50 | 19458 | 18492 | -966 | better |
| latencyP95 | 37887 | 37535 | -352 | better |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-15 | 0.670 | **refused** | refuse:out-of-scope | How does the i18n fallback work? |
| q-24 | 0.698 | pass | answer | Почему шлюз отказывает до вызова модели? |
| q-32 | 0.708 | pass | answer | Что хранится в истории переписки и где? |
| q-22 | 0.833 | pass | answer | How do I mount DocPilot in React? |
| q-33 | 0.878 | pass | answer | What does the credential check deliberately not match, and w |
| q-40 | 0.902 | pass | answer | Why does a greeting never reach a model? |
| q-11 | 0.917 | pass | answer | Why are the vectors quantised, and what does it cost? |
| q-21 | 0.917 | pass | answer | How do I quote a passage into the composer? |
| q-41 | 0.917 | pass | answer | And what does the reader see when it refuses? |
| q-39 | 0.927 | pass | answer | Which providers in the chain cannot embed? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| ok | 32 | q-01, q-02, q-03, q-04, q-05, q-09, q-10, q-11, q-12, q-13, q-18, q-19, q-20, q-21, q-25, q-26, q-27, q-29, q-30, q-31, q-32, q-34, q-35, q-37, q-38, q-39, q-40, q-41, q-42, q-43, q-45, q-46 |
| gold-below-primed | 5 | q-06, q-08, q-16, q-28, q-33 |
| retrieval-miss | 3 | q-14, q-24, q-36 |
| primed-low-f1 | 5 | q-07, q-17, q-22, q-23, q-44 |
| over-refused | 1 | q-15 |
| neg-caught | 13 | n-01, n-02, n-03, n-05, n-07, n-08, n-09, n-10, n-12, n-13, n-16, n-19, n-24 |
| neg-answered:refuse:no-evidence | 10 | n-04, n-11, n-14, n-15, n-17, n-18, n-20, n-21, n-22, n-23 |
| neg-answered:refuse:out-of-scope | 1 | n-06 |

## Pages behind the misses that never say what they are for

> A frontmatter `description` lands on the page's FIRST chunk and is
> the one measured dense lever on this pipeline. A lead, not a verdict:
> the answer may simply not be written anywhere.

| page | records |
|---|---|
| `/guide/providers` | q-06, q-16 |
| `/concepts/a-turn` | q-08, q-28 |
| `/guide/social-openers` | q-14 |
| `/guide/philosophy` | q-24 |
| `/concepts/the-gate` | q-24 |
| `/guide/credentials` | q-33 |
| `/concepts/the-ladder` | q-36 |
| `/reference/cli` | q-36 |

## Re-search

1 of 70 turns searched again in the model's own words; **1** of those crossed language.

> A re-search moves the lexical half only: the dense half still scores the reader's original question. Records: n-22.

## Misses

- q-15(refuse:out-of-scope)
- n-04(answer)
- n-06(answer)
- n-11(answer)
- n-14(answer)
- n-15(answer)
- n-17(answer)
- n-18(answer)
- n-20(answer)
- n-21(answer)
- n-22(answer)
- n-23(answer)
