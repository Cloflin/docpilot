import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'

import { collectStatus, comparableRuns, corpusOf, nextStep, renderStatus } from '../src/cli-status.js'
import { HOME_ACTIONS, homeChoices } from '../src/cli-home.js'
import { previousReport } from '../src/eval/report.js'
import { splitOf } from '../src/eval/levels.js'
import { resolveDocPilot } from '../src/config.js'
import { palette, stripAnsi, symbols } from '../src/cli-ui.js'
import { COMMANDS } from '../src/cli-flags.js'

/**
 * `docpilot status` — engine-spec 030.
 *
 * Scratch projects, indexed by the REAL `docpilot index` — lexical-only and
 * with the openers off, so the build needs no key, no network and no model —
 * because the one claim this command makes that matters most is "fresh", and
 * that claim is only as good as its agreement with the build.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(ROOT, 'bin/docpilot.js')

// Neither colour switch inherited: every spawn below is asserted piped.
const ENV = { ...process.env }
delete ENV.FORCE_COLOR
delete ENV.NO_COLOR

const SETTINGS = { product: 'Acme', embed: false, suggestions: { precomputed: false } }
const CONFIG = `export const docPilot = ${JSON.stringify(SETTINGS)}\n`
const PAGES = {
  'docs/guide/install.md':
    '# Install\n\nInstall Acme with npm. Run `npm install acme` in the project root, then import the widget.\n\n' +
    '## Configure the widget\n\nPass a `theme` option to choose light or dark, and a `lang` option for the interface.\n',
  'docs/guide/billing.md':
    '# Billing\n\nAcme bills monthly per seat. Invoices are sent on the first day of each month.\n\n' +
    '## Refunds\n\nA refund is issued within fourteen days of a cancelled subscription.\n',
}

const dirs = []
function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-status-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries({ 'docpilot.config.mjs': CONFIG, ...PAGES, ...files })) {
    if (body == null) continue
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const index = (dir) => {
  const r = spawnSync(process.execPath, [CLI, 'index', '--yes'], { cwd: dir, encoding: 'utf8', env: ENV })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(fs.readFileSync(path.join(dir, 'docs/public/rag/manifest.json'), 'utf8'))
}

const docPilot = resolveDocPilot(SETTINGS, {})
const status = (dir, opts = {}) =>
  collectStatus({ docPilot, configPath: 'docpilot.config.mjs', root: dir, env: {}, now: Date.parse('2026-10-25T12:00:00Z'), ...opts })

const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
const GOLDEN = jsonl([
  { id: 'q-01', level: 'low', question: 'How do I install Acme?', expect: 'answer', gold_chunks: ['guide/install#'], split: 'dev' },
  { id: 'q-02', level: 'medium', question: 'When are refunds issued?', expect: 'answer', gold_chunks: ['guide/billing#refunds'], split: 'test' },
  { id: 'q-03', question: 'How do I set the theme?', expect: 'answer', gold_chunks: ['guide/install#configure-the-widget'] },
  { id: 'n-01', level: 'low', question: 'What is the capital of Peru?', expect: 'refuse:no-evidence', gold_chunks: [] },
])

describe('the index block', () => {
  let dir
  let manifest
  beforeAll(() => {
    dir = project()
    manifest = index(dir)
  })

  /**
   * THE DERIVATION, HELD TO THE BUILD. `corpusOf` restates the indexer's
   * enumeration rather than importing it; this is the check that the restating
   * did not drift — the hash the real `docpilot index` wrote, recomputed.
   */
  it('re-derives exactly the hash docpilot index wrote', () => {
    expect(corpusOf(docPilot, dir).hash).toBe(manifest.hash)
  })

  it('calls an index built from the docs on disk fresh, and reads its figures', async () => {
    const s = await status(dir)
    expect(s.index).toMatchObject({
      dir: 'docs/public/rag',
      exists: true,
      hash: manifest.hash,
      chunks: manifest.chunkCount,
      pages: 2,
      embedModel: null,
      quant: 'none',
      fresh: true,
      docsHash: manifest.hash,
      reason: null,
    })
    expect(s.index.bytes).toBeGreaterThan(0)
    expect(s.index.brotliBytes).toBeGreaterThan(0)
    expect(s.index.brotliBytes).toBeLessThan(s.index.bytes)
  })

  it('calls it stale once a page changes, and says both hashes', async () => {
    const stale = project()
    const built = index(stale)
    fs.appendFileSync(path.join(stale, 'docs/guide/billing.md'), '\n## Taxes\n\nPrices exclude VAT, which is added at checkout.\n')
    const s = await status(stale)
    expect(s.index.fresh).toBe(false)
    expect(s.index.reason).toContain(built.hash)
    expect(s.index.reason).toContain(corpusOf(docPilot, stale).hash)
    expect(s.next.rule).toBe('stale-index')
    expect(s.next.argv).toEqual(['index'])
  })

  it('says there is no index, and that index is next', async () => {
    const s = await status(project())
    expect(s.index.exists).toBe(false)
    expect(s.index.reason).toBe('there is no index at docs/public/rag')
    expect(s.next.rule).toBe('no-index')
    expect(s.next.command).toBe('npx docpilot index')
  })

  /**
   * Pages under `importDir` are not re-chunked here — nor OpenAPI specs, nor a
   * `--html-dir` build — so a hash mismatch would not mean stale, and sending
   * somebody to rebuild on it could cost them the pages it cannot see.
   */
  it('reports an index it cannot re-derive as unverified, not stale', async () => {
    const withImports = project({ 'kb/their-guide.md': '# Guide\n\nText.\n' })
    index(withImports)
    const settings = { ...docPilot, importDir: 'kb' }
    const s = await collectStatus({ docPilot: settings, configPath: 'docpilot.config.mjs', root: withImports, env: {} })
    expect(s.index.exists).toBe(true)
    expect(s.index.fresh).toBeNull()
    expect(s.index.reason).toMatch(/the pages under kb\/, which status does not re-chunk/)
    expect(s.next.rule).not.toBe('stale-index')
  })
})

describe('the eval sets block', () => {
  /**
   * Counted where `eval` scores a record: an absent level at `high`, and an
   * absent split where `splitOf` assigns it by id — so the two halves printed
   * are the two halves `--split=dev` and `--split=test` will run.
   */
  it('counts each set by expect, split and level — where eval scores each record', async () => {
    const effective = {}
    for (const r of GOLDEN.trim().split('\n').map((l) => JSON.parse(l))) effective[splitOf(r)] = (effective[splitOf(r)] ?? 0) + 1
    const dir = project({
      'docpilot/golden.jsonl': GOLDEN + '{not json\n',
      'docpilot/chains.jsonl': jsonl([{ id: 'c-01', turns: [{ kind: 'base' }, { kind: 'relate' }] }, { id: 'c-02', turns: [{ kind: 'base' }] }]),
      'docpilot/calibration.jsonl': jsonl([
        { id: 'u-01', question: 'a', stratum: 'U' },
        { id: 'u-02', question: 'b', stratum: 'U' },
        { id: 'n-01', question: 'c', stratum: 'N1' },
      ]),
    })
    const { evalSets } = await status(dir)
    expect(evalSets.golden).toEqual({
      file: 'docpilot/golden.jsonl',
      exists: true,
      records: 4,
      invalid: 1,
      byExpect: { answer: 3, 'refuse:no-evidence': 1 },
      bySplit: effective,
      byLevel: { low: 2, medium: 1, high: 1 },
    })
    expect(evalSets.chains).toMatchObject({ exists: true, records: 2, turns: 3, byKind: { base: 2, relate: 1 } })
    expect(evalSets.calibration).toMatchObject({ records: 3, byStratum: { U: 2, N1: 1 }, bySplit: null })
    expect(evalSets.adversarial).toMatchObject({ exists: false, records: 0 })
  })
})

/** A report as `writeReport` leaves one: meta, summary, and nothing else that status reads. */
function writeReport(dir, name, meta, summary) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ meta, summary, diff: [], incomparable: [], rows: [] }))
}

describe('the last eval block', () => {
  let dir
  let manifest
  beforeAll(() => {
    dir = project({ 'docpilot/golden.jsonl': GOLDEN })
    manifest = index(dir)
  })
  const gateMeta = (over = {}) => ({
    model: '(gate only)',
    gateOnly: true,
    lexical: true,
    vectorlessIndex: true,
    indexHash: manifest.hash,
    embedModel: null,
    level: 'ultra',
    records: 4,
    ...over,
  })

  it('says none, and that a free gate-only run is next', async () => {
    const s = await status(dir)
    expect(s.lastEval).toBeNull()
    expect(s.next.rule).toBe('no-report')
    expect(s.next.argv).toEqual(['eval', '--gate-only'])
    expect(s.next.then.map((t) => t.argv)).toEqual([['eval']])
  })

  it('pairs the newest report with the one eval paired it with, and draws the history', async () => {
    const reports = path.join(dir, 'docpilot/reports')
    // Unstamped: it predates `ranAt`, so it is OLDER than everything stamped,
    // whatever its mtime says — a fresh clone gives every file the same one.
    writeReport(reports, 'report-00000000-_gate_only_-x.json', gateMeta({ indexHash: '00000000' }), { recall8: 0.5, mrr: 0.4 })
    writeReport(reports, 'report-11111111-_gate_only_-x.json', gateMeta({ indexHash: '11111111', ranAt: '2026-10-01T00:00:00Z' }), { recall8: 0.6, mrr: 0.5 })
    writeReport(reports, `history/report-${manifest.hash}-_gate_only_-x.2026-10-20.json`, gateMeta({ ranAt: '2026-10-20T00:00:00Z' }), { recall8: 0.7, mrr: 0.55, latencyP50: 0 })
    writeReport(reports, `report-${manifest.hash}-_gate_only_-x.json`, gateMeta({ ranAt: '2026-10-24T12:00:00Z' }), {
      recall8: 0.75,
      mrr: 0.5,
      latencyP50: 0,
      hallucinated: 0,
      scopeContainment: 1,
    })
    // A different kind of run on the same index: not its predecessor, not its history.
    writeReport(reports, `report-${manifest.hash}-qwen3_8b-x.json`, { ...gateMeta({ ranAt: '2026-10-22T00:00:00Z' }), model: 'qwen3:8b', gateOnly: false }, { recall8: 0.1 })

    const s = await status(dir)
    const l = s.lastEval
    expect(l.model).toBe('(gate only)')
    expect(l.ranAt).toBe('2026-10-24T12:00:00.000Z')
    expect(l.ageMs).toBe(24 * 3600 * 1000)
    expect(l.forCurrentIndex).toBe(true)
    expect(l.previous.file).toBe(`docpilot/reports/history/report-${manifest.hash}-_gate_only_-x.2026-10-20.json`)
    const recall = l.metrics.find((m) => m.key === 'recall8')
    expect(recall.value).toBe(0.75)
    expect(recall.delta).toBeCloseTo(0.05)
    expect(recall.better).toBe('higher')
    expect(recall.series).toEqual([0.5, 0.6, 0.7, 0.75])
    const mrr = l.metrics.find((m) => m.key === 'mrr')
    expect(mrr.delta).toBeCloseTo(-0.05)
    // A gate-only run scores no answer, so an answer-side zero is not a metric.
    expect(l.metrics.find((m) => m.key === 'latencyP50')).toBeUndefined()
    expect(l.hardGates).toEqual({ hallucinated: 0, scopeContainment: 1, passed: true })
    expect(l.forIndex).toEqual({ gateOnly: true, full: true, partial: false })
  })

  /**
   * The drift the restated rule would have shipped: two halves of one set on
   * one index, which `eval` never compares, read as a delta.
   */
  it('never pairs a run with one eval would not compare it with — another split', async () => {
    const split = project({ 'docpilot/golden.jsonl': GOLDEN })
    const m = index(split)
    const reports = path.join(split, 'docpilot/reports')
    const meta = (over) => ({ ...gateMeta({ indexHash: m.hash }), ...over })
    writeReport(reports, `report-${m.hash}-_gate_only_-dev.json`, meta({ split: 'dev', ranAt: '2026-10-23T00:00:00Z' }), { recall8: 0.2 })
    writeReport(reports, `report-${m.hash}-_gate_only_-test.json`, meta({ split: 'test', ranAt: '2026-10-24T00:00:00Z' }), { recall8: 0.9 })
    const s = await status(split)
    expect(s.lastEval.previous).toBeNull()
    expect(s.lastEval.metrics.find((x) => x.key === 'recall8').delta).toBeNull()
    expect(s.lastEval.runs).toBe(1)
  })

  it('moves next on to the whole set once only the gate has been measured', async () => {
    const only = project({ 'docpilot/golden.jsonl': GOLDEN })
    const m = index(only)
    writeReport(path.join(only, 'docpilot/reports'), `report-${m.hash}-_gate_only_-x.json`, gateMeta({ indexHash: m.hash, ranAt: '2026-10-24T00:00:00Z' }), { recall8: 1 })
    const s = await status(only)
    expect(s.next.rule).toBe('gate-only')
    expect(s.next.argv).toEqual(['eval'])
  })
})

/**
 * `previousReport` OWNS the pairing rule, and `comparableRuns` asks it rather
 * than restating it — the rule went from four checks to eight while this was
 * being written. Held here to the same answers over every axis it checks, so
 * a copy written later cannot drift unseen.
 */
describe('comparableRuns agrees with previousReport', () => {
  it('picks the same predecessor for every kind of run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-pair-'))
    dirs.push(dir)
    const base = { indexHash: 'abcd1234', model: 'qwen3:8b', level: 'ultra', lexical: false, vectorlessIndex: false, embedModel: 'bge-m3' }
    const variants = [
      { ...base },
      { ...base, lexical: true },
      { ...base, vectorlessIndex: true, lexical: true },
      { ...base, level: 'low' },
      { ...base, embedModel: 'nomic-embed-text' },
      { ...base, embedModel: undefined },
      { ...base, runtime: 'server' },
      { ...base, split: 'dev' },
      { ...base, split: 'test' },
      { ...base, set: 'adversarial' },
      { ...base, runtime: 'server', serverTurn: { loop: 'one-shot' } },
    ]
    variants.forEach((meta, i) => {
      const file = path.join(dir, `report-abcd1234-qwen3_8b-${i}.json`)
      fs.writeFileSync(file, JSON.stringify({ meta, summary: { recall8: i } }))
      fs.utimesSync(file, 1_700_000_000 + i, 1_700_000_000 + i)
    })
    const ours = (meta) =>
      variants
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => comparableRuns(m, meta))?.i ?? null
    for (const meta of variants) {
      const theirs = previousReport(dir, meta)
      expect(theirs?.summary.recall8 ?? null, JSON.stringify(meta)).toBe(ours(meta))
    }
  })
})

/** A hand-built status, so each rule can be fired on its own. */
function shaped(over = {}) {
  const s = {
    project: { config: 'docpilot.config.mjs', runtime: 'browser' },
    index: { exists: true, fresh: true, hash: 'abcd1234', dir: 'docs/public/rag', reason: null },
    guard: { mode: 'off', enforced: false, verdict: 'calibrated', pendingInline: false, calibration: { file: 'docpilot/calibration.json', stale: false, reason: null } },
    evalSets: { golden: { file: 'docpilot/golden.jsonl', exists: true, records: 4 } },
    lastEval: { goldenChanged: false, forIndex: { gateOnly: true, full: true, partial: false } },
    server: { configured: false },
  }
  for (const [k, v] of Object.entries(over)) s[k] = { ...s[k], ...v }
  return s
}

describe('the next rules, in the order the loop runs', () => {
  const rule = (over) => nextStep(shaped(over))

  it('asks for a config before anything else', () => {
    expect(rule({ project: { config: null } })).toMatchObject({ rule: 'no-config', argv: ['init'] })
  })

  it('asks for an index, and for a fresh one', () => {
    expect(rule({ index: { exists: false, reason: 'there is no index at x' } }).rule).toBe('no-index')
    expect(rule({ index: { fresh: false, reason: 'changed' } })).toMatchObject({ rule: 'stale-index', argv: ['index'] })
    // Unverified is not stale: it does not send anybody to rebuild.
    expect(rule({ index: { fresh: null } }).rule).toBe('measured')
  })

  it('inlines a calibration that was measured after the index was built', () => {
    expect(rule({ guard: { pendingInline: true } })).toMatchObject({ rule: 'guard-not-inlined', argv: ['index'] })
  })

  /** "guard not 'off' with stale/provisional calibration → calibrate". */
  it('sends an enforcing guard on unmeasured thresholds to calibrate, and leaves an off one alone', () => {
    const enforcing = { mode: 'calibrated', enforced: true, calibration: { stale: true, reason: 'nothing has measured the thresholds yet' } }
    expect(rule({ guard: { ...enforcing, verdict: 'provisional' } })).toMatchObject({ rule: 'stale-guard', argv: ['calibrate'] })
    expect(rule({ guard: { ...enforcing, verdict: 'stale' } }).rule).toBe('stale-guard')
    expect(rule({ guard: { verdict: 'provisional', calibration: { stale: true } } }).rule).toBe('measured')
    expect(rule({ guard: { ...enforcing, verdict: 'config' } }).rule).toBe('measured')
  })

  it('says there is no golden set', () => {
    expect(rule({ evalSets: { golden: { file: 'docpilot/golden.jsonl', exists: false, records: 0 } } })).toMatchObject({
      rule: 'no-golden',
      argv: ['init'],
    })
  })

  it('measures an index nothing has measured: the gate first, then the whole set', () => {
    const n = nextStep({ ...shaped(), lastEval: null })
    expect(n).toMatchObject({ rule: 'no-report', argv: ['eval', '--gate-only'], command: 'npx docpilot eval --gate-only' })
    expect(n.then).toEqual([{ argv: ['eval'], command: 'npx docpilot eval', why: 'the whole golden set, with the model answering' }])
    expect(rule({ lastEval: { forIndex: { gateOnly: false, full: false, partial: false } } }).rule).toBe('no-report')
  })

  it('then picks the most useful next measurement', () => {
    expect(rule({ lastEval: { forIndex: { gateOnly: true, full: false, partial: false } } })).toMatchObject({ rule: 'gate-only', argv: ['eval'] })
    expect(rule({ lastEval: { goldenChanged: true } })).toMatchObject({ rule: 'golden-changed', argv: ['eval'] })
    expect(rule({ lastEval: { forIndex: { gateOnly: true, full: false, partial: true } } })).toMatchObject({ rule: 'one-tier', argv: ['eval'] })
    expect(rule({})).toMatchObject({ rule: 'measured', argv: ['eval', '--level=low'] })
    // engine-spec 035: a measured index with failing records goes to the plan.
    expect(rule({ lastEval: { misses: 3 } })).toMatchObject({ rule: 'improve', argv: ['improve'] })
  })
})

describe('the server block', () => {
  let server
  let base
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      res.setHeader('content-type', 'application/json')
      if (url.pathname.endsWith('/manifest')) return res.end(JSON.stringify({ hash: 'abcd1234', chunkCount: 4 }))
      if (url.pathname === '/ai/turn/metrics') return res.end(JSON.stringify({ kind: 'docpilot.metrics', v: 1, turns: { total: 7 } }))
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  it('reaches nothing when there is nothing to reach', async () => {
    const s = await status(project())
    expect(s.server).toMatchObject({ configured: false, url: null, reachable: null })
  })

  it('reads the manifest and the metrics of a server it is pointed at', async () => {
    const s = await status(project(), { url: base })
    expect(s.server).toMatchObject({
      configured: true,
      url: `${base}/ai/turn`,
      reachable: true,
      status: 200,
      manifest: { hash: 'abcd1234', chunkCount: 4 },
      metricsStatus: 'ok',
    })
    expect(s.server.metrics.turns.total).toBe(7)
    expect(typeof s.server.roundTripMs).toBe('number')
  })

  it('says "metrics unavailable" for a server from before /metrics', async () => {
    const s = await status(project(), { url: `${base}/legacy` })
    expect(s.server.reachable).toBe(true)
    expect(s.server.metricsStatus).toBe('unavailable')
    expect(renderStatus(s, view(false)).join('\n')).toContain('metrics unavailable')
  })

  it('says a server that is down is down', async () => {
    const s = await status(project(), { url: 'http://127.0.0.1:9', timeoutMs: 1000 })
    expect(s.server.reachable).toBe(false)
    expect(s.server.error).toBeTruthy()
  })
})

const view = (color) => ({ color, unicode: true, width: 80, c: palette(color), sym: symbols(true) })

describe('renderStatus', () => {
  it('draws every block, and the same picture with colour on, escapes aside', async () => {
    const dir = project({ 'docpilot/golden.jsonl': GOLDEN })
    index(dir)
    const s = await status(dir)
    const plain = renderStatus(s, view(false))
    const text = plain.join('\n')
    for (const label of ['project', 'index', 'guard', 'eval sets', 'last eval', 'server', 'next']) {
      expect(text, label).toMatch(new RegExp(`^  ${label} `, 'm'))
    }
    expect(text).toContain('✔ fresh')
    expect(text).toContain('❯ npx docpilot eval --gate-only')
    expect(text).not.toContain('\x1b')
    expect(renderStatus(s, view(true)).map(stripAnsi)).toEqual(plain)
  })
})

describe('the home screen', () => {
  it('offers the next step first, then what exists, and a way out last', async () => {
    const s = shaped()
    const commands = ['index', 'calibrate', 'lint', 'eval', 'doctor', 'serve', 'monitor']
    const choices = homeChoices({ ...s, next: nextStep({ ...s, lastEval: null }) }, commands)
    expect(choices.map((c) => c.label)).toEqual(['eval --gate-only', 'eval', 'index', 'calibrate', 'lint', 'doctor', 'quit'])
    expect(choices[0].hint).toMatch(/^next — /)
    expect(choices.at(-1).value).toBeNull()
  })

  it('offers a command only when the launcher has it — the hook a new command plugs into', () => {
    const s = { ...shaped(), next: nextStep(shaped()) }
    HOME_ACTIONS.improve = [{ argv: ['improve'], hint: 'test entry' }]
    try {
      expect(homeChoices(s, ['eval', 'lint']).map((c) => c.label)).not.toContain('improve')
      expect(homeChoices(s, ['eval', 'lint', 'improve']).map((c) => c.label)).toContain('improve')
    } finally {
      delete HOME_ACTIONS.improve
    }
  })

  it('offers serve and monitor only to a project on the server runtime', () => {
    const commands = ['serve', 'monitor', 'eval']
    const browser = { ...shaped(), next: nextStep(shaped()) }
    expect(homeChoices(browser, commands).map((c) => c.label)).not.toContain('monitor')
    const server = { ...browser, project: { ...browser.project, runtime: 'server' } }
    expect(homeChoices(server, commands).map((c) => c.label)).toEqual(expect.arrayContaining(['serve', 'monitor']))
  })
})

/**
 * `index --dry` printed each of four set-equal warnings four times on this
 * repository. A table over the chunk ceiling is split once per overflow and
 * warned once per split, which is the same repeat, built on purpose.
 */
describe('index — one line per distinct warning', () => {
  it('prints a repeated warning once, with ×N', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| option-${i} | what the ${i}th option changes for the reader, in a sentence |`)
    const dir = project({ 'docs/reference/big.md': `# Options\n\n## All of them\n\n| option | what |\n|---|---|\n${rows.join('\n')}\n` })
    const r = spawnSync(process.execPath, [CLI, 'index', '--dry'], { cwd: dir, encoding: 'utf8', env: ENV })
    expect(r.status, r.stderr).toBe(0)
    const lines = r.stderr.split('\n').filter((l) => l.includes('table split at row boundaries'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^ {2}warn {2}table split at row boundaries by MAX_CHUNK_CHARS in \/reference\/big {2}×\d+$/)
    expect(Number(lines[0].split('×')[1])).toBeGreaterThan(1)
    // Said above the corpus figures, where the build always said it.
    expect(`${r.stdout}`).not.toContain('table split')
  })
})

describe('docpilot status, spawned', () => {
  const run = (args, cwd = ROOT) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: ENV })

  it('prints one docpilot.status object with --json, and exits 0', () => {
    const dir = project({ 'docpilot/golden.jsonl': GOLDEN })
    index(dir)
    const r = run(['status', '--json'], dir)
    expect(r.status).toBe(0)
    const s = JSON.parse(r.stdout)
    expect(s.kind).toBe('docpilot.status')
    expect(s.v).toBe(1)
    expect(Object.keys(s)).toEqual(['kind', 'v', 'project', 'index', 'guard', 'evalSets', 'lastEval', 'server', 'next'])
    expect(s.index.fresh).toBe(true)
    expect(s.next.rule).toBe('no-report')
  })

  /**
   * ESCAPES IN A LOG ARE THE CLASSIC FAILURE, so it is asserted where it would
   * happen: every new writer, spawned with pipes, with neither colour switch set.
   */
  it('writes no escape at all when piped — status, its help, and the global help', () => {
    for (const args of [['status'], ['status', '--help'], ['monitor', '--help'], ['--help'], ['help']]) {
      const r = run(args)
      expect(r.status, args.join(' ')).toBe(0)
      expect(`${r.stdout}${r.stderr}`, args.join(' ')).not.toContain('\x1b')
    }
  })

  it('writes no escape in any command, piped — every help, and the commands that draw progress', () => {
    for (const command of Object.keys(COMMANDS)) {
      const r = run([command, '--help'])
      expect(`${r.stdout}${r.stderr}`, `${command} --help`).not.toContain('\x1b')
    }
    // Free and offline: chunking only, and the golden set against the index.
    for (const args of [['index', '--dry'], ['lint']]) {
      const r = run(args)
      expect(`${r.stdout}${r.stderr}`, args.join(' ')).not.toContain('\x1b')
      expect(`${r.stdout}${r.stderr}`, args.join(' ')).not.toContain('\r')
    }
  })

  it('reports this repository, offline, without failing', () => {
    const r = run(['status', '--json'])
    expect(r.status).toBe(0)
    const s = JSON.parse(r.stdout)
    expect(s.project.config).toBe('docs/.vitepress/config.mjs')
    expect(s.index.exists).toBe(true)
    expect(s.server.configured).toBe(false)
  })
})
