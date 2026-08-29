/**
 * Asking a LOCAL server what it has actually loaded — the answering half's
 * sibling of embed-discovery.js.
 *
 * WHY THIS EXISTS. A local Ollama or llama-server knows which weights it holds.
 * This package holds a guess about somebody else's machine: `LOCAL_CHAT_MODEL`
 * is the string `'qwen3:8b'`, and `llamacpp`'s `chatModel` is the literal
 * `'local'`, which llama-server ignores entirely. When the guess is wrong the
 * reader is the one who finds out — a 404 for a model nobody typed, rendered by
 * the panel as "I couldn't find this in the docs", which is a sentence about the
 * corpus for a problem that is about the server.
 *
 * The old `doctor --models` made it worse for llama.cpp specifically: it
 * compared the placeholder `'local'` against `/v1/models`, reported it as NOT in
 * the list, and advised naming a different one — advice for a mistake nobody
 * made, on the one provider where the field is meaningless.
 *
 * IT REPORTS; IT NEVER ACTS, and that is the whole contract. Nothing here
 * reaches `readiness().missing`, changes an exit code, or edits a configuration.
 * A laptop's Ollama being switched off is not a fact about this package, and a
 * publish that fails because of one is the failure this module was written to
 * remove rather than to add.
 *
 * IT MOVES NO PROVIDER — the same boundary embed-discovery.js states in its own
 * header, for the same reason: the proxy routes are written from the resolved
 * config synchronously, with no network, so a decision made mid-flight would
 * leave every reader posting to an upstream the proxy does not carry.
 *
 * NO SECOND PROBE. Every path and parser here is the adapter's own —
 * `modelsUrl`/`modelsParse`, `showUrl`/`parseCapabilities` through
 * `detectCapabilities`, and llama.cpp's `propsUrl`/`parseProps`. A second
 * implementation of "ask the server what it has" is a second thing to drift.
 *
 * BUILD-TIME ONLY. Nothing here ships to a browser — `src/build/` is Node's.
 */

import { providerFor } from '../../theme/docpilot/providers.js'
import { detectCapabilities } from '../../theme/docpilot/llm.js'

/**
 * NULL MEANS "COULD NOT ASK", NEVER "NO".
 *
 * The distinction is the whole reason this returns an object rather than a
 * boolean: a server that is off, a server behind a key this machine does not
 * have, and a server that answered and does not have the model are three
 * different sentences, and only the last one is worth printing at an author.
 *
 * @typedef {object} ChatInspection
 * @property {string[]|null} serves       what the server lists, or null
 * @property {string|null}   loaded       the weights llama-server actually holds
 * @property {number|null}   contextLength the context it was started with
 * @property {{tools: boolean, thinking: boolean, contextLength?: number}|null} capabilities
 * @property {'served'|'not-served'|'placeholder'|'unknown'} verdict
 */

/** @type {ChatInspection} */
const UNKNOWN = { serves: null, loaded: null, contextLength: null, capabilities: null, verdict: 'unknown' }

/**
 * Ask one chat target what it can answer to.
 *
 * @param {{id?: string, provider: string, baseURL: string|null, model?: string|null,
 *   apiKey?: string|null, modelPlaceholder?: boolean}} target
 *   A `nodeChatTarget()` result. `provider` is the ADAPTER id, because paths and
 *   payload shapes are facts about an API; `id` is the brand, and is used only
 *   for the message a caller prints.
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [opts]
 * @returns {Promise<ChatInspection>}
 */
export async function inspectChatTarget(target, { fetchImpl = fetch, signal } = {}) {
  if (!target?.baseURL || typeof fetchImpl !== 'function') return UNKNOWN
  const adapter = providerFor(target.provider)

  const [serves, props, capabilities] = await Promise.all([
    listModels(adapter, target, fetchImpl, signal),
    readProps(adapter, target, fetchImpl, signal),
    readCapabilities(target, fetchImpl, signal),
  ])

  return {
    serves,
    loaded: props.loaded,
    contextLength: props.contextLength ?? capabilities?.contextLength ?? null,
    capabilities,
    verdict: verdictOf(target, serves),
  }
}

/**
 * A placeholder outranks a list, and a missing list is not a denial.
 *
 * The order matters: llama-server DOES answer `/v1/models`, with the alias it
 * was launched under, so asking it whether it serves `'local'` gets a confident
 * and useless no. The brand fact — `modelPlaceholder` on the `PROVIDERS` row —
 * is the only thing that knows the question does not apply.
 */
function verdictOf(target, serves) {
  if (target.modelPlaceholder) return 'placeholder'
  if (!serves?.length || !target.model) return 'unknown'
  return serves.includes(target.model) ? 'served' : 'not-served'
}

/** @returns {Promise<string[]|null>} */
async function listModels(adapter, target, fetchImpl, signal) {
  const url = adapter.modelsUrl?.(target.baseURL)
  if (!url) return null
  try {
    const res = await fetchImpl(url, { headers: adapter.headers(target.apiKey), signal })
    if (!res?.ok) return null
    return adapter.modelsParse(await res.json())
  } catch {
    return null
  }
}

/**
 * llama.cpp's `/props`, and only where the adapter publishes one.
 *
 * Optional by design: the openai adapter has no such endpoint, and knocking on
 * `https://api.openai.com/props` on the off chance is a request nobody asked
 * this tool to make.
 */
async function readProps(adapter, target, fetchImpl, signal) {
  const url = adapter.propsUrl?.(target.baseURL)
  if (!url) return { loaded: null, contextLength: null }
  try {
    const res = await fetchImpl(url, { headers: adapter.headers(target.apiKey), signal })
    if (!res?.ok) return { loaded: null, contextLength: null }
    return adapter.parseProps(await res.json())
  } catch {
    return { loaded: null, contextLength: null }
  }
}

/**
 * Ollama's `/api/show`, through the function the browser already uses for it.
 *
 * `detectCapabilities` returns null for every adapter that has no `showUrl`, so
 * this needs no guard of its own — and reusing it is what keeps one answer to
 * "can this model think?" rather than two that can disagree.
 */
async function readCapabilities(target, fetchImpl, signal) {
  if (!target.model) return null
  try {
    return await detectCapabilities({
      provider: target.provider,
      baseURL: target.baseURL,
      apiKey: target.apiKey,
      model: target.model,
      fetchImpl,
      signal,
    })
  } catch {
    return null
  }
}
