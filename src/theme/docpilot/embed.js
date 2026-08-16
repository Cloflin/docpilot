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
 * The embedding provider is configured SEPARATELY from the chat provider, and
 * not for symmetry: Anthropic has no embeddings endpoint at all, so "answer
 * with Claude, retrieve with something else" has to be expressible.
 */
export async function embedQuery(text, { provider = 'ollama', baseURL, model, apiKey, signal }) {
  const p = providerFor(provider)
  if (!p.embedUrl) throw new Error(`provider ${provider} has no embeddings endpoint`)

  const res = await fetch(p.embedUrl(baseURL), {
    method: 'POST',
    headers: p.headers(apiKey),
    body: JSON.stringify(p.embedBody(model, `${queryPrefix(model)}${text}`)),
    signal,
  })
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
