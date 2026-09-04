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
 *   · `'off'` — never. THE DEFAULT since 1.3, engine-spec 019, and the reason is
 *     arithmetic rather than taste: `L` is token overlap between the question
 *     and the corpus, so it is 0 BY CONSTRUCTION for any question asked in a
 *     language the documentation is not written in — no threshold on top of a
 *     zero can separate a reader asking about the product in Russian from one
 *     asking about the weather. Measured on this package's own English docs: a
 *     Russian install question scored G 0.21 against a 0.41 tau while the
 *     refusal's own "closest pages" line named the three pages that answered
 *     it. `vocabulary` closes the SAME-alphabet case — a reader who calls the
 *     product by a name the docs do not use; nothing closes the cross-language
 *     one, because there is no threshold to calibrate per language and no
 *     bound on how many languages a site's readers use. So the verdict is
 *     scored and kept for the record, and the MODEL decides whether the
 *     question is answerable — the judgement a scalar cannot make and the one
 *     the model can, since it is shown the passages and holds a refusal
 *     contract of its own.
 *   · `'dense-only'` — only where there is a dense channel to have scored it
 *     with. The narrower, opt-in middle ground: a vectorless deployment still
 *     refuses nothing (same argument as `'off'`, restricted to the one shape
 *     where `G` is `L` alone and the gap is worst), while a deployment with an
 *     embedder gets the pre-1.3 refusal contract back.
 *   · `'calibrated'` — always. The pre-1.3 default, for a deployment that wants
 *     the refusal contract enforced whatever the channel — a single-language
 *     site with a probe corpus to calibrate against is the case for it.
 *
 * WHAT `'off'` COSTS, on every deployment now rather than one: a question the
 * corpus has nothing for spends a model turn before that is known. On a shared
 * free tier that is one of fifty a day for the whole site. `readiness` says so.
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
 * A CHAIN OF ELLIPSES, AND THE ONE HOP THAT LOSES IT — engine-spec 023.
 *
 * `composeQuery` prepends the last ANSWERED question, which is what rescues
 * "and for backend calls?". One hop carries one ellipsis and no more: "how do I
 * style the panel?", then "and on React?", then "and on Docusaurus?" composes as
 * `and on React?\nand on Docusaurus?`, in which nothing names styling and
 * nothing names the panel. The subject is two turns back and the composed
 * channel cannot see it.
 *
 * THE SECOND HOP IS CONDITIONAL ON THE GATE, not on a length test and not on a
 * classifier — the same objection that killed `terms(q).length < 6` one docblock
 * up applies to any measurement taken of the question alone. `turn.gate` keeps
 * `channel` and `antecedent` (GATE_KEYS, history.js), so the previous turn has
 * already SAID whether it was itself an ellipsis: it won on `channel:
 * 'composed'` with `antecedent: 'question'`, which is a measurement that its own
 * question was too weak an anchor to score with. Chaining is restricted to
 * exactly those turns, so the lexical dilution a longer composed query costs is
 * confined to the turns where one hop has already failed. Every ordinary chain
 * composes the single hop it always did.
 *
 * ONE CHANNEL STILL, and no new value of `gate.channel`. `src/feedback/stratum.js`
 * routes on `channel`/`antecedent` and DEFINES the F and N5 strata as
 * prev_question plus a tail, and `regate` in `src/eval/calibrate.js` mirrors
 * `evaluate()`'s two-arm maximum exactly; a third arm would change what `tau`
 * means and file records under a stratum nobody has measured. So this returns a
 * longer string for the slot `composeQuery` already has — the composed query
 * becomes `${T0}\n${T1}\n${q}` — and the composition keeps one spelling.
 *
 * A LONGER ANTECEDENT IS NOT A FREE PASS. The three properties that bound the
 * single hop bound this one unchanged: `admissible` tests the RAW tail against
 * the composed evidence, so a topic switch wearing two antecedents is vetoed
 * exactly as one wearing one is; `G` is a maximum over the channels, so the
 * composed arm can only ever REDUCE refusals; and `assertWeights` guarantees
 * `wLexical < tau`, so no amount of borrowed lexical coverage clears the gate on
 * its own. What gets a chained follow-up through is dense evidence, which is
 * what got the one-hop follow-up through as well.
 *
 * OVER THE CEILING THE OLDER HOP IS DROPPED WHOLE. A question cut at
 * ANTECEDENT_MAX_CHARS is a query nobody asked: it embeds as a fragment and its
 * severed terms still enter `Q`. Falling back to the single hop is the behaviour
 * that shipped, so the ceiling costs a turn nothing it had.
 *
 * IT IS THE CHAIN'S CEILING AND NOTHING ELSE, which the constant's name does not
 * say. A single antecedent of 340 characters still travels whole and is meant
 * to: that is the one-hop composition that shipped, and putting a cap on it here
 * would be a new refusal smuggled into a docblock about a new rescue. So the
 * only thing this number can ever veto is the SECOND hop, and vetoing it lands
 * on that same shipped behaviour.
 *
 * Counted in CODE POINTS — `Array.from` before `.length` — for the reason
 * `clampTo` and `clampLine` give in prompt.js: `.length` counts UTF-16 code
 * units, so a chain of questions carrying emoji or astral characters reached the
 * ceiling at half its nominal length and lost a hop the budget had room for.
 *
 * `DOCPILOT_ANTECEDENT_HOPS=1` collapses this to that single hop. It is a
 * MEASUREMENT SWITCH, for the A/B that decides whether the second hop pays, and
 * not a configuration key: no resolver reads it and no site can set it.
 *
 * IT IS READ AT CALL TIME, out of `process.env`, for the reason `resolveLevers`
 * gives in retriever.js — the timing is the whole of it. Every CLI entry point
 * loads `.env.local` into `process.env` AFTER the module graph is imported, and
 * `.env.local` is exactly where every DocPilot doc tells a consumer to put their
 * `DOCPILOT_*` keys, so a module-scope fold answered from a read taken before the
 * file was loaded: importing this module and THEN setting
 * `DOCPILOT_ANTECEDENT_HOPS=1` chained two hops, setting it first gave one. The
 * switch therefore worked under `npx docpilot eval` — bin/docpilot.js happens to
 * call `applyFileEnv()` ahead of the entry import — and was silently ignored
 * under `node dist/eval/run.js`, the invocation run.js's own docblock says its
 * redundant `applyFileEnv()` exists to make behave identically. Still through
 * `globalThis.process?.env`, so a browser bundle with no `process` takes the
 * default rather than throwing, at call time exactly as at import time.
 *
 * IT HAS EXACTLY TWO MEANINGFUL VALUES, 1 and 2, and any other finite number is
 * clamped into that range rather than read out. `=0` and `=3` were taken whole
 * before, and each named something no branch implements: 0 fell to the single
 * hop that 1 names, 3 took the two-hop arm that 2 names. The clamp moves no
 * turn — it stops the variable from claiming a setting it does not have. A third
 * hop is not a number away; it is `chainAntecedent` reading further back.
 */
export const ANTECEDENT_HOPS = 2
export const ANTECEDENT_MAX_CHARS = 320

const hops = () => {
  const raw = globalThis.process?.env?.['DOCPILOT_ANTECEDENT_HOPS']
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(n)) return ANTECEDENT_HOPS
  return Math.min(Math.max(Math.trunc(n), 1), ANTECEDENT_HOPS)
}

/**
 * @param {{question: string, composed: boolean}[]} prior the ANSWERED turns,
 *   oldest first. `composed` is the caller's reading of that turn's own gate
 *   record; a turn that has none is `false`, which is the single hop.
 */
export function chainAntecedent(prior) {
  if (!prior?.length) return { text: null, hops: 0 }
  const last = prior[prior.length - 1]
  const older = prior.length > 1 ? prior[prior.length - 2] : null
  if (hops() >= 2 && last.composed && older) {
    const chained = `${older.question}\n${last.question}`
    if (Array.from(chained).length <= ANTECEDENT_MAX_CHARS) return { text: chained, hops: 2 }
  }
  return { text: last.question, hops: 1 }
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
