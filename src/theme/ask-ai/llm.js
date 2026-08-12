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

/** Statuses worth trying again: the request was fine, the far end was not. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 4

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
 */
async function fetchWithRetry(url, init, attempt = 1) {
  const res = await fetch(url, init)
  if (res.ok || !RETRYABLE.has(res.status) || attempt >= MAX_ATTEMPTS) return res
  if (init.signal?.aborted) return res

  const header = Number(res.headers.get('retry-after'))
  const waitMs = Number.isFinite(header) && header > 0
    ? Math.min(header * 1000, 20000)
    : Math.min(500 * 2 ** (attempt - 1), 8000)

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
  return fetchWithRetry(url, init, attempt + 1)
}

/**
 * One model call.
 *
 * @returns {{ toolCall: {name, args}|null, text: string, think: string }}
 */
export async function chat({
  provider = 'ollama',
  baseURL,
  model,
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
}) {
  const p = providerFor(provider)

  // Streaming is a display concern only: the reassembled message is identical
  // either way, so a caller that passes no onDelta gets the old single response
  // and every guardrail downstream reads the same object it always did.
  const streaming = typeof onDelta === 'function'

  // A JSON schema, when one is supplied, beats a tool definition on weak models:
  // measured, qwen3:8b offered only the `answer` tool still replied in prose,
  // and prose carries no citations, so a good answer landed on a refusal.
  const body = p.body({
    model,
    messages,
    temperature,
    streaming,
    schemaBody: schema,
    enableThink,
    maxTokens,
    numCtx,
    tools: tools
      ? answerOnly
        ? toolSchemas(citableIds).filter((t) => t.function.name === 'answer')
        : toolSchemas(citableIds)
      : null,
  })

  const res = await fetchWithRetry(p.chatUrl(baseURL), {
    method: 'POST',
    headers: p.headers(apiKey),
    body: JSON.stringify(body),
    signal,
  })
  // Name a rate limit as a rate limit. Reported as a bare status it reads in the
  // eval as though the model failed to answer, which is the opposite of true:
  // the request never reached a model.
  if (res.status === 429) {
    throw new Error(`chat 429 — rate limited by the provider after ${MAX_ATTEMPTS} attempts`)
  }
  if (!res.ok) throw new Error(`chat ${res.status}`)
  const reply =
    streaming && res.body ? await p.readStream(res, onDelta) : p.parse(await res.json())

  // qwen3 on Ollama returns reasoning in a separate field; deepseek-r1 through
  // the fallback transport inlines it as <think> tags in the content. Both are
  // stripped from what the next step sees.
  const { think: inline, rest } = splitThink(reply.content || '')
  const think = (reply.thinking || inline || '').trim()

  const usage = reply.usage || null

  if (reply.toolCall) return { toolCall: reply.toolCall, text: rest, think, usage }

  if (schema) {
    try {
      const obj = JSON.parse(rest)
      return { toolCall: { name: 'answer', args: obj }, text: '', think, usage }
    } catch {
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
 * Capability probe, run once at init. A model that ignores a tool definition on
 * its first call is a fallback model whatever its card says.
 */
export async function detectTools({ provider = 'ollama', baseURL, model, apiKey, signal }) {
  const p = providerFor(provider)
  try {
    const res = await fetch(p.chatUrl(baseURL), {
      method: 'POST',
      headers: p.headers(apiKey),
      body: JSON.stringify(p.probeBody(model, toolSchemas())),
      signal,
    })
    if (!res.ok) return false
    return p.probeHasToolCall(await res.json())
  } catch {
    return false
  }
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
export async function detectCapabilities({ provider = 'ollama', baseURL, model, apiKey, signal }) {
  const p = providerFor(provider)
  if (!p.showUrl || !p.parseCapabilities) return null
  try {
    const res = await fetch(p.showUrl(baseURL), {
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
