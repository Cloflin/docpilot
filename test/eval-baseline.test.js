import { describe, it, expect } from 'vitest'

import { assembleIndex } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { composeQuery } from '../src/theme/docpilot/gate.js'
import { scaleToIndexDomain } from '../src/eval/prefetch.js'
import { rankRecords } from '../src/eval/ranking.js'

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
