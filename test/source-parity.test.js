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
 * response is to find why, not to run `vitest -u`. Phase 2 moved expected.json
 * once, on purpose, because a built-site corpus hash carries the extractor
 * version (engine-spec 043).
 *
 * `--no-embed` and no calibration file: no network, no model, and no threshold
 * a recalibration could move.
 */
import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chunkOpenapi } from '../src/build/lib/openapi-chunker.js'
import { readMarkdownDocs, readKbDocs, readOpenapiDocs, discoverOpenapiSpecs } from '../src/build/lib/readers.js'
import { documentsToChunks } from '../src/build/lib/documents.js'

const BIN = path.resolve('bin/docpilot.js')
const FIXTURE = path.resolve('test/fixtures/source-parity')

/** Every temp directory a test made, removed once the file is done. */
const made = []
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** The fixture, copied: a build deletes and rewrites its index directory. */
function copyFixture() {
  const root = path.join(tmp('dp-parity-'), 'site')
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

describe('source parity — readers read front matter as the chunker does', () => {
  it('finds the title and the source of a file that starts with a byte-order mark', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-bom-'))
    try {
      fs.writeFileSync(
        path.join(dir, 'page.md'),
        '\uFEFF---\ntitle: With a mark\nsource: https://example.com/page\n---\n\n# Body\n\nWords.\n',
      )
      const [md] = readMarkdownDocs({ docsDir: dir, root: dir, exclude: new Set(), specRoutes: new Set(), warn: () => {} })
      expect(md.title).toBe('With a mark')
      const [kb] = readKbDocs({ kbDir: dir, externalPrefix: '/kb' })
      expect(kb.title).toBe('With a mark')
      expect(kb.url).toBe('https://example.com/page')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Layer 1 of the byte gate — the repository's own corpus, offline.
 *
 * The committed indexes (`docs/public/rag`, `docs/public/rag-local`) were built
 * from `docs/` by the unrefactored builder. Reading `docs/` through the readers
 * and the pipeline stage must give back, chunk for chunk, what they hold; and
 * because a shard is named by its own bytes, the shard names say the same thing
 * about every byte of every chunk object. No embedding, no network: a vector is
 * not an input to either claim.
 */
describe('source parity — the repository\'s own docs against both committed indexes', () => {
  const SHARD_SIZE = 250 // build-rag-index.ts writes 250 chunks to a shard
  const read = async () => {
    const docs = readMarkdownDocs({
      docsDir: path.resolve('docs'),
      root: process.cwd(),
      // main()'s own: the home and scratch pages; this repository has no OpenAPI spec.
      exclude: new Set(['/index', '/new-file']),
      specRoutes: new Set(),
      warn: () => {},
    })
    return documentsToChunks(docs, {
      embedContext: 'off',
      llmsAbout: new Map(),
      originFor: () => {
        throw new Error('this repository imports no page with a front-matter source')
      },
      warn: () => {},
      die: (m) => {
        throw new Error(m)
      },
    })
  }

  for (const dir of ['rag', 'rag-local']) {
    const rag = path.resolve('docs', 'public', dir)
    const manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))

    it(`${dir}: yields the chunk ids, texts and order the index holds`, async () => {
      const { chunks } = await read()
      const held = manifest.shards.flatMap((f) => JSON.parse(fs.readFileSync(path.join(rag, f), 'utf8')))
      expect(chunks.map((c) => c.id)).toEqual(held.map((c) => c.id))
      expect(chunks.map((c) => c.text)).toEqual(held.map((c) => c.text))
      expect(chunks).toHaveLength(manifest.chunkCount)
    })

    it(`${dir}: yields the page rows of the manifest, tail aside, in its key order`, async () => {
      const { pages } = await read()
      const held = manifest.pages.map(({ tail, ...row }) => row)
      expect(JSON.stringify([...pages.values()])).toBe(JSON.stringify(held))
    })

    it(`${dir}: names its shards by the same bytes`, async () => {
      // main() writes the chunk objects to the shards as the stage returns
      // them, so no step is repeated here before hashing.
      const { chunks } = await read()
      const names = []
      for (let i = 0; i < chunks.length; i += SHARD_SIZE) {
        const bytes = Buffer.from(JSON.stringify(chunks.slice(i, i + SHARD_SIZE)))
        const hex = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8)
        names.push(`chunks-${String(i / SHARD_SIZE).padStart(2, '0')}.${hex}.json`)
      }
      expect(names).toEqual(manifest.shards)
    })
  }
})

/**
 * The stage on its own — what `main()` cannot be asked in process, because it
 * calls `process.exit` where the stage calls the `die` it is given.
 */
describe('source parity — documentsToChunks, in process', () => {
  const doc = (over = {}) => ({
    id: '/guide/one',
    source: 'markdown',
    url: null,
    title: null,
    body: { format: 'markdown', markdown: '# One\n\nSome words about the first page.\n' },
    visibility: 'public',
    breadcrumb: [],
    tags: [],
    ...over,
  })
  const ctx = (over = {}) => {
    const said = { warn: [], die: [] }
    return {
      said,
      embedContext: 'off',
      llmsAbout: new Map(),
      originFor: () => {
        throw new Error('no source expected')
      },
      warn: (m) => said.warn.push(m),
      die: (m) => {
        said.die.push(m)
        throw new Error(m)
      },
      ...over,
    }
  }

  it('stops on a document marked internal, naming it, before any chunk is produced', async () => {
    const c = ctx()
    let chunked = 0
    const docs = [doc(), doc({ id: '/guide/secret', visibility: 'internal' })]
    await expect(documentsToChunks(docs, { ...c, originFor: () => (chunked++, 'x') })).rejects.toThrow(
      /not public: \/guide\/secret/,
    )
    expect(c.said.die).toHaveLength(1)
    expect(c.said.die[0]).toContain('/guide/secret')
    expect(c.said.die[0]).not.toContain('/guide/one')
    expect(chunked).toBe(0)
  })

  it('refuses a document whose visibility is missing, as it refuses an internal one', async () => {
    const { visibility, ...bare } = doc()
    await expect(documentsToChunks([bare], ctx())).rejects.toThrow(/not public: \/guide\/one/)
  })

  it('returns no chunks and no pages for no documents', async () => {
    const r = await documentsToChunks([], ctx())
    expect(r.chunks).toEqual([])
    expect([...r.pages]).toEqual([])
    expect(r.rawBytes).toBe(0)
    expect(r.counts).toEqual({ htmlPages: 0, htmlShadowed: 0, external: 0 })
  })

  it('skips a document that yields no chunks, without a page row', async () => {
    const home = doc({
      id: '/home',
      body: { format: 'markdown', markdown: '---\nlayout: home\n---\n\n# Welcome\n' },
    })
    const r = await documentsToChunks([home, doc()], ctx())
    expect([...r.pages.keys()]).toEqual(['/guide/one'])
  })

  it('stamps every document with a contentHash, and keeps the input order of one source', async () => {
    const docs = [doc({ id: '/b' }), doc({ id: '/a' })]
    const r = await documentsToChunks(docs, ctx())
    expect(r.docs.map((d) => d.id)).toEqual(['/b', '/a'])
    expect(r.docs.every((d) => /^[0-9a-f]{64}$/.test(d.contentHash))).toBe(true)
    expect([...r.pages.keys()]).toEqual(['/b', '/a'])
  })

  it('says today\'s warning for a built page that produces no chunks, and for an empty --html-dir', async () => {
    const empty = doc({
      id: '/built',
      source: 'html-dir',
      title: 'Built',
      file: path.resolve('built.html'),
      body: { format: 'markdown', markdown: '---\nlayout: home\n---\n' },
    })
    const c = ctx({ root: process.cwd(), htmlDir: 'site' })
    await documentsToChunks([empty], c)
    expect(c.said.warn).toContain('built page produced no chunks: built.html')
    expect(c.said.warn).toContain('--html-dir site produced no pages')
  })

  it('stops an imported page that has no front-matter source', async () => {
    const kb = doc({ id: '/kb/topic', source: 'kb', file: path.resolve('kb/topic.md') })
    const c = ctx({ externalPrefix: '/kb', importDir: 'kb', docsDir: 'docs' })
    await expect(documentsToChunks([kb], c)).rejects.toThrow(/has no frontmatter source/)
  })

  it('stops, naming the document, when no stage would read it', async () => {
    // a kb page without externalPrefix, a source nobody stages, a body of the wrong format
    for (const bad of [
      doc({ id: '/kb/a', source: 'kb' }),
      doc({ id: '/x/conn', source: 'connector' }),
      doc({ id: '/guide/yaml', body: { format: 'openapi', yaml: 'openapi: 3.0.0' } }),
    ]) {
      const c = ctx()
      await expect(documentsToChunks([doc(), bad], c)).rejects.toThrow(/no stage reads/)
      expect(c.said.die[0]).toContain(bad.id)
    }
  })

  it('reads an OpenAPI file as a document and hands it to the OpenAPI chunker', async () => {
    // A spec is a YAML file; the fixture's JSON is valid YAML, copied under that name.
    const file = path.join(tmp('dp-spec-'), 'mini.yaml')
    fs.copyFileSync(path.join(FIXTURE, 'openapi', 'mini.json'), file)
    const [d] = readOpenapiDocs([file])
    expect(d.id).toBe('/reference/mini')
    expect(d.body.format).toBe('openapi')
    expect(d.visibility).toBe('public')
    // Without the optional parser the chunker says so, which proves the stage
    // reached chunkOpenapi and not a Markdown path.
    await expect(documentsToChunks([d], ctx())).rejects.toThrow(/@scalar\/openapi-parser is not installed/)
  })

  it('stops when two spec files claim one /reference/ route', () => {
    const root = tmp('dp-specs-')
    for (const v of ['v1', 'v2']) {
      fs.mkdirSync(path.join(root, v))
      fs.writeFileSync(path.join(root, v, 'api.yaml'), 'openapi: 3.0.0\n')
    }
    const said = []
    const die = (m) => {
      said.push(m)
      throw new Error(m)
    }
    expect(() => discoverOpenapiSpecs({ configured: ['v1', 'v2'], fallbackDir: 'none', root, die })).toThrow(
      /two OpenAPI specs claim \/reference\/api/,
    )
    const found = discoverOpenapiSpecs({ configured: ['v1'], fallbackDir: 'none', root, die })
    expect([...found.routes]).toEqual(['/reference/api'])
  })
})
