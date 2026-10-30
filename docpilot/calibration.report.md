# Gate calibration — `37991d24`

Produced by `npx docpilot calibrate` (RAG-SPEC 5.6). Embed endpoint only — no chat model,
no LLM judge, no unseeded randomness. Same corpus + same probes ⇒ same output.

| | |
|---|---|
| index | `37991d24`, 856 chunks, bge-m3 |
| probes | 631 from `docpilot/calibration.jsonl` |
| **tau** | **0.68** |
| **tauLexical** | **0.51** |
| wDense / wLexical | 0.75 / 0.25 |
| denseMode | cosine, window [0.26, 0.62] |
| source | `calibrated-reduced` |
| gatePrecision | 58.2% (target 60%, never a constraint) |

## Probe set, and what the reduction costs

RAG-SPEC 5.6 sizes the strata at ~540 probes so `UB95 <= 0.05` is reachable.
With zero failures `UB95(0,n) = z²/(n+z²)`, `z = 1.6449`, so the 5% bound is
**unreachable below n = 52** whatever the gate does, and the 8% bound below n = 32.
This run keeps the three bounded positive strata above those floors and cuts the
negatives, which are a target (`gatePrecision >= 0.60`) and never a constraint.

| stratum | spec n | this run | UB95 at 0 failures | UB95 at spec n | cost of the cut |
|---|---|---|---|---|---|
| U | 180 | 169 | 0.016 | 0.015 | +0.001 |
| S | 60 | 123 | 0.022 | 0.043 | −0.022 |
| F | 60 | 90 | 0.029 | 0.043 | −0.014 |
| N1 | 30 | 30 | 0.083 | 0.083 | — |
| N2 | 30 | 30 | 0.083 | 0.083 | — |
| N3 | 30 | 30 | 0.083 | 0.083 | — |
| N4 | 30 | 30 | 0.083 | 0.083 | — |
| N5 | 30 | 40 | 0.063 | 0.083 | −0.019 |
| N6 | 30 | 30 | 0.083 | 0.083 | — |
| X | 30 | 30 | 0.083 | 0.083 | — |
| P | 30 | 29 | 0.085 | 0.083 | +0.003 |

The interval width is not the whole cost. What actually decides whether a bound can
bind is how many failures it tolerates at the n it has:

| bound | stratum | n | ceiling | failures tolerated | n needed for 1 |
|---|---|---|---|---|---|
| `gateOverRefusal` | U | 169 (spec 180) | 0.05 | **3** | 87 |
| `scopedGateOverRefusal` | S | 123 (spec 60) | 0.05 | **2** | 87 |
| `followupRefusalRate` | F | 90 (spec 60) | 0.08 | **2** | 54 |

## Sweep (RAG-SPEC 5.6 step 3)

`X` probes are scored on refusal alone, cause-agnostic, during the sweep —
`wouldPassUnscoped` is itself a function of tau. The cause is checked once, below.
Positives that are `retrievalMisses` are excluded from the three bounds (RAG-SPEC 5.4).

| tau | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 | feasible |
|---|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 0.0% | 0.0% | yes |
| 0.05 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 0.8% | 3.3% | yes |
| 0.10 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 0.8% | 3.3% | yes |
| 0.15 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 2.4% | 10.0% | yes |
| 0.20 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 2.4% | 10.0% | yes |
| 0.25 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 4.0% | 16.7% | yes |
| 0.30 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 4.8% | 16.7% | yes |
| 0.35 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 10.8% | 36.7% | yes |
| 0.40 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 18.9% | 56.7% | yes |
| 0.45 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 24.9% | 73.3% | yes |
| 0.50 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 31.3% | 86.7% | yes |
| 0.55 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 36.1% | 90.0% | yes |
| 0.60 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 42.6% | 90.0% | yes |
| 0.65 | 2/169 | 0.035 | 2/123 | 0.048 | 0/90 | 0.029 | 52.6% | 96.7% | yes |
| 0.68 | 3/169 | 0.044 | 2/123 | 0.048 | 1/90 | 0.048 | 58.2% | 96.7% | yes |
| 0.70 | 5/169 | 0.060 | 8/123 | 0.112 | 1/90 | 0.048 | 60.2% | 96.7% |  |
| 0.75 | 6/169 | 0.067 | 15/123 | 0.179 | 2/90 | 0.065 | 69.9% | 100.0% |  |
| 0.80 | 10/169 | 0.097 | 22/123 | 0.242 | 12/90 | 0.203 | 80.7% | 100.0% |  |
| 0.85 | 16/169 | 0.138 | 31/123 | 0.321 | 16/90 | 0.253 | 87.6% | 100.0% |  |
| 0.90 | 30/169 | 0.231 | 51/123 | 0.489 | 22/90 | 0.326 | 95.2% | 100.0% |  |
| 0.95 | 64/169 | 0.442 | 71/123 | 0.648 | 42/90 | 0.553 | 98.4% | 100.0% |  |
| 1.00 | 94/169 | 0.618 | 86/123 | 0.762 | 64/90 | 0.783 | 98.8% | 100.0% |  |

## Every stratum at the chosen tau

| stratum | what it is | n | correct | wrong |
|---|---|---|---|---|
| U | unscoped positives | 169 | 98.2% | 3 — `u-42`, `u-48`, `u-166` |
| S | scoped positives | 123 | 98.4% | 2 — `s-66`, `s-87` |
| F | follow-up pairs | 90 | 98.9% | 1 — `f-80` |
| N1 | adjacent product, absent here | 30 | 46.7% | 16 — `n1-01`, `n1-02`, `n1-03`, `n1-04`, `n1-05`, `n1-06`, `n1-09`, `n1-10`, `n1-11`, `n1-13`, … |
| N2 | plausible-but-absent API | 30 | 16.7% | 25 — `n2-01`, `n2-02`, `n2-03`, `n2-04`, `n2-06`, `n2-07`, `n2-08`, `n2-09`, `n2-10`, `n2-11`, … |
| N3 | off-domain technical | 30 | 80.0% | 6 — `n3-03`, `n3-04`, `n3-11`, `n3-15`, `n3-16`, `n3-17` |
| N4 | off-domain general (blatant) | 30 | 96.7% | 1 — `n4-01` |
| N5 | off-domain after a legitimate previous turn | 40 | 62.5% | 15 — `n5-01`, `n5-02`, `n5-04`, `n5-06`, `n5-11`, `n5-19`, `n5-25`, `n5-26`, `n5-27`, `n5-28`, … |
| N6 | docs excerpt + off-domain ask | 30 | 23.3% | 23 — `n6-01`, `n6-02`, `n6-03`, `n6-04`, `n6-05`, `n6-06`, `n6-08`, `n6-09`, `n6-10`, `n6-12`, … |
| X | scoped, gold outside the scope | 30 | 96.7% | 1 — `x-16` |
| P | scoped, vocabulary overlap without the answer | 29 | 41.4% | 17 — `p-02`, `p-03`, `p-05`, `p-06`, `p-07`, `p-08`, `p-09`, `p-10`, `p-11`, `p-12`, … |

`gatePrecision` **58.2%** against a target of 60%. RAG-SPEC 5.6
step 6: it may never justify raising the threshold past the rule that chose it, and
`chooseTau()` is not given the number — the
constraint is structural, not a promise.

### Where the strata sit on the G axis

The separability question, before any threshold is chosen.

| stratum | min G | median G | max G |
|---|---|---|---|
| U | 0.634 | 0.986 | 1.000 |
| S | 0.618 | 0.931 | 1.000 |
| F | 0.668 | 0.950 | 1.000 |
| N1 | 0.389 | 0.700 | 0.938 |
| N2 | 0.573 | 0.792 | 1.000 |
| N3 | 0.385 | 0.606 | 0.754 |
| N4 | 0.038 | 0.394 | 0.726 |
| N5 | 0.038 | 0.625 | 0.929 |
| N6 | 0.499 | 0.759 | 0.890 |
| X | 0.228 | 0.406 | 0.708 |
| P | 0.354 | 0.743 | 1.000 |

## The probes that bound the chosen tau

At tau 0.69 the bounds `gateOverRefusal`, `scopedGateOverRefusal` break.

| probe | stratum | G | D | L | question |
|---|---|---|---|---|---|
| `u-76` | U | 0.687 | 0.783 | 0.400 | How do I verify a production deployment is wired correctly? |
| `s-03` | S | 0.683 | 0.745 | 0.500 | How much of the conversation is remembered? |
| `s-22` | S | 0.683 | 0.688 | 0.667 | How do I grow the golden set? |
| `s-23` | S | 0.684 | 0.645 | 0.800 | How much of the golden set should a single run cover? |

Without those probes, `tau` would be **0.69** instead of **0.68**. That is a robustness number, not a proposal: deleting the probe that pins `tau` in order to make calibration pass is the one edit this procedure exists to prevent.

## Over-refusal backlog — the ten positives closest to tau

These pass today with the least margin: the first questions a reader loses if the
threshold moves, and the shortlist for a documentation fix.

| probe | stratum | G | margin | question |
|---|---|---|---|---|
| `s-22` | S | 0.683 | 0.003 | How do I grow the golden set? |
| `s-03` | S | 0.683 | 0.004 | How much of the conversation is remembered? |
| `s-23` | S | 0.684 | 0.004 | How much of the golden set should a single run cover? |
| `u-76` | U | 0.688 | 0.007 | How do I verify a production deployment is wired correctly? |
| `s-103` | S | 0.692 | 0.012 | What does tune write? |
| `s-112` | S | 0.696 | 0.016 | What does guard accept? |
| `s-36` | S | 0.699 | 0.019 | How does fallback work per leaf? |
| `u-168` | U | 0.699 | 0.019 | Где хранится история переписки? |
| `s-08` | S | 0.701 | 0.021 | What two channels feed the gate? |
| `f-41` | F | 0.702 | 0.022 | And what are its two channels? |

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
| S over-refusal | 9/123, UB95 0.122 | none (RAG-SPEC 3.2) |
| F over-refusal | 14/90, UB95 0.228 | none (RAG-SPEC 3.2) |
| gatePrecision | 68.3% | — |
| blatantRefusalRate | 86.7% | >= 80% |

### The `G_lex` sweep

Every fifth step, plus the chosen row. `chooseTauLexical` reads the `N4` column and
nothing else, so this is where the over-refusal it costs becomes visible.

| tauLexical | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 |
|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/169 | 0.016 | 0/123 | 0.022 | 0/90 | 0.029 | 0.0% | 0.0% |
| 0.05 | 3/169 | 0.044 | 0/123 | 0.022 | 11/90 | 0.190 | 10.0% | 16.7% |
| 0.10 | 3/169 | 0.044 | 0/123 | 0.022 | 11/90 | 0.190 | 10.0% | 16.7% |
| 0.15 | 3/169 | 0.044 | 0/123 | 0.022 | 11/90 | 0.190 | 10.0% | 16.7% |
| 0.20 | 3/169 | 0.044 | 0/123 | 0.022 | 12/90 | 0.203 | 10.0% | 16.7% |
| 0.25 | 3/169 | 0.044 | 0/123 | 0.022 | 12/90 | 0.203 | 13.3% | 23.3% |
| 0.30 | 3/169 | 0.044 | 0/123 | 0.022 | 12/90 | 0.203 | 22.1% | 40.0% |
| 0.35 | 4/169 | 0.052 | 0/123 | 0.022 | 12/90 | 0.203 | 35.7% | 66.7% |
| 0.40 | 4/169 | 0.052 | 0/123 | 0.022 | 12/90 | 0.203 | 36.9% | 66.7% |
| 0.45 | 5/169 | 0.060 | 0/123 | 0.022 | 12/90 | 0.203 | 45.4% | 73.3% |
| 0.50 | 5/169 | 0.060 | 0/123 | 0.022 | 12/90 | 0.203 | 45.4% | 73.3% |
| 0.51 | 9/169 | 0.089 | 9/123 | 0.122 | 14/90 | 0.228 | 68.3% | 86.7% |
| 0.55 | 9/169 | 0.089 | 9/123 | 0.122 | 14/90 | 0.228 | 68.3% | 86.7% |
| 0.60 | 9/169 | 0.089 | 9/123 | 0.122 | 14/90 | 0.228 | 71.5% | 86.7% |
| 0.65 | 9/169 | 0.089 | 9/123 | 0.122 | 15/90 | 0.241 | 79.5% | 90.0% |
| 0.70 | 18/169 | 0.152 | 25/123 | 0.269 | 18/90 | 0.278 | 85.1% | 93.3% |
| 0.75 | 18/169 | 0.152 | 25/123 | 0.269 | 19/90 | 0.290 | 86.3% | 93.3% |
| 0.80 | 29/169 | 0.224 | 36/123 | 0.364 | 23/90 | 0.338 | 91.6% | 96.7% |
| 0.85 | 41/169 | 0.301 | 39/123 | 0.389 | 31/90 | 0.430 | 95.2% | 96.7% |
| 0.90 | 42/169 | 0.307 | 39/123 | 0.389 | 33/90 | 0.453 | 95.6% | 96.7% |
| 0.95 | 42/169 | 0.307 | 39/123 | 0.389 | 34/90 | 0.464 | 95.6% | 96.7% |
| 1.00 | 42/169 | 0.307 | 39/123 | 0.389 | 34/90 | 0.464 | 95.6% | 96.7% |

## zExp ladder (RAG-SPEC 3.4.1)

Median of `(max c − m)/s` over the unscoped positives, at real page-contiguous
scopes — never random chunk samples, because adjacent paragraphs of one page are
exactly the correlation the ladder exists to measure.

| n | z | closed form sqrt(2·ln n) |
|---|---|---|
| 8 | 0.9897 | 2.0393 |
| 9 | 1.1833 | 2.0963 |
| 23 | 1.8844 | 2.5042 |
| 45 | 2.1406 | 2.7592 |
| 107 | 2.7383 | 3.0571 |
| 308 | 3.7328 | 3.3853 |
| 715 | 4.5963 | 3.6255 |
| 856 | 4.8636 | 3.6749 |

`denseMode` is `cosine` on this index, so the ladder is **inert**:
`zExp(n)` is only consulted in `zscore` mode. It is measured and recorded anyway so
that a swap to an anisotropic embed model cannot silently inherit the closed form.

## retrievalMisses

0/29 positives carrying a gold page (0.0%, bound 5%).

Measured at PAGE level through `retrieval.closest()`: RAG-SPEC 5.6 step 1 gives the
probe set no gold chunk ids, so `gold_page` is the granularity available. Page level
is the more forgiving of the two — a miss reported here is a miss at chunk level too.
