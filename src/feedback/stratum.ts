/**
 * What a real reader's vote is EVIDENCE OF — the bridge from a feedback record
 * to a calibration probe or a golden record.
 *
 * PURE, and deliberately not confident. `stratum` is a judgement about what a
 * question was FOR, and a feedback record carries signals about what the gate
 * DID. The two are related and are not the same thing, so this module says what
 * the signals are consistent with and marks the rest for review. Where the
 * signals cannot separate two strata it emits the options rather than picking
 * one: a single guess is false precision, and false precision in a reviewed file
 * is worse than an open question, because it gets rubber-stamped.
 *
 * The suggested keys are checked against the STRATA table in calibrate.js, which
 * is the same table `loadProbes` validates against — so this file cannot drift
 * into proposing a stratum the calibrator would then reject.
 */

import {STRATA} from '../eval/calibrate.js'

/** Where a candidate is headed. Not every vote is a threshold question. */
export const TARGETS = ['calibration', 'golden', 'docs', 'none']

/** Reasons the panel offers, in DocPilot.vue's stable order. */
const DISPUTES_ABSENCE = ['wrong', 'incomplete']

const ok = (key) => {
  if (key != null && !Object.hasOwn(STRATA, key)) {
    throw new Error(`[docpilot] suggested stratum "${key}" is not in the calibrator's table`)
  }
  return key
}

/**
 * One aggregated candidate → what to do with it.
 *
 * @param {object} c aggregate produced by aggregate.js
 * @returns {{target: string, stratum: string|null, stratumOptions: string[],
 *            expect?: string, needsReview: boolean, note: string}}
 */
export function suggest(c) {
  const gate = c.gate || null
  const refusal = c.refusal || null
  const verdict = c.verdict || null
  const scoped = c.scope?.kind && c.scope.kind !== 'all'
  const reasons = c.reasons || []
  const positive = scoped ? 'S' : 'U'

  // 1. NEVER REACHED THE GATE. A credential refusal settles in the browser
  //    before `evaluate()` runs and the question that reaches this file is the
  //    MASK-redacted one; a social turn is "hello". Neither is a probe, and
  //    neither is a question anyone asked of the corpus.
  if (!gate) {
    return out('none', null, [], {
      needsReview: false,
      note:
        refusal === 'credential'
          ? 'a pasted credential — the question was redacted and never searched'
          : refusal === 'social'
            ? 'a greeting, not a question about the docs'
            : 'no gate result recorded',
    })
  }

  // 2. MEASURED ON A DIFFERENT INSTRUMENT. A turn whose embedder was DOWN had
  //    no dense channel, so its G was scored against tauLexical while every
  //    other record of the same deployment was scored against tau. Calibrating
  //    with it would compare two numbers that do not mean the same thing.
  //
  //    `degraded`, not the mode: a site built with `embed: false` runs every
  //    turn lexical-only by design, `docpilot calibrate` sweeps `tauLexical`
  //    there and nothing else, and those records are the probe set for exactly
  //    the threshold that gate consults. Dropping them left that site's
  //    feedback loop proposing nothing, forever, with a note claiming an outage
  //    that never happened.
  if (gate.mode === 'lexical-only' && gate.degraded !== false) {
    return out('none', null, [], {
      needsReview: true,
      note: 'retrieval was degraded (lexical-only) — G is not comparable to tau',
    })
  }

  // 3. THE GATE PASSED AND THE MODEL DECLINED. Nothing here is about a
  //    threshold: the evidence was admitted and the answer was not written.
  //    That is a golden record.
  if (refusal === 'not-answerable') {
    return out('golden', null, [], {
      expect: 'refuse:no-evidence',
      needsReview: true,
      note: 'the gate passed; the model declined — an answer-side record, not a probe',
    })
  }

  // 4a. A QUOTED TURN. The composed channel fired, but what it composed with is
  //     a passage the reader selected out of an earlier answer — corpus text,
  //     not a question anyone asked. F and N5 are DEFINED as prev_question plus
  //     a tail, and this is neither, so it never becomes a tau probe: a
  //     threshold calibrated on an antecedent the corpus wrote would be the
  //     corpus measured against itself.
  //
  //     Both conditions, not just the antecedent: a quoted turn whose RAW
  //     channel carried it is ordinary evidence — the reader's own words did the
  //     work — and it must still reach step 6's X stratum if it was refused in
  //     scope. This diverts only the records the composed channel rescued.
  if (gate.channel === 'composed' && gate.antecedent === 'quote') {
    return out(verdict === 'down' ? 'golden' : 'none', null, [], {
      ...(verdict === 'down' ? {expect: 'answer'} : {}),
      needsReview: true,
      note: 'a quoted follow-up — the antecedent is a passage from an answer, not a previous question',
    })
  }

  // 4/5. A FOLLOW-UP. `channel: 'composed'` means the question only scored where
  //      it did once the previous question was prepended — so this record is one
  //      half of a pair, and the other half is not in it. conversationId is what
  //      makes a reviewer able to go and find it.
  if (gate.channel === 'composed') {
    if (verdict === 'up' && !refusal) {
      return out('calibration', ok('F'), ['F'], {
        needsReview: true,
        note: 'a follow-up the composed channel rescued — add prev_question from the conversation',
      })
    }
    if (verdict === 'down') {
      return out('calibration', ok('N5'), ['N5', 'F'], {
        needsReview: true,
        note: 'off-domain after a legitimate turn, or a follow-up that failed — add prev_question',
      })
    }
  }

  // 6. SCOPED PAST THE ANSWER. The reader narrowed the search and the gold sits
  //    outside what they narrowed it to — which is exactly what X measures.
  if (refusal === 'out-of-scope') {
    return out('calibration', ok('X'), ['X'], {
      needsReview: true,
      note: 'refused in scope, would have passed unscoped',
    })
  }

  if (refusal === 'no-evidence') {
    // 7. SCOPED, AND IT WOULD NOT HAVE PASSED UNSCOPED EITHER. Either the scope
    //    shares vocabulary with the answer without containing it (P), or the
    //    corpus does cover it and the gate over-refused (S). Nothing in the
    //    record separates those.
    if (scoped && !gate.wouldPassUnscoped) {
      return out('calibration', null, ['P', 'S'], {
        needsReview: true,
        note: 'scoped refusal — vocabulary overlap without the answer, or a genuine over-refusal',
      })
    }
    // 8. THE READER SAYS THE DOCS DO COVER IT. "Wrong" or "incomplete" on a
    //    refusal is a claim that an answer existed and the gate did not admit
    //    it — the over-refusal these strata are bounded on.
    if (verdict === 'down' && reasons.some((r) => DISPUTES_ABSENCE.includes(r))) {
      return out('calibration', ok(positive), [positive], {
        needsReview: true,
        note: `the reader disputes the refusal — over-refusal candidate at G ${fmtMargin(gate)}`,
      })
    }
    // 9. THE READER AGREES IT IS ABSENT. A true negative, and a good probe —
    //    but WHICH negative is a judgement about the product's neighbourhood
    //    that no recorded signal can make. N6 is an adversarial construction
    //    nobody stumbles into, so it is never offered.
    if (verdict === 'down' && reasons.includes('not-in-docs')) {
      return out('calibration', null, ['N1', 'N2', 'N3', 'N4'], {
        needsReview: true,
        note: 'confirmed absent — pick the negative stratum by how close it is to the product',
      })
    }
    return out('calibration', null, ['N1', 'N2', 'N3', 'N4', positive], {
      needsReview: true,
      note: 'refused, and the reader did not say whether that was right',
    })
  }

  // 10. THE LINKS WERE WRONG. The gate passed, the answer came, and what failed
  //     was citation. No threshold moves that.
  if (verdict === 'down' && reasons.includes('bad-links')) {
    return out('docs', null, [], {
      needsReview: true,
      note: 'a citation defect — check the cited pages, not the threshold',
    })
  }

  // 11. THE GATE PASSED AND THE ANSWER WAS WRONG. A golden record, once someone
  //     writes the answer it should have given.
  if (verdict === 'down') {
    return out('golden', null, [], {
      expect: 'answer',
      needsReview: true,
      note: 'answered and disputed — needs a gold_answer before it can measure anything',
    })
  }

  // 12. CONFIRMED POSITIVE. The cheapest good probe there is: a real question,
  //     a passing gate, and a reader who said it worked.
  if (verdict === 'up') {
    return out('calibration', ok(positive), [positive], {
      needsReview: true,
      note: 'confirmed positive',
    })
  }

  return out('none', null, [], {needsReview: true, note: 'no verdict'})
}

function fmtMargin(gate) {
  if (typeof gate.G !== 'number' || typeof gate.tau !== 'number') return 'unknown'
  const d = gate.G - gate.tau
  // The record's `tau` is whatever threshold the turn was actually scored
  // against, and on a lexical-only turn that is `tauLexical`. A reviewer acts on
  // this sentence, and naming the wrong threshold is how one gets moved in the
  // wrong file.
  return `${d >= 0 ? '+' : ''}${d.toFixed(3)} against ${gate.mode === 'lexical-only' ? 'tauLexical' : 'tau'}`
}

function out(target, stratum, stratumOptions, extra) {
  return {target, stratum, stratumOptions, ...extra}
}
