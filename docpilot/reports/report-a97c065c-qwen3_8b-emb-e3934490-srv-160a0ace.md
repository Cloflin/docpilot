# DocPilot eval — qwen3:8b

- index `a97c065c` · 859 chunks · embed `bge-m3`
- prompt `160a0ace` · records 96 · maxIterations 2
- transport native tools, think unsupported
- guard mode `cosine` tau `0.64` source `calibrated-reduced` calibratedAt `a97c065c`
- guard.mode `off`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | 0 | pass |
| scope containment | 1 | pass |
| answers without a link | 0.127 | **FAIL** q-09, q-17, q-20, q-37, q-49, q-54, q-56, q-66 |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.265 |
| recall8 | 0.742 |
| mrr | 0.553 |
| recall1 | 0.364 |
| recall3 | 0.568 |
| recall5 | 0.644 |
| ndcg8 | 0.569 |
| contextPrecision5 | 0.534 |
| answerF1 | 0.330 |
| identifierRecall | 0.414 |
| citationPrecision | 0.490 |
| citationRecall | 0.579 |
| supportPrecision | 0.946 |
| language | 1 |
| negativesCaughtRate | 0.333 |
| scopeContainment | 1 |
| unsupportedAnswerRate | 0.032 |
| hallucinated | 0 |
| unlinked | 0.127 |
| gateOverRefusal | 7 |
| answerOverRefusal | 3 |
| rejectedFetches | 0 |
| promptTokens | 2972 |
| outputTokens | 313 |
| tokensPerAcceptedAnswer | 5006 |
| iterationsPerAnswer | 0 |
| latencyP50 | 4785 |
| latencyP95 | 38415 |
| latencyP99 | 41990 |
| ttftP50 | 1334 |
| ttftP95 | 2289 |

## By language

> The corpus has one language; the readers do not. A mean over the whole
> set describes neither population when they differ.

| lang | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| English | 60 | 29 | 0.775 | 0.578 | 0.343 | 0.427 | 0.310 |
| Russian | 6 | 1 | 0.417 | 0.306 | 0.178 | 0.222 | 1 |

## By chain depth

> A question asked cold and a follow-up three turns into a chain are not
> the same question, and a mean over both describes neither.

| depth | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| 0 | 38 | 24 | 0.842 | 0.614 | 0.351 | 0.478 | 0.292 |
| 1 | 8 | 0 | 0.813 | 0.592 | 0.285 | 0.500 | — |
| 2 | 10 | 1 | 0.800 | 0.633 | 0.370 | 0.333 | 0 |
| 3 | 10 | 5 | 0.250 | 0.212 | 0.242 | 0.131 | 0.600 |

> **Prompt changed: 45921454 → 160a0ace** — every delta below is against a different setup.

## Change since the previous run

| metric | before | after | Δ | |
|---|---|---|---|---|
| retrievalF1 | 0.270 | 0.265 | -0.004 | worse |
| recall8 | 0.750 | 0.742 | -0.008 | worse |
| mrr | 0.556 | 0.553 | -0.003 | worse |
| recall5 | 0.652 | 0.644 | -0.008 | worse |
| ndcg8 | 0.573 | 0.569 | -0.004 | worse |
| contextPrecision5 | 0.537 | 0.534 | -0.003 | worse |
| answerF1 | 0.365 | 0.330 | -0.035 | worse |
| identifierRecall | 0.492 | 0.414 | -0.079 | worse |
| citationPrecision | 0.506 | 0.490 | -0.016 | worse |
| citationRecall | 0.597 | 0.579 | -0.017 | worse |
| supportPrecision | 0.971 | 0.946 | -0.025 | worse |
| unsupportedAnswerRate | 0.016 | 0.032 | +0.016 | worse |
| unlinked | 0.435 | 0.127 | -0.308 | better |
| gateOverRefusal | 6 | 7 | +1 | worse |
| answerOverRefusal | 2 | 3 | +1 | worse |
| promptTokens | 2646 | 2972 | +327 | worse |
| outputTokens | 332 | 313 | -19.073 | better |
| tokensPerAcceptedAnswer | 4611 | 5006 | +395 | worse |
| latencyP50 | 5958 | 4785 | -1173 | better |
| latencyP95 | 25959 | 38415 | +12456 | worse |
| latencyP99 | 40490 | 41990 | +1500 | worse |
| ttftP50 | 1294 | 1334 | +40 | worse |
| ttftP95 | 2275 | 2289 | +14 | worse |
| recall8[English] | 0.783 | 0.775 | -0.008 | worse |
| mrr[English] | 0.581 | 0.578 | -0.003 | worse |
| answerF1[English] | 0.381 | 0.343 | -0.038 | worse |
| identifierRecall[English] | 0.512 | 0.427 | -0.084 | worse |
| citationRecall[English] | 0.623 | 0.603 | -0.019 | worse |
| negativesCaughtRate[English] | 0.345 | 0.310 | -0.034 | worse |
| answerF1[Russian] | 0.188 | 0.178 | -0.010 | worse |
| negativesCaughtRate[Russian] | 0 | 1 | +1 | better |
| answerF1[depth=0] | 0.394 | 0.351 | -0.042 | worse |
| identifierRecall[depth=0] | 0.522 | 0.478 | -0.044 | worse |
| citationRecall[depth=0] | 0.625 | 0.608 | -0.017 | worse |
| negativesCaughtRate[depth=0] | 0.417 | 0.292 | -0.125 | worse |
| answerF1[depth=1] | 0.314 | 0.285 | -0.029 | worse |
| identifierRecall[depth=1] | 1 | 0.500 | -0.500 | worse |
| citationRecall[depth=1] | 0.643 | 0.688 | +0.045 | better |
| answerF1[depth=2] | 0.358 | 0.370 | +0.012 | better |
| identifierRecall[depth=2] | 0.581 | 0.333 | -0.248 | worse |
| citationRecall[depth=2] | 0.700 | 0.667 | -0.033 | worse |
| recall8[depth=3] | 0.300 | 0.250 | -0.050 | worse |
| mrr[depth=3] | 0.233 | 0.212 | -0.020 | worse |
| answerF1[depth=3] | 0.300 | 0.242 | -0.058 | worse |
| identifierRecall[depth=3] | 0.202 | 0.131 | -0.072 | worse |
| citationRecall[depth=3] | 0.333 | 0.278 | -0.056 | worse |
| negativesCaughtRate[depth=3] | 0 | 0.600 | +0.600 | better |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-66 | 0.521 | **refused** | answer | And why is the second of those the serious one? |
| q-15 | 0.559 | **refused** | answer | How does the i18n fallback work? |
| q-57 | 0.609 | **refused** | answer | А если удалить один из них в одной вкладке? |
| q-24 | 0.615 | **refused** | answer | Почему шлюз отказывает до вызова модели? |
| q-50 | 0.623 | **refused** | answer | А сразу после него? |
| q-58 | 0.624 | **refused** | answer | And which of them is not a loss at all? |
| q-52 | 0.633 | **refused** | answer | And what undoes that sorting? |
| q-62 | 0.649 | pass | refuse:not-answerable | А что из этого вообще нельзя заменить? |
| q-32 | 0.654 | pass | answer | Что хранится в истории переписки и где? |
| q-56 | 0.703 | pass | answer | And why does one of them jump the queue? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| ok | 35 | q-01, q-02, q-03, q-05, q-07, q-09, q-11, q-12, q-13, q-15, q-17, q-18, q-19, q-20, q-21, q-22, q-23, q-25, q-26, q-27, q-30, q-31, q-32, q-35, q-37, q-38, q-40, q-41, q-45, q-46, q-47, q-52, q-55, q-63, q-64 |
| gold-below-primed | 4 | q-04, q-16, q-33, q-49 |
| retrieval-miss | 13 | q-06, q-08, q-14, q-28, q-36, q-50, q-51, q-53, q-54, q-56, q-58, q-61, q-66 |
| primed-low-f1 | 11 | q-24, q-29, q-34, q-39, q-42, q-43, q-44, q-48, q-57, q-60, q-65 |
| over-refused | 3 | q-10, q-59, q-62 |
| neg-caught | 10 | n-01, n-05, n-08, n-12, n-19, n-22, n-23, n-28, n-29, n-30 |
| neg-answered:refuse:no-evidence | 15 | n-02, n-04, n-07, n-10, n-11, n-14, n-15, n-17, n-18, n-20, n-21, n-24, n-25, n-26, n-27 |
| neg-answered:refuse:out-of-scope | 5 | n-03, n-06, n-09, n-13, n-16 |

## Pages behind the misses that never say what they are for

> A frontmatter `description` lands on the page's FIRST chunk and is
> the one measured dense lever on this pipeline. A lead, not a verdict:
> the answer may simply not be written anywhere.

| page | records |
|---|---|
| `/reference/cli` | q-04, q-36 |
| `/guide/providers` | q-06, q-16, q-53 |
| `/concepts/a-turn` | q-08, q-28, q-49, q-50 |
| `/guide/social-openers` | q-14, q-56 |
| `/guide/credentials` | q-33 |
| `/concepts/the-ladder` | q-36, q-54 |
| `/concepts/the-gate` | q-49 |
| `/guide/comparison` | q-51 |
| `/guide/history` | q-58 |
| `/install/docusaurus` | q-61 |
| `/reference/config` | q-66 |
| `/guide/indexing` | q-66 |

## Misses

- n-02(answer)
- n-03(answer)
- q-10(refuse:not-answerable)
- n-04(answer)
- n-06(answer)
- n-07(answer)
- n-09(answer)
- n-10(answer)
- n-11(answer)
- n-13(answer)
- n-14(answer)
- n-15(answer)
- n-16(answer)
- n-17(answer)
- n-18(answer)
- n-20(answer)
- n-21(answer)
- n-24(answer)
- q-59(refuse:not-answerable)
- q-62(refuse:not-answerable)
- n-25(answer)
- n-26(answer)
- n-27(answer)
