/**
 * Who may start a turn, and how many may run — engine-spec 033.
 *
 * Spec 028 left this to the reverse proxy ("лимит — забота reverse proxy") and
 * shipped an `authorize` hook instead. The hook is still the place for auth; a
 * LIMIT is different, because the default deployment has no proxy at all —
 * `docpilot serve` and the Docker image put this handler straight on a port —
 * and without one the endpoint is OWASP LLM10 verbatim: anybody can spend the
 * owner's model allowance as fast as the model answers, with up to eight chat
 * calls per turn.
 *
 * THREE CEILINGS, each answering a different abuse:
 *
 *   · a token bucket per client (`perMinute`, refill continuous, `burst` deep) —
 *     one reader typing quickly is fine, one script looping is not;
 *   · a daily count per client (`perDay`, UTC day) — the slow drip a per-minute
 *     bucket lets through;
 *   · a concurrency cap, server-wide (`concurrent`) and per client
 *     (`perClient`) — the turns that are RUNNING, which is what actually holds
 *     a GPU or a provider's rate limit.
 *
 * THE CLIENT IS THE SOCKET'S ADDRESS, never a header, unless `trustProxy` says a
 * proxy in front rewrites `X-Forwarded-For` — a header the client writes is a
 * limit the client chooses. An IPv6 address counts as its /64 (`addressKey`).
 * On a runtime that gives no address (an edge `handle(Request)` with no
 * `info`), every request shares one bucket: the limit still holds the
 * endpoint, it just cannot tell readers apart, and the docs say to put the
 * edge's own limiter in front.
 *
 * In memory, per process: a restart forgets, and N replicas allow N times the
 * rate. Both are stated in the guide; a shared store is the proxy's job.
 */

export interface LimitSettings {
  perMinute?: number
  burst?: number
  perDay?: number
  concurrent?: number
  perClient?: number
}

/**
 * One shape for both answers, because this package type-checks without
 * `strictNullChecks` and a discriminated union on `ok` would not narrow: an
 * admitted request carries `release`, a refused one carries the rest.
 */
export interface Admission {
  ok: boolean
  release: () => void
  status?: number
  reason?: 'rate' | 'day' | 'busy'
  retryAfterS?: number
}

const NOOP = () => {}

export function createLimiter(settings: LimitSettings | false, { now = Date.now } = {}) {
  if (!settings) return { admit: (_key: string): Admission => ({ ok: true, release: NOOP }), clients: () => 0 }
  const perMinute = settings.perMinute ?? 10
  const burst = settings.burst ?? perMinute
  const perDay = settings.perDay ?? Infinity
  const concurrent = settings.concurrent ?? Infinity
  const perClient = settings.perClient ?? Infinity
  const refillPerMs = perMinute / 60000
  const clients = new Map<string, { tokens: number; at: number; day: number; dayCount: number; running: number }>()
  let running = 0
  let admitted = 0

  const dayOf = (t) => Math.floor(t / 86400000)

  /** Forget clients idle for a day, every few hundred admissions. */
  const prune = (t) => {
    for (const [k, c] of clients) if (!c.running && t - c.at > 86400000) clients.delete(k)
  }

  function admit(key: string): Admission {
    const t = now()
    if (++admitted % 256 === 0) prune(t)
    // A client is REMEMBERED ONLY ONCE ADMITTED. A newcomer is judged on a fresh
    // record that is stored on the way out, so a flood of refused requests from
    // new addresses — every one `busy` while the server is full — costs no
    // memory: the map holds the clients that ran a turn, not every one that asked.
    let c = clients.get(key)
    const fresh = !c
    if (fresh) c = { tokens: burst, at: t, day: dayOf(t), dayCount: 0, running: 0 }
    c.tokens = Math.min(burst, c.tokens + (t - c.at) * refillPerMs)
    c.at = t
    if (c.day !== dayOf(t)) {
      c.day = dayOf(t)
      c.dayCount = 0
    }
    if (c.dayCount >= perDay) {
      const reset = (c.day + 1) * 86400000
      return { ok: false, release: NOOP, status: 429, reason: 'day', retryAfterS: Math.ceil((reset - t) / 1000) }
    }
    if (c.tokens < 1) {
      return { ok: false, release: NOOP, status: 429, reason: 'rate', retryAfterS: Math.ceil((1 - c.tokens) / refillPerMs / 1000) }
    }
    // Busy is 503, not 429: the CLIENT did nothing wrong, the server is full.
    if (running >= concurrent || c.running >= perClient) {
      return { ok: false, release: NOOP, status: 503, reason: 'busy', retryAfterS: 2 }
    }
    if (fresh) clients.set(key, c)
    c.tokens -= 1
    c.dayCount++
    c.running++
    running++
    let released = false
    const entry = c
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        entry.running--
        running--
      },
    }
  }

  return { admit, clients: () => clients.size }
}

/**
 * The address a request came from, by the rule in the header above.
 *
 * `trustProxy` is a hop COUNT, not a boolean, for the reason Express's setting
 * is: with two proxies in front, the left-most `X-Forwarded-For` entry is still
 * the client's to forge, and the trustworthy one is `hops` from the right.
 * `true` means one hop.
 */
export function clientKey(request: Request, info: { remoteAddress?: string | null } | null, trustProxy: boolean | number) {
  const hops = trustProxy === true ? 1 : Number(trustProxy) || 0
  if (hops > 0) {
    const chain = String(request.headers.get('x-forwarded-for') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const fromProxy = chain[chain.length - hops]
    if (fromProxy) return addressKey(fromProxy)
  }
  return addressKey(info?.remoteAddress) || 'anonymous'
}

/**
 * One client per IPv6 /64, and an IPv4-mapped address as its IPv4.
 *
 * A /64 is what one residential line or one cloud VM is handed, so keyed on the
 * full address one client holds 2^64 keys, each with a fresh burst, day and
 * `perClient` slot — every ceiling above, bypassed by rotating the low bits.
 * `::ffff:a.b.c.d` is how a dual-stack socket reports an IPv4 peer, and the same
 * reader must not count once per spelling. A string that is not an address (an
 * edge's own id) is kept as given.
 */
export function addressKey(addr: string | null | undefined): string {
  const a = String(addr ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  if (!a.includes(':')) return a
  const halves = a.split('::')
  if (halves.length > 2) return a
  const groups = (part: string) => {
    const out = part ? part.split(':') : []
    const last = out[out.length - 1]
    // An embedded IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is two groups.
    if (last && last.includes('.')) {
      const o = last.split('.').map(Number)
      if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return null
      out.splice(-1, 1, ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16))
    }
    return out
  }
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  if (!head || !tail) return a
  const fill = 8 - head.length - tail.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return a
  const all = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail]
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return a
  const n = all.map((g) => parseInt(g, 16))
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.')
  }
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/** Loopback, in the spellings `node:net` reports it — IPv4, IPv6, mapped IPv4. */
export const isLoopback = (addr) =>
  typeof addr === 'string' && (/^127\./.test(addr) || addr === '::1' || /^::ffff:127\./.test(addr))
