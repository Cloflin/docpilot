import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { extractHtml, EXTRACTOR_VERSION, MAX_HTML_BYTES } from '../src/build/lib/extract-html.js'
import { readHtmlDir, pageFromHtml } from '../src/build/lib/html-dir.js'

/**
 * `extractHtml` — engine-spec 043, the one pipeline from HTML to Markdown.
 *
 * The first block holds the corpus hash through the real CLI: the hash is what
 * calibrations and frozen baselines are stamped with, and the extractor version
 * is a term of it only for a corpus with built pages.
 */

const BIN = path.resolve('bin/docpilot.js')
const FIXTURE = path.resolve('test/fixtures/source-parity')

const made = []
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** The fixture, copied: a build deletes and rewrites its index directory. */
function copyFixture() {
  const root = path.join(tmp('dp-extract-'), 'site')
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (src) => !/expected\.json$/.test(src) })
  return root
}

const build = (root, ...extra) =>
  spawnSync(process.execPath, [BIN, 'index', '--no-embed', '--yes', ...extra], { cwd: root, encoding: 'utf8' })

/** The written manifest and the chunk list its shards hold, in order. */
function readWritten(root) {
  const rag = path.join(root, 'docs', 'public', 'rag')
  const manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
  const chunks = manifest.shards.flatMap((name) => JSON.parse(fs.readFileSync(path.join(rag, name), 'utf8')))
  return { manifest, chunks }
}

const hashOf = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 8)

describe('extractHtml — the pipeline', () => {
  it('stamps the extractor version into the hash of a corpus with built pages', () => {
    const root = copyFixture()
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const { manifest, chunks } = readWritten(root)
    const parts = chunks.map((c) => c.id + c.text)
    expect(manifest.hash).toBe(hashOf([...parts, `extractor:${EXTRACTOR_VERSION}`]))
    expect(manifest.hash).not.toBe(hashOf(parts))
    expect(EXTRACTOR_VERSION).toBe(2)
  })

  it('adds no term to the hash of a corpus without built pages', () => {
    const root = copyFixture()
    const r = build(root)
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const { manifest, chunks } = readWritten(root)
    expect(manifest.hash).toBe(hashOf(chunks.map((c) => c.id + c.text)))
  })

  const PROSE = '<p>' + 'Every request is counted against a window. '.repeat(6) + '</p>'
  const page = (body, head = '') =>
    `<!doctype html><html lang="EN-us"><head><title>Rate limits</title>${head}</head>` +
    `<body><main><nav><a href="/x">nav</a></nav>${body}<footer>footer text</footer></main></body></html>`

  it('gives deep-equal results for the same input', async () => {
    const html = page(`<h2>Window</h2>${PROSE}<ul><li>one</li><li>two</li></ul>`)
    const a = await extractHtml(html, { base: 'https://acme.test/' })
    const b = await extractHtml(html, { base: 'https://acme.test/' })
    expect(a.ok).toBe(true)
    expect(a).toEqual(b)
  })

  it('returns Markdown for a page shaped like the fixture, furniture removed', async () => {
    const out = await extractHtml(page(`<h2>Window</h2>${PROSE}`))
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('## Window')
    expect(out.markdown).toContain('Every request is counted')
    expect(out.markdown).not.toContain('footer text')
    expect(out.title).toBe('Rate limits')
    expect(out.lang).toBe('en')
    expect(out.scope).toBe('main')
    expect(out.report.dropped.map((d) => d.text)).toEqual(expect.arrayContaining(['nav', 'footer text']))
  })

  it('returns every string in NFC', async () => {
    const out = await extractHtml(page(`<h2>Café</h2>${PROSE}`, '<meta name="description" content="Café hours">'))
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('Café')
    expect(out.markdown).not.toContain('é')
    expect(out.description).toBe('Café hours')
  })
})

/** A directory of built pages, written to a temp directory. */
function site(files) {
  const dir = tmp('dp-site-')
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

const SENTENCES = '<p>' + 'Every request is counted against a window. '.repeat(6) + '</p>'
const good = (title) => `<!doctype html><html><head><title>${title}</title></head><body><main>${SENTENCES}</main></body></html>`

describe('extractHtml — a bad page does not stop the directory', () => {
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'indexes the good page and warns for an unreadable one',
    async () => {
      const dir = site({ 'good.html': good('Good'), 'locked.html': good('Locked') })
      const locked = path.join(dir, 'locked.html')
      fs.chmodSync(locked, 0o000)
      const warnings = []
      try {
        const out = await readHtmlDir({ dir, warn: (m) => warnings.push(m) })
        expect(out.map((p) => p.route)).toEqual(['/good'])
        expect(warnings.join('\n')).toContain('skipped locked.html:')
      } finally {
        fs.chmodSync(locked, 0o644)
      }
    },
  )

  // The walk overflows the stack near 5,000 levels, so 8,000 takes the same
  // RangeError path as 20,000 in a fraction of the time: pickMain scores every
  // div by its subtree, which is quadratic in the depth (13 s at 20,000).
  it('never throws for a page nested 8,000 deep, and indexes the page beside it', async () => {
    const deep = `<!doctype html><html><body>${'<div>'.repeat(8000)}bottom of the pile${'</div>'.repeat(8000)}</body></html>`
    const out = await extractHtml(deep)
    if (!out.ok) expect(out.reason).toMatch(/\S/)
    const dir = site({ 'deep.html': deep, 'good.html': good('Good') })
    const warnings = []
    const pages = await readHtmlDir({ dir, warn: (m) => warnings.push(m) })
    expect(pages.map((p) => p.route)).toContain('/good')
    expect(warnings.join('\n')).toMatch(/skipped deep\.html: (extraction failed|near-empty)/)
  }, 60000)

  it('skips a page whose body is literally empty as near-empty, and indexes the page beside it (HTML-09)', async () => {
    const empty = '<!doctype html><html><head><title>Void</title></head><body></body></html>'
    const out = await extractHtml(empty)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('near-empty')
    const dir = site({ 'void.html': empty, 'good.html': good('Good') })
    const warnings = []
    const pages = await readHtmlDir({ dir, warn: (m) => warnings.push(m) })
    expect(pages.map((p) => p.route)).toEqual(['/good'])
    expect(warnings.join('\n')).toContain('skipped void.html: near-empty')
  })

  it('stops the directory only when nothing could be extracted', async () => {
    const dir = site({ 'a.html': '<!doctype html><html><body><main>Loading…</main></body></html>' })
    const warnings = []
    await expect(readHtmlDir({ dir, warn: (m) => warnings.push(m) })).rejects.toThrow('no page could be extracted')
    expect(warnings.join('\n')).toContain('skipped a.html: near-empty')
  })

  it('does not throw for an empty directory', async () => {
    expect(await readHtmlDir({ dir: site({}) })).toEqual([])
  })

  it('skips a page larger than MAX_HTML_BYTES before parsing it', async () => {
    const big = `<!doctype html><html><body><main><p>${'x'.repeat(MAX_HTML_BYTES + 1)}</p></main></body></html>`
    const out = await extractHtml(big)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('too large')
    const warnings = []
    expect(await pageFromHtml(big, { id: 'big.html', warn: (m) => warnings.push(m) })).toBeNull()
    expect(warnings[0]).toMatch(/^skipped big\.html: too large/)
  })

  it('names a page with only script, style, template, svg or noscript content near-empty', async () => {
    const html =
      '<!doctype html><html><body><script>var a = 1; var b = 2; var c = 3;</script>' +
      '<style>body { color: red; margin: 0; padding: 0 }</style><template>not shown to anybody</template>' +
      '<svg><text>vector label text here</text></svg><noscript>enable javascript please</noscript></body></html>'
    const out = await extractHtml(html)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('near-empty')
  })

  it('counts code points, not UTF-16 units, against the floor', async () => {
    // 13 astral characters are 26 UTF-16 units and 13 code points: under 24 either way
    // for the code-point count, over it for the unit count.
    const out = await extractHtml(`<!doctype html><html><body><main><p>${'\u{1F600}'.repeat(13)}</p></main></body></html>`)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('near-empty (13 characters)')
  })
})

describe('extractHtml — a page with no html or body tag (WR-02)', () => {
  // The parser does not build the tree, so these pages used to read as empty.
  const PROSE = 'Every request is counted against a window. '.repeat(6)

  it('extracts an article fragment', async () => {
    const out = await extractHtml(`<article><h2>Limits</h2><p>${PROSE}</p></article>`)
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('## Limits')
    expect(out.markdown).toContain('Every request is counted')
  })

  it('extracts an html element with no body, and still reads its head', async () => {
    const out = await extractHtml(
      `<!doctype html><html lang="de"><head><title>Rate limits</title></head><div><p>${PROSE}</p></div></html>`,
    )
    expect(out.ok).toBe(true)
    expect(out.title).toBe('Rate limits')
    expect(out.lang).toBe('de')
    expect(out.markdown).toContain('Every request is counted')
  })

  it('does not drop a short landmark that the body would not hold either', async () => {
    const out = await extractHtml('<main><p>This short paragraph is the whole page, and it is long enough.</p></main>')
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('This short paragraph is the whole page')
  })

  it('reads title and meta that stand with the content and no head', async () => {
    const out = await extractHtml(
      `<title>Loose title</title><meta name="description" content="A loose description"><p>${PROSE}</p>`,
    )
    expect(out.ok).toBe(true)
    expect(out.title).toBe('Loose title')
    expect(out.description).toBe('A loose description')
    expect(out.markdown).not.toContain('Loose title')
  })

  it('extracts a body element with no html element around it', async () => {
    const out = await extractHtml(`<body><p>${PROSE}</p>`)
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('Every request is counted')
  })

  it('keeps every top-level block of a fragment', async () => {
    const out = await extractHtml(`<p>${PROSE}</p><p>The second block names a window too and is kept.</p>`)
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('The second block names a window')
  })
})

describe('extractHtml — links', () => {
  const withLink = (href) =>
    `<!doctype html><html><body><main>${SENTENCES}<p><a href="${href}">Install</a></p></main></body></html>`

  it('turns a relative link with no base into its text, counts it and warns once', async () => {
    const warnings = []
    const out = await extractHtml(
      withLink('guide/x').replace('</p></main>', '</p><p><a href="guide/y">Other</a></p></main>'),
      { id: 'guide/index.html', warn: (m) => warnings.push(m) },
    )
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('Install')
    expect(out.markdown).not.toContain('guide/x')
    expect(out.report.linksDegraded).toBe(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('guide/index.html')
    expect(warnings[0]).toContain('guide/x')
  })

  it('resolves a relative link against the base', async () => {
    const out = await extractHtml(withLink('guide/x'), { base: 'https://acme.test/docs/' })
    expect(out.markdown).toContain('[Install](https://acme.test/docs/guide/x)')
    expect(out.report.linksResolved).toBe(1)
    expect(out.report.linksDegraded).toBe(0)
  })

  it('leaves a fragment link as text with no warning and no count', async () => {
    const warnings = []
    const out = await extractHtml(withLink('#top'), { warn: (m) => warnings.push(m) })
    expect(out.markdown).toContain('Install')
    expect(out.markdown).not.toContain('(#top)')
    expect(out.report.linksDegraded).toBe(0)
    expect(warnings).toEqual([])
  })
})
