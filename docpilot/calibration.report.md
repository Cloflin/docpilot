# Gate calibration — `ab42d56c`

Produced by `npx docpilot calibrate` (RAG-SPEC 5.6). Embed endpoint only — no chat model,
no LLM judge, no unseeded randomness. Same corpus + same probes ⇒ same output.

| | |
|---|---|
| index | `ab42d56c`, 477 chunks, nvidia/nemotron-3-embed-1b:free |
| probes | 271 from `docpilot/calibration.jsonl` |
| **tau** | **0.69** |
| **tauLexical** | **0.51** |
| wDense / wLexical | 0.75 / 0.25 |
| denseMode | cosine, window [0.04, 0.18] |
| source | `transferred-window` |
| gatePrecision | — (target 60%, never a constraint) |

## Probe set, and what the reduction costs

RAG-SPEC 5.6 sizes the strata at ~540 probes so `UB95 <= 0.05` is reachable.
With zero failures `UB95(0,n) = z²/(n+z²)`, `z = 1.6449`, so the 5% bound is
**unreachable below n = 52** whatever the gate does, and the 8% bound below n = 32.
This run keeps the three bounded positive strata above those floors and cuts the
negatives, which are a target (`gatePrecision >= 0.60`) and never a constraint.

| stratum | spec n | this run | UB95 at 0 failures | UB95 at spec n | cost of the cut |
|---|---|---|---|---|---|
| U | 180 | 52 | 0.049 | 0.015 | +0.035 |
| S | 60 | 52 | 0.049 | 0.043 | +0.006 |
| F | 60 | 32 | 0.078 | 0.043 | +0.035 |
| N1 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N2 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N3 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N4 | 30 | 30 | 0.083 | 0.083 | — |
| N5 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N6 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| X | 30 | 15 | 0.153 | 0.083 | +0.070 |
| P | 30 | 15 | 0.153 | 0.083 | +0.070 |

The interval width is not the whole cost. What actually decides whether a bound can
bind is how many failures it tolerates at the n it has:

| bound | stratum | n | ceiling | failures tolerated | n needed for 1 |
|---|---|---|---|---|---|
| `gateOverRefusal` | U | 52 (spec 180) | 0.05 | **0** | 87 |
| `scopedGateOverRefusal` | S | 52 (spec 60) | 0.05 | **0** | 87 |
| `followupRefusalRate` | F | 32 (spec 60) | 0.08 | **0** | 54 |

`gateOverRefusal` and `scopedGateOverRefusal` and `followupRefusalRate` tolerate **zero** failures at this n: a single refused probe decides `tau`. That is the outcome RAG-SPEC 5.4 introduced UB95 to prevent, and for `gateOverRefusal` it persists at the spec's own n = 180 — the bound needs n = 87 before one failure is survivable. Read `tau` accordingly.

## Sweep (RAG-SPEC 5.6 step 3)

`X` probes are scored on refusal alone, cause-agnostic, during the sweep —
`wouldPassUnscoped` is itself a function of tau. The cause is checked once, below.
Positives that are `retrievalMisses` are excluded from the three bounds (RAG-SPEC 5.4).

| tau | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 | feasible |
|---|---|---|---|---|---|---|---|---|---|

## Every stratum at the chosen tau

| stratum | what it is | n | correct | wrong |
|---|---|---|---|---|

`gatePrecision` **—** against a target of 60%. RAG-SPEC 5.6
step 6: it may never justify raising the threshold past the rule that chose it, and
`chooseTau()` is not given the number — the
constraint is structural, not a promise.

### Where the strata sit on the G axis

The separability question, before any threshold is chosen.

| stratum | min G | median G | max G |
|---|---|---|---|
| U | 0.850 | 1.000 | 1.000 |
| S | 0.693 | 1.000 | 1.000 |
| F | 0.850 | 1.000 | 1.000 |
| N1 | 0.750 | 0.875 | 1.000 |
| N2 | 0.850 | 0.875 | 0.917 |
| N3 | 0.438 | 0.813 | 0.906 |
| N4 | 0.210 | 0.425 | 0.861 |
| N5 | 0.228 | 0.812 | 1.000 |
| N6 | 0.574 | 0.875 | 0.938 |
| X | 0.023 | 0.532 | 0.850 |
| P | 0.596 | 0.900 | 0.958 |

## The probes that bound the chosen tau

No positive probe flips at tau + 0.01, so `tau` is not bounded by a named probe.

## Over-refusal backlog — the ten positives closest to tau

These pass today with the least margin: the first questions a reader loses if the
threshold moves, and the shortlist for a documentation fix.

| probe | stratum | G | margin | question |
|---|---|---|---|---|
| `s-16` | S | 0.693 | 0.003 | How is the money arranged compared to the alternatives? |
| `s-112` | S | 0.750 | 0.060 | What does guard accept? |
| `s-105` | S | 0.794 | 0.104 | What is the step everyone forgets? |
| `u-76` | U | 0.850 | 0.160 | How do I verify a production deployment is wired correctly? |
| `f-37` | F | 0.850 | 0.160 | А какие у него два канала? |
| `s-57` | S | 0.866 | 0.175 | What does "measured, not chosen" mean here? |
| `s-03` | S | 0.875 | 0.185 | How much of the conversation is remembered? |
| `s-47` | S | 0.875 | 0.185 | Whose plugin generates llms.txt? |
| `s-66` | S | 0.875 | 0.185 | How do I verify the deployment? |
| `u-12` | U | 0.917 | 0.227 | How does the gate treat a follow-up question differently from a first question? |

## Refusal causes at the chosen tau (RAG-SPEC 5.6 step 3)

`X` was scored cause-agnostically during the sweep. Here the cause is checked once:
a refused `X` probe whose `wouldPassUnscoped` is false at this threshold is a
**stratum-authoring miss**, not a gate failure.

| probe | refused | wouldPassUnscoped | cause | verdict |
|---|---|---|---|---|
| `x-02` | no | no | — | ESCAPED |
| `x-05` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-09` | no | no | — | ESCAPED |
| `x-12` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-13` | yes | yes | `refuse:out-of-scope` | correct |
| `x-15` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-17` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-18` | no | yes | — | ESCAPED |
| `x-19` | no | no | — | ESCAPED |
| `x-21` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-22` | no | no | — | ESCAPED |
| `x-23` | yes | yes | `refuse:out-of-scope` | correct |
| `x-24` | yes | no | `refuse:no-evidence` | authoring miss |
| `x-25` | no | no | — | ESCAPED |
| `x-26` | yes | no | `refuse:no-evidence` | authoring miss |

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
| gatePrecision | — | — |
| blatantRefusalRate | — | >= 80% |

### The `G_lex` sweep

Every fifth step, plus the chosen row. `chooseTauLexical` reads the `N4` column and
nothing else, so this is where the over-refusal it costs becomes visible.

| tauLexical | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 |
|---|---|---|---|---|---|---|---|---|

## zExp ladder (RAG-SPEC 3.4.1)

Median of `(max c − m)/s` over the unscoped positives, at real page-contiguous
scopes — never random chunk samples, because adjacent paragraphs of one page are
exactly the correlation the ladder exists to measure.

| n | z | closed form sqrt(2·ln n) |
|---|---|---|
| 7 | 1.1593 | 1.9728 |
| 10 | 1.29 | 2.1460 |
| 25 | 3.0093 | 2.5373 |
| 49 | 3.8108 | 2.7899 |
| 110 | 4.6497 | 3.0661 |
| 315 | 7.0089 | 3.3919 |
| 477 | 8.315 | 3.5121 |
| 477 | 8.315 | 3.5121 |

`denseMode` is `cosine` on this index, so the ladder is **inert**:
`zExp(n)` is only consulted in `zscore` mode. It is measured and recorded anyway so
that a swap to an anisotropic embed model cannot silently inherit the closed form.

## retrievalMisses

0/0 positives carrying a gold page (0.0%, bound 5%).

Measured at PAGE level through `retrieval.closest()`: RAG-SPEC 5.6 step 1 gives the
probe set no gold chunk ids, so `gold_page` is the granularity available. Page level
is the more forgiving of the two — a miss reported here is a miss at chunk level too.
