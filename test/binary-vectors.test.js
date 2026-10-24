import { describe, it, expect } from 'vitest'

import {
  l2normalise,
  toInt8,
  packSigns,
  binaryScale,
  binaryQuantisationError,
} from '../src/build/lib/quantize.js'
import { assembleIndex, unpackSigns } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'

/**
 * engine-spec 027 — one sign bit per dimension.
 *
 * The packed layout has two ends, `packSigns` in the build and `unpackSigns` in
 * the browser, and nothing but these tests holds them to the same bit order.
 */

// Deterministic, so a failure reproduces. Not Math.random: a flaky fit is a
// fit nobody can debug.
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff - 0.5
}

/** Vectors that share a common direction, as real embeddings do. */
const corpus = (n, dims, seed = 7) => {
  const r = rng(seed)
  const topics = Array.from({ length: 4 }, () => Array.from({ length: dims }, r))
  return Array.from({ length: n }, (_, i) =>
    l2normalise(topics[i % 4].map((t) => t + 0.8 * r())),
  )
}

describe('packSigns / unpackSigns', () => {
  it('round-trips the sign of every dimension, including a width that is not a multiple of 8', () => {
    const vs = corpus(5, 37)
    const bytes = packSigns(vs)
    expect(bytes.length).toBe(5 * Math.ceil(37 / 8))
    const back = unpackSigns(bytes, 5, 37)
    vs.forEach((v, r) => {
      for (let i = 0; i < 37; i++) expect(back[r * 37 + i]).toBe(v[i] >= 0 ? 1 : -1)
    })
  })
})

describe('binaryScale', () => {
  it('puts the asymmetric sign score back on the cosine scale', () => {
    const vs = corpus(80, 1024)
    const scale = binaryScale(vs)
    expect(scale).toBeGreaterThan(0)
    expect(binaryQuantisationError(vs, scale)).toBeLessThan(0.03)
    // A scale off by 2× is the failure this guards: it ranks the same and moves
    // every D, which is every calibrated threshold.
    expect(binaryQuantisationError(vs, scale * 2)).toBeGreaterThan(binaryQuantisationError(vs, scale))
  })
})

describe('a 1-bit index', () => {
  const DIMS = 256
  const vs = corpus(12, DIMS)
  const rows = vs.map((_, i) => ({
    id: `p${i % 3}#c${i}`,
    path: `/p${i % 3}`,
    anchor: `c${i}`,
    title: `Chunk ${i}`,
    breadcrumb: 'Docs',
    kind: 'guide',
    text: `chunk number ${i}`,
    next: null,
  }))
  const manifest = (extra) => ({
    version: 3,
    hash: `binary-${Math.random()}`,
    embedModel: 'test',
    dims: DIMS,
    vectors: 'vectors.bin',
    chunkCount: rows.length,
    pages: [0, 1, 2].map((p) => ({ path: `/p${p}`, title: `P${p}`, tail: 'Docs' })),
    sections: [],
    guard: { tau: 0.3, tauLexical: 0.3, wDense: 0.75, wLexical: 0.25, denseMode: 'cosine', cosFloor: 0.44, cosCeil: 0.64, zexp: null },
    ...extra,
  })
  const build = (extra, buffer) =>
    assembleIndex({
      manifest: manifest(extra),
      shards: [rows.map((r) => ({ ...r }))],
      vectorBuffer: buffer,
      dfDoc: { df: {} },
    })

  it('checks the blob against chunkCount × dims / 8, not × dims', () => {
    const packed = packSigns(vs)
    expect(() => build({ quant: 'binary', cosScale: 0.1 }, packed.buffer)).not.toThrow()
    expect(() => build({}, packed.buffer)).toThrow(/chunkCount × dims/)
  })

  it('ranks like the int8 index and reports D on the same scale', () => {
    const int8 = new Int8Array(vs.length * DIMS)
    vs.forEach((v, i) => int8.set(toInt8(v), i * DIMS))
    const a = build({}, int8.buffer)
    const b = build({ quant: 'binary', cosScale: binaryScale(vs) }, packSigns(vs).buffer)
    const scope = { kind: 'all', paths: [], label: 'All docs' }
    const query = Float64Array.from(vs[5], (x) => x * 127)
    const top = (index) =>
      createRetrieval({ index, scope, guard: index.manifest.guard }).search({ query: '', queryVec: query, k: 3 })
    expect(top(b)[0].id).toBe(top(a)[0].id)
    const D = (index) =>
      createRetrieval({ index, scope, guard: index.manifest.guard }).evaluate({
        question: 'zzz',
        queryVec: query,
        mode: 'hybrid',
      }).D
    expect(Math.abs(D(a) - D(b))).toBeLessThan(0.05)
  })
})
