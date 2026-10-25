/**
 * `docpilot status` — one picture of the project. engine-spec 030.
 *
 * WHY IT EXISTS. "Is my index fresh, is the guard calibrated for it, how did
 * the last eval do, is the server up?" took four commands and a JSON file —
 * `index --dry`, `doctor`, reading `docpilot/reports/latest.json`, and `curl` —
 * and none of them said what to run next.
 *
 * TWO HALVES. `collectStatus()` reads — the manifest, the calibration, the eval
 * sets, the reports, the docs, and a server when there is one to reach — and
 * returns ONE object. `renderStatus()` draws it. The home screen, the picture
 * and `--json` all take the same object, so what a person reads and what the
 * tuning agent (spec 036) parses cannot disagree.
 *
 * THE FRESHNESS CHECK IS THE TEST'S, NOT A GUESS. The index version is a pure
 * function of the corpus — `sha256(JSON.stringify(chunks.map(c => c.id +
 * c.text))).slice(0, 8)` in `build-rag-index.ts` — with no embedding in it, so
 * the docs are chunked here, offline, and the hash compared. It is the same
 * derivation `test/docs-links.test.js` holds this repository's own index to,
 * and it has the same blind spots, said rather than papered over: pages under
 * `importDir`, OpenAPI specs and `--html-dir` are not re-read, and an index
 * built from any of them is reported as unverified instead of stale.
 *
 * NO NETWORK unless there is a server to reach: `--url`, or a project on the
 * server runtime, whose endpoint `docpilot serve` puts on localhost:8787.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

import { chunkMarkdown } from './build/lib/chunker.js'
import { specFiles } from './build/lib/openapi-chunker.js'
import { routeOf } from './theme/docpilot/route.js'
import { indexDirOf } from './config.js'
import { DEFAULT_RUN_LEVEL, LEVELS, recordLevel } from './eval/levels.js'
import { previousReport } from './eval/report.js'
import { FAILED, OK, USAGE, printError } from './cli-exit.js'
import { flagErrors, flagGiven, flagValue, helpFor } from './cli-flags.js'
import { bytes, count, duration, kv, ui } from './cli-ui.js'
import type { Ui } from './cli-ui.js'
import { SCORECARD, renderScorecard, scorecardRows } from './cli-scorecard.js'
import { fetchMetrics, serverEndpoint } from './cli-monitor.js'

type Env = Record<string, string | undefined>

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** How many runs a sparkline reaches back over. */
const SERIES = 12

// ── the corpus ───────────────────────────────────────────────────────────────

/**
 * The build's enumeration, step for step: `walkMarkdown` skipping `.vitepress`
 * and `public`, `.md` and `.mdx`, in `readdirSync` order — the hash is
 * order-sensitive and the build does not sort, so neither does this — then
 * `EXCLUDE`, then `kindFor`. Restated rather than imported because importing
 * `build-rag-index.js` runs a build's worth of module scope; held to the build
 * by `test/cli-status.test.js`, which builds a lexical-only index of a scratch
 * project with the real `docpilot index` and compares the two hashes.
 */
const EXCLUDE = new Set(['/index', '/new-file'])
const kindFor = (route) =>
  route.startsWith('/reference/') ? 'reference' : route.startsWith('/extensions') ? 'extensions' : 'guide'

function walkMarkdown(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.vitepress' && entry.name !== 'public') walkMarkdown(p, acc)
    } else if (/\.mdx?$/.test(entry.name)) acc.push(p)
  }
  return acc
}

/**
 * The hash `docpilot index` would give the docs as they are now.
 *
 * @returns `unverifiable` — a sentence, or null — when the index can hold
 *   chunks this cannot re-derive, so a mismatch would not mean "stale".
 */
export function corpusOf(docPilot, root = process.cwd()) {
  const docs = path.resolve(root, docPilot.docsDir)
  if (!fs.existsSync(docs)) {
    return { hash: null, chunks: 0, pages: new Set<string>(), unverifiable: `there is no ${docPilot.docsDir}/ to compare it with` }
  }
  // A spec claims its route from the markdown pass, so the claimed routes are
  // skipped here exactly as the build skips them.
  const { files: specs } = specFiles(docPilot.openapi, path.join(docPilot.docsDir, 'public', 'openapi'), root)
  const specRoutes = new Set(specs.map((f) => `/reference/${path.basename(f).replace(/\.ya?ml$/i, '')}`))
  const chunks = []
  const pages = new Set<string>()
  for (const file of walkMarkdown(docs)) {
    const route = routeOf(path.relative(docs, file))
    if (EXCLUDE.has(route) || specRoutes.has(route)) continue
    const { chunks: c } = chunkMarkdown({ src: fs.readFileSync(file, 'utf8'), path: route, kind: kindFor(route) })
    if (!c.length) continue
    chunks.push(...c)
    pages.add(route)
  }
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(chunks.map((c) => c.id + c.text)))
    .digest('hex')
    .slice(0, 8)
  const importDir = docPilot.importDir ? path.resolve(root, docPilot.importDir) : null
  const extra = [
    specs.length ? `${specs.length} OpenAPI spec(s)` : null,
    importDir && fs.existsSync(importDir) ? `the pages under ${docPilot.importDir}/` : null,
  ].filter(Boolean)
  const unverifiable = extra.length
    ? `the index also holds ${extra.join(' and ')}, which status does not re-chunk`
    : chunks.length
      ? null
      : `${docPilot.docsDir}/ holds no markdown — an index built with --html-dir cannot be re-derived here`
  return { hash, chunks: chunks.length, pages, unverifiable }
}

// ── the blocks ───────────────────────────────────────────────────────────────

const relTo = (root) => (p) => (path.relative(root, p) || '.').split(path.sep).join('/')

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * Sizes on disk, and what they cost over the wire.
 *
 * Brotli per FILE, because the browser fetches them one at a time and each is
 * compressed on its own. Quality 9, not 11: measured on this repository's
 * index it lands within 5% of 11 in 37 ms instead of 1.7 s, and the number is
 * labelled an estimate.
 */
function sizesOf(dir) {
  let onDisk = 0
  let brotli = 0
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (!st.isFile()) continue
    onDisk += st.size
    brotli += zlib.brotliCompressSync(fs.readFileSync(p), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }).length
  }
  return { onDisk, brotli }
}

function readIndex(docPilot, root) {
  const rel = relTo(root)
  const dir = path.resolve(root, indexDirOf(docPilot))
  const file = path.join(dir, 'manifest.json')
  const block = {
    dir: rel(dir),
    exists: false,
    hash: null,
    chunks: null,
    pages: null,
    embedModel: null,
    dims: null,
    quant: null,
    bytes: null,
    brotliBytes: null,
    fresh: null,
    docsHash: null,
    docsChunks: null,
    reason: null,
  }
  let manifest = null
  try {
    manifest = readJson(file)
  } catch (e) {
    block.reason = fs.existsSync(file) ? `${rel(file)} is unreadable (${e.message})` : `there is no index at ${block.dir}`
    return { block, manifest: null }
  }
  Object.assign(block, {
    exists: true,
    hash: manifest.hash ?? null,
    chunks: manifest.chunkCount ?? null,
    pages: Array.isArray(manifest.pages) ? manifest.pages.length : null,
    embedModel: manifest.embedModel ?? null,
    dims: manifest.dims || null,
    // Absent `quant` is int8 — that is how every manifest before 027 reads.
    quant: manifest.vectors == null ? 'none' : (manifest.quant ?? 'int8'),
  })
  const { onDisk, brotli } = sizesOf(dir)
  block.bytes = onDisk
  block.brotliBytes = brotli

  const corpus = corpusOf(docPilot, root)
  block.docsHash = corpus.hash
  block.docsChunks = corpus.chunks
  if (corpus.unverifiable) {
    block.reason = corpus.unverifiable
  } else if (corpus.hash === manifest.hash) {
    block.fresh = true
  } else {
    block.fresh = false
    const gone = (manifest.pages ?? []).filter((p) => p?.path && !corpus.pages.has(p.path)).length
    block.reason =
      `${docPilot.docsDir}/ now chunks to ${corpus.hash} (${corpus.chunks} chunks); the index is ` +
      `${manifest.hash} (${manifest.chunkCount} chunks)` +
      (gone ? ` — ${gone} indexed page(s) have no markdown here: deleted since, or built with --html-dir` : '')
  }
  return { block, manifest }
}

/**
 * The guard the index SHIPS, and the calibration on disk — which are two
 * things, and the gap between them is half of what this block is for.
 *
 * The staleness rules are `guardFor`'s in `build-rag-index.ts`, in its order:
 * the corpus, the vocabulary, the embedder. They are restated rather than
 * called because `guardFor` reads its module's build state; what it decides at
 * build time is in `manifest.guard`, and what it WOULD decide now is this.
 */
function readGuard(docPilot, manifest, root) {
  const rel = relTo(root)
  const mode = docPilot.guard?.mode ?? 'off'
  const evalDir = path.resolve(root, docPilot.evalDir)
  // `calibrationPathFor`: a per-index file first, the shared one as fallback.
  const named = path.join(evalDir, `calibration.${path.basename(path.resolve(root, indexDirOf(docPilot)))}.json`)
  const file = fs.existsSync(named) ? named : path.join(evalDir, 'calibration.json')
  const calibration = { file: rel(file), exists: fs.existsSync(file), calibratedAt: null, source: null, tau: null, stale: null, reason: null }
  if (!calibration.exists) {
    calibration.reason = 'nothing has measured the thresholds yet'
  } else {
    try {
      const doc = readJson(file)
      const g = doc?.guard
      calibration.calibratedAt = g?.calibratedAt ?? null
      calibration.source = g?.source ?? null
      calibration.tau = g?.tau ?? null
      calibration.stale = true
      if (!g) calibration.reason = 'it carries no guard'
      else if (!manifest) calibration.reason = 'there is no index to hold it to'
      else if (g.calibratedAt !== manifest.hash) calibration.reason = `it was measured on index ${g.calibratedAt}, and the index is ${manifest.hash}`
      else if ((doc.vocabHash ?? null) !== (manifest.vocabHash ?? null)) {
        calibration.reason = `it was measured with vocabulary ${doc.vocabHash ?? 'none'}, and the index tokenises with ${manifest.vocabHash ?? 'none'}`
      } else if (doc.embedModel && doc.embedModel !== manifest.embedModel) {
        calibration.reason = `it was measured with "${doc.embedModel}", and the index embeds with "${manifest.embedModel}"`
      } else calibration.stale = false
    } catch (e) {
      calibration.stale = true
      calibration.reason = `it is unreadable (${e.message})`
    }
  }

  const shipped = manifest?.guard ?? null
  // `guard.tau` written by hand wins at runtime — `session.js` mints source
  // "config" for it — so neither the manifest nor the file is what gates.
  const byHand = isNum(docPilot.guard?.tau)
  const verdict = byHand
    ? 'config'
    : !shipped
      ? null
      : shipped.source === 'provisional'
        ? 'provisional'
        : calibration.stale
          ? 'stale'
          : 'calibrated'
  return {
    mode,
    enforced: mode !== 'off',
    tau: byHand ? docPilot.guard.tau : (shipped?.tau ?? null),
    tauLexical: byHand ? (docPilot.guard.tauLexical ?? null) : (shipped?.tauLexical ?? null),
    source: byHand ? 'config' : (shipped?.source ?? null),
    calibratedAt: shipped?.calibratedAt ?? null,
    verdict,
    // Measured for THIS index and not in its manifest: `calibrate` ran after
    // `index`, and only `index` inlines.
    pendingInline: Boolean(
      !byHand && shipped && calibration.stale === false && (shipped.source !== calibration.source || shipped.calibratedAt !== calibration.calibratedAt),
    ),
    calibration,
  }
}

/** A JSONL file, parsed a line at a time, with the lines that did not parse counted. */
function readJsonl(file) {
  if (!fs.existsSync(file)) return { exists: false, records: [], invalid: 0 }
  const records = []
  let invalid = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      invalid++
    }
  }
  return { exists: true, records, invalid }
}

const histogram = (records, of) => {
  const out = {}
  for (const r of records) {
    const k = of(r)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/**
 * Counts by the three axes a set is cut along — `expect`, `split`, `level` —
 * plus `stratum` for the calibration probes. An axis no record carries is
 * null rather than `{ "(none)": 96 }`.
 */
function setSummary(file, rel, { level = false, stratum = false } = {}) {
  const { exists, records, invalid } = readJsonl(file)
  const carries = (k) => records.some((r) => r?.[k] != null)
  const levelOrder = (h) => {
    const out = {}
    for (const l of [...LEVELS, ...Object.keys(h).filter((k) => !LEVELS.includes(k))]) if (h[l]) out[l] = h[l]
    return out
  }
  return {
    file: rel(file),
    exists,
    records: records.length,
    invalid,
    byExpect: carries('expect') ? histogram(records, (r) => r.expect ?? '(none)') : null,
    bySplit: carries('split') ? histogram(records, (r) => r.split ?? '(none)') : null,
    // `recordLevel`, so an absent level counts where `eval` scores it — at `high`.
    byLevel: level && records.length ? levelOrder(histogram(records, (r) => recordLevel(r))) : null,
    ...(stratum ? { byStratum: carries('stratum') ? histogram(records, (r) => r.stratum ?? '(none)') : null } : {}),
  }
}

function readEvalSets(docPilot, root) {
  const rel = relTo(root)
  const dir = path.resolve(root, docPilot.evalDir)
  const chainsFile = path.join(dir, 'chains.jsonl')
  const chains = readJsonl(chainsFile)
  return {
    golden: setSummary(path.join(dir, 'golden.jsonl'), rel, { level: true }),
    chains: {
      file: rel(chainsFile),
      exists: chains.exists,
      records: chains.records.length,
      invalid: chains.invalid,
      turns: chains.records.reduce((a, r) => a + (Array.isArray(r?.turns) ? r.turns.length : 0), 0),
      byKind: chains.records.length ? histogram(chains.records.flatMap((r) => (Array.isArray(r?.turns) ? r.turns : [])), (t) => t?.kind ?? '(none)') : null,
    },
    adversarial: setSummary(path.join(dir, 'adversarial.jsonl'), rel, { level: true }),
    calibration: setSummary(path.join(dir, 'calibration.jsonl'), rel, { stratum: true }),
  }
}

/** sha1 of the golden file, truncated to 16 — `goldenSha` in `run.ts`, byte for byte. */
const goldenShaOf = (file) => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/**
 * Every report on disk, oldest first: `reports/report-*.json` and the copies
 * `writeReport` keeps in `reports/history/` when a rerun overwrites one.
 *
 * Ordered by `meta.ranAt`. A report with no `ranAt` predates the field, so it
 * goes BEFORE every report that has one, ordered among its own kind by mtime —
 * not interleaved by mtime, because a fresh clone gives every file the same
 * mtime, the checkout's, and an old report would read as the newest run.
 */
function readReports(dir) {
  const out = []
  const scan = (d, history) => {
    let names = []
    try {
      names = fs.readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith('report-') || !name.endsWith('.json')) continue
      const file = path.join(d, name)
      try {
        const doc = readJson(file)
        if (!doc?.meta || !doc?.summary) continue
        const stamped = Date.parse(doc.meta.ranAt ?? '')
        const ranAt = Number.isFinite(stamped) ? stamped : fs.statSync(file).mtimeMs
        out.push({ file, history, meta: doc.meta, summary: doc.summary, ranAt, stamped: Number.isFinite(stamped) })
      } catch {
        // A half-written report is not a run.
      }
    }
  }
  scan(dir, false)
  scan(path.join(dir, 'history'), true)
  return out.sort((a, b) => Number(a.stamped) - Number(b.stamped) || a.ranAt - b.ranAt)
}

/**
 * Would `eval` compare these two runs? ASKED OF `previousReport`, NOT COPIED.
 *
 * `previousReport` in `src/eval/report.ts` owns the rule — a lexical diagnostic
 * is not a hybrid run, a tier is a different population, a server runtime is a
 * different install, a split is a different half of the set — and the rule
 * keeps growing: it went from four checks to eight while this command was
 * being written. A restated copy here would have paired runs `eval` refuses to
 * compare, in silence, from the first check it missed.
 *
 * So the candidate's `meta` is written, alone, under the QUERIED run's file
 * prefix in a private directory, and `previousReport` is asked whether it
 * pairs. The prefix is the (index, model) half of the rule, matched by
 * construction; everything `previousReport` checks inside the document decides.
 * One small file per candidate, and the scan below stops as soon as it has
 * what it needs.
 */
export function pairing(meta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-status-'))
  const file = path.join(dir, `report-${meta.indexHash}-${String(meta.model).replace(/[^\w.-]+/g, '_')}-candidate.json`)
  return {
    pairs(candidate) {
      fs.writeFileSync(file, JSON.stringify({ meta: candidate, summary: {} }))
      return previousReport(dir, meta) != null
    },
    close() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** `pairing` for one question. */
export function comparableRuns(candidate, meta) {
  const p = pairing(meta)
  try {
    return p.pairs(candidate)
  } finally {
    p.close()
  }
}

/**
 * The newest report, the one it is compared against, and its history.
 *
 * THE DELTA AND THE TREND USE TWO RULES ON PURPOSE. The delta is against the
 * predecessor `eval` itself paired the run with — same index, same model, and
 * `comparableRuns` — so the arrow here is the arrow `eval` printed. The trend
 * drops the index: a sparkline that reset on every rebuild would never be more
 * than two points long, and how a metric moved as the docs moved is exactly
 * what a history is for.
 */
function readLastEval(docPilot, root, manifest, now) {
  const rel = relTo(root)
  const all = readReports(path.resolve(root, docPilot.evalDir, 'reports'))
  const top = all.filter((r) => !r.history)
  if (!top.length) return null
  const newest = top[top.length - 1]
  const m = newest.meta
  const indexHash = manifest?.hash ?? null
  // EARLIER BY POSITION in the sorted list, not by comparing times — the
  // ordering already knows that an unstamped report precedes a stamped one.
  // Walked newest first, and only as far as it takes to fill the sparkline
  // and find the predecessor on this index.
  const kin = []
  let prev = null
  const pair = pairing(m)
  try {
    for (const r of all.slice(0, all.indexOf(newest)).reverse()) {
      if (kin.length >= SERIES - 1 && prev) break
      if (r.meta.model !== m.model || !pair.pairs(r.meta)) continue
      if (kin.length < SERIES - 1) kin.unshift(r)
      if (!prev && r.meta.indexHash === m.indexHash) prev = r
    }
  } finally {
    pair.close()
  }
  const history = [...kin, newest]
  const series = Object.fromEntries(
    SCORECARD.map(({ key }) => [key, history.map((r) => (isNum(r.summary[key]) ? r.summary[key] : null))]),
  )
  const rows = scorecardRows(newest.summary, { prev: prev?.summary ?? null, gateOnly: Boolean(m.gateOnly), series })

  const forIndex = { gateOnly: false, full: false, partial: false }
  for (const r of top) {
    if (!indexHash || r.meta.indexHash !== indexHash) continue
    if (r.meta.gateOnly) forIndex.gateOnly = true
    else if ((r.meta.level ?? DEFAULT_RUN_LEVEL) === DEFAULT_RUN_LEVEL) forIndex.full = true
    else forIndex.partial = true
  }
  const goldenNow = goldenShaOf(path.resolve(root, docPilot.evalDir, 'golden.jsonl'))
  const reference = top.filter((r) => r.meta.indexHash === indexHash).at(-1) ?? newest
  const s = newest.summary
  return {
    file: rel(newest.file),
    model: m.model ?? null,
    level: m.level ?? DEFAULT_RUN_LEVEL,
    gateOnly: Boolean(m.gateOnly),
    lexical: Boolean(m.lexical),
    ranAt: new Date(newest.ranAt).toISOString(),
    ageMs: Math.max(0, now - newest.ranAt),
    indexHash: m.indexHash ?? null,
    forCurrentIndex: Boolean(indexHash) && m.indexHash === indexHash,
    records: m.records ?? null,
    goldenChanged: Boolean(goldenNow && reference.meta.goldenSha && reference.meta.goldenSha !== goldenNow),
    hardGates: {
      hallucinated: isNum(s.hallucinated) ? s.hallucinated : null,
      scopeContainment: isNum(s.scopeContainment) ? s.scopeContainment : null,
      passed: !(s.hallucinated > 0) && !(isNum(s.scopeContainment) && s.scopeContainment < 1),
    },
    previous: prev ? { file: rel(prev.file), ranAt: new Date(prev.ranAt).toISOString() } : null,
    runs: history.length,
    metrics: rows.map(({ key, label, value, of, delta, better, series: trend }) => ({ key, label, value, of, delta, better, series: trend })),
    forIndex,
  }
}

/**
 * The server block. Reached only when there is a server to reach: `--url`, or
 * the server runtime, whose endpoint `serve` puts on localhost:8787.
 *
 * `{endpoint}/manifest` is what the panel itself reads first, so it is the
 * honest "is it up" — and it carries the index hash, which says whether the
 * process is serving the index on disk or the one it read when it started.
 */
async function readServer({ url, docPilot, env, fetchImpl, timeoutMs, localHash }) {
  const endpoint = url ? serverEndpoint(url, docPilot) : docPilot.runtime === 'server' ? serverEndpoint(null, docPilot) : null
  const block = {
    configured: Boolean(endpoint),
    url: endpoint,
    reachable: null,
    status: null,
    roundTripMs: null,
    error: null,
    manifest: null,
    indexMatches: null,
    metrics: null,
    metricsStatus: null,
    metricsError: null,
  }
  if (!endpoint) return block
  const t0 = performance.now()
  let res
  try {
    res = await fetchImpl(`${endpoint}/manifest`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    block.reachable = false
    block.error = e?.name === 'TimeoutError' ? `no answer in ${duration(timeoutMs)}` : String(e?.cause?.code || e?.message || e)
    return block
  }
  block.reachable = true
  block.status = res.status
  block.roundTripMs = Math.round(performance.now() - t0)
  if (res.ok) {
    try {
      const m = await res.json()
      block.manifest = { hash: m?.hash ?? null, chunkCount: m?.chunkCount ?? null }
      block.indexMatches = block.manifest.hash && localHash ? block.manifest.hash === localHash : null
    } catch {
      block.error = 'the manifest is not JSON'
    }
  } else {
    block.error = `the manifest answered HTTP ${res.status}`
  }
  const r = await fetchMetrics(endpoint, { token: env.DOCPILOT_METRICS_TOKEN ?? null, fetch: fetchImpl, timeoutMs })
  block.metrics = r.ok ? r.snapshot : null
  block.metricsStatus = r.ok ? 'ok' : r.status === 404 ? 'unavailable' : r.status === 401 || r.status === 403 ? 'unauthorized' : 'error'
  block.metricsError = r.error
  return block
}

// ── what to run next ─────────────────────────────────────────────────────────

const step = (rule, argv, why, then = []) => ({
  rule,
  argv,
  command: `npx docpilot ${argv.join(' ')}`,
  why,
  then: then.map(([a, w]) => ({ argv: a, command: `npx docpilot ${a.join(' ')}`, why: w })),
})

/**
 * THE RULES, in the order the loop runs: a config before an index, an index
 * before a threshold, a threshold before a measurement, and the cheapest
 * measurement before the expensive one. The first rule that fires is the one
 * command to run next; `rule` names it so a script can branch on it without
 * parsing a sentence.
 */
export function nextStep(s) {
  if (!s.project.config) {
    return step('no-config', ['init'], 'there is no docPilot config here — init scaffolds one, with the eval sets and the skills')
  }
  if (!s.index.exists) return step('no-index', ['index'], `${s.index.reason} — the panel has nothing to search`)
  if (s.index.fresh === false) return step('stale-index', ['index'], `the docs changed since the index was built: ${s.index.reason}`)
  const g = s.guard
  if (g.pendingInline) {
    return step('guard-not-inlined', ['index'], `${g.calibration.file} was measured for this index and is not in its manifest yet — index inlines it`)
  }
  if (g.enforced && (g.verdict === 'provisional' || g.verdict === 'stale')) {
    return step(
      'stale-guard',
      ['calibrate'],
      `guard.mode is '${g.mode}', so the gate refuses on its thresholds — and ${g.calibration.reason}`,
    )
  }
  const golden = s.evalSets.golden
  if (!golden.exists || !golden.records) {
    return step('no-golden', ['init'], `there is no golden set at ${golden.file} — init scaffolds three records to grow it from`)
  }
  const fi = s.lastEval?.forIndex
  if (!fi || (!fi.gateOnly && !fi.full && !fi.partial)) {
    return step(
      'no-report',
      ['eval', '--gate-only'],
      `nothing has measured index ${s.index.hash} yet — a gate-only run calls no model, costs nothing and takes seconds`,
      [[['eval'], 'the whole golden set, with the model answering']],
    )
  }
  if (!fi.full && !fi.partial) {
    return step('gate-only', ['eval'], `index ${s.index.hash} has a gate-only report, so its answers have not been measured`)
  }
  if (s.lastEval.goldenChanged) {
    return step('golden-changed', ['eval'], 'the golden set changed since the last eval, so its numbers describe a different set')
  }
  if (!fi.full) return step('one-tier', ['eval'], `the reports for index ${s.index.hash} score one tier — the whole set has not run on it`)
  return step('measured', ['eval', '--level=low'], `everything is measured for index ${s.index.hash} — a smoke run is the cheapest check after the next change`)
}

// ── the object ───────────────────────────────────────────────────────────────

/**
 * THE STATUS — `{kind: 'docpilot.status', v: 1, …}`.
 *
 * Reads, never writes, and returns everything `renderStatus` and `--json`
 * need. `fetch` and `now` are injectable so a test can hold the server block
 * and the ages still.
 *
 * @param docPilot RESOLVED settings, as the launcher hands every command.
 * @param configPath the file they came from, or null — "no config" is a rule.
 */
export async function collectStatus({
  docPilot,
  configPath = null,
  root = process.cwd(),
  env = process.env,
  url = null,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = 1500,
}: {
  docPilot: any
  configPath?: string | null
  root?: string
  env?: Env
  url?: string | null
  fetch?: typeof fetch
  now?: number
  timeoutMs?: number
}) {
  const project = {
    config: configPath,
    product: docPilot.product ?? null,
    runtime: docPilot.runtime ?? 'browser',
    docsDir: docPilot.docsDir,
    indexDir: relTo(root)(path.resolve(root, indexDirOf(docPilot))),
    evalDir: docPilot.evalDir,
  }
  const { block: index, manifest } = readIndex(docPilot, root)
  const status = {
    kind: 'docpilot.status',
    v: 1,
    project,
    index,
    guard: readGuard(docPilot, manifest, root),
    evalSets: readEvalSets(docPilot, root),
    lastEval: readLastEval(docPilot, root, manifest, now),
    server: await readServer({ url, docPilot, env, fetchImpl, timeoutMs, localHash: manifest?.hash ?? null }),
    next: null,
  }
  status.next = nextStep(status)
  return status
}

// ── the picture ──────────────────────────────────────────────────────────────

const GUARD_MODE = {
  off: 'off — scored on every turn, refuses nothing',
  'dense-only': 'dense-only — refuses on the dense channel alone',
  calibrated: 'calibrated — refuses below tau, before the model is called',
}

/** `low 10 · medium 11` — a histogram in its own key order, or null. */
const counts = (h, sep, limit = Infinity) => {
  if (!h) return null
  const entries = Object.entries(h)
  const shown = entries.slice(0, limit).map(([k, n]) => `${k} ${count(n as number)}`)
  return shown.join(sep) + (entries.length > limit ? `${sep}…` : '')
}

/** `answer 66 · refuse 30` — the refusals folded, because the reasons are the JSON's detail. */
const expectCounts = (h, sep) => {
  if (!h) return null
  let refuse = 0
  const rest = {}
  for (const [k, n] of Object.entries(h)) {
    if (String(k).startsWith('refuse')) refuse += n as number
    else rest[k] = n
  }
  return counts({ ...rest, ...(refuse ? { refuse } : {}) }, sep)
}

/**
 * The picture. PURE: one status object in, lines out, at whatever width and
 * with whatever colour `view` says — so the home screen and the command draw
 * the same thing, and a test draws it at 80 columns with colour on and off.
 */
export function renderStatus(s, view: Ui): string[] {
  const { c, sym } = view
  const sep = c.muted(' · ')
  const yes = (t) => c.ok(`${sym.ok} ${t}`)
  const no = (t) => c.fail(`${sym.fail} ${t}`)
  const maybe = (t) => c.warn(`${sym.dot} ${t}`)
  const blocks: Array<[string, string]> = []

  const p = s.project
  blocks.push([
    'project',
    [
      [`runtime ${p.runtime}`, `config ${p.config ?? c.warn('none — shipped defaults')}`].join(sep),
      [`docs ${p.docsDir}/`, `index ${p.indexDir}/`, `eval ${p.evalDir}/`].join(sep),
    ].join('\n'),
  ])

  const i = s.index
  if (!i.exists) {
    blocks.push(['index', no(i.reason)])
  } else {
    const verdict = i.fresh === true ? yes('fresh') : i.fresh === false ? no('stale') : maybe('unverified')
    const vectors =
      i.quant === 'none'
        ? 'lexical only — no vectors'
        : [i.embedModel ?? '—', i.dims ? `${i.dims}d` : null, i.quant].filter(Boolean).join(sep)
    blocks.push([
      'index',
      [
        `${verdict}  ${[i.hash, `${count(i.chunks)} chunks`, `${count(i.pages)} pages`].join(sep)}`,
        [vectors, `${bytes(i.bytes)} on disk`, `≈ ${bytes(i.brotliBytes)} brotli`].join(sep),
        i.reason ? c.muted(i.reason) : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ])
  }

  const g = s.guard
  if (i.exists || g.verdict === 'config') {
    const head =
      g.verdict === 'calibrated'
        ? yes('calibrated')
        : g.verdict === 'config'
          ? yes('set by hand')
          : g.verdict === 'stale'
            ? no('stale')
            : maybe(g.verdict ?? 'unknown')
    const cal = g.calibration
    const calLine =
      g.verdict === 'config'
        ? 'guard.tau is set in the config, so neither the manifest nor a calibration gates'
        : cal.stale === false
          ? `${cal.file} — measured for this index${g.pendingInline ? ', not inlined yet' : ''}`
          : `${cal.file} — ${cal.reason}`
    blocks.push([
      'guard',
      [
        `${head}  ${[`tau ${g.tau ?? '—'}`, g.tauLexical != null ? `tauLexical ${g.tauLexical}` : null, `source ${g.source ?? '—'}`].filter(Boolean).join(sep)}`,
        `mode ${GUARD_MODE[g.mode] ?? g.mode}`,
        c.muted(calLine),
      ].join('\n'),
    ])
  }

  const e = s.evalSets
  const setLines: Array<[string, string]> = []
  const golden = e.golden
  setLines.push([
    'golden',
    golden.exists
      ? [
          [`${count(golden.records)} records`, expectCounts(golden.byExpect, sep), golden.invalid ? c.fail(`${golden.invalid} unreadable`) : null].filter(Boolean).join(sep),
          counts(golden.byLevel, sep),
          counts(golden.bySplit, sep),
        ]
          .filter(Boolean)
          .join('\n')
      : c.warn('none'),
  ])
  setLines.push(['chains', e.chains.exists ? [`${count(e.chains.records)} chains`, `${count(e.chains.turns)} turns`].join(sep) : c.muted('none')])
  setLines.push([
    'adversarial',
    e.adversarial.exists ? [`${count(e.adversarial.records)} records`, expectCounts(e.adversarial.byExpect, sep), counts(e.adversarial.bySplit, sep)].filter(Boolean).join(sep) : c.muted('none'),
  ])
  setLines.push([
    'calibration',
    e.calibration.exists
      ? [
          `${count(e.calibration.records)} probes`,
          counts(
            e.calibration.byStratum && Object.fromEntries(Object.entries(e.calibration.byStratum).sort((a, b) => (b[1] as number) - (a[1] as number))),
            sep,
            6,
          ),
        ]
          .filter(Boolean)
          .join(sep)
      : c.muted('none'),
  ])
  blocks.push(['eval sets', kv(setLines, { indent: 0 }).join('\n')])

  const l = s.lastEval
  if (!l) {
    blocks.push(['last eval', c.muted('none yet')])
  } else {
    const rows = l.metrics.map((m) => ({ ...m, fmt: SCORECARD.find((r) => r.key === m.key)?.fmt ?? 'ratio' }))
    blocks.push([
      'last eval',
      [
        [l.model, l.level, l.records != null ? `${count(l.records)} records` : null, `${duration(l.ageMs)} ago`].filter(Boolean).join(sep),
        l.forCurrentIndex ? `index ${l.indexHash} ${c.ok(sym.ok)}` : c.warn(`index ${l.indexHash} — not the index on disk${i.hash ? ` (${i.hash})` : ''}`),
        c.muted(
          l.previous
            ? `Δ against the comparable run of ${l.previous.ranAt.slice(0, 16).replace('T', ' ')} UTC`
            : 'Δ — no earlier comparable run on this index',
        ),
        ...renderScorecard(rows, { ui: view, trend: true, summary: { hallucinated: l.hardGates.hallucinated, scopeContainment: l.hardGates.scopeContainment }, indent: 0 }),
      ].join('\n'),
    ])
  }

  const sv = s.server
  if (!sv.configured) {
    blocks.push(['server', c.muted(`not configured — runtime ${p.runtime}; --url reaches a running server`)])
  } else if (!sv.reachable) {
    blocks.push(['server', [no(`${sv.url} — ${sv.error}`), c.muted('npx docpilot serve starts it')].join('\n')])
  } else {
    const served =
      sv.indexMatches === true
        ? `index ${sv.manifest.hash} ${c.ok(sym.ok)}`
        : sv.indexMatches === false
          ? c.warn(`serves index ${sv.manifest.hash}, the disk holds ${i.hash} — restart serve`)
          : sv.error
            ? c.warn(sv.error)
            : null
    const mt = sv.metrics
    const metricsLine = mt
      ? [
          `turns ${count(mt.turns?.total)}`,
          `p50 ${duration(mt.latencyMs?.p50)}`,
          `p95 ${duration(mt.latencyMs?.p95)}`,
          `errors ${count(mt.turns?.byOutcome?.error)}`,
        ].join(sep)
      : c.muted(sv.metricsStatus === 'unavailable' ? 'metrics unavailable' : (sv.metricsError ?? 'metrics unavailable'))
    blocks.push(['server', [[yes(sv.url), `${sv.roundTripMs}ms`, served].filter(Boolean).join(sep), metricsLine].join('\n')])
  }

  const n = s.next
  blocks.push([
    'next',
    [
      c.accent(`${sym.pointer} ${n.command}`),
      `  ${n.why}`,
      ...n.then.map((t) => c.muted(`  then ${t.command} — ${t.why}`)),
    ].join('\n'),
  ])

  return [
    '',
    `  ${c.bold(p.product || 'DocPilot')} ${c.muted('status')}`,
    '',
    ...kv(blocks, { keyWidth: 10, key: (k) => c.bold(k) }),
    '',
  ]
}

// ── the command ──────────────────────────────────────────────────────────────

/**
 * A write that has reached the OS before the launcher's `process.exit` runs.
 * `--json` is tens of kilobytes, and a pipe is not guaranteed to take that in
 * one synchronous write. A stand-in stream with no events is written plainly.
 */
const emit = (stream, text: string) =>
  new Promise<void>((resolve) => {
    if (typeof stream?.once !== 'function') {
      stream.write(text)
      resolve()
    } else stream.write(text, () => resolve())
  })

/**
 * `run*` contract: flags of its own, a code back, nothing exited.
 *
 * ALWAYS 0 when it ran. A stale index is a finding, not a failure of this
 * command — `doctor` is the readiness gate a CI job exits on, and two gates
 * over one state is how an author learns to ignore one of them. A script that
 * wants a verdict reads `next.rule` out of `--json`.
 */
export async function runStatus({
  docPilot,
  argv = [],
  env = process.env,
  configPath = null,
  root = process.cwd(),
  stdout = process.stdout,
  fetch: fetchImpl = globalThis.fetch,
}: {
  docPilot: any
  argv?: string[]
  env?: Env
  configPath?: string | null
  root?: string
  stdout?: any
  fetch?: typeof fetch
}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${helpFor('status')}\n`)
    return OK
  }
  const [bad] = flagErrors('status', argv)
  if (bad) {
    console.error(`[docpilot] ${bad}`)
    return USAGE
  }
  let status
  try {
    status = await collectStatus({ docPilot, configPath, root, env, url: flagValue('status', argv, 'url'), fetch: fetchImpl })
  } catch (e) {
    printError(e?.message || String(e), e, env)
    return e?.usage ? USAGE : FAILED
  }
  if (flagGiven('status', argv, 'json')) {
    await emit(stdout, `${JSON.stringify(status, null, 2)}\n`)
    return OK
  }
  await emit(stdout, `${renderStatus(status, ui(stdout, env)).join('\n')}\n`)
  return OK
}
