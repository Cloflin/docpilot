# The refusal gate

A retrieval-side floor that can refuse **before the model is called**. A question with no support costs zero model calls and produces zero generated text.

## It is a relevance floor, not an entailment check

Nothing here can determine whether the retrieved text supports the claim being asked about. A question that overlaps a documented subject reaches the model **by design** — including one that quotes your documentation and then asks something else entirely. The evaluation measures how often that happens rather than pretending it does not.

## Two channels

**Dense.** How far the best in-scope chunk stands out. With a cosine-trained embedding model the absolute value is calibrated and can be thresholded directly; with an anisotropic one it cannot, and a shift-free statistic is used instead. The index records which instrument it was built for, so changing embedding model cannot silently inherit the wrong one.

**Lexical.** What share of the question's rarest terms appear in the retrieved text. The term count is capped, which is what makes the measure length-invariant: without the cap a pasted 300-word question drives the denominator to 300 and the score to noise. An unlisted term is treated as maximally rare — with the opposite default, an off-domain question padded with your product's nouns saturates the measure.

The two are combined with weights, and the lexical weight is asserted at startup to be **below** the threshold. Otherwise a query made of rare identifiers plus an off-domain ask clears the gate with no dense evidence at all. The dense channel may pass alone: a correctly paraphrased question with no shared vocabulary is the normal case, not an attack.

## Follow-ups

`and for backend calls?` retrieves nothing on its own. Gating that is the failure that gets guards switched off.

So the score is the **maximum** of the raw question and the question composed with the previous one — which can only ever reduce refusals, the property that makes it safe without a new threshold. Admissibility stops it being a free pass: at least one content word of the *tail* must appear in the retrieved evidence. `and for backend calls?` passes. `and for AWS S3 buckets?` does not.

There is no length-based continuation classifier. Measured against three ordinary starter questions, a "shorter than six words" test fired on all three.

## Three refusals, three causes

| cause | when | offered |
|---|---|---|
| `no-evidence` | below threshold, and widening the scope provably would not help | the closest pages |
| `out-of-scope` | below threshold, but it would pass across the whole corpus | a button that widens and resubmits |
| `not-answerable` | the model was called and returned nothing citable | the closest pages |

`out-of-scope` is only claimed when it has been **computed**, never guessed.

**A refusal never explains itself with a number.** No score, no threshold, no "low confidence", no "off-topic".

## Calibrate it

Thresholds are measured against your corpus, not inherited from ours. See [Calibration and evaluation](/guide/evaluation).
