/**
 * The static install's files — engine-spec 034: every immutable file is named
 * by its own bytes, and the manifest carries the Subresource Integrity of each,
 * which the browser's loader hands to `fetch`.
 *
 * Built for real, by the CLI, in a throwaway project: `--no-embed`, so no
 * network and no model, and the build is the one a reader's site would run.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve('bin/docpilot.js')

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-static-'))
  fs.mkdirSync(path.join(root, 'docs', 'guide'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'docpilot.config.mjs'),
    "export const docPilot = { product: 'Acme', embed: false, chat: false }\nexport default {}\n",
  )
  const para = (w) => `${w} `.repeat(160)
  fs.writeFileSync(path.join(root, 'docs', 'index.md'), `# Acme\n\n${para('intro')}\n`)
  fs.writeFileSync(
    path.join(root, 'docs', 'guide', 'retries.md'),
    `---\ntitle: Retries\n---\n\n# Retries\n\n## Backoff\n\n${para('backoff')}\n\n## Limits\n\n${para('limits')}\n`,
  )
  return root
}

const build = (root) => spawnSync(process.execPath, [BIN, 'index', '--no-embed', '--yes'], { cwd: root, encoding: 'utf8' })

describe('the static index — content-addressed and integrity-checked', () => {
  let root
  let rag
  let manifest
  beforeAll(() => {
    root = project()
    const r = build(root)
    expect(r.status, r.stderr).toBe(0)
    rag = path.join(root, 'docs', 'public', 'rag')
    manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
  })

  it('names every file it writes by its own bytes', () => {
    const files = [...manifest.shards, manifest.df]
    for (const f of files) {
      const hex = crypto.createHash('sha256').update(fs.readFileSync(path.join(rag, f))).digest('hex').slice(0, 8)
      expect(f, f).toContain(`.${hex}.`)
    }
  })

  it('carries a sha256 integrity for each, matching the bytes on disk', () => {
    for (const f of [...manifest.shards, manifest.df]) {
      const sri = `sha256-${crypto.createHash('sha256').update(fs.readFileSync(path.join(rag, f))).digest('base64')}`
      expect(manifest.integrity[f]).toBe(sri)
    }
  })

  it('rebuilds to the same names when nothing changed', () => {
    const before = JSON.stringify([manifest.shards, manifest.df, manifest.integrity])
    expect(build(root).status).toBe(0)
    const again = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
    expect(JSON.stringify([again.shards, again.df, again.integrity])).toBe(before)
  })
})

describe('loadIndex hands the integrity to fetch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('passes the manifest’s sha256 for every file it asks for', async () => {
    const { loadIndex, __setIndex } = await import('../src/theme/docpilot/store.js')
    __setIndex(null)
    const chunk = { id: 'a#', path: '/a', anchor: '', title: 'A', breadcrumb: 'A', kind: 'guide', text: 'A — A\nbody', next: null }
    const manifest = {
      version: 3,
      hash: 'h',
      embedModel: null,
      dims: 0,
      chunkCount: 1,
      shards: ['chunks-00.x.json'],
      vectors: null,
      df: 'df.y.json',
      pages: [{ path: '/a', title: 'A' }],
      sections: [],
      orphanPages: [],
      guard: {},
      tuning: null,
      openers: null,
      integrity: { 'chunks-00.x.json': 'sha256-AAA', 'df.y.json': 'sha256-BBB' },
    }
    const seen = []
    vi.stubGlobal('fetch', async (url, init) => {
      seen.push([String(url), init?.integrity ?? null])
      const body = String(url).endsWith('manifest.json') ? manifest : String(url).includes('chunks-') ? [chunk] : { n: 1, df: {} }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    await loadIndex('/rag')
    expect(seen).toContainEqual(['/rag/chunks-00.x.json', 'sha256-AAA'])
    expect(seen).toContainEqual(['/rag/df.y.json', 'sha256-BBB'])
    expect(seen.find(([u]) => u.endsWith('manifest.json'))[1]).toBe(null)
    __setIndex(null)
  })
})
