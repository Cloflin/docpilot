/**
 * The byte oracle for the document pipeline — it CHARACTERISES today's builder.
 *
 * `docpilot index` reads four kinds of source: the docs Markdown, `importDir`
 * (the `--kb` pages), a built site (`--html-dir`) and OpenAPI. The committed
 * corpora exercise only the first. This suite builds a small project that uses
 * all four, through the real CLI, and holds the result to per-file sha256
 * snapshots. Plan 01-10 refactors the readers against these files.
 *
 * NEVER REGENERATE THE SNAPSHOTS TO MAKE A REFACTOR PASS. Every snapshot below
 * was generated from the UNCHANGED builder. A refactor that moves a byte has
 * changed what `docpilot index` writes for a reader's site, and the right
 * response is to find why, not to run `vitest -u`.
 *
 * `--no-embed` and no calibration file: no network, no model, and no threshold
 * a recalibration could move.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chunkOpenapi } from '../src/build/lib/openapi-chunker.js'

const BIN = path.resolve('bin/docpilot.js')
const FIXTURE = path.resolve('test/fixtures/source-parity')

/** The fixture, copied: a build deletes and rewrites its index directory. */
function copyFixture() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-parity-')), 'site')
  fs.cpSync(FIXTURE, root, {
    recursive: true,
    // The snapshots are the test's expectations, not the project's input.
    filter: (src) => !/expected\.json$/.test(src),
  })
  return root
}

const build = (root, ...extra) =>
  spawnSync(process.execPath, [BIN, 'index', '--no-embed', '--yes', ...extra], { cwd: root, encoding: 'utf8' })

/** name → sha256 of every file the build wrote, in name order. */
function hashIndex(root) {
  const rag = path.join(root, 'docs', 'public', 'rag')
  const out = {}
  for (const name of fs.readdirSync(rag).sort()) {
    out[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(rag, name))).digest('hex')
  }
  return out
}

describe('source parity — today\'s builder, built through the CLI', () => {
  it('writes the index the snapshot holds, byte for byte', async () => {
    const root = copyFixture()
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).toBe(0)
    await expect(JSON.stringify(hashIndex(root), null, 2) + '\n').toMatchFileSnapshot(
      './fixtures/source-parity/expected.json',
    )
  })

  it('indexes a route that Markdown and the built site both claim once, from the Markdown', () => {
    const root = copyFixture()
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const rag = path.join(root, 'docs', 'public', 'rag')
    const manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
    const shadow = manifest.pages.filter((p) => p.path === '/guide/shadow')
    expect(shadow).toHaveLength(1)
    const text = fs.readdirSync(rag).filter((f) => f.startsWith('chunks-')).map((f) => fs.readFileSync(path.join(rag, f), 'utf8')).join('')
    expect(text).toContain('shadow-markdown')
    expect(text).not.toContain('shadow-artefact')
    // The other three sources are in the same index.
    expect(manifest.pages.map((p) => p.path)).toEqual(
      expect.arrayContaining(['/guide/alpha', '/guide/beta', '/guide/gamma']),
    )
    expect(manifest.pages.some((p) => p.external)).toBe(true)
  })

  it('stops the build on a front-matter source outside the allowlist, and writes no index', () => {
    const root = copyFixture()
    const kb = path.join(root, 'kb', 'topic.md')
    fs.writeFileSync(kb, fs.readFileSync(kb, 'utf8').replace('https://example.com/topic', 'javascript:alert(1)'))
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('Add the origin to docPilot.sources.allow')
    expect(fs.existsSync(path.join(root, 'docs', 'public', 'rag'))).toBe(false)
  })
})

describe('source parity — the OpenAPI chunk building, without the optional parser', () => {
  const SPEC = fs.readFileSync(path.join(FIXTURE, 'openapi', 'mini.json'), 'utf8')

  it('builds the chunk list the snapshot holds, through an injected dereference', async () => {
    const { title, chunks } = await chunkOpenapi(SPEC, 'mini', {
      dereference: async (t) => ({ schema: JSON.parse(t) }),
    })
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    await expect(
      JSON.stringify({ title, chunks: chunks.map((c) => ({ id: c.id, text: c.text })) }, null, 2) + '\n',
    ).toMatchFileSnapshot('./fixtures/source-parity/openapi.expected.json')
  })

  it('reports the missing parser, exactly as before, when none is injected', async () => {
    await expect(chunkOpenapi(SPEC, 'mini')).rejects.toThrow(
      /found an OpenAPI file \(mini\) but @scalar\/openapi-parser is not installed/,
    )
  })
})
