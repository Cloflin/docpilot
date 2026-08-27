/**
 * Asking a provider which embedding models it actually serves — RAG-SPEC 2.4.
 *
 * WHY THIS EXISTS. `PROVIDERS` in src/config.js carries one `embedModel` string
 * per service, and the paragraph above that table says what they are: defaults,
 * not guarantees. Catalogues change. The `openrouter` entry beside them records
 * how that fails in practice — it asserted for months that the service ships no
 * embeddings endpoint, which was true when it was written and silently wrong
 * afterwards — and the cost of a stale name today is `npx docpilot index` dying
 * on its first chunk with a 404 naming a model nobody typed.
 *
 * Three things it fixes, all the same defect:
 *   · `custom` and `llamacpp` name a HOST, not a service, so `BAAI/bge-m3` and
 *     `local` are this package guessing what somebody else loaded.
 *   · `embed: {provider: 'openai'}` with no model was a build-stopping error,
 *     while `chat: {provider: 'openai'}` with no model is a complete sentence.
 *   · A name that ages does so in silence.
 *
 * WHAT IT DOES NOT DO — and this is a boundary rather than an omission.
 * Discovery may change the MODEL; it may never change the PROVIDER. The proxy
 * that carries `/ai/v1/embeddings` is written from `resolveEmbed()` at config
 * time, synchronously, with no network available and none wanted (see the note
 * on `resolveEmbed` in src/config.js: a resolver that changed its answer with
 * the environment would hand a CI box a different configuration than the laptop
 * that built the index). So a build that decided mid-flight to embed somewhere
 * else would leave every reader's query vector posted to the wrong upstream. The
 * provider is a config-time decision and stays one; `docpilot doctor --models`
 * is where a provider that turns out to embed after all gets reported.
 *
 * BUILD-TIME ONLY. Nothing here ships to a browser — `src/build/` is Node's.
 */

import { providerFor } from '../../theme/docpilot/providers.js'

/**
 * What an embedding model is called, when the catalogue will not say.
 *
 * The OpenAI-compatible `/v1/models` is a list of `{id}` and nothing else: no
 * capability field, no modality, no way to tell `text-embedding-3-small` from
 * `gpt-4o-mini` except by reading the name. So this is a name test, and it is
 * deliberately loose — the families below are what embedding models are actually
 * called across the services this package speaks to.
 *
 * A LOOSE TEST IS SAFE HERE, and that is the whole design. This function only
 * PROPOSES; `createEmbedder.choose()` in build-rag-index.js disposes, by sending
 * each candidate a real embedding request and taking the first that answers. A
 * chat model that slips through on its name fails that probe and is skipped,
 * costing one request. A false negative costs more — an embedder nobody offered
 * — so the regex leans towards admitting.
 */
const EMBED_NAME = /embed|bge|gte|e5-|nomic|minilm|voyage|mxbai|jina|arctic|stella/i

/** Explicit, where a payload carries the answer instead of implying it. */
const MODALITIES = (m) => m?.architecture?.output_modalities || []

/**
 * Ordered so two builds of one catalogue emit one list.
 *
 * A DECLARED embedder outranks a guessed one — OpenRouter publishes
 * `output_modalities`, and a model that says what it is beats a model whose name
 * merely suggests it. Everything after that is the id, which is arbitrary and is
 * the point: an arbitrary rule applied identically twice is what makes a diff of
 * two build logs mean something.
 */
function order(models) {
  const rank = (m) => (MODALITIES(m).includes('embeddings') ? 0 : 1)
  return [...models]
    .sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)))
    .map((m) => m.id)
}

/**
 * The candidates a payload offers, whatever shape it arrived in.
 *
 * `modelsParse` gives the ids — it is the adapter's job and there is no second
 * copy of those paths here — but the ids alone lose `output_modalities`, which
 * is the one signal worth more than the name test. So the raw rows are read
 * where they exist and the parsed ids are the floor: Ollama's `/api/tags` has no
 * rows of that shape at all, and a payload this function does not recognise has
 * to degrade to "the names I was given" rather than to nothing.
 *
 * @param {object} json  the catalogue response
 * @param {string[]} ids `modelsParse(json)` — the adapter's own reading
 */
export function embedCandidates(json, ids) {
  const rows = Array.isArray(json?.data) ? json.data : null
  if (rows) {
    const declared = rows.filter((m) => MODALITIES(m).includes('embeddings'))
    // A catalogue that DECLARES its embedders is answering the question outright,
    // and the name test would only add guesses behind a real answer.
    if (declared.length) return order(declared)
    return order(rows.filter((m) => m?.id && EMBED_NAME.test(m.id)))
  }
  return [...ids].filter((id) => EMBED_NAME.test(id)).sort()
}

/**
 * Which embedding models this provider serves, in the order to try them.
 *
 * NEVER THROWS AND NEVER GUESSES. An unreachable host, a 401, a body that is not
 * the shape this adapter describes — every one of them is an empty list, which
 * means "could not ask" and not "there are none". The caller treats the two the
 * same way on purpose: the table's own name is already the head of the pool, so
 * a failed discovery leaves the build exactly as it was before this existed.
 *
 * @param {{provider: string, baseURL: string|null, apiKey?: string|null,
 *   fetchImpl?: typeof fetch, signal?: AbortSignal}} opts
 *   `provider` is the ADAPTER id — 'openai', 'ollama', 'anthropic' — because the
 *   path and the payload shape are facts about an API rather than about a brand.
 * @returns {Promise<string[]>}
 */
export async function discoverEmbedModels({
  provider,
  baseURL,
  apiKey = null,
  fetchImpl = fetch,
  signal,
}) {
  const adapter = providerFor(provider)
  const url = baseURL && adapter.modelsUrl ? adapter.modelsUrl(baseURL) : null
  if (!url || typeof fetchImpl !== 'function') return []
  try {
    const res = await fetchImpl(url, { headers: adapter.headers(apiKey), signal })
    if (!res?.ok) return []
    const json = await res.json()
    return embedCandidates(json, adapter.modelsParse(json))
  } catch {
    return []
  }
}

/**
 * The pool to hand `createEmbedder`, with the configured name at the head.
 *
 * THE HEAD IS THE TABLE'S ANSWER and it stays first, because it is the one
 * candidate somebody chose rather than found: it is what the docs name, what the
 * last index was probably built with, and — where the author wrote it down — a
 * sentence this package does not rewrite. Discovery lines up behind it, so the
 * common build makes one extra request and picks exactly what it always picked.
 *
 * The list is deduped and the head is never repeated. Both matter to
 * `createEmbedder`, which spends a probe request per candidate.
 *
 * @param {string|null} configured
 * @param {string[]} discovered
 */
export function embedPoolOf(configured, discovered) {
  const out = []
  for (const id of [configured, ...discovered]) {
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Does this provider serve embeddings, whatever the table says?
 *
 * `PROVIDERS` in src/config.js carries `embedModel: null` for anthropic, groq,
 * deepseek, xAI and cerebras, and that is a CLAIM rather than a law — the same
 * table asserted for months that OpenRouter ships no embeddings endpoint, which
 * was true when it was written and silently wrong afterwards. The cost of the
 * claim going stale is paid on every build: `embed: 'auto'` borrows OpenRouter's
 * free pool, so the deployment needs a SECOND key and posts the text of the
 * whole corpus to a third party.
 *
 * So it is asked, the only way it can be answered — by sending a real embedding
 * request. Candidates come from the provider's own catalogue, and at most two
 * are tried, so `docpilot doctor --models` cannot turn into a survey.
 *
 * IT REPORTS, IT DOES NOT ACT. `doctor` prints the one line an author writes
 * down; nothing switches provider on its own, for the reason in this file's
 * header. Never throws, because it runs beside a readiness verdict and a third
 * party being slow must not decide an exit code.
 *
 * @param {{provider: string, baseURL: string|null, apiKey?: string|null}} target
 *   the shape `nodeChatTarget` returns
 * @param {{fetchImpl?: typeof fetch, limit?: number}} [opts]
 * @returns {Promise<string|null>} the model that answered, or null
 */
export async function probeEmbedEndpoint(target, { fetchImpl = fetch, limit = 2 } = {}) {
  const adapter = providerFor(target.provider)
  const url = adapter.embedUrl && target.baseURL ? adapter.embedUrl(target.baseURL) : null
  if (!url || typeof fetchImpl !== 'function') return null

  const candidates = (
    await discoverEmbedModels({
      provider: target.provider,
      baseURL: target.baseURL,
      apiKey: target.apiKey,
      fetchImpl,
    })
  ).slice(0, limit)

  for (const model of candidates) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: adapter.headers(target.apiKey),
        body: JSON.stringify(adapter.embedBody(model, ['docpilot embedder probe'])),
      })
      if (!res?.ok) continue
      const vector = adapter.embedParse(await res.json())
      if (vector?.length) return model
    } catch {
      // Unreachable, or a body that is not the shape this adapter describes.
      // Either way it is not an answer, and not news.
    }
  }
  return null
}
