#!/usr/bin/env node
/**
 * WHY THIS SCRIPT EXISTS.
 *
 * The 1.4.0 retrieval floor was measured at the shipped default
 * DOCPILOT_ANTECEDENT_HOPS=2, so a depth>=2 record's composed query is
 * `older\nlast\nquestion`. docpilot 2.0's floor test composes flat single-hop,
 * `last\nquestion`, and the two therefore measure different query strings on the
 * same index. Re-measuring 1.4.0 at hops=1 makes them comparable.
 *
 * `npx docpilot eval --gate-only` CANNOT DO THAT RUN OFFLINE, and that is the
 * whole reason this file is not one more invocation of it. `run.ts` runs every
 * priming turn as a real turn (`resolveChain`), buying a vector for each priming
 * QUESTION and for each priming turn's own composed query. The committed
 * query-side cache (fixtures/embed-cache/embed-65a72db3e95f0c2e) was built by
 * `dump-rankings.mjs`, which ranks ONE query per record and never runs a priming
 * turn — so it holds the 92 scored questions and their 34 scored compositions
 * and none of the 74 priming questions or 41 priming compositions. At hops=1 the
 * eval needs 238 texts and the cache answers 129 of them. The other 109 are a
 * purchase, and this measurement is not worth a purchase.
 *
 * IT IS ONLY THE SCORED TURN, AND THAT IS EXACT RATHER THAN AN APPROXIMATION.
 * `probeRecords` reads exactly one value out of the cascade — `antecedent` — and
 * says so at the field itself: priorGates are "never consulted for the scored
 * turn". At hops=1 `chainAntecedent` returns `last.question` whatever the prior
 * turns' gates said (the `hops() >= 2` arm is unreachable), so the antecedent is
 * a pure function of the record. The priming cascade therefore cannot move
 * retrievedIds, rankedIds, recall@8, MRR or retrievalF1 at hops=1, and skipping
 * it costs the measurement nothing.
 *
 * EVERYTHING IT COMPUTES WITH IS 1.4.0's OWN — assembleIndex, createRetrieval,
 * evaluate, search, recallAtK, mrr, retrievalF1Loose, underPath, mean. The
 * arithmetic between them is `probeRecords`' scored-turn block and `summarise`'s
 * three retrieval means, transcribed rather than reimplemented.
 *
 * HOW IT IS VALIDATED, because a floor produced by a script has to earn it:
 *   - `--channel=lexical` needs no vectors at all, so the CLI CAN run it. Run
 *     both and the rows must be identical on all 96 records — they are, on
 *     rankedIds, retrievedIds, recall8, mrr, retrieval, channel, gatePass, G, L
 *     and D, with zero differences.
 *   - `--channel=hybrid` replays float32 cache rows where the CLI bought float64.
 *     On the 70 records whose composed query cannot depend on the hops setting
 *     (depth 0 and depth 1 — `chainAntecedent` cannot chain with one prior turn)
 *     the committed hybrid report and this replay agree everywhere but n-22,
 *     which is the adjacent rank-5/6 swap fixtures/drift already documents as a
 *     float32 tie-break on a negative with an empty gold set. Over the 46
 *     POSITIVES in that band the three metrics are equal to the last digit.
 *
 *   node scripts/replay-floor-hops1.mjs --channel=lexical|hybrid [--out=path]
 *
 * Costs nothing and touches no network. A text the cache does not hold is fatal.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const argOf = (name, dflt = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const CHANNEL = argOf('channel', 'lexical')
if (CHANNEL !== 'lexical' && CHANNEL !== 'hybrid') {
  console.error('[docpilot] --channel must be lexical or hybrid')
  process.exit(2)
}
const LEXICAL = CHANNEL === 'lexical'
const CACHE_DIR = argOf('embed-cache-dir', '/Users/olegponamarchuk/dev/universal-chat/fixtures/embed-cache')
const NAMESPACE = argOf('namespace', 'embed-65a72db3e95f0c2e')

/** The launcher's preamble, in order — see the docblock in dump-rankings.mjs. */
const { applyFileEnv } = await import('../dist/cli-env.js')
await applyFileEnv()
const { resolveDocPilot } = await import('../dist/config.js')
const { findConfig } = await import('../dist/cli-init.js')
const configPath = findConfig()
if (!configPath) {
  console.error('[docpilot] no config found — run this from the project root')
  process.exit(2)
}
const mod = await import(pathToFileURL(path.resolve(configPath)).href)
globalThis.__DOCPILOT_SETTINGS__ = resolveDocPilot(mod.docPilot ?? {}, process.env)
globalThis.__DOCPILOT_CONFIG__ = configPath

const { RAG, GOLDEN } = await import('../dist/cli-context.js')
const { assembleIndex } = await import('../dist/theme/docpilot/store.js')
const { createRetrieval } = await import('../dist/theme/docpilot/retriever.js')
const { composeQuery } = await import('../dist/theme/docpilot/gate.js')
const { priorQuestions } = await import('../dist/eval/record.js')
const M = await import('../dist/eval/metrics.js')

/** `loadIndex`, transcribed from src/eval/run.ts:432 — see dump-rankings.mjs. */
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
const index = loadIndex()
const guard = index.manifest.guard
const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

/**
 * The query-side cache, read positionally rather than through `openEmbedCache`.
 *
 * The key is `sha256(text).slice(0, 32)` and carries NO prefix — the `prefix`
 * argument `openEmbedCache` takes lands in the NAMESPACE (the filename) and
 * never in the key. `openEmbedCache` would do here; reading the pair directly
 * keeps the one thing this script must not get wrong visible in this file.
 */
const idxDoc = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${NAMESPACE}.json`), 'utf8'))
const bin = fs.readFileSync(path.join(CACHE_DIR, `${NAMESPACE}.bin`))
if (bin.length !== idxDoc.keys.length * idxDoc.dims * 4) {
  console.error('[docpilot] cache index and blob disagree — refusing to read half of it')
  process.exit(1)
}
const flat = new Float32Array(bin.buffer, bin.byteOffset, idxDoc.keys.length * idxDoc.dims)
const ROWS = new Map(idxDoc.keys.map((k, i) => [k, flat.subarray(i * idxDoc.dims, (i + 1) * idxDoc.dims)]))
const keyOf = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 32)

/**
 * `scaleToIndexDomain`'s ×127 re-applied on the way out, exactly as
 * dump-rankings.mjs does it: the cache stores the UNIT vector, and it is the
 * ×127 into the int8 domain that makes the runtime dot product a cosine.
 */
const MISSES = []
const vecOf = (text) => {
  const unit = ROWS.get(keyOf(text))
  if (!unit) {
    MISSES.push(text)
    return null
  }
  const out = new Float64Array(unit.length)
  for (let i = 0; i < unit.length; i++) out[i] = unit[i] * 127
  return out
}

const golden = fs
  .readFileSync(GOLDEN, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

/** One retrieval per DISTINCT scope; `createRetrieval` is pure in it. */
const retrievals = new Map()
const retrievalFor = (scope) => {
  const key = JSON.stringify(scope)
  if (!retrievals.has(key)) {
    retrievals.set(key, createRetrieval({ index, scope, guard, tuning: index.manifest.tuning }))
  }
  return retrievals.get(key)
}

const rows = []
for (const rec of golden) {
  const scope = rec.scope || ALL_SCOPE
  const retrieval = retrievalFor(scope)

  /**
   * hops=1: `chainAntecedent(priors).text === priors.at(-1).question`, whatever
   * each prior turn's gate decided. This is the ONE value probeRecords reads out
   * of the cascade, which is why the cascade does not have to run.
   */
  const priors = priorQuestions(rec)
  const antecedent = priors.length ? priors[priors.length - 1] : null
  const composedQuery = composeQuery(rec.question, antecedent)

  const vec = LEXICAL ? undefined : vecOf(rec.question)
  let composedVec
  if (composedQuery && !LEXICAL) composedVec = vecOf(composedQuery)
  if (LEXICAL && composedQuery) composedVec = null

  const g = retrieval.evaluate({
    question: rec.question,
    previousQuestion: antecedent,
    queryVec: vec,
    composedVec,
    mode: LEXICAL ? 'lexical-only' : 'hybrid',
  })
  const retrievedIds = g.chunks.map((c) => c.id)
  const ranked =
    g.channel === 'composed' && composedVec
      ? { query: composedQuery, queryVec: composedVec }
      : { query: rec.question, queryVec: vec }
  const rankedIds = retrieval.search({ ...ranked, k: 8 }).map((c) => c.id)

  const gold = rec.gold_chunks ?? []
  const goldInScope =
    scope.kind === 'all' || !scope.paths.length
      ? gold
      : gold.filter((gc) => scope.paths.some((p) => M.underPath(`/${gc}`, p)))
  const scoredAsNegative = gold.length > 0 && goldInScope.length === 0

  rows.push({
    id: rec.id,
    question: rec.question,
    expect: rec.expect,
    depth: priors.length,
    antecedent,
    composedQuery,
    channel: g.channel,
    G: g.G,
    D: g.D,
    L: g.L,
    gatePass: g.pass,
    retrievedIds,
    rankedIds,
    goldPages: [...new Set(goldInScope.map((x) => M.pageOf(x)))],
    scoredAsNegative,
    retrieval: goldInScope.length ? M.retrievalF1Loose(retrievedIds, goldInScope) : null,
    recall8: goldInScope.length ? M.recallAtK(rankedIds, goldInScope, 8) : null,
    mrr: goldInScope.length ? M.mrr(rankedIds, goldInScope) : null,
  })
}

/**
 * A HALF-DENSE REPLAY IS NOT A FLOOR. Every text has to be a hit, or the run
 * names what it could not find and scores nothing.
 */
if (MISSES.length) {
  console.error(
    `[docpilot] ${MISSES.length} query text(s) are not in ${NAMESPACE} — refusing to score a partial replay`,
  )
  for (const m of MISSES.slice(0, 20)) console.error('   ', JSON.stringify(m.slice(0, 140)))
  process.exit(1)
}

/** `summarise`'s two filters and its three retrieval means, verbatim. */
const positives = rows.filter((r) => r.expect === 'answer' && !r.scoredAsNegative)
const negatives = rows.filter((r) => r.expect.startsWith('refuse') || r.scoredAsNegative)
const summary = {
  positives: positives.length,
  negatives: negatives.length,
  retrievalF1: M.mean(positives.map((r) => r.retrieval?.f1)),
  recall8: M.mean(positives.map((r) => r.recall8)),
  mrr: M.mean(positives.map((r) => r.mrr)),
}

const doc = {
  _comment:
    'Scored-turn replay of `docpilot eval --gate-only` at DOCPILOT_ANTECEDENT_HOPS=1, ' +
    'computed offline from the committed query-side embed cache. Not a CLI run: the CLI ' +
    'also embeds every PRIMING turn, and those vectors were never cached. See the header ' +
    'of scripts/replay-floor-hops1.mjs for why the priming cascade cannot move any number ' +
    'in this file at hops=1, and for how the replay is validated against the CLI.',
  meta: {
    instrument: 'scripts/replay-floor-hops1.mjs (NOT `npx docpilot eval`)',
    channel: CHANNEL,
    antecedentHops: 1,
    gateOnly: true,
    lexicalOnly: LEXICAL,
    indexHash: index.manifest.hash,
    chunkCount: index.manifest.chunkCount,
    pages: index.manifest.pages.length,
    embedModel: index.manifest.embedModel,
    dims: index.manifest.dims,
    guard: index.manifest.guard,
    guardMode: globalThis.__DOCPILOT_SETTINGS__?.guard?.mode ?? 'off',
    levers: index.manifest.tuning ?? null,
    vocabHash: index.manifest.vocabHash,
    records: rows.length,
    embedCache: `${CACHE_DIR}/${NAMESPACE}`,
    embedCacheKeys: idxDoc.keys.length,
    embedRequests: 0,
    networkRequests: 0,
    goldenFile: GOLDEN,
    ranAt: new Date().toISOString(),
    command: process.argv.slice(1).map((a) => (a.startsWith('/') ? path.basename(a) : a)).join(' '),
    docpilotVersion: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    node: process.version,
    script: 'scripts/replay-floor-hops1.mjs',
  },
  summary,
  rows,
}

const out = argOf('out')
console.log(`[replay-floor-hops1] channel=${CHANNEL} hops=1 records=${rows.length} embedRequests=0`)
console.log(
  `  recall@8 ${summary.recall8}  (round×132 = ${Math.round(summary.recall8 * 132)})\n` +
    `  mrr      ${summary.mrr}\n` +
    `  retrievalF1 ${summary.retrievalF1}`,
)
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n')
  console.log(`  → ${out}`)
}
