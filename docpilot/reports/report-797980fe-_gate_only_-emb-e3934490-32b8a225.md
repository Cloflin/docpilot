# DocPilot eval — (gate only)

- index `797980fe` · 570 chunks · embed `bge-m3`
- prompt `32b8a225` · records 96 · maxIterations 2
- transport native tools, think on, num_ctx `8192`
- guard mode `cosine` tau `0.3` source `provisional` calibratedAt `null`
- guard.mode `off`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | — | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.275 |
| recall8 | 0.803 |
| mrr | 0.566 |
| negativesCaughtRate | 0 |
| noAnswerPrecision | 0 |
| scopeContainment | 1 |
| gateOverRefusal | 3 |
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
| English | 60 | 29 | 0.833 | 0.564 | — | — | 0 |
| Russian | 6 | 1 | 0.500 | 0.583 | — | — | 0 |

## By chain depth

> A question asked cold and a follow-up three turns into a chain are not
> the same question, and a mean over both describes neither.

| depth | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| 0 | 38 | 24 | 0.921 | 0.683 | — | — | 0 |
| 1 | 8 | 0 | 1 | 0.532 | — | — | — |
| 2 | 10 | 1 | 0.750 | 0.464 | — | — | 0 |
| 3 | 10 | 5 | 0.250 | 0.250 | — | — | 0 |

## Change since the previous run

| metric | before | after | Δ | |
|---|---|---|---|---|
| retrievalF1 | 0.293 | 0.275 | -0.018 | worse |
| recall8 | 0.841 | 0.803 | -0.038 | worse |
| mrr | 0.598 | 0.566 | -0.032 | worse |
| recall8[English] | 0.867 | 0.833 | -0.033 | worse |
| mrr[English] | 0.613 | 0.564 | -0.049 | worse |
| recall8[Russian] | 0.583 | 0.500 | -0.083 | worse |
| mrr[Russian] | 0.450 | 0.583 | +0.133 | better |
| recall8[depth=2] | 0.900 | 0.750 | -0.150 | worse |
| mrr[depth=2] | 0.658 | 0.464 | -0.194 | worse |
| recall8[depth=3] | 0.350 | 0.250 | -0.100 | worse |
| mrr[depth=3] | 0.270 | 0.250 | -0.020 | worse |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-15 | 0.271 | **refused** | answer | How does the i18n fallback work? |
| q-50 | 0.292 | **refused** | answer | А сразу после него? |
| q-57 | 0.296 | **refused** | answer | А если удалить один из них в одной вкладке? |
| q-58 | 0.323 | pass | answer | And which of them is not a loss at all? |
| q-48 | 0.357 | pass | answer | And why don't those two say what they searched? |
| q-66 | 0.397 | pass | answer | And why is the second of those the serious one? |
| q-52 | 0.439 | pass | answer | And what undoes that sorting? |
| q-56 | 0.458 | pass | answer | And why does one of them jump the queue? |
| q-24 | 0.505 | pass | answer | Почему шлюз отказывает до вызова модели? |
| q-32 | 0.515 | pass | answer | Что хранится в истории переписки и где? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| ok | 48 | q-01, q-02, q-03, q-05, q-07, q-09, q-10, q-11, q-12, q-13, q-15, q-17, q-18, q-19, q-20, q-21, q-22, q-23, q-24, q-25, q-26, q-27, q-29, q-30, q-31, q-32, q-34, q-35, q-37, q-38, q-39, q-40, q-41, q-42, q-43, q-44, q-45, q-46, q-47, q-48, q-50, q-51, q-52, q-57, q-59, q-60, q-63, q-65 |
| gold-below-primed | 7 | q-04, q-06, q-08, q-16, q-28, q-33, q-64 |
| retrieval-miss | 11 | q-14, q-36, q-49, q-53, q-54, q-55, q-56, q-58, q-61, q-62, q-66 |
| neg-answered:refuse:no-evidence | 25 | n-01, n-02, n-04, n-05, n-07, n-08, n-10, n-11, n-12, n-14, n-15, n-17, n-18, n-19, n-20, n-21, n-22, n-23, n-24, n-25, n-26, n-27, n-28, n-29, n-30 |
| neg-answered:refuse:out-of-scope | 5 | n-03, n-06, n-09, n-13, n-16 |

## Pages behind the misses that never say what they are for

> A frontmatter `description` lands on the page's FIRST chunk and is
> the one measured dense lever on this pipeline. A lead, not a verdict:
> the answer may simply not be written anywhere.

| page | records |
|---|---|
| `/reference/cli` | q-04, q-36 |
| `/guide/providers` | q-06, q-16, q-53 |
| `/concepts/a-turn` | q-08, q-28, q-49 |
| `/guide/social-openers` | q-14, q-56 |
| `/guide/credentials` | q-33, q-55 |
| `/concepts/the-ladder` | q-36, q-54 |
| `/concepts/the-gate` | q-49 |
| `/guide/history` | q-58 |
| `/install/docusaurus` | q-61 |
| `/guide/i18n` | q-62 |
| `/guide/indexing` | q-64, q-66 |
| `/reference/config` | q-66 |

## Misses

- n-01(answer)
- n-02(answer)
- n-03(answer)
- n-04(answer)
- n-05(answer)
- n-06(answer)
- n-07(answer)
- n-08(answer)
- n-09(answer)
- n-10(answer)
- n-11(answer)
- n-12(answer)
- n-13(answer)
- n-14(answer)
- n-15(answer)
- n-16(answer)
- n-17(answer)
- n-18(answer)
- n-19(answer)
- n-20(answer)
- n-21(answer)
- n-22(answer)
- n-23(answer)
- n-24(answer)
- n-25(answer)
- n-26(answer)
- n-27(answer)
- n-28(answer)
- n-29(answer)
- n-30(answer)
