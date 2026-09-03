/**
 * Resolving the openers at index time — engine-specs/009.
 *
 * The questions on the panel's empty state — three of them by default, five at
 * most — are the most-asked questions on any docs site by construction: every
 * reader who opens the panel without one of their own sees them, and clicking
 * one is the cheapest thing they can do. Until now it was also one of the most expensive things the site could do
 * — an embedding request and a model call, per reader, for a question the
 * author wrote down weeks earlier and has not changed since.
 *
 * So this resolves them where the budget belongs to the author: it embeds each
 * question, runs the shipped retrieval and the shipped gate over it, and — when
 * the site asks for it — has the shipped harness write the answer. What comes
 * out ships beside the index as `openers.<hash>.json`.
 *
 * NOTHING HERE IS A SECOND IMPLEMENTATION. `embedQuery`, `assembleIndex`,
 * `createRetrieval` and `runTurn` are the browser's own modules, imported and
 * called; the only thing this file contributes is the order they are called in
 * and the shape they are written down in. A separate build-side ranker would be
 * a ranker that silently stops agreeing with the one readers use.
 *
 * IT NEVER FAILS THE BUILD. Every failure below degrades to "no bundle", and a
 * missing bundle is the behaviour that shipped before this existed. Publishing
 * documentation must not depend on an embedder being up for an optimisation.
 */

import { embedQuery } from '../../theme/docpilot/embed.js'
import { assembleIndex } from '../../theme/docpilot/store.js'
import { createRetrieval } from '../../theme/docpilot/retriever.js'
import { runTurn } from '../../theme/docpilot/harness.js'
import { normalise } from '../../theme/docpilot/text.js'
import { detectLanguage, localeOf, promptHash } from '../../theme/docpilot/prompt.js'
import { openerFingerprint, similarity } from '../../theme/docpilot/openers.js'
import { l2normalise, toInt8, quantisationError } from './quantize.js'

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

/**
 * The stamp on an answer no model wrote.
 *
 * It occupies both `promptHash` and `model` because those two fields are the
 * cache key for "has this already been asked", and a written answer has not been
 * asked and never will be. A sentinel in both is what makes the freshness test
 * below fail closed for these entries without a branch of its own.
 */
const AUTHORED = 'authored'

/**
 * The int8 vector, as the bundle carries it.
 *
 * Base64 of the raw bytes rather than an array of 2048 numbers: the array form
 * is roughly 4× the bytes for the identical information, and this file is
 * fetched beside a 965 KB vector blob where 4× of anything is worth avoiding.
 */
const encodeVec = (int8) => Buffer.from(int8.buffer, int8.byteOffset, int8.byteLength).toString('base64')

/**
 * One question's vector, cache first.
 *
 * `embedQuery` rather than the indexer's own `embedBatch`, and the difference is
 * the entire correctness of the dense channel here: `embedBatch` applies
 * `search_document: ` because everything it has ever been handed was a document,
 * and an opener is a QUERY. `embedQuery` applies `search_query: ` by the
 * identical `/nomic/i` test, so the two sides of the asymmetry are decided by
 * one rule in one file.
 *
 * The cache namespace folds the prefix in (`embed-cache.js`), so the query-side
 * rows can never be confused with the document-side rows of the same model —
 * and a rebuild whose questions have not changed spends nothing.
 *
 * Cached POST-`l2normalise`, which is that module's stated contract; the ×127
 * that makes the int8 dot product a cosine is applied after the read, so a hit
 * and a miss produce the same number.
 */
async function vectorFor(question, { model, provider, baseURL, apiKey, cache }, embedFn) {
  const hit = cache?.get(question)
  if (hit) return Float32Array.from(hit)
  const scaled = await embedFn(question, { provider, baseURL, model, apiKey })
  const unit = Float32Array.from(scaled as ArrayLike<number>, (v: number) => v / 127)
  cache?.set(question, unit)
  return unit
}

/**
 * Resolve every opener, and write down what was resolved.
 *
 * @returns {{bundle, json, entries, report}} — `bundle` is null when nothing
 *          could be resolved, and the caller writes no file and sets no
 *          manifest key.
 */
export async function bakeOpeners({
  questions,
  /**
   * The answers the author wrote — `{q, answer, cite}`, resolved by
   * `resolveSuggestions` — engine-specs/017.
   *
   * Applied BEFORE the model loop and never re-derived: an authored answer is
   * not a cheaper way to get the model's answer, it is a different answer, and
   * the whole point of writing one is that the build must not paraphrase it.
   */
  authored = [],
  manifest,
  chunks,
  vectorBuffer,
  dfDoc,
  hash,
  embed,
  chat,
  docPilot,
  answers = true,
  matchTau = 0.65,
  previous = null,
  warn = console.warn,
  /**
   * The two network calls, injected — the same seam `createEmbedder({batch})`
   * opens in the indexer and for the same reason: everything worth testing here
   * is the ORDER these are called in and the shape of what is written down, and
   * neither is testable against a live embedder and a live model.
   *
   * Defaulted to the production functions, so no caller has to know they exist.
   */
  embedFn = embedQuery,
  turnFn = runTurn,
}) {
  const report = { embedded: 0, cached: 0, answered: 0, authored: 0, reused: 0, reusedRefusal: 0, refused: [], covered: [], uncitable: [], collisions: [], qErr: null }
  if (!questions.length) return { bundle: null, json: null, entries: [], report }

  const index = assembleIndex({ manifest, shards: [chunks], vectorBuffer, dfDoc })
  const retrieval = createRetrieval({
    index,
    scope: ALL_SCOPE,
    guard: manifest.guard,
    tuning: manifest.tuning,
  })

  /**
   * Two openers a paraphrase would fit equally well.
   *
   * Computed with the RUNTIME scorer, so this is not an approximation of the
   * risk — it is the risk, evaluated on the author's own inputs before a reader
   * meets it. Reported rather than refused: which of two near-neighbours to
   * rename is an editorial decision, and a build that will not run until it is
   * made is a build that gets `precomputed: false` instead.
   */
  for (let i = 0; i < questions.length; i++) {
    for (let j = i + 1; j < questions.length; j++) {
      const s = similarity(questions[i], questions[j], index.df)
      if (s >= matchTau) report.collisions.push({ a: questions[i], b: questions[j], score: s })
    }
  }

  const raw = []
  const entries = []
  for (const q of questions) {
    let unit = null
    if (!index.lexicalOnly) {
      const before = embed.cache?.stats().hits ?? 0
      try {
        unit = await vectorFor(q, embed, embedFn)
      } catch (e) {
        warn(`[docpilot] the embedder did not answer for "${q}" (${e.message}) — no openers baked`)
        return { bundle: null, json: null, entries: [], report }
      }
      if ((embed.cache?.stats().hits ?? 0) > before) report.cached++
      else report.embedded++
      raw.push(unit)
    }

    /**
     * The vector the READER will use, not the one the embedder returned.
     *
     * Quantising here and widening back means the gate score printed below is
     * the score the panel will compute, to the last decimal. Scoring the
     * float and shipping the int8 would print a number nobody can reproduce —
     * small, but it is the number an author decides to rewrite a question on.
     */
    const int8 = unit ? toInt8(l2normalise(unit)) : null
    const queryVec = int8 ? Float64Array.from(int8) : null
    const mode = index.lexicalOnly ? 'lexical-only' : 'hybrid'
    const g = retrieval.evaluate({ question: q, previousQuestion: null, queryVec, mode })
    if (!g.pass) report.refused.push({ q, G: g.G, threshold: g.threshold })

    entries.push({
      q,
      qnorm: normalise(q),
      lang: localeOf(detectLanguage(q)),
      vec: int8 ? encodeVec(int8) : null,
      // The build's own report, and NOT what the panel reads: the runtime
      // re-ranks from `vec` so that a lever moved after this bake is honoured.
      // Written down because a refused opener has to be legible a year later,
      // and because the docs-rag skill reads it.
      ids: g.chunks.map((c) => c.id),
      gate: {
        pass: g.pass, G: g.G, D: g.D, L: g.L, z: g.z, n: g.n,
        channel: g.channel, threshold: g.threshold, mode: g.mode,
      },
      answer: null,
      // Present only when a model was asked and wrote nothing citable — the
      // cache key for that fact. Absent on every entry nobody has asked for.
      answerAttempt: null,
    })
  }

  /**
   * COMMIT, or the cache is a Map that dies with the process.
   *
   * `openEmbedCache` writes nothing until it is told which texts this run used —
   * that is what makes it self-evicting. Without this line every rebuild
   * re-bought the same three vectors while reporting a cache, which is the exact
   * failure the cache exists to prevent, wearing its uniform.
   *
   * Committed with the questions in configured order, so an opener the author
   * removed stops costing disk on the next build.
   */
  embed.cache?.commit(questions)

  /**
   * The quantisation error the QUERY side pays.
   *
   * The corpus side has been measured and gated at 0.01 since the index shipped
   * (`build-rag-index.js`), and the query side has never been quantised before,
   * so it arrives with no number. Measured on the same function and reported
   * beside it rather than asserted: three vectors is not a sample worth failing
   * a build on, and the corpus gate already stands between this corpus and a
   * model whose int8 behaviour is bad.
   */
  if (raw.length) report.qErr = quantisationError(raw)

  /**
   * THE WRITTEN ANSWERS, before anything is asked of a model.
   *
   * Three things this does not do, and each of them is the reason a written
   * answer is worth having at all:
   *
   *   · IT DOES NOT CONSULT THE GATE. The gate asks whether the corpus supports
   *     a question; a written answer names the chunks it stands on, and those
   *     ids ARE that support, checked one at a time below. An opener the gate
   *     refuses is exactly the FAQ entry an author is most likely to write out
   *     by hand — the answer is spread across four pages and no single one of
   *     them scores — so refusing it here would retire the feature for its own
   *     best case.
   *   · IT DOES NOT ASK A MODEL, so it needs no key, no pool and no allowance,
   *     and it works on a `searchOnly` site where nothing else in this block
   *     runs.
   *   · IT DOES NOT REUSE. `previous` is a cache of what a model wrote; the
   *     config is the source for this, and it is already loaded.
   *
   * AN UNRESOLVABLE CITATION DROPS THE ANSWER, and the question survives it.
   * `settleAnswer` looks each citation up in `index.byId` and silently discards
   * the misses, so an id that has been renamed by a docs edit would ship as
   * prose with no sources under it — the exact artefact the model path refuses
   * to produce. Checked here instead, once, against the index this build just
   * wrote.
   */
  if (answers && authored?.length) {
    const byQuestion = new Map(authored.map((a) => [normalise(a.q), a]))
    for (const e of entries) {
      const a = byQuestion.get(e.qnorm)
      if (!a) continue
      const unknown = a.cite.filter((id) => !index.byId.has(id))
      if (unknown.length) {
        warn(
          `[docpilot] the written answer to "${e.q}" cites ${unknown.map((id) => `"${id}"`).join(', ')}, ` +
            `which this index does not contain — not baked; the model answers it instead`,
        )
        report.uncitable.push({ q: e.q, ids: unknown })
        continue
      }
      e.answer = {
        lang: localeOf(detectLanguage(e.q)),
        text: a.answer,
        citations: a.cite,
        confidence: null,
        // The stamp says WHO wrote it, and `AUTHORED` can never collide with a
        // prompt hash or a model id — so the reuse test below, which asks
        // whether the same model under the same prompt already answered, is
        // structurally incapable of matching one of these.
        promptHash: AUTHORED,
        model: AUTHORED,
      }
      report.authored++
      /**
       * A refused opener with a written answer is not a refused opener.
       *
       * `report.refused` prints a four-line warning about a chip that fails on
       * the reader's first click. That warning is the whole value of the check
       * and it is FALSE here — the click lands on prose the author wrote — so
       * the row moves rather than being suppressed: the gate score is still
       * worth seeing, and what it means now is "the corpus does not answer this
       * on its own, which is why you wrote one".
       */
      const refused = report.refused.findIndex((r) => r.q === e.q)
      if (refused >= 0) report.covered.push(report.refused.splice(refused, 1)[0])
    }
  }

  if (answers && !chat?.searchOnly && chat?.model) {
    for (const e of entries) {
      // Already written by hand. Asking a model to produce a second answer to a
      // question that has one would spend a request to build a string nothing
      // reads.
      if (e.answer) continue
      if (!e.gate.pass) continue
      /**
       * The answer cache: same question, same corpus, same prompt, same model →
       * the same answer, and no request.
       *
       * Every one of the four has to match. `hash` moving means the pages the
       * answer cites have changed, which is the failure a frozen answer would
       * otherwise become; `promptHash` moving means the instruction that shaped
       * it has; the model moving means a different writer.
       */
      /**
       * The answer cache, and it caches the REFUSAL too.
       *
       * Caching only successes looked right and was a per-build tax: an opener
       * whose answer came back uncited is dropped, so the next build found no
       * prior answer and asked again — the same corpus, the same prompt, the
       * same model, the same nothing, once per build forever. On a free tier
       * that is the most expensive question on the site being the one that
       * never produces anything.
       *
       * `answerAttempt` records that the four keys below were tried. It is the
       * difference between "nobody has asked" and "this was asked and the model
       * wrote nothing worth shipping", and only the second is worth skipping.
       * Any of the four moving retries: a corpus edit is exactly the thing that
       * can turn an uncitable question into a citable one.
       */
      const before = previous?.entries?.find((p) => p.qnorm === e.qnorm)
      const stamp = before?.answer ?? before?.answerAttempt
      const fresh =
        previous?.hash === hash && stamp?.promptHash === chat.promptHash && stamp?.model === chat.model
      if (fresh && before.answer) {
        e.answer = before.answer
        report.reused++
        continue
      }
      if (fresh) {
        e.answerAttempt = before.answerAttempt
        report.reusedRefusal++
        continue
      }
      const vec = e.vec ? Float64Array.from(Buffer.from(e.vec, 'base64')) : null
      const g = retrieval.evaluate({
        question: e.q, previousQuestion: null, queryVec: vec, mode: e.gate.mode,
      })
      let res
      try {
        res = await turnFn({
          retrieval,
          gateResult: g,
          question: e.q,
          history: [],
          addendum: '',
          config: {
            llm: chat.llm,
            maxIterations: chat.maxIterations,
            guard: manifest.guard,
            scope: { promptListLimit: 12 },
            prompt: docPilot.prompt,
            product: docPilot.product,
          },
          queryVec: vec,
        })
      } catch (err) {
        // NOT stamped as an attempt: a transport failure is not the model
        // declining to write, and the next build has every reason to try again.
        warn(`[docpilot] no answer baked for "${e.q}" (${err.message})`)
        continue
      }
      /**
       * AN UNCITED ANSWER IS NEVER BAKED, and this is the one hard floor in the
       * file.
       *
       * It is the same `untraceable` test the panel applies to a live answer,
       * and the reason is stronger here: a live uncited answer is a turn the
       * reader can retry, and a baked one is a turn every reader gets until the
       * next build. Prose about the corpus with nothing in the corpus behind it
       * must not become an artefact.
       */
      if (!res.text?.trim() || !res.citations?.length) {
        warn(`[docpilot] "${e.q}" produced an answer with no citations — not baked`)
        e.answerAttempt = { promptHash: chat.promptHash, model: chat.model }
        continue
      }
      e.answer = {
        lang: localeOf(detectLanguage(e.q)),
        text: res.text,
        citations: res.citations,
        confidence: res.confidence ?? null,
        promptHash: chat.promptHash,
        model: chat.model,
      }
      report.answered++
    }
  }

  const bundle = {
    hash,
    configHash: openerFingerprint({ questions, authored }),
    embedModel: manifest.embedModel,
    dims: manifest.dims,
    matchTau,
    entries,
  }
  return { bundle, json: JSON.stringify(bundle), entries, report }
}

/** What the build prints — the freshness check, and the reason this pass earns its place. */
export function renderOpenerReport({ entries, report, matchTau, configHash }) {
  const lines = []
  const bought = report.embedded + report.cached
  const answers = report.answered + report.reused + report.reusedRefusal
  lines.push(
    `  openers          ${entries.length} question(s) · configHash ${configHash}` +
      (bought ? ` · ${report.embedded} embedded, ${report.cached} cached` : '') +
      (report.authored ? ` · ${report.authored} answered by you` : '') +
      (answers
        ? ` · answers ${report.answered} written, ${report.reused + report.reusedRefusal} reused`
        : ''),
  )
  for (const e of entries) {
    const mark = e.gate.pass ? '✓' : '✗'
    // `authored` rather than a byte count: the size of a paragraph the author
    // can read in their own config is not news, and which of the two wrote it
    // is the only thing this line cannot otherwise say.
    const answer = e.answer
      ? e.answer.model === AUTHORED
        ? `  authored, ${e.answer.citations.length} citation(s)`
        : `  answer ${Buffer.byteLength(e.answer.text)} B`
      : ''
    lines.push(
      `    ${mark} ${e.gate.G.toFixed(2)}  ${JSON.stringify(e.q)}  ${e.ids.length} chunk(s)${answer}`,
    )
  }
  for (const c of report.uncitable) {
    lines.push(
      `    UNCITED  ${JSON.stringify(c.q)} was answered in your config, citing`,
      `             ${c.ids.map((id) => JSON.stringify(id)).join(', ')} —`,
      `             not in this index. The written answer is NOT baked and the`,
      `             model answers instead. Fix the ids, or reindex.`,
    )
  }
  for (const r of report.covered) {
    lines.push(
      `    covered  ${JSON.stringify(r.q)} scores ${r.G.toFixed(2)} against tau`,
      `             ${r.threshold.toFixed(2)} — the corpus does not answer it, and your`,
      `             written answer is what the click gets.`,
    )
  }
  if (report.qErr !== null) {
    lines.push(`    quantisation err ${report.qErr.toFixed(5)} mean |Δcos| on the query side`)
  }
  for (const r of report.refused) {
    lines.push(
      `    REFUSED  ${JSON.stringify(r.q)} scores ${r.G.toFixed(2)} against tau ${r.threshold.toFixed(2)}.`,
      `             This opener refuses on the reader's FIRST CLICK, in the one`,
      `             state that exists to show the panel working. Rewrite it, drop`,
      `             it, or write the page it asks for.`,
    )
  }
  for (const c of report.collisions) {
    lines.push(
      `    COLLIDES ${JSON.stringify(c.a)} and ${JSON.stringify(c.b)} score`,
      `             ${c.score.toFixed(2)} against each other, at or above matchTau`,
      `             ${matchTau} — a reader's paraphrase could land on either.`,
      `             Rename one, or set suggestions.matchTau: false.`,
    )
  }
  return lines
}
