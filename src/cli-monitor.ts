/**
 * `docpilot monitor` — a running server, watched. engine-spec 030.
 *
 * WHY IT EXISTS. Spec 028 put the turn on the owner's server and wrote a turn
 * log, and nothing showed what the server was doing while it ran: latency,
 * first-token time, outcomes, errors, rate-limited turns. The log answers that
 * question tomorrow; this answers it now.
 *
 * WHAT IT READS. `GET {endpoint}/metrics?format=json`, one `docpilot.metrics`
 * snapshot per poll — spec 031's shape. Every field may be null or missing: a
 * server that has answered no turns yet has no p95, and an older one has no
 * `/metrics` at all. Each one renders as `—` rather than as a zero nobody
 * measured.
 *
 * TWO OUTPUTS, ONE COMMAND. On a terminal it redraws one block in place and
 * `q` quits. Off a terminal, or with `--once`, it prints each snapshot as ONE
 * JSON line, unchanged — so `docpilot monitor >> metrics.jsonl` is a log, and
 * `--once` is a probe a script can gate on.
 */
import { FAILED, OK, USAGE } from './cli-exit.js'
import { flagErrors, flagGiven, flagValue, helpFor } from './cli-flags.js'
import { bar, compact, count, duration, keys, kv, live, pct, sparkline, table, ui } from './cli-ui.js'
import type { Ui } from './cli-ui.js'

/** Where `docpilot serve` listens when told nothing: `--port` 8787 on loopback. */
export const DEFAULT_SERVER_ORIGIN = 'http://localhost:8787'

/**
 * The server endpoint a command should reach — the URL the panel posts to.
 *
 * `--url` may name the whole endpoint (`http://host:8787/ai/turn`) or only an
 * origin (`http://host:8787`), and an origin takes the configured
 * `server.endpoint`: the path is in the config already, and making somebody
 * type it twice is how the two drift. With no `--url` at all, the configured
 * endpoint on localhost:8787, which is what `serve` with no flags runs.
 *
 * A URL that does not parse is a usage error, thrown the way `parseLevelArg`
 * throws one — `e.usage`, caught by whoever owns the exit.
 */
export function serverEndpoint(url: string | null, docPilot: any): string {
  const endpoint = String(docPilot?.server?.endpoint ?? '/ai/turn').replace(/\/+$/, '')
  if (!url) return `${DEFAULT_SERVER_ORIGIN}${endpoint}`
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    // reported below, with the other way a URL can be wrong
  }
  // `localhost:8787` PARSES — as the scheme "localhost:" — so a parse alone
  // would send the request nowhere and report it as a server that is down.
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    const e: Error & { usage?: boolean } = new Error(
      `--url="${url}" is not an http(s) URL, e.g. --url=${DEFAULT_SERVER_ORIGIN}${endpoint}`,
    )
    e.usage = true
    throw e
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${pathname || endpoint}`
}

/**
 * `--interval=2s` → milliseconds. `500ms`, `2s`, `1.5s`, `1m`, and a bare
 * number, which is seconds. Null when it is none of those, or faster than a
 * quarter of a second — a monitor that polls in a loop is a load test.
 */
export function parseInterval(raw: string | null | undefined, dflt = 2000): number | null {
  if (raw == null || raw === '') return dflt
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(raw).trim())
  if (!m) return null
  const n = Number(m[1]) * (m[2] === 'ms' ? 1 : m[2] === 'm' ? 60_000 : 1000)
  return n >= 250 ? Math.round(n) : null
}

/**
 * One poll. Never throws: every way it can fail is a value the two outputs
 * render differently.
 *
 * The token travels as a bearer — the metrics are the owner's, and a server
 * that publishes its traffic to anyone who asks is a server that has decided
 * to; `DOCPILOT_METRICS_TOKEN` is the variable for it, like
 * `DOCPILOT_FEEDBACK_TOKEN` for `feedback --from`.
 */
export async function fetchMetrics(
  endpoint: string,
  { token = null, fetch: fetchImpl = globalThis.fetch, timeoutMs = 3000 }: { token?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; snapshot: any; error: string | null; ms: number }> {
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  let res
  try {
    res = await fetchImpl(`${endpoint}/metrics?format=json`, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `no answer in ${duration(timeoutMs)}` : String(e?.cause?.code || e?.message || e)
    return { ok: false, status: 0, snapshot: null, error: `${endpoint} is not reachable — ${why}`, ms: ms() }
  }
  if (!res.ok) {
    const error =
      res.status === 404
        ? 'metrics unavailable — this server has no /metrics: server.metrics is false, or it predates them'
        : res.status === 401 || res.status === 403
          ? `metrics refused (HTTP ${res.status}) — pass --token, or set DOCPILOT_METRICS_TOKEN`
          : `metrics answered HTTP ${res.status}`
    return { ok: false, status: res.status, snapshot: null, error, ms: ms() }
  }
  let snapshot
  try {
    snapshot = await res.json()
  } catch {
    return { ok: false, status: res.status, snapshot: null, error: 'metrics answered something that is not JSON', ms: ms() }
  }
  // Lenient on absence, strict on a contradiction: a snapshot that names some
  // OTHER kind is somebody else's endpoint answering on this path.
  if (snapshot?.kind && snapshot.kind !== 'docpilot.metrics') {
    return { ok: false, status: res.status, snapshot: null, error: `metrics answered a "${snapshot.kind}", not a docpilot.metrics snapshot`, ms: ms() }
  }
  return { ok: true, status: res.status, snapshot, error: null, ms: ms() }
}

/** The outcome vocabulary of a turn, in the order the block lists it. */
export const OUTCOMES = ['answer', 'opener', 'refused', 'not-answerable', 'social', 'credential', 'results', 'error', 'aborted', 'rate-limited']

const STAGES = ['embed', 'retrieve', 'rerank', 'model']

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const sumOf = (xs) => xs.reduce((a, v) => a + (num(v) ?? 0), 0)

/**
 * One snapshot, drawn. PURE — the live loop and the tests call the same thing.
 *
 * @param clock the time the snapshot was taken, already formatted — passed in
 *   rather than read, so a test's expected output does not depend on its
 *   timezone.
 */
export function renderMetrics(
  m,
  { ui: view, url = null, error = null, clock = null, intervalMs = null, live: interactive = false }: { ui: Ui; url?: string | null; error?: string | null; clock?: string | null; intervalMs?: number | null; live?: boolean },
): string[] {
  const { c, sym, unicode } = view
  const dur = (v) => duration(num(v))
  const lines = [`  ${c.bold('docpilot monitor')}${url ? `  ${c.muted(url)}` : ''}`]
  if (error) lines.push(`  ${c.fail(sym.fail)} ${error}`)
  if (!m) {
    lines.push('', c.muted('  no snapshot yet'))
    return lines
  }

  const index = m.index ?? {}
  const up = num(m.uptimeS)
  lines.push(
    '  ' +
      [
        `model ${m.model ?? '—'}`,
        `embed ${m.embedModel ?? '—'}`,
        `index ${index.hash ?? '—'}${num(index.chunks) != null ? ` (${count(index.chunks)} chunks)` : ''}`,
        `up ${up != null ? duration(up * 1000) : '—'}`,
      ].join(c.muted(' · ')),
    '',
  )

  const turns = m.turns ?? {}
  const lat = m.latencyMs ?? {}
  const ttft = m.ttftMs ?? {}
  const stages = m.stagesMs ?? {}
  const perMinute = Array.isArray(m.perMinute) ? m.perMinute : []
  const minutes = perMinute.filter((v) => num(v) != null)
  lines.push(
    ...kv(
      [
        ['turns', `${count(num(turns.total))} total · ${count(num(turns.inFlight))} in flight`],
        [
          'per minute',
          minutes.length
            ? `${c.info(sparkline(perMinute, { unicode, min: 0 }))}  ${count(num(perMinute[perMinute.length - 1]))} now · peak ${count(Math.max(...minutes))}`
            : '—',
        ],
        [
          'latency',
          `p50 ${dur(lat.p50)} · p95 ${dur(lat.p95)} · p99 ${dur(lat.p99)}` +
            (num(lat.count) != null ? c.muted(`  (${count(lat.count)} turns)`) : ''),
        ],
        ['first token', `p50 ${dur(ttft.p50)} · p95 ${dur(ttft.p95)} · p99 ${dur(ttft.p99)}`],
        ['stages p50', STAGES.map((s) => `${s} ${dur(stages[s]?.p50)}`).join(' · ')],
        ['stages p95', STAGES.map((s) => `${s} ${dur(stages[s]?.p95)}`).join(' · ')],
      ],
      { key: c.muted, keyWidth: 12 },
    ),
    '',
  )

  // Shares of the outcomes ACTUALLY COUNTED, not of `turns.total`: a turn in
  // flight has no outcome yet, and the bars have to add up to the rows.
  const by = turns.byOutcome ?? {}
  const counted = sumOf(OUTCOMES.map((o) => by[o]))
  const tone = (o) =>
    ['error', 'aborted', 'rate-limited'].includes(o) ? c.fail : ['refused', 'not-answerable', 'credential'].includes(o) ? c.warn : c.ok
  lines.push(`  ${c.muted('outcomes')}`)
  lines.push(
    ...table(
      OUTCOMES.map((o) => {
        const n = num(by[o])
        const f = n != null && counted ? n / counted : 0
        return [o, tone(o)(bar(f, 20, { unicode })), count(n), n != null && counted ? pct(f) : '—']
      }),
      { indent: 4, align: ['left', 'left', 'right', 'right'] },
    ),
    '',
  )

  const limits = m.limits ?? {}
  const tokens = m.tokens ?? {}
  const cache = m.cache ?? {}
  const requests = m.requests ?? {}
  const errors = num(by.error)
  const hit = (h, miss) => {
    const a = num(h)
    const b = num(miss)
    if (a == null || b == null || a + b === 0) return '—'
    return `${pct(a / (a + b))} hit (${count(a)} of ${count(a + b)})`
  }
  const share = num(tokens.cached) != null && num(tokens.prompt) ? c.muted(`  (${pct(tokens.cached / tokens.prompt)} of prompt)`) : ''
  const errorText = `${count(errors)} errors · ${count(num(limits.rateLimited))} rate-limited · ${count(num(limits.rejected))} rejected`
  lines.push(
    ...kv(
      [
        ['errors', (errors ?? 0) + (num(limits.rateLimited) ?? 0) + (num(limits.rejected) ?? 0) > 0 ? c.fail(errorText) : errorText],
        ['tokens', `prompt ${compact(num(tokens.prompt))} · output ${compact(num(tokens.output))} · cached ${compact(num(tokens.cached))}${share}`],
        ['cache', `embed ${hit(cache.embedHits, cache.embedMisses)} · answers ${hit(cache.answerHits, cache.answerMisses)}`],
        ['requests', `chat ${count(num(requests.chat))} · embed ${count(num(requests.embed))} · rerank ${count(num(requests.rerank))}`],
      ],
      { key: c.muted, keyWidth: 12 },
    ),
  )

  const foot = [
    clock && `polled ${clock}`,
    intervalMs && `every ${intervalMs % 1000 === 0 ? `${intervalMs / 1000}s` : duration(intervalMs)}`,
    interactive && 'q quits',
  ].filter(Boolean)
  if (foot.length) lines.push('', c.muted(`  ${foot.join(' · ')}`))
  return lines
}

const clockOf = (d: Date) => d.toTimeString().slice(0, 8)

/**
 * The command. Same `run*` contract as `serve`: flags of its own, a code back.
 *
 * `sleep` and `fetch` are injectable for the tests; `maxPolls` bounds the
 * piped loop for the same reason and is not a flag — a log feeder that stops
 * on its own is a log with a hole in it.
 */
export async function runMonitor({
  docPilot,
  argv = [],
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  maxPolls = Infinity,
}: {
  docPilot: any
  argv?: string[]
  env?: Record<string, string | undefined>
  stdin?: any
  stdout?: any
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<unknown>
  maxPolls?: number
}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${helpFor('monitor')}\n`)
    return OK
  }
  const errors = flagErrors('monitor', argv)
  if (errors.length) {
    for (const e of errors) console.error(`[docpilot] ${e}`)
    return USAGE
  }
  const rawInterval = flagValue('monitor', argv, 'interval')
  const intervalMs = parseInterval(rawInterval)
  if (intervalMs == null) {
    console.error(`[docpilot] --interval="${rawInterval}" must be a duration of at least 250ms, e.g. --interval=2s`)
    return USAGE
  }
  let endpoint
  try {
    endpoint = serverEndpoint(flagValue('monitor', argv, 'url'), docPilot)
  } catch (e) {
    console.error(`[docpilot] ${e.message}`)
    return e.usage ? USAGE : FAILED
  }
  const token = flagValue('monitor', argv, 'token') ?? env.DOCPILOT_METRICS_TOKEN ?? null
  const once = flagGiven('monitor', argv, 'once')
  const poll = () => fetchMetrics(endpoint, { token, fetch: fetchImpl, timeoutMs: Math.min(5000, Math.max(1000, intervalMs)) })

  // ── a log, or a probe ──────────────────────────────────────────────────────
  if (once || !stdout.isTTY) {
    for (let n = 1; ; n++) {
      const r = await poll()
      if (r.ok) stdout.write(`${JSON.stringify(r.snapshot)}\n`)
      else console.error(`[docpilot] ${r.error}`)
      if (once) return r.ok ? OK : FAILED
      if (n >= maxPolls) return OK
      await sleep(intervalMs)
    }
  }

  // ── a terminal ─────────────────────────────────────────────────────────────
  const view = ui(stdout, env)
  const region = live(stdout)
  let quit: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    quit = resolve
  })
  let running = true
  stopped.then(() => {
    running = false
  })
  // `q`, Esc and Ctrl-C all mean "stop watching" here: there is no question
  // being declined, so it is not the CANCELLED code.
  const restore = stdin?.isTTY
    ? keys(stdin, (str, key) => {
        if (str === 'q' || key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) quit()
      })
    : null
  const onSigint = () => quit()
  if (!restore) process.once('SIGINT', onSigint)

  let last = null
  let lastLines: string[] = []
  try {
    for (let n = 1; running; n++) {
      const r = await poll()
      if (r.ok) last = r.snapshot
      lastLines = renderMetrics(last, {
        ui: { ...view, width: stdout.columns || 80 },
        url: endpoint,
        error: r.ok ? null : r.error,
        clock: clockOf(new Date()),
        intervalMs,
        live: Boolean(restore),
      })
      region.render(lastLines)
      if (n >= maxPolls) break
      await Promise.race([sleep(intervalMs), stopped])
    }
  } finally {
    restore?.()
    process.off('SIGINT', onSigint)
    // The last frame stays: quitting a monitor should not erase what it showed.
    region.done(lastLines)
  }
  return OK
}
