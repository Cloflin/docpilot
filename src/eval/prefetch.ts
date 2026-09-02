/**
 * ONE PURCHASE PER RUN — the probe texts, embedded in batches before anything
 * asks for them one at a time.
 *
 * `embedQuery` sends one text per request, which is the right shape for a reader
 * typing a question and the wrong one for a measurement. `eval --gate-only` is
 * 58 requests on this repository's golden set and 2 through here; a bounded
 * `calibrate --transfer` draws 271 anchors, 47 of which carry a previous turn
 * and cost a second embed, so the run was 318 requests against a free tier that
 * allows 50 a day. The same texts at the batch size `docpilot index` has always
 * used are ten.
 *
 * WHY IT IS A MODULE. It was written inside `calibrate.ts`, closing over that
 * file's `EMBED_PROVIDER`, `EMBED_BASE` and `EMBED_KEY` and mutating a
 * module-level `PREFETCHED`. `run.ts`, `tune.ts` and `bench emit` all embed the
 * same way and all bought one at a time, and none of them could reach it. The
 * behaviour is unchanged to the letter — same 32, same retryable statuses, same
 * refusal to guess at a short batch, same `retry-after` with a 20-second
 * ceiling, same silent fallback — and only the closure became a parameter.
 *
 * IT IS A CACHE AND NEVER A SECOND CODE PATH. Every failure returns quietly,
 * leaving the map short, and every caller falls through to `embedQuery` exactly
 * as it did — so a provider that will not batch degrades to the loop that
 * already worked rather than to an error, and the endpoint diagnosis stays in
 * the one place that words it well.
 */
import { providerFor } from '../theme/docpilot/providers.js'
import { embeddingsOf } from '../build/build-rag-index.js'

/** The batch `docpilot index` has always bought at. */
export const BATCH = 32

/**
 * The statuses worth asking again about. Everything else is a refusal that a
 * second identical request will earn again.
 */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `embedQuery`'s tail, verbatim.
 *
 * The vectors have to be `embedQuery`'s to the bit, which is why this is copied
 * from it rather than taken from the indexer's `l2normalise`: that one stops at
 * the unit vector, and it is the ×127 into the int8 domain that makes the
 * runtime dot product a cosine without a per-query rescale.
 */
export function scaleToIndexDomain(vec: ArrayLike<number> & Iterable<number>) {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum) || 1
  const out = new Float64Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] / norm) * 127
  return out
}

/**
 * Buy every text once, in batches, and hand back what was bought.
 *
 * @param texts    every text the run will ask for. Deduplicated here, so a
 *                 caller may pass a question and its composed form freely.
 * @param target   `{provider, baseURL, apiKey, model}` — the same four values
 *                 `nodeEmbedTarget` resolves, and the same four `embedQuery`
 *                 takes, so batched and per-text paths cannot disagree.
 * @param onTick   progress, called with `(done, total)`. The caller owns the
 *                 stream and the TTY rule; this function prints nothing.
 * @param sleepImpl the backoff, injectable so the retry can be tested without
 *                 the test suite waiting out a real one. Nothing in production
 *                 passes it.
 * @returns `{ vectors, requests }` — a map from text to vector, short if the
 *          provider refused, and the number of requests actually issued.
 */
export async function prefetchEmbeddings(
  texts,
  target,
  { onTick = null, fetchImpl = fetch, sleepImpl = sleep } = {},
) {
  const vectors = new Map<string, Float64Array>()
  let requests = 0

  const { provider, baseURL, apiKey, model } = target || {}
  const p = provider ? providerFor(provider) : null
  if (!p?.embedUrl || !model || !baseURL) return { vectors, requests }

  /**
   * The QUERY prefix. `build-rag-index` applies `search_document: ` across the
   * same asymmetry, so reusing its batch helper here would embed every probe as
   * though it were a chunk — right vectors, wrong side, and nothing downstream
   * could see it.
   */
  const prefix = /nomic/i.test(model) ? 'search_query: ' : ''
  const want = [...new Set<string>(texts)].filter(Boolean)

  for (let i = 0; i < want.length; i += BATCH) {
    const slice = want.slice(i, i + BATCH)
    let got = null
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      let res
      try {
        requests++
        res = await fetchImpl(p.embedUrl(baseURL), {
          method: 'POST',
          headers: p.headers(apiKey),
          body: JSON.stringify(p.embedBody(model, slice.map((t) => `${prefix}${t}`))),
        })
      } catch {
        // Unreachable. The caller's per-text path words that failure, and words
        // it better — it knows which endpoint and which command fixes it.
        return { vectors, requests }
      }
      if (res.ok) {
        const json = await res.json().catch(() => null)
        const batch = embeddingsOf(json, provider === 'ollama')
        // A short batch is a provider that silently dropped inputs. Guessing
        // which ones came back is how a probe gets somebody else's vector.
        if (batch?.length === slice.length && batch.every((v) => v?.length)) got = batch
        else return { vectors, requests }
      } else if (RETRYABLE.has(res.status) && attempt < 3) {
        const after = Number(res.headers.get('retry-after'))
        await sleepImpl(
          Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1), 20000),
        )
      } else return { vectors, requests }
    }
    if (!got) return { vectors, requests }
    slice.forEach((t, j) => vectors.set(t, scaleToIndexDomain(got[j])))
    onTick?.(Math.min(i + BATCH, want.length), want.length)
  }

  return { vectors, requests }
}
