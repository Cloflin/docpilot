import { describe, it, expect } from 'vitest'

import { renderBlocks } from '../src/build/lib/ir.js'

/**
 * The block stream — engine-specs/003.
 *
 * These are the rules a second source format would otherwise have to rediscover.
 * They were reachable only through a DOM before the split, which is why none of
 * them had a test of its own: asserting the fence-length rule meant building an
 * HTML page that happened to produce a fence.
 */

describe('renderBlocks', () => {
  it('normalises the heading ladder rather than copying it', () => {
    // A template that nests its sections under an <h3> would otherwise produce a
    // file with no `##` in it at all, and the chunker splits on heading level.
    const { markdown } = renderBlocks([
      { kind: 'h', level: 3, text: 'Install' },
      { kind: 'p', text: 'Body.' },
      { kind: 'h', level: 4, text: 'From npm' },
    ])
    expect(markdown).toBe('## Install\n\nBody.\n\n### From npm')
  })

  it('never goes below minHeading or above six', () => {
    const { markdown } = renderBlocks([
      { kind: 'h', level: 1, text: 'Top' },
      { kind: 'h', level: 9, text: 'Deep' },
    ])
    expect(markdown.split('\n\n')).toEqual(['## Top', '###### Deep'])
  })

  it('opens a fence longer than anything inside the sample', () => {
    const { markdown } = renderBlocks([
      { kind: 'code', lang: 'md', text: '```js\nconst a = 1\n```' },
    ])
    expect(markdown.startsWith('````md\n')).toBe(true)
    expect(markdown.endsWith('\n````')).toBe(true)
  })

  it('writes a plain three-backtick fence when the sample holds none', () => {
    const { markdown } = renderBlocks([{ kind: 'code', lang: 'bash', text: 'npm i' }])
    expect(markdown).toBe('```bash\nnpm i\n```')
  })

  it('puts the notes of a table underneath it', () => {
    const { markdown } = renderBlocks([
      { kind: 'table', text: '| a | b |\n| --- | --- |', notes: [{ term: 'a', definition: 'the first' }] },
    ])
    expect(markdown).toBe('| a | b |\n| --- | --- |\n\n- **a** — the first')
  })

  it('collects the absolute links it emitted', () => {
    const { links } = renderBlocks([
      { kind: 'p', text: 'See [docs](https://acme.test/docs) and [rel](/local).' },
    ])
    expect(links).toEqual(['https://acme.test/docs'])
  })

  it('reports the headings in document order', () => {
    const { headings } = renderBlocks([
      { kind: 'h', level: 2, text: 'One' },
      { kind: 'p', text: 'x' },
      { kind: 'h', level: 2, text: 'Two' },
    ])
    expect(headings).toEqual(['One', 'Two'])
  })

  it('is empty for an empty stream rather than throwing on Math.min', () => {
    expect(renderBlocks([])).toEqual({ markdown: '', headings: [], links: [] })
  })
})
