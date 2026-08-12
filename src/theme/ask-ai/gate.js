/**
 * The evidence gate — RAG-SPEC 3.4.
 *
 * A retrieval-side floor that can refuse BEFORE the model is called: a question
 * with no lexical and no dense support costs zero model calls and produces zero
 * generated text.
 *
 * It is a RELEVANCE FLOOR, NOT AN ENTAILMENT CHECK. A question that overlaps a
 * documented subject reaches the model by design. Nothing here can determine
 * whether the retrieved text supports the asked claim, and no comment in this
 * file may imply that it can.
 */

import { terms } from './text.js'

export const Q_CAP = 12
const MAD_FLOOR = 0.01
const D_SCALE = 3.0

/**
 * Expected maximum of n samples.
 *
 * sqrt(2·ln n) is the expected maximum of n I.I.D. standard normals, and chunk
 * cosines are neither independent nor identically distributed — MMR exists in
 * 3.1 precisely because adjacent paragraphs of one page cluster. The closed form
 * therefore over-corrects, and the over-correction grows with n. `rag:calibrate`
 * replaces it with a measured ladder; until then this is used and every record
 * says `zexpSource: "closed-form"` so no one mistakes it for measured.
 */
export function zExp(n, ladder = null) {
  if (ladder && ladder.length >= 2) {
    const x = Math.log(Math.max(n, 2))
    const pts = ladder.slice().sort((a, b) => a.n - b.n)
    if (x <= Math.log(pts[0].n)) return pts[0].z
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const xa = Math.log(a.n)
      const xb = Math.log(b.n)
      if (x <= xb) return a.z + ((x - xa) / (xb - xa)) * (b.z - a.z)
    }
    return pts[pts.length - 1].z
  }
  return Math.sqrt(2 * Math.log(Math.max(n, 2)))
}

function median(sorted) {
  const n = sorted.length
  if (!n) return 0
  const mid = n >> 1
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Dense separation D over the FULL corpus distribution, with the champion taken
 * from the scoped set.
 *
 * median, not mean — the mean is dragged up by the relevant cluster itself.
 * MAD, not standard deviation — the outlier being measured is the top-1, and a
 * standard deviation would let the numerator inflate its own denominator.
 * Raw cosine is never thresholded — nomic-embed-text is anisotropic, so z is the
 * only shift-free, scale-free quantity available.
 */
/**
 * Dense evidence from the ABSOLUTE cosine of the best in-scope chunk.
 *
 * The z-statistic below measures "is there an outlier", not "is the outlier
 * relevant" — and with 1191 chunks every query has a nearest neighbour several
 * MADs above the median, including "write me a poem about the sea" (z = 4.80,
 * higher than most real questions). Measured on this corpus:
 *
 *            over-refusal   off-topic caught
 *   z-score       15%             42%
 *   cosine         0%             67%
 *
 * The ban on thresholding raw cosine is real but MODEL-SPECIFIC: it holds for
 * anisotropic embedders like nomic-embed-text, where the absolute value carries
 * no stable meaning. bge-m3 is trained with cosine as its objective, so the
 * value is calibrated and thresholding it is the correct instrument. `denseMode`
 * records which instrument an index was built for, so a future embed-model swap
 * cannot silently inherit the wrong one.
 */
export function denseFromCosine(maxCos, { cosFloor, cosCeil }) {
  const span = Math.max(cosCeil - cosFloor, 1e-6)
  return { D: Math.min(1, Math.max(0, (maxCos - cosFloor) / span)), z: maxCos }
}

export function denseSeparation(cosines, scopedMax, n, ladder) {
  if (!cosines.length) return { D: 0, z: 0 }
  const sorted = Float64Array.from(cosines).sort()
  const m = median(sorted)
  const dev = Float64Array.from(sorted, (c) => Math.abs(c - m)).sort()
  const s = Math.max(1.4826 * median(dev), MAD_FLOOR)
  const z = (scopedMax - m) / s
  const D = Math.min(1, Math.max(0, (z - zExp(n, ladder)) / D_SCALE))
  return { D, z }
}

/**
 * Lexical coverage L.
 *
 * Capping Q at 12 is what makes L length-invariant: without it a pasted 300-word
 * question drives the denominator to 300 and L to noise.
 *
 * df(t) ?? 0 — an unlisted term is treated as maximally rare. This is the whole
 * sign of the guard: with the opposite default an off-domain term is excluded
 * from Q, Q fills with the query's docs vocabulary, and L saturates on every
 * off-topic question padded with plugin nouns.
 */
export function lexicalCoverage(query, evidenceText, df) {
  const qTerms = terms(query)
  if (!qTerms.length) return { L: 0, Q: [] }
  const seen = new Set()
  const ranked = qTerms
    .filter((t) => (seen.has(t) ? false : seen.add(t)))
    .map((t, i) => ({ t, df: df?.[t] ?? 0, i }))
    .sort((a, b) => a.df - b.df || a.i - b.i)
    .slice(0, Q_CAP)
  const Q = ranked.map((r) => r.t)
  const T = new Set(terms(evidenceText))
  const hit = Q.filter((t) => T.has(t)).length
  return { L: Q.length ? hit / Q.length : 0, Q }
}

/**
 * The verdict.
 *
 * `guard.wLexical < guard.tau` is asserted at init: at a 0.35 weight the lexical
 * channel clears the gate alone, so a query made of rare docs identifiers plus an
 * off-domain ask passes with zero dense evidence. The dense channel MAY pass
 * alone — a correctly paraphrased question with no term overlap is the normal
 * case, not an attack.
 */
export function assertWeights(guard) {
  if (!(guard.wLexical < guard.tau)) {
    throw new Error(
      `ask-ai gate: wLexical (${guard.wLexical}) must be < tau (${guard.tau}); ` +
        'otherwise the lexical channel clears the gate with zero dense evidence',
    )
  }
}

export function verdict({ D, L, mode, guard }) {
  if (mode === 'lexical-only') {
    return { G: L, threshold: guard.tauLexical, pass: L >= guard.tauLexical }
  }
  const G = guard.wDense * D + guard.wLexical * L
  return { G, threshold: guard.tau, pass: G >= guard.tau }
}

/**
 * Follow-ups — two channels, no classifier. RAG-SPEC 3.4.5.
 *
 * Gating the raw follow-up is the failure that gets guards switched off:
 * "and for backend calls?" retrieves nothing. A length-based continuation
 * classifier was rejected because, measured against this component's own three
 * default suggestions, a `terms(q).length < 6` test fires on all three.
 *
 * G is a MAXIMUM, so the composed channel can only ever REDUCE refusals — the
 * property that makes this safe to ship without a new threshold. Admissibility
 * is what stops it being a free pass: at least one content term of the TAIL must
 * appear in the retrieved evidence, which passes "and for backend calls?" and
 * fails "and for AWS S3 buckets?".
 */
export function composeQuery(question, previousQuestion) {
  return previousQuestion ? `${previousQuestion}\n${question}` : null
}

export function admissible(question, composedEvidenceText) {
  const tail = terms(question)
  if (!tail.length) return true // nothing to switch topic to
  const T = new Set(terms(composedEvidenceText))
  return tail.some((t) => T.has(t))
}
