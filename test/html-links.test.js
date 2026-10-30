import { describe, it, expect } from 'vitest'

import { extractHtml, linkBaseFor } from '../src/build/lib/extract-html.js'
import { createLinkResolver, MAX_LINK_SAMPLES } from '../src/build/lib/html-links.js'

/**
 * Link resolution — engine-spec 043 (D-10, research Pattern 4).
 *
 * A relative link resolves against `<base href>`, then the page's canonical
 * URL, then the `base` option. A link that cannot resolve is text, counted and
 * named; a non-web scheme is text and is not a failure.
 */

const SENTENCE = 'Invoices are issued on the first day of every month for the previous one.'
const page = (head, body) =>
  `<!doctype html><html><head><title>Billing</title>${head}</head><body><main><h1>Billing</h1><p>${SENTENCE}</p>${body}</main></body></html>`

describe('linkBaseFor', () => {
  it('prefers <base>, then the canonical, then the option', () => {
    const meta = { baseHref: '/docs/', canonical: 'https://acme.test/help/articles/42' }
    expect(linkBaseFor(meta, 'https://acme.test/x/page')).toBe('https://acme.test/docs/')
    expect(linkBaseFor({ ...meta, baseHref: '' }, 'https://other.test/')).toBe('https://acme.test/help/articles/42')
    expect(linkBaseFor({ baseHref: '', canonical: '' }, 'https://other.test/p')).toBe('https://other.test/p')
    expect(linkBaseFor({ baseHref: '', canonical: '' }, '')).toBe('')
  })

  it('ignores a base or canonical that is not http(s)', () => {
    const meta = { baseHref: 'javascript:alert(1)', canonical: 'data:text/html,x' }
    expect(linkBaseFor(meta, 'https://acme.test/p')).toBe('https://acme.test/p')
    expect(linkBaseFor(meta, 'ftp://acme.test/p')).toBe('')
  })

  it('a relative <base> with no usable option base does not resolve', () => {
    expect(linkBaseFor({ baseHref: '/docs/', canonical: '' }, '')).toBe('')
  })
})

describe('the resolver counters', () => {
  it('counts resolved, degraded and schemeDropped apart', () => {
    const r = createLinkResolver({ base: 'https://acme.test/a/' })
    expect(r.resolve('b')).toBe('https://acme.test/a/b')
    expect(r.resolve('mailto:a@acme.test')).toBeNull()
    expect(r.resolve('tel:+100')).toBeNull()
    expect(r.resolve('javascript:alert(1)')).toBeNull()
    expect(r.resolve('data:text/html,x')).toBeNull()
    expect(r.stats).toMatchObject({ resolved: 1, degraded: 0, schemeDropped: 4 })
  })

  it('an empty, whitespace-only or fragment-only href counts in none', () => {
    const r = createLinkResolver({ base: 'https://acme.test/' })
    for (const href of ['', '   ', '#x', ' #x ', null, undefined]) expect(r.resolve(href)).toBeNull()
    expect(r.stats).toMatchObject({ resolved: 0, degraded: 0, schemeDropped: 0 })
  })

  it('keeps only the first MAX_LINK_SAMPLES degraded hrefs', () => {
    const r = createLinkResolver({})
    for (const href of ['a', 'b', 'c', 'd', 'e']) r.resolve(href)
    expect(r.stats.degraded).toBe(5)
    expect(r.stats.samples).toEqual(['a', 'b', 'c'].slice(0, MAX_LINK_SAMPLES))
    expect(r.stats.firstDegraded).toBe('a')
  })

  it('serialises a resolved href the WHATWG way', () => {
    const r = createLinkResolver({})
    expect(r.resolve('https://bücher.acme.test/a b')).toBe('https://xn--bcher-kva.acme.test/a%20b')
  })
})

describe('links in an extracted page', () => {
  it('<base href> wins over the option base', async () => {
    const html = page('<base href="/docs/">', '<p>See <a href="a.html">the article</a>.</p>')
    const r = await extractHtml(html, { base: 'https://acme.test/x/page' })
    expect(r.markdown).toContain('[the article](https://acme.test/docs/a.html)')
    expect(r.report.linksDegraded).toBe(0)
    expect(r.report.linksResolved).toBe(1)
  })

  it('the canonical URL is the base when there is no <base>', async () => {
    const html = page(
      '<link rel="canonical" href="https://acme.test/help/articles/42">',
      '<p>See <a href="../reference/messages">messages</a>.</p>',
    )
    const r = await extractHtml(html)
    expect(r.markdown).toContain('[messages](https://acme.test/help/reference/messages)')
  })

  it('no base at all: the link becomes text, counted, one warning per page', async () => {
    const warnings = []
    const html = page('', '<p>See <a href="guide/x">the guide</a> and <a href="guide/y">more</a>.</p>')
    const r = await extractHtml(html, { id: 'p.html', warn: (m) => warnings.push(m) })
    expect(r.markdown).toContain('the guide')
    expect(r.markdown).not.toContain('](')
    expect(r.report.linksDegraded).toBe(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('guide/x')
  })

  it('mailto, tel and javascript become text with no warning and no failure count', async () => {
    const warnings = []
    const html = page(
      '',
      '<p><a href="mailto:a@acme.test">mail us</a> <a href="tel:+100">call us</a> <a href="javascript:alert(1)">run</a>.</p>',
    )
    const r = await extractHtml(html, { warn: (m) => warnings.push(m) })
    expect(r.markdown).toContain('mail us')
    expect(r.markdown).not.toContain('](')
    expect(r.report.linksDegraded).toBe(0)
    expect(warnings).toEqual([])
  })

  it('an empty and a fragment-only href are plain text with no warning', async () => {
    const warnings = []
    const html = page('', '<p><a href="">nothing</a> <a href="   ">blank</a> <a href="#x">anchor</a>.</p>')
    const r = await extractHtml(html, { warn: (m) => warnings.push(m) })
    expect(r.markdown).toContain('nothing')
    expect(r.markdown).not.toContain('](')
    expect(r.report.linksDegraded).toBe(0)
    expect(warnings).toEqual([])
  })

  it('an IDN host and a space in the path come out in one canonical spelling', async () => {
    const html = page('', '<p><a href="https://bücher.acme.test/a b">shop</a>.</p>')
    const r = await extractHtml(html)
    expect(r.markdown).toContain('(https://xn--bcher-kva.acme.test/a%20b)')
  })

  it('emits no image and no image link on the HTML path', async () => {
    const html = page('', '<p><img src="/a.png" alt="Diagram"> Text after the picture.</p>')
    const r = await extractHtml(html, { base: 'https://acme.test/' })
    expect(r.markdown).not.toContain('![')
    expect(r.markdown).not.toContain('a.png')
  })
})
