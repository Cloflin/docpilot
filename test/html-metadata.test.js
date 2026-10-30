import { afterAll, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseHTML } from 'linkedom'

import { metadata, langOf, robotsNoindex, MAX_JSONLD_CHARS } from '../src/build/lib/html-extract.js'
import { extractHtml } from '../src/build/lib/extract-html.js'
import { readHtmlDir } from '../src/build/lib/html-dir.js'

/**
 * Page metadata and the robots wish — engine-spec 043 (D-12, D-27).
 *
 * `metadata(document)` is read before anything is removed: a JSON-LD
 * `dateModified` sits in a `<script>` that the pruner deletes.
 */

const doc = (head, body = '<main><h1>Title</h1></main>', htmlAttrs = '') =>
  parseHTML(`<!doctype html><html ${htmlAttrs}><head>${head}</head><body>${body}</body></html>`).document

const ld = (json) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`

const BODY =
  '<main><h1>Billing</h1><p>Invoices are issued on the first day of every month for the previous one.</p></main>'
const page = (head, htmlAttrs = '') =>
  `<!doctype html><html ${htmlAttrs}><head><title>Billing</title>${head}</head><body>${BODY}</body></html>`

describe('metadata: title and description precedence (HTML-06)', () => {
  const OG = '<meta property="og:title" content="Open Graph Heading">'
  const OGD = '<meta property="og:description" content="Social summary of the page.">'
  const DESC = '<meta name="description" content="Plain summary of the page.">'
  const body = '<main><h1>Visible Heading</h1></main>'

  it('takes og:title over the h1, and the h1 over the title element', () => {
    const all = doc(`<title>Browser Tab Name</title>${OG}`, body)
    expect(metadata(all).title).toBe('Open Graph Heading')
    const noOg = doc('<title>Browser Tab Name</title>', body)
    expect(metadata(noOg).title).toBe('Visible Heading')
    const onlyTitle = doc('<title>Browser Tab Name</title>', '<main><p>No heading here.</p></main>')
    expect(metadata(onlyTitle).title).toBe('Browser Tab Name')
  })

  it('takes meta description over og:description, and falls back to og:description', () => {
    expect(metadata(doc(`${OGD}${DESC}`)).description).toBe('Plain summary of the page.')
    expect(metadata(doc(OGD)).description).toBe('Social summary of the page.')
    expect(metadata(doc('')).description).toBe('')
  })
})

describe('metadata: dateModified', () => {
  it('reads a JSON-LD Article date', () => {
    const d = doc(ld({ '@type': 'Article', dateModified: '2026-01-02T10:00:00Z' }))
    expect(metadata(d).dateModified).toBe('2026-01-02T10:00:00Z')
  })

  it('finds the Article inside a @graph array', () => {
    const d = doc(
      ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'Article', dateModified: '2026-02-03' }] }),
    )
    expect(metadata(d).dateModified).toBe('2026-02-03')
  })

  it('falls back to article:modified_time', () => {
    const d = doc('<meta property="article:modified_time" content="2026-03-04">')
    expect(metadata(d).dateModified).toBe('2026-03-04')
  })

  it('refuses a value that is not ISO 8601', () => {
    const d = doc('<meta property="article:modified_time" content="last Tuesday">')
    expect(metadata(d).dateModified).toBe('')
  })

  it('survives broken JSON and an oversized block', () => {
    const broken = doc('<script type="application/ld+json">{"dateModified": </script>')
    expect(metadata(broken).dateModified).toBe('')
    const big = ld({ dateModified: '2026-01-01', pad: 'x'.repeat(MAX_JSONLD_CHARS) })
    expect(metadata(doc(big)).dateModified).toBe('')
  })

  it('is read before the pruner removes the script', async () => {
    const html = page(ld({ '@type': 'Article', dateModified: '2026-05-06T07:08:09Z' }))
    const r = await extractHtml(html)
    expect(r.ok).toBe(true)
    expect(r.dateModified).toBe('2026-05-06T07:08:09Z')
  })
})

describe('metadata: language, canonical, base', () => {
  it('langOf gives the primary subtag, lowercased', () => {
    expect(langOf(doc('', undefined, 'lang="en-GB"'))).toBe('en')
    expect(langOf(doc('', undefined, 'lang="UK"'))).toBe('uk')
    expect(langOf(doc(''))).toBe('')
  })

  it('reads the canonical link and the base href as written', () => {
    const d = doc('<link rel="Canonical" href="https://acme.test/a"><base href="/docs/">')
    const m = metadata(d)
    expect(m.canonical).toBe('https://acme.test/a')
    expect(m.baseHref).toBe('/docs/')
    expect(metadata(doc('')).canonical).toBe('')
  })

  it('the extract result carries an absolute canonical, and null for javascript:', async () => {
    const ok = await extractHtml(page('<link rel="canonical" href="https://acme.test/a">', 'lang="en-GB"'))
    expect(ok.canonical).toBe('https://acme.test/a')
    expect(ok.lang).toBe('en')
    const rel = await extractHtml(page('<link rel="canonical" href="/b">'), { base: 'https://acme.test/x' })
    expect(rel.canonical).toBe('https://acme.test/b')
    const bad = await extractHtml(page('<link rel="canonical" href="javascript:alert(1)">'))
    expect(bad.canonical).toBeNull()
  })
})

describe('robots noindex', () => {
  it('robotsNoindex reads tokens, case-insensitively', () => {
    expect(robotsNoindex('NOINDEX, follow')).toBe(true)
    expect(robotsNoindex('none')).toBe(true)
    expect(robotsNoindex('index, follow')).toBe(false)
    expect(robotsNoindex('')).toBe(false)
    expect(robotsNoindex(undefined)).toBe(false)
  })

  it('a robots meta with noindex skips the page', async () => {
    const r = await extractHtml(page('<meta name="ROBOTS" content="NOINDEX, follow">'))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('noindex')
    expect(r.noindex).toBe(true)
  })

  it('index, follow does not', async () => {
    const r = await extractHtml(page('<meta name="robots" content="index, follow">'))
    expect(r.ok).toBe(true)
    expect(r.noindex).toBe(false)
  })

  it('the X-Robots-Tag header value is the option robots', async () => {
    const r = await extractHtml(page(''), { robots: 'noindex' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('noindex')
  })
})

describe('readHtmlDir and noindex', () => {
  const made = []
  afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

  it('skips the noindex page, keeps the other, and says why', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-robots-'))
    made.push(dir)
    fs.writeFileSync(path.join(dir, 'hidden.html'), page('<meta name="robots" content="noindex">'))
    fs.writeFileSync(path.join(dir, 'open.html'), page(''))
    const warnings = []
    const pages = await readHtmlDir({ dir, warn: (m) => warnings.push(m) })
    expect(pages).toHaveLength(1)
    expect(pages[0].route).toMatch(/open/)
    expect(warnings.some((w) => /skipped hidden\.html: noindex/.test(w))).toBe(true)
  })
})
