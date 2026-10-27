import { describe, it, expect, afterEach, vi } from 'vitest'

import { assembleIndex } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { runTurn } from '../src/theme/docpilot/harness.js'

/**
 * engine-spec 040 — what a search says it searched.
 *
 * Measured on a production site with the 2.1.0 prompt: in every live turn one of
 * the two steps re-searched and got back exactly the six excerpts the host had
 * primed it with, all marked repeated, because the priming result named no query
 * and read as a search nobody had made. On the 2.1.1 prompt two of ten turns
 * still spent a step on a search that found nothing new, and its rows were
 * re-sent on every step after it.
 */

const DIMS = 4
const GUARD = { tau: 0.3, tauLexical: 0.3, wDense: 0.75, wLexical: 0.25, denseMode: 'cosine', cosFloor: 0.44, cosCeil: 0.64, zexp: null }
let n = 0
const twoPageIndex = () => {
  const chunks = [
    { id: 'a#one', path: '/a', anchor: 'one', title: 'Alpha', breadcrumb: 'Docs', kind: 'guide', text: 'The alpha widget is configured with a manifest and a token.', prev: null, next: null },
    { id: 'b#one', path: '/b', anchor: 'one', title: 'Beta', breadcrumb: 'Docs', kind: 'guide', text: 'The beta gadget is switched off with a single flag.', prev: null, next: null },
  ]
  const vectors = new Int8Array(DIMS * chunks.length)
  for (let i = 0; i < chunks.length; i++) vectors[i * DIMS] = 127
  return assembleIndex({
    manifest: {
      version: 3,
      hash: `observations-${++n}`,
      embedModel: 'test',
      dims: DIMS,
      chunkCount: chunks.length,
      vectors: 'vectors.observations.bin',
      pages: [
        { path: '/a', title: 'Alpha', tail: 'Docs' },
        { path: '/b', title: 'Beta', tail: 'Docs' },
      ],
      guard: GUARD,
    },
    shards: [chunks],
    vectorBuffer: vectors.buffer,
    dfDoc: { df: {} },
  })
}

/** The model makes the given calls in order, then answers. */
const turn = async (calls, { composedQuery = null } = {}) => {
  const bodies = []
  vi.stubGlobal('fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    const call = calls[bodies.length - 1] || {
      name: 'answer',
      arguments: JSON.stringify({ text: 'With a manifest [1].', citations: ['a#one'], confidence: 0.9 }),
    }
    return { ok: true, json: async () => ({ message: { tool_calls: [{ function: call }] } }) }
  })
  const index = twoPageIndex()
  const retrieval = createRetrieval({ index, scope: { kind: 'all', paths: [], label: 'All docs' }, guard: GUARD })
  const res = await runTurn({
    retrieval,
    // The gate primed the alpha page alone.
    gateResult: { G: 1, pass: true, chunks: [index.byId.get('a#one')] },
    question: 'how is the alpha widget configured?',
    history: [],
    addendum: '',
    config: { llm: { provider: 'ollama', baseURL: 'http://x', model: 'm' }, maxIterations: 4 },
    fallback: false,
    queryVec: null,
    composedQuery,
  })
  const observations = (i) =>
    bodies[i].messages
      .map((m) => String(m.content))
      .filter((c) => c.startsWith('{'))
      .map((c) => JSON.parse(c))
  return { res, bodies, observations }
}

const search = (args) => ({ name: 'search_docs', arguments: JSON.stringify(args) })

describe('a search says what it searched — engine-spec 040', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names the query the host primed the turn with', async () => {
    const { observations } = await turn([])
    const [primed] = observations(0)
    expect(primed.tool).toBe('search_docs')
    expect(primed.query).toBe('how is the alpha widget configured?')
    expect(primed.results.map((r) => r.id)).toEqual(['a#one'])
  })

  it('names the composed text where that channel won', async () => {
    const composedQuery = 'what is the alpha widget?\nhow is the alpha widget configured?'
    const { observations } = await turn([], { composedQuery })
    expect(observations(0)[0].query).toBe(composedQuery)
  })

  it('answers the priming search asked again from the turn, and refunds it', async () => {
    const { res, observations } = await turn([search({ query: 'How is the alpha widget configured?' })])
    expect(observations(1).at(-1).note).toMatch(/same call as an earlier step/)
    // A refunded step, so the answer came on what is still the first iteration.
    expect(res.iterations).toBe(1)
  })

  it('answers a search that found nothing new with its ids, and charges it', async () => {
    const { res, observations } = await turn([search({ query: 'alpha manifest token' })])
    const found = observations(1).at(-1)
    expect(found).toEqual({
      tool: 'search_docs',
      query: 'alpha manifest token',
      note: expect.stringMatching(/already above/),
      scope: 'All docs',
      ids: ['a#one'],
    })
    // No row per repeat, so nothing to re-send on every later step.
    expect(found.results).toBeUndefined()
    expect(res.iterations).toBe(2)
  })

  it('spells out what a search did find, under the query it ran', async () => {
    const { observations } = await turn([search({ query: 'beta gadget flag' })])
    const found = observations(1).at(-1)
    expect(found.query).toBe('beta gadget flag')
    expect(found.results.map((r) => r.id)).toContain('b#one')
    expect(found.results.find((r) => r.id === 'b#one').text).toMatch(/single flag/)
  })
})
