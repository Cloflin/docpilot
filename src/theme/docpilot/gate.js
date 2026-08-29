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
 * therefore over-corrects, and the over-correction grows with n. `docpilot calibrate`
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
      `docpilot gate: wLexical (${guard.wLexical}) must be < tau (${guard.tau}); ` +
        'otherwise the lexical channel clears the gate with zero dense evidence',
    )
  }
}

/**
 * WHETHER THE VERDICT ENDS THE TURN — the gate's other question, and the one
 * `guard.mode` answers.
 *
 * The verdict is ALWAYS scored and always recorded. This decides only whether a
 * failing one refuses before the model is called, and the three values differ in
 * where they draw that line:
 *
 *   · `'calibrated'` — always. The behaviour that shipped, kept for a deployment
 *     that wants the refusal contract enforced whatever the channel.
 *   · `'dense-only'` — only where there is a dense channel to have scored it
 *     with. THE DEFAULT, and the reason is arithmetic rather than taste: with no
 *     embedder G is L alone, and L is token overlap between the question and the
 *     corpus. A reader who asks in a language the corpus is not written in, or
 *     who calls the product by a name the docs do not use, scores L = 0 for a
 *     question that is squarely about the product — and the panel then answers
 *     "I couldn't find this in the docs", which is false. It did not look.
 *     `vocabulary` closes the second of those; nothing closes the first. So on a
 *     vectorless turn the verdict picks the copy and the MODEL decides whether
 *     the question is answerable, which is the judgement it can actually make.
 *   · `'off'` — never. Every question reaches the model on every deployment.
 *
 * WHAT IT COSTS, on the one deployment shape it changes: a question the corpus
 * has nothing for now spends a model turn before that is known. On a shared free
 * tier that is one of fifty a day for the whole site. `readiness` says so.
 */
export function enforces(guardMode, retrievalMode) {
  if (guardMode === 'off') return false
  if (guardMode === 'dense-only') return retrievalMode !== 'lexical-only'
  return true
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

/**
 * WHEN ADMISSIBILITY HAS NOTHING TO MEASURE — a tail written in a script the
 * corpus is not written in.
 *
 * `admissible` asks whether a content term of the tail appears in the composed
 * evidence. Over a corpus in another writing system that question has no
 * answer: not one term of "а я могу его стилизировать?" can appear in English
 * prose, whatever the reader asked about, so the veto fires on every follow-up
 * a reader in that language ever asks and the composed channel — the one
 * mechanism that resolves "его" — is discarded exactly where it is needed.
 * `enforces` names the same hole for L one screen up and closes it for the
 * vectorless case only; this is the same hole in the same file, on the
 * deployment shape that HAS a dense channel to decide with.
 *
 * ABSTAINING IS NOT PASSING. The caller still requires `composed.G > raw.G` and
 * still requires the winner to clear `tau`, and `assertWeights` guarantees
 * `wLexical < tau`, so a channel that gets past this predicate has to carry
 * real DENSE evidence — a foreign tail cannot lexically smuggle itself through
 * on the antecedent's terms. What is given up is the topic-switch check for one
 * population, and what replaces it is the dense floor.
 *
 * TWO CONDITIONS, and both are load-bearing:
 *
 *   1. No tail term is known to the corpus. A Russian question that names
 *      `css` or `docpilot` HAS something the lexical test can match, so the
 *      veto stays and does its job. This is also what keeps
 *      "and for AWS S3 buckets?" rejected on a corpus that mentions AWS.
 *   2. The tail's letters are not the corpus's letters. Without this, condition
 *      1 alone would abstain for any off-topic English tail whose words the
 *      corpus happens not to use — the documented case the veto exists for.
 *
 * WHY A MASS SHARE AND NOT A CHARACTER SET. Five words of a Russian UI sample
 * in an i18n page put 20 Cyrillic letters into this corpus's vocabulary, which
 * is enough for a set-membership test to call a wholly Russian question native
 * and refuse it. Measured over the shipped 405-chunk index: the tails above
 * score 0.04%–0.08% of the vocabulary's letter mass, an English tail scores
 * 41%–56% (every English word carries a vowel), and a contrived tail of nothing
 * but the rarest English letters still scores 0.36%. The floor sits an order of
 * magnitude clear on both sides — it separates writing systems, and it is not
 * asked to separate anything finer.
 */
const ALPHABET_FLOOR = 0.01
const LETTER = /\p{L}/u
const ALPHABETS = new WeakMap()

/** Letters of the corpus vocabulary, counted once per type. Memoised per index. */
function letterMass(df) {
  let m = ALPHABETS.get(df)
  if (m) return m
  const share = new Map()
  let total = 0
  for (const t of Object.keys(df)) {
    for (const ch of t) {
      if (!LETTER.test(ch)) continue
      share.set(ch, (share.get(ch) || 0) + 1)
      total++
    }
  }
  m = { share, total }
  ALPHABETS.set(df, m)
  return m
}

export function foreignTail(question, df) {
  if (!df) return false // no corpus profile, no claim about the corpus
  const tail = terms(question)
  if (!tail.length) return false
  if (tail.some((t) => (df[t] ?? 0) > 0)) return false
  const { share, total } = letterMass(df)
  if (!total) return false
  const letters = new Set()
  for (const t of tail) for (const ch of t) if (LETTER.test(ch)) letters.add(ch)
  if (!letters.size) return false // digits and symbols make no claim about script
  let mass = 0
  for (const ch of letters) mass += share.get(ch) || 0
  return mass / total < ALPHABET_FLOOR
}
