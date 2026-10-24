# Gate calibration — `aa4d756c`

Produced by `npx docpilot calibrate` (RAG-SPEC 5.6). Embed endpoint only — no chat model,
no LLM judge, no unseeded randomness. Same corpus + same probes ⇒ same output.

| | |
|---|---|
| index | `aa4d756c`, 584 chunks, bge-m3 |
| probes | 639 from `docpilot/calibration.jsonl` |
| **tau** | **0.35** |
| **tauLexical** | **0.51** |
| wDense / wLexical | 0.75 / 0.25 |
| denseMode | cosine, window [0.4, 0.74] |
| source | `calibrated-reduced` |
| gatePrecision | 52.4% (target 60%, never a constraint) |

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
| F | 60 | 92 | 0.029 | 0.043 | −0.015 |
| N1 | 30 | 30 | 0.083 | 0.083 | — |
| N2 | 30 | 30 | 0.083 | 0.083 | — |
| N3 | 30 | 30 | 0.083 | 0.083 | — |
| N4 | 30 | 30 | 0.083 | 0.083 | — |
| N5 | 30 | 40 | 0.063 | 0.083 | −0.019 |
| N6 | 30 | 30 | 0.083 | 0.083 | — |
| X | 30 | 30 | 0.083 | 0.083 | — |
| P | 30 | 30 | 0.083 | 0.083 | — |

The interval width is not the whole cost. What actually decides whether a bound can
bind is how many failures it tolerates at the n it has:

| bound | stratum | n | ceiling | failures tolerated | n needed for 1 |
|---|---|---|---|---|---|
| `gateOverRefusal` | U | 169 (spec 180) | 0.05 | **3** | 87 |
| `scopedGateOverRefusal` | S | 128 (spec 60) | 0.05 | **2** | 87 |
| `followupRefusalRate` | F | 92 (spec 60) | 0.08 | **3** | 54 |

## Sweep (RAG-SPEC 5.6 step 3)

`X` probes are scored on refusal alone, cause-agnostic, during the sweep —
`wouldPassUnscoped` is itself a function of tau. The cause is checked once, below.
Positives that are `retrievalMisses` are excluded from the three bounds (RAG-SPEC 5.4).

| tau | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 | feasible |
|---|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 0.0% | 0.0% | yes |
| 0.05 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 4.8% | 10.0% | yes |
| 0.10 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 16.0% | 40.0% | yes |
| 0.15 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 21.6% | 60.0% | yes |
| 0.20 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 29.6% | 86.7% | yes |
| 0.25 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 35.6% | 90.0% | yes |
| 0.30 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 40.8% | 93.3% | yes |
| 0.35 | 0/169 | 0.016 | 2/128 | 0.046 | 1/92 | 0.047 | 52.4% | 96.7% | yes |
| 0.40 | 3/169 | 0.044 | 3/128 | 0.057 | 1/92 | 0.047 | 60.8% | 96.7% |  |
| 0.45 | 6/169 | 0.067 | 13/128 | 0.154 | 4/92 | 0.093 | 68.0% | 100.0% |  |
| 0.50 | 11/169 | 0.104 | 19/128 | 0.207 | 9/92 | 0.161 | 75.2% | 100.0% |  |
| 0.55 | 14/169 | 0.125 | 24/128 | 0.250 | 15/92 | 0.236 | 82.0% | 100.0% |  |
| 0.60 | 19/169 | 0.159 | 38/128 | 0.367 | 18/92 | 0.272 | 88.4% | 100.0% |  |
| 0.65 | 41/169 | 0.301 | 51/128 | 0.471 | 22/92 | 0.319 | 94.8% | 100.0% |  |
| 0.70 | 55/169 | 0.387 | 71/128 | 0.625 | 32/92 | 0.433 | 96.0% | 100.0% |  |
| 0.75 | 86/169 | 0.571 | 87/128 | 0.743 | 40/92 | 0.520 | 97.2% | 100.0% |  |
| 0.80 | 107/169 | 0.692 | 101/128 | 0.842 | 55/92 | 0.678 | 98.4% | 100.0% |  |
| 0.85 | 127/169 | 0.802 | 113/128 | 0.922 | 67/92 | 0.797 | 99.2% | 100.0% |  |
| 0.90 | 146/169 | 0.902 | 122/128 | 0.976 | 75/92 | 0.872 | 100.0% | 100.0% |  |
| 0.95 | 162/169 | 0.977 | 125/128 | 0.991 | 83/92 | 0.942 | 100.0% | 100.0% |  |
| 1.00 | 166/169 | 0.993 | 128/128 | 1.000 | 91/92 | 0.998 | 100.0% | 100.0% |  |

## Every stratum at the chosen tau

| stratum | what it is | n | correct | wrong |
|---|---|---|---|---|
| U | unscoped positives | 169 | 100.0% | 0 |
| S | scoped positives | 128 | 98.4% | 2 — `s-66`, `s-87` |
| F | follow-up pairs | 92 | 98.9% | 1 — `f-80` |
| N1 | adjacent product, absent here | 30 | 33.3% | 20 — `n1-01`, `n1-02`, `n1-03`, `n1-04`, `n1-05`, `n1-06`, `n1-08`, `n1-09`, `n1-10`, `n1-11`, … |
| N2 | plausible-but-absent API | 30 | 16.7% | 25 — `n2-01`, `n2-02`, `n2-03`, `n2-04`, `n2-06`, `n2-07`, `n2-08`, `n2-09`, `n2-10`, `n2-11`, … |
| N3 | off-domain technical | 30 | 73.3% | 8 — `n3-03`, `n3-04`, `n3-07`, `n3-11`, `n3-16`, `n3-17`, `n3-21`, `n3-24` |
| N4 | off-domain general (blatant) | 30 | 96.7% | 1 — `n4-01` |
| N5 | off-domain after a legitimate previous turn | 40 | 60.0% | 16 — `n5-01`, `n5-02`, `n5-04`, `n5-06`, `n5-07`, `n5-11`, `n5-17`, `n5-19`, `n5-23`, `n5-26`, … |
| N6 | docs excerpt + off-domain ask | 30 | 13.3% | 26 — `n6-01`, `n6-02`, `n6-03`, `n6-04`, `n6-05`, `n6-06`, `n6-08`, `n6-09`, `n6-10`, `n6-12`, … |
| X | scoped, gold outside the scope | 30 | 96.7% | 1 — `x-16` |
| P | scoped, vocabulary overlap without the answer | 30 | 26.7% | 22 — `p-02`, `p-03`, `p-04`, `p-05`, `p-06`, `p-07`, `p-08`, `p-09`, `p-10`, `p-11`, … |

`gatePrecision` **52.4%** against a target of 60%. RAG-SPEC 5.6
step 6: it may never justify raising the threshold past the rule that chose it, and
`chooseTau()` is not given the number — the
constraint is structural, not a promise.

### Where the strata sit on the G axis

The separability question, before any threshold is chosen.

| stratum | min G | median G | max G |
|---|---|---|---|
| U | 0.368 | 0.750 | 1.000 |
| S | 0.332 | 0.681 | 0.979 |
| F | 0.306 | 0.773 | 1.000 |
| N1 | 0.155 | 0.436 | 0.792 |
| N2 | 0.274 | 0.522 | 0.880 |
| N3 | 0.084 | 0.317 | 0.442 |
| N4 | 0.000 | 0.125 | 0.445 |
| N5 | 0.000 | 0.310 | 0.857 |
| N6 | 0.213 | 0.505 | 0.772 |
| X | 0.000 | 0.118 | 0.372 |
| P | 0.067 | 0.502 | 0.849 |

## The probes that bound the chosen tau

At tau 0.36 the bound `scopedGateOverRefusal` breaks.

| probe | stratum | G | D | L | question |
|---|---|---|---|---|---|
| `s-31` | S | 0.350 | 0.300 | 0.500 | What do I have to decide myself? |

Without that probe, `tau` would be **0.40** instead of **0.35**. That is a robustness number, not a proposal: deleting the probe that pins `tau` in order to make calibration pass is the one edit this procedure exists to prevent.

## Over-refusal backlog — the ten positives closest to tau

These pass today with the least margin: the first questions a reader loses if the
threshold moves, and the shortlist for a documentation fix.

| probe | stratum | G | margin | question |
|---|---|---|---|---|
| `s-31` | S | 0.350 | 0.000 | What do I have to decide myself? |
| `u-48` | U | 0.368 | 0.018 | How does the i18n fallback work? |
| `u-111` | U | 0.379 | 0.029 | What flags does eval take? |
| `u-166` | U | 0.398 | 0.048 | Что такое шлюз отказа и когда он срабатывает? |
| `s-23` | S | 0.401 | 0.051 | How much of the golden set should a single run cover? |
| `u-168` | U | 0.401 | 0.051 | Где хранится история переписки? |
| `s-22` | S | 0.404 | 0.054 | How do I grow the golden set? |
| `s-03` | S | 0.407 | 0.058 | How much of the conversation is remembered? |
| `s-103` | S | 0.409 | 0.059 | What does tune write? |
| `u-114` | U | 0.416 | 0.066 | What does tune cost to run? |

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
| `x-16` | no | yes | — | ESCAPED |
| `x-17` | yes | yes | `refuse:out-of-scope` | correct |
| `x-18` | yes | yes | `refuse:out-of-scope` | correct |
| `x-19` | yes | yes | `refuse:out-of-scope` | correct |
| `x-20` | yes | yes | `refuse:out-of-scope` | correct |
| `x-21` | yes | yes | `refuse:out-of-scope` | correct |
| `x-22` | yes | yes | `refuse:out-of-scope` | correct |
| `x-23` | yes | yes | `refuse:out-of-scope` | correct |
| `x-24` | yes | yes | `refuse:out-of-scope` | correct |
| `x-25` | yes | yes | `refuse:out-of-scope` | correct |
| `x-26` | yes | yes | `refuse:out-of-scope` | correct |
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
| F over-refusal | 16/92, UB95 0.248 | none (RAG-SPEC 3.2) |
| gatePrecision | 67.6% | — |
| blatantRefusalRate | 86.7% | >= 80% |

### The `G_lex` sweep

Every fifth step, plus the chosen row. `chooseTauLexical` reads the `N4` column and
nothing else, so this is where the over-refusal it costs becomes visible.

| tauLexical | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 |
|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/169 | 0.016 | 0/128 | 0.021 | 0/92 | 0.029 | 0.0% | 0.0% |
| 0.05 | 3/169 | 0.044 | 0/128 | 0.021 | 12/92 | 0.199 | 12.4% | 20.0% |
| 0.10 | 3/169 | 0.044 | 0/128 | 0.021 | 12/92 | 0.199 | 12.4% | 20.0% |
| 0.15 | 3/169 | 0.044 | 0/128 | 0.021 | 12/92 | 0.199 | 12.4% | 20.0% |
| 0.20 | 3/169 | 0.044 | 0/128 | 0.021 | 13/92 | 0.211 | 12.8% | 20.0% |
| 0.25 | 3/169 | 0.044 | 0/128 | 0.021 | 13/92 | 0.211 | 16.0% | 26.7% |
| 0.30 | 3/169 | 0.044 | 0/128 | 0.021 | 13/92 | 0.211 | 23.6% | 40.0% |
| 0.35 | 4/169 | 0.052 | 0/128 | 0.021 | 14/92 | 0.224 | 34.8% | 63.3% |
| 0.40 | 4/169 | 0.052 | 0/128 | 0.021 | 14/92 | 0.224 | 36.0% | 63.3% |
| 0.45 | 5/169 | 0.060 | 0/128 | 0.021 | 14/92 | 0.224 | 44.8% | 70.0% |
| 0.50 | 5/169 | 0.060 | 0/128 | 0.021 | 14/92 | 0.224 | 44.8% | 70.0% |
| 0.51 | 9/169 | 0.089 | 10/128 | 0.126 | 16/92 | 0.248 | 67.6% | 86.7% |
| 0.55 | 9/169 | 0.089 | 10/128 | 0.126 | 16/92 | 0.248 | 67.6% | 86.7% |
| 0.60 | 9/169 | 0.089 | 10/128 | 0.126 | 16/92 | 0.248 | 69.2% | 86.7% |
| 0.65 | 11/169 | 0.104 | 10/128 | 0.126 | 17/92 | 0.260 | 78.8% | 90.0% |
| 0.70 | 22/169 | 0.179 | 26/128 | 0.267 | 19/92 | 0.284 | 85.6% | 93.3% |
| 0.75 | 22/169 | 0.179 | 26/128 | 0.267 | 20/92 | 0.296 | 87.2% | 93.3% |
| 0.80 | 32/169 | 0.244 | 38/128 | 0.367 | 25/92 | 0.354 | 92.0% | 96.7% |
| 0.85 | 42/169 | 0.307 | 41/128 | 0.391 | 35/92 | 0.466 | 95.2% | 96.7% |
| 0.90 | 43/169 | 0.313 | 41/128 | 0.391 | 38/92 | 0.499 | 95.6% | 96.7% |
| 0.95 | 43/169 | 0.313 | 41/128 | 0.391 | 39/92 | 0.510 | 95.6% | 96.7% |
| 1.00 | 43/169 | 0.313 | 41/128 | 0.391 | 39/92 | 0.510 | 95.6% | 96.7% |

## zExp ladder (RAG-SPEC 3.4.1)

Median of `(max c − m)/s` over the unscoped positives, at real page-contiguous
scopes — never random chunk samples, because adjacent paragraphs of one page are
exactly the correlation the ladder exists to measure.

| n | z | closed form sqrt(2·ln n) |
|---|---|---|
| 8 | 1.1257 | 2.0393 |
| 11 | 1.2468 | 2.1899 |
| 25 | 1.8666 | 2.5373 |
| 50 | 2.1675 | 2.7971 |
| 114 | 2.9164 | 3.0777 |
| 309 | 4.0093 | 3.3862 |
| 584 | 4.854 | 3.5693 |
| 584 | 4.854 | 3.5693 |

`denseMode` is `cosine` on this index, so the ladder is **inert**:
`zExp(n)` is only consulted in `zscore` mode. It is measured and recorded anyway so
that a swap to an anisotropic embed model cannot silently inherit the closed form.

## retrievalMisses

0/31 positives carrying a gold page (0.0%, bound 5%).

Measured at PAGE level through `retrieval.closest()`: RAG-SPEC 5.6 step 1 gives the
probe set no gold chunk ids, so `gold_page` is the granularity available. Page level
is the more forgiving of the two — a miss reported here is a miss at chunk level too.
