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
 * nothing without shared storage could. So the limiter is not what bounds the
 * spend: the body is. This deploy runs on PAID models, and a proxy that forwards
 * the client's body unread lets any caller pick the model, the token ceiling and
 * every routing or billing parameter on the operator's key. `shapeChat()` and
 * `shapeEmbed()` rebuild the upstream body from an allowlist instead — see them.
 * Put a hard credit limit on the OpenRouter key as well; that one is enforced
 * where the money is.
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
/**
 * WHAT THE OPERATOR'S KEY WILL PAY FOR, and the defaults are this site's config.
 *
 * `docs/.vitepress/config.mjs` names one chat model and one embedding model, and
 * the panel walks no pool beside them, so those two ids are the whole of what a
 * real reader's browser ever sends. The test beside this file asserts the
 * defaults against that export, the same way it holds the routes. A deployment
 * that changes models sets the variables — comma-separated ids — rather than
 * editing this file.
 *
 * `DOCPILOT_PROXY_MAX_TOKENS` clamps the output ceiling, and the reasoning
 * budget with it. The panel asks for 2048 (`chat.maxTokens`); 4096 leaves room
 * for an author who raises it, and nothing for a caller asking for a model's
 * maximum. A body that names no ceiling gets this one, because upstream's
 * default is the model's maximum.
 */
export const CHAT_MODELS_ENV = 'DOCPILOT_PROXY_CHAT_MODELS'
export const EMBED_MODELS_ENV = 'DOCPILOT_PROXY_EMBED_MODELS'
export const MAX_TOKENS_ENV = 'DOCPILOT_PROXY_MAX_TOKENS'
export const DEFAULT_CHAT_MODELS = ['deepseek/deepseek-v4-flash']
export const DEFAULT_EMBED_MODELS = ['qwen/qwen3-embedding-8b']
export const DEFAULT_MAX_TOKENS = 4096

/**
 * The panel embeds one string, or two on a follow-up (the question and the
 * question with its antecedent, in one request — session.js). Eight is room for
 * that and no room for a batch job.
 */
export const EMBED_INPUTS = 8

/**
 * What one chat body may carry, measured on what the panel builds — the test
 * beside this file builds every body with providers.ts itself and passes it
 * through `shapeChat`.
 *
 * TOOLS — five built-ins plus at most `MAX_TOOLS` (12, tools.ts) of the site's
 * own: seventeen. 24 is room for that, and none for a catalogue.
 *
 * MESSAGES — the system block, one line naming older questions, three pairs,
 * the addendum, the question and one observation per step (prompt.ts): about
 * twenty at `maxIterations: 4`. 64 is three times that.
 */
export const CHAT_TOOLS = 24
export const CHAT_MESSAGES = 64

export const BURST = {limit: 10, windowMs: 60 * 1000}
export const DAILY = {limit: 20, windowMs: 24 * 60 * 60 * 1000}

const BURST_BUCKETS = new Map()
const DAILY_BUCKETS = new Map()

/**
 * At most this many windows per map, and holding the bound costs O(1) a request.
 *
 * Unbounded, a warm instance keeps one daily window per address that ever
 * asked. A full sweep at a threshold is no bound: under a flood every window is
 * still open, the sweep frees nothing, and it runs over the whole map again for
 * every new key. So the Map's own order is kept equal to the order windows
 * opened — a reopened one moves to the back — and since every window in one map
 * has one length, the front is always the next to close. `sweep` drops closed
 * windows from the front and stops at the first open one; only a map that is
 * full of open windows loses its oldest early, which hands that one address a
 * fresh window rather than holding a flood's worth of memory.
 */
export const BUCKETS_MAX = 5000

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
export function take(buckets, key, limit, windowMs, now = Date.now(), cap = BUCKETS_MAX) {
    const held = buckets.get(key)
    if (!held || now >= held.resetAt) {
        buckets.delete(key)
        sweep(buckets, now, cap - 1)
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

/**
 * Drop closed windows from the front, then open ones while more than `room`
 * remain. Exported so the arithmetic is testable.
 */
export function sweep(buckets, now = Date.now(), room = Infinity) {
    for (const [key, held] of buckets) {
        if (now < held.resetAt && buckets.size <= room) break
        buckets.delete(key)
    }
    return buckets.size
}

/**
 * Who to count against.
 *
 * ON VERCEL (`process.env.VERCEL`, set at runtime), the platform's headers:
 * `x-vercel-forwarded-for` first — Vercel writes it and overwrites any the client
 * sent. `x-forwarded-for` is read as its FIRST entry — the list is
 * client-then-proxies, and reading the last entry counts every reader against
 * the edge node in front of them, which is one bucket for the whole site.
 *
 * OFF VERCEL, NO HEADER. Nothing in front is known to rewrite them, so each is
 * the client's to write, and a fresh value per request is a fresh bucket per
 * request. The key is the peer `address` the host hands `proxy()`.
 *
 * A request with no address lands in one shared `unknown` bucket deliberately:
 * that is a host that passes none or a platform that stopped setting them, and
 * one conservative bucket is a better answer than an unlimited one per caller.
 *
 * Folded by `addressKey`, so an IPv6 /64 — one line, 2^64 addresses — is one
 * client.
 */
export function clientIp(headers, env = process.env, address = null) {
    const first = (value) => (value ? String(value).split(',')[0].trim() : '')
    const raw = env?.VERCEL
        ? first(headers?.get?.('x-vercel-forwarded-for')) ||
          first(headers?.get?.('x-real-ip')) ||
          first(headers?.get?.('x-forwarded-for'))
        : address
    return addressKey(raw) || 'unknown'
}

/**
 * One client per IPv6 /64, and `::ffff:a.b.c.d` as the IPv4 it spells. The same
 * rule as `addressKey` in src/server/limits.ts, re-stated rather than imported
 * because nothing under lib/ imports the package; the test beside this file
 * holds the copies to one table. A string that is not an address is kept.
 */
export function addressKey(addr) {
    const a = String(addr ?? '')
        .trim()
        .replace(/^\[|\]$/g, '')
        .replace(/%.*$/, '')
    if (!a.includes(':')) return a
    const halves = a.split('::')
    if (halves.length > 2) return a
    const groups = (part) => {
        const out = part ? part.split(':') : []
        const last = out[out.length - 1]
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
    return `${n
        .slice(0, 4)
        .map((x) => x.toString(16))
        .join(':')}::/64`
}

/**
 * Contract note 5.
 *
 * A MISSING `Origin` IS REFUSED. The Fetch standard has a browser send `Origin`
 * on every POST, same-origin included, so the panel always carries one. A
 * request without it is `curl` or a script, and letting it through made this
 * endpoint an open gateway on the operator's key. The header is forgeable by a
 * non-browser client, so this is a speed bump; `shapeChat()` is what bounds
 * the spend. The cross-site browser case is also stopped by the absence of any
 * `access-control-allow-*` header, so a cross-origin fetch is never read.
 *
 * The host is compared against THIS request's own, never against a hard-coded
 * one, so every preview deployment — each on its own generated hostname — is
 * correct without an allowlist anyone has to remember to extend.
 */
export function sameOrigin(request) {
    const origin = request.headers.get('origin')
    if (!origin) return false
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

/** A comma-separated id list from the environment, or the default when unset. */
export function modelsFrom(env, name, fallback) {
    const raw = env?.[name]
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
}

/** The output ceiling, from the environment; a value that is not a positive integer is ignored. */
export function maxTokensFrom(env) {
    const n = Number(env?.[MAX_TOKENS_ENV])
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TOKENS
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clampInt = (v, cap) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(Math.floor(Number(v)), cap) : cap)

/**
 * The transcript, rebuilt. Three roles, because providers.ts sends an
 * observation as `user` rather than `tool` and never replays `tool_calls`; a
 * string or text parts, because an `image_url` or `file` part is a URL the
 * provider fetches and bills for, and the panel writes neither.
 */
const ROLES = ['system', 'user', 'assistant']

function shapeMessages(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return {error: 'messages must be a non-empty array'}
    if (raw.length > CHAT_MESSAGES) return {error: `messages: at most ${CHAT_MESSAGES}`}
    const messages = []
    for (const m of raw) {
        if (!isObject(m) || !ROLES.includes(m.role)) return {error: `a message role must be ${ROLES.join(', ')}`}
        const c = m.content
        const parts = Array.isArray(c) && c.length > 0 && c.every((p) => isObject(p) && p.type === 'text' && typeof p.text === 'string')
        if (typeof c !== 'string' && !parts) return {error: 'message content must be a string or text parts'}
        messages.push({role: m.role, content: parts ? c.map((p) => ({type: 'text', text: p.text})) : c})
    }
    return {messages}
}

/**
 * Function tools only. OpenRouter reads a typed entry in `tools` —
 * `{"type": "openrouter:web_search"}` — as a server tool it runs and bills for,
 * so a list copied verbatim is a list the caller can spend from.
 */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

function shapeTools(raw) {
    if (!Array.isArray(raw) || raw.length > CHAT_TOOLS) return {error: `tools must be a list of at most ${CHAT_TOOLS} function tools`}
    const tools = []
    for (const t of raw) {
        const f = isObject(t) && t.type === 'function' && isObject(t.function) ? t.function : null
        if (!f || typeof f.name !== 'string' || !TOOL_NAME.test(f.name)) {
            return {error: 'every tool must be {type: "function", function: {name, description, parameters}}'}
        }
        const fn = {name: f.name}
        if (typeof f.description === 'string') fn.description = f.description
        if (isObject(f.parameters)) fn.parameters = f.parameters
        if (typeof f.strict === 'boolean') fn.strict = f.strict
        tools.push({type: 'function', function: fn})
    }
    return {tools}
}

/** A word, or a function the body itself declares — providers.ts pins `answer` this way. */
function shapeToolChoice(raw, tools) {
    if (raw === 'auto' || raw === 'none' || raw === 'required') return {choice: raw}
    const name = isObject(raw) && raw.type === 'function' && isObject(raw.function) ? raw.function.name : null
    if (typeof name === 'string' && (tools || []).some((t) => t.function.name === name)) {
        return {choice: {type: 'function', function: {name}}}
    }
    return {error: 'tool_choice must be auto, none, required or a function named in tools'}
}

/** `text`, `json_object`, or the strict `json_schema` the answer step sends. */
function shapeFormat(raw) {
    if (isObject(raw) && (raw.type === 'json_object' || raw.type === 'text')) return {format: {type: raw.type}}
    const s = isObject(raw) && raw.type === 'json_schema' && isObject(raw.json_schema) ? raw.json_schema : null
    if (s && typeof s.name === 'string' && isObject(s.schema)) {
        const json_schema = {name: s.name, schema: s.schema}
        if (typeof s.strict === 'boolean') json_schema.strict = s.strict
        if (typeof s.description === 'string') json_schema.description = s.description
        return {format: {type: 'json_schema', json_schema}}
    }
    return {error: 'response_format must be text, json_object, or json_schema with a name and a schema'}
}

/**
 * The chat body that goes UPSTREAM, rebuilt from the one the client sent.
 *
 * Built from nothing for the reason `upstreamHeaders` is: a denylist is correct
 * only about the parameters someone thought of, and OpenRouter keeps adding
 * ones that spend money (`models`, `plugins`, `transforms`, `route`, `n`). What
 * is copied is exactly what providers.ts writes for the openai-shaped adapter,
 * and the nested parts are rebuilt the same way: messages, tools, `tool_choice`
 * and `response_format` each by the helper above it.
 * `provider` keeps `require_parameters` alone — the routing fix config.ts sends
 * — and drops every other routing key.
 *
 * Returns `{body}` or `{error}`; an error is a 400 that never reaches upstream.
 */
export function shapeChat(raw, env = process.env) {
    if (!isObject(raw)) return {error: 'body must be a JSON object'}
    const allowed = modelsFrom(env, CHAT_MODELS_ENV, DEFAULT_CHAT_MODELS)
    if (typeof raw.model !== 'string' || !allowed.includes(raw.model)) {
        return {error: `model not allowed here — this proxy serves ${allowed.join(', ')}`}
    }
    const shaped = shapeMessages(raw.messages)
    if (shaped.error) return {error: shaped.error}
    const cap = maxTokensFrom(env)
    const body = {model: raw.model, messages: shaped.messages}
    if (typeof raw.stream === 'boolean') body.stream = raw.stream
    if (body.stream && isObject(raw.stream_options)) body.stream_options = {include_usage: raw.stream_options.include_usage === true}
    if (typeof raw.temperature === 'number') body.temperature = Math.min(Math.max(raw.temperature, 0), 2)
    if (typeof raw.top_p === 'number') body.top_p = raw.top_p
    if (Number.isInteger(raw.seed)) body.seed = raw.seed
    if (typeof raw.verbosity === 'string') body.verbosity = raw.verbosity
    if (typeof raw.reasoning_effort === 'string') body.reasoning_effort = raw.reasoning_effort
    // One ceiling field, always present. `max_completion_tokens` is kept when the
    // client chose it (gpt-5 and o-series reject `max_tokens`); otherwise the
    // older name is written, with the cap when the client named none.
    if (raw.max_completion_tokens !== undefined) body.max_completion_tokens = clampInt(raw.max_completion_tokens, cap)
    else body.max_tokens = clampInt(raw.max_tokens, cap)
    if (isObject(raw.reasoning)) {
        const r = {}
        if (typeof raw.reasoning.effort === 'string') r.effort = raw.reasoning.effort
        if (typeof raw.reasoning.enabled === 'boolean') r.enabled = raw.reasoning.enabled
        if (typeof raw.reasoning.exclude === 'boolean') r.exclude = raw.reasoning.exclude
        if (raw.reasoning.max_tokens !== undefined) r.max_tokens = clampInt(raw.reasoning.max_tokens, cap)
        body.reasoning = r
    }
    if (raw.tools != null) {
        const t = shapeTools(raw.tools)
        if (t.error) return {error: t.error}
        body.tools = t.tools
    }
    if (raw.tool_choice != null) {
        const c = shapeToolChoice(raw.tool_choice, body.tools)
        if (c.error) return {error: c.error}
        body.tool_choice = c.choice
    }
    if (raw.response_format != null) {
        const f = shapeFormat(raw.response_format)
        if (f.error) return {error: f.error}
        body.response_format = f.format
    }
    if (isObject(raw.provider) && typeof raw.provider.require_parameters === 'boolean') {
        body.provider = {require_parameters: raw.provider.require_parameters}
    }
    return {body}
}

/** The embedding body, rebuilt the same way: an allowed model and at most `EMBED_INPUTS` strings. */
export function shapeEmbed(raw, env = process.env) {
    if (!isObject(raw)) return {error: 'body must be a JSON object'}
    const allowed = modelsFrom(env, EMBED_MODELS_ENV, DEFAULT_EMBED_MODELS)
    if (typeof raw.model !== 'string' || !allowed.includes(raw.model)) {
        return {error: `model not allowed here — this proxy serves ${allowed.join(', ')}`}
    }
    const input = raw.input
    const ok =
        typeof input === 'string' ||
        (Array.isArray(input) && input.length > 0 && input.length <= EMBED_INPUTS && input.every((s) => typeof s === 'string'))
    if (!ok) return {error: `input must be a string or 1–${EMBED_INPUTS} strings`}
    return {body: {model: raw.model, input}}
}

/** Which shaper each upstream path takes. A path with none is refused, never forwarded raw. */
const SHAPERS = {'/v1/chat/completions': shapeChat, '/v1/embeddings': shapeEmbed}

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
 *
 * `address` is the peer a non-Vercel host knows (`clientIp`); on Vercel the
 * platform's headers name it and the handlers pass none.
 */
export async function proxy(request, upstreamPath, env = process.env, now = Date.now(), address = null) {
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

    const ip = clientIp(request.headers, env, address)
    const burst = take(BURST_BUCKETS, ip, BURST.limit, BURST.windowMs, now)
    if (!burst.ok) return limitResponse('burst', burst, now)
    const day = take(DAILY_BUCKETS, ip, DAILY.limit, DAILY.windowMs, now)
    if (!day.ok) return limitResponse('daily', day, now)

    const read = await readBody(request)
    if (read.tooLarge) {
        return problem(413, `request body over ${BODY_LIMIT} bytes`)
    }
    const shaper = SHAPERS[upstreamPath]
    if (!shaper) return problem(500, 'no body rule for this route')
    let parsed
    try {
        parsed = JSON.parse(new TextDecoder().decode(read.body))
    } catch {
        return problem(400, 'body is not JSON')
    }
    const shaped = shaper(parsed, env)
    if (shaped.error) return problem(400, shaped.error)

    const res = await fetch(`${UPSTREAM}${upstreamPath}`, {
        method: 'POST',
        headers: upstreamHeaders(request, key),
        body: JSON.stringify(shaped.body),
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
