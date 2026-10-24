# DocPilot eval — openai/gpt-4o-mini

- index `a02ccb5b` · 580 chunks · embed `qwen/qwen3-embedding-8b`
- prompt `32b8a225` · records 96 · maxIterations 2
- transport **fallback** (no tool calling), think on
- guard mode `cosine` tau `0.55` source `calibrated-reduced` calibratedAt `a02ccb5b`
- guard.mode `off`

## Hard gates

| gate | value | verdict |
|---|---|---|
| hallucinated citations | — | pass |
| scope containment | 1 | pass |

## Metrics

| metric | value |
|---|---|
| retrievalF1 | 0.328 |
| recall8 | 0.803 |
| mrr | 0.631 |
| negativesCaughtRate | 0 |
| noAnswerPrecision | 0 |
| scopeContainment | 1 |
| gateOverRefusal | 4 |
| answerOverRefusal | 0 |
| rejectedFetches | 0 |
| latencyP50 | 159 |
| latencyP95 | 487 |

## By language

> The corpus has one language; the readers do not. A mean over the whole
> set describes neither population when they differ.

| lang | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| English | 60 | 29 | 0.825 | 0.650 | — | — | 0 |
| Russian | 6 | 1 | 0.583 | 0.450 | — | — | 0 |

## By chain depth

> A question asked cold and a follow-up three turns into a chain are not
> the same question, and a mean over both describes neither.

| depth | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |
|---|---|---|---|---|---|---|---|
| 0 | 38 | 24 | 0.921 | 0.804 | — | — | 0 |
| 1 | 8 | 0 | 1 | 0.581 | — | — | — |
| 2 | 10 | 1 | 0.750 | 0.471 | — | — | 0 |
| 3 | 10 | 5 | 0.250 | 0.175 | — | — | 0 |

## Over-refusal backlog — the ten positives closest to the floor

| id | G | gate | observed | question |
|---|---|---|---|---|
| q-66 | 0.417 | **refused** | error | And why is the second of those the serious one? |
| q-52 | 0.446 | **refused** | error | And what undoes that sorting? |
| q-62 | 0.488 | **refused** | error | А что из этого вообще нельзя заменить? |
| q-24 | 0.507 | **refused** | error | Почему шлюз отказывает до вызова модели? |
| q-50 | 0.572 | pass | error | А сразу после него? |
| q-58 | 0.591 | pass | error | And which of them is not a loss at all? |
| q-49 | 0.607 | pass | error | And if none of them survive? |
| q-56 | 0.630 | pass | error | And why does one of them jump the queue? |
| q-57 | 0.647 | pass | error | А если удалить один из них в одной вкладке? |
| q-32 | 0.658 | pass | error | Что хранится в истории переписки и где? |

## Failure taxonomy

> What moved, not how much. The four positive buckets have four
> different fixes: a corpus edit, a ranking lever, the answer side,
> and the gate.

| bucket | n | ids |
|---|---|---|
| error | 96 | q-01, q-02, q-03, q-04, q-05, q-06, q-07, n-01, n-02, n-03, q-08, q-09, q-10, q-11, q-12, q-13, q-14, q-15, q-16, n-04, n-05, n-06, q-17, q-18, q-19, q-20, q-21, q-22, q-23, q-24, q-25, q-26, n-07, n-08, n-09, n-10, q-27, q-28, q-29, q-30, q-31, q-32, n-11, n-12, n-13, q-33, q-34, q-35, q-36, q-37, q-38, q-39, q-40, n-14, n-15, n-16, q-41, q-42, q-43, q-44, q-45, q-46, n-17, n-18, n-19, n-20, n-21, n-22, n-23, n-24, q-47, q-48, q-49, q-50, q-51, q-52, q-53, q-54, q-55, q-56, q-57, q-58, q-59, q-60, q-61, q-62, q-63, q-64, q-65, q-66, n-25, n-26, n-27, n-28, n-29, n-30 |

## Misses

- q-01(error)
- q-02(error)
- q-03(error)
- q-04(error)
- q-05(error)
- q-06(error)
- q-07(error)
- n-01(error)
- n-02(error)
- n-03(error)
- q-08(error)
- q-09(error)
- q-10(error)
- q-11(error)
- q-12(error)
- q-13(error)
- q-14(error)
- q-15(error)
- q-16(error)
- n-04(error)
- n-05(error)
- n-06(error)
- q-17(error)
- q-18(error)
- q-19(error)
- q-20(error)
- q-21(error)
- q-22(error)
- q-23(error)
- q-24(error)
- q-25(error)
- q-26(error)
- n-07(error)
- n-08(error)
- n-09(error)
- n-10(error)
- q-27(error)
- q-28(error)
- q-29(error)
- q-30(error)
- q-31(error)
- q-32(error)
- n-11(error)
- n-12(error)
- n-13(error)
- q-33(error)
- q-34(error)
- q-35(error)
- q-36(error)
- q-37(error)
- q-38(error)
- q-39(error)
- q-40(error)
- n-14(error)
- n-15(error)
- n-16(error)
- q-41(error)
- q-42(error)
- q-43(error)
- q-44(error)
- q-45(error)
- q-46(error)
- n-17(error)
- n-18(error)
- n-19(error)
- n-20(error)
- n-21(error)
- n-22(error)
- n-23(error)
- n-24(error)
- q-47(error)
- q-48(error)
- q-49(error)
- q-50(error)
- q-51(error)
- q-52(error)
- q-53(error)
- q-54(error)
- q-55(error)
- q-56(error)
- q-57(error)
- q-58(error)
- q-59(error)
- q-60(error)
- q-61(error)
- q-62(error)
- q-63(error)
- q-64(error)
- q-65(error)
- q-66(error)
- n-25(error)
- n-26(error)
- n-27(error)
- n-28(error)
- n-29(error)
- n-30(error)
