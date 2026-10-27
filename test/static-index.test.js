/**
 * The static install's files — engine-spec 034: every immutable file is named
 * by its own bytes, and the manifest carries the Subresource Integrity of each,
 * which the browser's loader hands to `fetch`.
 *
 * Built for real, by the CLI, in a throwaway project: `--no-embed`, so no
 * network and no model, and the build is the one a reader's site would run.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve('bin/docpilot.js')

// The project sits one level inside its temp directory, so a test that points
// `indexDir` at `..` can only ever reach a directory the test made.
function project(extra = '') {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-static-')), 'site')
  fs.mkdirSync(path.join(root, 'docs', 'guide'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'docpilot.config.mjs'),
    `export const docPilot = { product: 'Acme', embed: false, chat: false${extra} }\nexport default {}\n`,
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

/** Every file of a directory, by name, with the hash of its bytes. */
const snapshot = (dir) =>
  Object.fromEntries(
    fs.readdirSync(dir).sort().map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]),
  )
const output = (r) => `${r.stdout}\n${r.stderr}`

/**
 * t6 R4 — the index was wiped BEFORE the checks that can still fail. A site
 * whose `pages[]` alone passes the 64 KB manifest ceiling died after the old
 * index was gone, leaving shards and no `manifest.json` in a committed dir.
 */
describe('a failed build leaves the last index as it was', () => {
  it('keeps every file of the previous index when the manifest ceiling fails', () => {
    const root = project()
    expect(build(root).status).toBe(0)
    const pub = path.join(root, 'docs', 'public')
    const rag = path.join(pub, 'rag')
    const before = snapshot(rag)
    // Nothing left beside the index by a build that succeeded.
    expect(fs.readdirSync(pub)).toEqual(['rag'])

    const title = 'A long page title '.repeat(12)
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(root, 'docs', 'guide', `p${i}.md`), `---\ntitle: ${title}${i}\n---\n\nbody of page ${i}\n`)
    }
    const r = build(root)
    expect(r.status).not.toBe(0)
    expect(output(r)).toMatch(/manifest is \d+ bytes, over the 65536 ceiling/)
    expect(snapshot(rag)).toEqual(before)
    expect(fs.readdirSync(pub)).toEqual(['rag'])
  })

  /**
   * fix-D1 R4 residue — a signal fires no `exit` event, so Ctrl-C during the
   * build left `docs/public/.rag.staging` beside a committed index. The build
   * is held in the openers pass by a model that never answers, which is the
   * long wait a reader actually interrupts.
   */
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    it(`removes the stage on ${signal}, and exits ${code}`, async () => {
      const server = http.createServer(() => {}) // accepts, never answers
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${server.address().port}`
      const root = project(
        `, chat: { provider: 'ollama', baseURL: '${base}', model: 'hang' }, suggestions: ['How does backoff work?']`,
      )
      const stage = path.join(root, 'docs', 'public', '.rag.staging')
      const asked = new Promise((resolve) => server.once('request', resolve))
      const child = spawn(process.execPath, [BIN, 'index', '--no-embed', '--yes'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, OLLAMA_BASE_URL: base },
      })
      try {
        await asked
        // The precondition that makes the assertion below mean something.
        expect(fs.existsSync(stage)).toBe(true)
        const exited = new Promise((resolve) => child.once('exit', (c, s) => resolve({ c, s })))
        child.kill(signal)
        expect(await exited).toEqual({ c: code, s: null })
        expect(fs.existsSync(stage)).toBe(false)
      } finally {
        child.kill('SIGKILL')
        server.closeAllConnections()
        server.close()
      }
    }, 20000)
  }
})

/**
 * t6 R8 — two pages with the same (title, tail) died the build. Without a
 * sidebar every tail is '', so two pages called "Overview" were enough.
 */
describe('two pages, one label', () => {
  it('warns, keeps both pages, and leaves their titles as written', () => {
    const root = project()
    for (const dir of ['a', 'b']) {
      fs.mkdirSync(path.join(root, 'docs', dir), { recursive: true })
      fs.writeFileSync(path.join(root, 'docs', dir, 'overview.md'), `---\ntitle: Overview\n---\n\n# Overview\n\n${dir} body text\n`)
    }
    const r = build(root)
    expect(r.status, output(r)).toBe(0)
    // Either order: `walkMarkdown` lists in readdir order, which ext4 does not sort.
    expect(output(r)).toMatch(/2 pages share the title "Overview": \/(a|b)\/overview, \/(a|b)\/overview — /)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'public', 'rag', 'manifest.json'), 'utf8'))
    const both = manifest.pages.filter((p) => p.title === 'Overview')
    expect(both.map((p) => [p.path, p.tail]).sort()).toEqual([
      ['/a/overview', ''],
      ['/b/overview', ''],
    ])
  })
})

/**
 * t6 R5 — `indexDir` is deleted whole on every build, and nothing checked what
 * it pointed at: `'docs'` deleted the docs, `'.'` the project.
 */
describe('indexDir is never a directory the project needs', () => {
  for (const [what, dir] of [
    ['the project root', '.'],
    ['docsDir', 'docs'],
    ['a directory above the project', '..'],
  ]) {
    it(`refuses ${what}, and deletes nothing`, () => {
      const root = project(`, indexDir: ${JSON.stringify(dir)}`)
      const r = build(root)
      expect(r.status).not.toBe(0)
      expect(output(r)).toMatch(/deletes that directory whole on every build/)
      expect(fs.existsSync(path.join(root, 'docs', 'guide', 'retries.md'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'docpilot.config.mjs'))).toBe(true)
    })
  }

  it('builds into a directory outside the project', () => {
    const root = project(", indexDir: '../site-out/rag'")
    const r = build(root)
    expect(r.status, output(r)).toBe(0)
    expect(fs.existsSync(path.join(root, '..', 'site-out', 'rag', 'manifest.json'))).toBe(true)
  })
})

/**
 * t6 R9 — `guide.md` and `guide/index.md` are both `/guide`. The page entry was
 * overwritten while both files' chunks stayed; with a shared `## Setup` the
 * build died on a duplicate chunk id far from the cause.
 */
describe('two files, one route', () => {
  const chunksOf = (root, route) => {
    const rag = path.join(root, 'docs', 'public', 'rag')
    const manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
    const chunks = manifest.shards.flatMap((f) => JSON.parse(fs.readFileSync(path.join(rag, f), 'utf8')))
    return { pages: manifest.pages.filter((p) => p.path === route), chunks: chunks.filter((c) => c.path === route) }
  }

  it('keeps guide.md over guide/index.md, warns, and indexes one page', () => {
    const root = project()
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Flat\n\n## Setup\n\nflat body text\n')
    fs.writeFileSync(path.join(root, 'docs', 'guide', 'index.md'), '# Nested\n\n## Setup\n\nnested body text\n')
    const r = build(root)
    expect(r.status, output(r)).toBe(0)
    expect(output(r)).toContain('two files claim /guide: docs/guide.md and docs/guide/index.md — the second is skipped')
    const { pages, chunks } = chunksOf(root, '/guide')
    expect(pages).toHaveLength(1)
    expect(pages[0].title).toBe('Flat')
    expect(chunks).toHaveLength(pages[0].chunks)
    expect(chunks.map((c) => c.text).join('\n')).not.toContain('nested body')
  })

  it('keeps .md over .mdx whichever the directory lists first', () => {
    const root = project()
    fs.writeFileSync(path.join(root, 'docs', 'guide', 'retries.mdx'), '# Retries again\n\n## Other\n\nmdx body text\n')
    const r = build(root)
    expect(r.status, output(r)).toBe(0)
    expect(output(r)).toContain('two files claim /guide/retries: docs/guide/retries.md and docs/guide/retries.mdx')
    const { pages, chunks } = chunksOf(root, '/guide/retries')
    expect(pages).toHaveLength(1)
    expect(chunks).toHaveLength(pages[0].chunks)
    expect(chunks.map((c) => c.text).join('\n')).not.toContain('mdx body')
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
