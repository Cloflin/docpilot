/**
 * Query embedding — RAG-SPEC 3.2.
 *
 * The query must be embedded with the same model that built the index. If this
 * endpoint is unavailable while chat works, retrieval degrades to pure BM25:
 * not surfaced in the UI, recorded as `retrieval: 'lexical-only'`, and the gate
 * switches to G = L against tauLexical.
 */

/**
 * nomic-embed-text requires an asymmetric prefix and the quality difference is
 * visible. bge-m3 and the e5 family are trained without one, and adding it
 * degrades the vector — so the prefix follows the model, and the build script
 * applies the document-side counterpart by the identical test.
 */
import { providerFor } from './providers.js'

const queryPrefix = (model) => (/nomic/i.test(model) ? 'search_query: ' : '')

/**
 * Statuses where the request was fine and the far end was not — the same set
 * llm.js retries on, for the same reason. A shared free embedder answers 429
 * whenever somebody else is indexing, and reported as a failure that is a
 * question silently downgraded to lexical-only.
 *
 * ROTATION IS NOT AVAILABLE HERE, and that is a property of embeddings rather
 * than an omission. The chat half can try another model because any of them can
 * answer; a second embedder produces vectors in a different space, and scoring
 * this index with them yields numbers that look like similarities and are not.
 * So the choice is between waiting and lexical-only, and both of those are
 * honest. The model is chosen once, by `npx docpilot index`, and recorded in the
 * manifest.
 */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 3

/**
 * The embedding provider is configured SEPARATELY from the chat provider, and
 * not for symmetry: Anthropic has no embeddings endpoint at all, so "answer
 * with Claude, retrieve with something else" has to be expressible.
 *
 * `model` may be absent from the config — a pooled provider leaves the choice to
 * the build — in which case the caller passes the manifest's name. Absent from
 * BOTH is a bug worth naming rather than a request worth sending.
 */
export async function embedQuery(text, { provider = 'ollama', baseURL, model, apiKey, signal }) {
  const p = providerFor(provider)
  if (!p.embedUrl) throw new Error(`provider ${provider} has no embeddings endpoint`)
  if (!model) throw new Error('no embedding model — the index names it; rebuild with `npx docpilot index`')

  let res
  for (let attempt = 1; ; attempt++) {
    res = await fetch(p.embedUrl(baseURL), {
      method: 'POST',
      headers: p.headers(apiKey),
      body: JSON.stringify(p.embedBody(model, `${queryPrefix(model)}${text}`)),
      signal,
    })
    if (res.ok || !RETRYABLE.has(res.status) || attempt >= MAX_ATTEMPTS || signal?.aborted) break
    const after = Number(res.headers.get('retry-after'))
    const waitMs =
      Number.isFinite(after) && after > 0
        ? Math.min(after * 1000, 5000)
        : Math.min(300 * 2 ** (attempt - 1), 2000)
    // A reader is watching a spinner, so the ceiling here is far below the
    // indexer's: past a few seconds, lexical-only is the better answer.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    })
  }
  if (!res.ok) throw new Error(`embed ${res.status}`)
  const json = await res.json()
  const vec = p.embedParse(json)
  if (!vec) throw new Error('embed response has no vector')

  // L2-normalise, then scale to the index's int8 domain so the runtime dot
  // product is the cosine without any per-query rescaling.
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum) || 1
  const out = new Float64Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] / norm) * 127
  return out
}
