/**
 * Imported pages (`importDir`, the `--kb` pages) held to the imported-content
 * policy inside `docpilot index` — engine-spec 043, D-05, D-10, D-23, D-26.
 *
 * A link in an imported page points at the routes of the site the page was
 * copied from, so a dead one degrades to its text with a warning and never stops
 * the build (F-08). The two layers are tested apart: `documentsToChunks` in
 * process, where `die` and `warn` are collected, and the real CLI, where the
 * exit code and stderr are what an owner sees. `--no-embed --yes`: no network,
 * no model.
 */
import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { documentsToChunks } from '../src/build/lib/documents.js'

const BIN = path.resolve('bin/docpilot.js')
const FIXTURE = path.resolve('test/fixtures/source-parity')

const made = []
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

/** The parity fixture, copied: a build deletes and rewrites its index directory. */
function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-imported-'))
  made.push(dir)
  const root = path.join(dir, 'site')
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (src) => !/expected\.json$/.test(src) })
  return root
}

const build = (root, ...extra) =>
  spawnSync(process.execPath, [BIN, 'index', '--no-embed', '--yes', ...extra], { cwd: root, encoding: 'utf8' })

/** The topic page of the fixture, with `extra` appended to its body. */
function appendToTopic(root, extra) {
  const file = path.join(root, 'kb', 'topic.md')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + extra)
}

const SENTENCE = 'The imported page explains how the batch counter resets after every window.'

const docOf = (id, source, markdown, over = {}) => ({
  id,
  source,
  url: null,
  title: null,
  body: { format: 'markdown', markdown },
  file: `/proj${id}.md`,
  visibility: 'public',
  breadcrumb: [],
  tags: [],
  ...over,
})
const guide = (route) => docOf(route, 'markdown', `# ${route}\n\n${SENTENCE}\n`)
/** A kb page as `readKbDocs` returns it: the whole file, front matter included. */
const kbPage = (id, body, front = 'source: https://example.com/topic') =>
  docOf(id, 'kb', `---\ntitle: Page\n${front}\n---\n\n# Page\n\n${SENTENCE} ${body}\n`, { url: 'https://example.com/topic' })

function ctx(over = {}) {
  const said = { warn: [], die: [] }
  return {
    said,
    embedContext: 'off',
    llmsAbout: new Map(),
    originFor: (source) => source,
    warn: (m) => said.warn.push(m),
    die: (m) => {
      said.die.push(m)
      throw new Error(m)
    },
    root: '/proj',
    externalPrefix: '/kb',
    importDir: 'kb',
    docsDir: 'docs',
    ...over,
  }
}

const textOf = (chunks) => chunks.map((c) => c.text).join('\n')

describe('imported pages — a dead link degrades to its text (D-10, F-08)', () => {
  it('writes a link to a route this build lacks as its text, and warns with the file and the href', async () => {
    const c = ctx()
    const { chunks } = await documentsToChunks(
      [guide('/guide/alpha'), kbPage('/kb/one', 'See [gone](/guide/gone) for more.')],
      c,
    )
    const text = textOf(chunks)
    expect(text).toContain('See gone for more.')
    expect(text).not.toContain('/guide/gone')
    expect(c.said.die).toEqual([])
    const warned = c.said.warn.filter((m) => m.includes('/guide/gone'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('kb/one.md')
  })

  it('writes a link with a fragment or a title as its text too, target dropped', async () => {
    const c = ctx()
    const { chunks } = await documentsToChunks(
      [kbPage('/kb/one', 'See [a](/guide/a#top) and [b](/guide/b "Title") now.')],
      c,
    )
    const text = textOf(chunks)
    expect(text).toContain('See a and b now.')
    expect(text).not.toContain('/guide/a')
    expect(text).not.toContain('/guide/b')
    expect(c.said.warn.filter((m) => m.includes('not a page of this site'))).toHaveLength(2)
  })

  it('leaves a link inside a fenced block and inside an inline code span verbatim and unwarned', async () => {
    const c = ctx()
    const body = [
      'Use `[gone](/guide/gone)` as written, or ``[two](/guide/two)`` with doubled ticks.',
      '',
      '```md',
      'A fenced [sample](/guide/sample) link.',
      '```',
      '',
      '~~~~',
      'A tilde [sample](/guide/tilde) link.',
      '```',
      'still inside [sample](/guide/inner)',
      '~~~~',
      '',
      'After the fences, [real](/guide/real) is a link.',
    ].join('\n')
    const { chunks } = await documentsToChunks([kbPage('/kb/one', body)], c)
    const text = textOf(chunks)
    // The chunker flattens link syntax inside a code span to `text (href)` for every
    // page; the point here is that the href survives it, which a degrade would remove.
    expect(text).toContain('`gone (/guide/gone)`')
    expect(text).toContain('``two (/guide/two)``')
    expect(text).toContain('A fenced [sample](/guide/sample) link.')
    expect(text).toContain('A tilde [sample](/guide/tilde) link.')
    expect(text).toContain('still inside [sample](/guide/inner)')
    expect(text).toContain('After the fences, real is a link.')
    const links = c.said.warn.filter((m) => m.includes('not a page of this site'))
    expect(links).toHaveLength(1)
    expect(links[0]).toContain('/guide/real')
  })

  it('keeps a link to a route, an OpenAPI route, another imported page, the home page and an asset', async () => {
    const c = ctx({ specRoutes: new Set(['/reference/mini']) })
    const body =
      'Links: [alpha](/guide/alpha), [slash](/guide/alpha/), [spec](/reference/mini), [other](/kb/two#part), ' +
      '[home](/), [img](/img/a.png), and ![shot](/img/missing) as an image.'
    const { chunks } = await documentsToChunks(
      [guide('/guide/alpha'), kbPage('/kb/one', body), kbPage('/kb/two', 'The other page.')],
      c,
    )
    const text = textOf(chunks)
    // The chunker writes a kept link as `text (href)`; a degraded one has no href at all.
    for (const kept of [
      'alpha (/guide/alpha)',
      'slash (/guide/alpha/)',
      'spec (/reference/mini)',
      'other (/kb/two#part)',
      'home (/)',
      'img (/img/a.png)',
    ]) {
      expect(text).toContain(kept)
    }
    expect(c.said.warn.filter((m) => m.includes('not a page of this site'))).toEqual([])
  })

  it('still stops the build for a kb page with no front-matter source (D-23)', async () => {
    const c = ctx()
    await expect(
      documentsToChunks([kbPage('/kb/one', 'Plain text.', 'description: none here')], c),
    ).rejects.toThrow(/has no frontmatter source/)
  })
})

describe('imported pages — through the CLI', () => {
  it('indexes a page holding a dead link, exits 0 and names the file and the href on stderr', () => {
    const root = copyFixture()
    appendToTopic(root, '\nSee [gone](/guide/gone) for details.\n')
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(r.stderr).toContain(path.join('kb', 'topic.md'))
    expect(r.stderr).toContain('/guide/gone')
    const rag = path.join(root, 'docs', 'public', 'rag')
    const manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
    const text = manifest.shards.map((f) => fs.readFileSync(path.join(rag, f), 'utf8')).join('')
    expect(text).toContain('See gone for details.')
    expect(text).not.toContain('/guide/gone')
    // The fixture's own link to a real route is still a link.
    expect(text).toContain('alpha (/guide/alpha)')
  })

  it('stops with "has no frontmatter source" when the kb page has none', () => {
    const root = copyFixture()
    const file = path.join(root, 'kb', 'topic.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^source: .*\n/m, ''))
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).not.toBe(0)
    expect(r.stderr + r.stdout).toContain('has no frontmatter source')
  })
})
