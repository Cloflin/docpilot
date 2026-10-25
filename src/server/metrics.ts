/**
 * What a running server has been doing — engine-spec 031.
 *
 * The turn log (spec 028) is the record of every turn, written for the commands
 * that read it later: `traffic`, `dataset`, `model`. It is the wrong instrument
 * for "is it fast right now": answering that from the log means a file read and
 * a parse per question, and the log is off on a deployment that set `log: null`.
 * This keeps the numbers an operator watches in memory, updated once per turn,
 * and renders them two ways:
 *
 *   · `prometheus()` — the text exposition format, for a scraper. Counters and
 *     histograms only, so a rate or a quantile is the scraper's arithmetic and
 *     survives a restart of this process the way Prometheus expects.
 *   · `snapshot()` — one JSON object (`docpilot.metrics/1`), for `docpilot
 *     monitor` and for a human with curl. Percentiles here are EXACT over the
 *     last `window` turns rather than estimated from buckets, because a
 *     dashboard reading p95 off 12 buckets would print a bucket edge.
 *
 * Nothing here knows what a turn means. It is fed the finished turn record and
 * reads the fields that record already has, plus `timing`, which the turn now
 * measures for this module's sake.
 */

/** Bucket edges in SECONDS: a cached opener is 5 ms, a local 8B turn is a minute. */
const BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120, 300]

/** The stages a turn is timed in, in the order a turn spends them. */
export const STAGES = ['embed', 'retrieve', 'rerank', 'model']

/** Every outcome a turn record can end on — spec 028 §3. Listed so the zeros print. */
export const OUTCOMES = [
  'answer',
  'opener',
  'refused',
  'not-answerable',
  'social',
  'credential',
  'results',
  'error',
  'aborted',
  'rate-limited',
]

/** A fixed-size ring of numbers, for exact percentiles over the recent past. */
function ring(size) {
  const buf: number[] = []
  let at = 0
  return {
    push(v) {
      if (!Number.isFinite(v)) return
      if (buf.length < size) buf.push(v)
      else buf[at] = v
      at = (at + 1) % size
    },
    values: () => buf.slice(),
  }
}

/** Nearest-rank percentile — the rule `eval`'s `percentile` uses, so the two agree. */
export function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.floor(v.length * q))]
}

function histogram() {
  const counts = new Array(BUCKETS.length).fill(0)
  let sum = 0
  let count = 0
  return {
    observe(seconds) {
      if (!Number.isFinite(seconds)) return
      sum += seconds
      count++
      for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) counts[i]++
    },
    lines(name, labels = '') {
      const sep = labels ? `${labels},` : ''
      const out = BUCKETS.map((b, i) => `${name}_bucket{${sep}le="${b}"} ${counts[i]}`)
      out.push(`${name}_bucket{${sep}le="+Inf"} ${count}`)
      out.push(`${name}_sum${labels ? `{${labels}}` : ''} ${round(sum, 6)}`)
      out.push(`${name}_count${labels ? `{${labels}}` : ''} ${count}`)
      return out
    },
  }
}

const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d)

/** A Prometheus label value: backslash, quote and newline escaped, nothing else. */
const label = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

export interface MetricsOptions {
  now?: () => number
  /** How many recent turns the exact percentiles are taken over. */
  window?: number
}

export function createMetrics({ now = Date.now, window = 1000 }: MetricsOptions = {}) {
  const startedAt = now()
  const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0]))
  let total = 0
  let inFlight = 0
  const recent = {
    latency: ring(window),
    ttft: ring(window),
    ...Object.fromEntries(STAGES.map((s) => [s, ring(window)])),
  }
  const hist = {
    latency: histogram(),
    ttft: histogram(),
    ...Object.fromEntries(STAGES.map((s) => [s, histogram()])),
  }
  const requests = { chat: 0, embed: 0, rerank: 0 }
  const tokens = { prompt: 0, output: 0, cached: 0 }
  const cache = { embedHits: 0, embedMisses: 0, answerHits: 0, answerMisses: 0 }
  const limits = { rateLimited: 0, rejected: 0 }
  /** One-minute buckets of finished turns, keyed by minute since the epoch. */
  const minutes = new Map<number, number>()
  const PER_MINUTE = 30

  return {
    /** A turn started; the returned function says it ended (whatever way it ended). */
    begin() {
      inFlight++
      let done = false
      return () => {
        if (done) return
        done = true
        inFlight--
      }
    },

    /** The finished turn record — `docpilot.turn/1` with its `timing`. */
    turn(record) {
      total++
      const outcome = OUTCOMES.includes(record?.outcome) ? record.outcome : 'error'
      byOutcome[outcome]++
      const t = record?.timing || {}
      const latency = Number.isFinite(t.totalMs) ? t.totalMs : record?.latencyMs
      recent.latency.push(latency)
      hist.latency.observe(latency / 1000)
      if (Number.isFinite(t.firstTokenMs)) {
        recent.ttft.push(t.firstTokenMs)
        hist.ttft.observe(t.firstTokenMs / 1000)
      }
      for (const s of STAGES) {
        const ms = t[`${s}Ms`]
        if (!Number.isFinite(ms)) continue
        recent[s].push(ms)
        hist[s].observe(ms / 1000)
      }
      requests.chat += Number(record?.requests) || 0
      requests.embed += Number(t.embedRequests) || 0
      requests.rerank += Number(t.rerankRequests) || 0
      tokens.prompt += Number(record?.usage?.promptTokens) || 0
      tokens.output += Number(record?.usage?.outputTokens) || 0
      tokens.cached += Number(record?.usage?.cachedTokens) || 0
      const minute = Math.floor(now() / 60000)
      minutes.set(minute, (minutes.get(minute) || 0) + 1)
      for (const k of minutes.keys()) if (k <= minute - PER_MINUTE) minutes.delete(k)
    },

    cacheHit(kind: 'embed' | 'answer') {
      cache[`${kind}Hits`]++
    },
    cacheMiss(kind: 'embed' | 'answer') {
      cache[`${kind}Misses`]++
    },
    /** A turn refused before any work: `rate` for a limit, `rejected` for the rest. */
    limited(kind: 'rate' | 'rejected') {
      if (kind === 'rate') limits.rateLimited++
      else limits.rejected++
    },

    snapshot(extra: Record<string, any> = {}) {
      const at = now()
      const minute = Math.floor(at / 60000)
      const perMinute = []
      for (let k = minute - PER_MINUTE + 1; k <= minute; k++) perMinute.push(minutes.get(k) || 0)
      const pct = (r) => {
        const v = r.values()
        return {
          p50: round(quantile(v, 0.5)),
          p95: round(quantile(v, 0.95)),
          p99: round(quantile(v, 0.99)),
          count: v.length,
        }
      }
      return {
        kind: 'docpilot.metrics',
        v: 1,
        startedAt: new Date(startedAt).toISOString(),
        now: new Date(at).toISOString(),
        uptimeS: Math.round((at - startedAt) / 1000),
        ...extra,
        turns: { total, inFlight, byOutcome: { ...byOutcome } },
        latencyMs: pct(recent.latency),
        ttftMs: pct(recent.ttft),
        stagesMs: Object.fromEntries(
          STAGES.map((s) => {
            const p = pct(recent[s])
            return [s, { p50: p.p50, p95: p.p95 }]
          }),
        ),
        requests: { ...requests },
        tokens: { ...tokens },
        cache: { ...cache },
        limits: { ...limits },
        perMinute,
      }
    },

    prometheus(extra: { model?: string | null; embedModel?: string | null; index?: { hash?: string | null } } = {}) {
      const lines = []
      const help = (name, type, text) => lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`)
      help('docpilot_info', 'gauge', 'The model, embedder and index this server answers with.')
      lines.push(
        `docpilot_info{model="${label(extra.model)}",embed_model="${label(extra.embedModel)}",index_hash="${label(extra.index?.hash)}"} 1`,
      )
      help('docpilot_start_time_seconds', 'gauge', 'When this server started, in Unix seconds.')
      lines.push(`docpilot_start_time_seconds ${Math.floor(startedAt / 1000)}`)
      help('docpilot_turns_total', 'counter', 'Finished turns, by outcome.')
      for (const o of OUTCOMES) lines.push(`docpilot_turns_total{outcome="${o}"} ${byOutcome[o]}`)
      help('docpilot_turns_in_flight', 'gauge', 'Turns running now.')
      lines.push(`docpilot_turns_in_flight ${inFlight}`)
      help('docpilot_turn_duration_seconds', 'histogram', 'Whole-turn latency, request to settle.')
      lines.push(...hist.latency.lines('docpilot_turn_duration_seconds'))
      help('docpilot_turn_first_token_seconds', 'histogram', 'Request to the first answer token on screen.')
      lines.push(...hist.ttft.lines('docpilot_turn_first_token_seconds'))
      help('docpilot_turn_stage_seconds', 'histogram', 'Time spent in each stage of a turn.')
      for (const s of STAGES) lines.push(...hist[s].lines('docpilot_turn_stage_seconds', `stage="${s}"`))
      help('docpilot_upstream_requests_total', 'counter', 'Requests sent to the model provider, by kind.')
      for (const [k, v] of Object.entries(requests)) lines.push(`docpilot_upstream_requests_total{kind="${k}"} ${v}`)
      help('docpilot_tokens_total', 'counter', 'Tokens reported by the provider, by type.')
      for (const [k, v] of Object.entries(tokens)) lines.push(`docpilot_tokens_total{type="${k}"} ${v}`)
      help('docpilot_cache_lookups_total', 'counter', 'In-process cache lookups, by cache and result.')
      lines.push(
        `docpilot_cache_lookups_total{cache="embedding",result="hit"} ${cache.embedHits}`,
        `docpilot_cache_lookups_total{cache="embedding",result="miss"} ${cache.embedMisses}`,
        `docpilot_cache_lookups_total{cache="answer",result="hit"} ${cache.answerHits}`,
        `docpilot_cache_lookups_total{cache="answer",result="miss"} ${cache.answerMisses}`,
      )
      help('docpilot_refused_requests_total', 'counter', 'Requests turned away before any work, by reason.')
      lines.push(
        `docpilot_refused_requests_total{reason="rate-limit"} ${limits.rateLimited}`,
        `docpilot_refused_requests_total{reason="rejected"} ${limits.rejected}`,
      )
      return `${lines.join('\n')}\n`
    },
  }
}

export type Metrics = ReturnType<typeof createMetrics>
