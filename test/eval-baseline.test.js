import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

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
  replayBorrowing,
  MissingVector,
  diffBaseline,
} from '../src/eval/baseline.js'
import { hasSecret } from '../src/theme/docpilot/credentials.js'
import { readIndexDir } from '../src/server/index.js'
import { underPath } from '../src/eval/metrics.js'

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

  it('carries the missing text on the error, so a capture can look it up', async () => {
    const { index } = await capture()
    const err = await replayBaseline({ index, guard: GUARD, records: [RECORDS[0]], baseline: { vectors: {} } }).catch((e) => e)
    expect(err).toBeInstanceOf(MissingVector)
    expect(err.text).toBe(RECORDS[0].question)
  })

  it('borrows a text the live run never asked for, and stores it with the others', async () => {
    const { index, baseline } = await capture()
    const all = decodeVectors(baseline)
    const [taken] = [...all.keys()]
    const asked = new Map([...all].filter(([t]) => t !== taken))
    const { replayed, borrowed } = await replayBorrowing({
      index,
      guard: GUARD,
      records: RECORDS,
      asked,
      borrow: (t) => all.get(t),
    })
    expect(borrowed).toEqual([taken])
    expect(asked.has(taken)).toBe(true)
    expect(diffBaseline(baseline, replayed)).toEqual([])
  })

  it('does not borrow when nothing is missing, and refuses what the lender cannot supply', async () => {
    const { index, baseline } = await capture()
    const all = decodeVectors(baseline)
    const lend = vi.fn(() => undefined)
    const full = await replayBorrowing({ index, guard: GUARD, records: RECORDS, asked: new Map(all), borrow: lend })
    expect(full.borrowed).toEqual([])
    expect(lend).not.toHaveBeenCalled()
    const [taken] = [...all.keys()]
    const short = new Map([...all].filter(([t]) => t !== taken))
    await expect(
      replayBorrowing({ index, guard: GUARD, records: RECORDS, asked: short, borrow: lend }),
    ).rejects.toBeInstanceOf(MissingVector)
    expect(lend).toHaveBeenCalledWith(taken)
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

/**
 * THE 2.1.1 BASELINES, REPLAYED OFFLINE (D-02, EVAL-01, EVAL-02).
 *
 * `docpilot/baselines/2.1.1.<index>.json` freezes what 2.1.1 ranks for every
 * golden record, together with the int8 query vectors the ranking came from. This
 * block loads the COMMITTED index off disk, replays the ranking from the frozen
 * vectors and fails on any record whose `rankedIds`, `retrievedIds`, `channel` or
 * gate result moved. `fetch` throws for the length of the block: the gate is
 * offline by construction, so it runs on a machine with no Ollama and no key.
 *
 * A deliberate ranking change is reviewed as the diff of the baseline file:
 * rewrite it with the command each failure message names.
 *
 * The same block pins two provenance rules. The baseline names the index it was
 * taken on (`meta.indexHash`) and the golden set (`meta.goldenSha`); when either
 * moved, the file is stale and the message says how to refresh it. And the
 * committed manifest carries a MEASURED guard (EVAL-02): `source` is not
 * 'provisional' and `calibratedAt` is the manifest's own hash, because
 * `guardFor` inlines a calibration only when the two agree.
 */
const ROOT = path.resolve(import.meta.dirname, '..')
const GOLDEN_FILE = path.join(ROOT, 'docpilot/golden.jsonl')

/** The ids and pages of a loaded index, the way `lint` resolves a gold entry. */
function resolvesInIndex(index, gold) {
  const ids = index.chunks.map((c) => c.id)
  const pages = new Set(index.chunks.map((c) => c.path))
  return ids.includes(gold) || pages.has(`/${gold}`) || pages.has(gold) || ids.some((id) => underPath(id, gold))
}

function frozenBaselineSuite({ label, indexDir, baselineFile, kind }) {
  const rel = `docpilot/baselines/${baselineFile}`
  const refresh =
    `node bin/docpilot.js eval --gate-only --baseline=${rel} --update-baseline` +
    ` (against ${path.basename(indexDir)})`

  describe(`the 2.1.1 baseline — ${label}`, () => {
    let index
    let manifest
    let golden
    let goldenText
    let baselineText
    let baseline
    let replayed

    beforeAll(async () => {
      vi.stubGlobal('fetch', () => {
        throw new Error('the offline baseline gate must not reach the network')
      })
      index = readIndexDir(path.join(ROOT, indexDir))
      manifest = index.manifest
      goldenText = fs.readFileSync(GOLDEN_FILE, 'utf8')
      golden = goldenText
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      baselineText = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      baseline = JSON.parse(baselineText)
      replayed = await replayBaseline({ index, guard: manifest.guard, records: golden, baseline })
    })

    afterAll(() => {
      vi.unstubAllGlobals()
    })

    it('names the index and the golden set it was taken on, and both are still the committed ones', () => {
      expect(baseline.meta.schema, rel).toBe(BASELINE_SCHEMA)
      expect(baseline.meta.indexHash, `the index moved since the baseline was taken — ${refresh}`).toBe(manifest.hash)
      expect(baseline.meta.goldenSha, `docpilot/golden.jsonl changed since the baseline was taken — ${refresh}`).toBe(
        goldenShaOf(goldenText),
      )
      expect(baseline.meta.embedModel).toBe(manifest.embedModel)
      expect(baseline.meta.guard).toEqual(manifest.guard)
    })

    it('carries a measured guard stamped for this corpus (EVAL-02)', () => {
      expect(manifest.guard.source).not.toBe('provisional')
      expect(manifest.guard.calibratedAt).toBe(manifest.hash)
    })

    it('holds one record per golden record, and a vector for every question it asks', () => {
      expect(Object.keys(baseline.records).sort()).toEqual(golden.map((r) => r.id).sort())
      expect(baseline.meta.vectors.count).toBe(Object.keys(baseline.vectors).length)
      expect(replayed).toHaveLength(golden.length)
    })

    it('ranks every golden record exactly as the frozen run did', () => {
      const diffs = diffBaseline(baseline, replayed)
      expect(diffs, `${diffs.length} record field(s) moved — ${refresh}`).toEqual([])
    })

    it('names a gold chunk that exists in the index, for every golden record', () => {
      const missing = golden.flatMap((r) =>
        (r.gold_chunks || []).filter((g) => !resolvesInIndex(index, g)).map((g) => `${r.id}: ${g}`),
      )
      expect(missing).toEqual([])
    })

    it('names the host that measured it, and carries no credential-shaped string', () => {
      expect(hasSecret(baselineText)).toBe(false)
      const host = baseline.meta.host
      expect(originOnly(host.embed)).toBe(host.embed)
      if (kind === 'ollama') {
        // D-07: an Ollama build and a model digest are part of the measurement.
        expect(host.ollama.base).toBe(host.embed)
        expect(host.ollama.version).toMatch(/^\d+\.\d+\.\d+/)
        expect(host.ollama.models[manifest.embedModel]).toMatch(/^[0-9a-f]{12}$/)
      } else {
        expect(host.embed).toBe('https://openrouter.ai')
        expect(host.ollama).toBeNull()
      }
    })
  })
}

frozenBaselineSuite({
  label: 'rag-local',
  indexDir: 'docs/public/rag-local',
  baselineFile: '2.1.1.rag-local.json',
  kind: 'ollama',
})

frozenBaselineSuite({
  label: 'rag',
  indexDir: 'docs/public/rag',
  baselineFile: '2.1.1.rag.json',
  kind: 'openrouter',
})

/**
 * THE 2.1.1 ANSWER-QUALITY BASELINES — well-formedness only (D-06, D-07).
 *
 * `2.1.1.rag-local.answers.json` (browser runtime) and `2.1.1.rag-local.server.json`
 * (the in-process server turn) are what a model answered on one host. A model call
 * cannot be replayed offline, so verify does not compare them: `eval --baseline=<file>`
 * does, on the same host, and its exit code follows the rankings alone. What verify can
 * hold is that each file is the whole golden set, that it names the machine and the
 * models that produced it, and that it carries no credential.
 *
 * The host is whatever Ollama the maintainer measured on (plan 01-09 used the LAN box,
 * not 127.0.0.1) — never a hosted origin, because an answer baseline that quietly came
 * from a metered provider would not be comparable with a local rerun.
 */
const PRIVATE_HOST = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)(:\d+)?$/

function answerBaselineSuite({ title, baselineFile, runtime, vectors }) {
  const rel = `docpilot/baselines/${baselineFile}`

  describe(title, () => {
    let manifest
    let golden
    let baselineText
    let baseline

    beforeAll(() => {
      vi.stubGlobal('fetch', () => {
        throw new Error('the offline baseline checks must not reach the network')
      })
      manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/public/rag-local/manifest.json'), 'utf8'))
      golden = fs
        .readFileSync(GOLDEN_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      baselineText = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      baseline = JSON.parse(baselineText)
    })

    afterAll(() => {
      vi.unstubAllGlobals()
    })

    it('holds one record per golden record, each with a ranking and an outcome', () => {
      expect(Object.keys(baseline.records).sort()).toEqual(golden.map((r) => r.id).sort())
      for (const [id, rec] of Object.entries(baseline.records)) {
        expect(Array.isArray(rec.rankedIds), `${id}.rankedIds`).toBe(true)
        expect(typeof rec.outcome, `${id}.outcome`).toBe('string')
      }
    })

    it('names the index, the golden set, the model and the runtime it was measured on', () => {
      expect(baseline.meta.schema).toBe(BASELINE_SCHEMA)
      expect(baseline.meta.indexHash).toBe(manifest.hash)
      expect(baseline.meta.embedModel).toBe(manifest.embedModel)
      expect(baseline.meta.goldenSha).toBe(goldenShaOf(fs.readFileSync(GOLDEN_FILE, 'utf8')))
      expect(baseline.meta.runtime).toBe(runtime)
      expect(baseline.meta.gateOnly).toBe(false)
      expect(baseline.meta.model).toBe('qwen3:8b')
    })

    it('summarises recall, ranking, groundedness and both refusal rates', () => {
      for (const key of [
        'recall8',
        'mrr',
        'citationPrecision',
        'supportPrecision',
        'unsupportedAnswerRate',
        'gateOverRefusal',
        'answerOverRefusal',
      ]) {
        expect(typeof baseline.summary[key], `summary.${key}`).toBe('number')
      }
    })

    it('names the mapping Phase 10 compares groundedness by', () => {
      expect(baseline.meta.groundedness).toEqual(GROUNDEDNESS_KEYS)
      for (const key of GROUNDEDNESS_KEYS) expect(typeof baseline.summary[key]).toBe('number')
    })

    it('names the Ollama host, its version and the digest of the chat and embed models (D-07)', () => {
      const host = baseline.meta.host
      expect(host.chat).toMatch(PRIVATE_HOST)
      expect(host.embed).toMatch(PRIVATE_HOST)
      expect(originOnly(host.chat)).toBe(host.chat)
      expect(host.ollama.base).toBe(host.embed)
      expect(host.ollama.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(host.ollama.models['qwen3:8b']).toMatch(/^[0-9a-f]{12}$/)
      expect(host.ollama.models[manifest.embedModel]).toMatch(/^[0-9a-f]{12}$/)
    })

    // The server embeds inside its own turn, so a server run has no query vectors to freeze.
    it(vectors ? 'freezes the int8 query vectors of the browser run' : 'carries no vectors', () => {
      if (vectors) expect(Object.keys(baseline.vectors).length).toBe(baseline.meta.vectors.count)
      else expect(baseline.vectors).toBeUndefined()
    })

    it('carries no credential-shaped string', () => {
      expect(hasSecret(baselineText)).toBe(false)
    })
  })
}

answerBaselineSuite({
  title: 'the 2.1.1 answer baseline — rag-local, browser',
  baselineFile: '2.1.1.rag-local.answers.json',
  runtime: 'browser',
  vectors: true,
})

answerBaselineSuite({
  title: 'the 2.1.1 server baseline — rag-local',
  baselineFile: '2.1.1.rag-local.server.json',
  runtime: 'server',
  vectors: false,
})

/**
 * A FILE THAT CANNOT BE COMPARED WITH IS REFUSED BEFORE THE RUN SPENDS ANYTHING.
 *
 * The check sits at module scope in src/eval/run.ts, so these runs end before an
 * index is read or a request is made — which is also what keeps them offline.
 * They need the built `dist/`, like every test that spawns the CLI.
 */
describe('eval --baseline= with a file that is not a baseline', () => {
  let dir
  const evalWith = (file) =>
    spawnSync(process.execPath, [path.join(ROOT, 'bin/docpilot.js'), 'eval', `--baseline=${file}`], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: os.tmpdir() },
    })
  const write = (name, body) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-baseline-'))
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['a file with no meta.schema (the bundle report)', 'bundle.json', JSON.stringify({ files: [] })],
    ['a baseline whose records are an array', 'array.json', JSON.stringify({ meta: { schema: BASELINE_SCHEMA }, records: [] })],
    ['a baseline whose records are missing', 'norecords.json', JSON.stringify({ meta: { schema: BASELINE_SCHEMA } })],
  ])('exits 1 on %s', (_label, name, body) => {
    const r = evalWith(write(name, body))
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/is not a schema-1 baseline/)
  })

  it('exits 1 on a file that is not there, and says how to write it', () => {
    const r = evalWith(path.join(dir, 'missing.json'))
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/cannot read the baseline/)
    expect(r.stderr).toMatch(/--update-baseline/)
  })
})
