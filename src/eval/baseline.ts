/**
 * A frozen ranking baseline — capture, replay and diff (engine-spec 041 owes the
 * prose; this header owes the reasons).
 *
 * WHY IT EXISTS (D-02, D-03, D-07). Phase 1 freezes what 2.1.1 ranks, so that
 * every later phase can prove it moved nothing it did not mean to. A baseline
 * holds three things: the query vectors the ranking was computed from, the
 * ranking per golden record (`rankedIds`, `retrievedIds`, `channel`, the gate
 * result), and the circumstances that produced them. The ranking is REPLAYED
 * from the frozen vectors through `rankRecords` (src/eval/ranking.ts) with no
 * network, which is what lets `npm run verify` check it on any machine.
 *
 * THE VECTORS ARE STORED ROUNDED, AND THE RANKING IS TAKEN FROM THE ROUNDED
 * VECTORS. A live query vector is a ×127 float; the file keeps it as int8. If
 * the stored ranking came from the floats, replay from the file could differ
 * from it by one rounding and the diff would report a regression no change
 * caused. So the capture ranks once from the floats (to say, in
 * `meta.vectors.liveDivergence`, which records the rounding moved) and stores
 * the ranking of the ROUNDED vectors. Replay is then exact by construction.
 *
 * WHAT IT NEVER DOES: read `process.env`, write a file, call `process.exit`, or
 * reach the network — with ONE exception, `ollamaHost`, which asks the local
 * Ollama for its version and model digests (D-07) and returns null on any
 * failure. The caller (src/eval/run.ts) owns files, flags and exit codes.
 *
 * WHAT IT NEVER WRITES: a path, a query string or a key. A host is reduced to
 * its origin by `originOnly`, because a base URL can carry a credential and this
 * file is committed.
 */
import crypto from 'node:crypto'

import { rankRecords } from './ranking.js'

/** The file format. Bump it when the shape of `records` or `vectors` changes. */
export const BASELINE_SCHEMA = 1

/**
 * The summary metrics REL-10 reads as "groundedness". The eval summary has no
 * metric by that name (research mapping): these three are the ones that say
 * whether an answer stood on its evidence. The mapping is written into every
 * baseline's meta, so a later reader does not have to rediscover it.
 */
export const GROUNDEDNESS_KEYS = ['supportPrecision', 'unsupportedAnswerRate', 'citationPrecision']

/** Query vectors live in the index domain: L2-normalised, then ×127. */
const INT8_MAX = 127

/** G, D and L are diagnostic floats; six decimals is below any real ranking move. */
const SCORE_DECIMALS = 6

/**
 * The fields `diffBaseline` compares. `G`, `D` and `L` are NOT here: a tie in a
 * float that differs in its last bit on another CPU is not a ranking change
 * (research Pitfall 10), and the ranking fields would show a real one.
 */
const COMPARED = ['rankedIds', 'retrievedIds', 'channel', 'gatePass']

/** The digest length Ollama's own `ollama list` prints. */
const DIGEST_HEX = 12

/** A local Ollama answers in milliseconds; a hung one must not hang a capture. */
const OLLAMA_TIMEOUT_MS = 5000

/** An int8 vector, as base64. Values are rounded and clamped to ±127. */
export function encodeVector(vec: ArrayLike<number>): string {
  const bytes = new Int8Array(vec.length)
  for (let i = 0; i < vec.length; i++) {
    bytes[i] = Math.max(-INT8_MAX, Math.min(INT8_MAX, Math.round(vec[i])))
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** The frozen query vectors, as `Float64Array`s already in the index domain. */
export function decodeVectors(baseline: { vectors?: Record<string, string> }): Map<string, Float64Array> {
  const out = new Map<string, Float64Array>()
  for (const [text, b64] of Object.entries(baseline.vectors ?? {})) {
    const raw = Buffer.from(b64, 'base64')
    const vec = new Float64Array(raw.length)
    for (let i = 0; i < raw.length; i++) vec[i] = (raw[i] << 24) >> 24
    out.set(text, vec)
  }
  return out
}

/**
 * WHICH golden set: sha1 of the bytes, sixteen hex. The definition `run.ts` has
 * always used for `meta.goldenSha`, moved here so there is one.
 */
export function goldenShaOf(bufferOrText: Buffer | string): string {
  return crypto.createHash('sha1').update(bufferOrText).digest('hex').slice(0, 16)
}

/** An address without path, query or credentials; null for anything that is not a URL. */
export function originOnly(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * The local Ollama's version and the digests of the models that answered (D-07).
 *
 * The eval report's `meta` never recorded which host produced it, and two hosts
 * on the same weights can run different Ollama builds. `null` on ANY failure —
 * an unreachable host is a fact the caller records as absence, not an error.
 *
 * @param base   the host, as an origin
 * @param names  model names to look up; one that is not installed is left out
 * @param fetchFn  injected for the test; the global `fetch` otherwise
 */
export async function ollamaHost(
  base: string,
  names: string[] = ['qwen3:8b', 'bge-m3'],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ base: string; version: string | null; models: Record<string, string> } | null> {
  try {
    const origin = originOnly(base)
    if (!origin) return null
    const get = async (route: string) => {
      const res = await fetchFn(`${origin}${route}`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`${route} answered ${res.status}`)
      return res.json() as Promise<any>
    }
    const [version, tags] = await Promise.all([get('/api/version'), get('/api/tags')])
    const installed: any[] = Array.isArray(tags?.models) ? tags.models : []
    const models: Record<string, string> = {}
    for (const name of names) {
      // `bge-m3` is listed as `bge-m3:latest`.
      const found = installed.find((m) => m.name === name || m.name === `${name}:latest`)
      const digest = found?.digest ? String(found.digest).replace(/^sha256:/, '') : ''
      if (digest) models[name] = digest.slice(0, DIGEST_HEX)
    }
    return { base: origin, version: typeof version?.version === 'string' ? version.version : null, models }
  } catch {
    return null
  }
}

const round = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(SCORE_DECIMALS)) : null

/**
 * One record of a baseline, read off a probe (`rankRecords` output) and, when a
 * model or a server ran, the report row that carries its outcome. `probe` may be
 * null for a server run, where the row is the whole evidence.
 */
export function recordOf(probe: any, row: any = null) {
  const g = probe?.g
  const rec: Record<string, any> = {
    id: probe?.rec?.id ?? row?.id,
    channel: g ? g.channel : (row?.channel ?? null),
    gatePass: g ? Boolean(g.pass) : Boolean(row?.gatePass),
    G: round(g ? g.G : row?.G),
    D: round(g ? g.D : row?.D),
    L: round(g ? g.L : row?.L),
    rankedIds: [...(probe ? probe.rankedIds : (row?.rankedIds ?? []))],
    retrievedIds: [...(probe ? probe.retrievedIds : (row?.retrievedIds ?? []))],
  }
  if (row?.observed !== undefined) rec.outcome = row.observed
  return rec
}

/**
 * The file. Records are keyed by id and sorted by id, vectors keyed by text and
 * sorted by text, so two captures of one run are byte-identical apart from what
 * the caller puts in `meta` (`capturedAt`).
 *
 * @param meta     everything that describes the circumstances; the caller owns it
 * @param records  `recordOf` results
 * @param vectors  text -> vector in the index domain; omitted from the file when empty
 * @param summary  the eval summary, when a model or server ran
 */
export function captureBaseline({
  meta,
  records,
  vectors = null,
  summary = null,
}: {
  meta: Record<string, any>
  records: Array<Record<string, any>>
  vectors?: Map<string, ArrayLike<number>> | null
  summary?: Record<string, any> | null
}) {
  const byId = {}
  for (const { id, ...rest } of [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    byId[id] = rest
  }
  const encoded = {}
  for (const text of [...(vectors?.keys() ?? [])].sort()) encoded[text] = encodeVector(vectors.get(text))
  const count = Object.keys(encoded).length

  const out: Record<string, any> = { meta: { schema: BASELINE_SCHEMA, ...meta } }
  if (summary) out.meta.groundedness = GROUNDEDNESS_KEYS
  if (count) {
    out.meta.vectors = { format: 'int8-base64', scale: INT8_MAX, normalised: true, ...meta.vectors, count }
  }
  out.records = byId
  if (count) out.vectors = encoded
  if (summary) out.summary = summary
  return out
}

/**
 * Rank `records` again from the baseline's frozen vectors. Offline by
 * construction: the embedder is a Map lookup, and a text the baseline holds no
 * vector for is an error that names the text, never a silent lexical fallback.
 */
export async function replayBaseline({
  index,
  guard,
  records,
  baseline,
  lexical = false,
}: {
  index: any
  guard: any
  records: any[]
  baseline: { vectors?: Record<string, string> }
  lexical?: boolean
}) {
  const frozen = decodeVectors(baseline)
  return rankRecords({
    index,
    guard,
    records,
    lexical,
    embed: async (text) => {
      const vec = frozen.get(text)
      if (!vec) throw new Error(`the baseline holds no vector for the query "${text}"`)
      return vec
    },
  })
}

/**
 * What moved between a baseline and a current ranking.
 *
 * @param current  `recordOf` results, or probes straight from `rankRecords`
 * @param partial  the current run covered only part of the set: a baseline
 *   record the run did not rank is then not "missing"
 * @returns `[{ id, field, before, after }]`; empty when nothing moved. A record on
 *   one side only is `field: 'record'`, with `after: 'added'` or `after: 'missing'`.
 */
export function diffBaseline(
  baseline: { records: Record<string, any> },
  current: any[],
  { partial = false }: { partial?: boolean } = {},
) {
  const now = new Map<string, any>()
  for (const item of current) {
    const rec = item?.rec ? recordOf(item) : item
    now.set(rec.id, rec)
  }
  const diffs: Array<{ id: string; field: string; before: unknown; after: unknown }> = []
  const ids = [...new Set([...Object.keys(baseline.records), ...now.keys()])].sort()
  for (const id of ids) {
    const before = baseline.records[id]
    const after = now.get(id)
    if (!before) {
      diffs.push({ id, field: 'record', before: 'absent', after: 'added' })
      continue
    }
    if (!after) {
      if (!partial) diffs.push({ id, field: 'record', before: 'present', after: 'missing' })
      continue
    }
    for (const field of COMPARED) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
        diffs.push({ id, field, before: before[field], after: after[field] })
      }
    }
  }
  return diffs
}
