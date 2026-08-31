import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  walkHtml,
  routeForHtml,
  sitemapRoutes,
  pageFromHtml,
  readHtmlDir,
} from '../src/build/lib/html-dir.js'

/**
 * `index --html-dir` — engine-specs/001.
 *
 * The extraction itself is `import.test.js`'s subject and is not retested here:
 * this suite is about the three things 001 actually added — which files are
 * walked, which route a file is served at, and what happens when two of them
 * want the same one.
 */

const tmp = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-html-'))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title>` +
  `<meta name="description" content="What ${title} is for.">` +
  `</head><body><nav><a href="/x">nav</a></nav><main>${body}</main>` +
  `<footer>footer text</footer></body></html>`

/**
 * No `<h1>`: `metadata()` prefers a page's own `<h1>` over its `<title>`, so a
 * shared fixture carrying one would give every page in a directory the same
 * name and quietly make the per-route assertions below test nothing.
 */
const PROSE = '<p>' + 'Every request is counted against a window. '.repeat(8) + '</p>'

describe('walkHtml', () => {
  it('finds .html at any depth and skips asset directories', () => {
    const dir = tmp({
      'index.html': page('Home', PROSE),
      'guide/install.html': page('Install', PROSE),
      'assets/app.html': page('Asset', PROSE),
      '_next/chunk.html': page('Chunk', PROSE),
      '.git/hook.html': page('Hook', PROSE),
      'guide/style.css': 'body{}',
    })
    const found = walkHtml(dir).map((f) => path.relative(dir, f).replace(/\\/g, '/'))
    expect(found).toEqual(['guide/install.html', 'index.html'])
  })
})

describe('routeForHtml', () => {
  it('collapses index and strips the extension, exactly as markdown does', () => {
    const dir = '/site'
    expect(routeForHtml(dir, '/site/index.html')).toBe('/')
    expect(routeForHtml(dir, '/site/guide/index.html')).toBe('/guide')
    expect(routeForHtml(dir, '/site/guide/install.html')).toBe('/guide/install')
    expect(routeForHtml(dir, '/site/reference/cli.htm')).toBe('/reference/cli')
  })
})

describe('sitemapRoutes', () => {
  it('reads <loc> as routes, absolute or relative, trailing slash or not', () => {
    const routes = sitemapRoutes(`<?xml version="1.0"?><urlset>
      <url><loc>https://acme.test/</loc></url>
      <url><loc>https://acme.test/guide/install</loc></url>
      <url><loc>https://acme.test/guide/</loc></url>
      <url><loc>/reference/cli</loc></url>
    </urlset>`)
    expect([...routes].sort()).toEqual(['/', '/guide', '/guide/install', '/reference/cli'])
  })

  it('is empty for a sitemap with no locations rather than throwing', () => {
    expect(sitemapRoutes('<urlset></urlset>').size).toBe(0)
  })
})

describe('pageFromHtml', () => {
  it('drops the furniture and leads with the title and the description', async () => {
    const out = await pageFromHtml(page('Rate limits', PROSE))
    expect(out.title).toBe('Rate limits')
    expect(out.src.startsWith('# Rate limits\n\nWhat Rate limits is for.')).toBe(true)
    expect(out.src).not.toContain('nav')
    expect(out.src).not.toContain('footer text')
    expect(out.src).toContain('Every request is counted')
  })

  it('returns null for a page with no body text', async () => {
    expect(await pageFromHtml('<!doctype html><html><body><nav>a</nav></body></html>')).toBeNull()
  })

  /**
   * A selector that matches nothing is a typo in a flag somebody typed. Falling
   * back to `pickMain` would index a different subtree than the one they asked
   * for and say nothing about it, which is the failure this test names.
   */
  it('warns and skips when --html-select matches nothing', async () => {
    const warnings = []
    const out = await pageFromHtml(page('Rate limits', PROSE), {
      select: '.no-such-thing',
      warn: (m) => warnings.push(m),
      id: 'guide/rate-limits.html',
    })
    expect(out).toBeNull()
    expect(warnings.join()).toContain('--html-select ".no-such-thing" matched nothing')
  })

  it('honours a selector that does match', async () => {
    const html =
      '<!doctype html><html><body><main><p>the wrong one</p></main>' +
      `<div id="docs">${PROSE}</div></body></html>`
    const out = await pageFromHtml(html, { select: '#docs' })
    expect(out.src).toContain('Every request is counted')
    expect(out.src).not.toContain('the wrong one')
  })
})

describe('readHtmlDir', () => {
  it('returns one record per page, keyed by route', async () => {
    const dir = tmp({
      'index.html': page('Home', PROSE),
      'guide/install.html': page('Install', PROSE),
    })
    const out = await readHtmlDir({ dir })
    expect(out.map((p) => p.route).sort()).toEqual(['/', '/guide/install'])
    expect(out.find((p) => p.route === '/guide/install').title).toBe('Install')
  })

  /**
   * `guide.html` and `guide/index.html` are both `/guide`. Several generators
   * emit both for trailing-slash compatibility, and two pages under one id is a
   * `duplicate chunk id` build death several hundred lines from its cause.
   */
  it('keeps one file per route and says which one it dropped', async () => {
    const dir = tmp({
      'guide.html': page('Guide flat', PROSE),
      'guide/index.html': page('Guide nested', PROSE),
    })
    const warnings = []
    const out = await readHtmlDir({ dir, warn: (m) => warnings.push(m) })
    expect(out.map((p) => p.route)).toEqual(['/guide'])
    expect(warnings.join()).toContain('two files claim /guide')
  })

  it('indexes only what a sitemap declares, when one is given', async () => {
    const dir = tmp({
      'index.html': page('Home', PROSE),
      'guide/install.html': page('Install', PROSE),
      '404.html': page('Not found', PROSE),
      'sitemap.xml':
        '<urlset><url><loc>https://acme.test/</loc></url>' +
        '<url><loc>https://acme.test/guide/install</loc></url></urlset>',
    })
    const out = await readHtmlDir({ dir, sitemap: path.join(dir, 'sitemap.xml') })
    expect(out.map((p) => p.route).sort()).toEqual(['/', '/guide/install'])
  })

  it('names the directory when it does not exist', async () => {
    await expect(readHtmlDir({ dir: '/no/such/dir' })).rejects.toThrow('does not exist')
  })
})
