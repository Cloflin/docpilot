/**
 * Retrieval and the scope choke point — RAG-SPEC 3.1, 3.3, 3.4.
 *
 * `createRetrieval({index, scope})` is the ONLY export that accepts an index.
 * harness.js closes its tool executors over the object this returns and never
 * holds a reference to the index — including for id resolution — so there is no
 * code path in which a tool argument can name a page the host has not admitted.
 */

import MiniSearch from 'minisearch'
import { terms, stemLite, STOP } from './text.js'
import {
  denseSeparation,
  denseFromCosine,
  lexicalCoverage,
  verdict,
  composeQuery,
  admissible,
  foreignTail,
  assertWeights,
} from './gate.js'

/**
 * Ranking constants — RAG-SPEC 7 levers 1 and 2, and the LAST of three layers.
 *
 * A lever that cannot be swept is a lever nobody pulls: `--gate-only` measures a
 * candidate in seconds, so the only thing standing between a hypothesis and a
 * number was having to edit the file. But editing the file is also all there was:
 * the literals below are what every consumer's bundle shipped, whatever their
 * corpus measured. Three layers now resolve to one value, in `resolveLevers`:
 *
 *   an explicitly-set DOCPILOT_<NAME>  — a sweep running on this shell, now
 *   > the per-instance `tuning` object — what `docpilot tune` measured on THIS
 *                                        corpus, inlined into the manifest
 *   > the constant below               — what was measured on ours
 *
 * THE ENV LAYER IS READ AT CALL TIME, out of `process.env`, and resolves to the
 * value it actually read. The timing is the whole of it. Every CLI entry point
 * loads `.env.local` into `process.env` AFTER the module graph is imported —
 * tune.js does it at its own top level, run.js and calibrate.js through
 * cli-context — and `.env.local` is exactly where every DocPilot doc tells a
 * consumer to put their `DOCPILOT_*` keys.
 *
 * So an env layer that answered out of the constants below would be reading a
 * fold taken BEFORE the file was loaded: `DOCPILOT_GATE_K=9` in `.env.local`
 * made `envIsSet` true from the moment the file landed while the constant still
 * said 5, and `resolveLevers` handed back 5 — discarding the env value AND the
 * manifest tuning, and pinning the lever to the package literal on the one path
 * the documentation actually recommends. Reading `process.env` and answering
 * from something else is the bug; they have to be the same read.
 *
 * `globalThis.process` is undefined in the browser, so `envLever` is NaN for
 * every name there and the rule collapses to `tuning ?? constant` — no bundler
 * has to define anything, at call time exactly as at import time.
 *
 * `resolveLevers` is the ONLY implementation of that precedence. run.js,
 * calibrate.js and tune.js import it rather than re-deriving it, because three
 * copies of a precedence rule are three different answers to the one question a
 * report has to be able to answer: which value did this run actually use.
 *
 * NOT sweepable here: tau, tauLexical, wDense, wLexical. Those live in the guard
 * and only `docpilot calibrate` may set them (RAG-SPEC 7).
 */
const envLever = (name) => {
  const raw = globalThis.process?.env?.[`DOCPILOT_${name}`]
  return raw === undefined || raw === '' ? NaN : Number(raw)
}
/**
 * The import-time fold, which is NOT the env layer of the precedence any more.
 *
 * It survives for one narrow job: `mmr()` and `rrf()` are exported with these as
 * DEFAULT PARAMETERS, so a caller who scores the objective directly — the λ
 * sweep, the tests — follows a variable exported on the shell without being
 * handed a third spelling of the rule. Every lever the retrieval itself reads
 * comes through `resolveLevers`, which re-reads `process.env` per call and never
 * consults this fold for the env layer; see the header for the `.env.local`
 * ordering that made the difference load-bearing.
 */
const tune = (name, dflt) => {
  const n = envLever(name)
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
 * The diversity lever for the path where MMR has none — at most this many chunks
 * of one page in the final set, applied INSTEAD of `mmr()` when there is no query
 * vector.
 *
 * The paragraph above ends "the lexical-only path survives: with no queryVec every
 * `rel` is 0, the greedy pick ties, and the pool keeps its RRF order". It survives
 * in the sense that it does not crash. What it does not do is diversify: at λ=1.0
 * the redundancy term is multiplied by (1 − λ) = 0, so `simTo.pair` — which in the
 * vectorless branch is exactly the same-page indicator this cap re-derives — is
 * dead code, and one page can take all of GATE_K. That is the shape lexical-only
 * least affords: with no dense channel to cross-check it, a page whose wording
 * happens to repeat the query's rare terms wins every slot on the strength of one
 * lucky vocabulary.
 *
 * A cap rather than a lexical-similarity MMR at λ<1, for two reasons. The first is
 * that λ is a MEASURED number and a manifest-tuned one — `docpilot tune` sweeps it
 * over cosine geometry, and feeding it a token-overlap similarity it was never
 * measured against silently repurposes a value the manifest claims was measured.
 * The second is that the similarity in question would mostly re-derive page
 * membership anyway, so the cap says the thing directly, in O(pool), deterministic
 * and testable, and leaves the hybrid path bit-identical.
 *
 * 2, not 1. The λ measurement above is unambiguous that "several sections of one
 * page is the shape an answer needs"; a cap of 1 would over-rotate against the one
 * finding on this axis that has numbers behind it. 2 keeps the shape and stops the
 * sweep.
 *
 * `sectionExpand` may still pull a same-page `next` after this runs — deliberate.
 * That is answer shape, not retrieval redundancy, and the cap governs what was
 * SELECTED, not what a short selected chunk drags in behind it.
 */
const PAGE_CAP = tune('PAGE_CAP', 2)
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
/**
 * BM25's own three, and the two field boosts — MiniSearch's defaults and ours,
 * written down where a sweep can reach them.
 *
 * These five were never decided; they were inherited. `k`, `b` and `d` are
 * MiniSearch's `defaultBM25params` verbatim, and nothing in this package had ever
 * named them, so the one lexical scoring function DocPilot ships was the only part
 * of retrieval that could not be measured — which matters most in the mode where
 * it is the ONLY scoring function. The values below reproduce what shipped, so
 * this is plumbing at identity: until a sweep moves one, every number this file
 * has ever reported still stands.
 *
 * `b` is the one to reach for first. It is the length normalisation, and this
 * corpus is chunks with a context line — far more uniform in length than the web
 * pages BM25's defaults were fitted on.
 *
 * The boosts are the existing constructor literals, read through the same fold so
 * there is one spelling of each: `miniSearchFor` uses them as the floor for a bare
 * `ms.search()`, and the retrieval passes the fully resolved values per search.
 */
const BM25_K = tune('BM25_K', 1.2)
const BM25_B = tune('BM25_B', 0.7)
const BM25_D = tune('BM25_D', 0.5)
const BOOST_TITLE = tune('BOOST_TITLE', 2)
const BOOST_BREADCRUMB = tune('BOOST_BREADCRUMB', 1.5)
/**
 * THE ROUTE AND THE HEADING SLUG, indexed — two fields the chunks have carried
 * since the first build and nothing ever searched.
 *
 * A reader who types `getting-started`, or a `search_docs` argument naming a
 * route, could only reach a page through its prose: `/guide/getting-started` was
 * a field on every chunk and a term in no index. `indexTokens` already splits on
 * `[./#-]`, so the route enters as the compound plus `guide`, `getting`,
 * `started` — which is exactly the shape that makes a half-remembered URL a
 * usable query.
 *
 * `kind` is deliberately NOT a field. It is a FILTER, and indexing its four enum
 * values would put `guide` and `reference` in the vocabulary of every chunk that
 * has them — inflating the document frequency of two words this corpus uses in
 * their ordinary sense on nearly every page.
 *
 * The anchor carries the slightly higher boost of the two because it is the
 * heading a reader landed on and is nearly always a phrase from the docs; a path
 * segment is as often structural (`reference`, `guide`) as it is topical, so it
 * enters at parity and earns no thumb.
 */
const BOOST_PATH = tune('BOOST_PATH', 1.0)
const BOOST_ANCHOR = tune('BOOST_ANCHOR', 1.25)

/**
 * The allowlist, and the reason `tuning` is not just spread over the defaults.
 *
 * A tuning object arrives from a manifest, which arrives from a file a consumer
 * commits; `resolveLevers` reads only these names out of it, so a
 * `tau` that finds its way in there — by hand, by a merge, by a future writer
 * being helpful — resolves to nothing rather than to a threshold the guard never
 * agreed to. The build drops such a key loudly; this is the second wall.
 *
 * BEING HERE IS NOT BEING IN `MEASURED_LEVER_NAMES`. That build-side allowlist is
 * narrower on purpose: a name in a manifest's `tuning` object is a claim that
 * `docpilot tune` swept it on that corpus, and `tune` sweeps two. The six names
 * added below — PAGE_CAP and the five lexical scoring levers — are env-sweepable
 * here so `eval --gate-only --lexical` can measure them, and are dropped loudly by
 * `tuningFor` if they turn up in a tuning.json. They can all move `L`, and `L` is
 * half of `G`, so the road from a hand-edited file to a moved verdict is exactly
 * the road that allowlist exists to close.
 */
export const LEVER_NAMES = [
  'RRF_K',
  'W_LEXICAL_RRF',
  'W_DENSE_RRF',
  'MMR_LAMBDA',
  'PAGE_CAP',
  'CANDIDATES',
  'FUSED',
  'EXPAND_BELOW_TOKENS',
  'GATE_K',
  'BM25_K',
  'BM25_B',
  'BM25_D',
  'BOOST_TITLE',
  'BOOST_BREADCRUMB',
  'BOOST_PATH',
  'BOOST_ANCHOR',
]

const FALLBACK = {
  RRF_K,
  W_LEXICAL_RRF,
  W_DENSE_RRF,
  MMR_LAMBDA,
  PAGE_CAP,
  CANDIDATES,
  FUSED,
  EXPAND_BELOW_TOKENS,
  GATE_K,
  BM25_K,
  BM25_B,
  BM25_D,
  BOOST_TITLE,
  BOOST_BREADCRUMB,
  BOOST_PATH,
  BOOST_ANCHOR,
}

/**
 * Is this lever pinned by the environment, and to WHAT — one read, one answer.
 *
 * Exported because `docpilot tune` has to ask the question and must not re-derive
 * it: its whole job is to vary the `tuning` object that this layer outranks, so a
 * pinned axis makes all ~99 of its cells measure the identical retrieval, and a
 * second copy of the parse in tune.js would be a second opinion about which runs
 * are degenerate. The env variable's own spelling is returned with the value for
 * the same reason — the message that names it must name what is really read.
 *
 * "Set" still means "parses as a finite number", which is what keeps a typo out
 * of the precedence: `DOCPILOT_MMR_LAMBDA=high` returns null here, so the lever
 * falls through to the tuning object rather than resolving to NaN and taking
 * every comparison downstream with it. An empty value is treated the same, since
 * `DOCPILOT_GATE_K=` is a shell that ate the value, not a decision.
 *
 * @param {string} name  one of LEVER_NAMES
 * @returns {{env: string, value: number}|null}
 */
export function envPin(name) {
  const value = envLever(name)
  return Number.isFinite(value) ? { env: `DOCPILOT_${name}`, value } : null
}

/**
 * @param {object|null} tuning  manifest.tuning — per-corpus levers, or null
 * @returns {{RRF_K:number, W_LEXICAL_RRF:number, W_DENSE_RRF:number, MMR_LAMBDA:number, PAGE_CAP:number, CANDIDATES:number, FUSED:number, EXPAND_BELOW_TOKENS:number, GATE_K:number, BM25_K:number, BM25_B:number, BM25_D:number, BOOST_TITLE:number, BOOST_BREADCRUMB:number, BOOST_PATH:number, BOOST_ANCHOR:number}}
 */
export function resolveLevers(tuning: Record<string, number> | null = null) {
  const out: Record<string, number> = {}
  for (const name of LEVER_NAMES) {
    // The env layer resolves to the value THIS CALL read, never to `FALLBACK`:
    // the constants folded `process.env` at import, and `.env.local` lands after
    // it, so answering out of them turns a set variable into the package literal
    // and drops the tuning object on the way past. See the header.
    const pin = envPin(name)
    out[name] = pin ? pin.value : (tuning?.[name] ?? FALLBACK[name])
  }
  return out
}

/**
 * The tokenizer, and it is ASYMMETRIC on purpose.
 *
 * MiniSearch's default splitter breaks at every non-alphanumeric, so
 * `window.initEditor` indexes as two ordinary words and the compound the reader
 * actually typed is not a term at all. `terms()` — the tokenizer `df.json` and
 * the gate's L are both built from — keeps `.`, `/`, `#` and `-` inside a token,
 * which is the right shape for a corpus made of identifiers and routes.
 *
 * Used alone it trades one failure for a worse one. `window.initEditor` becomes
 * the single token `window.initeditor`, and a search for the bare `initEditor`
 * then cannot reach it — `prefix: true` does not save it either, because a
 * prefix match walks from the START of a term. Measured over this corpus:
 * `initEditor` went from 14 hits to 1. A bare identifier is exactly what a
 * `search_docs` call tends to be, so that is the common case, not a corner.
 *
 * So the index emits BOTH — the compound and its parts — while the query side
 * stays plain `terms()`. A reader who types the compound matches the compound; a
 * reader who types one half matches through the part. MiniSearch supports this
 * directly: a top-level `tokenize` governs indexing, and `searchOptions.tokenize`
 * overrides it for queries.
 *
 * NOT the reason: keeping BM25's vocabulary aligned with `df.json`. MiniSearch
 * never reads `df.json` — it derives its own document frequencies, and `index.df`
 * is consumed only by `lexicalCoverage`. The two lexical channels do different
 * jobs and their alphabets were free to differ. This change has to earn its place
 * on measurement alone, and the measurement is below.
 *
 * The extra `fieldName` argument MiniSearch passes is ignored by arity, and the
 * default `processTerm` lowercases a string `terms()` has already lowercased.
 */
const indexTokens = (s) => {
  const out = []
  for (const t of terms(s)) {
    out.push(t)
    if (!/[./#-]/.test(t)) continue
    for (const part of t.split(/[./#-]+/)) {
      /**
       * STEMMED, like every other word — and this is the one place the
       * asymmetry above must NOT extend to.
       *
       * `terms()` returns the compound whole, and `stemLite` refuses to touch a
       * token carrying a separator, so a compound arrives here unstripped and
       * correctly so. Its PARTS are ordinary words: `plugin.settings` splits to
       * `plugin` and `settings`, while a reader typing `settings` on the query
       * side gets `setting`. Pushing the raw part would put a form in the index
       * that no query can now produce — the compound tokenizer's whole purpose,
       * inverted.
       */
      const stem = stemLite(part)
      if (stem.length >= 2 && !STOP.has(part)) out.push(stem)
    }
  }
  return out
}

/**
 * One MiniSearch instance over the whole corpus, never rebuilt per scope.
 *
 * MEASURED, with the corrected `underPath` — and read the two numbers as the
 * different things they are.
 *
 * The LEXICAL CHANNEL ALONE gains a lot: over the golden positives recall@8 goes
 * roughly 0.32 → 0.42 and MRR 0.16 → 0.27, and the index builds about 7× faster,
 * because the stop words leave it and the prefix and fuzzy trie walks collapse.
 * (Those two figures were taken before the metrics fix and are understated in
 * absolute terms; the direction is not in doubt.)
 *
 * THE SHIPPED PIPELINE gains a part of it, because the dense channel was already
 * finding much of what the lexical one missed. `--gate-only` over the 60 records
 * on text-embedding-3-small / 1216 chunks:
 *
 *   recall@8      0.7386 → 0.7841   +4.5pp, per-record 2 wins and 0 losses
 *   MRR           0.4857 → 0.4734   -1.2pp
 *   retrieval F1  0.3012 → 0.2975   -0.4pp
 *
 * with gate over-refusal, negatives caught and scope containment all unmoved. The
 * two records that move are q-31 and q-34, both extension-API questions whose gold
 * page is named by a dotted identifier the default splitter took apart.
 *
 * MRR pays about a point for it. That is the honest cost and it is inside the
 * two-point revert rule, but it is not nothing: `evaluate()` builds the evidence
 * text for L out of the TOP 3 of this list, so rank feeds the gate as well as the
 * answer. Watch it if this is swept again.
 *
 * A NOTE ON AN EARLIER VERSION OF THIS COMMENT. It reported +2.3pp and "2 wins,
 * 1 loss", and told a story about q-26 losing its gold chunk because a short
 * follow-up is mostly stop words. That loss was an artefact of the broken
 * `underPath` — q-26's gold is a split section, and the old matcher scored the
 * right chunk as a miss. There was no stop-word regression. The lesson is the
 * instrument, not the lever.
 *
 * A THING THIS TOUCHES THAT LOOKS UNRELATED: `evaluate()` builds L's evidence out
 * of this list, so changing the ranking changes L, and L is half of G. On this set
 * no verdict moved — gate over-refusal stayed 0/44, negatives caught stayed 3/16 —
 * but `tau` was calibrated against the old distribution, and RAG-SPEC 5.6 wants a
 * recalibration pass for changes of this class. It is owed.
 */
let miniCache = null
function miniSearchFor(index) {
  if (miniCache?.hash === index.manifest.hash) return miniCache.ms
  const ms = new MiniSearch({
    fields: ['text', 'title', 'breadcrumb', 'path', 'anchor'],
    storeFields: ['path'],
    idField: 'id',
    tokenize: indexTokens,
    searchOptions: {
      boost: {
        title: BOOST_TITLE,
        breadcrumb: BOOST_BREADCRUMB,
        path: BOOST_PATH,
        anchor: BOOST_ANCHOR,
      },
      bm25: { k: BM25_K, b: BM25_B, d: BM25_D },
      prefix: true,
      fuzzy: 0.2,
      tokenize: terms,
    },
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

/**
 * Reciprocal rank fusion. Rank-derived, so its output carries no absolute meaning.
 *
 * `rrfK` is a parameter and not a closed-over constant so that a sweep can score
 * a hundred grid cells against one loaded index in-process, without a module
 * reload per cell.
 */
function rrf(lists, rrfK = RRF_K) {
  const scores = new Map()
  for (const { ids, weight } of lists) {
    ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + weight / (rrfK + rank + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/**
 * Maximal marginal relevance. Without it three of five slots go to one page.
 *
 * Exported for the λ sweep, which needs to score the objective directly rather
 * than through a whole retrieval — and for the tests, which pin what the two ends
 * of the λ range mean: at 1.0 the redundancy term drops out and this is a
 * relevance re-rank, at 0 relevance drops out and it is a pure diversity filter.
 */
export function mmr(ids, simTo, k, lambda = MMR_LAMBDA) {
  const picked = []
  const pool = [...ids]
  while (picked.length < k && pool.length) {
    let best = null
    let bestScore = -Infinity
    for (const id of pool) {
      const rel = simTo.query(id)
      const red = picked.length ? Math.max(...picked.map((p) => simTo.pair(id, p))) : 0
      const score = lambda * rel - (1 - lambda) * red
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

/**
 * At most `cap` chunks per page, in the order they arrived, then backfilled.
 *
 * The lexical-only stand-in for `mmr()` — see PAGE_CAP. Two properties it has to
 * have, and both are load-bearing:
 *
 * ORDER IS PRESERVED. The pool arrives in RRF order, which in lexical-only is BM25
 * rank, and nothing here reorders it — a cap is a filter, not a re-rank. That is
 * what makes this a drop-in for the branch where `mmr()` at λ=1.0 already
 * degenerates to the pool's own order.
 *
 * IT NEVER RETURNS FEWER THAN `mmr()` WOULD. On a corpus of three pages a cap of 2
 * would otherwise hand back 6 chunks where 8 were asked for, and a short set is a
 * worse failure than a repetitive one — the model would be reasoning from less
 * evidence, not more diverse evidence. So overflow is kept and appended, in pool
 * order, until k is met. The cap shapes the head of the set; it does not shorten
 * it.
 *
 * Exported for the tests, which pin both of those, and for a sweep that wants to
 * score the objective without standing up a whole retrieval.
 */
export function pageCap(ids, byId, k, cap = PAGE_CAP) {
  const picked = []
  const overflow = []
  const seen = new Map()
  for (const id of ids) {
    if (picked.length >= k) break
    const path = byId.get(id)?.path
    const n = seen.get(path) || 0
    if (n >= cap) {
      overflow.push(id)
      continue
    }
    seen.set(path, n + 1)
    picked.push(id)
  }
  for (const id of overflow) {
    if (picked.length >= k) break
    picked.push(id)
  }
  return picked
}

export class ScopeEscape extends Error {}

/**
 * @param {object}  index    from store.loadIndex()
 * @param {object}  scope    { kind, paths, label } — frozen for the turn
 * @param {object}  guard    manifest.guard, possibly overridden by config
 * @param {object}  tuning   manifest.tuning — per-corpus levers, or null
 * @param {boolean} dev      throw on a GATE 2 escape instead of filtering silently
 */
export function createRetrieval({
  index,
  scope,
  guard,
  tuning = null,
  dev = false,
  onDebug = null,
}) {
  assertWeights(guard)

  /**
   * Resolved ONCE per retrieval, and every lever read below goes through it.
   *
   * A bare constant left anywhere inside this closure is not a small
   * inconsistency: it is a lever that the manifest says was tuned and that the
   * running code ignores, and nothing downstream can see the difference — the
   * report would name the tuned value and the retrieval would use ours.
   */
  const T = resolveLevers(tuning)

  const allow = !scope || scope.kind === 'all' ? null : new Set(scope.paths)
  const inScope = (c) => allow === null || allow.has(c.path)

  /**
   * The backward half of `c.next`.
   *
   * The chunker writes a FORWARD pointer only (`chunker.js`, `openapi-chunker.js`)
   * and `sectionExpand` below has never needed the other direction. `expand_section`
   * does, and the alternative — a `prev` field in every chunk of every shipped
   * index — would change the index format, move the corpus hash, and make every
   * consumer rebuild for a value that is derivable in one pass at load.
   *
   * Built here rather than in the store because this is the only reader: a map
   * the size of the corpus, built once per retrieval object, not per turn.
   */
  const prevOf = new Map()
  for (const c of index.chunks) if (c.next) prevOf.set(c.next, c.id)
  const scopedChunks = allow === null ? index.chunks : index.chunks.filter(inScope)
  const ms = miniSearchFor(index)

  /**
   * An index built with no embedder, which is NOT the runtime degradation of an
   * embedder that stopped answering: there is no vector space here for a query
   * vector to be scored in, and no later turn in which one appears.
   *
   * Settled once, so the two entry points that take a query vector can drop it
   * at the top and every dense arithmetic site below keeps the single condition
   * it already tests — a missing query vector — instead of growing a second.
   */
  const vectorless = !index.vectors || !index.dims

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

  /**
   * The scoring half of every `ms.search` this retrieval makes.
   *
   * `boost` and `bm25` come from `T` rather than from the constructor, because the
   * constructor is memoised on the manifest hash and `T` is per-retrieval: two
   * instances over one index may resolve different levers, and the instance that
   * built the cache must not decide for the one that found it. The constructor's
   * own copies are the floor for a search made outside this closure; both read the
   * same module fold, so there is one spelling of each number.
   */
  const lexOpts = (filter = null) => ({
    boost: {
      title: T.BOOST_TITLE,
      breadcrumb: T.BOOST_BREADCRUMB,
      path: T.BOOST_PATH,
      anchor: T.BOOST_ANCHOR,
    },
    bm25: { k: T.BM25_K, b: T.BM25_B, d: T.BM25_D },
    ...(filter ? { filter } : {}),
  })

  /**
   * Scope, and `kind` when the model asked for one, as a MiniSearch `filter`.
   *
   * Same results as filtering the returned array — MiniSearch applies `filter`
   * before its own sort, and a filter either side of a sort by score leaves the
   * relative order alone — but it is the search that now knows what the caller
   * will accept. That matters for `kind`: filtering afterwards could only shrink a
   * list already truncated to CANDIDATES, so a rare kind was answered out of
   * whatever survived a search that had never heard of it.
   *
   * IDF stays corpus-global. One instance over the whole corpus, never rebuilt per
   * scope — the gate needs the whole-corpus distribution to know what a rare term
   * is, and a per-scope index would redefine rarity for every reader.
   */
  const lexFilter = (kind) => {
    if (allow === null && !kind) return null
    return (r) =>
      (allow === null || allow.has(r.path)) &&
      (!kind || index.byId.get(r.id)?.kind === kind)
  }

  const lexical = (query, k, kind = null) =>
    ms
      .search(query, lexOpts(lexFilter(kind)))
      .slice(0, k)
      .map((r) => r.id)

  const dense = (queryVec, k, kind = null) => {
    if (!queryVec) return { ids: [], cosines: [], scopedMax: 0 }
    // Computed over the FULL array and masked afterwards: the gate needs the
    // whole-corpus distribution to know what "similar" means for this query.
    const cosines = new Float64Array(index.chunks.length)
    for (let i = 0; i < index.chunks.length; i++) {
      cosines[i] = dot(index.vectors, index.dims, i, queryVec)
    }
    // `scopedMax` is the best the SCOPE holds and is deliberately not narrowed by
    // `kind`: it is the gate's D, the gate never passes a kind, and a maximum
    // taken over a model-chosen subset would answer a different question than the
    // one the threshold was calibrated against.
    let scopedMax = -1
    const scored = []
    for (const c of scopedChunks) {
      const v = cosines[c.row]
      if (v > scopedMax) scopedMax = v
      if (kind && c.kind !== kind) continue
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
      if (c.text.length / 3.6 >= T.EXPAND_BELOW_TOKENS) continue
      const next = c.next && index.byId.get(c.next)
      if (next && !have.has(next.id)) {
        out.push(next)
        have.add(next.id)
      }
    }
    return gate2(out)
  }

  function rank({
    query,
    queryVec,
    k = 5,
    kind = null,
    question,
    previousQuestion,
    composedVec,
    mode,
  }: {
    query?: string
    queryVec?: any
    k?: number
    kind?: string | null
    question?: string
    previousQuestion?: string | null
    composedVec?: any
    mode?: string
  }) {
    // Dropped ahead of the width check, which would otherwise read every query
    // vector as a mismatch against a `dims` of 0. A mismatch is a disagreement
    // between two vector spaces; here there is only one.
    if (vectorless) queryVec = null
    // A vector of the wrong width means the embed model changed under a cached
    // index. Degrade to lexical-only — the mode the spec already defines for a
    // missing embedder — rather than scoring garbage or throwing mid-turn.
    if (queryVec && queryVec.length !== index.dims) {
      onDebug?.('dim-mismatch', { got: queryVec.length, want: index.dims })
      queryVec = null
    }
    const fuse = (l, d) =>
      rrf(
        [
          { ids: l, weight: T.W_LEXICAL_RRF },
          { ids: d.ids, weight: T.W_DENSE_RRF },
        ],
        T.RRF_K,
      ).slice(0, T.FUSED)

    // `kind` is the one filter the model may request, and it can only intersect —
    // a kind the corpus does not have under this query must not silently widen the
    // search, so an empty result falls back to the unfiltered pool rather than to
    // nothing. What changed is WHERE it intersects: both channels now generate
    // candidates that already satisfy it, so the fallback is a genuinely empty
    // kind rather than a kind that merely lost the truncation.
    let lex = lexical(query, T.CANDIDATES, kind)
    let den = dense(queryVec, T.CANDIDATES, kind)
    let pool = fuse(lex, den)
    if (kind && !pool.length) {
      lex = lexical(query, T.CANDIDATES)
      den = dense(queryVec, T.CANDIDATES)
      pool = fuse(lex, den)
    }

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

    // The vectorless branch takes the cap, not MMR. `queryVec` has been through
    // both drops above, so this is the same condition every dense arithmetic site
    // below already tests, and the hybrid path is untouched.
    const diverse = queryVec
      ? mmr(pool, simTo, Math.min(k, pool.length), T.MMR_LAMBDA)
      : pageCap(pool, index.byId, Math.min(k, pool.length), T.PAGE_CAP)
    const chunks = gate2(diverse.map((id) => index.byId.get(id)))
    return { chunks: sectionExpand(chunks), lexIds: lex, dense: den }
  }

  return {
    scope,

    /** Model-facing arguments ONLY. No path, no page set, no scope parameter. */
    search({
      query,
      queryVec,
      k = 5,
      kind = null,
    }: {
      query: string
      queryVec?: any
      k?: number
      kind?: string | null
    }) {
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

    /**
     * The chunk before or after one the model already has.
     *
     * Same discriminated shape as `fetch`, and for the same reason — it must not
     * be possible to tell an id that does not exist from one this turn's scope
     * excludes. `no-neighbour` is a THIRD outcome and is safe to distinguish:
     * "this section is the last on its page" is a fact about a page the model has
     * already been shown, so it leaks nothing it did not have.
     *
     * Expansion is same-page by construction, because `next` is written per page
     * and never crosses into the following one.
     */
    expand(id, direction) {
      const c = index.byId.get(id)
      if (!c) return { ok: false, reason: 'unknown-id' }
      if (!inScope(c)) return { ok: false, reason: 'out-of-scope' }
      const neighbourId = direction === 'prev' ? prevOf.get(id) : c.next
      const n = neighbourId ? index.byId.get(neighbourId) : null
      if (!n) return { ok: false, reason: 'no-neighbour' }
      // A neighbour outside the scope is an id that does not exist as far as this
      // turn is concerned, and is reported as the same nothing.
      if (!inScope(n)) return { ok: false, reason: 'no-neighbour' }
      return { ok: true, section: n }
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
    evaluate({
      question,
      previousQuestion,
      queryVec,
      composedVec,
      mode = 'hybrid',
    }: {
      question: string
      previousQuestion?: string | null
      queryVec?: any
      composedVec?: any
      mode?: string
    }) {
      /**
       * A lexical-only INDEX is a mode, not a mismatch.
       *
       * The block below names a real disagreement in the debug channel — a
       * vector of one width scored against an index of another — and whoever
       * reads that event goes looking for an embed model that changed under a
       * cached index. An index built without an embedder disagrees with
       * nothing: this is the mode the deployment chose, so it is named as such
       * and reported no further.
       *
       * `composedVec` keeps the undefined/null distinction the composed channel
       * runs on: undefined means "no second query to score", null means "score
       * it lexically". Collapsing them here would silently drop the channel.
       */
      if (vectorless) {
        queryVec = null
        composedVec = composedVec === undefined ? undefined : null
        mode = 'lexical-only'
      }
      /**
       * A query vector of the wrong width is a MISSING embedder, not a weak one.
       *
       * `rank` has always dropped it — scoring a 2048-wide vector against a
       * 1024-wide index is arithmetic on unrelated numbers — but it dropped it
       * silently, three levels below the only place that knows what `mode`
       * means. So D came back 0 from a run still labelled `hybrid`, the gate
       * scored G against the hybrid threshold instead of `tauLexical`, and every
       * question — including the most on-topic one in the corpus — refused while
       * the panel reported a healthy search. Naming the mode here is what makes
       * the refusal legible and the fallback the one RAG-SPEC 3.2 defines.
       *
       * Reachable whenever an index outlives the model that built it, which a
       * free embedding pool makes ordinary rather than exotic.
       */
      if (queryVec && queryVec.length !== index.dims) {
        onDebug?.('dim-mismatch', { got: queryVec.length, want: index.dims })
        queryVec = null
        composedVec = composedVec === undefined ? undefined : null
        mode = 'lexical-only'
      }
      const run = (query, vec) => {
        const r = rank({ query, queryVec: vec, k: T.GATE_K })
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
      let admissibleBy = null
      const composed = composeQuery(question, previousQuestion)
      if (composed && composedVec !== undefined) {
        const c = run(composed, composedVec)
        const byTerm = admissible(question, c.evidence)
        /**
         * `foreignTail` abstains where the term test has nothing to measure, and
         * it is restricted to a scored dense channel on purpose: what replaces
         * the veto is the dense floor, and in lexical-only there is no dense
         * floor to replace it with — G is L there, and abstaining would hand a
         * foreign tail the antecedent's L with nothing at all standing behind
         * it. The remedy on that deployment shape is `vocabulary`, which makes
         * the tail's terms corpus terms and the veto measurable again.
         */
        const byScript = !byTerm && mode !== 'lexical-only' && foreignTail(question, index.df)
        admissibleTail = byTerm || byScript
        admissibleBy = byTerm ? 'lexical' : byScript ? 'foreign-tail' : null
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
      } else if (allow !== null && mode === 'lexical-only') {
        /**
         * The same question, asked of the only channel this mode has.
         *
         * The block above is gated on dense cosines existing, which in
         * lexical-only they never do — so `wouldPassUnscoped` was structurally
         * false, every scoped refusal was reported as `no-evidence` even when the
         * answer sat one directory away, and the one-click widen affordance could
         * not render at all. The reader was told the docs did not cover their
         * question when what was true is that their scope did not.
         *
         * Symmetric with the dense arm by construction: top 3 of an UNSCOPED
         * search, the raw `question` (not the composed channel's query — the same
         * choice the dense arm makes, for the same reason: this measures the
         * corpus, not the conversation), the same `lexicalCoverage`, the same
         * `verdict` and therefore the same `tauLexical`. It introduces no
         * threshold and moves no primary `G`, so nothing here is owed a
         * recalibration — and `unscopedG_lex`, which `docpilot calibrate` has
         * always recorded and always found null, starts carrying the value
         * RAG-SPEC 5.6 step 3 needs to re-derive the boolean at another tau.
         *
         * Costs one extra `ms.search` per scoped turn, on the path that has no
         * embedding request to pay for.
         */
        const unscopedEvidence = ms
          .search(question, lexOpts())
          .slice(0, 3)
          .map((r) => index.byId.get(r.id)?.text || '')
          .join('\n')
        const { L } = lexicalCoverage(question, unscopedEvidence, index.df)
        const v = verdict({ D: 0, L, mode, guard })
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
        // WHICH test admitted the channel, not merely that one did: `admissible`
        // is now the disjunction of a term match and a script abstention, and a
        // calibration record that cannot tell them apart cannot tell whether a
        // stratum moved because the corpus matched or because nothing could.
        admissibleBy,
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
      /**
       * The lexical branch is not only the missing-embedder fallback: a
       * VECTORLESS INDEX takes it too, and the choice has to be made here
       * because this is the one entry point whose query vector never passes
       * through `rank`. A deployment that names an embedder over an index built
       * without one — the disagreement `readiness()` reports rather than
       * prevents — embeds the question perfectly well and arrives holding a
       * vector with nothing to score it against.
       */
      const scored =
        queryVec && !vectorless
          ? pool
              .map((c) => [c, dot(index.vectors, index.dims, c.row, queryVec)])
              .sort((a, b) => b[1] - a[1])
              .map(([c]) => c)
          : ms
              .search(query, lexOpts())
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
