/**
 * A record's CONVERSATION — the questions asked before the one being scored.
 *
 * A chain is those questions in order, oldest first. Until this module the
 * evaluation sets could express exactly one of them: a record carried a single
 * `prev_question` string, and so did every probe in `docpilot/calibration.jsonl`.
 * One hop carries one ellipsis and no more, which is the same ceiling
 * `chainAntecedent` was written against: "how do I style the panel?", then "and
 * on React?", then "and on Docusaurus?" — the subject of the third question is
 * two turns back, and a set that can only hold one prior question cannot pose
 * it. Nothing measured whether an elliptical question keeps its subject past the
 * first hop, because no runner could build a history deeper than one pair.
 *
 * `prev_questions` is that array. `prev_question` is its legacy one-element
 * spelling and stays legal forever: every golden file and probe file in the wild
 * carries it, and a file written before chains existed must score identically
 * after them — the same rule `recordLevel` follows for an absent `level`, and
 * for the same reason.
 *
 * DEPTH IS NOT CAPPED HERE. A chain of four is worth authoring: `buildMessages`
 * (src/theme/docpilot/prompt.js) keeps the last three answered pairs verbatim
 * and condenses everything older into one line — "Earlier in this session the
 * reader asked about: …" — so that line first appears at the fourth pair and no
 * eval has ever reached it. A ceiling in this accessor would delete the only
 * records that exercise it.
 *
 * DELIBERATELY ABOUT THE RECORD'S SHAPE, AND NOTHING ELSE. Which of those
 * questions becomes the antecedent is a RULE, it depends on how the prior turn
 * won its gate, and it lives in `chainAntecedent` (src/theme/docpilot/gate.js)
 * with `composeQuery` writing the composition. Neither may be restated here: the
 * eval's composition and the panel's have to be one expression, or a report
 * measures a query the panel never sends.
 *
 * Pure by contract: no fs, no process, no env. run.js, calibrate.js, tune.js,
 * answer-bench.js and lint-golden.js all read a conversation through this, and
 * five copies of `rec.prev_question ? [rec.prev_question] : []` is five places
 * for one of them to drift — the argument levels.js makes about membership,
 * one field over.
 */

/**
 * The conversation before this record, oldest first.
 *
 * VERBATIM: no trimming, no filtering, no dropping of blanks. A record whose
 * prior is an empty string is a lint error, and it has to reach `lintRecords`
 * intact to be named there rather than be quietly repaired into a shorter chain
 * that scores fine and hides the mistake — the rule `recordLevel` states for an
 * authored-but-wrong `level`. That is why both tests below are for PRESENCE and
 * not for content: `recordLevel` (src/eval/levels.js) is `rec?.level ??
 * DEFAULT_RECORD_LEVEL`, `??` and not `||` so that only an ABSENT field
 * defaults and an authored empty string reaches the caller unchanged; a
 * `.length` here is the `||` that file rejected, one field over, and it reads
 * `prev_question: ''` as depth 0 — a record the linter can then never name.
 *
 * BOTH FIELDS PRESENT returns `prev_questions`. The linter rejects that record;
 * this accessor's job is to be predictable, not to arbitrate which of two
 * spellings the author meant. An EMPTY `prev_questions` is present: `[]` beside
 * a legacy `prev_question` returns `[]`, because the alternative — falling
 * through to the legacy field — is that same arbitration, decided silently, and
 * it contradicts this paragraph's own rule for the record it is most likely to
 * be written on.
 */
export function priorQuestions(rec) {
  const chain = rec?.prev_questions
  if (Array.isArray(chain)) return chain
  const one = rec?.prev_question
  if (typeof one === 'string') return [one]
  return []
}

/**
 * How many questions precede this one.
 *
 * Named rather than left as `.length` at the call site because `0`, `1` and
 * `>= 2` are three different populations in every report — a first turn, the
 * single hop that shipped, and a chain that can reach the second antecedent —
 * and a bare length says nothing about which one a row belongs to.
 */
export function chainDepth(rec) {
  return priorQuestions(rec).length
}

/** Whether this record is a follow-up at all. Replaces `Boolean(rec.prev_question)`. */
export function isFollowUp(rec) {
  return chainDepth(rec) > 0
}
