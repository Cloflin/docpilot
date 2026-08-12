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
 * @returns {{manifest, chunks, byId, vectors, dims, df}}
 */
export function assembleIndex({ manifest, shards, vectorBuffer, dfDoc }) {
  const chunks = shards.flat()
  if (chunks.length !== manifest.chunkCount) {
    throw new Error(`chunk count mismatch: ${chunks.length} vs ${manifest.chunkCount}`)
  }

  const vectors = new Int8Array(vectorBuffer)
  if (vectors.length !== manifest.chunkCount * manifest.dims) {
    throw new Error('vector buffer does not match chunkCount × dims')
  }

  chunks.forEach((c, i) => {
    c.row = i
  })

  return {
    manifest,
    chunks,
    byId: new Map(chunks.map((c) => [c.id, c])),
    vectors,
    dims: manifest.dims,
    df: dfDoc.df,
  }
}

/**
 * @returns {Promise<{manifest, chunks, byId, vectors, dims, df}>}
 */
export function loadIndex(base = '/rag') {
  if (loading) return loading
  loading = (async () => {
    const manifest = await fetchJson(`${base}/manifest.json`)

    const [shards, vectorBuffer, dfDoc] = await Promise.all([
      Promise.all(manifest.shards.map((s) => fetchJson(`${base}/${s}`))),
      fetch(`${base}/${manifest.vectors}`).then((r) => {
        if (!r.ok) throw new Error(`vectors → ${r.status}`)
        return r.arrayBuffer()
      }),
      fetchJson(`${base}/${manifest.df}`),
    ])

    return assembleIndex({ manifest, shards, vectorBuffer, dfDoc })
  })()
  return loading
}

/** Test seam — lets a unit test install a fixture index without touching the network. */
export function __setIndex(promise) {
  loading = promise
}
