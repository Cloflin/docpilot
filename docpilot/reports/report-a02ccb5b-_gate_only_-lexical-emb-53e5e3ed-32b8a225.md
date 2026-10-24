# DocPilot eval — (gate only)

- index `a02ccb5b` · 580 chunks · embed `openai/text-embedding-3-small` · **dense channel off for this run**
- prompt `32b8a225` · records 96 · maxIterations 2
- transport native tools, think on, num_ctx `8192`
- guard tauLexical `0.3` source `provisional` calibratedAt `null` (tau `0.3`, not consulted by this run)
- guard.mode `off`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | — | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.261 |
| recall8 | 0.636 |
| mrr | 0.560 |
| negativesCaughtRate | 0 |
| noAnswerPrecision | 0 |
| scopeContainment | 1 |
| gateOverRefusal | 6 |
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
| English | 60 | 29 | 0.700 | 0.616 | — | — | 0 |
| Russian | 6 | 1 | 0 | 0 | — | — | 0 |

## By chain depth

> A question asked cold and a follow-up three turns into a chain are not
> the same question, and a mean over both describes neither.

| depth | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| 0 | 38 | 24 | 0.842 | 0.764 | — | — | 0 |
| 1 | 8 | 0 | 0.500 | 0.323 | — | — | — |
| 2 | 10 | 1 | 0.500 | 0.500 | — | — | 0 |
| 3 | 10 | 5 | 0.100 | 0.033 | — | — | 0 |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-24 | 0 | **refused** | answer | Почему шлюз отказывает до вызова модели? |
| q-32 | 0 | **refused** | answer | Что хранится в истории переписки и где? |
| q-50 | 0 | **refused** | answer | А сразу после него? |
| q-54 | 0 | **refused** | answer | А если ни одна так и не ответила? |
| q-57 | 0 | **refused** | answer | А если удалить один из них в одной вкладке? |
| q-62 | 0 | **refused** | answer | А что из этого вообще нельзя заменить? |
| q-22 | 0.333 | pass | answer | How do I mount DocPilot in React? |
| q-52 | 0.500 | pass | answer | And what undoes that sorting? |
| q-66 | 0.500 | pass | answer | And why is the second of those the serious one? |
| q-11 | 0.667 | pass | answer | Why are the vectors quantised, and what does it cost? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| ok | 44 | q-01, q-02, q-03, q-05, q-06, q-07, q-08, q-09, q-10, q-11, q-12, q-13, q-15, q-16, q-17, q-18, q-19, q-20, q-21, q-22, q-23, q-25, q-26, q-27, q-28, q-29, q-30, q-31, q-33, q-34, q-37, q-38, q-39, q-40, q-43, q-44, q-46, q-47, q-51, q-53, q-59, q-60, q-63, q-64 |
| gold-below-primed | 1 | q-36 |
| retrieval-miss | 21 | q-04, q-14, q-24, q-32, q-35, q-41, q-42, q-45, q-48, q-49, q-50, q-52, q-54, q-55, q-56, q-57, q-58, q-61, q-62, q-65, q-66 |
| neg-answered:refuse:no-evidence | 25 | n-01, n-02, n-04, n-05, n-07, n-08, n-10, n-11, n-12, n-14, n-15, n-17, n-18, n-19, n-20, n-21, n-22, n-23, n-24, n-25, n-26, n-27, n-28, n-29, n-30 |
| neg-answered:refuse:out-of-scope | 5 | n-03, n-06, n-09, n-13, n-16 |

## Pages behind the misses that never say what they are for

> A frontmatter `description` lands on the page's FIRST chunk and is
> the one measured dense lever on this pipeline. A lead, not a verdict:
> the answer may simply not be written anywhere.

| page | records |
|---|---|
| `/reference/cli` | q-04, q-36 |
| `/guide/social-openers` | q-14, q-56 |
| `/guide/philosophy` | q-24 |
| `/concepts/the-gate` | q-24, q-35, q-48, q-49 |
| `/guide/history` | q-32, q-57, q-58 |
| `/concepts/the-ladder` | q-36, q-52, q-54 |
| `/guide/panel` | q-41 |
| `/guide/providers` | q-42, q-52 |
| `/guide/i18n` | q-45, q-62 |
| `/concepts/a-turn` | q-49, q-50 |
| `/guide/credentials` | q-55 |
| `/install/docusaurus` | q-61 |
| `/guide/evaluation` | q-65 |
| `/reference/config` | q-66 |
| `/guide/indexing` | q-66 |

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
