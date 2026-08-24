/**
 * The `/ai/*` reverse proxy this site needs to answer a single question.
 *
 * WHY IT EXISTS AT ALL. `targetOf` in src/config.js emits `baseURL: '/ai'` for
 * every hosted provider, so the browser POSTs SAME-ORIGIN to `/ai/v1/…` and the
 * key never reaches the page. In `vitepress dev` the plugin's own proxy answers
 * those paths; a built site is static files and nothing answers them. That is
 * the point in a deployment where every question 404s AFTER the calibrated gate
 * has already decided it was answerable — the reader sees a transport error for
 * a service that is working perfectly. This module is the production half.
 *
 * WHY IT IS NOT UNDER `api/`. Every file under `api/` becomes a route on Vercel,
 * so a shared module placed there would be a third, undeclared endpoint. `lib/`
 * is also absent from `package.json#files`, so none of this ships to npm — it is
 * this deployment's, not the package's — and absent from `tsconfig.json#include`,
 * whose list is deliberately narrow, so it is not type-checked either.
 *
 * WHAT IT IS BUILT TO. `proxyContract()` in src/config.js returns the routes and
 * five notes; all five are implemented here and in `vercel.json` beside it:
 *
 *   1. match the paths EXACTLY — `api/ai/chat.js` and `api/ai/embeddings.js` are
 *      reached by two literal rewrites, never by a prefix match on `/ai`
 *   2. strip any client `Authorization`, `x-api-key` and `Cookie` — `upstreamHeaders`
 *      builds a fresh `Headers` and copies nothing from the request but `accept`
 *   3. do not buffer the response — the answer is server-sent events, so
 *      `res.body` is handed back unread
 *   4. rate-limit by IP and cap the body — `take()` and `readBody()` below
 *   5. allow only this deployment's own origin — `sameOrigin()`
 *
 * WHAT THE LIMITER IS AND IS NOT. The two `Map`s below live in module scope.
 * They survive between invocations of a WARM instance, are lost when that
 * instance recycles, and two instances serving concurrently keep two independent
 * counters — so the effective ceiling is the stated one times however many
 * instances happen to be up. This stops a runaway retry loop and a `curl` in a
 * `for` loop, which is what it is for. It does not stop a distributed one, and
 * nothing without shared storage could. The hard ceiling is upstream's anyway:
 * OpenRouter counts 50 free requests a day against the account, for every reader
 * of this site together, and that number is enforced where the money is.
 */

/**
 * The upstream, as a LITERAL, and the test beside this file is what keeps it
 * honest: it asserts this string plus each handler's path against what
 * `proxyContract()` returns for this site's own `docPilot` export. The contract
 * asks the adapter for its paths rather than writing them down precisely because
 * a second copy drifts — it once printed `/v1/chat/completions` for Anthropic,
 * whose adapter posts to `/v1/messages`. This file is that second copy. The test
 * is the thing that stops it from drifting.
 */
export const UPSTREAM = 'https://openrouter.ai/api'

/** Named, never read into a message or a response — only its absence is reported. */
export const KEY_ENV = 'OPENROUTER_API_KEY'

/**
 * 256 KB, and the number is an arithmetic bound rather than a round figure.
 *
 * A turn's body is the system block plus every accumulated observation, re-sent
 * on every step. The gate primes it with `GATE_K` excerpts — 5 (retriever.js) —
 * each cut to `SEARCH_CHARS`, 1200 characters (harness.js), and `maxIterations`
 * is 2 (config.js), which is measured: 5.9k prompt tokens and 0.7k output per
 * turn at num_ctx 8192. So the fattest turn this package can construct is tens
 * of kilobytes, and the whole 8192-token window is about 32 KB of UTF-8.
 *
 * 256 KB is several times the largest body a real turn produces. Nothing the
 * panel sends comes near it, and a body that does is not a turn.
 */
export const BODY_LIMIT = 256 * 1024

/**
 * Two windows per IP, and neither is trying to be OpenRouter's.
 *
 * BURST — 10 a minute. A turn is 1 embedding request plus 2–3 model calls, plus
 * any the pool rotates through, so one question costs 3–4 and a reader asking
 * questions at human speed never sees this. A script does, immediately.
 *
 * DAILY — 20 a day, which is 5–7 questions. The account's free ceiling is 50
 * requests a day TOTAL, shared by every reader of this site, so a per-IP day of
 * 20 is the statement that no single visitor may spend the site's whole
 * allowance before anyone else arrives.
 *
 * The day is a fixed 24 hours from an IP's first request, not midnight UTC.
 * OpenRouter's day boundary is OpenRouter's, this proxy cannot see it, and a
 * window that pretends to align with one it cannot observe is a lie in the
 * `x-ratelimit-reset` it publishes.
 */
export const BURST = {limit: 10, windowMs: 60 * 1000}
export const DAILY = {limit: 20, windowMs: 24 * 60 * 60 * 1000}

const BURST_BUCKETS = new Map()
const DAILY_BUCKETS = new Map()

/**
 * Past this many live keys, expired ones are swept before a new one is added.
 *
 * Unbounded, a long-lived warm instance accumulates one daily bucket per IP that
 * ever asked a question and never releases them. The sweep is O(size) and runs
 * only at the threshold, so the amortised cost of a request is unchanged.
 */
const SWEEP_AT = 5000

/**
 * One request against one fixed window. Returns the decision AND the numbers the
 * refusal will publish, because a limiter that knows it refused but not until
 * when produces a 429 the panel cannot act on.
 *
 * A REFUSED REQUEST STILL COUNTS. The window is fixed rather than sliding, so
 * hammering does not push the reset out; counting the refusals as well simply
 * means a client that ignores `retry-after` gets no reward for it.
 *
 * @param {Map<string, {count: number, resetAt: number}>} buckets
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
 * @param {number} now
 * @returns {{ok: boolean, limit: number, remaining: number, resetAt: number}}
 */
export function take(buckets, key, limit, windowMs, now = Date.now()) {
    const held = buckets.get(key)
    if (!held || now >= held.resetAt) {
        if (buckets.size >= SWEEP_AT) sweep(buckets, now)
        const opened = {count: 1, resetAt: now + windowMs}
        buckets.set(key, opened)
        return {ok: true, limit, remaining: limit - 1, resetAt: opened.resetAt}
    }
    held.count += 1
    return {
        ok: held.count <= limit,
        limit,
        remaining: Math.max(0, limit - held.count),
        resetAt: held.resetAt,
    }
}

/** Drop every window that has already closed. Exported so the arithmetic is testable. */
export function sweep(buckets, now = Date.now()) {
    for (const [key, held] of buckets) {
        if (now >= held.resetAt) buckets.delete(key)
    }
    return buckets.size
}

/**
 * Who to count against.
 *
 * `x-vercel-forwarded-for` first: the platform sets it and a client cannot forge
 * it. `x-forwarded-for` is read as its FIRST entry — the list is
 * client-then-proxies, and reading the last entry counts every reader against
 * the edge node in front of them, which is one bucket for the whole site.
 *
 * A request with none of the three lands in one shared `unknown` bucket
 * deliberately: that is local `vercel dev` or a platform that stopped setting
 * them, and one conservative bucket is a better answer than an unlimited one per
 * caller.
 */
export function clientIp(headers) {
    const first = (value) => (value ? String(value).split(',')[0].trim() : '')
    return (
        first(headers?.get?.('x-vercel-forwarded-for')) ||
        first(headers?.get?.('x-real-ip')) ||
        first(headers?.get?.('x-forwarded-for')) ||
        'unknown'
    )
}

/**
 * Contract note 5, and the reason it is not stricter than it looks.
 *
 * A MISSING `Origin` PASSES. The check exists to stop another site's page from
 * spending this key through a reader's browser, and that page always sends one;
 * a browser that omits it on a same-origin POST would otherwise 403 every
 * question on this site, which is exactly the silent-failure mode this whole
 * deployment is built to avoid. The real defence against the cross-site case is
 * that no response here carries an `access-control-allow-*` header at all, so a
 * cross-origin fetch is refused by the browser before it is read.
 *
 * The host is compared against THIS request's own, never against a hard-coded
 * one, so every preview deployment — each on its own generated hostname — is
 * correct without an allowlist anyone has to remember to extend.
 */
export function sameOrigin(request) {
    const origin = request.headers.get('origin')
    if (!origin) return true
    let host
    try {
        host = new URL(request.url).host
    } catch {
        host = ''
    }
    const forwarded = request.headers.get('x-forwarded-host') || ''
    try {
        const asked = new URL(origin).host
        return asked !== '' && (asked === host || asked === forwarded)
    } catch {
        return false
    }
}

/**
 * The request body, buffered, with the ceiling applied to BYTES READ.
 *
 * The docs' warning about not awaiting is about the RESPONSE. Buffering the
 * request is what makes the cap exact: `content-length` is supplied by the
 * client, so a cap that trusts it is a cap the client sets. It is still read
 * first, as a free early refusal for an honest oversized body, and then ignored.
 *
 * Reading incrementally rather than through `arrayBuffer()` is the same point
 * made about memory: `arrayBuffer()` would materialise a gigabyte before anyone
 * could object to it. This stops at the first chunk that crosses the line.
 *
 * Buffering also removes the `duplex: 'half'` requirement on the upstream fetch,
 * which is the other thing that makes a streamed request body awkward here.
 */
export async function readBody(request, cap = BODY_LIMIT) {
    const stated = request.headers.get('content-length')
    // `Number(null)` is 0, not NaN, so an absent header read straight through
    // `Number()` would report a body of zero bytes rather than no claim at all.
    const declared = stated === null || stated === '' ? NaN : Number(stated)
    if (Number.isFinite(declared) && declared > cap) return {tooLarge: true, body: null}
    if (!request.body) return {tooLarge: false, body: new Uint8Array(0)}
    const reader = request.body.getReader()
    const parts = []
    let size = 0
    for (;;) {
        const {done, value} = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > cap) {
            await reader.cancel().catch(() => {})
            return {tooLarge: true, body: null}
        }
        parts.push(value)
    }
    const body = new Uint8Array(size)
    let at = 0
    for (const part of parts) {
        body.set(part, at)
        at += part.byteLength
    }
    return {tooLarge: false, body}
}

/**
 * What goes UPSTREAM, built from nothing rather than filtered.
 *
 * Contract note 2 says to strip `Authorization`, `x-api-key` and `Cookie`. A
 * denylist is the wrong shape for that: it is correct only about the headers
 * someone thought of, and this is the request that carries the key. So the
 * request's headers are not copied at all — three are set outright, and `accept`
 * is the single value passed through, because it names a response format and
 * carries no credential.
 */
export function upstreamHeaders(request, key) {
    return {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: request.headers.get('accept') || 'application/json',
    }
}

/**
 * The three headers `readLimitHeaders()` in theme/docpilot/budget.js reads —
 * `x-ratelimit-limit`, `-remaining`, `-reset` — plus `retry-after` and the
 * content type. This is the one place this proxy has to be better than the
 * thirteen-line edge-function sketch in docs/guide/production.md, which copies
 * `content-type` alone: without the three, the panel's "N of 50 left today" line
 * has nothing to read and the budget can only be discovered by hitting it, which
 * costs the reader a question and shows them a transport error.
 *
 * NOTHING ELSE IS COPIED. No `set-cookie`, so upstream cannot set state in a
 * reader's browser through this origin; no `access-control-allow-*`, so the
 * same-origin property this endpoint depends on is not handed away by an
 * upstream that happens to be permissive.
 *
 * `cache-control: no-store` is added rather than copied: every response here is
 * one reader's answer, and a CDN that cached one would serve it to the next.
 */
const FORWARD = ['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']

export function forwardHeaders(upstream) {
    const out = new Headers()
    for (const name of FORWARD) {
        const value = upstream?.get?.(name)
        if (value !== null && value !== undefined && value !== '') out.set(name, value)
    }
    if (!out.has('content-type')) out.set('content-type', 'application/json')
    out.set('cache-control', 'no-store')
    return out
}

/**
 * An error in the shape the panel already parses: OpenRouter's, which is the
 * shape `classifyLimit()` reads a `metadata.limit_source` out of and the shape
 * every other error in this transport arrives in. A proxy inventing its own
 * envelope is a second parser nobody wrote.
 */
function problem(status, message, extra = {}, headers = {}) {
    return new Response(JSON.stringify({error: {code: status, message, ...extra}}), {
        status,
        headers: {'content-type': 'application/json', 'cache-control': 'no-store', ...headers},
    })
}

/**
 * THE 429, WRITTEN TO THE CONTRACT THE PANEL ALREADY READS.
 *
 * `classifyLimit()` (theme/docpilot/budget.js) asks four questions in order, and
 * the first is `error.metadata.limit_source`: a value CONTAINING "daily" is a
 * day, anything else falls through to the message text, then to the arithmetic,
 * then to the window. So the two buckets are named `docpilot-proxy-daily` and
 * `docpilot-proxy-burst`, and the burst message is worded to avoid the second
 * rule's `/per-day|per day|free-models-per-day|daily/i` — a burst refusal whose
 * sentence says "day" would be classified as one.
 *
 * The distinction is not cosmetic. `rotatable()` in theme/docpilot/llm.js stops
 * walking the model pool ONLY on `rateLimit.daily`, so a burst refusal correctly
 * lets the panel wait and try the next candidate, while a daily one stops it
 * from spending nine more requests to be told the same thing nine more times.
 * `defendable()` in budget.js is the other reader: a stated day is written into
 * the ledger the panel displays, and a burst window shorter than ten minutes is
 * deliberately not, because a burst limiter's `remaining: 0` is a fact about the
 * next second rather than about the day.
 *
 * The `x-ratelimit-*` values published here are THIS PROXY'S, which is the
 * honest number — it is the ceiling the reader will actually meet — and they
 * appear only on a refusal this proxy generated. Every response that reached
 * upstream carries upstream's own headers instead, unaltered.
 */
export function limitResponse(kind, decision, now = Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((decision.resetAt - now) / 1000))
    const daily = kind === 'daily'
    const message = daily
        ? `this address has used its allowance for the day at this proxy — ${decision.limit} requests`
        : `too many requests from this address — retry in ${retryAfter}s`
    return problem(
        429,
        message,
        {metadata: {limit_source: daily ? 'docpilot-proxy-daily' : 'docpilot-proxy-burst'}},
        {
            'retry-after': String(retryAfter),
            'x-ratelimit-limit': String(decision.limit),
            'x-ratelimit-remaining': '0',
            // Epoch MILLISECONDS. `resetAtOf` in budget.js reads anything past
            // 1e11 as milliseconds, past 1e9 as seconds, and smaller as a delay —
            // so a millisecond instant is unambiguous and needs no convention
            // agreed with the reader.
            'x-ratelimit-reset': String(decision.resetAt),
        },
    )
}

/**
 * One request, one upstream path.
 *
 * The order of the gates is the order of what each costs. Method, origin and key
 * are free. The buckets come next, so a refused request costs neither a body
 * read nor an upstream call — the whole point of a limiter in front of an
 * endpoint that spends money. The body cap is last before the fetch.
 *
 * BURST BEFORE DAILY, so a request refused for asking too fast does not also
 * spend one of the day's twenty.
 *
 * `upstreamPath` is passed in by the caller as a literal. It is never derived
 * from `request.url`: a path this function computes is a path this function can
 * compute wrongly, and the two handlers exist to make that impossible.
 */
export async function proxy(request, upstreamPath, env = process.env, now = Date.now()) {
    if (request.method !== 'POST') {
        return problem(405, `${request.method} not allowed — this endpoint takes POST`, {}, {allow: 'POST'})
    }
    if (!sameOrigin(request)) {
        return problem(403, 'cross-origin requests are not accepted here')
    }
    const key = env[KEY_ENV]
    if (!key) {
        // The one 503 worth distinguishing from an outage: nothing is down, a
        // variable is unset. Named, never printed — and set it on Production,
        // Preview AND Development, or every question on every preview URL
        // arrives here.
        return problem(503, `no upstream key — set ${KEY_ENV} in the deployment environment`)
    }

    const ip = clientIp(request.headers)
    const burst = take(BURST_BUCKETS, ip, BURST.limit, BURST.windowMs, now)
    if (!burst.ok) return limitResponse('burst', burst, now)
    const day = take(DAILY_BUCKETS, ip, DAILY.limit, DAILY.windowMs, now)
    if (!day.ok) return limitResponse('daily', day, now)

    const read = await readBody(request)
    if (read.tooLarge) {
        return problem(413, `request body over ${BODY_LIMIT} bytes`)
    }

    const res = await fetch(`${UPSTREAM}${upstreamPath}`, {
        method: 'POST',
        headers: upstreamHeaders(request, key),
        body: read.body,
        // The reader closed the tab or hit stop; the upstream request is still
        // running and still counted against the day. Cancelling it is the only
        // way that request is not spent on an answer nobody will read.
        signal: request.signal,
    })

    // Contract note 3, and the single line the whole streaming behaviour rests
    // on: `res.body` is handed over UNREAD. Awaiting it here — `await res.text()`
    // — is the change that turns a token-by-token answer into a blank panel and
    // then a wall of text, with nothing anywhere reporting a fault.
    return new Response(res.body, {status: res.status, headers: forwardHeaders(res.headers)})
}
