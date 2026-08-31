/**
 * Chat transport — RAG-SPEC 4.1, 4.6.
 *
 * Two paths, chosen once at init by capability:
 *   native   — `tools`, arguments may stream
 *   fallback — a forced JSON shape plus a strict positional parser
 *
 * WHICH SERVICE is a separate axis from which of those two paths runs, and it
 * lives entirely in providers.js. This module is about the agent's contract:
 * one call in, `{ toolCall, text, think }` out.
 */

import { TOOLS, FALLBACK_DOC } from './prompt.js'
import { providerFor } from './providers.js'
import { readLimitHeaders, classifyLimit } from './budget.js'

/**
 * What the transport throws. Every `@param {TransportError}` in the prose below
 * refers to this; it used to be a `@typedef`, which a .ts file does not read.
 */
type TransportError = Error & {
  status?: number
  retryAfterMs?: number
  rateLimit?: unknown
}

/**
 * Everything `chat()` accepts. Every key is optional because every one either
 * carries a default below or is legitimately absent — a destructured parameter
 * with no annotation would infer them all as REQUIRED, and the whole Node half
 * of this package calls in without a `signal`.
 */
export interface ChatOptions {
  provider?: string
  baseURL?: string
  model?: string
  models?: string[] | null
  apiKey?: string | null
  temperature?: number
  messages?: unknown[]
  tools?: unknown
  signal?: AbortSignal
  answerOnly?: boolean
  schema?: unknown
  citableIds?: string[] | null
  enableThink?: boolean
  maxTokens?: number
  numCtx?: number
  /** Returns whether the delta was painted — see the `emitted` flag below. */
  onDelta?: ((...args: any[]) => boolean | void) | null
  onModel?: ((...args: any[]) => void) | null
  onAbandon?: ((...args: any[]) => void) | null
  extraBody?: Record<string, unknown> | null
  tuning?: unknown
  onHeaders?: ((...args: any[]) => void) | null
  continuations?: number
  maxRequests?: number
  rotateOnParseError?: boolean
  chain?: Array<Record<string, any>> | null
  onMember?: ((...args: any[]) => void) | null
}

/**
 * Tool schemas in the shape Ollama and OpenAI-compatible servers expect.
 *
 * `citableIds` closes the gap that made a correct answer disappear from the
 * screen. The instruction says to mark claims `[1]`, `[2]` "matching the order
 * of the citations array", and gpt-4o-mini read that as the array holding the
 * markers: it returned `citations: ["1"]`, the harness found no such id in its
 * emitted set, filtered it out as a phantom, and an answer with six real sources
 * behind it ended the turn on "I couldn't find this in the docs".
 *
 * An enum makes the shape unforgeable rather than merely requested — the ids are
 * the ONLY strings the field accepts, enforced by the provider before a token of
 * it reaches us. It is the same trick the forced `answer` schema plays on weak
 * models, applied one level down. Passing nothing keeps the open `string` shape,
 * so callers with no emitted set (the capability probe) are unaffected.
 */
export function toolSchemas(citableIds = null) {
  const ids = Array.isArray(citableIds) && citableIds.length ? citableIds : null
  const citationItems = ids ? { type: 'string', enum: ids } : { type: 'string' }
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [
            k,
            k === 'citations'
              ? { type: 'array', items: citationItems, description: v }
              : k === 'k' || k === 'confidence'
                ? { type: 'number', description: v }
                : { type: 'string', description: v },
          ]),
        ),
        required: t.name === 'answer' ? ['text', 'citations', 'confidence'] : [],
      },
    },
  }))
}

/**
 * The strict, positional fallback parser — RAG-SPEC 4.6.
 *
 * No single-quote repair and no trailing-comma repair: repair becomes a
 * guardrail bypass the moment a corpus- or user-supplied string can close
 * `text` early and supply its own citations and confidence, and it corrupts
 * every legitimate apostrophe in the corpus.
 */
export function parseFallback(raw) {
  let s = String(raw || '')
  // 1. strip fences and <think>, INCLUDING an unterminated trailing one:
  // deepseek-r1 emits reasoning first, and a trace that rehearses {"tool": …}
  // would otherwise be the first balanced object.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '')
  s = s.replace(/<think>[\s\S]*$/i, '')
  s = s.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')
  s = s.trim()

  // 2. must begin at index 0 with `{`
  if (!s.startsWith('{')) return { ok: false, reason: 'could not read the response' }

  // 3. first complete balanced object, anything after it discarded
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      end = i + 1
      break
    }
  }
  if (end < 0) return { ok: false, reason: 'could not read the response' }

  try {
    const obj = JSON.parse(s.slice(0, end))
    if (!obj || typeof obj.tool !== 'string') return { ok: false, reason: 'no tool named' }
    return { ok: true, tool: obj.tool, args: obj.args || {} }
  } catch {
    return { ok: false, reason: 'could not read the response' }
  }
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }

/**
 * The value of `"text"` inside a half-written JSON object — RAG-SPEC 4.1.
 *
 * The final call is a structured-output call, so what streams is `{"text": "…"`
 * with the closing brace still minutes away. JSON.parse cannot read that, and
 * waiting for the object to close is exactly the delay streaming exists to
 * remove. This walks the one string it cares about and stops at the write head:
 * a half-written escape is dropped rather than shown, because `\u041` on screen
 * for one frame is worse than a character arriving one frame late.
 */
export function streamingAnswerText(raw) {
  const s = String(raw || '')
  const k = s.indexOf('"text"')
  if (k < 0) return ''
  const colon = s.indexOf(':', k + 6)
  if (colon < 0) return ''
  const open = s.indexOf('"', colon + 1)
  if (open < 0) return ''

  let out = ''
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"') break
    if (ch !== '\\') {
      out += ch
      continue
    }
    const esc = s[i + 1]
    if (esc === undefined) break
    if (esc === 'u') {
      const hex = s.slice(i + 2, i + 6)
      if (hex.length < 4) break
      out += String.fromCharCode(parseInt(hex, 16))
      i += 5
      continue
    }
    out += ESCAPES[esc] ?? esc
    i += 1
  }
  return out
}

/** Split a `<think>` stream out of content so it never reaches the next step. */
export function splitThink(content) {
  const think = [...String(content).matchAll(/<think>([\s\S]*?)<\/think>/gi)]
    .map((m) => m[1])
    .join('\n')
    .trim()
  return { think, rest: String(content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim() }
}

/**
 * The same split for an UNTERMINATED `<think>` — the trace a model was still
 * writing when it ran into the token ceiling, and the one `splitThink` above
 * cannot see, because it matches pairs.
 *
 * `parseFallback` has stripped this shape since deepseek-r1 arrived; the
 * strict-schema path never did, so the identical reply parsed on one transport
 * and came back `could not read the response` on the other. Raising the
 * reasoning effort makes the shape commoner — more thinking against the same
 * `maxTokens` — which is what makes it worth closing now.
 *
 * SEPARATE from `splitThink`, and applied only after a parse has already failed,
 * because stripping to end of input is destructive: an answer ABOUT reasoning
 * can carry the literal `<think>` inside its `text` string — this corpus does —
 * and repairing a reply that needed no repair would throw away a good object.
 */
export function splitOpenThink(content) {
  const s = String(content)
  const at = s.search(/<think>/i)
  if (at < 0) return { think: '', rest: s }
  return { think: s.slice(at).replace(/^<think>/i, '').trim(), rest: s.slice(0, at).trim() }
}

/** Statuses worth trying again: the request was fine, the far end was not. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 4

/**
 * Statuses worth trying the NEXT MODEL for — a wider set, and deliberately so.
 *
 * Retrying is a bet that the same model will behave differently in a second;
 * rotating is a bet that a DIFFERENT model will behave differently now. That
 * makes the permanent-looking failures rotatable and only them: a 404 is a model
 * the catalogue has retired, a 402 is one that has left the free tier, a 400 is
 * one that will not take the strict `response_format` the final step sends, and
 * a 403 is a moderation refusal another model may not repeat.
 *
 * 401 is absent on purpose. A rejected key rejects every model in the pool, so
 * rotating turns one clear "your key is wrong" into N pointless requests and a
 * final error about whichever model happened to be last.
 */
const ROTATABLE = new Set([400, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504])

/**
 * Attempts per model while there is another model this call can REACH: ONE.
 *
 * The pool is the retry. Waiting is what you do when the only model you have is
 * busy, and `retry-after` on a saturated free tier is routinely tens of seconds
 * — which is a reader watching a spinner while nine other models sit idle. The
 * last candidate still gets the full retry budget, because at that point waiting
 * is the only thing left that can work — and a REQUEST CEILING can make that
 * candidate the first one, which is what `reachable` is for. Exactly one
 * candidate per call waits, whatever the ceiling; the ceiling only decides which.
 */
const POOL_ATTEMPTS = 1

/** How long a model that just failed goes to the back of the queue. */
const COOLDOWN_MS = 60000

/**
 * @typedef {{limit?: number, remaining?: number, resetAt?: number, daily: boolean}} RateLimit
 * The transport's error — see the `TransportError` type below, which is now
 * the declaration rather than this line.
 */

/**
 * @param {string} message
 * @param {number} status
 * @returns {TransportError}
 */
function statusError(message: string, status: number): TransportError {
  const e: TransportError = new Error(message)
  e.status = status
  return e
}

/** `retry-after`, in milliseconds, or undefined — the service's own number. */
function retryAfterOf(headers) {
  const n = Number(headers?.get?.('retry-after'))
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined
}

/** An instant `ms` from `now`, or undefined when nothing said how long. */
const after = (now, ms) => (ms ? now + ms : undefined)

/**
 * WHAT THIS RESPONSE SAID ABOUT THE LIMIT — asked once, and once only.
 *
 * Three things downstream turn on the answer: whether to wait and try again,
 * whether the error that comes out of here is the day's rather than the
 * minute's, and what the budget ledger writes down. They used to ask
 * separately — this file consulting `limit_source`, the message and then the
 * headers; budget.js consulting the reset alone — and on one real response they
 * disagreed: a 429 with `limit_source: 'daily'`, `free-models-per-day`,
 * `remaining: 0` and `retry-after: 120` ended the turn as rate-limited here and
 * was dropped as "about a minute" there, so the panel said "out of free answers
 * until …" beside "5 of 50 left today" and the next question planned a full
 * agentic walk into a spent day.
 *
 * So `classifyLimit` in budget.js decides and everything reads that one verdict.
 * The classification travels WITH the response: computed here, handed to the
 * ledger through `onHeaders`, and handed to `rateLimitOf` to build the error.
 *
 * The body is read through `clone()` so the caller still gets an unread
 * response, and only for a 429 — no other status carries an error body worth
 * reading, and consuming a 200's body here would take the answer with it. A
 * response that cannot be cloned or is not JSON is classified from its headers,
 * which is the burst behaviour that shipped.
 *
 * @returns {Promise<'daily'|'burst'|'unknown'>}
 */
async function classifyResponse(res) {
  const now = Date.now()
  // The headers first and outside the try: a response whose body cannot be
  // cloned still carries them, and `remaining: 0` with tomorrow's reset beside
  // it is a spent day whatever the body turned out to be.
  const limits = readLimitHeaders(res?.headers, now)
  let payload = null
  if (res?.status === 429) {
    try {
      payload = await res.clone().json()
    } catch {
      /* an HTML error page from a proxy — the headers are all there is */
    }
  }
  return classifyLimit(
    {
      payload,
      remaining: limits?.remaining,
      // `retry-after` stands in for the reset when the service sent one and no
      // reset: a wrong-looking timestamp is worse than none, so nothing is
      // invented beyond what one of the two actually stated.
      resetAt: limits?.resetAt ?? after(now, retryAfterOf(res?.headers)),
    },
    now,
  )
}

/**
 * What a 429 actually said, as opposed to what it looked like.
 *
 * The two 429s a free tier sends are nothing alike. The common one is a burst
 * limit that lifts in a second or two, and every mechanism in this file already
 * handles it: wait, or ask the next model. The other one is the DAY, and none of
 * those mechanisms can help — every model in the pool shares the same allowance,
 * so rotating spends nine more requests to be told the same thing nine more
 * times, and the reader is shown a transport error for a service that is working
 * perfectly and knows exactly when it will answer again.
 *
 * `daily` is not decided here: `kind` is the verdict `classifyResponse` already
 * reached on this same response, passed in rather than recomputed.
 */
function rateLimitOf(res, retryAfterMs, kind) {
  const now = Date.now()
  const limits = readLimitHeaders(res?.headers, now)
  return {
    limit: limits?.limit,
    remaining: limits?.remaining,
    // The reset the caller is shown, not just the one the headers carried: a
    // service that answered with `retry-after` and nothing else has still said
    // when it comes back, and a day never comes back in twenty seconds.
    resetAt: limits?.resetAt ?? after(now, retryAfterMs),
    daily: kind === 'daily',
  }
}

/**
 * A completed response's headers, handed to whoever is keeping the budget —
 * with what this response turned out to be beside them.
 *
 * The ledger cannot read a body and this side already has: a daily 429 that
 * states its count and names no reset is indistinguishable from a burst one
 * through the headers alone, and that response is the whole of F4. `kind` is
 * optional because the capability probe reports headers too and has no verdict
 * to pass; budget.js classifies from the headers when nobody hands it one.
 *
 * Inside a try, always: the ledger is bookkeeping and the answer is the product,
 * so a storage quota or a thrown listener must not be able to lose a reply that
 * has already been paid for.
 */
function reportHeaders(onHeaders, res, kind?: string) {
  if (!onHeaders) return
  try {
    onHeaders(res.headers, kind)
  } catch {
    /* see above */
  }
}

/**
 * A transport failure with no status is a network failure — DNS, TLS, a dropped
 * connection — and the next model is served from the same host, so rotating is
 * pointless. `AbortError` reaches here too when a step times out, and the next
 * model would inherit an already-aborted signal.
 */
/** @param {TransportError} e */
function rotatable(e) {
  if (!e || e.name === 'AbortError' || e.name === 'TimeoutError') return false
  // The DAY's allowance belongs to the ACCOUNT, not to the model, so every
  // candidate behind it is refused by the same counter. Rotating out of one
  // spends nine more requests to be told the same thing nine more times, and
  // ends on whichever model happened to be last — a transport error, for a
  // service that is working perfectly and has already said when it will answer
  // again. This is the one 429 the pool cannot rescue, and `rateLimitOf` exists
  // to tell the two apart.
  if (e.rateLimit?.daily) return false
  return ROTATABLE.has(e.status)
}

/**
 * Which model answered last, per endpoint, and which ones just refused.
 *
 * Module scope rather than session state, because the fact being remembered is
 * about the SERVICE, not about the conversation: a free id that is saturated is
 * saturated for the next thread too, and a reader who opens a second panel
 * should not re-discover it. Cleared by a reload, which is the right lifetime —
 * the free pool's composition changes on that scale.
 */
const POOLS = new Map()

function poolFor(provider, baseURL) {
  const key = `${provider}|${baseURL}`
  let pool = POOLS.get(key)
  if (!pool) {
    pool = { sticky: null, cooldown: new Map() }
    POOLS.set(key, pool)
  }
  return pool
}

/** @param {{sticky: string|null, cooldown: Map<string, number>}} pool
 *  @param {string} model
 *  @param {TransportError} e */
function cool(pool, model, e) {
  // The server's own number when it sent one — a 429 carrying `retry-after: 1`
  // is a model that is free again in a second, and a flat minute of exile would
  // spend the rest of the pool for nothing.
  const ms = Number.isFinite(e?.retryAfterMs) ? e.retryAfterMs : COOLDOWN_MS
  pool.cooldown.set(model, Date.now() + Math.max(1000, ms))
  if (pool.sticky === model) pool.sticky = null
}

/**
 * The order to try models in — pure, so the policy is testable without a socket.
 *
 * Cooling models are moved to the BACK rather than removed. A pool where every
 * member is cooling is exactly the moment a reader is waiting, and answering
 * "no models available" while ten of them would have answered is the failure
 * this feature exists to prevent.
 */
export function orderCandidates(
  models,
  { sticky = null, cooldown = null, now = Date.now(), primary = null } = {},
) {
  const list = []
  for (const m of models) if (m && !list.includes(m)) list.push(m)
  const cooling = (m) => cooldown?.get(m) > now

  // `primary` OUTRANKS `sticky`, and that ordering is the difference between a
  // pool and a demotion. `chat: {model: 'anthropic/claude-…', models: ['…:free']}`
  // is documented as a paid primary with free understudies — but one transient
  // failure used to make an understudy sticky, and sticky went to the front
  // unconditionally, so the model the author actually chose was never asked
  // again for the life of the page. It leads unless it is itself cooling.
  const lead = []
  if (primary && list.includes(primary) && !cooling(primary)) lead.push(primary)
  if (sticky && sticky !== primary && list.includes(sticky) && !cooling(sticky)) lead.push(sticky)

  const rest = list.filter((m) => !lead.includes(m))
  if (!cooldown || !cooldown.size) return [...lead, ...rest]
  // Cooling models go to the BACK rather than out: a pool where every member is
  // cooling is exactly the moment a reader is waiting.
  return [...lead, ...rest.filter((m) => !cooling(m)), ...rest.filter(cooling)]
}

/** Test seam: forget every sticky choice and every cooldown, model and service. */
export function resetPools() {
  POOLS.clear()
  LADDER.clear()
}

/**
 * Retry a transport failure, honouring `Retry-After`.
 *
 * A 429 is not a refusal and not a model failure — measured against a shared
 * free pool on OpenRouter, three of four records died with `chat 429` and a
 * `retry-after: 1`, which recorded a rate limit as though the model had failed
 * to answer. For a reader it is worse: a momentarily busy provider turns a good
 * question into an error message.
 *
 * The delay comes from the server when it sends one, because the server knows
 * when its pool frees up and exponential backoff only guesses. The caller's
 * abort signal wins over any wait.
 *
 * It returns the response AND what that response said about the limit, because
 * the caller needs the second to build its error and re-deriving it there is how
 * two readings of one response start disagreeing. Classified before it is
 * reported, so the ledger is told the same thing the retry decision was made on.
 */
async function fetchWithRetry(url, init, attempt = 1, maxAttempts = MAX_ATTEMPTS, onHeaders = null) {
  const res = await fetch(url, init)
  const kind = await classifyResponse(res)
  // Every response the transport completes, reported to whoever is keeping the
  // budget — and the retried attempts too, because a 429 is the most
  // informative response of the lot: it is the one that states what is left and
  // when it comes back.
  reportHeaders(onHeaders, res, kind)
  if (res.ok || !RETRYABLE.has(res.status) || attempt >= maxAttempts) return { res, kind }
  if (init.signal?.aborted) return { res, kind }
  // A day does not lift in twenty seconds, and every attempt spent finding that
  // out is a request the reader does not have.
  if (res.status === 429 && kind === 'daily') return { res, kind }

  const stated = retryAfterOf(res.headers)
  const waitMs = stated ? Math.min(stated, 20000) : Math.min(500 * 2 ** (attempt - 1), 8000)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs)
    init.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
  return fetchWithRetry(url, init, attempt + 1, maxAttempts, onHeaders)
}

/**
 * The shortest overlap worth treating as a repetition rather than a coincidence,
 * and the longest tail worth looking for one in.
 *
 * Twenty-four characters is past the length any two sentences share by accident,
 * and well short of the length a model repeats when it restarts. The ceiling
 * keeps the scan linear on an answer of any size.
 */
const SEAM_MIN = 24
const SEAM_MAX = 2000

/**
 * Two halves of one reply, joined so that the seam cannot be found afterwards.
 *
 * A continuation is a prefill: the truncated text goes back as the last
 * assistant message and the model carries on from inside it. Services that
 * support that return only what comes next and this is a plain concatenation.
 * Services that do not treat the prefill as context and start the reply again —
 * and a doubled paragraph, or a second `{"text": …` opening beside the first,
 * is a worse answer than the truncated one it was supposed to rescue. So a tail
 * of what we already have, repeated at the head of what arrived, is dropped.
 *
 * The floor is what keeps this honest: below it, a match is two sentences ending
 * and starting the same way, and cutting there would delete a word the reader
 * was owed.
 */
function joinFragment(head, fragment) {
  if (!head) return fragment
  if (!fragment) return head
  const max = Math.min(head.length, fragment.length, SEAM_MAX)
  for (let k = max; k >= SEAM_MIN; k--) {
    if (fragment.startsWith(head.slice(-k))) return head + fragment.slice(k)
  }
  return head + fragment
}

/** Token counts from every request a reply took, so a turn is charged for all of them. */
function addUsage(total, next) {
  if (!next) return total
  if (!total) return { promptTokens: next.promptTokens || 0, outputTokens: next.outputTokens || 0 }
  return {
    promptTokens: total.promptTokens + (next.promptTokens || 0),
    outputTokens: total.outputTokens + (next.outputTokens || 0),
  }
}

/**
 * One model call — or, when a POOL is configured, one model call per candidate
 * until one of them answers.
 *
 * `model` is still the single name an author wrote down and is still tried
 * first. `models` is the ordered pool behind it, and it exists for exactly one
 * service shape: OpenRouter's free tier, where a 429 says nothing about the
 * model and everything about who else is asking. Rotation is off unless a caller
 * passes a pool, so every other provider posts the same request it always did.
 *
 * FOUR THINGS STOP THE ROTATION, and each is a case where continuing is worse
 * than failing: the reader pressed stop, a delta has already been painted (half
 * an answer plus a second model's opening line is not an answer), a failure that
 * the next model would repeat — a bad key, a dropped connection, a step that ran
 * out of time — and the turn running out of REQUESTS.
 *
 * `maxRequests` is that last one and it is the only budget this module keeps.
 * Every completed response is charged against it, retries and continuations
 * included, and when it is gone the walk stops and the best reply so far is
 * returned rather than a better one being shopped for. It exists because
 * rotation and the iteration ceiling were orthogonal: a turn rationed to "one
 * request" could still walk a ten-member pool with a continuation each, twenty
 * requests against the fifteen that triggered the rationing. Absent, or
 * Infinity, is the behaviour that shipped.
 *
 * A reply may also take MORE than one request. `continuations` is how many
 * follow-ups a truncated reply may spend; the fragments are reassembled here and
 * nothing downstream can tell that it happened — see `once` below for what that
 * costs. `rotateOnParseError` decides whether a reply in the wrong SHAPE costs a
 * model its turn the way an empty one does; it is on unless a caller says
 * otherwise, and it governs only the rotation. A misshapen reply is never a
 * model's REWARD either way — see the accept path below.
 *
 * `onDelta` RETURNS whether it painted anything. llm.js cannot know: the final
 * call streams a JSON object and the consumer shows the value of one key inside
 * it, so a model answering in prose streams frames all the way to the end and
 * puts nothing on the screen. Setting `emitted` on the arrival of a frame made
 * the guard fire for every streamed reply, which switched the whole
 * prose-rotation fix off in the browser and left it working only for the callers
 * that do not stream.
 *
 * `onAbandon` is the other half of that seam, and it fires with the name of each
 * candidate this walk GIVES UP ON. What a rotation invalidates is not only the
 * text: a model that streamed two frames of reasoning and was then rotated past
 * left them on screen under the WINNER's answer, with a thoughtSeconds count,
 * because the consumer's "a call is starting" event fires once per chat() call
 * and never between candidates inside one. Whether that reasoning was ever
 * displayed is the consumer's business; that the model it belonged to is not
 * going to answer is knowable only here, at the rotation point.
 *
 * Two options exist only so that something else can do its job. `extraBody` is
 * the brand-specific fragment the adapter merges beneath the fields it owns —
 * the client knows adapters, not brands, so a brand's needs travel as data.
 * `onHeaders` is called with the headers of every COMPLETED response: success or
 * 429, every retried attempt, every candidate a pool walks through, every
 * continuation. A rate-limit budget is learned there for free, and counted
 * exactly, which is the difference between stating what is left and guessing it.
 *
 * @returns {Promise<{ toolCall: {name: string, args: any}|null, text: string,
 *   think: string, model?: string, usage?: any, parseError?: string }>}
 */
export async function chat(options: ChatOptions) {
  const {
  provider = 'ollama',
  baseURL,
  model,
  models = null,
  apiKey,
  temperature,
  messages,
  tools,
  signal,
  answerOnly = false,
  schema = null,
  citableIds = null,
  enableThink = undefined,
  maxTokens = undefined,
  numCtx = undefined,
  onDelta = null,
  onModel = null,
  onAbandon = null,
  extraBody = null,
  /**
   * The connector record: the author's neutral request, already clamped to what
   * the configured service accepts and carrying a body SHAPE rather than a
   * brand. Passed through untouched, exactly like `extraBody` — this module is
   * about the agent's contract, and which field a level becomes is an adapter's
   * business.
   */
  tuning = null,
  onHeaders = null,
  continuations = 0,
  maxRequests = Infinity,
  rotateOnParseError = true,
  /**
   * THE SET OF SERVICES that may answer this call, in the order to ask them —
   * `chat.chain` resolved, and the provider-level form of `models`.
   *
   * A member is self-contained: `{provider, baseURL, model, models, extraBody,
   * tuning}`, each already clamped to what that service accepts. The scalars
   * above stay the whole call when this is absent or holds one member, which is
   * every pinned provider and every environment with one key — the same requests
   * in the same order, to the byte.
   */
  chain = null,
  /** Which member answered, once one has. */
  onMember = null,
  } = options
  // Streaming is a display concern only: the reassembled message is identical
  // either way, so a caller that passes no onDelta gets the old single response
  // and every guardrail downstream reads the same object it always did.
  const streaming = typeof onDelta === 'function'

  // A JSON schema, when one is supplied, beats a tool definition on weak models:
  // measured, qwen3:8b offered only the `answer` tool still replied in prose,
  // and prose carries no citations, so a good answer landed on a refusal.
  const toolSpec = tools
    ? answerOnly
      ? toolSchemas(citableIds).filter((t) => t.function.name === 'answer')
      : toolSchemas(citableIds)
    : null

  /**
   * The services to ask, in order — one, or the resolved set.
   *
   * A single-member `chain` collapses to the scalars deliberately rather than
   * being walked as a set of one: the two are the same request, and the scalar
   * path is the one every pinned deployment has been running.
   */
  const targets =
    chain && chain.length > 1
      ? chain.map((m) => ({
          provider: m.provider,
          baseURL: m.baseURL,
          model: m.model,
          models: m.models,
          // A member may carry its own credential where one exists at all. In a
          // browser none does — every hosted member is reached through a
          // same-origin path and the reverse proxy attaches the key — so this
          // falls to the call's own, which is what a Node caller passes.
          apiKey: m.apiKey ?? apiKey,
          extraBody: m.extraBody ?? null,
          tuning: m.tuning ?? null,
          // Carried rather than used here: nothing in this file rations, and the
          // turn's record of WHICH rung answered is the one place the difference
          // between a billed account and a free catalogue is worth keeping.
          freePool: Boolean(m.freePool),
        }))
      : [{ provider, baseURL, model, models, apiKey, extraBody, tuning, freePool: false }]

  /**
   * The turn's requests, counted where they are actually charged.
   *
   * Every COMPLETED response, whatever its status — a 429 is spent, a retried
   * attempt is spent, a continuation is spent. A request that never got a
   * response is not: a dropped connection costs the reader nothing but time.
   * This is the same event `onHeaders` reports, so what the harness counts and
   * what this bounds are the same number by construction.
   *
   * WHAT IT BOUNDS is the candidate walk and the continuations — the requests
   * that buy a BETTER answer — and not the attempts a 429 costs. Those are
   * different bets. Rotating and continuing spend a request that would otherwise
   * have answered somebody's next question, which is the luxury a thin budget
   * cannot afford; retrying a burst limit spends one that was refused, on the
   * only path to AN answer at all, and the alternative is a failed turn the
   * reader asks again anyway. Measured against the live pool, three of four
   * failures were a 429 with `retry-after: 1` — a turn that gave up on those
   * would fail most of the last quarter of every day.
   */
  let spent = 0
  // `kind` is carried through untouched. Dropping it here is invisible — the
  // ledger simply falls back to classifying from the headers — and it is exactly
  // how a daily 429 that names no reset goes on being recorded as a minute's.
  const meter = (headers, kind) => {
    spent++
    onHeaders?.(headers, kind)
  }
  /**
   * The floor of one is the CALLER'S LAST-RESORT GUARANTEE, not a rounding.
   *
   * harness.js reserves a request for the forced final call and stops its loop
   * one short, so a ceiling below one only ever reaches here on that call, and
   * only when retries — which are outside the ceiling by decision, see above —
   * overdrew the turn. Making no request there would end the turn on "I couldn't
   * find this in the docs" to save one request, which is the reader's question
   * spent to protect their quota. A loop call that cannot be afforded is simply
   * never issued, one level up, where the turn's arithmetic is known.
   */
  const ceiling = Number.isFinite(maxRequests) ? Math.max(1, maxRequests) : Infinity
  /** Whether one more request may be issued at all. */
  const affordable = () => spent < ceiling
  /**
   * Whether the NEXT candidate can actually be reached from here: one exists,
   * and the turn can still pay for the request that would reach it.
   *
   * It decides one attempt (the pool is the retry) or four with waits of up to
   * twenty seconds each, and BOTH halves have to be in it. `!last` alone was a
   * bet that rotation is available, and on a rationed turn that bet is simply
   * false: at a ceiling of one the first candidate got a single attempt, the
   * catch below then found `affordable()` already spent, and the turn died
   * having neither waited nor rotated — measured, a turn at six answers left
   * whose forced final call met a burst 429 that lifted a second later spent two
   * requests and returned `text: ""`, which the harness reports to the reader as
   * "I couldn't find this in the docs" about a service that answered one second
   * later. Three of four measured live failures are exactly that 429.
   *
   * `spent + 1`, not `spent`: the request about to be issued is one the ceiling
   * counts, so what has to be affordable is the one AFTER it. That is the same
   * arithmetic the sentence at the call site describes — a model still in
   * reserve, and a request left to reach it with.
   *
   * IT DOES NOT BUY MORE RETRIES WHEN THIN, which is the other way this line has
   * been wrong. Exactly one candidate per call gets the wait budget: the last
   * one the ceiling can reach. A thinner ceiling makes that candidate come
   * sooner, never makes the retrying wider — measured against a pool of three
   * with every response a 429, ceiling 1 spends 4 requests, ceiling 2 spends 5,
   * and an unrationed call spends 6. Thinner is cheaper at every step, which is
   * the property the ceiling is there for.
   */

  /**
   * WHETHER ANYTHING HAS REACHED THE SCREEN, for the whole call rather than for
   * one model.
   *
   * A candidate that painted a word owns the answer: rotating past it would make
   * the reader watch a half-written paragraph vanish and a different one grow in
   * its place. That is as true across services as within one, and this is the
   * flag that carries the rule over the member boundary.
   */
  let painted = false

  /**
   * ONE SERVICE, walked to the end of its pool — the whole of what this function
   * did before a set could be configured.
   *
   * `finalMember` is the second half of `reachable`: with another service still
   * to ask, waiting out a rate limit here is the wrong trade for the same reason
   * it is wrong with another model still to ask.
   */
  async function walkOne(target, finalMember) {
    const p = providerFor(target.provider)
    const pool = poolFor(target.provider, target.baseURL)
    const candidates = orderCandidates([target.model, ...(target.models || [])], {
      ...pool,
      primary: target.model || null,
    })
    if (!candidates.length) throw new Error('chat — no model configured')
    const rotating = candidates.length > 1
    /**
     * Whether the NEXT candidate can actually be reached from here: one exists,
     * and the turn can still pay for the request that would reach it.
     *
     * It decides one attempt (the pool is the retry) or four with waits of up to
     * twenty seconds each, and BOTH halves have to be in it. `!last` alone was a
     * bet that rotation is available, and on a rationed turn that bet is simply
     * false: at a ceiling of one the first candidate got a single attempt, the
     * catch below then found `affordable()` already spent, and the turn died
     * having neither waited nor rotated — measured, a turn at six answers left
     * whose forced final call met a burst 429 that lifted a second later spent
     * two requests and returned `text: ""`, which the harness reports to the
     * reader as "I couldn't find this in the docs" about a service that answered
     * one second later. Three of four measured live failures are exactly that
     * 429.
     *
     * `spent + 1`, not `spent`: the request about to be issued is one the ceiling
     * counts, so what has to be affordable is the one AFTER it. That is the same
     * arithmetic the sentence at the call site describes — a model still in
     * reserve, and a request left to reach it with.
     *
     * IT DOES NOT BUY MORE RETRIES WHEN THIN, which is the other way this line
     * has been wrong. Exactly one candidate per call gets the wait budget: the
     * last one the ceiling can reach. A thinner ceiling makes that candidate come
     * sooner, never makes the retrying wider — measured against a pool of three
     * with every response a 429, ceiling 1 spends 4 requests, ceiling 2 spends 5,
     * and an unrationed call spends 6. Thinner is cheaper at every step, which is
     * the property the ceiling is there for.
     *
     * ANOTHER SERVICE COUNTS AS SOMEWHERE TO GO. The last candidate of a member
     * that is not the last member has one more place to be asked, so it waits no
     * longer than a candidate with a sibling does.
     */
    const reachable = (last) => ((rotating && !last) || !finalMember) && spent + 1 < ceiling

    let lastError = null
    for (let i = 0; i < candidates.length; i++) {
      const chosen = candidates[i]
      const last = i === candidates.length - 1 && finalMember
      // Whether anything reached the SCREEN under this model — which is a question
      // only the consumer can answer, so `onDelta` answers it. The flag has to be
      // per-candidate: a first model that painted nothing leaves the panel clean
      // for the second, and a first model that painted something does not.
      let emitted = false
      const delta = streaming
        ? (d) => {
            if (onDelta(d)) {
              emitted = true
              painted = true
            }
          }
        : null

      let out
      try {
        out = await once(chosen, delta, last)
      } catch (e) {
        lastError = e
        if (signal?.aborted || emitted || last || !rotating || !affordable() || !rotatable(e)) throw e
        onAbandon?.(chosen)
        cool(pool, chosen, e)
        continue
      }

      // A 200 carrying neither a tool call nor a word of text is a model that did
      // not answer — providers.js records one doing exactly that, 1202 output
      // tokens against an empty `content`. Reported as an answer it becomes "I
      // couldn't find this in the docs" about a corpus that was never consulted,
      // so it costs the model its turn instead.
      const silent = !out.toolCall && !String(out.text || '').trim()

      // A reply that is text but not the SHAPE that was asked for is the same
      // failure in better clothes, and it was the commoner one: measured against
      // the live free pool, six of ten members answered the strict final call in
      // prose. Prose carries no citations, so the harness lands it on
      // `not-answerable` — the request is spent and a perfectly good answer is
      // thrown away. Rotating costs one more request and buys an answer.
      const wrong = silent || Boolean(out.parseError)
      const worthRotating = silent || (Boolean(out.parseError) && rotateOnParseError !== false)

      // `!last` rather than `rotating && !last`: with another SERVICE still to
      // ask, a member whose only model answered in prose has somewhere to go even
      // though its own pool is exhausted. The two are the same test wherever there
      // is one member, which is where this line has always run.
      if (wrong && worthRotating && !last && !emitted && affordable()) {
        lastError = statusError(
          silent
            ? `chat — "${chosen}" returned an empty reply`
            : `chat — "${chosen}" answered outside the requested shape`,
          silent ? 204 : 422,
        )
        onAbandon?.(chosen)
        cool(pool, chosen, lastError)
        continue
      }

      onModel?.(chosen)

      /**
       * KEPT, NOT REWARDED.
       *
       * A reply kept because there was nowhere left to go — no candidate, no
       * request to reach one with — is still a reply that did not answer as asked,
       * and `pool.sticky` is module scope: it outlives the turn, the thread and the
       * panel. Marking one sticky here put the prose-answering member at the FRONT
       * of every later call, cleared the cooldown that would have moved it back,
       * and kept it there into the next day, when the budget was full again and
       * rotating past it was free. So it is cooled on exactly the terms the
       * rotating branch above cools it, and the pool chooses again next time.
       *
       * The reply itself is returned unchanged: the harness reads `parseError` and
       * can explain the turn it ends, where an invented transport failure would
       * put "the AI service didn't respond" on a service that answered.
       */
      if (wrong) {
        cool(pool, chosen, statusError(`chat — "${chosen}" did not answer as asked`, 422))
        return { ...out, model: chosen, provider: target.provider }
      }

      pool.sticky = chosen
      pool.cooldown.delete(chosen)
      return { ...out, model: chosen, provider: target.provider }
    }
    throw lastError || new Error('chat — no model in the pool answered')

    /**
     * One model's whole reply, however many requests it took to get it.
     *
     * A provider that stops at its output ceiling says so — `finish_reason:
     * 'length'` — and hands back an answer cut off mid-word. On the final call
     * that answer is a half-written JSON object, so JSON.parse fails, the reply
     * becomes a parse error, and the turn ends on "I couldn't find this in the
     * docs" about an answer that was three quarters written. One more request
     * finishes it.
     *
     * THE SEAM MUST BE INVISIBLE, and that is the whole difficulty. Three things
     * make it so: the fragments are concatenated BEFORE anything reads them, so
     * `JSON.parse` and the fallback parser see one document and never a half of
     * one; `usage` is summed, because the harness charges a turn once per reply
     * and tokens spent on a second request would otherwise vanish from the
     * accounting; and each fragment's deltas are re-based onto what came before,
     * because the panel re-renders the answer from `contentSoFar` on every frame
     * and a second request's counter starts at zero — un-rebased, the reader would
     * watch the answer collapse to its own last paragraph mid-sentence.
     *
     * A TOOL CALL IS NEVER CONTINUED. Its arguments arrive as a JSON string that
     * the adapter has already parsed and discarded on failure, so there is no
     * partial to prefill — and the loop step it belongs to is cheap to repeat.
     */
    async function once(chosen, onFrame, last) {
      let content = ''
      let thinking = ''
      let usage = null
      let toolCall = null
      let left = Math.max(0, Math.trunc(Number(continuations) || 0))

      for (;;) {
        const reply = await send(chosen, rebase(onFrame, content), last, content)
        content = joinFragment(content, reply.content || '')
        thinking += reply.thinking || ''
        usage = addUsage(usage, reply.usage)
        if (reply.toolCall) toolCall = reply.toolCall
        // Nothing to carry on FROM is the case that would otherwise loop: a model
        // that hit its ceiling on reasoning alone has written no answer text, and
        // prefilling nothing just asks the same question again. `affordable` is
        // the same ceiling the rotation obeys: a retried 429 inside this call has
        // already spent what the continuation was going to.
        if (toolCall || left <= 0 || !affordable()) break
        if (reply.finishReason !== 'length' || !content.trim()) break
        left--
      }

      // qwen3 on Ollama returns reasoning in a separate field; deepseek-r1 through
      // the fallback transport inlines it as <think> tags in the content. Both are
      // stripped from what the next step sees.
      const { think: inline, rest } = splitThink(content)
      const think = (thinking || inline || '').trim()

      if (toolCall) return { toolCall, text: rest, think, usage }

      if (schema) {
        try {
          return { toolCall: { name: 'answer', args: JSON.parse(rest) }, text: '', think, usage }
        } catch {
          // WHAT ARRIVED FIRST, THE REPAIR SECOND. See `splitOpenThink`: a reply
          // whose reasoning was cut off mid-trace leaves an unterminated `<think>`
          // that no pair-matching strip can see, and it is the only thing standing
          // between this object and a parse. Trying it before the plain parse would
          // mangle a good answer that merely mentions the tag.
          const open = splitOpenThink(rest)
          if (open.think) {
            try {
              return {
                toolCall: { name: 'answer', args: JSON.parse(open.rest) },
                text: '',
                think: [think, open.think].filter(Boolean).join('\n').trim(),
                usage,
              }
            } catch {
              /* fall through to the same parse error the plain attempt produced */
            }
          }
          return { toolCall: null, text: rest, think, usage, parseError: 'could not read the response' }
        }
      }

      if (!tools) {
        const parsed = parseFallback(rest)
        if (parsed.ok) return { toolCall: { name: parsed.tool, args: parsed.args }, text: '', think, usage }
        return { toolCall: null, text: rest, think, usage, parseError: parsed.reason }
      }

      return { toolCall: null, text: rest, think, usage }
    }

    /**
     * A continuation's deltas, renumbered as though they had always been part of
     * one reply. `contentSoFar` is the panel's whole answer, not an increment, so
     * a fragment that starts its own count has to be told where it starts.
     */
    function rebase(onFrame, head) {
      if (!onFrame || !head) return onFrame
      return (d) => onFrame(d?.contentSoFar == null ? d : { ...d, contentSoFar: head + d.contentSoFar })
    }

    /** One request. `prefill` is the reply so far when this is a continuation of it. */
    async function send(chosen, onFrame, last, prefill) {
      const body = p.body({
        model: chosen,
        // The partial reply goes back as the last assistant message and the model
        // carries on from inside it. `continuing` tells the adapter to stop
        // forcing a response shape while it does — under a strict schema the
        // completion has to be a whole valid object on its own, so the model would
        // start the answer again and truncate in the same place.
        messages: prefill ? [...messages, { role: 'assistant', content: prefill }] : messages,
        temperature,
        streaming,
        schemaBody: schema,
        enableThink,
        maxTokens,
        numCtx,
        tools: toolSpec,
        // THE MEMBER'S OWN body fragment and tuning record, not the call's. One
        // neutral request goes in and each service gets the spelling it accepts:
        // config.js has already clamped every member separately, so a chain whose
        // second entry cannot take `topP` carries a record that does not mention
        // it.
        extraBody: target.extraBody,
        tuning: target.tuning,
        continuing: Boolean(prefill),
      })

      const { res, kind } = await fetchWithRetry(
        p.chatUrl(target.baseURL),
        {
          method: 'POST',
          headers: p.headers(target.apiKey),
          body: JSON.stringify(body),
          signal,
        },
        1,
        // With a model still in reserve — and a request left to reach it with —
        // waiting out a rate limit is the wrong trade: the next one is a single
        // request away. Once the turn cannot afford a second candidate, waiting is
        // again the only thing left that can work, exactly as it is for a
        // deployment that never had a pool.
        reachable(last) ? POOL_ATTEMPTS : MAX_ATTEMPTS,
        meter,
      )
      // Name a rate limit as a rate limit. Reported as a bare status it reads in the
      // eval as though the model failed to answer, which is the opposite of true:
      // the request never reached a model.
      if (res.status === 429) {
        const err = statusError(
          rotating
            ? `chat 429 — "${chosen}" is rate limited`
            : `chat 429 — rate limited by the provider after ${MAX_ATTEMPTS} attempts`,
          429,
        )
        err.retryAfterMs = retryAfterOf(res.headers)
        // The verdict the transport already reached on this response, not a second
        // reading of it: `daily` decides whether the pool is walked and whether
        // session.js settles the turn as rate-limited, and those must not be able
        // to disagree with what the ledger was told a moment ago.
        err.rateLimit = rateLimitOf(res, err.retryAfterMs, kind)
        throw err
      }
      if (!res.ok) throw statusError(`chat ${res.status} — model "${chosen}"`, res.status)
      return streaming && res.body ? await p.readStream(res, onFrame) : p.parse(await res.json())
    }
  }

  const order = orderMembers(targets, { cooldown: LADDER })
  let memberError = null
  for (let i = 0; i < order.length; i++) {
    const target = order[i]
    const finalMember = i === order.length - 1
    try {
      const out = await walkOne(target, finalMember)
      // The member that answered, reported for the same reason `onModel` reports
      // the model: a turn's record of WHERE its answer came from. Nothing renders
      // it — a service quietly stepping aside for the next one is the feature
      // working, not a fault to put in front of a reader.
      onMember?.(target, i)
      return out
    } catch (e) {
      memberError = e
      if (finalMember || painted || signal?.aborted || !affordable() || !memberRotatable(e)) throw e
      coolMember(target, e)
    }
  }
  throw memberError || new Error('chat — no service in the chain answered')
}

/**
 * Statuses worth trying the NEXT SERVICE for — everything a live call can fail
 * with, which is wider than `rotatable` and deliberately so.
 *
 * Every exclusion `rotatable` makes is an argument about the SAME host and the
 * same account, and none of them survives a provider boundary:
 *
 * - **401** is one deployment's bad proxy credential. Rotating past it inside a
 *   pool is pointless because a rejected key rejects every model behind it; the
 *   next service is behind a different key entirely.
 * - **A network failure** — no status at all — is one host down, and the next
 *   member is a different host. Inside a pool it was the same socket.
 * - **The DAY's allowance** belongs to ONE account. It is the failure this whole
 *   ladder exists for: a free tier that has answered its fifty questions has
 *   nothing more to say today, and a second key sitting in the environment does.
 *   Only the LAST member's daily 429 leaves this function, so session.js still
 *   settles the turn as `rate-limited` with the reset the service named.
 *
 * Abort and a step timeout are the two that never rotate anywhere: the signal
 * every later request would inherit is already dead.
 *
 * @param {TransportError} e
 */
function memberRotatable(e) {
  return Boolean(e) && e.name !== 'AbortError' && e.name !== 'TimeoutError'
}

/**
 * Which SERVICES just refused, keyed as `POOLS` is.
 *
 * Module scope for the reason `POOLS` gives: a service that is down is down for
 * the next thread too. There is no sticky sibling to this map, and that absence
 * is the point — a sticky member would let one blip promote a free tier above
 * the billed account the deployment configured first, which inverts the order
 * the whole feature is about.
 */
const LADDER = new Map()

const memberKey = (t) => `${t.provider}|${t.baseURL}`

/** @param {TransportError} e */
function coolMember(target, e) {
  const ms = Number.isFinite(e?.retryAfterMs) ? e.retryAfterMs : COOLDOWN_MS
  LADDER.set(memberKey(target), Date.now() + Math.max(1000, ms))
}

/**
 * The order to ask services in — pure, so the policy is testable without a
 * socket, exactly as `orderCandidates` is.
 *
 * The configured order is law: it is the deployment's own statement of which
 * account to spend first, and `ladderTier` in config.js has already sorted the
 * billed ones ahead of a free tier. All this adds is the cooldown, and a cooling
 * member moves to the BACK rather than out — a chain where every member is
 * cooling is exactly the moment a reader is waiting.
 */
export function orderMembers(targets, { cooldown = null, now = Date.now() } = {}) {
  const list = [...targets]
  if (!cooldown || !cooldown.size) return list
  const cooling = (t) => cooldown.get(memberKey(t)) > now
  return [...list.filter((t) => !cooling(t)), ...list.filter(cooling)]
}

/**
 * Capability probe, run once at init. A model that ignores a tool definition on
 * its first call is a fallback model whatever its card says.
 *
 * THREE answers, not two: `true`, `false`, and `null` for "the question was not
 * reached" — every candidate refused the connection, or the reader stopped. The
 * caller must not latch a null, because nothing was measured.
 *
 * `onHeaders` is the same seam `chat()` opens and it is here for the same
 * reason: this probe is a real model request, spent from the same daily
 * allowance, and it is spent BEFORE the reader has asked anything. Left
 * unreported it is one to three answers a day that vanish from the count — and
 * on a metered service its response is also the earliest chance the page has to
 * learn what the day has left, which is a budget line the panel can show while
 * the composer is still empty.
 *
 * @returns {Promise<boolean|null>}
 */
export async function detectTools({
  provider = 'ollama',
  baseURL,
  model,
  models = null,
  apiKey,
  signal,
  onHeaders = null,
}: {
  provider?: string
  baseURL?: string
  model?: string
  models?: string[] | null
  apiKey?: string | null
  signal?: AbortSignal
  onHeaders?: ((...args: any[]) => void) | null
}) {
  const p = providerFor(provider)
  // The probe decides ONE thing for the whole session — native tools or the
  // fallback shape — so on a pool it has to be answered by the pool rather than
  // by whichever member happened to be first. A saturated head would otherwise
  // demote nine capable models to the fallback transport for the rest of the
  // page's life. Three is where the cost of asking overtakes the value: the
  // pools this ships with are ordered by capability, so a fourth "no" is a
  // service that is down, not a model that cannot.
  const candidates = orderCandidates([model, ...(models || [])], {
    ...poolFor(provider, baseURL),
    primary: model || null,
  }).slice(0, models?.length ? 3 : 1)

  // `answered` is the difference between "this model will not call tools" and
  // "nobody was home". The caller LATCHES a false for the life of the page, so a
  // pool that happened to be saturated during the first question used to demote
  // every model behind it to the fallback transport permanently — a worse answer
  // to every later question, caused by a rate limit that had already passed.
  let answered = false
  for (const chosen of candidates) {
    try {
      const res = await fetch(p.chatUrl(baseURL), {
        method: 'POST',
        headers: p.headers(apiKey),
        body: JSON.stringify(p.probeBody(chosen, toolSchemas())),
        signal,
      })
      reportHeaders(onHeaders, res)
      if (!res.ok) continue
      answered = true
      if (p.probeHasToolCall(await res.json())) return true
    } catch {
      if (signal?.aborted) return null
    }
  }
  return answered ? false : null
}

/**
 * What the SERVER says a model can do, where the server can say it.
 *
 * Ollama's /api/show returns a capability list, and it is the only honest source:
 * RAG-SPEC 4.6 records `phi4:14b` as a native tool caller, and this build ships
 * it with `completion` alone. Sending `think` to a model without the thinking
 * capability is an error rather than a no-op, so the transport has to read this
 * rather than trust a table. Providers that expose no such endpoint return null
 * and the caller falls back to the behavioural probe above.
 */
export async function detectCapabilities({
  provider = 'ollama',
  baseURL,
  model,
  apiKey,
  signal,
  fetchImpl = fetch,
}: {
  provider?: string
  baseURL?: string
  model?: string
  apiKey?: string | null
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}) {
  const p = providerFor(provider)
  if (!p.showUrl || !p.parseCapabilities) return null
  try {
    const res = await fetchImpl(p.showUrl(baseURL), {
      method: 'POST',
      headers: p.headers(apiKey),
      body: JSON.stringify(p.showBody(model)),
      signal,
    })
    if (!res.ok) return null
    return p.parseCapabilities(await res.json())
  } catch {
    return null
  }
}

export const FALLBACK_HINT = FALLBACK_DOC
