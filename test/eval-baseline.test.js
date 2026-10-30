import { describe, it, expect } from 'vitest'

import { assembleIndex } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { composeQuery } from '../src/theme/docpilot/gate.js'
import { scaleToIndexDomain } from '../src/eval/prefetch.js'
import { rankRecords } from '../src/eval/ranking.js'
import {
  BASELINE_SCHEMA,
  GROUNDEDNESS_KEYS,
  encodeVector,
  decodeVectors,
  goldenShaOf,
  originOnly,
  ollamaHost,
  recordOf,
  captureBaseline,
  replayBaseline,
  diffBaseline,
} from '../src/eval/baseline.js'
import { hasSecret } from '../src/theme/docpilot/credentials.js'

/**
 * THE RANKING ENGINE AND THE BASELINE ENGINE, on an index that lives in memory.
 *
 * `eval` ranks every record through `rankRecords` (src/eval/ranking.ts), and a
 * frozen baseline is replayed through the same function with a Map-backed
 * embedder (src/eval/baseline.ts). The first half of this file pins that the
 * extraction moved the ranking nowhere: what `rankRecords` returns is what
 * `createRetrieval(...).search` returns when asked directly, on the channel the
 * gate won on. The second half pins the baseline engine — capture, replay, diff
 * and the provenance helpers — with no network and no files.
 *
 * Nothing here touches `eval/run.ts`: that module parses flags and may exit the
 * process the moment it is imported, which is why the ranking was extracted.
 */

const GUARD = {
  tau: 0.3,
  tauLexical: 0.3,
  wDense: 0.75,
  wLexical: 0.25,
  denseMode: 'cosine',
  cosFloor: 0.44,
  cosCeil: 0.64,
  zexp: null,
}

const DIMS = 8

/** Six chunks over two pages; each carries a keyword the fixture embedder knows. */
const ROWS = [
  ['a#manifest', '/a', 'manifest', 'Alpha', 'The alpha widget is configured with a manifest file and a token.'],
  ['a#token', '/a', 'token', 'Alpha', 'The alpha token is rotated every hour and stored in the keychain.'],
  ['a#install', '/a', 'install', 'Alpha', 'Install the alpha widget with the registry command and a lockfile.'],
  ['b#registry', '/b', 'registry', 'Beta', 'The beta gizmo installs from the registry and needs no token at all.'],
  ['b#cache', '/b', 'cache', 'Beta', 'The beta cache is cleared by deleting the cache directory on disk.'],
  ['b#logging', '/b', 'logging', 'Beta', 'Beta logging writes one line per request into the journal file.'],
].map(([id, path, anchor, title, text]) => ({
  id,
  path,
  anchor,
  title,
  breadcrumb: 'Docs',
  kind: 'guide',
  text: `Docs — ${title}\n${text}`,
  prev: null,
  next: null,
}))

/** One axis per chunk plus a deterministic tilt, so no two chunks are parallel. */
const AXIS = ROWS.map((_, i) => {
  const v = new Float64Array(DIMS)
  v[i] = 1
  v[(i + 3) % DIMS] += 0.25
  return v
})

const KEYWORDS = ['manifest', 'token', 'install', 'registry', 'cache', 'logging']

/** The fixture embedder: sum the axes of the keywords a text mentions, scale to ×127. */
export function fixtureEmbed(text) {
  const sum = new Float64Array(DIMS)
  KEYWORDS.forEach((k, i) => {
    if (text.toLowerCase().includes(k)) for (let d = 0; d < DIMS; d++) sum[d] += AXIS[i][d]
  })
  if (!sum.some((v) => v)) sum[DIMS - 1] = 1
  return scaleToIndexDomain(sum)
}

let fixtureCount = 0
/** An index with int8 vectors, built by the function the browser uses. */
export function fixtureIndex() {
  const vectorBuffer = new ArrayBuffer(ROWS.length * DIMS)
  const bytes = new Int8Array(vectorBuffer)
  AXIS.forEach((axis, i) => {
    const scaled = scaleToIndexDomain(axis)
    for (let d = 0; d < DIMS; d++) bytes[i * DIMS + d] = Math.round(scaled[d])
  })
  return assembleIndex({
    manifest: {
      version: 3,
      // A distinct hash per fixture: `miniSearchFor` memoises its instance on it.
      hash: `eval-baseline-${++fixtureCount}`,
      embedModel: 'fixture-embed',
      dims: DIMS,
      vectors: 'vectors.bin',
      chunkCount: ROWS.length,
      pages: [
        { path: '/a', title: 'Page /a', tail: 'Docs' },
        { path: '/b', title: 'Page /b', tail: 'Docs' },
      ],
      sections: [],
      guard: GUARD,
    },
    shards: [ROWS.map((r) => ({ ...r }))],
    vectorBuffer,
    dfDoc: { df: {} },
  })
}

const RECORDS = [
  { id: 'r-1', question: 'How is the alpha manifest configured?', gold_chunks: ['a#manifest'] },
  { id: 'r-2', question: 'How do I clear the beta cache?', gold_chunks: ['b#cache'] },
  {
    id: 'r-3',
    question: 'And the token?',
    prev_question: 'How is the alpha manifest configured?',
    gold_chunks: ['a#token'],
  },
]

describe('rankRecords', () => {
  it('ranks a plain record exactly as the retriever does when asked directly', async () => {
    const index = fixtureIndex()
    const probes = await rankRecords({
      index,
      guard: GUARD,
      records: [RECORDS[0]],
      embed: async (t) => fixtureEmbed(t),
    })
    expect(probes).toHaveLength(1)
    const direct = createRetrieval({
      index,
      scope: { kind: 'all', paths: [], label: 'All docs' },
      guard: GUARD,
      tuning: index.manifest.tuning,
    })
      .search({ query: RECORDS[0].question, queryVec: fixtureEmbed(RECORDS[0].question), k: 8 })
      .map((c) => c.id)
    expect(probes[0].rankedIds).toEqual(direct)
    expect(probes[0].rankedIds[0]).toBe('a#manifest')
    expect(probes[0].g.channel).toBe('raw')
    expect(probes[0].recall8).toBe(1)
  })

  it('follows the composed channel for a follow-up when the gate picks it', async () => {
    const index = fixtureIndex()
    const [probe] = await rankRecords({
      index,
      guard: GUARD,
      records: [RECORDS[2]],
      embed: async (t) => fixtureEmbed(t),
    })
    // A follow-up has a composed query; the ranked list must be read off the
    // channel the gate won on, never off the bare question when composed won.
    expect(probe.composedQuery).toBe(composeQuery(RECORDS[2].question, RECORDS[2].prev_question))
    const retrieval = createRetrieval({
      index,
      scope: { kind: 'all', paths: [], label: 'All docs' },
      guard: GUARD,
      tuning: index.manifest.tuning,
    })
    const expected =
      probe.g.channel === 'composed'
        ? { query: probe.composedQuery, queryVec: fixtureEmbed(probe.composedQuery) }
        : { query: RECORDS[2].question, queryVec: fixtureEmbed(RECORDS[2].question) }
    expect(probe.rankedIds).toEqual(retrieval.search({ ...expected, k: 8 }).map((c) => c.id))
    expect(probe.priorGates).toHaveLength(1)
    expect(probe.priorVecs).toHaveLength(1)
  })

  it('asks the injected embedder for nothing under lexical', async () => {
    const index = fixtureIndex()
    let asked = 0
    const probes = await rankRecords({
      index,
      guard: GUARD,
      records: RECORDS,
      embed: async () => {
        asked++
        return fixtureEmbed('x')
      },
      lexical: true,
    })
    expect(asked).toBe(0)
    expect(probes).toHaveLength(RECORDS.length)
    expect(probes.every((p) => p.vec === undefined)).toBe(true)
  })

  it('lets an embedder failure through to the caller, which owns its wording', async () => {
    const index = fixtureIndex()
    await expect(
      rankRecords({
        index,
        guard: GUARD,
        records: [RECORDS[0]],
        embed: async () => {
          throw new Error('endpoint down')
        },
      }),
    ).rejects.toThrow('endpoint down')
  })
})

/** Capture a baseline of `RECORDS` the way `eval --update-baseline` does, minus the files. */
async function capture(meta = { indexHash: 'fixture' }, summary = null) {
  const index = fixtureIndex()
  const asked = new Map()
  const live = await rankRecords({
    index,
    guard: GUARD,
    records: RECORDS,
    embed: async (t) => {
      const v = fixtureEmbed(t)
      asked.set(t, v)
      return v
    },
  })
  // Rank from the ROUNDED vectors, as the capture does, so replay is exact.
  const frozen = { vectors: Object.fromEntries([...asked].map(([t, v]) => [t, encodeVector(v)])) }
  const replayed = await replayBaseline({ index, guard: GUARD, records: RECORDS, baseline: frozen })
  const baseline = captureBaseline({ meta, records: replayed.map((p) => recordOf(p)), vectors: asked, summary })
  return { index, live, baseline }
}

describe('encodeVector and decodeVectors', () => {
  it('round-trips an int8 vector within half a unit of the rounded input', () => {
    const vec = Float64Array.from([0, 1.4, -1.6, 126.5, -127, 63.49])
    const [back] = [...decodeVectors({ vectors: { x: encodeVector(vec) } }).values()]
    expect(back).toHaveLength(vec.length)
    vec.forEach((v, i) => expect(Math.abs(back[i] - Math.max(-127, Math.min(127, Math.round(v))))).toBeLessThanOrEqual(0.5))
  })

  it('clamps to plus and minus 127', () => {
    const [back] = [...decodeVectors({ vectors: { x: encodeVector([500, -500, 127.4]) } }).values()]
    expect([...back]).toEqual([127, -127, 127])
  })
})

describe('captureBaseline, replayBaseline and diffBaseline', () => {
  it('replays offline to the same records, and diffs to nothing', async () => {
    const { index, live, baseline } = await capture()
    expect(baseline.meta.schema).toBe(BASELINE_SCHEMA)
    const replayed = await replayBaseline({ index, guard: GUARD, records: RECORDS, baseline })
    expect(diffBaseline(baseline, replayed)).toEqual([])
    // The ranking was taken from the ROUNDED vectors, so the live floats may tie
    // differently; that is what `meta.vectors.liveDivergence` reports, and the
    // diff against the live run says which records it touches.
    for (const d of diffBaseline(baseline, live)) expect(['rankedIds', 'retrievedIds']).toContain(d.field)
  })

  it('names the record and the field that moved', async () => {
    const { baseline } = await capture()
    const moved = JSON.parse(JSON.stringify(baseline))
    moved.records['r-2'].rankedIds = [...moved.records['r-2'].rankedIds].reverse().concat('zzz')
    const diffs = diffBaseline(moved, Object.entries(baseline.records).map(([id, r]) => ({ id, ...r })))
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ id: 'r-2', field: 'rankedIds' })
    expect(diffs[0].before).not.toEqual(diffs[0].after)
  })

  it('compares the channel and the gate result, and ignores G, D and L', async () => {
    const { baseline } = await capture()
    const current = Object.entries(baseline.records).map(([id, r]) => ({ id, ...r }))
    current[0] = { ...current[0], G: 0.123456, D: 0.5, L: 0.5 }
    expect(diffBaseline(baseline, current)).toEqual([])
    current[1] = { ...current[1], channel: 'other', gatePass: !current[1].gatePass }
    expect(diffBaseline(baseline, current).map((d) => d.field).sort()).toEqual(['channel', 'gatePass'])
  })

  it('reports a record on one side only as added or missing', async () => {
    const { baseline } = await capture()
    const current = Object.entries(baseline.records).map(([id, r]) => ({ id, ...r }))
    const dropped = current.pop()
    const diffs = diffBaseline(baseline, [...current, { ...dropped, id: 'r-new' }])
    expect(diffs).toEqual([
      { id: dropped.id, field: 'record', before: 'present', after: 'missing' },
      { id: 'r-new', field: 'record', before: 'absent', after: 'added' },
    ])
    // A narrowed run never reports the records it did not rank as missing.
    expect(diffBaseline(baseline, current, { partial: true })).toEqual([])
  })

  it('throws, naming the query, when the baseline holds no vector for a text', async () => {
    const { index, baseline } = await capture()
    const stripped = { ...baseline, vectors: {} }
    await expect(
      replayBaseline({ index, guard: GUARD, records: [RECORDS[0]], baseline: stripped }),
    ).rejects.toThrow(RECORDS[0].question)
  })

  it('writes records sorted by id and vectors sorted by text, byte-identical across captures', async () => {
    const a = (await capture({ indexHash: 'fixture', capturedAt: 'x' })).baseline
    const b = (await capture({ indexHash: 'fixture', capturedAt: 'x' })).baseline
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(Object.keys(a.records)).toEqual([...Object.keys(a.records)].sort())
    expect(Object.keys(a.vectors)).toEqual([...Object.keys(a.vectors)].sort())
    expect(a.meta.vectors).toMatchObject({ format: 'int8-base64', scale: 127, normalised: true })
    expect(a.meta.vectors.count).toBe(Object.keys(a.vectors).length)
  })

  it('names the groundedness mapping only when a summary is carried', async () => {
    const without = (await capture()).baseline
    expect(without.meta.groundedness).toBeUndefined()
    expect(without.summary).toBeUndefined()
    const withSummary = (await capture({ indexHash: 'fixture' }, { supportPrecision: 1 })).baseline
    expect(withSummary.meta.groundedness).toEqual(GROUNDEDNESS_KEYS)
  })

  it('records the outcome only when a row from a model or server run is given', async () => {
    const { live } = await capture()
    expect(recordOf(live[0]).outcome).toBeUndefined()
    expect(recordOf(live[0], { observed: 'answer' }).outcome).toBe('answer')
    expect(recordOf(null, { id: 's-1', channel: 'raw', gatePass: true, rankedIds: ['a'], retrievedIds: ['a'], observed: 'answer' })).toMatchObject({
      id: 's-1',
      rankedIds: ['a'],
      outcome: 'answer',
    })
  })
})

describe('provenance helpers', () => {
  it('reduces a URL to its origin and drops a key carried in it', () => {
    expect(originOnly('https://openrouter.ai/api/v1/embeddings?key=sk-or-v1-abc')).toBe('https://openrouter.ai')
    expect(originOnly('not a url')).toBeNull()
    expect(originOnly(undefined)).toBeNull()
  })

  it('keeps a secret out of a baseline whose meta came from such a URL', async () => {
    const url = 'https://openrouter.ai/api/v1/embeddings?key=sk-or-v1-0123456789abcdef0123456789abcdef'
    expect(hasSecret(url)).toBe(true)
    const { baseline } = await capture({ indexHash: 'fixture', host: { embed: originOnly(url) } })
    expect(hasSecret(JSON.stringify(baseline))).toBe(false)
  })

  it('names the golden set by the first sixteen hex of its sha1', () => {
    expect(goldenShaOf('abc')).toBe('a9993e364706816a')
    expect(goldenShaOf(Buffer.from('abc'))).toBe('a9993e364706816a')
  })

  it('reads the Ollama version and the model digests through the injected fetch', async () => {
    const answers = {
      '/api/version': { version: '0.40.12' },
      '/api/tags': {
        models: [
          { name: 'qwen3:8b', digest: 'sha256:500a1f067a9f0123456789' },
          { name: 'bge-m3:latest', digest: '790764642607abcdef0123' },
        ],
      },
    }
    const seen = []
    const fetchFn = async (url) => {
      seen.push(url)
      return { ok: true, json: async () => answers[new URL(url).pathname] }
    }
    const host = await ollamaHost('http://127.0.0.1:11434/some/path?k=v', undefined, fetchFn)
    expect(host).toEqual({
      base: 'http://127.0.0.1:11434',
      version: '0.40.12',
      models: { 'qwen3:8b': '500a1f067a9f', 'bge-m3': '790764642607' },
    })
    expect(seen.sort()).toEqual(['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/version'])
  })

  it('returns null, never throws, when the host is unreachable', async () => {
    const down = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await ollamaHost('http://127.0.0.1:1', undefined, down)).toBeNull()
    expect(await ollamaHost('http://127.0.0.1:1', undefined, async () => ({ ok: false, status: 500 }))).toBeNull()
  })
})
