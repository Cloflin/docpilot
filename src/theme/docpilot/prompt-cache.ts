/**
 * Prompt caching on the wire — the three places a service takes a hint, and the
 * rule for each. The text of the prompt is not touched here or anywhere this
 * file is used: a hint changes what the provider may reuse, never what the
 * model reads.
 *
 *   anthropic          `system` is a block array whose last block carries
 *                      `cache_control`, and so does the last tool. Native
 *                      Messages API; it always takes the field.
 *   api.openai.com     `prompt_cache_key`, a hash of the system text and the
 *                      tool schemas. Any other OpenAI-shaped host (a proxy,
 *                      llama.cpp, Groq, Together, an Azure gateway) may answer an
 *                      unknown field with a 400, and a reader's question would
 *                      pay for the lesson — so the field goes to this host only.
 *   openrouter.ai +    the system message as content parts with `cache_control`
 *   `anthropic/*`      on the last part, which OpenRouter forwards to Anthropic.
 *                      Only for that pair: its other upstreams do not read it.
 *
 * NO IMPORTS, and none may be added: this file ships to the browser and the
 * server alike, and `providers.ts` is the only module that calls it.
 */

/** The one marker Anthropic's API defines. A new object each time, so no caller can share a mutation. */
export const ephemeral = () => ({ type: 'ephemeral' as const })

/** The lower-cased host of a URL, or null when it is not one. Never throws. */
export function hostOf(baseURL: unknown): string | null {
  try {
    return new URL(String(baseURL)).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** OpenAI's own API, and nothing that merely speaks its dialect. */
export const isOpenAIHost = (baseURL: unknown): boolean => hostOf(baseURL) === 'api.openai.com'

/** OpenRouter routing to an Anthropic model, the one pair whose upstream reads `cache_control`. */
export const isOpenRouterAnthropic = (baseURL: unknown, model: unknown): boolean =>
  hostOf(baseURL) === 'openrouter.ai' && /^anthropic\//i.test(String(model ?? ''))

/** What the system messages say, joined the way the Anthropic adapter joins them. */
export function systemTextOf(messages: any[]): string {
  return messages
    .filter((m) => m?.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n')
}

/**
 * 53 bits of cyrb53. It is a ROUTING HINT, not a secret and not a boundary: it
 * has to be the same string for the same prefix on every request and on every
 * machine, and short enough to be a header-sized field. `node:crypto` is not an
 * option in the browser and `crypto.subtle` is asynchronous.
 */
function hash53(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * The `prompt_cache_key` for a request, or null when there is no system text to
 * cache. It is derived from the system text and the tool schemas ONLY — the
 * parts every reader's request shares — so it carries no question, no quote, no
 * history and nothing that identifies a reader, and it is not the text itself.
 * Two requests with the same prefix get the same key, which is what lets the
 * provider send them to the engine that already holds it.
 */
export function promptCacheKey(system: string, ...schemas: unknown[]): string | null {
  if (!system) return null
  const parts = schemas.map((s) => (s == null ? '' : JSON.stringify(s)))
  return `dp-${hash53([system, ...parts].join('\u0000')).toString(16).padStart(14, '0')}`
}

/**
 * The last item of a list with `cache_control` on a COPY of it. The list and its
 * items are shared with the harness, which builds them once and reuses them, so
 * marking one in place would mark it on the next request to a different service.
 */
export function markLast<T extends object>(list: T[]): T[] {
  if (!list.length) return list
  return [...list.slice(0, -1), { ...list[list.length - 1], cache_control: ephemeral() }]
}

/**
 * The same messages with the LAST system message turned into content parts, the
 * last part carrying `cache_control`. A message that is not a string is left as
 * it is: a part list somebody built already says what they want cached.
 */
export function markLastSystem(messages: any[]): any[] {
  let at = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'system') {
      at = i
      break
    }
  }
  if (at < 0 || typeof messages[at].content !== 'string') return messages
  const out = messages.slice()
  out[at] = {
    ...messages[at],
    content: [{ type: 'text', text: messages[at].content, cache_control: ephemeral() }],
  }
  return out
}
