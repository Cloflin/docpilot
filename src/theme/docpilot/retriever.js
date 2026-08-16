/**
 * Retrieval and the scope choke point — RAG-SPEC 3.1, 3.3, 3.4.
 *
 * `createRetrieval({index, scope})` is the ONLY export that accepts an index.
 * harness.js closes its tool executors over the object this returns and never
 * holds a reference to the index — including for id resolution — so there is no
 * code path in which a tool argument can name a page the host has not admitted.
 */

import MiniSearch from 'minisearch'
import { terms } from './text.js'
import {
  denseSeparation,
  denseFromCosine,
  lexicalCoverage,
  verdict,
  composeQuery,
  admissible,
  assertWeights,
} from './gate.js'

/**
 * Ranking constants, sweepable from the environment.
 *
 * These are RAG-SPEC 7 lever 1 and 2, and a lever that cannot be swept is a
 * lever nobody pulls: `--gate-only` measures a candidate in seconds, so the only
 * thing standing between a hypothesis and a number was having to edit the file.
 * `globalThis.process` is undefined in the browser, so the shipped bundle reads
 * the literals below and no bundler has to define anything.
 *
 * NOT sweepable here: tau, tauLexical, wDense, wLexical. Those live in the guard
 * and only `docpilot calibrate` may set them (RAG-SPEC 7).
 */
const tune = (name, dflt) => {
  const raw = globalThis.process?.env?.[`DOCPILOT_${name}`]
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) ? n : dflt
}

/**
 * 5, not the textbook 60. RRF weight is `w / (RRF_K + rank + 1)`, so a large K
 * flattens the curve until rank barely matters — which is the wrong shape once
 * MMR re-ranks the pool by dense cosine (see MMR_LAMBDA below) and RRF is only
 * selecting candidates. Swept `--gate-only` on the 60-record set, recall@8:
 *
 *   RRF_K   0      1      2      3      5      10     15     20     60
 *           0.88   0.88   0.88   0.90   0.92   0.90   0.85   0.85   0.83
 *
 * The whole band 0–10 beats the old default, so this is a plateau the constant
 * was sitting outside of rather than a lucky point.
 */
const RRF_K = tune('RRF_K', 5)
/**
 * Equal weights. The 1.2 thumb on dense was measured as a 2-record loss
 * (recall@8 0.92 → 0.85 at RRF_K 5): with MMR ordering the survivors by dense
 * cosine, a dense-weighted fusion counts the same signal twice. It is the RATIO
 * that matters, not the magnitude — 1.2/1.2 scores identically to 1.0/1.0.
 */
const W_LEXICAL_RRF = tune('W_LEXICAL_RRF', 1.0)
const W_DENSE_RRF = tune('W_DENSE_RRF', 1.0)
/**
 * 0.9, not the original 0.7. Measured `--gate-only` over the golden positives,
 * monotone across 0.7 / 0.8 / 0.9 / 1.0:
 *
 *   lambda   retrieval F1   MRR     q-08 F1   q-11 F1
 *   0.7      0.531          0.704   0.00      0.00
 *   0.9      0.563          0.748   0.29      0.00
 *   1.0      0.632          0.757   0.29      0.57
 *
 * with gate over-refusal 0/12 and negatives 4/4 at every point. The diversity
 * penalty was evicting further sections OF THE CORRECT PAGE in favour of a
 * different page — on a corpus of 1191 small chunks the top hits for a question
 * are normally several sections of one page, which is the shape an answer needs.
 * Result sets still span 3.6 distinct pages at 0.9 (3.0 even at 1.0), so nothing
 * collapses onto a single page.
 *
 * 1.0 measures better still, but on 12 positives that last step rests on q-11
 * alone and 1.0 makes mmr() a no-op — decide it against the 60-record set.
 *
 * DECIDED on that set, 2026-08-12: 1.0. It wins on retrieval F1 (0.33 vs 0.29),
 * recall@8 (0.85 vs 0.83) and MRR with no gate regression, and the diversity
 * objection does not survive measurement — result sets still span 3.33 distinct
 * pages against 3.58, with single-page sets going 4 → 5 of 60.
 *
 * At 1.0 `mmr()` is NOT an identity: the score collapses to `rel`, which is the
 * dense cosine, so the stage stops being a diversity filter and becomes a
 * dense-cosine re-rank of the fused pool. RRF selects, dense orders. That is
 * also why the RRF weights above had to come level. The lexical-only path
 * survives: with no queryVec every `rel` is 0, the greedy pick ties, and the
 * pool keeps its RRF order.
 */
const MMR_LAMBDA = tune('MMR_LAMBDA', 1.0)
/**
 * 30, not 20 — deeper lexical and dense lists into the fusion. Worth one record
 * on recall@8 with a plateau at 30–35 (20 → 0.88, 25 → 0.88, 30 → 0.92,
 * 35 → 0.90); 40 alone is worse, so this is not "more is better".
 */
const CANDIDATES = tune('CANDIDATES', 30)
const FUSED = tune('FUSED', 12)
const EXPAND_BELOW_TOKENS = tune('EXPAND_BELOW_TOKENS', 150)
/** The gate's own k. The model's k is its tool argument, clamped 1..8 separately. */
const GATE_K = tune('GATE_K', 5)

/** One MiniSearch instance over the whole corpus, never rebuilt per scope. */
let miniCache = null
function miniSearchFor(index) {
  if (miniCache?.hash === index.manifest.hash) return miniCache.ms
  const ms = new MiniSearch({
    fields: ['text', 'title', 'breadcrumb'],
    storeFields: ['path'],
    idField: 'id',
    searchOptions: { boost: { title: 2, breadcrumb: 1.5 }, prefix: true, fuzzy: 0.2 },
  })
  ms.addAll(index.chunks)
  miniCache = { hash: index.manifest.hash, ms }
  return ms
}

function dot(vectors, dims, row, query) {
  const off = row * dims
  let sum = 0
  for (let i = 0; i < dims; i++) sum += vectors[off + i] * query[i]
  return sum / 16129 // 127²
}

/** Reciprocal rank fusion. Rank-derived, so its output carries no absolute meaning. */
function rrf(lists) {
  const scores = new Map()
  for (const { ids, weight } of lists) {
    ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + weight / (RRF_K + rank + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/** Maximal marginal relevance. Without it three of five slots go to one page. */
function mmr(ids, simTo, k) {
  const picked = []
  const pool = [...ids]
  while (picked.length < k && pool.length) {
    let best = null
    let bestScore = -Infinity
    for (const id of pool) {
      const rel = simTo.query(id)
      const red = picked.length ? Math.max(...picked.map((p) => simTo.pair(id, p))) : 0
      const score = MMR_LAMBDA * rel - (1 - MMR_LAMBDA) * red
      if (score > bestScore) {
        bestScore = score
        best = id
      }
    }
    picked.push(best)
    pool.splice(pool.indexOf(best), 1)
  }
  return picked
}

export class ScopeEscape extends Error {}

/**
 * @param {object}  index    from store.loadIndex()
 * @param {object}  scope    { kind, paths, label } — frozen for the turn
 * @param {object}  guard    manifest.guard, possibly overridden by config
 * @param {boolean} dev      throw on a GATE 2 escape instead of filtering silently
 */
export function createRetrieval({ index, scope, guard, dev = false, onDebug = null }) {
  assertWeights(guard)

  const allow = !scope || scope.kind === 'all' ? null : new Set(scope.paths)
  const inScope = (c) => allow === null || allow.has(c.path)
  const scopedChunks = allow === null ? index.chunks : index.chunks.filter(inScope)
  const ms = miniSearchFor(index)

  /** GATE 2 — a post-condition on the final set. Expected to be a no-op. */
  const gate2 = (chunks) => {
    const kept = chunks.filter(inScope)
    if (kept.length !== chunks.length) {
      const escaped = chunks.filter((c) => !inScope(c)).map((c) => c.id)
      if (dev) throw new ScopeEscape(`section expansion escaped the scope: ${escaped.join(', ')}`)
      onDebug?.('scope-escape', escaped)
    }
    return kept
  }

  const lexical = (query, k) =>
    ms
      .search(query)
      .filter((r) => allow === null || allow.has(r.path))
      .slice(0, k)
      .map((r) => r.id)

  const dense = (queryVec, k) => {
    if (!queryVec) return { ids: [], cosines: [], scopedMax: 0 }
    // Computed over the FULL array and masked afterwards: the gate needs the
    // whole-corpus distribution to know what "similar" means for this query.
    const cosines = new Float64Array(index.chunks.length)
    for (let i = 0; i < index.chunks.length; i++) {
      cosines[i] = dot(index.vectors, index.dims, i, queryVec)
    }
    let scopedMax = -1
    const scored = []
    for (const c of scopedChunks) {
      const v = cosines[c.row]
      if (v > scopedMax) scopedMax = v
      scored.push([c.id, v])
    }
    scored.sort((a, b) => b[1] - a[1])
    return { ids: scored.slice(0, k).map(([id]) => id), cosines, scopedMax: Math.max(scopedMax, 0) }
  }

  /** filter → expand → filter. Expansion is same-page only by construction. */
  const sectionExpand = (chunks) => {
    const out = [...chunks]
    const have = new Set(out.map((c) => c.id))
    for (const c of chunks) {
      if (c.text.length / 3.6 >= EXPAND_BELOW_TOKENS) continue
      const next = c.next && index.byId.get(c.next)
      if (next && !have.has(next.id)) {
        out.push(next)
        have.add(next.id)
      }
    }
    return gate2(out)
  }

  function rank({ query, queryVec, k = 5, kind = null }) {
    // A vector of the wrong width means the embed model changed under a cached
    // index. Degrade to lexical-only — the mode the spec already defines for a
    // missing embedder — rather than scoring garbage or throwing mid-turn.
    if (queryVec && queryVec.length !== index.dims) {
      onDebug?.('dim-mismatch', { got: queryVec.length, want: index.dims })
      queryVec = null
    }
    const lex = lexical(query, CANDIDATES)
    const den = dense(queryVec, CANDIDATES)
    const fused = rrf([
      { ids: lex, weight: W_LEXICAL_RRF },
      { ids: den.ids, weight: W_DENSE_RRF },
    ]).slice(0, FUSED)

    // `kind` is the one filter the model may request, and it can only intersect.
    const filtered = kind ? fused.filter((id) => index.byId.get(id)?.kind === kind) : fused
    const pool = filtered.length ? filtered : fused

    const rowOf = (id) => index.byId.get(id).row
    const simTo = {
      query: (id) => (queryVec ? dot(index.vectors, index.dims, rowOf(id), queryVec) : 0),
      pair: (a, b) => {
        if (!queryVec) return index.byId.get(a).path === index.byId.get(b).path ? 1 : 0
        const dims = index.dims
        const oa = rowOf(a) * dims
        const ob = rowOf(b) * dims
        let sum = 0
        for (let i = 0; i < dims; i++) sum += index.vectors[oa + i] * index.vectors[ob + i]
        return sum / 16129
      },
    }

    const diverse = mmr(pool, simTo, Math.min(k, pool.length))
    const chunks = gate2(diverse.map((id) => index.byId.get(id)))
    return { chunks: sectionExpand(chunks), lexIds: lex, dense: den }
  }

  return {
    scope,

    /** Model-facing arguments ONLY. No path, no page set, no scope parameter. */
    search({ query, queryVec, k = 5, kind = null }) {
      return rank({ query, queryVec, k: Math.min(Math.max(k, 1), 8), kind }).chunks
    },

    /**
     * Discriminated result, never a raw chunk: the harness must not be able to
     * tell "unknown id" from "out of scope", because the distinction is
     * information the model has no legitimate use for.
     */
    fetch(id) {
      const c = index.byId.get(id)
      if (!c) return { ok: false, reason: 'unknown-id' }
      if (!inScope(c)) return { ok: false, reason: 'out-of-scope' }
      return { ok: true, section: c }
    },

    /** Prefix-normalised AND scope-filtered. Unfiltered it is an id oracle. */
    pages(prefix) {
      let p = String(prefix || '/').trim()
      if (!p.startsWith('/')) p = `/${p}`
      p = p.replace(/\/$/, '') || '/'
      return index.manifest.pages
        .filter((page) => (allow === null || allow.has(page.path)))
        .filter((page) => p === '/' || page.path === p || page.path.startsWith(`${p}/`))
        .map((page) => ({ path: page.path, title: page.title, breadcrumb: page.tail }))
    },

    /**
     * The gate. Runs BEFORE the model is called; on a refusal no message is ever
     * built and no token is ever sent. RAG-SPEC 3.4, 4.2 step 0.
     */
    evaluate({ question, previousQuestion, queryVec, composedVec, mode = 'hybrid' }) {
      const run = (query, vec) => {
        const r = rank({ query, queryVec: vec, k: GATE_K })
        const evidence = r.lexIds
          .slice(0, 3)
          .map((id) => index.byId.get(id)?.text || '')
          .join('\n')
        const { L } = lexicalCoverage(query, evidence, index.df)
        const n = scopedChunks.length
        const { D, z } =
          mode === 'lexical-only'
            ? { D: 0, z: 0 }
            : guard.denseMode === 'zscore'
              ? denseSeparation(r.dense.cosines, r.dense.scopedMax, n, index.manifest.guard.zexp)
              : denseFromCosine(r.dense.scopedMax, guard)
        const v = verdict({ D, L, mode, guard })
        return { ...v, D, L, z, n, chunks: r.chunks, evidence, dense: r.dense }
      }

      const raw = run(question, queryVec)

      let best = { ...raw, channel: 'raw' }
      // `admissible` is reported, not just applied: RAG-SPEC 5.6 step 2 requires
      // `docpilot calibrate` to record it per probe, and a boolean that only ever exists
      // inside an && is a boolean nothing can measure. Evaluating it eagerly costs
      // one set intersection on turns after the first and changes no verdict.
      let admissibleTail = null
      const composed = composeQuery(question, previousQuestion)
      if (composed && composedVec !== undefined) {
        const c = run(composed, composedVec)
        admissibleTail = admissible(question, c.evidence)
        if (admissibleTail && c.G > best.G) best = { ...c, channel: 'composed' }
      }

      // wouldPassUnscoped selects the `out-of-scope` cause and its one-click
      // remedy, and is the reason a widen affordance renders ONLY when widening
      // would change the verdict.
      // `unscopedG` is the SCORE behind wouldPassUnscoped, not a second decision.
      // The boolean is a function of tau, so a threshold sweep that only has the
      // boolean cannot re-derive it at any other tau without re-embedding the
      // whole probe set — RAG-SPEC 5.6 step 3 requires exactly that re-derivation.
      let wouldPassUnscoped = false
      let unscopedG = null
      if (allow !== null && best.dense?.cosines?.length) {
        const all = index.chunks.length
        let max = 0
        for (let i = 0; i < all; i++) if (best.dense.cosines[i] > max) max = best.dense.cosines[i]
        const { D } =
          guard.denseMode === 'zscore'
            ? denseSeparation(best.dense.cosines, max, all, index.manifest.guard.zexp)
            : denseFromCosine(max, guard)
        const unscopedEvidence = index.chunks
          .map((c, i) => [i, best.dense.cosines[i]])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([i]) => index.chunks[i].text)
          .join('\n')
        const { L } = lexicalCoverage(question, unscopedEvidence, index.df)
        const v = verdict({ D, L, mode, guard })
        unscopedG = v.G
        wouldPassUnscoped = v.pass
      }

      return {
        pass: best.pass,
        G: best.G,
        D: best.D,
        L: best.L,
        z: best.z,
        n: best.n,
        channel: best.channel,
        threshold: best.threshold,
        mode,
        admissible: admissibleTail,
        wouldPassUnscoped,
        unscopedG,
        chunks: best.chunks,
      }
    },

    /** Closest pages for a refusal, ignoring the threshold. RAG-SPEC 13. */
    closest({ query, queryVec, outsideScope = false, limit = 3 }) {
      const pool = outsideScope ? index.chunks : scopedChunks
      const seen = new Set()
      const out = []
      const scored = queryVec
        ? pool
            .map((c) => [c, dot(index.vectors, index.dims, c.row, queryVec)])
            .sort((a, b) => b[1] - a[1])
            .map(([c]) => c)
        : ms
            .search(query)
            .map((r) => index.byId.get(r.id))
            .filter(Boolean)
            .filter((c) => (outsideScope ? true : inScope(c)))
      for (const c of scored) {
        if (outsideScope && inScope(c)) continue
        if (seen.has(c.path)) continue
        seen.add(c.path)
        const page = index.manifest.pages.find((p) => p.path === c.path)
        out.push({
          path: c.path,
          title: page?.title || c.title,
          tail: page?.tail || '',
          // Same rule as a cited source row: an imported page is offered as the
          // original it was imported from.
          origin: page?.origin || null,
        })
        if (out.length >= limit) break
      }
      return out
    },
  }
}
