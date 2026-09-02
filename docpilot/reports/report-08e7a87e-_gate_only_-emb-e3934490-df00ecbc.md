# DocPilot eval — (gate only)

- index `08e7a87e` · 484 chunks · embed `bge-m3`
- prompt `df00ecbc` · records 56 · maxIterations 2
- transport native tools, think on, num_ctx `8192`
- guard mode `cosine` tau `0.69` source `calibrated-reduced` calibratedAt `08e7a87e`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | — | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.317 |
| recall8 | 0.912 |
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

## By language

> The corpus has one language; the readers do not. A mean over the whole
> set describes neither population when they differ.

| lang | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| English | 38 | 16 | 0.934 | 0.678 | — | — | 0.438 |
| Russian | 2 | 0 | 0.500 | 0.500 | — | — | — |

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
| q-39 | 0.927 | pass | answer | Which providers in the chain cannot embed? |
| q-18 | 0.938 | pass | answer | How does retrieval fuse its two channels? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| ok | 31 | q-01, q-02, q-03, q-04, q-05, q-07, q-09, q-10, q-11, q-12, q-13, q-17, q-18, q-19, q-20, q-21, q-22, q-23, q-25, q-26, q-27, q-29, q-30, q-31, q-32, q-34, q-35, q-37, q-38, q-39, q-40 |
| gold-below-primed | 5 | q-06, q-08, q-16, q-28, q-33 |
| retrieval-miss | 3 | q-14, q-24, q-36 |
| over-refused | 1 | q-15 |
| neg-caught | 7 | n-03, n-05, n-08, n-09, n-12, n-13, n-16 |
| neg-answered:refuse:no-evidence | 8 | n-01, n-02, n-04, n-07, n-10, n-11, n-14, n-15 |
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
