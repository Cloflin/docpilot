import { describe, it, expect } from 'vitest'

import { assembleIndex } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { TOOLS } from '../src/theme/docpilot/prompt.js'
import { toolSchemas } from '../src/theme/docpilot/llm.js'
import { srcText } from './helpers/source.js'

/**
 * `expand_section` — engine-specs/004.
 *
 * Two subjects, and they are deliberately separate. The retrieval half is
 * behaviour and is driven directly. The harness half is a CONTRACT — always
 * charges, caps at two, cites what it emitted — and is asserted over the source,
 * the way the other harness invariants in this suite are, because reaching it
 * behaviourally means standing up a model.
 */

const DIMS = 4
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

let fixtures = 0
const makeIndex = (chunks) => {
  const hash = `expand-${++fixtures}`
  const paths = [...new Set(chunks.map((c) => c.path))]
  return assembleIndex({
    manifest: {
      version: 3,
      hash,
      embedModel: 'test',
      dims: DIMS,
      chunkCount: chunks.length,
      vectors: null,
      pages: paths.map((p) => ({ path: p, title: `Page ${p}`, tail: 'Docs' })),
      guard: GUARD,
    },
    shards: [chunks],
    vectorBuffer: null,
    dfDoc: { df: {} },
  })
}

/** A page of `n` sections, linked forward the way the chunker links them. */
const page = (path, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${path.slice(1)}#s${i + 1}`,
    path,
    anchor: `s${i + 1}`,
    title: `Section ${i + 1}`,
    breadcrumb: 'Docs',
    kind: 'guide',
    text: `Body of section ${i + 1} on ${path}.`,
    next: i < n - 1 ? `${path.slice(1)}#s${i + 2}` : null,
  }))

const ALL = { kind: 'all', paths: [], label: 'all docs' }
const only = (paths) => ({ kind: 'pages', paths, label: 'one page' })

describe('retrieval.expand', () => {
  const index = () => makeIndex([...page('/a', 3), ...page('/b', 2)])

  it('walks forward with the pointer the chunker already writes', () => {
    const r = createRetrieval({ index: index(), scope: ALL, guard: GUARD })
    expect(r.expand('a#s1', 'next')).toMatchObject({ ok: true, section: { id: 'a#s2' } })
  })

  /**
   * The backward direction has no field in the index. It is derived at load, so
   * no shipped index has to be rebuilt and the corpus hash does not move.
   */
  it('walks backward without a prev field in the index', () => {
    const r = createRetrieval({ index: index(), scope: ALL, guard: GUARD })
    expect(r.expand('a#s3', 'prev')).toMatchObject({ ok: true, section: { id: 'a#s2' } })
  })

  it('stops at both ends of a page rather than crossing into the next one', () => {
    const r = createRetrieval({ index: index(), scope: ALL, guard: GUARD })
    expect(r.expand('a#s3', 'next')).toEqual({ ok: false, reason: 'no-neighbour' })
    expect(r.expand('a#s1', 'prev')).toEqual({ ok: false, reason: 'no-neighbour' })
  })

  it('refuses an id that is not in the corpus', () => {
    const r = createRetrieval({ index: index(), scope: ALL, guard: GUARD })
    expect(r.expand('nope#s1', 'next')).toEqual({ ok: false, reason: 'unknown-id' })
  })

  /**
   * Scope is the choke point, and expansion may not step around it. A section
   * whose page the reader excluded reports the same nothing as the end of a page
   * — never `out-of-scope`, which would confirm the id exists.
   */
  it('cannot leave the scope in either role', () => {
    const r = createRetrieval({ index: index(), scope: only(['/b']), guard: GUARD })
    expect(r.expand('a#s1', 'next')).toEqual({ ok: false, reason: 'out-of-scope' })
    expect(r.expand('b#s1', 'next')).toMatchObject({ ok: true, section: { id: 'b#s2' } })
  })

  it('defaults to forward for anything that is not "prev"', () => {
    const r = createRetrieval({ index: index(), scope: ALL, guard: GUARD })
    expect(r.expand('a#s1', 'sideways')).toMatchObject({ ok: true, section: { id: 'a#s2' } })
  })
})

describe('expand_section — the contract the model is handed', () => {
  it('is a declared tool with an id and a direction', () => {
    const tool = TOOLS.find((t) => t.name === 'expand_section')
    expect(tool, 'expand_section is not in TOOLS').toBeTruthy()
    expect(Object.keys(tool.parameters)).toEqual(['id', 'direction'])
    expect(tool.parameters.direction).toContain('next | prev')
  })

  it('reaches the provider as a function schema', () => {
    const schema = toolSchemas().find((t) => t.function.name === 'expand_section')
    expect(schema.function.parameters.properties.direction.type).toBe('string')
    // Nothing is required: an id-only call means "next", which is the common case.
    expect(schema.function.parameters.required).toEqual([])
  })
})

describe('expand_section — the harness invariants', () => {
  const src = srcText('src/theme/docpilot/harness.js')

  it('goes through retrieval, never the index', () => {
    // `check-docpilot.sh` enforces the file-wide rule — the harness holds no
    // index reference — and it reads code, not the header comment that NAMES
    // `index.byId.get` to explain why it is absent. This asserts the positive
    // half for the new tool: it resolves through the object the host admitted.
    expect(src).toMatch(/retrieval\.expand\(/)
  })

  /**
   * A refunded expansion is a free step, and a free step is a loop: `next` from
   * the first chunk of a page to the last, one lap each, refunding every one.
   */
  it('always charges — it is never added to the free paths', () => {
    const block = src.slice(src.indexOf("if (name === 'expand_section')"), src.indexOf("if (name === 'list_pages')"))
    expect(block).not.toContain('free: true')
    expect(block).toContain('expansions++')
    expect(block).toContain('MAX_EXPANSIONS')
  })

  it('caps the turn rather than the page', () => {
    expect(src).toMatch(/const MAX_EXPANSIONS = 2/)
    // Declared beside the loop's other counters, reset per turn with them.
    expect(src).toMatch(/let expansions = 0/)
  })

  it('makes what it emitted citable, exactly as a search result is', () => {
    const block = src.slice(src.indexOf("if (name === 'expand_section')"), src.indexOf("if (name === 'list_pages')"))
    expect(block).toContain('emittedIds.add(res.section.id)')
    expect(block).toContain('spelled.add(res.section.id)')
  })

  it('keeps unknown and out-of-scope indistinguishable', () => {
    const block = src.slice(src.indexOf("if (name === 'expand_section')"), src.indexOf("if (name === 'list_pages')"))
    expect(block).not.toContain('out of scope')
    expect(block).toContain("'unknown id'")
  })
})
