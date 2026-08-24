/**
 * Lazy index loading — RAG-SPEC 2.4.
 *
 * Nothing here runs until the drawer is opened for the first time: a reader who
 * never asks a question pays nothing for the feature.
 */

let loading = null

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

/**
 * Assemble the loaded parts into the runtime index, integrity checks included.
 *
 * Split out from loadIndex() because `eval/run.js` reads the same artefacts off
 * disk, where `fetch` cannot reach them: it used to carry its own copy of this
 * function, and a copy of an integrity check is a check that silently stops
 * matching the format it guards.
 *
 * @returns {{manifest, chunks, byId, vectors, dims, lexicalOnly, df}}
 */
export function assembleIndex({ manifest, shards, vectorBuffer, dfDoc }) {
  const chunks = shards.flat()
  if (chunks.length !== manifest.chunkCount) {
    throw new Error(`chunk count mismatch: ${chunks.length} vs ${manifest.chunkCount}`)
  }

  /**
   * A null `vectors` name is THE signal that this index was built with no
   * embedder, and it is read instead of `dims === 0` on purpose: a manifest
   * that names a width but ships no blob is a corrupt index, and reading the
   * width would turn that into a silent downgrade to BM25 that nothing
   * downstream can tell apart from a deliberate one.
   *
   * STRICTLY null, on the same grounds and matching `indexInfo` in config.js. A
   * manifest MISSING the key is not a vectorless index either — it is the one
   * `loadIndex` used to fetch `${base}/undefined` for and fail loudly on — and
   * `== null` would answer that corrupt build with the deliberate mode: no
   * error, no `degraded`, a real embedding request every turn, and BM25.
   */
  const lexicalOnly = manifest.vectors === null
  let vectors = null
  if (!lexicalOnly) {
    vectors = new Int8Array(vectorBuffer)
    if (vectors.length !== manifest.chunkCount * manifest.dims) {
      throw new Error('vector buffer does not match chunkCount × dims')
    }
  }

  chunks.forEach((c, i) => {
    c.row = i
  })

  return {
    manifest,
    chunks,
    byId: new Map(chunks.map((c) => [c.id, c])),
    vectors,
    dims: lexicalOnly ? 0 : manifest.dims,
    lexicalOnly,
    df: dfDoc.df,
  }
}

/**
 * The base is REQUIRED, and used to default to `/rag`.
 *
 * That default was the whole of the package's answer to "where is the index",
 * and it was wrong for every site not served from the root of its origin — the
 * production guide told those readers to mount `/rag/` at the origin root with
 * an nginx `alias`, which is a deployment workaround for a hardcoded string.
 * `hostConfig().ragBase` always produces a value, so no caller has a reason to
 * omit one, and a default that can silently disagree with the resolved value is
 * the kind of second copy this package has been bitten by before.
 *
 * @param {string} base  e.g. `/rag` or `/docs/rag`, no trailing slash
 * @returns {Promise<{manifest, chunks, byId, vectors, dims, lexicalOnly, df}>}
 */
export function loadIndex(base) {
  if (loading) return loading
  loading = (async () => {
    const manifest = await fetchJson(`${base}/manifest.json`)

    const [shards, vectorBuffer, dfDoc] = await Promise.all([
      Promise.all(manifest.shards.map((s) => fetchJson(`${base}/${s}`))),
      // A lexical-only index ships no vector blob, so there is no URL to ask
      // for — `${base}/null` is a request for a file that was never written,
      // and in this position a 404 fails the whole load rather than costing the
      // dense channel.
      manifest.vectors === null
        ? null
        : fetch(`${base}/${manifest.vectors}`).then((r) => {
            if (!r.ok) throw new Error(`vectors → ${r.status}`)
            return r.arrayBuffer()
          }),
      fetchJson(`${base}/${manifest.df}`),
    ])

    return assembleIndex({ manifest, shards, vectorBuffer, dfDoc })
  })().catch((e) => {
    /**
     * THE MEMO IS RELEASED ON FAILURE — the same fix, and the same reason, as
     * `ensureHighlighter`'s: a settled rejected promise left in `loading` is
     * what every later call returns, so one dropped connection meant a panel
     * that could never load its index again short of a reload.
     *
     * It became load-bearing with ui-specs/009's prefetch. That fires on a
     * hover, often seconds after page load and before the network is warm, and
     * it is speculative by definition — a speculative fetch that can poison
     * every real one is worse than no prefetch at all.
     */
    loading = null
    throw e
  })
  return loading
}

/** Test seam — lets a unit test install a fixture index without touching the network. */
export function __setIndex(promise) {
  loading = promise
}
