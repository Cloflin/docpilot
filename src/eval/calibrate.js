#!/usr/bin/env node
/**
 * Gate calibration — RAG-SPEC 5.6.
 *
 *   npx docpilot calibrate
 *   npx docpilot calibrate --refresh        ignore the raw cache, re-embed
 *   npx docpilot calibrate --sweep-only     sweep the cache, embed nothing
 *   npx docpilot calibrate --limit=40       short loop while authoring probes
 *
 * NEEDS THE EMBED ENDPOINT ONLY. No chat model is contacted, ever: a threshold
 * that moves when a generator moves is not a threshold, and the whole point of
 * this file is that the same corpus and the same probes produce the same two
 * numbers on any machine. There is no LLM judge here and there must never be one
 * (`eval/metrics.js` states the same constraint for the same reason).
 *
 * `tau`, `tauLexical`, `wDense` and `wLexical` are set ONLY here (RAG-SPEC 7).
 * Everything downstream reads `${evalDir}/calibration.json`; nothing else may write it.
 *
 * The three expensive things — embedding, retrieval and the zExp ladder — are
 * computed once and cached to `${evalDir}/calibration.raw.jsonl` (gitignored). The
 * sweep is then a pure function of that cache, so re-running step 3 after a
 * change to the selection rule costs milliseconds instead of a full re-embed.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { assembleIndex } from '../theme/docpilot/store.js'
import { embedQuery } from '../theme/docpilot/embed.js'
import { createRetrieval } from '../theme/docpilot/retriever.js'
import { wilsonUpper95 } from './metrics.js'
import { nodeEmbedTarget } from '../config.js'

import {
  ROOT,
  RAG,
  CALIBRATION_SET,
  CALIBRATION_OUT,
  settings as docPilot,
  fileEnv,
} from '../cli-context.js'
const EVAL = path.dirname(CALIBRATION_SET)
const PROBES = path.join(EVAL, 'calibration.jsonl')
const RAW = path.join(EVAL, 'calibration.raw.jsonl')
const OUT_JSON = path.join(EVAL, 'calibration.json')
const OUT_MD = path.join(EVAL, 'calibration.report.md')

/** `.env.local` through the loader config.mjs uses. Existing environment wins. */
for (const [k, v] of Object.entries(await fileEnv())) {
  if (process.env[k] === undefined) process.env[k] = v
}

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const REFRESH = has('refresh')
const SWEEP_ONLY = has('sweep-only')
const LIMIT = Number(arg('limit', '0'))
/**
 * The embedder, from the project's own settings.
 *
 * These three used to default to a local Ollama regardless of what the index was
 * built with, so `docpilot calibrate` on a project embedding with a hosted service
 * either failed on an unreachable `localhost:11434` or — worse, if an Ollama
 * happened to be running — measured thresholds in a foreign vector space and
 * wrote them out as if they described this corpus.
 *
 * `nodeEmbedTarget` is the same resolver `docpilot index` uses, so the calibration
 * and the index cannot disagree about which model produced the vectors. The
 * environment still wins, for a sweep against a second endpoint.
 */
const EMBED_TARGET = nodeEmbedTarget(docPilot, process.env)
const EMBED_PROVIDER = process.env.DOCPILOT_EMBED_PROVIDER || EMBED_TARGET.provider
const EMBED_BASE = process.env.DOCPILOT_EMBED_URL || EMBED_TARGET.baseURL
// Read but never printed. The report and every log line below carry thresholds
// and probe ids, never a credential.
const EMBED_KEY = process.env.DOCPILOT_EMBED_KEY || EMBED_TARGET.apiKey || null

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

// ── strata ───────────────────────────────────────────────────────────────────

/**
 * The eleven strata of RAG-SPEC 5.6 step 1, and what each one is for.
 *
 * `positive` strata are scored on PASSING; everything else is scored on
 * REFUSING. `bound` is the UB95 ceiling from the RAG-SPEC 5.4 table — only the
 * three positive strata carry one, and `gatePrecision` deliberately does not:
 * step 6 says negative-catch is the objective maximised subject to over-refusal,
 * never a reason to raise tau.
 *
 * EXPORTED so `src/feedback/stratum.js` can suggest a stratum for a question a
 * reader actually asked, and be structurally unable to suggest one this
 * validator would then reject.
 */
export const STRATA = {
  U: { positive: true, bound: 0.05, metric: 'gateOverRefusal', label: 'unscoped positives' },
  S: { positive: true, bound: 0.05, metric: 'scopedGateOverRefusal', label: 'scoped positives' },
  F: { positive: true, bound: 0.08, metric: 'followupRefusalRate', label: 'follow-up pairs' },
  N1: { positive: false, label: 'adjacent product, absent here' },
  N2: { positive: false, label: 'plausible-but-absent API' },
  N3: { positive: false, label: 'off-domain technical' },
  N4: { positive: false, label: 'off-domain general (blatant)' },
  N5: { positive: false, label: 'off-domain after a legitimate previous turn' },
  N6: { positive: false, label: 'docs excerpt + off-domain ask' },
  X: { positive: false, label: 'scoped, gold outside the scope' },
  P: { positive: false, label: 'scoped, vocabulary overlap without the answer' },
}
const POSITIVE_STRATA = Object.keys(STRATA).filter((s) => STRATA[s].positive)

/** RAG-SPEC 3.4.1: the ladder is measured at these n, as real page scopes. */
const LADDER_N = [2, 6, 20, 40, 100, 300, 700, null] // null → the whole corpus

const die = (m) => {
  console.error(`\n  FAIL  ${m}\n`)
  process.exit(1)
}
const num = (v, d = 3) => (v == null || Number.isNaN(v) ? '  —  ' : v.toFixed(d))
const pct = (v) => (v == null ? '  — ' : `${(100 * v).toFixed(1)}%`)

/** Deterministic PRNG. Math.random would make a calibration unreproducible. */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

function loadIndex() {
  const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
  const shards = manifest.shards.map((s) => JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')))
  // `.buffer` on a Buffer is NOT the file: Node pools small allocations, so for
  // any vector blob under ~8 KB it is the whole pool and `assembleIndex`'s
  // length check refuses the index. Slice to the view's own bytes.
  const vecBuf = fs.readFileSync(path.join(RAG, manifest.vectors))
  const vectorBuffer = vecBuf.buffer.slice(vecBuf.byteOffset, vecBuf.byteOffset + vecBuf.byteLength)
  const dfDoc = JSON.parse(fs.readFileSync(path.join(RAG, manifest.df), 'utf8'))
  return assembleIndex({ manifest, shards, vectorBuffer, dfDoc })
}

function loadProbes() {
  if (!fs.existsSync(PROBES)) die(`no probe set at ${path.relative(ROOT, PROBES)}`)
  const recs = fs
    .readFileSync(PROBES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (e) {
        die(`${path.relative(ROOT, PROBES)}:${i + 1} is not JSON — ${e.message}`)
      }
    })
  const seen = new Set()
  for (const r of recs) {
    if (!r.id || !r.question || !r.stratum) die(`probe ${r.id || '?'} is missing id/question/stratum`)
    if (!STRATA[r.stratum]) die(`probe ${r.id} has unknown stratum "${r.stratum}"`)
    if (seen.has(r.id)) die(`duplicate probe id ${r.id}`)
    seen.add(r.id)
  }
  return LIMIT ? recs.slice(0, LIMIT) : recs
}

/**
 * The retrieval constants in force, so a cached row from a different sweep is
 * never silently reused. tau and friends are absent on purpose: they are what
 * this file produces, and nothing cached here depends on them.
 */
function levers() {
  const names = [
    'RRF_K',
    'W_LEXICAL_RRF',
    'W_DENSE_RRF',
    'MMR_LAMBDA',
    'CANDIDATES',
    'FUSED',
    'EXPAND_BELOW_TOKENS',
    'GATE_K',
  ]
  const out = {}
  for (const n of names) {
    const v = process.env[`DOCPILOT_${n}`]
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) out[n] = Number(v)
  }
  return out
}

// Bump when a row gains a field the sweep READS. A cache line written before
// the bump is missing that field, and `regate` would hand it back unswept —
// a silent half-swept run is worse than a re-embed that costs a cent.
const RAW_SCHEMA = 2 // 2: per-channel z/L for the window sweep

const sigOf = (rec, indexHash, lev) =>
  crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        RAW_SCHEMA,
        indexHash,
        rec.question,
        rec.prev_question || null,
        rec.scope || null,
        rec.stratum,
        lev,
      ]),
    )
    .digest('hex')
    .slice(0, 16)

// ── step 2: retrieval only, once per probe ───────────────────────────────────

/**
 * Page-contiguous scopes for the zExp ladder — RAG-SPEC 3.4.1, which forbids
 * random chunk samples: adjacent paragraphs of one page are exactly the
 * correlation the ladder exists to measure, and a random sample destroys it.
 * The run wraps at the end of the page list, so it is contiguous in sidebar
 * order modulo one seam.
 */
function contiguousScope(pages, targetN, startIdx) {
  const paths = []
  let total = 0
  for (let step = 0; step < pages.length && total < targetN; step++) {
    const p = pages[(startIdx + step) % pages.length]
    paths.push(p.path)
    total += p.chunks
  }
  return { kind: 'section', paths, label: `ladder n≈${targetN}`, n: total }
}

async function embed(text, index) {
  const vec = await embedQuery(text, {
    provider: EMBED_PROVIDER,
    baseURL: EMBED_BASE,
    model: index.manifest.embedModel,
    apiKey: EMBED_KEY,
  })
  if (vec.length !== index.manifest.dims) {
    die(
      `embed model mismatch: ${EMBED_PROVIDER} returned ${vec.length} dims, the index is ` +
        `${index.manifest.dims} (${index.manifest.embedModel}). Point the embedder at it:\n` +
        `          DOCPILOT_EMBED_PROVIDER=ollama\n` +
        `          DOCPILOT_EMBED_URL=http://localhost:11434`,
    )
  }
  return vec
}

/**
 * Everything the sweep needs, for one probe, at the guard the index ships.
 *
 * G, D, L, z and n do not depend on tau — the verdict does. `unscopedG` is
 * recorded rather than `wouldPassUnscoped` alone because the boolean IS a
 * function of tau (RAG-SPEC 5.6 step 3) and a sweep that cached only the boolean
 * would be re-deriving a decision from a decision.
 */
async function probeOne({ rec, index, guard, ladderPages }) {
  const scope = rec.scope || ALL_SCOPE
  const retrieval = createRetrieval({ index, scope, guard })

  const vec = await embed(rec.question, index)
  const composedText = rec.prev_question ? `${rec.prev_question}\n${rec.question}` : null
  const composedVec = composedText ? await embed(composedText, index) : undefined

  const hybrid = retrieval.evaluate({
    question: rec.question,
    previousQuestion: rec.prev_question,
    queryVec: vec,
    composedVec,
  })
  // The two channels, separately, through the public contract: a raw-channel
  // evaluate on the composed TEXT is exactly what the composed channel computes.
  const rawOnly = rec.prev_question
    ? retrieval.evaluate({ question: rec.question, queryVec: vec })
    : hybrid
  const composedOnly = composedText
    ? retrieval.evaluate({ question: composedText, queryVec: composedVec })
    : null

  // Dense disabled — RAG-SPEC 5.6 step 7. queryVec is withheld rather than
  // ignored: `lexical-only` is the mode where the embedder is UNREACHABLE, and
  // fusion behaves differently when there is no vector to fuse.
  const lexical = retrieval.evaluate({
    question: rec.question,
    previousQuestion: rec.prev_question,
    queryVec: null,
    composedVec: composedText ? null : undefined,
    mode: 'lexical-only',
  })

  // retrievalMisses — RAG-SPEC 5.4. `closest()` ignores the threshold and ranks
  // PAGES, which is the granularity this probe set carries (no gold chunk ids,
  // by RAG-SPEC 5.6 step 1). Page level is the more forgiving of the two, so a
  // miss reported here is a miss at chunk level too.
  let retrievalMiss = null
  if (rec.gold_page && STRATA[rec.stratum].positive) {
    const q = composedText || rec.question
    const qv = composedText ? composedVec : vec
    const dense = retrieval.closest({ query: q, queryVec: qv, limit: 20 }).map((p) => p.path)
    const lex = retrieval.closest({ query: q, queryVec: null, limit: 20 }).map((p) => p.path)
    retrievalMiss = !dense.includes(rec.gold_page) && !lex.includes(rec.gold_page)
  }

  // The zExp ladder, over the unscoped positives — RAG-SPEC 3.4.1. Measured in
  // `zscore` mode regardless of what the index ships, because the ladder IS the
  // z statistic; on a cosine-mode index it is inert until an embed-model swap.
  const ladder = []
  if (rec.stratum === 'U' && !rec.prev_question) {
    const zGuard = { ...guard, denseMode: 'zscore' }
    const start = Math.floor(rng(hashSeed(rec.id))() * ladderPages.length)
    for (const target of LADDER_N) {
      const s = target === null ? ALL_SCOPE : contiguousScope(ladderPages, target, start)
      const r = createRetrieval({ index, scope: s, guard: zGuard })
      const g = r.evaluate({ question: rec.question, queryVec: vec })
      ladder.push({ n: g.n, z: g.z })
    }
  }

  return {
    id: rec.id,
    stratum: rec.stratum,
    scoped: scope.kind !== 'all',
    followUp: Boolean(rec.prev_question),
    russian: /[Ѐ-ӿ]/.test(rec.question),
    G: hybrid.G,
    G_raw: rawOnly.G,
    G_composed: composedOnly ? composedOnly.G : null,
    D: hybrid.D,
    L: hybrid.L,
    z: hybrid.z,
    // The window sweep re-derives D from the raw cosine, and in cosine mode `z`
    // IS that cosine (`denseFromCosine` returns it unchanged). It needs the
    // components of EVERY channel, not only the one that won here: which channel
    // wins is `c.G > best.G`, and G moves with the window being swept. Caching
    // the winner alone would pin the follow-up strata to the window the probe
    // happened to run under — the records that decide tau.
    z_raw: rawOnly.z,
    L_raw: rawOnly.L,
    z_composed: composedOnly ? composedOnly.z : null,
    L_composed: composedOnly ? composedOnly.L : null,
    n: hybrid.n,
    mode: hybrid.mode,
    channel: hybrid.channel,
    admissible: hybrid.admissible,
    unscopedG: hybrid.unscopedG,
    G_lex: lexical.G,
    channel_lex: lexical.channel,
    unscopedG_lex: lexical.unscopedG,
    retrievalMiss,
    ladder,
  }
}

const hashSeed = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ── step 3 and 4: the sweep ──────────────────────────────────────────────────

const TAU_STEPS = Array.from({ length: 101 }, (_, i) => Number((i / 100).toFixed(2)))

/**
 * The cosine window — swept here, not hard-coded upstream.
 *
 * WHY THIS EXISTS. `cosFloor` / `cosCeil` map a raw cosine onto D, and where a
 * raw cosine SITS is a property of the embedder, not of the corpus. The pair
 * [0.44, 0.64] was measured on bge-m3 and reached `guardFor()` in
 * build-rag-index.js as a literal, while this file swept only tau inside it. So
 * an embed-model swap kept a window nobody re-measured, and on
 * text-embedding-3-small — whose positives sit 0.44–0.72 against bge-m3's much
 * higher band — the floor landed inside the positive distribution. Measured
 * consequence: Russian positives scored cosine ≈ 0.49, D ≈ 0.27, G ≈ 0.20
 * against tau 0.30 and were refused with their gold page ranked first, while the
 * English half cleared the same gate on lexical overlap the Russian half cannot
 * have. Twelve probes pinned tau at 0.00 and the run failed `no-feasible-tau`.
 *
 * HOW IT IS CHOSEN, and where this is an interpretation rather than the spec.
 * RAG-SPEC 5.6 step 6 forbids `gatePrecision` from justifying a higher **tau**,
 * and that rule is untouched: inside every candidate window tau is still step
 * 4's largest-feasible, chosen by a selector that never sees the precision. The
 * window is a different axis and the spec does not size it, so the rule written
 * down here is: keep only windows that clear the step-5 hard floor
 * (`blatantRefusalRate >= 0.80`) with a feasible tau above `wLexical`, and among
 * those take the highest `gatePrecision`. Ties go to the larger tau, then to the
 * wider span — a wide window degrades gracefully, a narrow one is a step
 * function pretending to be a score.
 *
 * `unscopedG` is NOT re-derived. It drives the X-stratum cause check and the
 * widen affordance, never the sweep — which scores X on refusal alone — so it
 * keeps the window its probe ran under. Said out loud because a reader comparing
 * `unscopedG` against a swept `G` would otherwise find them inconsistent.
 */
const WINDOW_FLOORS = Array.from({ length: 16 }, (_, i) => Number((0.16 + i * 0.02).toFixed(2)))
const WINDOW_SPANS = Array.from({ length: 17 }, (_, i) => Number((0.08 + i * 0.02).toFixed(2)))

const WINDOWS = WINDOW_FLOORS.flatMap((cosFloor) =>
  WINDOW_SPANS.map((span) => ({ cosFloor, cosCeil: Number((cosFloor + span).toFixed(2)) })),
).filter((w) => w.cosCeil <= 0.95)

/** gate.js `denseFromCosine`, restated over the cache so the sweep stays pure. */
const dOf = (z, { cosFloor, cosCeil }) =>
  Math.min(1, Math.max(0, (z - cosFloor) / Math.max(cosCeil - cosFloor, 1e-6)))

/**
 * Re-score every probe at one candidate window.
 *
 * Mirrors `retriever.evaluate()`'s channel rule exactly — the composed channel
 * replaces the raw one only when it is `admissible` AND scores higher — because
 * a sweep that picked the max unconditionally would measure a retriever nobody
 * ships.
 */
function regate(rows, w, guard) {
  return rows.map((r) => {
    if (r.z_raw == null) return r // pre-window cache line: leave it as measured
    const gOf = (z, L) => guard.wDense * dOf(z, w) + guard.wLexical * L
    const raw = { G: gOf(r.z_raw, r.L_raw), D: dOf(r.z_raw, w), channel: 'raw' }
    let best = raw
    if (r.z_composed != null && r.admissible) {
      const composed = {
        G: gOf(r.z_composed, r.L_composed),
        D: dOf(r.z_composed, w),
        channel: 'composed',
      }
      if (composed.G > best.G) best = composed
    }
    return { ...r, ...best, G_raw: raw.G }
  })
}

/**
 * The window search. Returns the winning window with the sweep it earned, or
 * null when no window in the grid produces a shippable gate at all — which is a
 * real answer, not a failure to search: it means the embedder does not separate
 * this corpus and no threshold can rescue that.
 */
function chooseWindow(scored, guard) {
  const positives = scored.filter((r) => STRATA[r.stratum].positive && r.z_raw != null)

  const viable = []
  for (const w of WINDOWS) {
    const rw = regate(scored, w, guard)
    const sweep = TAU_STEPS.map((t) => sweepRow(rw, t, 'G'))
    const best = chooseTau(sweep)
    if (!best || best.tau < 0.05 || best.tau <= guard.wLexical) continue
    if (best.blatantRefusalRate === null || best.blatantRefusalRate < 0.8) continue

    // How much of the ramp is actually being used. A window narrower than the
    // spread it is mapping saturates D to 0 or 1 for everything and turns the
    // gate into a step on the raw cosine — which scores well here and ships a
    // knife edge: one embedder revision and every probe crosses at once.
    const inside = positives.filter((r) => {
      const d = dOf(r.z_raw, w)
      return d > 0 && d < 1
    }).length
    viable.push({
      window: w,
      sweep,
      best,
      rows: rw,
      span: Number((w.cosCeil - w.cosFloor).toFixed(2)),
      rampShare: positives.length ? inside / positives.length : 0,
    })
  }
  if (!viable.length) return null

  const rank = (a, b) =>
    b.best.gatePrecision - a.best.gatePrecision || b.best.tau - a.best.tau || b.span - a.span

  // Non-degenerate first: a window that leaves at least a third of the positives
  // strictly inside the ramp is scoring them, not bucketing them. Only if the
  // grid offers none does the search fall back to raw precision, and it says so.
  const graded = viable.filter((v) => v.rampShare >= 0.33).sort(rank)
  const pool = graded.length ? graded : viable.slice().sort(rank)

  return {
    ...pool[0],
    viableCount: viable.length,
    gradedCount: graded.length,
    shortlist: pool.slice(0, 6).map((v) => ({
      window: v.window,
      tau: v.best.tau,
      gatePrecision: v.best.gatePrecision,
      blatant: v.best.blatantRefusalRate,
      rampShare: v.rampShare,
    })),
  }
}

/**
 * One row of the sweep at a candidate threshold.
 *
 * Positives are scored on PASSING, negatives on REFUSING, and `X` is scored on
 * REFUSAL ALONE, cause-agnostic — RAG-SPEC 5.6 step 3. Scoring `X` on the cause
 * during the sweep would be circular: `wouldPassUnscoped` is itself thresholded
 * at tau, so the cause moves with the very number being chosen. The cause is
 * checked once, at the end, and a miss there is a stratum-authoring miss.
 */
function sweepRow(rows, tau, field = 'G') {
  const refused = (r) => r[field] < tau
  const byStratum = {}
  for (const key of Object.keys(STRATA)) {
    const set = rows.filter((r) => r.stratum === key)
    const bad = set.filter((r) => (STRATA[key].positive ? refused(r) : !refused(r)))
    byStratum[key] = {
      n: set.length,
      // For a positive stratum: over-refusals. For a negative one: escapes.
      failures: bad.length,
      rate: set.length ? bad.length / set.length : null,
      ub95: wilsonUpper95(bad.length, set.length),
      ids: bad.map((r) => r.id),
    }
  }
  const negatives = rows.filter((r) => !STRATA[r.stratum].positive)
  const caught = negatives.filter(refused).length
  const n4 = byStratum.N4
  return {
    tau,
    byStratum,
    gatePrecision: negatives.length ? caught / negatives.length : null,
    blatantRefusalRate: n4.n ? 1 - n4.failures / n4.n : null,
    feasible: POSITIVE_STRATA.every((k) => byStratum[k].n === 0 || byStratum[k].ub95 <= STRATA[k].bound),
  }
}

/**
 * RAG-SPEC 5.6 step 4: the LARGEST tau satisfying all three positive bounds
 * simultaneously.
 *
 * Over-refusal is monotone in tau, so the feasible set is a prefix and "largest
 * feasible" is well defined. It is chosen without ever consulting gatePrecision
 * — step 6 forbids negative-catch from justifying a higher tau, and the only way
 * to make that structural rather than aspirational is for the selector not to
 * receive the number.
 */
function chooseTau(sweep) {
  let chosen = null
  for (const row of sweep) {
    if (row.feasible) chosen = row
    else break
  }
  return chosen
}

/**
 * RAG-SPEC 5.6 step 7 — "repeat with dense disabled for tauLexical".
 *
 * Step 4's rule cannot be repeated literally here, and the spec says why in
 * RAG-SPEC 3.2: with dense disabled "the single-channel invariant is
 * unsatisfiable by construction — the mode is a degradation, and its refusal
 * rates are reported as their own row, never pooled." The RAG-SPEC 5.4 table
 * agrees: `lexicalOnlyRefusalRate` is the one refusal metric with no threshold.
 * Applied literally, step 4 returns tauLexical = 0.00 on this corpus — a gate
 * that refuses nothing — because a Russian query has L = 0 against an English
 * index and no positive bound can survive it.
 *
 * So the constraint that carries over is the one step 5 states as a hard floor
 * rather than as a bound: a gate that cannot refuse a blatantly off-domain
 * question is indistinguishable from `guard.mode: 'off'`. The objective flips
 * with it — minimise over-refusal subject to the gate still being a gate:
 *
 *   tauLexical = the SMALLEST threshold whose blatantRefusalRate >= 0.80.
 *
 * This is an interpretation of an ambiguous step, and it is written down here
 * rather than buried: the over-refusal UB95 values it produces are reported
 * beside it, unbounded and unpooled, so the cost is visible either way.
 */
function chooseTauLexical(sweep) {
  return sweep.find((r) => r.tau >= 0.05 && r.blatantRefusalRate !== null && r.blatantRefusalRate >= 0.8) || null
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const index = loadIndex()
  const guard = index.manifest.guard
  const hash = index.manifest.hash
  const lev = levers()
  const probes = loadProbes()

  console.log(`\nDocPilot gate calibration — RAG-SPEC 5.6`)
  console.log(
    `  index ${hash}  chunks ${index.manifest.chunkCount}  embed ${index.manifest.embedModel}`,
  )
  console.log(
    `  guard in: mode=${guard.denseMode} tau=${guard.tau} tauLexical=${guard.tauLexical} ` +
      `wDense=${guard.wDense} wLexical=${guard.wLexical} source=${guard.source}`,
  )
  console.log(`  probes ${probes.length} from ${path.relative(ROOT, PROBES)}\n`)

  // ── cache ──────────────────────────────────────────────────────────────────
  const cache = new Map()
  if (!REFRESH && fs.existsSync(RAW)) {
    for (const line of fs.readFileSync(RAW, 'utf8').split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line)
        if (row.sig) cache.set(row.sig, row)
      } catch {
        /* a truncated cache line is a cache miss, not an error */
      }
    }
  }

  const rows = []
  let embedded = 0
  const ladderPages = index.manifest.pages
  for (const rec of probes) {
    const sig = sigOf(rec, hash, lev)
    const hit = cache.get(sig)
    if (hit) {
      rows.push(hit)
      continue
    }
    if (SWEEP_ONLY) {
      die(
        `--sweep-only, but ${rec.id} is not in ${path.relative(ROOT, RAW)}. ` +
          `Run without --sweep-only once to populate it.`,
      )
    }
    let row
    try {
      row = await probeOne({ rec, index, guard, ladderPages })
    } catch (e) {
      if (/fetch failed|ECONNREFUSED|embed \d+/i.test(String(e.message || e))) {
        die(
          `embed endpoint unreachable at ${EMBED_BASE} — ${e.message || e}` +
            (EMBED_PROVIDER === 'ollama'
              ? `\n        start it with:  ollama serve` +
                `\n        pull the model: ollama pull ${index.manifest.embedModel}`
              : `\n        check DOCPILOT_EMBED_URL and the key in .env.local`),
        )
      }
      throw e
    }
    row.sig = sig
    rows.push(row)
    embedded++
    if (embedded % 20 === 0) process.stdout.write(`\r  probed ${embedded} new…`)
  }
  if (embedded) process.stdout.write(`\r  probed ${embedded} new, ${rows.length - embedded} cached\n`)
  else console.log(`  all ${rows.length} probes served from the cache`)

  // Rewrite the cache with every row currently known, so a partial run still
  // leaves the file usable and a probe removed from the set stops costing.
  fs.writeFileSync(RAW, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  // ── step 3 + 4 ─────────────────────────────────────────────────────────────
  const positives = rows.filter((r) => STRATA[r.stratum].positive)
  const withGold = positives.filter((r) => r.retrievalMiss !== null)
  const misses = withGold.filter((r) => r.retrievalMiss)
  const retrievalMissRate = withGold.length ? misses.length / withGold.length : 0

  // RAG-SPEC 5.4: retrieval misses are "excluded from the three bounds above".
  // A positive whose gold page is in neither channel's top-20 is measuring the
  // probe set, not the gate — charging its refusal to over-refusal would let a
  // badly authored question drag tau down and call the result a gate property.
  // They are still counted in `retrievalMisses`, which has its own FAIL.
  const missIds = new Set(misses.map((r) => r.id))
  const scored = rows.filter((r) => !missIds.has(r.id))

  // The window is swept beside tau, in cosine mode only — in zscore mode D comes
  // off the z ladder and there is no window to move. `rows` is re-scored IN
  // PLACE at the winner so every downstream reader (the report, the bounding
  // list, `scored`, which shares these objects) sees one consistent G. The RAW
  // cache is already on disk by this point and keeps the values as MEASURED,
  // which is what makes `--sweep-only` able to try a different window for free.
  const searched = guard.denseMode === 'cosine' ? chooseWindow(scored, guard) : null
  const win = searched ? searched.window : { cosFloor: guard.cosFloor, cosCeil: guard.cosCeil }
  if (searched) {
    regate(rows, win, guard).forEach((r, i) => Object.assign(rows[i], r))
    console.log(
      `  window: [${win.cosFloor}, ${win.cosCeil}] from ${WINDOWS.length} candidates — ` +
        `${searched.viableCount} viable, ${searched.gradedCount} non-degenerate  ` +
        `(was [${guard.cosFloor}, ${guard.cosCeil}], ${guard.source})`,
    )
    console.log('           window        tau   gatePrec  blatant  ramp')
    for (const s of searched.shortlist) {
      console.log(
        `           [${s.window.cosFloor}, ${s.window.cosCeil}]  ${s.tau.toFixed(2)}   ` +
          `${(100 * s.gatePrecision).toFixed(1)}%     ${(100 * s.blatant).toFixed(0)}%     ` +
          `${(100 * s.rampShare).toFixed(0)}%`,
      )
    }
  } else if (guard.denseMode === 'cosine') {
    console.log(
      `  window: no candidate of ${WINDOWS.length} yields a feasible tau above wLexical ` +
        `with blatantRefusalRate >= 80% — keeping [${win.cosFloor}, ${win.cosCeil}]`,
    )
  }
  const guardOut = { ...guard, cosFloor: win.cosFloor, cosCeil: win.cosCeil }

  const sweep = searched ? searched.sweep : TAU_STEPS.map((t) => sweepRow(scored, t, 'G'))
  const best = searched ? searched.best : chooseTau(sweep)
  const tau = best ? best.tau : null

  const sweepLex = TAU_STEPS.map((t) => sweepRow(scored, t, 'G_lex'))
  const bestLex = chooseTauLexical(sweepLex)
  const tauLexical = bestLex ? bestLex.tau : null

  const fails = []
  if (tau === null || tau < 0.05) {
    fails.push({
      name: 'no-feasible-tau',
      detail:
        `no tau >= 0.05 satisfies all three positive UB95 bounds simultaneously ` +
        `(largest feasible ${tau === null ? 'none' : tau.toFixed(2)}). ` +
        `RAG-SPEC 5.6: a broken score function, or a wrong zExp(n).`,
    })
  }
  if (tau !== null && tau <= guard.wLexical) {
    fails.push({
      name: 'tau-below-wlexical',
      detail:
        `chosen tau ${tau.toFixed(2)} <= wLexical ${guard.wLexical}: the RAG-SPEC 3.4.4 ` +
        `single-channel invariant would be violated — the lexical channel would clear ` +
        `the gate with zero dense evidence.`,
    })
  }
  if (best && best.blatantRefusalRate !== null && best.blatantRefusalRate < 0.8) {
    fails.push({
      name: 'blatant-refusal-below-floor',
      detail:
        `blatantRefusalRate ${pct(best.blatantRefusalRate)} < 80% at tau ${tau.toFixed(2)}: ` +
        `a gate that cannot refuse an off-domain general question is indistinguishable ` +
        `from guard.mode "off" and must never ship stamped as calibrated.`,
    })
  }
  if (retrievalMissRate > 0.05) {
    fails.push({
      name: 'retrieval-misses-above-floor',
      detail:
        `retrievalMisses ${pct(retrievalMissRate)} of ${withGold.length} positives carrying a ` +
        `gold page (> 5%): the probe set is being measured, not the gate. ` +
        `Missed: ${misses.map((r) => r.id).join(', ')}`,
    })
  }
  // The step-7 counterpart. RAG-SPEC 5.4 gives `lexicalOnlyRefusalRate` no
  // over-refusal threshold — the mode is a declared degradation whose rates are
  // "reported separately, never pooled" — so the condition that carries over is
  // the one from step 5's third bullet, applied to the degraded threshold: a
  // tauLexical that cannot refuse a blatantly off-domain question is a gate that
  // is off, and `lexical-only` is precisely the mode nobody can see is on.
  if (bestLex === null) {
    fails.push({
      name: 'lexical-blatant-refusal-below-floor',
      detail:
        `no tauLexical >= 0.05 reaches blatantRefusalRate 80% with dense disabled: the ` +
        `degraded mode would pass off-domain general questions, and RAG-SPEC 3.2 forbids ` +
        `surfacing that it is even in that mode.`,
    })
  }

  // ── step 8: the ladder ─────────────────────────────────────────────────────
  const ladderRows = rows.filter((r) => r.ladder && r.ladder.length === LADDER_N.length)
  const zexp = LADDER_N.map((_, rung) => {
    const ns = ladderRows.map((r) => r.ladder[rung].n).sort((a, b) => a - b)
    const zs = ladderRows.map((r) => r.ladder[rung].z).sort((a, b) => a - b)
    const med = (a) => (a.length ? (a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2) : null)
    // n is rounded: `zExp` interpolates on ln(n) and a half-chunk scope is not
    // a thing that exists. The median is over ACTUAL scoped chunk counts, not
    // over the requested rung, because a page-contiguous scope overshoots.
    return { n: med(ns) == null ? null : Math.round(med(ns)), z: Number(med(zs)?.toFixed(4)) }
  }).filter((e) => e.n != null)

  // What tau would be if the probes that pin it were not in the set. Not a
  // proposal — a robustness number. When one probe out of 315 moves tau by 0.16
  // the result is a property of that probe, and saying so is the difference
  // between a calibration and a coincidence.
  const bounding = boundingProbes(sweep, tau)
  const withoutBounding = bounding.newlyRefused.length
    ? chooseTau(
        TAU_STEPS.map((t) =>
          sweepRow(scored.filter((r) => !bounding.newlyRefused.some((b) => b.id === r.id)), t, 'G'),
        ),
      )
    : null

  const ctx = {
    rows,
    scored,
    sweep,
    sweepLex,
    best,
    bestLex,
    tau,
    tauLexical,
    fails,
    // Carries the SWEPT window, so `calibration.json` ships the pair that was
    // measured rather than the pair the index happened to be built with.
    guard: guardOut,
    index,
    zexp,
    retrievalMissRate,
    withGold: withGold.length,
    misses,
    bounding,
    withoutBounding,
    probeFile: path.relative(ROOT, PROBES),
  }

  report(ctx)

  // The markdown report is written whether or not calibration passed: RAG-SPEC
  // 5.6 step 5 protects `calibration.json` — the file something downstream
  // CONSUMES — and a failed calibration you cannot read is a failure twice.
  const doc = buildDoc(ctx)
  fs.writeFileSync(OUT_MD, markdown(doc, ctx))

  if (fails.length) {
    console.log(`\n  CALIBRATION FAILED — ${path.relative(ROOT, OUT_JSON)} left untouched`)
    console.log(`  diagnosis written to ${path.relative(ROOT, OUT_MD)}\n`)
    for (const f of fails) console.log(`    ${f.name}\n      ${f.detail}\n`)
    process.exit(1)
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n')
  console.log(`\n  wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`)
  console.log(`  run \`npx docpilot index\` to inline the new guard into the manifest\n`)
}

// ── output ───────────────────────────────────────────────────────────────────

/** Every probe that would flip if tau took one more step. RAG-SPEC 5.6 step 8. */
function boundingProbes(sweep, tau) {
  if (tau === null) return { blocked: [], newlyRefused: [] }
  const next = sweep.find((r) => Math.abs(r.tau - (tau + 0.01)) < 1e-9)
  if (!next) return { blocked: [], newlyRefused: [] }
  const blocked = POSITIVE_STRATA.filter(
    (k) => next.byStratum[k].n > 0 && next.byStratum[k].ub95 > STRATA[k].bound,
  )
  const here = new Set(POSITIVE_STRATA.flatMap((k) => sweep.find((r) => r.tau === tau).byStratum[k].ids))
  const newlyRefused = blocked.flatMap((k) =>
    next.byStratum[k].ids.filter((id) => !here.has(id)).map((id) => ({ id, stratum: k })),
  )
  return { blocked, newlyRefused }
}

function backlog(rows, tau, field = 'G') {
  return rows
    .filter((r) => STRATA[r.stratum].positive && r[field] >= tau)
    .sort((a, b) => a[field] - b[field])
    .slice(0, 10)
    .map((r) => ({ id: r.id, stratum: r.stratum, G: Number(r[field].toFixed(4)), margin: Number((r[field] - tau).toFixed(4)) }))
}

function report(ctx) {
  const { rows, best, bestLex, tau, tauLexical, sweep, retrievalMissRate, withGold, misses, bounding } = ctx
  const line = (k, v) => console.log(`  ${String(k).padEnd(30)} ${v}`)

  console.log('\n── sweep (every 5th step) ──────────────────────────────────────')
  console.log('   tau    U ovr  UB95    S ovr  UB95    F ovr  UB95   negCaught  N4')
  for (const r of sweep) {
    if (Math.round(r.tau * 100) % 5) continue
    const c = (k) => `${String(r.byStratum[k].failures).padStart(3)}/${String(r.byStratum[k].n).padEnd(3)} ${num(r.byStratum[k].ub95)}`
    console.log(
      `  ${r.tau.toFixed(2)}  ${c('U')}  ${c('S')}  ${c('F')}   ` +
        `${pct(r.gatePrecision)}   ${pct(r.blatantRefusalRate)}${r.feasible ? '  ok' : ''}`,
    )
  }

  console.log('\n── chosen ──────────────────────────────────────────────────────')
  line('tau (largest feasible)', tau === null ? 'NONE' : tau.toFixed(2))
  line('tauLexical', tauLexical === null ? 'NONE' : tauLexical.toFixed(2))
  if (best) {
    for (const k of POSITIVE_STRATA) {
      const s = best.byStratum[k]
      line(`${STRATA[k].metric}`, `${s.failures}/${s.n}  UB95 ${num(s.ub95)}  (bound ${STRATA[k].bound})`)
    }
    line('gatePrecision (target .60)', pct(best.gatePrecision))
    line('blatantRefusalRate (>= .80)', pct(best.blatantRefusalRate))
    console.log('\n  per stratum at the chosen tau')
    for (const k of Object.keys(STRATA)) {
      const s = best.byStratum[k]
      if (!s.n) continue
      const wrongWay = STRATA[k].positive ? 'refused' : 'escaped'
      line(`  ${k} — ${STRATA[k].label}`, `${wrongWay} ${s.failures}/${s.n}  ${pct(1 - s.rate)} correct`)
    }
  }
  if (bestLex) {
    console.log('\n  lexical-only (reported separately, never pooled — RAG-SPEC 3.2)')
    for (const k of POSITIVE_STRATA) {
      const s = bestLex.byStratum[k]
      line(`  ${k} over-refusal`, `${s.failures}/${s.n}  UB95 ${num(s.ub95)}`)
    }
    line('  gatePrecision', pct(bestLex.gatePrecision))
    line('  blatantRefusalRate', pct(bestLex.blatantRefusalRate))
  }
  line('retrievalMisses', `${misses.length}/${withGold}  ${pct(retrievalMissRate)}  (bound 5%)`)

  if (bounding.newlyRefused.length) {
    console.log(`\n  bounding probes (refused at tau ${(tau + 0.01).toFixed(2)}):`)
    for (const b of bounding.newlyRefused.slice(0, 12)) {
      const r = rows.find((x) => x.id === b.id)
      console.log(`    ${b.id.padEnd(8)} ${b.stratum.padEnd(3)} G=${num(r.G)}`)
    }
  }
}

/** The RAG-SPEC 5.6 step-1 sizes, so the report can price its own reduction. */
const SPEC_SIZE = { U: 180, S: 60, F: 60, N1: 30, N2: 30, N3: 30, N4: 30, N5: 30, N6: 30, X: 30, P: 30 }

/** Smallest n at which the bound still holds with `f` failures. */
function nForFailures(bound, f) {
  for (let n = f + 1; n <= 4000; n++) if (wilsonUpper95(f, n) <= bound) return n
  return null
}

function buildDoc(ctx) {
  const { rows, scored, sweep, sweepLex, best, bestLex, tau, tauLexical, guard, index, zexp, retrievalMissRate, withGold, misses, probeFile, fails, bounding, withoutBounding } = ctx
  const byStratumN = {}
  for (const k of Object.keys(STRATA)) {
    const n = rows.filter((r) => r.stratum === k).length
    if (n) byStratumN[k] = n
  }
  const spec = SPEC_SIZE

  const doc = {
    ok: fails.length === 0,
    fails,
    version: 1,
    calibratedAt: index.manifest.hash,
    embedModel: index.manifest.embedModel,
    chunkCount: index.manifest.chunkCount,
    probeFile,
    probeCount: rows.length,
    byStratum: byStratumN,
    specStratumSize: spec,
    guard: {
      tau,
      tauLexical,
      wDense: guard.wDense,
      wLexical: guard.wLexical,
      denseMode: guard.denseMode,
      cosFloor: guard.cosFloor,
      cosCeil: guard.cosCeil,
      // NOT "calibrated": the probe set is below the RAG-SPEC 5.6 size, so the
      // UB95 intervals are wider than the spec sized them for. The suffix, and
      // the per-stratum n above, are what stop this being read as the full run.
      source: 'calibrated-reduced',
      calibratedAt: index.manifest.hash,
      zexp,
      zexpSource: zexp.length >= 2 ? 'measured' : 'closed-form',
      overRefusalUB95: best ? best.byStratum.U.ub95 : null,
      gatePrecision: best ? best.gatePrecision : null,
    },
    // Each bound with the arithmetic that decides whether it can bind at all.
    // `tolerates` is the number of failures the stratum's own n can absorb —
    // when it is 0, tau is decided by a single probe and UB95 has stopped doing
    // the job RAG-SPEC 5.4 introduced it for.
    bounds: Object.fromEntries(
      Object.entries(STRATA)
        .filter(([, v]) => v.positive)
        .map(([k, v]) => {
          const n = byStratumN[k] || 0
          let tolerates = 0
          while (n && wilsonUpper95(tolerates + 1, n) <= v.bound) tolerates++
          return [
            v.metric,
            {
              stratum: k,
              bound: v.bound,
              n,
              specN: spec[k],
              ub95AtZero: n ? wilsonUpper95(0, n) : null,
              tolerates,
              nForOneFailure: nForFailures(v.bound, 1),
            },
          ]
        }),
    ),
    chosen: best && {
      tau,
      byStratum: best.byStratum,
      gatePrecision: best.gatePrecision,
      blatantRefusalRate: best.blatantRefusalRate,
    },
    chosenLexical: bestLex && {
      tauLexical,
      byStratum: bestLex.byStratum,
      gatePrecision: bestLex.gatePrecision,
      blatantRefusalRate: bestLex.blatantRefusalRate,
    },
    retrievalMisses: { rate: retrievalMissRate, n: withGold, ids: misses.map((r) => r.id) },
    boundingProbes: bounding,
    tauWithoutBoundingProbes: withoutBounding ? withoutBounding.tau : null,
    backlog: backlog(scored, tau, 'G'),
    sweep: sweep.map((r) => ({
      tau: r.tau,
      feasible: r.feasible,
      gatePrecision: r.gatePrecision,
      blatantRefusalRate: r.blatantRefusalRate,
      byStratum: Object.fromEntries(
        Object.entries(r.byStratum).map(([k, v]) => [k, { failures: v.failures, n: v.n, ub95: v.ub95 }]),
      ),
    })),
  }
  return doc
}
function markdown(doc, ctx) {
  const { rows, scored, sweep, sweepLex, best, bestLex, misses } = ctx
  const L = []
  const p = (v) => (v == null ? '—' : `${(100 * v).toFixed(1)}%`)
  const n3 = (v) => (v == null ? '—' : v.toFixed(3))
  const t2 = (v) => (v == null ? '**NONE**' : v.toFixed(2))
  const questionOf = (id) => (QUESTIONS.get(id) || '').replace(/\|/g, '\\|').slice(0, 88)

  L.push(`# Gate calibration — \`${doc.calibratedAt}\``)
  L.push('')
  L.push(`Produced by \`npx docpilot calibrate\` (RAG-SPEC 5.6). Embed endpoint only — no chat`)
  L.push(`model, no LLM judge, no unseeded randomness. Same corpus + same probes ⇒ same output.`)
  L.push('')

  if (!doc.ok) {
    L.push(`> ## CALIBRATION FAILED`)
    L.push(`>`)
    L.push(`> \`${path.relative(ROOT, OUT_JSON)}\` was **not** written; \`build-rag-index.js\` will keep`)
    L.push(`> inlining the provisional guard and warning about it. RAG-SPEC 5.6 step 5.`)
    L.push(`>`)
    for (const f of doc.fails) {
      L.push(`> **\`${f.name}\`** — ${f.detail}`)
      L.push(`>`)
    }
    L.push('')
  }

  L.push(`| | |`)
  L.push(`|---|---|`)
  L.push(`| index | \`${doc.calibratedAt}\`, ${doc.chunkCount} chunks, ${doc.embedModel} |`)
  L.push(`| probes | ${doc.probeCount} from \`${doc.probeFile}\` |`)
  L.push(`| **tau** | **${t2(doc.guard.tau)}** |`)
  L.push(`| **tauLexical** | **${t2(doc.guard.tauLexical)}** |`)
  L.push(`| wDense / wLexical | ${doc.guard.wDense} / ${doc.guard.wLexical} |`)
  L.push(`| denseMode | ${doc.guard.denseMode}, window [${doc.guard.cosFloor}, ${doc.guard.cosCeil}] |`)
  L.push(`| source | \`${doc.guard.source}\` |`)
  L.push(`| gatePrecision | ${p(doc.guard.gatePrecision)} (target 60%, never a constraint) |`)
  L.push('')

  L.push(`## Probe set, and what the reduction costs`)
  L.push('')
  L.push(`RAG-SPEC 5.6 sizes the strata at ~540 probes so \`UB95 <= 0.05\` is reachable.`)
  L.push(`With zero failures \`UB95(0,n) = z²/(n+z²)\`, \`z = 1.6449\`, so the 5% bound is`)
  L.push(`**unreachable below n = 52** whatever the gate does, and the 8% bound below n = 32.`)
  L.push(`This run keeps the three bounded positive strata above those floors and cuts the`)
  L.push(`negatives, which are a target (\`gatePrecision >= 0.60\`) and never a constraint.`)
  L.push('')
  L.push(`| stratum | spec n | this run | UB95 at 0 failures | UB95 at spec n | cost of the cut |`)
  L.push(`|---|---|---|---|---|---|`)
  const ub0 = (n) => (n ? 2.7057 / (n + 2.7057) : null)
  for (const [k, v] of Object.entries(doc.byStratum)) {
    const s = doc.specStratumSize[k]
    L.push(
      `| ${k} | ${s} | ${v} | ${n3(ub0(v))} | ${n3(ub0(s))} | ` +
        `${s === v ? '—' : `${v > s ? '−' : '+'}${n3(Math.abs(ub0(v) - ub0(s)))}`} |`,
    )
  }
  L.push('')
  L.push(`The interval width is not the whole cost. What actually decides whether a bound can`)
  L.push(`bind is how many failures it tolerates at the n it has:`)
  L.push('')
  L.push(`| bound | stratum | n | ceiling | failures tolerated | n needed for 1 |`)
  L.push(`|---|---|---|---|---|---|`)
  for (const [metric, b] of Object.entries(doc.bounds)) {
    L.push(
      `| \`${metric}\` | ${b.stratum} | ${b.n} (spec ${b.specN}) | ${b.bound} | ` +
        `**${b.tolerates}** | ${b.nForOneFailure} |`,
    )
  }
  L.push('')
  const zeroTol = Object.entries(doc.bounds).filter(([, b]) => b.tolerates === 0)
  if (zeroTol.length) {
    L.push(
      `${zeroTol.map(([m]) => `\`${m}\``).join(' and ')} tolerate **zero** failures at this n: a ` +
        `single refused probe decides \`tau\`. That is the outcome RAG-SPEC 5.4 introduced UB95 ` +
        `to prevent, and for \`${zeroTol[0][0]}\` it persists at the spec's own ` +
        `n = ${zeroTol[0][1].specN} — the bound needs n = ${zeroTol[0][1].nForOneFailure} ` +
        `before one failure is survivable. Read \`tau\` accordingly.`,
    )
    L.push('')
  }

  L.push(`## Sweep (RAG-SPEC 5.6 step 3)`)
  L.push('')
  L.push(`\`X\` probes are scored on refusal alone, cause-agnostic, during the sweep —`)
  L.push(`\`wouldPassUnscoped\` is itself a function of tau. The cause is checked once, below.`)
  L.push(`Positives that are \`retrievalMisses\` are excluded from the three bounds (RAG-SPEC 5.4).`)
  L.push('')
  L.push(`| tau | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 | feasible |`)
  L.push(`|---|---|---|---|---|---|---|---|---|---|`)
  for (const r of sweep) {
    if (Math.round(r.tau * 100) % 5 && (doc.guard.tau == null || Math.abs(r.tau - doc.guard.tau) > 1e-9)) continue
    const c = (k) => `${r.byStratum[k].failures}/${r.byStratum[k].n}`
    L.push(
      `| ${r.tau.toFixed(2)} | ${c('U')} | ${n3(r.byStratum.U.ub95)} | ${c('S')} | ` +
        `${n3(r.byStratum.S.ub95)} | ${c('F')} | ${n3(r.byStratum.F.ub95)} | ` +
        `${p(r.gatePrecision)} | ${p(r.blatantRefusalRate)} | ${r.feasible ? 'yes' : ''} |`,
    )
  }
  L.push('')

  L.push(`## Every stratum at the chosen tau`)
  L.push('')
  L.push(`| stratum | what it is | n | correct | wrong |`)
  L.push(`|---|---|---|---|---|`)
  for (const [k, v] of Object.entries(STRATA)) {
    const s = best?.byStratum[k]
    if (!s?.n) continue
    L.push(
      `| ${k} | ${v.label} | ${s.n} | ${p(1 - s.rate)} | ${s.failures}` +
        `${s.ids.length ? ` — ${s.ids.slice(0, 10).map((i) => `\`${i}\``).join(', ')}${s.ids.length > 10 ? ', …' : ''}` : ''} |`,
    )
  }
  L.push('')
  L.push(`\`gatePrecision\` **${p(best?.gatePrecision)}** against a target of 60%. RAG-SPEC 5.6`)
  L.push(`step 6: it may never justify raising tau past step 4, and \`chooseTau()\` is not given`)
  L.push(`the number — the constraint is structural, not a promise.`)
  L.push('')

  L.push(`### Where the strata sit on the G axis`)
  L.push('')
  L.push(`The separability question, before any threshold is chosen.`)
  L.push('')
  L.push(`| stratum | min G | median G | max G |`)
  L.push(`|---|---|---|---|`)
  for (const k of Object.keys(STRATA)) {
    const g = rows.filter((r) => r.stratum === k).map((r) => r.G).sort((a, b) => a - b)
    if (!g.length) continue
    L.push(`| ${k} | ${n3(g[0])} | ${n3(g[g.length >> 1])} | ${n3(g[g.length - 1])} |`)
  }
  L.push('')

  L.push(`## The probes that bound the chosen tau`)
  L.push('')
  if (doc.boundingProbes.blocked.length) {
    L.push(
      `At tau ${(doc.guard.tau + 0.01).toFixed(2)} the bound` +
        `${doc.boundingProbes.blocked.length > 1 ? 's' : ''} ` +
        `${doc.boundingProbes.blocked.map((k) => `\`${STRATA[k].metric}\``).join(', ')} ` +
        `${doc.boundingProbes.blocked.length > 1 ? 'break' : 'breaks'}.`,
    )
    L.push('')
    L.push(`| probe | stratum | G | D | L | question |`)
    L.push(`|---|---|---|---|---|---|`)
    for (const b of doc.boundingProbes.newlyRefused) {
      const r = rows.find((x) => x.id === b.id)
      L.push(`| \`${b.id}\` | ${b.stratum} | ${n3(r.G)} | ${n3(r.D)} | ${n3(r.L)} | ${questionOf(b.id)} |`)
    }
    L.push('')
    if (doc.tauWithoutBoundingProbes != null) {
      L.push(
        `Without ${doc.boundingProbes.newlyRefused.length === 1 ? 'that probe' : 'those probes'}, ` +
          `\`tau\` would be **${doc.tauWithoutBoundingProbes.toFixed(2)}** instead of ` +
          `**${t2(doc.guard.tau)}**. That is a robustness number, not a proposal: deleting the ` +
          `probe that pins \`tau\` in order to make calibration pass is the one edit this ` +
          `procedure exists to prevent.`,
      )
      L.push('')
    }
  } else {
    L.push(`No positive probe flips at tau + 0.01, so \`tau\` is not bounded by a named probe.`)
    L.push('')
  }

  L.push(`## Over-refusal backlog — the ten positives closest to tau`)
  L.push('')
  L.push(`These pass today with the least margin: the first questions a reader loses if \`tau\``)
  L.push(`moves, and the shortlist for a documentation fix.`)
  L.push('')
  L.push(`| probe | stratum | G | margin | question |`)
  L.push(`|---|---|---|---|---|`)
  for (const b of doc.backlog) {
    L.push(`| \`${b.id}\` | ${b.stratum} | ${n3(b.G)} | ${n3(b.margin)} | ${questionOf(b.id)} |`)
  }
  L.push('')

  L.push(`## Refusal causes at the chosen tau (RAG-SPEC 5.6 step 3)`)
  L.push('')
  L.push(`\`X\` was scored cause-agnostically during the sweep. Here the cause is checked once:`)
  L.push(`a refused \`X\` probe whose \`wouldPassUnscoped\` is false at this tau is a`)
  L.push(`**stratum-authoring miss**, not a gate failure.`)
  L.push('')
  L.push(`| probe | refused | wouldPassUnscoped | cause | verdict |`)
  L.push(`|---|---|---|---|---|`)
  for (const r of rows.filter((x) => x.stratum === 'X')) {
    const refused = doc.guard.tau != null && r.G < doc.guard.tau
    const wpu = r.unscopedG != null && doc.guard.tau != null && r.unscopedG >= doc.guard.tau
    const cause = !refused ? '—' : wpu ? '`refuse:out-of-scope`' : '`refuse:no-evidence`'
    const verdict = !refused ? 'ESCAPED' : wpu ? 'correct' : 'authoring miss'
    L.push(`| \`${r.id}\` | ${refused ? 'yes' : 'no'} | ${wpu ? 'yes' : 'no'} | ${cause} | ${verdict} |`)
  }
  L.push('')

  L.push(`## Lexical-only (RAG-SPEC 5.6 step 7)`)
  L.push('')
  L.push(`Dense disabled — the mode RAG-SPEC 3.2 defines for an unreachable embedder, where`)
  L.push(`\`G = L\` against \`tauLexical\`. Its rates are reported here and **never pooled**`)
  L.push(`with the hybrid numbers.`)
  L.push('')
  L.push(`Step 4's selection rule is not repeated literally: RAG-SPEC 3.2 says the`)
  L.push(`single-channel invariant is *unsatisfiable by construction* in this mode, and`)
  L.push(`RAG-SPEC 5.4 gives \`lexicalOnlyRefusalRate\` no threshold. Applied literally, step 4`)
  L.push(`returns \`tauLexical = 0.00\` on this corpus — a gate that refuses nothing — because a`)
  L.push(`Russian query scores \`L = 0\` against an English index. The rule used instead is the`)
  L.push(`step-5 floor with the objective flipped: **the smallest \`tauLexical\` whose`)
  L.push(`\`blatantRefusalRate >= 0.80\`**, i.e. minimise over-refusal subject to the gate still`)
  L.push(`being a gate. This is an interpretation of an ambiguous step; the numbers it costs`)
  L.push(`are in the table.`)
  L.push('')
  L.push(`| metric | value | bound |`)
  L.push(`|---|---|---|`)
  L.push(`| tauLexical | ${t2(doc.guard.tauLexical)} | — |`)
  for (const k of POSITIVE_STRATA) {
    const s = bestLex?.byStratum[k]
    if (s) L.push(`| ${k} over-refusal | ${s.failures}/${s.n}, UB95 ${n3(s.ub95)} | none (RAG-SPEC 3.2) |`)
  }
  L.push(`| gatePrecision | ${p(bestLex?.gatePrecision)} | — |`)
  L.push(`| blatantRefusalRate | ${p(bestLex?.blatantRefusalRate)} | >= 80% |`)
  L.push('')

  L.push(`## zExp ladder (RAG-SPEC 3.4.1)`)
  L.push('')
  L.push(`Median of \`(max c − m)/s\` over the unscoped positives, at real page-contiguous`)
  L.push(`scopes — never random chunk samples, because adjacent paragraphs of one page are`)
  L.push(`exactly the correlation the ladder exists to measure.`)
  L.push('')
  L.push(`| n | z | closed form sqrt(2·ln n) |`)
  L.push(`|---|---|---|`)
  for (const e of doc.guard.zexp) {
    L.push(`| ${e.n} | ${e.z} | ${Math.sqrt(2 * Math.log(Math.max(e.n, 2))).toFixed(4)} |`)
  }
  L.push('')
  L.push(`\`denseMode\` is \`${doc.guard.denseMode}\` on this index, so the ladder is **inert**:`)
  L.push(`\`zExp(n)\` is only consulted in \`zscore\` mode. It is measured and recorded anyway so`)
  L.push(`that a swap to an anisotropic embed model cannot silently inherit the closed form.`)
  L.push('')

  L.push(`## retrievalMisses`)
  L.push('')
  L.push(
    `${doc.retrievalMisses.ids.length}/${doc.retrievalMisses.n} positives carrying a gold page ` +
      `(${p(doc.retrievalMisses.rate)}, bound 5%).` +
      (doc.retrievalMisses.ids.length
        ? ` Missed: ${doc.retrievalMisses.ids.map((i) => `\`${i}\``).join(', ')} — excluded from the three bounds.`
        : ''),
  )
  L.push('')
  L.push(`Measured at PAGE level through \`retrieval.closest()\`: RAG-SPEC 5.6 step 1 gives the`)
  L.push(`probe set no gold chunk ids, so \`gold_page\` is the granularity available. Page level`)
  L.push(`is the more forgiving of the two — a miss reported here is a miss at chunk level too.`)
  L.push('')
  return L.join('\n')
}

/** Questions are needed for the report only; ids alone would make it unreadable. */
const QUESTIONS = new Map()
for (const line of fs.existsSync(PROBES) ? fs.readFileSync(PROBES, 'utf8').split('\n') : []) {
  if (!line.trim()) continue
  try {
    const r = JSON.parse(line)
    QUESTIONS.set(r.id, r.question)
  } catch {
    /* validated properly in loadProbes */
  }
}

export { sweepRow, chooseTau, contiguousScope, TAU_STEPS }
// The window search, exported for the same reason the tau sweep is: it decides
// a shipped threshold and is a pure function of the cache, so it is testable
// without an embedder.
export { dOf, regate, chooseWindow, WINDOWS }

// `pathToFileURL`, not a template literal: a path with a space or a non-ASCII
// segment does not survive plain concatenation, and the failure mode is this
// whole command silently doing nothing and exiting 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message))
}
