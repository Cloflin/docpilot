/**
 * The vectors this corpus already has, so a rebuild does not buy them twice.
 *
 * WHY THIS EXISTS. `docpilot index` re-embeds every chunk on every run, and the
 * loop `engine-specs/README.md` binds a corpus change to — `index → calibrate →
 * lint → eval` — therefore costs `ceil(chunks/32)` plus `ceil(probes/32)`
 * requests. On this package's own 471-chunk corpus that is 15 + 19 = 34; on a
 * 1216-chunk one it is 57. The free tier this project recommends is **50
 * requests a day**, metered as requests rather than tokens. So the process the
 * documentation mandates did not fit the tariff the documentation recommends,
 * and a docs commit that wanted a non-provisional guard spent the allowance its
 * readers answer out of.
 *
 * CONTENT-ADDRESSED, NEVER GIT. A file is not a chunk: reordering frontmatter
 * changes the file and not the chunk, and a change to `chunker.js` or to the
 * vocabulary changes every chunk without touching one file. A git-diff gate
 * misses in both directions; a hash of the text that was sent misses in
 * neither — and it works for `--html-dir` and `import`, where there is no git
 * to diff.
 *
 * IT IS A CACHE AND NEVER A SECOND CODE PATH. Every failure here is silent and
 * leaves the map short: a miss re-embeds, which is what the build did before
 * this file existed. The same rule `calibrate.js` states over
 * `calibration.raw.jsonl`, for the same reason.
 *
 * WHAT IS IN THE KEY, and why each one has to be.
 *
 *   - the TEXT that was sent, prefix included — the actual input;
 *   - the RESOLVED model name — a different model is a different vector space,
 *     and `calibrate.js`'s `sigOf` carries the post-mortem of what keying
 *     without it costs: a 100% cache hit after an embedder swap, publishing the
 *     old space's thresholds as the new one's calibration;
 *   - the PROVIDER and BASE URL — one model name served by two hosts is not
 *     guaranteed to be one set of weights;
 *   - the SCHEMA below — bump it when what gets sent changes, or when the
 *     stored representation does.
 *
 * WHAT IS NOT, and why. The corpus hash: it covers every chunk, so one edited
 * chunk would evict the other 470 — which is the whole thing this file exists to
 * avoid. `vocabHash` and `tokenizer`: they decide BM25 tokenisation and
 * `df.json`, and `terms()` is never called on the embed path.
 *
 * FLOAT32, NOT INT8. `quantisationError` in `build-rag-index.js` reads the float
 * vectors and refuses the build over 0.01 mean |Δcos|; caching the int8 rows
 * would blind the one check that guards the reader's whole vector file. And the
 * pipeline holds `Float32Array` between `l2normalise` and `toInt8` — a round
 * trip through JSON returns f64, `Math.round(v * 127)` disagrees on the
 * boundary, and the build's byte-identical-output contract breaks.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Bump when the bytes sent to the provider change, or when a stored row stops
 * meaning what it meant. A stale row served under a changed contract is the
 * silent half-wrong index this file must never produce.
 */
const SCHEMA = 1

/** 128 bits of sha256. One corpus is thousands of texts, not billions. */
const keyOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)

/**
 * The namespace one embedder occupies, as a filename.
 *
 * `dims` is deliberately NOT in it. A provider that changes the width under a
 * stable model name is a silent corruption, and the point is to CATCH it — a
 * dims mismatch has to be a rejected read, not a second namespace that quietly
 * works.
 */
const namespaceOf = ({ model, provider, baseURL, prefix }) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([SCHEMA, model, provider, baseURL ?? null, prefix ?? '']))
    .digest('hex')
    .slice(0, 16)

/**
 * One embedder's vectors, on disk.
 *
 * Two files per namespace: a JSON index of keys in row order, and a flat
 * float32 blob. The pair is written whole or not at all, and a read that finds
 * them inconsistent throws the cache away rather than serving half of it.
 *
 * @param dir      where the pair lives — injected, so this is testable without a project
 * @param model    the RESOLVED model name, after `choose()`
 * @param provider adapter id, e.g. 'openrouter'
 * @param baseURL  the host the model was served from
 * @param prefix   the document-side prefix actually applied to every text
 * @param refresh  skip the READ, never the write — so a refresh also repairs the file
 * @param warn     a corrupt or unreadable cache says so once and is dropped
 */
export function openEmbedCache({
  dir,
  model,
  provider,
  baseURL,
  prefix = '',
  refresh = false,
  warn = (_message: string) => {},
}) {
  const ns = namespaceOf({ model, provider, baseURL, prefix })
  const idxPath = path.join(dir, `embed-${ns}.json`)
  const binPath = path.join(dir, `embed-${ns}.bin`)

  const rows = new Map() // key -> Float32Array
  let dims: number | null = null
  let hits = 0

  if (!refresh && fs.existsSync(idxPath) && fs.existsSync(binPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
      const buf = fs.readFileSync(binPath)
      const n = idx.keys?.length ?? 0
      // Both halves have to agree before a single row is trusted. A truncated
      // blob read positionally is the same failure as a short batch: every row
      // after the tear belongs to somebody else.
      if (idx.schema !== SCHEMA) throw new Error(`schema ${idx.schema}, this build is ${SCHEMA}`)
      if (idx.model !== model) throw new Error(`model "${idx.model}", this build embeds with "${model}"`)
      if (!Number.isInteger(idx.dims) || idx.dims <= 0) throw new Error('no usable dims')
      if (buf.length !== n * idx.dims * 4) {
        throw new Error(`blob is ${buf.length} bytes, not ${n} × ${idx.dims} × 4`)
      }
      dims = idx.dims
      const all = new Float32Array(buf.buffer, buf.byteOffset, n * idx.dims)
      idx.keys.forEach((k, i) => rows.set(k, all.subarray(i * idx.dims, (i + 1) * idx.dims)))
    } catch (e) {
      warn(`${path.basename(idxPath)} is not usable (${e.message}) — embedding without it`)
      rows.clear()
      dims = null
    }
  }

  return {
    get(text) {
      const hit = rows.get(keyOf(text))
      if (hit) hits++
      return hit ?? null
    },

    /**
     * A vector, post-`l2normalise`. The first one seen fixes the width, and a
     * later one that disagrees is refused rather than stored: that is the
     * provider changing dims under a stable name, and it must not become two
     * shapes in one namespace.
     */
    set(text, vec) {
      if (dims === null) dims = vec.length
      if (vec.length !== dims) {
        warn(`the embedder returned ${vec.length} dimensions where it returned ${dims} — not cached`)
        return
      }
      rows.set(keyOf(text), vec)
    },

    /**
     * Rewrite the pair with EXACTLY the texts this run used, in their order.
     *
     * Self-evicting by construction — a chunk deleted from the corpus stops
     * costing disk on the next build, and a partial run still leaves a usable
     * file. `calibrate.js` writes `calibration.raw.jsonl` the same way and for
     * the same reason.
     */
    commit(texts) {
      const keys = []
      const keep = []
      const seen = new Set()
      for (const t of texts) {
        const k = keyOf(t)
        if (seen.has(k)) continue
        const v = rows.get(k)
        if (!v) continue
        seen.add(k)
        keys.push(k)
        keep.push(v)
      }
      if (!keys.length || dims === null) return
      const flat = new Float32Array(keys.length * dims)
      keep.forEach((v, i) => flat.set(v, i * dims))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(binPath, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))
      fs.writeFileSync(
        idxPath,
        JSON.stringify({ schema: SCHEMA, model, provider, dims, keys }) + '\n',
      )
    },

    stats: () => ({ hits, stored: rows.size, dims }),
  }
}

export { SCHEMA as EMBED_CACHE_SCHEMA, namespaceOf, keyOf }
