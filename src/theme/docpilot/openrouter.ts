/**
 * OpenRouter's free tier, as a POOL rather than as a model.
 *
 * Everywhere else in this package a model is one string an author wrote down.
 * OpenRouter is the exception worth making, and not for thrift: its free ids are
 * a shared pool, so the failure they produce is a 429 on a model that is fine —
 * the request never reached it. Naming one free id in `chat.model` therefore
 * buys a panel that works until somebody else's traffic arrives. A list, tried
 * in order, is the shape that matches what the service actually is.
 *
 * Two halves, and they are not symmetric:
 *
 *   chat  — rotation is free. Any model in the pool can answer the next turn,
 *           so a 429 costs a retry and nothing else.
 *   embed — rotation is a BUILD-TIME decision only. Two embedding models are two
 *           vector spaces; querying an index built by one with a vector from the
 *           other scores noise that looks like a number, and the gate then
 *           refuses good questions with nothing in the console. So the indexer
 *           picks whichever free embedder answers, writes it into the manifest,
 *           and the browser is bound to that name for the life of the index.
 *           A busy embedder at QUERY time degrades to lexical-only, which is the
 *           mode RAG-SPEC 3.2 already defines, rather than to a foreign space.
 *
 * The lists below are a snapshot, not a contract — free ids are retired weekly.
 * They are the offline floor; `fetchFreePool` reads the live catalogue when it
 * can reach it, and both catalogue endpoints are public (no key, and the chat
 * one answers `access-control-allow-origin: *`, which is why the browser may ask
 * for it directly rather than through the owner's `/ai` proxy).
 */

/** The catalogue endpoints. Public — neither needs the owner's key. */
export const CATALOGUE = {
  chat: 'https://openrouter.ai/api/v1/models',
  embed: 'https://openrouter.ai/api/v1/embeddings/models',
}

/**
 * "No model named" and "name the pool" are the same request, so both spellings
 * resolve here. `null` is what `resolveDocPilot` leaves behind when an author
 * writes `chat: {provider: 'openrouter'}` and nothing else; `'auto'` and
 * `'free'` are what an author writes when they want to say it out loud.
 */
export function isAutoModel(model) {
  if (model == null) return true
  const s = String(model).trim().toLowerCase()
  return s === '' || s === 'auto' || s === 'free'
}

/**
 * The head of the chat pool, and it is not an ordinary model.
 *
 * `openrouter/free` is OpenRouter's own router over the free tier: it picks a
 * free model per request, skips the ones that are saturated, and reports which
 * one answered in `model`. That is this whole feature implemented one hop
 * closer to the pool than we can see it, so it goes first — the explicit ids
 * behind it are what runs when the router itself is unavailable or when a
 * deployment pins an older catalogue.
 */
export const FREE_ROUTER = 'openrouter/free'

/**
 * Ordered by what the harness ACTUALLY sends, which is why this is not simply
 * "biggest context first". The final step pins its shape with a strict
 * `response_format: json_schema` (harness.js), so a model without
 * `structured_outputs` fails that one call — the interesting call — with a 400.
 * Structured-output models therefore lead, `response_format`-only models follow,
 * and tools-only models are the tail that rotation reaches when nothing better
 * is free.
 */
export const FREE_CHAT = [
  FREE_ROUTER,
  'dots-studio/dots-3-note-preview:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
]

/**
 * Both are 2048-dimensional, which is worth knowing before the first build: an
 * int8 vector per chunk is 2 KB, so a 1500-chunk corpus is a 3 MB index and the
 * builder's own size warning fires. That is a real cost of the free tier, not a
 * defect — `build-rag-index.js` prints the number either way.
 */
export const FREE_EMBED = [
  'nvidia/nemotron-3-embed-1b:free',
  'nvidia/llama-nemotron-embed-vl-1b-v2:free',
]

export const FREE_POOL = { chat: FREE_CHAT, embed: FREE_EMBED }

/**
 * Free means the catalogue charges zero for input, NOT that the id ends `:free`.
 * The suffix is a convention with exceptions in both directions — the router
 * above carries no suffix and is free, and a suffixed id could in principle be
 * priced — and `pricing.prompt` is the field the service bills from.
 */
const isFree = (m) => Number(m?.pricing?.prompt ?? 1) === 0

const params = (m) => m?.supported_parameters || []
const outputs = (m) => m?.architecture?.output_modalities || []

/**
 * Rank by the two capabilities the harness depends on, then by context.
 * Deterministic to the last comparison — the id — so two builds of the same
 * catalogue emit the same list and a diff of the config output means something.
 */
function order(models) {
  const rank = (m) =>
    m.id === FREE_ROUTER
      ? -1
      : params(m).includes('structured_outputs')
        ? 0
        : params(m).includes('response_format')
          ? 1
          : 2
  return [...models]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.context_length || 0) - (a.context_length || 0) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .map((m) => m.id)
}

/**
 * The free chat pool from a `/api/v1/models` payload.
 *
 * `output_modalities` is checked rather than assumed: the same zero-price filter
 * also catches Google's Lyria music models, which are free per token because
 * they bill per song, and posting a documentation question to a music generator
 * is a 400 with a confusing message rather than a fallback.
 */
export function freeChatModels(json) {
  const data = Array.isArray(json?.data) ? json.data : []
  return order(
    data.filter((m) => isFree(m) && outputs(m).includes('text') && params(m).includes('tools')),
  )
}

/** The free embed pool from a `/api/v1/embeddings/models` payload. */
export function freeEmbedModels(json) {
  const data = Array.isArray(json?.data) ? json.data : []
  return order(data.filter((m) => isFree(m) && outputs(m).includes('embeddings')))
}

/**
 * The live pool, with the baked list as the floor rather than as an alternative.
 *
 * Never rejects and never returns empty: a catalogue that is unreachable — no
 * network at build time, a `connect-src 'self'` CSP in the browser — is a
 * reason to use last week's list, not a reason to have no models. The baked ids
 * are appended to the live ones rather than replaced by them, so an id that is
 * still serving but has dropped off the first page of the catalogue stays
 * reachable at the tail.
 *
 * `fallback: false` turns that off and returns `null` instead, for the one
 * caller that is ASKING ABOUT the baked list rather than using it: with the
 * baked ids folded in, "which of ours has been retired?" is a question whose
 * answer is always "none".
 */
/**
 * @param {'chat'|'embed'} kind
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch, apiKey?: string|null,
 *   fallback?: boolean}} [opts]
 * @returns {Promise<string[]|null>}
 */
export async function fetchFreePool(
  kind: 'chat' | 'embed',
  {
    signal,
    fetchImpl = fetch,
    apiKey = null,
    fallback = true,
  }: {
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    apiKey?: string | null
    fallback?: boolean
  } = {},
) {
  const baked = FREE_POOL[kind] || []
  const floor = () => (fallback ? [...baked] : null)
  const url = CATALOGUE[kind]
  if (!url || typeof fetchImpl !== 'function') return floor()
  try {
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined
    const res = await fetchImpl(url, { signal, headers })
    if (!res?.ok) return floor()
    const json = await res.json()
    const live = kind === 'embed' ? freeEmbedModels(json) : freeChatModels(json)
    if (!live.length) return floor()
    return fallback ? [...new Set([...live, ...baked])] : live
  } catch {
    return floor()
  }
}
