import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { DEFAULT_SERVER_ORIGIN, fetchMetrics, parseInterval, renderMetrics, runMonitor, serverEndpoint } from '../src/cli-monitor.js'
import { palette, stripAnsi, symbols } from '../src/cli-ui.js'
import { createMetrics } from '../src/server/metrics.js'

/**
 * `docpilot monitor` — engine-spec 030.
 *
 * The endpoint it reads (spec 031) is built elsewhere, so the shape is held
 * here by a fake server on port 0 that answers exactly what the spec says —
 * and by a rendering of one fixed snapshot, line for line, at 80 columns.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(ROOT, 'bin/docpilot.js')

const SNAPSHOT = {
  kind: 'docpilot.metrics',
  v: 1,
  startedAt: '2026-10-25T10:00:00.000Z',
  now: '2026-10-25T12:03:04.000Z',
  uptimeS: 7384,
  model: 'qwen3:8b',
  embedModel: 'bge-m3',
  index: { hash: '8f551919', chunks: 672 },
  turns: {
    total: 1204,
    inFlight: 2,
    byOutcome: { answer: 812, opener: 130, refused: 80, 'not-answerable': 60, social: 35, credential: 2, results: 30, error: 12, aborted: 10, 'rate-limited': 3 },
  },
  latencyMs: { p50: 1800, p95: 4200, p99: 7900, count: 1180 },
  ttftMs: { p50: 420, p95: 1100, p99: 2000, count: 1100 },
  stagesMs: { embed: { p50: 35, p95: 80 }, retrieve: { p50: 12, p95: 30 }, rerank: null, model: { p50: 1600, p95: 3900 } },
  requests: { chat: 1400, embed: 1150, rerank: 0 },
  tokens: { prompt: 2_100_000, output: 310_000, cached: 1_400_000 },
  cache: { embedHits: 900, embedMisses: 250, answerHits: 30, answerMisses: 220 },
  limits: { rateLimited: 3, rejected: 1 },
  perMinute: [0, 1, 2, 4, 6, 9, 12, 15, 18, 22, 24, 21, 17, 14, 12, 10, 8, 9, 11, 13, 16, 19, 22, 20, 17, 14, 11, 8, 6, 12],
}

const view = (color) => ({ color, unicode: true, width: 80, c: palette(color), sym: symbols(true) })

describe('renderMetrics — one snapshot, drawn', () => {
  const opts = { url: 'http://localhost:8787/ai/turn', clock: '12:03:04', intervalMs: 2000, live: true }

  it('draws a fixed snapshot line for line, colour off', () => {
    expect(renderMetrics(SNAPSHOT, { ui: view(false), ...opts })).toEqual([
      '  docpilot monitor  http://localhost:8787/ai/turn',
      '  model qwen3:8b · embed bge-m3 · index 8f551919 (672 chunks) · up 2h 03m',
      '',
      '  turns         1,204 total · 2 in flight',
      '  per minute    ▁▁▂▂▃▄▅▅▆▇█▇▆▅▅▄▃▄▄▅▆▇▇▇▆▅▄▃▃▅  12 now · peak 24',
      '  latency       p50 1.8s · p95 4.2s · p99 7.9s  (1,180 turns)',
      '  first token   p50 420ms · p95 1.1s · p99 2.0s',
      '  stages p50    embed 35ms · retrieve 12ms · rerank — · model 1.6s',
      '  stages p95    embed 80ms · retrieve 30ms · rerank — · model 3.9s',
      '',
      '  outcomes',
      '    answer          █████████████▉        812  69.2%',
      '    opener          ██▎                   130  11.1%',
      '    refused         █▍                     80   6.8%',
      '    not-answerable  █                      60   5.1%',
      '    social          ▋                      35   3.0%',
      '    credential                              2   0.2%',
      '    results         ▌                      30   2.6%',
      '    error           ▎                      12   1.0%',
      '    aborted         ▏                      10   0.9%',
      '    rate-limited                            3   0.3%',
      '',
      '  errors        12 errors · 3 rate-limited · 1 rejected',
      '  tokens        prompt 2.1M · output 310k · cached 1.4M  (66.7% of prompt)',
      '  cache         embed 78.3% hit (900 of 1,150) · answers 12.0% hit (30 of 250)',
      '  requests      chat 1,400 · embed 1,150 · rerank 0',
      '',
      '  polled 12:03:04 · every 2s · q quits',
    ])
  })

  it('draws the same thing with colour on, escapes aside', () => {
    const plain = renderMetrics(SNAPSHOT, { ui: view(false), ...opts })
    const coloured = renderMetrics(SNAPSHOT, { ui: view(true), ...opts })
    expect(coloured.join('\n')).toContain('\x1b[')
    expect(coloured.map(stripAnsi)).toEqual(plain)
  })

  it('fits every line in 80 columns', () => {
    for (const line of renderMetrics(SNAPSHOT, { ui: view(false), ...opts })) {
      expect([...line].length, line).toBeLessThanOrEqual(80)
    }
  })

  /** A server that has answered no turn yet has no p95 — and an older one sends half the shape. */
  it('renders every missing or null field as —, and does not throw', () => {
    const empty = renderMetrics({ kind: 'docpilot.metrics', v: 1, turns: { total: null } }, { ui: view(false) }).join('\n')
    expect(empty).toContain('turns         — total · — in flight')
    expect(empty).toContain('p50 — · p95 — · p99 —')
    expect(empty).toContain('answer')
    expect(empty).toContain('model — · embed — · index — · up —')
    expect(renderMetrics({}, { ui: view(false) }).length).toBeGreaterThan(5)
  })

  /**
   * THE REAL PRODUCER, not only the fixture: `createMetrics()` is what the
   * server answers `/metrics?format=json` with, fed the facts the server
   * passes it. Whatever it emits — a fresh server with no turns, or a busy
   * one — has to draw.
   */
  it('draws what the server\'s own metrics module emits, busy or fresh', () => {
    let t = Date.parse('2026-10-25T12:00:00Z')
    const metrics = createMetrics({ now: () => t })
    const facts = { model: 'qwen3:8b', embedModel: 'bge-m3', index: { hash: 'abcd1234', chunks: 10 } }

    const fresh = renderMetrics(metrics.snapshot(facts), { ui: view(false) }).join('\n')
    expect(fresh).toContain('turns         0 total · 0 in flight')
    expect(fresh).toContain('latency       p50 — · p95 — · p99 —  (0 turns)')

    const timing = { totalMs: 1800, firstTokenMs: 400, embedMs: 30, retrieveMs: 10, modelMs: 1500, embedRequests: 1 }
    metrics.turn({ outcome: 'answer', timing, requests: 2, usage: { promptTokens: 1000, outputTokens: 200, cachedTokens: 500 } })
    metrics.turn({ outcome: 'refused', timing: { ...timing, totalMs: 20, firstTokenMs: undefined, modelMs: undefined } })
    metrics.cacheHit('embed')
    metrics.cacheMiss('embed')
    metrics.limited('rate')
    t += 60_000
    const busy = renderMetrics(metrics.snapshot(facts), { ui: view(false) }).join('\n')
    expect(busy).toContain('model qwen3:8b · embed bge-m3 · index abcd1234 (10 chunks) · up 1m 00s')
    expect(busy).toContain('turns         2 total · 0 in flight')
    expect(busy).toContain('first token   p50 400ms')
    expect(busy).toMatch(/answer +█+ +1  50\.0%/)
    expect(busy).toContain('errors        0 errors · 1 rate-limited · 0 rejected')
    expect(busy).toContain('cache         embed 50.0% hit (1 of 2) · answers —')
    expect(busy).toContain('tokens        prompt 1.0k · output 200 · cached 500  (50.0% of prompt)')
  })

  it('says why there is no snapshot rather than drawing an empty one', () => {
    const lines = renderMetrics(null, { ui: view(false), error: 'http://x is not reachable — ECONNREFUSED' })
    expect(lines.join('\n')).toContain('✖ http://x is not reachable — ECONNREFUSED')
    expect(lines.join('\n')).toContain('no snapshot yet')
  })
})

describe('where the server is', () => {
  const docPilot = { server: { endpoint: '/ai/turn' } }

  it('defaults to the configured endpoint on localhost:8787, which is what serve runs', () => {
    expect(DEFAULT_SERVER_ORIGIN).toBe('http://localhost:8787')
    expect(serverEndpoint(null, docPilot)).toBe('http://localhost:8787/ai/turn')
    expect(serverEndpoint(null, { server: { endpoint: '/chat/' } })).toBe('http://localhost:8787/chat')
  })

  it('takes a whole endpoint as given, and gives an origin the configured path', () => {
    expect(serverEndpoint('https://docs.example.com/api/ai/', docPilot)).toBe('https://docs.example.com/api/ai')
    expect(serverEndpoint('http://127.0.0.1:9000', docPilot)).toBe('http://127.0.0.1:9000/ai/turn')
  })

  /**
   * `localhost:8787` PARSES — as the scheme "localhost:" — so the check is on
   * the scheme, not on whether `new URL` threw.
   */
  it('refuses anything but an http(s) URL, as a usage error', () => {
    for (const bad of ['not a url', 'localhost:8787', 'ftp://example.com']) {
      let error
      try {
        serverEndpoint(bad, docPilot)
      } catch (e) {
        error = e
      }
      expect(error?.usage, bad).toBe(true)
      expect(error.message).toContain(`--url="${bad}" is not an http(s) URL`)
    }
  })

  it('reads an interval the way people write one, and refuses a load test', () => {
    expect(parseInterval(undefined)).toBe(2000)
    expect(parseInterval('2s')).toBe(2000)
    expect(parseInterval('500ms')).toBe(500)
    expect(parseInterval('1.5s')).toBe(1500)
    expect(parseInterval('1m')).toBe(60_000)
    expect(parseInterval('3')).toBe(3000)
    expect(parseInterval('100ms')).toBeNull()
    expect(parseInterval('soon')).toBeNull()
  })
})

/** The spec-031 endpoint, faked: `/ai/turn` with a token, `/old` from before /metrics existed. */
let server
let base
const seen = []
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ path: url.pathname, query: url.search, auth: req.headers.authorization ?? null })
    if (url.pathname === '/ai/turn/metrics' && url.searchParams.get('format') === 'json') {
      if (req.headers.authorization !== 'Bearer s3cret') {
        res.statusCode = 401
        return res.end('{"error":"unauthorized"}')
      }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(SNAPSHOT))
    }
    if (url.pathname === '/open/metrics') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(SNAPSHOT))
    }
    if (url.pathname === '/other/metrics') {
      res.setHeader('content-type', 'application/json')
      return res.end('{"kind":"prometheus.text"}')
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

describe('fetchMetrics — one poll, never a throw', () => {
  it('reads the snapshot, sending the token as a bearer and asking for JSON', async () => {
    const r = await fetchMetrics(`${base}/ai/turn`, { token: 's3cret' })
    expect(r.ok).toBe(true)
    expect(r.snapshot).toEqual(SNAPSHOT)
    const last = seen.at(-1)
    expect(last).toEqual({ path: '/ai/turn/metrics', query: '?format=json', auth: 'Bearer s3cret' })
  })

  it('names the token when the server refuses without one', async () => {
    const r = await fetchMetrics(`${base}/ai/turn`)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.error).toMatch(/--token, or set DOCPILOT_METRICS_TOKEN/)
  })

  /** A server from before spec 031 has no /metrics; that is a state, not a crash. */
  it('says "metrics unavailable" for a server with no /metrics', async () => {
    const r = await fetchMetrics(`${base}/old`)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    expect(r.error).toMatch(/^metrics unavailable/)
  })

  it('refuses a snapshot that names some other kind', async () => {
    const r = await fetchMetrics(`${base}/other`)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a docpilot\.metrics snapshot/)
  })

  it('reports a server that is not there as unreachable', async () => {
    const r = await fetchMetrics('http://127.0.0.1:9', { timeoutMs: 1000 })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
    expect(r.error).toMatch(/is not reachable/)
  })
})

/** A stand-in stdout: what was written, and whether it is a terminal. */
const fakeOut = (isTTY) => {
  const out = { isTTY, columns: 100, rows: 0, text: '', write(s) {
    out.text += s
    return true
  } }
  return out
}

describe('runMonitor', () => {
  const docPilot = { server: { endpoint: '/ai/turn' } }
  const fetchOk = async () => new Response(JSON.stringify(SNAPSHOT), { headers: { 'content-type': 'application/json' } })

  it('prints one JSON line per poll off a terminal — a log, not a picture', async () => {
    const stdout = fakeOut(false)
    const code = await runMonitor({ docPilot, argv: [], env: {}, stdout, fetch: fetchOk, sleep: async () => {}, maxPolls: 2 })
    expect(code).toBe(0)
    const lines = stdout.text.trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(JSON.parse(line)).toEqual(SNAPSHOT)
    expect(stdout.text).not.toContain('\x1b')
  })

  it('polls once with --once, even on a terminal, and exits on what it found', async () => {
    const stdout = fakeOut(true)
    expect(await runMonitor({ docPilot, argv: ['--once'], env: {}, stdout, fetch: fetchOk })).toBe(0)
    expect(JSON.parse(stdout.text)).toEqual(SNAPSHOT)

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = async () => new Response('', { status: 404 })
    expect(await runMonitor({ docPilot, argv: ['--once'], env: {}, stdout: fakeOut(false), fetch: refused })).toBe(1)
    expect(err.mock.calls.join(' ')).toMatch(/metrics unavailable/)
    err.mockRestore()
  })

  it('takes the token from the environment when no flag gives one', async () => {
    let auth = null
    const fetch = async (_url, init) => {
      auth = init.headers.authorization
      return fetchOk()
    }
    await runMonitor({ docPilot, argv: ['--once'], env: { DOCPILOT_METRICS_TOKEN: 'from-env' }, stdout: fakeOut(false), fetch })
    expect(auth).toBe('Bearer from-env')
    await runMonitor({ docPilot, argv: ['--once', '--token=from-flag'], env: { DOCPILOT_METRICS_TOKEN: 'from-env' }, stdout: fakeOut(false), fetch })
    expect(auth).toBe('Bearer from-flag')
  })

  it('refuses a bad interval and a bad URL as usage errors', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runMonitor({ docPilot, argv: ['--interval=fast'], stdout: fakeOut(false), fetch: fetchOk })).toBe(2)
    expect(await runMonitor({ docPilot, argv: ['--url=not a url'], stdout: fakeOut(false), fetch: fetchOk })).toBe(2)
    expect(await runMonitor({ docPilot, argv: ['--intervall=2s'], stdout: fakeOut(false), fetch: fetchOk })).toBe(2)
    err.mockRestore()
  })

  /** On a terminal: frames redrawn in place, `q` quits, and the terminal comes back cooked. */
  it('redraws in place on a terminal until q, and restores the terminal', async () => {
    const stdin = new PassThrough()
    stdin.isTTY = true
    stdin.isRaw = false
    stdin.setRawMode = (on) => {
      stdin.isRaw = on
      return stdin
    }
    const stdout = fakeOut(true)
    let polls = 0
    const fetch = async () => {
      polls++
      if (polls === 2) setTimeout(() => stdin.write('q'), 5)
      return fetchOk()
    }
    const code = await runMonitor({
      docPilot,
      argv: ['--interval=250ms'],
      env: {},
      stdin,
      stdout,
      fetch,
      sleep: () => new Promise((r) => setTimeout(r, 20)),
    })
    expect(code).toBe(0)
    expect(stdin.isRaw).toBe(false)
    expect(polls).toBeGreaterThanOrEqual(2)
    // The second frame is drawn over the first, not under it.
    expect(stdout.text).toMatch(/\x1b\[\d+A\r\x1b\[J/)
    expect(stripAnsi(stdout.text)).toContain('q quits')
  })
})

/**
 * The command as a reader runs it — piped, from a directory with no project,
 * against the fake server. Spawned ASYNCHRONOUSLY: the server lives in this
 * process, and a synchronous spawn would stop the loop that has to answer it.
 */
describe('docpilot monitor --once, spawned', () => {
  // Neither colour switch inherited: what is asserted is the piped default.
  const env = { ...process.env }
  delete env.FORCE_COLOR
  delete env.NO_COLOR
  const run = (args, cwd) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, 'monitor', ...args], { cwd, env }, (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr }),
      )
    })

  it('prints one parsable docpilot.metrics line and exits 0', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-monitor-'))
    try {
      const r = await run(['--once', `--url=${base}/ai/turn`, '--token=s3cret'], cwd)
      expect(r.code).toBe(0)
      const lines = r.stdout.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]).kind).toBe('docpilot.metrics')
      expect(`${r.stdout}${r.stderr}`).not.toContain('\x1b')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('exits 1 with the reason on stderr when the server has no /metrics', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-monitor-'))
    try {
      const r = await run(['--once', `--url=${base}/old`], cwd)
      expect(r.code).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toMatch(/metrics unavailable/)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
