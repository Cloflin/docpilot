/**
 * A question this build already resolved — engine-specs/009, ui-specs/013.
 *
 * `docpilot index` takes `suggestions.questions`, embeds each one, and ships the
 * vector beside the index. This module decides whether the question in front of
 * it is one of those, and hands back the vector if it is. That is the whole
 * feature: the reader's click costs no embedding request, because the request
 * was made on the author's machine with the author's allowance.
 *
 * WHAT IT DOES NOT DO, and the restraint is the design. It does not rank, it
 * does not score chunks, it does not decide anything the gate decides. The
 * vector it returns re-enters `createRetrieval` through the same `queryVec`
 * parameter a live embedding enters by, so ranking, MMR, the page cap, the
 * scope filter, `manifest.tuning` and a `guard.tau` overridden in the site's
 * config all apply exactly as they do to every other turn. A frozen list of
 * chunk ids would have been smaller and would have quietly ignored all six.
 *
 * The consequence worth stating: an opener hit is byte-identical to an ordinary
 * turn minus one HTTP request. There is no second ranking path to keep in step,
 * and no state in which the panel answers from evidence the live pipeline would
 * not have chosen.
 *
 * PURE, and importing `embed.js` here would be a defect rather than a style
 * mistake — see the invariant in the docs-rag skill. Nothing in this file may
 * reach the network.
 */

import { normalise, questionsHash, terms } from './text.js'
import { lexicalCoverage } from './gate.js'
import { DEFAULT_SUGGESTIONS, MATCH_NEVER } from './switches.js'

/**
 * The list the panel WILL show, which is the list the build baked.
 *
 * `DocPilot.vue` falls back to the built-in three when a project configured
 * none, so a project that configured none still shows three chips and those
 * three still deserve a bake. Both sides read this one function so the
 * fingerprint they compare cannot be a fingerprint of two different lists.
 */
export function openerQuestions(suggestions) {
  const configured = suggestions?.questions
  return configured?.length ? configured : DEFAULT_SUGGESTIONS
}

/**
 * The fingerprint the two sides compare — the questions AND the answers written
 * for them.
 *
 * `questionsHash(openerQuestions(...))` was enough while every baked answer was
 * derived: an author who edited what a model would write edited the corpus, the
 * prompt or the model, and all three are already covered by `hash` and by the
 * per-answer stamp. An AUTHORED answer is none of those. It lives in the config
 * beside the question, so a rewritten paragraph under an unchanged question
 * moved nothing at all — and a bundle carrying the previous paragraph would go
 * on being served, correctly stamped, indefinitely.
 *
 * So the answer text and the ids it cites go into the same hash. It is still
 * derived on both sides from the resolved config rather than carried in the
 * bundle, which is what keeps there being one answer to "is this bake current".
 */
export function openerFingerprint(suggestions) {
  const questions = openerQuestions(suggestions)
  const authored = suggestions?.authored
  if (!authored?.length) return questionsHash(questions)
  return questionsHash([
    ...questions,
    ...authored.map((a) => `${a.q} ${a.answer} ${a.cite.join(' ')}`),
  ])
}

/**
 * Base64 int8 → the float domain the retriever dots against.
 *
 * `embedQuery` L2-normalises and multiplies by 127 (embed.js), which is what
 * makes the int8 dot product a cosine without a per-query rescale. The bake
 * stores that vector quantised to int8, so the widening here is the whole of
 * the inverse: no scaling, no normalisation, one copy.
 *
 * `Int8Array` over the decoded bytes rather than arithmetic on each byte: the
 * sign is the point, and `charCodeAt` would hand back 0..255 with the negative
 * half of the vector silently reflected.
 */
function widen(b64, dims) {
  if (typeof b64 !== 'string' || !b64) return null
  let bin
  try {
    bin = atob(b64)
  } catch {
    return null
  }
  if (bin.length !== dims) return null
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const signed = new Int8Array(bytes.buffer)
  const out = new Float64Array(dims)
  for (let i = 0; i < dims; i++) out[i] = signed[i]
  return out
}

/**
 * How much of one question's rare wording the other covers — in BOTH directions.
 *
 * `lexicalCoverage` is the gate's own L: it ranks the query's terms by corpus
 * rarity, caps the list at the twelve rarest, and returns the fraction of those
 * the evidence text contains. Reused rather than reimplemented because it
 * already runs through `terms()` — the single tokenizer behind `df.json`, the
 * gate and MiniSearch's query side — so an opener and a question are compared
 * with the same stemmer, stop list and vocabulary the index was built with.
 *
 * BM25 was the other candidate and is the wrong tool: its scores are unbounded
 * and corpus-relative, so a fixed threshold against them means something
 * different on every site, and a second MiniSearch over three documents would
 * have a three-document rarity distribution, which is not a rarity distribution.
 * L is in [0, 1] and is the same unit `tau` is written in.
 *
 * SYMMETRY IS NOT A REFINEMENT. One direction alone is a containment test, and
 * containment fires on a fragment: "gate" scores 1.0 against "How do I configure
 * the refusal gate?" because every one of its rare terms is present. The reader
 * asking about one thing would be handed the answer to another, with citations
 * that are real, checkable, and about the other thing. `min` of the two
 * directions is what "the same question, phrased differently" actually means.
 */
export function similarity(a, b, df) {
  if (!terms(a).length || !terms(b).length) return 0
  return Math.min(lexicalCoverage(a, b, df).L, lexicalCoverage(b, a, df).L)
}

/**
 * The question in front of us, if this build already resolved it.
 *
 * Returns `null` far more often than not, and every early return below is a
 * case where leaning on the bake would be wrong rather than merely unhelpful.
 *
 * @returns null | {entry, matched: 'exact'|'lexical', score, queryVec, answer}
 */
export function matchOpener(question, { index, config, scope, quote, turns, locale, uiLocale }) {
  const suggestions = config?.suggestions
  if (suggestions?.precomputed === false) return null

  const bundle = index?.openers
  if (!bundle?.entries?.length) return null

  /**
   * TWO FINGERPRINTS, and they answer two different questions.
   *
   * `hash` asks "was this baked against the corpus that is loaded" — the file is
   * content-addressed, so this can only fail on a deployment serving mismatched
   * artefacts, and a mismatch means the chunk ids and the vector space are both
   * from somewhere else.
   *
   * `configHash` asks "was this baked for the questions that are configured" —
   * and this one fails routinely and by design. An author edits a question and
   * ships without reindexing; the fingerprint moves, the whole bundle is
   * ignored, and every turn embeds as it did before the feature existed. There
   * is no state in which a question can be served a vector computed for a
   * different question, because the guard is over the list rather than over the
   * entry.
   */
  if (bundle.hash !== index.manifest?.hash) return null
  if (bundle.configHash !== openerFingerprint(suggestions)) return null

  const key = normalise(question)
  if (!key) return null

  let entry = bundle.entries.find((e) => e.qnorm === key) || null
  let matched: 'exact' | 'lexical' = 'exact'
  let score = 1

  if (!entry) {
    /**
     * The paraphrase pass, and it is allowed to decline.
     *
     * `MATCH_NEVER` is a threshold coverage cannot reach, which is what
     * `matchTau: false` resolves to — the rule stays here and stops firing.
     *
     * A TIE REFUSES. Two openers a paraphrase fits equally well is the
     * build-time confusability warning arriving at runtime, and picking the
     * first of them by array order would be picking by the order the author
     * happened to type them in.
     */
    const tau = suggestions?.matchTau ?? MATCH_NEVER
    if (tau > 1) return null
    let best = null
    let bestScore = tau
    let tied = false
    for (const e of bundle.entries) {
      const s = similarity(question, e.q, index.df)
      if (s < bestScore) continue
      if (best && s === bestScore) tied = true
      else {
        tied = false
        best = e
        bestScore = s
      }
    }
    if (!best || tied) return null
    entry = best
    matched = 'lexical'
    score = bestScore
  }

  /**
   * The vector, and the two reasons there might not be one.
   *
   * A vectorless index bakes no vectors because there is nothing to bake — the
   * whole corpus is BM25 and the query side of a BM25 search is the text. A
   * site that DECLARED `embed.lexicalOnly` is the same statement from the other
   * end: `submit()` will not use a query vector, so handing it one would be
   * handing it something it has already decided not to look at.
   *
   * Either way the match still stands. The bake's other half — the answer — is
   * exactly as valid, and a lexical-only site is the one that most wants it.
   */
  const queryVec =
    config?.embed?.lexicalOnly || index.lexicalOnly ? null : widen(entry.vec, index.manifest.dims)

  /**
   * The answer is served under FOUR conditions, and each one is a way it could
   * otherwise be the wrong answer rather than a slower one.
   *
   *   · `answers` is on — rule 11, and the switch that reverts the expensive
   *     half of the bake without touching the cheap half.
   *   · the scope is all the docs. The answer was written against the whole
   *     corpus; serving it to a reader who narrowed the scope on purpose would
   *     be answering from pages they excluded, and every citation would prove
   *     it.
   *   · nothing is attached and nothing came before. A quote and a previous
   *     turn are both antecedents, and an answer written with neither in hand is
   *     an answer to a different question than the one being asked.
   *   · the language matches. See `answerFor`.
   */
  const answer =
    suggestions?.answers === false ||
    scope?.kind !== 'all' ||
    quote ||
    turns?.length
      ? null
      : answerFor(entry, locale, uiLocale)

  return { entry, matched, score, queryVec, answer }
}

/**
 * The margin a dense match has to win by — engine-specs/017.
 *
 * `matchTau`'s tie rule, in the unit cosine is written in. Two openers a
 * paraphrase fits equally well is not a close call to be settled by array order,
 * and in a dense space an exact tie never happens: the scores differ in the
 * third decimal and one of them wins by nothing. So "equal" has to be a band
 * rather than a value, and a question inside it is answered by the model, which
 * is the outcome that existed before this pass did.
 */
const DENSE_MARGIN = 0.05

/**
 * The opener this question MEANS, from the vector the turn already bought.
 *
 * Runs after `matchOpener` has declined and after the query has been embedded,
 * which is the only reason it can be free: `session.js` calls it on the vector
 * the retrieval was going to be run with either way, so a hit costs one dot
 * product per opener — three of them, over 1024 or 2048 int8 lanes — and a miss
 * costs the same.
 *
 * `null` MEANS NOTHING CLEARED THE BAR. A cleared bar is reported even when the
 * baked TEXT is not servable — wrong language, per `answerFor` — because the
 * MATCH itself is real information a caller can use for something other than
 * serving English prose to a Russian reader: `session.js` primes the turn with
 * the matched entry's own resolved evidence, engine-spec 018. `answer` is
 * therefore nullable on a non-null result; a caller that only wants the servable
 * case checks `.answer`, not truthiness.
 *
 * This pass still never returns a VECTOR and never changes what `retrieval.
 * search` ranks — the entry's vector is for comparison only, and priming is an
 * addition to a turn's evidence, not a change to its retrieval.
 *
 * @returns null | {entry, matched: 'dense', score, answer}, answer possibly null
 */
export function matchOpenerDense(queryVec, { index, config, scope, quote, turns, locale, uiLocale }) {
  const suggestions = config?.suggestions
  if (!queryVec || suggestions?.precomputed === false) return null
  if (suggestions?.answers === false) return null
  const tau = suggestions?.matchCos ?? MATCH_NEVER
  if (tau > 1) return null

  const bundle = index?.openers
  if (!bundle?.entries?.length) return null
  if (bundle.hash !== index.manifest?.hash) return null
  if (bundle.configHash !== openerFingerprint(suggestions)) return null

  // The three antecedent rules `matchOpener` states at length, and they bind
  // harder here: a dense match is already the looser of the two tests, so the
  // conditions under which a baked answer is the WRONG answer are not relaxed
  // for it as well.
  if (scope?.kind !== 'all' || quote || turns?.length) return null

  const dims = index.manifest?.dims
  let best = null
  let bestScore = -Infinity
  let runnerUp = -Infinity
  for (const e of bundle.entries) {
    const vec = widen(e.vec, dims)
    if (!vec) continue
    const s = cosine(queryVec, vec)
    if (s > bestScore) {
      runnerUp = bestScore
      bestScore = s
      best = e
    } else if (s > runnerUp) {
      runnerUp = s
    }
  }
  if (!best || bestScore < tau) return null
  if (runnerUp > -Infinity && bestScore - runnerUp < DENSE_MARGIN) return null

  const answer = answerFor(best, locale, uiLocale)
  return { entry: best, matched: 'dense' as const, score: bestScore, answer }
}

/**
 * Two vectors that are both already L2-normalised and scaled by 127.
 *
 * `/ 16129` is `retriever.js`'s own line, and it is the whole of the conversion:
 * `embedQuery` normalises and multiplies by 127 so that an int8 dot product IS a
 * cosine, and both sides of this one went through it. Duplicated rather than
 * imported because the retriever's `dot` walks a packed corpus buffer by row
 * offset and this walks two loose vectors — same arithmetic, different shape.
 */
function cosine(a, b) {
  let sum = 0
  for (let i = 0; i < b.length; i++) sum += a[i] * b[i]
  return sum / 16129 // 127²
}

/**
 * The baked answer, if it is in the reader's language — and BOTH selectors have
 * to agree before it is.
 *
 * `locale` is the language of the text that was typed. `uiLocale` is the
 * language of the page. i18n.js already draws this distinction and states why:
 * one selector for both would either answer a Russian greeting in English or
 * write Russian into an English page's chrome.
 *
 * Here it is load-bearing in a way that is easy to miss. A CHIP is not the
 * reader's sentence, it is the author's — the text is whatever the config file
 * says, so `detectLanguage` of it reports the AUTHOR's language on every click,
 * for every reader, in every locale. On English docs with English openers,
 * `locale` is therefore always `en`, and a rule that consulted it alone would
 * hand the English baked answer to a reader of the Russian build of the same
 * site. Which is precisely the reader this rule exists for.
 *
 * So the page has a vote. A Russian locale reading an English opener falls
 * through to the model, which answers in Russian — with the evidence already
 * resolved, so it still costs no embedding request. A typed question in a third
 * language cannot reach here at all: it matches no opener, lexically or
 * exactly, and the turn is an ordinary turn.
 *
 * PRIMARY SUBTAGS, and NOT `normaliseLocale`. That function answers "which panel
 * translation has this package shipped", falling back to `en` for everything
 * else — so a site published in French with no French override block would
 * normalise to `en` and be handed an English answer. The question here is about
 * the reader's language, not about this package's coverage of it.
 */
export function answerFor(entry, locale, uiLocale = locale) {
  const a = entry?.answer
  if (!a?.text || !a.citations?.length) return null
  const lang = primaryOf(a.lang)
  return lang === primaryOf(locale) && lang === primaryOf(uiLocale) ? a : null
}

/** `zh-CN` and `zh` are one language; `fr` and `en` are not. */
export const primaryOf = (l) => String(l || 'en').toLowerCase().split('-')[0]
