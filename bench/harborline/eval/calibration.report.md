# Gate calibration — `c57213df`

Produced by `npx docpilot calibrate` (RAG-SPEC 5.6). Embed endpoint only — no chat model,
no LLM judge, no unseeded randomness. Same corpus + same probes ⇒ same output.

> ## CALIBRATION FAILED
>
> `eval/calibration.rag-calibrated.json` was **not** written; `build-rag-index.js` will keep
> inlining the provisional guard and warning about it. RAG-SPEC 5.6 step 5.
>
> **`tau-below-wlexical`** — chosen tau 0.15 <= wLexical 0.25: the RAG-SPEC 3.4.4 single-channel invariant would be violated — the lexical channel would clear the gate with zero dense evidence.
>

| | |
|---|---|
| index | `c57213df`, 265 chunks, bge-m3 |
| probes | 295 from `eval/calibration.jsonl` |
| **tau** | **0.15** |
| **tauLexical** | **0.34** |
| wDense / wLexical | 0.75 / 0.25 |
| denseMode | cosine, window [0.44, 0.64] |
| source | `calibrated-reduced` |
| gatePrecision | 25.8% (target 60%, never a constraint) |

## Probe set, and what the reduction costs

RAG-SPEC 5.6 sizes the strata at ~540 probes so `UB95 <= 0.05` is reachable.
With zero failures `UB95(0,n) = z²/(n+z²)`, `z = 1.6449`, so the 5% bound is
**unreachable below n = 52** whatever the gate does, and the 8% bound below n = 32.
This run keeps the three bounded positive strata above those floors and cuts the
negatives, which are a target (`gatePrecision >= 0.60`) and never a constraint.

| stratum | spec n | this run | UB95 at 0 failures | UB95 at spec n | cost of the cut |
|---|---|---|---|---|---|
| U | 180 | 70 | 0.037 | 0.015 | +0.022 |
| S | 60 | 65 | 0.040 | 0.043 | −0.003 |
| F | 60 | 40 | 0.063 | 0.043 | +0.020 |
| N1 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N2 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N3 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N4 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N5 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| N6 | 30 | 15 | 0.153 | 0.083 | +0.070 |
| X | 30 | 15 | 0.153 | 0.083 | +0.070 |
| P | 30 | 15 | 0.153 | 0.083 | +0.070 |

The interval width is not the whole cost. What actually decides whether a bound can
bind is how many failures it tolerates at the n it has:

| bound | stratum | n | ceiling | failures tolerated | n needed for 1 |
|---|---|---|---|---|---|
| `gateOverRefusal` | U | 70 (spec 180) | 0.05 | **0** | 87 |
| `scopedGateOverRefusal` | S | 65 (spec 60) | 0.05 | **0** | 87 |
| `followupRefusalRate` | F | 40 (spec 60) | 0.08 | **0** | 54 |

`gateOverRefusal` and `scopedGateOverRefusal` and `followupRefusalRate` tolerate **zero** failures at this n: a single refused probe decides `tau`. That is the outcome RAG-SPEC 5.4 introduced UB95 to prevent, and for `gateOverRefusal` it persists at the spec's own n = 180 — the bound needs n = 87 before one failure is survivable. Read `tau` accordingly.

## Sweep (RAG-SPEC 5.6 step 3)

`X` probes are scored on refusal alone, cause-agnostic, during the sweep —
`wouldPassUnscoped` is itself a function of tau. The cause is checked once, below.
Positives that are `retrievalMisses` are excluded from the three bounds (RAG-SPEC 5.4).

| tau | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 | feasible |
|---|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/70 | 0.037 | 0/65 | 0.040 | 0/40 | 0.063 | 0.0% | 0.0% | yes |
| 0.05 | 0/70 | 0.037 | 0/65 | 0.040 | 0/40 | 0.063 | 10.8% | 40.0% | yes |
| 0.10 | 0/70 | 0.037 | 0/65 | 0.040 | 0/40 | 0.063 | 23.3% | 86.7% | yes |
| 0.15 | 0/70 | 0.037 | 0/65 | 0.040 | 0/40 | 0.063 | 25.8% | 100.0% | yes |
| 0.20 | 1/70 | 0.062 | 0/65 | 0.040 | 1/40 | 0.105 | 30.8% | 100.0% |  |
| 0.25 | 1/70 | 0.062 | 1/65 | 0.066 | 1/40 | 0.105 | 32.5% | 100.0% |  |
| 0.30 | 1/70 | 0.062 | 1/65 | 0.066 | 1/40 | 0.105 | 35.8% | 100.0% |  |
| 0.35 | 1/70 | 0.062 | 1/65 | 0.066 | 1/40 | 0.105 | 42.5% | 100.0% |  |
| 0.40 | 1/70 | 0.062 | 1/65 | 0.066 | 1/40 | 0.105 | 46.7% | 100.0% |  |
| 0.45 | 2/70 | 0.083 | 3/65 | 0.110 | 1/40 | 0.105 | 47.5% | 100.0% |  |
| 0.50 | 2/70 | 0.083 | 4/65 | 0.130 | 1/40 | 0.105 | 49.2% | 100.0% |  |
| 0.55 | 3/70 | 0.102 | 6/65 | 0.169 | 2/40 | 0.140 | 51.7% | 100.0% |  |
| 0.60 | 3/70 | 0.102 | 8/65 | 0.206 | 2/40 | 0.140 | 54.2% | 100.0% |  |
| 0.65 | 5/70 | 0.140 | 12/65 | 0.276 | 2/40 | 0.140 | 60.0% | 100.0% |  |
| 0.70 | 7/70 | 0.175 | 13/65 | 0.293 | 2/40 | 0.140 | 67.5% | 100.0% |  |
| 0.75 | 11/70 | 0.241 | 16/65 | 0.343 | 2/40 | 0.140 | 70.0% | 100.0% |  |
| 0.80 | 15/70 | 0.305 | 20/65 | 0.408 | 3/40 | 0.173 | 75.8% | 100.0% |  |
| 0.85 | 22/70 | 0.411 | 27/65 | 0.517 | 4/40 | 0.205 | 80.8% | 100.0% |  |
| 0.90 | 27/70 | 0.484 | 31/65 | 0.578 | 6/40 | 0.265 | 87.5% | 100.0% |  |
| 0.95 | 44/70 | 0.717 | 42/65 | 0.736 | 13/40 | 0.455 | 93.3% | 100.0% |  |
| 1.00 | 56/70 | 0.867 | 50/65 | 0.843 | 23/40 | 0.695 | 98.3% | 100.0% |  |

## Every stratum at the chosen tau

| stratum | what it is | n | correct | wrong |
|---|---|---|---|---|
| U | unscoped positives | 70 | 100.0% | 0 |
| S | scoped positives | 65 | 100.0% | 0 |
| F | follow-up pairs | 40 | 100.0% | 0 |
| N1 | adjacent product, absent here | 15 | 0.0% | 15 — `n1-01`, `n1-02`, `n1-03`, `n1-04`, `n1-05`, `n1-06`, `n1-07`, `n1-08`, `n1-09`, `n1-10`, … |
| N2 | plausible-but-absent API | 15 | 0.0% | 15 — `n2-01`, `n2-02`, `n2-03`, `n2-04`, `n2-05`, `n2-06`, `n2-07`, `n2-08`, `n2-09`, `n2-10`, … |
| N3 | off-domain technical | 15 | 26.7% | 11 — `n3-04`, `n3-05`, `n3-06`, `n3-07`, `n3-08`, `n3-09`, `n3-10`, `n3-11`, `n3-12`, `n3-14`, … |
| N4 | off-domain general (blatant) | 15 | 100.0% | 0 |
| N5 | off-domain after a legitimate previous turn | 15 | 46.7% | 8 — `n5-04`, `n5-07`, `n5-08`, `n5-09`, `n5-11`, `n5-12`, `n5-13`, `n5-15` |
| N6 | docs excerpt + off-domain ask | 15 | 0.0% | 15 — `n6-01`, `n6-02`, `n6-03`, `n6-04`, `n6-05`, `n6-06`, `n6-07`, `n6-08`, `n6-09`, `n6-10`, … |
| X | scoped, gold outside the scope | 15 | 33.3% | 10 — `x-03`, `x-04`, `x-05`, `x-06`, `x-07`, `x-08`, `x-11`, `x-12`, `x-13`, `x-15` |
| P | scoped, vocabulary overlap without the answer | 15 | 0.0% | 15 — `p-01`, `p-02`, `p-03`, `p-04`, `p-05`, `p-06`, `p-07`, `p-08`, `p-09`, `p-10`, … |

`gatePrecision` **25.8%** against a target of 60%. RAG-SPEC 5.6
step 6: it may never justify raising the threshold past the rule that chose it, and
`chooseTau()` is not given the number — the
constraint is structural, not a promise.

### Where the strata sit on the G axis

The separability question, before any threshold is chosen.

| stratum | min G | median G | max G |
|---|---|---|---|
| U | 0.182 | 0.938 | 1.000 |
| S | 0.200 | 0.900 | 1.000 |
| F | 0.152 | 0.967 | 1.000 |
| N1 | 0.497 | 0.654 | 0.917 |
| N2 | 0.682 | 0.906 | 1.000 |
| N3 | 0.000 | 0.268 | 0.569 |
| N4 | 0.000 | 0.050 | 0.109 |
| N5 | 0.000 | 0.151 | 0.917 |
| N6 | 0.245 | 0.657 | 0.887 |
| X | 0.013 | 0.280 | 0.666 |
| P | 0.297 | 0.784 | 1.000 |

## The probes that bound the chosen tau

At tau 0.16 the bound `followupRefusalRate` breaks.

| probe | stratum | G | D | L | question |
|---|---|---|---|---|---|
| `f-21` | F | 0.152 | 0.202 | 0.000 | how do i avoid getting it? |

Without that probe, `tau` would be **0.18** instead of **0.15**. That is a robustness number, not a proposal: deleting the probe that pins `tau` in order to make calibration pass is the one edit this procedure exists to prevent.

## Over-refusal backlog — the ten positives closest to tau

These pass today with the least margin: the first questions a reader loses if the
threshold moves, and the shortlist for a documentation fix.

| probe | stratum | G | margin | question |
|---|---|---|---|---|
| `f-21` | F | 0.152 | 0.002 | how do i avoid getting it? |
| `u-55` | U | 0.182 | 0.032 | whats the difference between ack and nack |
| `s-54` | S | 0.200 | 0.050 | what fields can the nack call take in its body? |
| `u-05` | U | 0.406 | 0.256 | how do i downgrade from team to free and when does it kick in |
| `s-62` | S | 0.415 | 0.265 | which bug about SIGTERM did 3.4.0 fix |
| `s-63` | S | 0.435 | 0.285 | what does the migration checklist say about deploy order of workers and producers |
| `s-60` | S | 0.487 | 0.337 | how long can an idempotency key be |
| `u-06` | U | 0.502 | 0.352 | do i get an email when im close to my monthly execution allowance |
| `s-01` | S | 0.522 | 0.372 | do keys stop working when the person who made them leaves the company? |
| `s-35` | S | 0.529 | 0.380 | a bug enqueued 40000 jobs that must never run. what do i do? |

## Refusal causes at the chosen tau (RAG-SPEC 5.6 step 3)

`X` was scored cause-agnostically during the sweep. Here the cause is checked once:
a refused `X` probe whose `wouldPassUnscoped` is false at this threshold is a
**stratum-authoring miss**, not a gate failure.

| probe | refused | wouldPassUnscoped | cause | verdict |
|---|---|---|---|---|
| `x-01` | yes | yes | `refuse:out-of-scope` | correct |
| `x-02` | yes | yes | `refuse:out-of-scope` | correct |
| `x-03` | no | yes | — | ESCAPED |
| `x-04` | no | yes | — | ESCAPED |
| `x-05` | no | yes | — | ESCAPED |
| `x-06` | no | yes | — | ESCAPED |
| `x-07` | no | yes | — | ESCAPED |
| `x-08` | no | yes | — | ESCAPED |
| `x-09` | yes | yes | `refuse:out-of-scope` | correct |
| `x-10` | yes | yes | `refuse:out-of-scope` | correct |
| `x-11` | no | yes | — | ESCAPED |
| `x-12` | no | yes | — | ESCAPED |
| `x-13` | no | yes | — | ESCAPED |
| `x-14` | yes | yes | `refuse:out-of-scope` | correct |
| `x-15` | no | yes | — | ESCAPED |

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
| tauLexical | 0.34 | — |
| U over-refusal | 0/70, UB95 0.037 | none (RAG-SPEC 3.2) |
| S over-refusal | 1/65, UB95 0.066 | none (RAG-SPEC 3.2) |
| F over-refusal | 1/40, UB95 0.105 | none (RAG-SPEC 3.2) |
| gatePrecision | 37.5% | — |
| blatantRefusalRate | 93.3% | >= 80% |

### The `G_lex` sweep

Every fifth step, plus the chosen row. `chooseTauLexical` reads the `N4` column and
nothing else, so this is where the over-refusal it costs becomes visible.

| tauLexical | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 |
|---|---|---|---|---|---|---|---|---|
| 0.00 | 0/70 | 0.037 | 0/65 | 0.040 | 0/40 | 0.063 | 0.0% | 0.0% |
| 0.05 | 0/70 | 0.037 | 0/65 | 0.040 | 1/40 | 0.105 | 11.7% | 40.0% |
| 0.10 | 0/70 | 0.037 | 0/65 | 0.040 | 1/40 | 0.105 | 11.7% | 40.0% |
| 0.15 | 0/70 | 0.037 | 0/65 | 0.040 | 1/40 | 0.105 | 12.5% | 40.0% |
| 0.20 | 0/70 | 0.037 | 0/65 | 0.040 | 1/40 | 0.105 | 14.2% | 40.0% |
| 0.25 | 0/70 | 0.037 | 0/65 | 0.040 | 1/40 | 0.105 | 18.3% | 60.0% |
| 0.30 | 0/70 | 0.037 | 0/65 | 0.040 | 1/40 | 0.105 | 26.7% | 66.7% |
| 0.34 | 0/70 | 0.037 | 1/65 | 0.066 | 1/40 | 0.105 | 37.5% | 93.3% |
| 0.35 | 0/70 | 0.037 | 1/65 | 0.066 | 1/40 | 0.105 | 37.5% | 93.3% |
| 0.40 | 0/70 | 0.037 | 1/65 | 0.066 | 1/40 | 0.105 | 39.2% | 93.3% |
| 0.45 | 0/70 | 0.037 | 2/65 | 0.089 | 1/40 | 0.105 | 44.2% | 100.0% |
| 0.50 | 0/70 | 0.037 | 2/65 | 0.089 | 1/40 | 0.105 | 45.0% | 100.0% |
| 0.55 | 3/70 | 0.102 | 2/65 | 0.089 | 1/40 | 0.105 | 60.8% | 100.0% |
| 0.60 | 3/70 | 0.102 | 2/65 | 0.089 | 1/40 | 0.105 | 65.0% | 100.0% |
| 0.65 | 5/70 | 0.140 | 6/65 | 0.169 | 1/40 | 0.105 | 75.0% | 100.0% |
| 0.70 | 11/70 | 0.241 | 12/65 | 0.276 | 2/40 | 0.140 | 83.3% | 100.0% |
| 0.75 | 13/70 | 0.273 | 16/65 | 0.343 | 2/40 | 0.140 | 85.8% | 100.0% |
| 0.80 | 29/70 | 0.513 | 20/65 | 0.408 | 2/40 | 0.140 | 90.0% | 100.0% |
| 0.85 | 41/70 | 0.678 | 30/65 | 0.563 | 4/40 | 0.205 | 95.0% | 100.0% |
| 0.90 | 43/70 | 0.704 | 34/65 | 0.622 | 4/40 | 0.205 | 95.8% | 100.0% |
| 0.95 | 43/70 | 0.704 | 34/65 | 0.622 | 4/40 | 0.205 | 95.8% | 100.0% |
| 1.00 | 43/70 | 0.704 | 34/65 | 0.622 | 4/40 | 0.205 | 95.8% | 100.0% |

## zExp ladder (RAG-SPEC 3.4.1)

Median of `(max c − m)/s` over the unscoped positives, at real page-contiguous
scopes — never random chunk samples, because adjacent paragraphs of one page are
exactly the correlation the ladder exists to measure.

| n | z | closed form sqrt(2·ln n) |
|---|---|---|
| 7 | 1.0834 | 1.9728 |
| 8 | 1.0948 | 2.0393 |
| 23 | 1.6844 | 2.5042 |
| 43 | 2.1669 | 2.7427 |
| 102 | 2.9065 | 3.0414 |
| 265 | 4.1909 | 3.3406 |
| 265 | 4.1909 | 3.3406 |
| 265 | 4.1909 | 3.3406 |

`denseMode` is `cosine` on this index, so the ladder is **inert**:
`zExp(n)` is only consulted in `zscore` mode. It is measured and recorded anyway so
that a swap to an anisotropic embed model cannot silently inherit the closed form.

## retrievalMisses

**Bound not armed.** No probe in `eval/calibration.jsonl` carries a `gold_page`, so there is nothing to measure retrieval misses over. The 5% floor cannot fail and cannot pass; add `gold_page` to the positives to arm it.

Measured at PAGE level through `retrieval.closest()`: RAG-SPEC 5.6 step 1 gives the
probe set no gold chunk ids, so `gold_page` is the granularity available. Page level
is the more forgiving of the two — a miss reported here is a miss at chunk level too.
