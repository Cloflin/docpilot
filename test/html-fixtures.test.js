import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { extractHtml } from '../src/build/lib/extract-html.js'

/**
 * The six synthetic pages of engine-spec 043, through `extractHtml`.
 *
 * The snapshot is the extractor's WHOLE output on brand-free pages (D-14): each
 * page reproduces the DOM pattern of a real source and none of its text. A rule
 * change that moves a snapshot is reviewed as the diff of its `expected.md`. A
 * change to any `expected.md` is also an EXTRACTOR_VERSION question: bump it
 * once per release, not per rule (Phase 2 is version 2, the first 3.0
 * extractor).
 *
 * Beside the snapshot, each page holds three plain assertions that do not
 * depend on how the Markdown is laid out: every line of `truth.txt` is in the
 * output, no string of `noise.txt` is, and two runs are byte-identical
 * (HTML-07, HTML-13, D-15).
 */

const ROOT = path.resolve('test/fixtures/html-extract')

/** A page with no canonical resolves its links against this origin. */
const FALLBACK_BASE = 'https://help.acme.test/'

const NAMES = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

const read = (name, file) => fs.readFileSync(path.join(ROOT, name, file), 'utf8')
const lines = (text) => text.split('\n').filter((l) => l.trim() !== '')
const collapse = (text) => text.replace(/\s+/g, ' ').trim()

/** The page's own canonical URL: the base a browser-less reader would infer. */
function baseOf(html) {
  const m = /<link\s+rel="canonical"\s+href="([^"]+)"/.exec(html)
  return m ? m[1] : FALLBACK_BASE
}

const run = (name) => {
  const html = read(name, 'input.html')
  return extractHtml(html, { base: baseOf(html), id: name })
}

describe('html extraction fixtures', () => {
  it('holds all six pages', () => {
    expect(NAMES).toEqual(['accordion', 'cookie-banner', 'help-article', 'marketing', 'openapi-article', 'tabs'])
  })

  for (const name of NAMES) {
    it(`${name}: snapshot, truth lines, no noise, same bytes twice`, async () => {
      const first = await run(name)
      expect(first.ok, first.reason).toBe(true)

      await expect(first.markdown + '\n').toMatchFileSnapshot(`./fixtures/html-extract/${name}/expected.md`)

      const flat = collapse(first.markdown)
      for (const line of lines(read(name, 'truth.txt'))) {
        expect(flat, `truth line missing from ${name}: ${line}`).toContain(collapse(line))
      }
      for (const line of lines(read(name, 'noise.txt'))) {
        expect(flat, `noise string present in ${name}: ${line}`).not.toContain(collapse(line))
      }

      const second = await run(name)
      expect(second.markdown).toBe(first.markdown)
    })
  }

  it('openapi-article: the relative link resolves against the canonical URL', async () => {
    const result = await run('openapi-article')
    expect(result.markdown).toContain('](https://help.acme.test/reference/messages)')
    expect(result.report.linksDegraded).toBe(0)
  })
})
