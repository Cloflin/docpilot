#!/usr/bin/env node
/**
 * WHY THIS SCRIPT EXISTS.
 *
 * docpilot 2.0 is a from-scratch rewrite, and ADR-015 withdrew bit-equivalence
 * with 1.4.0 as its acceptance test. What replaced it is a MEASUREMENT: 1.4.0's
 * own retrieval metrics on index `a02ccb5b` become the floor 2.0 may not fall
 * below, and the two engines' RANKINGS are diffed per question and printed as a
 * report rather than gated on. A rewrite is allowed to rank differently. It is
 * not allowed to rank differently and have nobody notice.
 *
 * A per-question diff needs a per-question record, and 1.4.0 never wrote one for
 * anything but the 96 golden questions (`rows[].rankedIds` in an eval report).
 * The 639 calibration probes — which is where most of the corpus's query surface
 * actually lives — were never dumped at all. This script dumps all 735, in both
 * channels, as the exact top-8 ids in rank order.
 *
 * NEVER AN AGGREGATE. A mean recall that did not move can hide two questions
 * that swapped their entire result sets, which is precisely the failure a
 * rewrite produces and precisely what a floor cannot see. So the unit here is
 * one question, one channel, one ordered list of eight ids.
 *
 * IT REUSES 1.4.0's RETRIEVAL AND NEVER REIMPLEMENTS IT. `assembleIndex`,
 * `createRetrieval` and `prefetchEmbeddings` are this package's own — the same
 * three `src/eval/run.ts` uses, resolved from the same config through the same
 * `bin/docpilot.js` preamble. A second copy of the ranking would produce a
 * fixture that measures the copy.
 *
 *   node scripts/dump-rankings.mjs --out=<path> [--lexical-only] [--limit=N]
 *
 * Costs one embedding request per 32 unique query texts (~26 requests for the
 * full set) and nothing else; `--lexical-only` costs nothing at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const argOf = (name, dflt = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`)

/**
 * THE LAUNCHER'S PREAMBLE, in order, and the order is load-bearing.
 *
 * `cli-context.js` resolves RAG/GOLDEN/EMBED_CACHE_DIR at MODULE SCOPE out of
 * `globalThis.__DOCPILOT_SETTINGS__`. Importing it before the globals are set
 * silently yields the shipped defaults — see the docblock at bin/docpilot.js:377
 * for what that cost the four commands it used to happen to.
 */
const { applyFileEnv } = await import('../dist/cli-env.js')
await applyFileEnv()
const { resolveDocPilot, nodeEmbedTarget } = await import('../dist/config.js')
const { findConfig } = await import('../dist/cli-init.js')

const configPath = findConfig()
if (!configPath) {
  console.error('[docpilot] no config found — run this from the project root')
  process.exit(2)
}
const mod = await import(pathToFileURL(path.resolve(configPath)).href)
const resolved = resolveDocPilot(mod.docPilot ?? {}, process.env)
globalThis.__DOCPILOT_SETTINGS__ = resolved
globalThis.__DOCPILOT_CONFIG__ = configPath

const { RAG, GOLDEN, CALIBRATION_SET, EMBED_CACHE_DIR } = await import('../dist/cli-context.js')
const { assembleIndex } = await import('../dist/theme/docpilot/store.js')
const { createRetrieval } = await import('../dist/theme/docpilot/retriever.js')
const { composeQuery } = await import('../dist/theme/docpilot/gate.js')
const { prefetchEmbeddings } = await import('../dist/eval/prefetch.js')
const { openEmbedCache } = await import('../dist/build/lib/embed-cache.js')

/**
 * `loadIndex`, transcribed from `src/eval/run.ts:432` — it is a module-private
 * function in a file that runs a whole eval on import, so it cannot be imported.
 * The four reads and the `.buffer` slice are verbatim; the slice in particular is
 * not incidental (Node pools small allocations, and the unsliced `.buffer` is the
 * whole pool, which `assembleIndex`'s length check refuses).
 */
function loadIndex() {
  const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
  const shards = manifest.shards.map((s) => JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')))
  let vectorBuffer = null
  if (manifest.vectors !== null) {
    const vecBuf = fs.readFileSync(path.join(RAG, manifest.vectors))
    vectorBuffer = vecBuf.buffer.slice(vecBuf.byteOffset, vecBuf.byteOffset + vecBuf.byteLength)
  }
  const dfDoc = JSON.parse(fs.readFileSync(path.join(RAG, manifest.df), 'utf8'))
  return assembleIndex({ manifest, shards, vectorBuffer, dfDoc })
}

const readJsonl = (p) =>
  fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

/**
 * THE ANTECEDENT, chosen without consulting a gate.
 *
 * `src/eval/conversation.ts` picks it with `chainAntecedent`, which reads which
 * CHANNEL each prior turn's gate won on — a choice that depends on thresholds,
 * on the embedder, and therefore on the run. A drift fixture may not depend on
 * any of those: the two engines being compared have to be handed the identical
 * query string, or the diff measures the antecedent rule rather than the
 * ranking. So this takes the last authored previous question, flatly, and says
 * so in the output.
 */
const antecedentOf = (rec) => {
  const chain = rec.prev_questions
  if (Array.isArray(chain) && chain.length) return chain[chain.length - 1]
  return rec.prev_question ?? null
}

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

const index = loadIndex()
const guard = index.manifest.guard
const tuning = index.manifest.tuning

const golden = readJsonl(GOLDEN).map((r) => ({ ...r, __set: 'golden' }))
const calibration = readJsonl(CALIBRATION_SET).map((r) => ({ ...r, __set: 'calibration' }))
let records = [...golden, ...calibration]
const limit = Number(argOf('limit', '0')) || 0
if (limit) records = records.slice(0, limit)

const lexicalOnly = flag('lexical-only')

/** Every query string the dump will rank, raw and composed alike, deduplicated. */
const wanted = new Set()
for (const rec of records) {
  wanted.add(rec.question)
  const ante = antecedentOf(rec)
  const composed = composeQuery(rec.question, ante)
  if (composed) wanted.add(composed)
}
console.log(`[dump-rankings] ${records.length} records, ${wanted.size} unique query texts`)

/**
 * ONE PURCHASE FOR THE WHOLE DUMP, through `src/eval/prefetch.ts` — the same
 * batcher `eval` buys with, so a vector here is bit-identical to the vector the
 * floor run scored with.
 */
const target = nodeEmbedTarget(resolved, process.env)
const CACHE_DIR = argOf('embed-cache-dir')

/**
 * The query-side cache, READ before it is written.
 *
 * 1.4.0 caches the DOC side of the embedder and nothing else — `prefetchEmbeddings`
 * is an in-memory map that dies with the process — so every repeat of this dump
 * was a repeat purchase, and a fixture nobody can regenerate offline is a fixture
 * that rots. Reading first makes a re-run free and, more importantly, makes the
 * dump reproducible from the fixture alone once the network is gone.
 *
 * `openEmbedCache` stores the UNIT vector (that is the contract the doc-side half
 * already keeps); `scaleToIndexDomain`'s ×127 is re-applied on the way out, so a
 * cached row and a freshly bought one enter the retriever identically.
 */
const cacheFor = (refresh) =>
  CACHE_DIR
    ? openEmbedCache({
        dir: CACHE_DIR,
        model: index.manifest.embedModel,
        provider: target.provider,
        baseURL: target.baseURL,
        prefix: 'docpilot-2.0-query-side',
        refresh,
        warn: (m) => console.warn(`[dump-rankings] ${m}`),
      })
    : null

const VECTORS = new Map()
let requests = 0
let cacheHits = 0
if (!lexicalOnly) {
  const t0 = Date.now()
  const cache = cacheFor(false)
  const missing = []
  for (const t of wanted) {
    const unit = cache?.get(t)
    if (unit) {
      const scaled = new Float64Array(unit.length)
      for (let i = 0; i < unit.length; i++) scaled[i] = unit[i] * 127
      VECTORS.set(t, scaled)
      cacheHits++
    } else missing.push(t)
  }
  if (missing.length) {
    const got = await prefetchEmbeddings(missing, { ...target, model: index.manifest.embedModel }, {
      onTick: (done, total) => process.stderr.write(`\r  embedded ${done}/${total}…`),
    })
    process.stderr.write('\n')
    requests = got.requests
    for (const [t, v] of got.vectors) VECTORS.set(t, v)
  }
  console.log(
    `[dump-rankings] ${cacheHits} cached, ${missing.length} bought in ${requests} request(s), ${
      ((Date.now() - t0) / 1000).toFixed(1)
    }s`,
  )
  if (VECTORS.size !== wanted.size) {
    console.error(
      `[docpilot] the embedder returned ${VECTORS.size} of ${wanted.size} texts — refusing to write a half-dense dump`,
    )
    process.exit(1)
  }
}

/**
 * One retrieval per DISTINCT scope, not per record.
 *
 * `createRetrieval` is a pure function of `{index, scope, guard, tuning}` and
 * holds no per-query state, so two records under one scope share an object with
 * no observable difference — and 735 constructions, each rebuilding a `prevOf`
 * map over 580 chunks, is minutes of nothing.
 */
const retrievals = new Map()
const retrievalFor = (scope) => {
  const key = JSON.stringify(scope ?? ALL_SCOPE)
  if (!retrievals.has(key)) {
    retrievals.set(key, createRetrieval({ index, scope: scope ?? ALL_SCOPE, guard, tuning }))
  }
  return retrievals.get(key)
}

/**
 * `search({k: 8})` CAN RETURN MORE THAN EIGHT, and both halves of that are
 * recorded rather than hidden.
 *
 * `rank()` clamps selection at k and then runs section expansion, which appends
 * same-page neighbours to the set it already chose — so the returned list runs to
 * 13 on this corpus. 1.4.0's own metrics disagree about which list they read:
 * `recallAtK` slices to 8, while `mrr` scans the WHOLE array and so is really
 * MRR@13 under a label that says @8 (src/eval/metrics.ts). A drift fixture that
 * stored one of the two would silently pick a side of that, so it stores both:
 * `ranked` is what 1.4.0 hands the caller, `top8` is what recall@8 reads.
 */
const rankOf = (retrieval, query, queryVec) => {
  const ranked = retrieval.search({ query, queryVec, k: 8 }).map((c) => c.id)
  return { ranked, top8: ranked.slice(0, 8) }
}

const questions = []
for (const rec of records) {
  const retrieval = retrievalFor(rec.scope)
  const ante = antecedentOf(rec)
  const composed = composeQuery(rec.question, ante)

  const row = {
    id: rec.id,
    set: rec.__set,
    question: rec.question,
    antecedent: ante,
    composedQuery: composed,
    scope: rec.scope ?? null,
    stratum: rec.stratum ?? null,
    level: rec.level ?? null,
    expect: rec.expect ?? null,
    gold_chunks: rec.gold_chunks ?? null,
    gold_page: rec.gold_page ?? null,
    channels: {},
  }

  row.channels.lexical = {
    raw: rankOf(retrieval, rec.question, undefined),
    composed: composed ? rankOf(retrieval, composed, undefined) : null,
  }
  if (!lexicalOnly) {
    row.channels.hybrid = {
      raw: rankOf(retrieval, rec.question, VECTORS.get(rec.question)),
      composed: composed ? rankOf(retrieval, composed, VECTORS.get(composed)) : null,
    }
  }
  questions.push(row)
}

/**
 * The query vectors, persisted beside the doc-side ones.
 *
 * 1.4.0 never wrote these — `prefetchEmbeddings` is an in-memory map that dies
 * with the process — so the hybrid channel could only ever be replayed by paying
 * for it again. 2.0 has to be able to run this diff offline and forever, against
 * the same vectors, which means they belong in the fixture. Stored as the unit
 * vector (`scaleToIndexDomain` divides out again) in `openEmbedCache`'s format,
 * so the doc-side and query-side halves of the fixture read the same way.
 */
if (!lexicalOnly && CACHE_DIR) {
  const cache = cacheFor(true)
  const texts = [...wanted]
  for (const t of texts) {
    const scaled = VECTORS.get(t)
    const unit = new Float32Array(scaled.length)
    for (let i = 0; i < scaled.length; i++) unit[i] = scaled[i] / 127
    cache.set(t, unit)
  }
  cache.commit(texts)
  console.log(`[dump-rankings] ${texts.length} query vectors written under ${CACHE_DIR}`)
}

const out = argOf('out', 'rankings-1.4.0.json')
const doc = {
  _comment:
    'Per-question top-8 retrieval rankings from docpilot 1.4.0, dumped as the drift ' +
    'reference for the 2.0 rewrite (ADR-015: measurement, not equivalence). Every ' +
    'entry is one question, one channel, one query variant, and the chunk ids IN RANK ' +
    'ORDER — `top8` is the eight recall@8 reads, `ranked` is the full list 1.4.0 hands ' +
    'back (section expansion can push it past eight). Never compare these as an ' +
    'aggregate — the point is the per-question diff, because a mean that did not move ' +
    'hides two questions that swapped result sets.',
  meta: {
    indexHash: index.manifest.hash,
    chunkCount: index.manifest.chunkCount,
    pages: index.manifest.pages.length,
    embedModel: index.manifest.embedModel,
    dims: index.manifest.dims,
    embedProvider: target.provider,
    embedBase: target.baseURL,
    guard: index.manifest.guard,
    tuning: index.manifest.tuning,
    vocabHash: index.manifest.vocabHash,
    records: records.length,
    golden: questions.filter((q) => q.set === 'golden').length,
    calibration: questions.filter((q) => q.set === 'calibration').length,
    uniqueQueryTexts: wanted.size,
    embedRequests: requests,
    embedCacheHits: cacheHits,
    lexicalOnly,
    channels: lexicalOnly ? ['lexical'] : ['lexical', 'hybrid'],
    k: 8,
    ranAt: new Date().toISOString(),
    command: process.argv.slice(1).map((a) => path.basename(a)).join(' '),
    docpilotVersion: JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version,
    node: process.version,
    script: 'scripts/dump-rankings.mjs',
    definitions: {
      top8: 'the first eight ids of `ranked` — the list recallAtK(…, 8) reads.',
      ranked:
        'what retrieval.search({k: 8}) actually returns, which runs to 13 on this corpus: ' +
        'rank() clamps SELECTION at k and then section expansion appends same-page ' +
        'neighbours. 1.4.0 reads two different lengths off this one array — recallAtK ' +
        'slices to 8, mrr scans all of it — so both are stored rather than a side picked.',
      raw: 'retrieval.search({query: rec.question, queryVec, k: 8}) — the bare question.',
      composed:
        "retrieval.search({query: composeQuery(rec.question, antecedent), …}) — present only " +
        'for a record that declares a previous turn. null otherwise.',
      antecedent:
        'the LAST authored prev_questions entry, else prev_question, else null. Deliberately ' +
        'NOT eval/conversation.ts\'s chainAntecedent, which reads prior gate channels and so ' +
        'would make the query string depend on thresholds and on the embedder.',
      lexical: 'queryVec omitted entirely — BM25 alone, no embedder is called.',
      hybrid: 'queryVec present — the fused dense + lexical ranking.',
      scope:
        'rec.scope when the record declares one, else {kind:"all"}. The retrieval object is ' +
        'built per distinct scope; createRetrieval is pure in it.',
      note:
        'These are the RETRIEVER\'s rankings for a stated query string. They are not identical ' +
        "to an eval report's rows[].rankedIds, which re-rank on whichever channel the gate won " +
        'on — a run-dependent choice that a drift fixture must not inherit.',
    },
    reproducibility: {
      source:
        'Generated from the query vectors in fixtures/embed-cache (cache hits, not a live ' +
        'purchase), so this file is regenerable offline and forever from the fixture alone.',
      float32Note:
        'The cache stores float32, as the doc-side half already does, while a freshly bought ' +
        'vector is float64 until it is quantised. Checked against the two 1.4.0 eval reports on ' +
        'all 62 chain-free golden records: the lexical channel is identical on 62/62, the hybrid ' +
        'channel on 61/62. The one difference is n-22 — an adjacent swap of ranks 5 and 6, a ' +
        'float32 tie-break on a negative record with an empty gold set, so it moves no metric. ' +
        'Recorded rather than smoothed over: a drift report that starts by explaining a known ' +
        'one-record delta is worth more than one that quietly cannot.',
      crossCheck:
        'The script reproduces rows[].rankedIds byte-for-byte on every chain-free golden record ' +
        'in the lexical channel, which is what establishes it is running 1.4.0 retrieval and not ' +
        'a lookalike.',
    },
  },
  questions,
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
console.log(`[dump-rankings] ${questions.length} questions → ${out}`)
