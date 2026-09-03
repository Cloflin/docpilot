# Gate calibration — `3dc7547a`

Produced by `npx docpilot calibrate` (RAG-SPEC 5.6). Embed endpoint only — no chat model,
no LLM judge, no unseeded randomness. Same corpus + same probes ⇒ same output.

| | |
|---|---|
| index | `3dc7547a`, 493 chunks, bge-m3 |
| probes | 597 from `docpilot/calibration.jsonl` |
| **tau** | **0.57** |
| **tauLexical** | **0.51** |
| wDense / wLexical | 0.75 / 0.25 |
| denseMode | cosine, window [0.3, 0.64] |
| source | `calibrated-reduced` |
| gatePrecision | 55.4% (target 60%, never a constraint) |

## Probe set, and what the reduction costs

RAG-SPEC 5.6 sizes the strata at ~540 probes so `UB95 <= 0.05` is reachable.
With zero failures `UB95(0,n) = z²/(n+z²)`, `z = 1.6449`, so the 5% bound is
**unreachable below n = 52** whatever the gate does, and the 8% bound below n = 32.
This run keeps the three bounded positive strata above those floors and cuts the
negatives, which are a target (`gatePrecision >= 0.60`) and never a constraint.

| stratum | spec n | this run | UB95 at 0 failures | UB95 at spec n | cost of the cut |
|---|---|---|---|---|---|
| U | 180 | 169 | 0.016 | 0.015 | +0.001 |
| S | 60 | 128 | 0.021 | 0.043 | −0.022 |
| F | 60 | 60 | 0.043 | 0.043 | — |
| N1 | 30 | 30 | 0.083 | 0.083 | — |
| N2 | 30 | 30 | 0.083 | 0.083 | — |
| N3 | 30 | 30 | 0.083 | 0.083 | — |
| N4 | 30 | 30 | 0.083 | 0.083 | — |
| N5 | 30 | 30 | 0.083 | 0.083 | — |
| N6 | 30 | 30 | 0.083 | 0.083 | — |
| X | 30 | 30 | 0.083 | 0.083 | — |
| P | 30 | 30 | 0.083 | 0.083 | — |

The interval width is not the whole cost. What actually decides whether a bound can
bind is how many failures it tolerates at the n it has:

| bound | stratum | n | ceiling | failures tolerated | n needed for 1 |
|---|---|---|---|---|---|
| `gateOverRefusal` | U | 169 (spec 180) | 0.05 | **3** | 87 |
| `scopedGateOverRefusal` | S | 128 (spec 60) | 0.05 | **2** | 87 |
| `followupRefusalRate` | F | 60 (spec 60) | 0.08 | **1** | 54 |

## Sweep (RAG-SPEC 5.6 step 3)

`X` probes are scored on refusal alone, cause-agnostic, during the sweep —
`wouldPassUnscoped` is itself a function of tau. The cause is checked once, below.
Positives that are `retrievalMisses` are excluded from the three bounds (RAG-SPEC 5.4).

| tau | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 | feasible |
|---|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 0.0% | 0.0% | yes |
| 0.05 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 1.7% | 6.7% | yes |
| 0.10 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 2.5% | 6.7% | yes |
| 0.15 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 3.3% | 10.0% | yes |
| 0.20 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 5.0% | 16.7% | yes |
| 0.25 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 7.9% | 23.3% | yes |
| 0.30 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 15.8% | 46.7% | yes |
| 0.35 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 24.6% | 76.7% | yes |
| 0.40 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 29.2% | 83.3% | yes |
| 0.45 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 34.2% | 90.0% | yes |
| 0.50 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 39.2% | 93.3% | yes |
| 0.55 | 0/169 | 0.016 | 1/128 | 0.034 | 0/60 | 0.043 | 51.2% | 96.7% | yes |
| 0.57 | 0/169 | 0.016 | 2/128 | 0.046 | 0/60 | 0.043 | 55.4% | 96.7% | yes |
| 0.60 | 2/169 | 0.035 | 4/128 | 0.068 | 0/60 | 0.043 | 59.2% | 96.7% |  |
| 0.65 | 7/169 | 0.075 | 12/128 | 0.145 | 1/60 | 0.071 | 66.7% | 96.7% |  |
| 0.70 | 8/169 | 0.082 | 18/128 | 0.199 | 2/60 | 0.096 | 73.3% | 100.0% |  |
| 0.75 | 12/169 | 0.111 | 24/128 | 0.250 | 4/60 | 0.140 | 80.8% | 100.0% |  |
| 0.80 | 16/169 | 0.138 | 34/128 | 0.334 | 6/60 | 0.182 | 88.3% | 100.0% |  |
| 0.85 | 30/169 | 0.231 | 46/128 | 0.431 | 9/60 | 0.241 | 92.9% | 100.0% |  |
| 0.90 | 53/169 | 0.375 | 62/128 | 0.557 | 17/60 | 0.387 | 97.1% | 100.0% |  |
| 0.95 | 87/169 | 0.577 | 85/128 | 0.729 | 30/60 | 0.604 | 98.8% | 100.0% |  |
| 1.00 | 110/169 | 0.708 | 98/128 | 0.821 | 44/60 | 0.816 | 99.6% | 100.0% |  |

## Every stratum at the chosen tau

| stratum | what it is | n | correct | wrong |
|---|---|---|---|---|
| U | unscoped positives | 169 | 100.0% | 0 |
| S | scoped positives | 128 | 98.4% | 2 — `s-66`, `s-112` |
| F | follow-up pairs | 60 | 100.0% | 0 |
| N1 | adjacent product, absent here | 30 | 33.3% | 20 — `n1-01`, `n1-02`, `n1-03`, `n1-04`, `n1-05`, `n1-06`, `n1-08`, `n1-09`, `n1-10`, `n1-11`, … |
| N2 | plausible-but-absent API | 30 | 16.7% | 25 — `n2-01`, `n2-02`, `n2-03`, `n2-04`, `n2-06`, `n2-07`, `n2-08`, `n2-09`, `n2-10`, `n2-11`, … |
| N3 | off-domain technical | 30 | 86.7% | 4 — `n3-04`, `n3-11`, `n3-16`, `n3-17` |
| N4 | off-domain general (blatant) | 30 | 96.7% | 1 — `n4-01` |
| N5 | off-domain after a legitimate previous turn | 30 | 66.7% | 10 — `n5-01`, `n5-02`, `n5-04`, `n5-06`, `n5-17`, `n5-19`, `n5-23`, `n5-25`, `n5-26`, `n5-27` |
| N6 | docs excerpt + off-domain ask | 30 | 16.7% | 25 — `n6-01`, `n6-02`, `n6-03`, `n6-04`, `n6-05`, `n6-06`, `n6-08`, `n6-09`, `n6-10`, `n6-12`, … |
| X | scoped, gold outside the scope | 30 | 100.0% | 0 |
| P | scoped, vocabulary overlap without the answer | 30 | 26.7% | 22 — `p-02`, `p-03`, `p-04`, `p-05`, `p-06`, `p-07`, `p-08`, `p-09`, `p-10`, `p-11`, … |

`gatePrecision` **55.4%** against a target of 60%. RAG-SPEC 5.6
step 6: it may never justify raising the threshold past the rule that chose it, and
`chooseTau()` is not given the number — the
constraint is structural, not a promise.

### Where the strata sit on the G axis

The separability question, before any threshold is chosen.

| stratum | min G | median G | max G |
|---|---|---|---|
| U | 0.589 | 0.946 | 1.000 |
| S | 0.529 | 0.904 | 1.000 |
| F | 0.650 | 0.950 | 1.000 |
| N1 | 0.315 | 0.617 | 0.938 |
| N2 | 0.510 | 0.725 | 1.000 |
| N3 | 0.295 | 0.523 | 0.662 |
| N4 | 0.000 | 0.304 | 0.666 |
| N5 | 0.000 | 0.512 | 0.875 |
| N6 | 0.435 | 0.725 | 0.917 |
| X | 0.059 | 0.307 | 0.560 |
| P | 0.293 | 0.691 | 0.958 |

## The probes that bound the chosen tau

At tau 0.58 the bound `scopedGateOverRefusal` breaks.

| probe | stratum | G | D | L | question |
|---|---|---|---|---|---|
| `s-31` | S | 0.570 | 0.594 | 0.500 | What do I have to decide myself? |

Without that probe, `tau` would be **0.59** instead of **0.57**. That is a robustness number, not a proposal: deleting the probe that pins `tau` in order to make calibration pass is the one edit this procedure exists to prevent.

## Over-refusal backlog — the ten positives closest to tau

These pass today with the least margin: the first questions a reader loses if the
threshold moves, and the shortlist for a documentation fix.

| probe | stratum | G | margin | question |
|---|---|---|---|---|
| `s-31` | S | 0.570 | 0.000 | What do I have to decide myself? |
| `u-48` | U | 0.589 | 0.019 | How does the i18n fallback work? |
| `s-03` | S | 0.593 | 0.023 | How much of the conversation is remembered? |
| `u-114` | U | 0.596 | 0.026 | What does tune cost to run? |
| `u-111` | U | 0.600 | 0.030 | What flags does eval take? |
| `u-166` | U | 0.610 | 0.040 | Что такое шлюз отказа и когда он срабатывает? |
| `u-168` | U | 0.622 | 0.052 | Где хранится история переписки? |
| `s-23` | S | 0.624 | 0.054 | How much of the golden set should a single run cover? |
| `s-22` | S | 0.625 | 0.055 | How do I grow the golden set? |
| `s-103` | S | 0.630 | 0.060 | What does tune write? |

## Refusal causes at the chosen tau (RAG-SPEC 5.6 step 3)

`X` was scored cause-agnostically during the sweep. Here the cause is checked once:
a refused `X` probe whose `wouldPassUnscoped` is false at this threshold is a
**stratum-authoring miss**, not a gate failure.

| probe | refused | wouldPassUnscoped | cause | verdict |
|---|---|---|---|---|
| `x-01` | yes | yes | `refuse:out-of-scope` | correct |
| `x-02` | yes | yes | `refuse:out-of-scope` | correct |
| `x-03` | yes | yes | `refuse:out-of-scope` | correct |
| `x-04` | yes | yes | `refuse:out-of-scope` | correct |
| `x-05` | yes | yes | `refuse:out-of-scope` | correct |
| `x-06` | yes | yes | `refuse:out-of-scope` | correct |
| `x-07` | yes | yes | `refuse:out-of-scope` | correct |
| `x-08` | yes | yes | `refuse:out-of-scope` | correct |
| `x-09` | yes | yes | `refuse:out-of-scope` | correct |
| `x-10` | yes | yes | `refuse:out-of-scope` | correct |
| `x-11` | yes | yes | `refuse:out-of-scope` | correct |
| `x-12` | yes | yes | `refuse:out-of-scope` | correct |
| `x-13` | yes | yes | `refuse:out-of-scope` | correct |
| `x-14` | yes | yes | `refuse:out-of-scope` | correct |
| `x-15` | yes | yes | `refuse:out-of-scope` | correct |
| `x-16` | yes | yes | `refuse:out-of-scope` | correct |
| `x-17` | yes | yes | `refuse:out-of-scope` | correct |
| `x-18` | yes | yes | `refuse:out-of-scope` | correct |
| `x-19` | yes | yes | `refuse:out-of-scope` | correct |
| `x-20` | yes | yes | `refuse:out-of-scope` | correct |
| `x-21` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-22` | yes | yes | `refuse:out-of-scope` | correct |
| `x-23` | yes | yes | `refuse:out-of-scope` | correct |
| `x-24` | yes | yes | `refuse:out-of-scope` | correct |
| `x-25` | yes | yes | `refuse:out-of-scope` | correct |
| `x-26` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-27` | yes | yes | `refuse:out-of-scope` | correct |
| `x-28` | yes | yes | `refuse:out-of-scope` | correct |
| `x-29` | yes | yes | `refuse:out-of-scope` | correct |
| `x-30` | yes | yes | `refuse:out-of-scope` | correct |

## Lexical-only (RAG-SPEC 5.6 step 7)

Dense disabled — the mode RAG-SPEC 3.2 defines for an unreachable embedder, where
`G = L` against `tauLexical`. Its rates are reported here and **never pooled**
with the hybrid numbers.

Step 4's selection rule is not repeated literally: RAG-SPEC 3.2 says the
single-channel invariant is *unsatisfiable by construction* in this mode, and
RAG-SPEC 5.4 gives `lexicalOnlyRefusalRate` no threshold. Applied literally, step 4
returns `tauLexical = 0.00` on this corpus — a gate that refuses nothing — because a
Russian query scores `L = 0` against an English index. The rule used instead is the
step-5 floor with the objective flipped: **the smallest `tauLexical` whose
`blatantRefusalRate >= 0.80`**, i.e. minimise over-refusal subject to the gate still
being a gate. This is an interpretation of an ambiguous step; the numbers it costs
are in the table.

| metric | value | bound |
|---|---|---|
| tauLexical | 0.51 | — |
| U over-refusal | 9/169, UB95 0.089 | none (RAG-SPEC 3.2) |
| S over-refusal | 10/128, UB95 0.126 | none (RAG-SPEC 3.2) |
| F over-refusal | 6/60, UB95 0.182 | none (RAG-SPEC 3.2) |
| gatePrecision | 68.8% | — |
| blatantRefusalRate | 83.3% | >= 80% |

### The `G_lex` sweep

Every fifth step, plus the chosen row. `chooseTauLexical` reads the `N4` column and
nothing else, so this is where the over-refusal it costs becomes visible.

| tauLexical | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 |
|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/169 | 0.016 | 0/128 | 0.021 | 0/60 | 0.043 | 0.0% | 0.0% |
| 0.05 | 3/169 | 0.044 | 1/128 | 0.034 | 5/60 | 0.161 | 13.3% | 20.0% |
| 0.10 | 3/169 | 0.044 | 1/128 | 0.034 | 5/60 | 0.161 | 13.3% | 20.0% |
| 0.15 | 3/169 | 0.044 | 1/128 | 0.034 | 5/60 | 0.161 | 13.3% | 20.0% |
| 0.20 | 3/169 | 0.044 | 1/128 | 0.034 | 5/60 | 0.161 | 13.8% | 20.0% |
| 0.25 | 3/169 | 0.044 | 1/128 | 0.034 | 5/60 | 0.161 | 17.1% | 30.0% |
| 0.30 | 3/169 | 0.044 | 1/128 | 0.034 | 5/60 | 0.161 | 24.6% | 43.3% |
| 0.35 | 4/169 | 0.052 | 1/128 | 0.034 | 5/60 | 0.161 | 36.7% | 66.7% |
| 0.40 | 4/169 | 0.052 | 1/128 | 0.034 | 5/60 | 0.161 | 37.9% | 66.7% |
| 0.45 | 5/169 | 0.060 | 1/128 | 0.034 | 5/60 | 0.161 | 45.8% | 66.7% |
| 0.50 | 5/169 | 0.060 | 1/128 | 0.034 | 5/60 | 0.161 | 45.8% | 66.7% |
| 0.51 | 9/169 | 0.089 | 10/128 | 0.126 | 6/60 | 0.182 | 68.8% | 83.3% |
| 0.55 | 9/169 | 0.089 | 10/128 | 0.126 | 6/60 | 0.182 | 68.8% | 83.3% |
| 0.60 | 9/169 | 0.089 | 10/128 | 0.126 | 6/60 | 0.182 | 70.8% | 83.3% |
| 0.65 | 12/169 | 0.111 | 10/128 | 0.126 | 7/60 | 0.202 | 80.4% | 90.0% |
| 0.70 | 22/169 | 0.179 | 24/128 | 0.250 | 9/60 | 0.241 | 87.1% | 93.3% |
| 0.75 | 22/169 | 0.179 | 24/128 | 0.250 | 9/60 | 0.241 | 88.3% | 93.3% |
| 0.80 | 31/169 | 0.237 | 36/128 | 0.351 | 12/60 | 0.297 | 93.3% | 96.7% |
| 0.85 | 40/169 | 0.294 | 40/128 | 0.383 | 20/60 | 0.439 | 96.7% | 96.7% |
| 0.90 | 40/169 | 0.294 | 40/128 | 0.383 | 21/60 | 0.456 | 96.7% | 96.7% |
| 0.95 | 40/169 | 0.294 | 40/128 | 0.383 | 21/60 | 0.456 | 96.7% | 96.7% |
| 1.00 | 40/169 | 0.294 | 40/128 | 0.383 | 21/60 | 0.456 | 96.7% | 96.7% |

## zExp ladder (RAG-SPEC 3.4.1)

Median of `(max c − m)/s` over the unscoped positives, at real page-contiguous
scopes — never random chunk samples, because adjacent paragraphs of one page are
exactly the correlation the ladder exists to measure.

| n | z | closed form sqrt(2·ln n) |
|---|---|---|
| 7 | 1.1791 | 1.9728 |
| 11 | 1.3869 | 2.1899 |
| 25 | 1.8294 | 2.5373 |
| 48 | 2.2552 | 2.7825 |
| 111 | 2.871 | 3.0690 |
| 320 | 3.9983 | 3.3966 |
| 493 | 4.7299 | 3.5215 |
| 493 | 4.7299 | 3.5215 |

`denseMode` is `cosine` on this index, so the ladder is **inert**:
`zExp(n)` is only consulted in `zscore` mode. It is measured and recorded anyway so
that a swap to an anisotropic embed model cannot silently inherit the closed form.

## retrievalMisses

**Bound not armed.** No probe in `docpilot/calibration.jsonl` carries a `gold_page`, so there is nothing to measure retrieval misses over. The 5% floor cannot fail and cannot pass; add `gold_page` to the positives to arm it.

Measured at PAGE level through `retrieval.closest()`: RAG-SPEC 5.6 step 1 gives the
probe set no gold chunk ids, so `gold_page` is the granularity available. Page level
is the more forgiving of the two — a miss reported here is a miss at chunk level too.
