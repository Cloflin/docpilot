import { describe, it, expect } from 'vitest'

import { chunkMarkdown } from '../src/build/lib/chunker.js'
import { unescapeProse } from '../src/build/lib/markdown-code.js'
import { pageFromHtml } from '../src/build/lib/html-dir.js'

/**
 * WR-15 (engine-spec 043): the extractor writes `\`, `[`, `]`, a backtick and a
 * `<` before a letter as Markdown escapes, and the chunker used to index them as
 * written, so `<h2>Array&lt;T&gt;</h2>` was cited as `Array&lt;T>`.
 */

const body = (h2, p) =>
  `<html><head><title>Guide</title></head><body><main><h1>Guide</h1>` +
  `<h2>${h2}</h2><p>${p}</p></main></body></html>`

const PROSE = 'A paragraph long enough to stand as a section of its own. '.repeat(14)

async function chunksOf(h2, p = PROSE) {
  const { src } = await pageFromHtml(body(h2, p))
  return { src, chunks: chunkMarkdown({ src, path: '/guide', kind: 'guide' }).chunks }
}

describe('unescapeProse', () => {
  it('undoes the four escapes of the extractor in prose', () => {
    expect(unescapeProse('Array&lt;T> and C:\\\\dir, \\[x\\] and \\`tick')).toBe('Array<T> and C:\\dir, [x] and `tick')
  })

  it('leaves a code span and a fence as the author wrote them', () => {
    const md = 'a `\\[x\\]` b \\[y\\]\n\n```js\nconst re = /\\[a\\]/ // &lt;\n```'
    expect(unescapeProse(md)).toBe('a `\\[x\\]` b [y]\n\n```js\nconst re = /\\[a\\]/ // &lt;\n```')
  })

  it('returns text with nothing to undo untouched', () => {
    const md = 'plain words, a | pipe and a `span`\n\n| a | b |\n| - | - |\n| 1 \\| 2 | 3 |'
    expect(unescapeProse(md)).toBe(md)
  })
})

describe('chunk titles and text', () => {
  it('cites a heading with an angle bracket as the page shows it, and slugs that', async () => {
    const { chunks } = await chunksOf('Using Array&lt;T&gt; and C:\\dir')
    const c = chunks.find((x) => x.title.startsWith('Using'))
    expect(c.title).toBe('Using Array<T> and C:\\dir')
    expect(c.title).not.toContain('&lt;')
    expect(c.anchor).toBe('using-array-t-and-c-dir')
    expect(c.text.startsWith('Guide — Using Array<T> and C:\\dir')).toBe(true)
  })

  it('indexes a literal bracket and a literal backslash as the reader typed them', async () => {
    const { chunks } = await chunksOf('Flags', `The [beta] flag and C:\\path. ${PROSE}`)
    const c = chunks.find((x) => x.title === 'Flags')
    expect(c.text).toContain('The [beta] flag and C:\\path.')
    expect(c.text).not.toContain('\\[')
    expect(c.text).not.toContain('\\\\')
  })

  it('does not read an escaped run of backticks as a fence before the split', async () => {
    const { src, chunks } = await chunksOf('Ticks', `${'`'.repeat(3)} is how a fence opens. ${PROSE}`)
    expect(src).toContain('\\`\\`\\`')
    const c = chunks.find((x) => x.title === 'Ticks')
    expect(c.text).toContain('``` is how a fence opens.')
    expect(c.text).toContain('A paragraph long enough')
  })

  it('keeps the escapes a code sample carries', () => {
    const src = '# P\n\n## Regex\n\n' + PROSE + '\n\n```js\nconst re = /\\[a\\]/ // &lt;tag>\n```\n'
    const { chunks } = chunkMarkdown({ src, path: '/p', kind: 'guide' })
    expect(chunks[0].text).toContain('const re = /\\[a\\]/ // &lt;tag>')
  })

  it('writes a merged short section once, with its title as it was', () => {
    const src = '# P\n\n## First\n\n' + PROSE + '\n\n## Tiny \\[x\\]\n\nshort\n'
    const { chunks } = chunkMarkdown({ src, path: '/p', kind: 'guide' })
    // The short section merges into its predecessor, and is unescaped once with it.
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('Tiny [x]\nshort')
  })
})
