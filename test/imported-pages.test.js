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
import crypto from 'node:crypto'
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
const kbPage = (id, body, front = 'source: https://example.com/topic', url = 'https://example.com/topic') =>
  docOf(id, 'kb', `---\ntitle: Page\n${front}\n---\n\n# Page\n\n${SENTENCE} ${body}\n`, { url })

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

/** A page `docpilot import` wrote: `importedAt:` always, `extractor:` from extractor 2 on. */
const imported = (id, source, extractor) =>
  kbPage(
    id,
    'Imported words.',
    [`source: ${source}`, 'importedAt: 2026-10-01', ...(extractor === undefined ? [] : [`extractor: ${extractor}`])].join('\n'),
    source,
  )
const stale = (c) => c.said.warn.filter((m) => /written by extractor/.test(m))
const newer = (c) => c.said.warn.filter((m) => /newer extractor/.test(m))

describe('imported pages — an older extractor is named with the command that refreshes it (D-05)', () => {
  it('counts two pages with importedAt and no extractor in one warning, with a re-import command each', async () => {
    const c = ctx()
    await documentsToChunks(
      [imported('/kb/one', 'https://example.com/a'), imported('/kb/two', 'https://example.com/b')],
      c,
    )
    expect(stale(c)).toHaveLength(1)
    const [message] = stale(c)
    expect(message).toContain('2 imported page(s)')
    expect(message).toContain('extractor 1')
    expect(message).toContain('npx docpilot import https://example.com/a --out one --force')
    expect(message).toContain('npx docpilot import https://example.com/b --out two --force')
    expect(c.said.die).toEqual([])
  })

  it('lists five commands and counts the rest', async () => {
    const c = ctx()
    const docs = Array.from({ length: 7 }, (_, i) => imported(`/kb/p${i}`, `https://example.com/p${i}`))
    await documentsToChunks(docs, c)
    const [message] = stale(c)
    expect(message).toContain('7 imported page(s)')
    expect(message.match(/npx docpilot import/g)).toHaveLength(5)
    expect(message).toContain('…and 2 more')
  })

  it('quotes a source that the shell would read as something else', async () => {
    const c = ctx()
    await documentsToChunks([imported('/kb/one', 'https://example.com/a?x=1&y=2')], c)
    expect(stale(c)[0]).toContain("npx docpilot import 'https://example.com/a?x=1&y=2' --out one --force")
  })

  it('shows a control byte in a source as an escape in the re-import command (W-02-01)', async () => {
    const c = ctx()
    await documentsToChunks([imported('/kb/one', 'https://example.com/a\u001b]52;c;eA==\u0007')], c)
    const [message] = stale(c)
    expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(message).toContain('\\x1b]52;c;eA==\\x07')
  })

  it('shows no control byte from a page or a file name on stderr when `index` warns (WR-10)', () => {
    const root = copyFixture()
    // A link target with no base to resolve against: the degrade warning names it.
    const hostile = '<!doctype html><html><head><title>Hostile</title></head><body><main><h2>Notes</h2><p>' +
      'The notes page explains how the batch counter resets after every window, and how a window is chosen. '.repeat(4) +
      '<a href="rel\u001b]52;c;eA==\u0007path">a relative link</a></p></main></body></html>'
    fs.writeFileSync(path.join(root, 'html', 'guide', 'hostile.html'), hostile)
    const r = build(root, '--html-dir=html')
    const said = r.stderr + r.stdout
    expect(said).toContain('had no usable base URL')
    expect(said).not.toMatch(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f-\u009f]/)
    expect(said).not.toContain('\u001b')
    expect(said).toContain('rel\\x1b]52;c;eA==\\x07path')
  })

  it('does not flag a page stamped with the current extractor, and says a newer one is newer', async () => {
    const c = ctx()
    await documentsToChunks(
      [imported('/kb/one', 'https://example.com/a', 2), imported('/kb/two', 'https://example.com/b', 3)],
      c,
    )
    expect(stale(c)).toEqual([])
    expect(newer(c)).toHaveLength(1)
    expect(newer(c)[0]).toContain('kb/two.md')
    expect(newer(c)[0]).not.toContain('kb/one.md')
    expect(c.said.die).toEqual([])
  })

  it('never flags a hand-written kb page, which has no importedAt', async () => {
    const c = ctx()
    await documentsToChunks([kbPage('/kb/one', 'Hand-written.'), kbPage('/kb/two', 'Also by hand.', 'source: https://example.com/b\nextractor: 1')], c)
    expect(stale(c)).toEqual([])
    expect(newer(c)).toEqual([])
  })
})

describe('imported pages — no term in the corpus hash (D-26)', () => {
  /** The manifest hash and the plain formula over the chunks the build wrote. */
  function hashes(root) {
    const rag = path.join(root, 'docs', 'public', 'rag')
    const manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
    const chunks = manifest.shards.flatMap((f) => JSON.parse(fs.readFileSync(path.join(rag, f), 'utf8')))
    const plain = crypto
      .createHash('sha256')
      .update(JSON.stringify(chunks.map((c) => c.id + c.text)))
      .digest('hex')
      .slice(0, 8)
    return { manifest: manifest.hash, plain }
  }

  it('is the plain formula for a corpus with kb pages, whatever extractor stamp they carry', () => {
    const stamped = (stamp) => {
      const root = copyFixture()
      const file = path.join(root, 'kb', 'topic.md')
      fs.writeFileSync(
        file,
        fs.readFileSync(file, 'utf8').replace('source: https://example.com/topic\n', `source: https://example.com/topic\nimportedAt: 2026-10-01\n${stamp}`),
      )
      const r = build(root)
      expect(r.status, r.stderr + r.stdout).toBe(0)
      return { r, ...hashes(root) }
    }
    const old = stamped('')
    const current = stamped('extractor: 2\n')
    expect(old.manifest).toBe(old.plain)
    expect(current.manifest).toBe(current.plain)
    expect(current.manifest).toBe(old.manifest)
    expect(old.r.stderr).toContain('npx docpilot import https://example.com/topic --out topic --force')
    expect(current.r.stderr).not.toContain('npx docpilot import')
  })
})
