import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { extractHtml, EXTRACTOR_VERSION } from '../src/build/lib/extract-html.js'

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
