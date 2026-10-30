import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { htmlOptionsFor, htmlConfigProblems } from '../src/build/lib/html-options.js'
import { extractHtml } from '../src/build/lib/extract-html.js'
import { htmlRecordToDoc, readKbDocs } from '../src/build/lib/readers.js'

/**
 * `docPilot.html` — engine-spec 043, D-06, D-21, D-22.
 *
 * One options function that every HTML path reads: flags over the longest
 * matching source over the project default, `content` and `exclude` taken
 * separately. The CLI block proves the config reaches `index --html-dir`.
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

function copyFixture() {
  const root = path.join(tmp('dp-options-'), 'site')
  fs.cpSync(FIXTURE, root, { recursive: true, filter: (src) => !/expected\.json$/.test(src) })
  return root
}

const build = (root, ...extra) =>
  spawnSync(process.execPath, [BIN, 'index', '--no-embed', '--yes', ...extra], { cwd: root, encoding: 'utf8' })

function chunkText(root) {
  const rag = path.join(root, 'docs', 'public', 'rag')
  const manifest = JSON.parse(fs.readFileSync(path.join(rag, 'manifest.json'), 'utf8'))
  return manifest.shards.flatMap((n) => JSON.parse(fs.readFileSync(path.join(rag, n), 'utf8'))).map((c) => c.text).join('\n')
}

describe('htmlOptionsFor — the project level and the flags', () => {
  it('returns nothing set when there is no config', () => {
    expect(htmlOptionsFor(null, 'a.html')).toEqual({ content: '', exclude: [] })
    expect(htmlOptionsFor(undefined, 'a.html')).toEqual({ content: '', exclude: [] })
  })

  it('reads the project default', () => {
    expect(htmlOptionsFor({ content: '#article', exclude: '.x' }, 'a.html')).toEqual({
      content: '#article',
      exclude: ['.x'],
    })
    expect(htmlOptionsFor({ exclude: ['.x', ' .y '] }, 'a.html').exclude).toEqual(['.x', '.y'])
  })

  it('lets a flag win over the project default, separately for each key', () => {
    const html = { content: '#article', exclude: '.x' }
    expect(htmlOptionsFor(html, 'a.html', { flags: { content: '#other' } })).toEqual({
      content: '#other',
      exclude: ['.x'],
    })
    expect(htmlOptionsFor(html, 'a.html', { flags: { exclude: '.z' } })).toEqual({
      content: '#article',
      exclude: ['.z'],
    })
  })

  it('treats an empty string, a blank string and an empty list as not set', () => {
    const html = { content: '#article', exclude: '.x' }
    expect(htmlOptionsFor(html, 'a.html', { flags: { content: '', exclude: [] } })).toEqual({
      content: '#article',
      exclude: ['.x'],
    })
    expect(htmlOptionsFor({ content: '   ', exclude: ['', '  '] }, 'a.html')).toEqual({ content: '', exclude: [] })
  })
})

describe('index --html-dir reads docPilot.html', () => {
  const NOTE = 'Internal editor note for the docs team.'
  const PROSE = 'The rollout checklist records each window and reports the result for every batch of the release. '.repeat(5)
  const PAGE =
    `<!doctype html><html><head><title>Rollout</title></head><body><main><h2>Checklist</h2>` +
    `<p>${PROSE}</p><div class="editor-note">${NOTE}</div></main></body></html>`

  function withPage(config) {
    const root = copyFixture()
    fs.mkdirSync(path.join(root, 'html', 'guide'), { recursive: true })
    fs.writeFileSync(path.join(root, 'html', 'guide', 'rollout.html'), PAGE)
    if (config) {
      const p = path.join(root, 'docpilot.config.mjs')
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('importDir:', `html: ${JSON.stringify(config)},\n  importDir:`))
    }
    return root
  }

  it('removes the excluded block from every built page', () => {
    const root = withPage({ exclude: '.editor-note' })
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const text = chunkText(root)
    expect(text).not.toContain('Internal editor note')
    expect(text).toContain('The rollout checklist records each window')
  })

  it('keeps the block when the config does not name it', () => {
    const root = withPage(null)
    const r = build(root, '--html-dir=html')
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(chunkText(root)).toContain('Internal editor note')
  })
})

describe('htmlOptionsFor — per-source overrides (D-21)', () => {
  const ROOT = path.resolve('/proj')
  const file = (rel) => path.join(ROOT, rel)

  it('matches a URL key at a path-segment boundary', () => {
    const html = { content: '#default', sources: { 'https://acme.test/help': { content: '#article' } } }
    expect(htmlOptionsFor(html, 'https://acme.test/help/a').content).toBe('#article')
    expect(htmlOptionsFor(html, 'https://acme.test/help').content).toBe('#article')
    expect(htmlOptionsFor(html, 'https://acme.test/helpdesk/a').content).toBe('#default')
    expect(htmlOptionsFor(html, 'https://other.test/help/a').content).toBe('#default')
  })

  it('matches a directory key at a path-segment boundary, the longest key winning', () => {
    const html = {
      content: '#default',
      sources: { html: { content: '#h' }, 'html/guide': { content: '#g' } },
    }
    const opts = { root: ROOT }
    expect(htmlOptionsFor(html, file('html/guide/a.html'), opts).content).toBe('#g')
    expect(htmlOptionsFor(html, file('html/other/a.html'), opts).content).toBe('#h')
    expect(htmlOptionsFor(html, file('htmlx/a.html'), opts).content).toBe('#default')
  })

  it('never matches a URL key to a file or a directory key to a URL', () => {
    const html = { sources: { 'https://acme.test': { content: '#u' }, html: { content: '#d' } } }
    expect(htmlOptionsFor(html, file('html/a.html'), { root: ROOT }).content).toBe('#d')
    expect(htmlOptionsFor(html, 'https://acme.test/html/a.html', { root: ROOT }).content).toBe('#u')
    expect(htmlOptionsFor({ sources: { html: { content: '#d' } } }, 'https://acme.test/html/a', { root: ROOT }).content).toBe('')
  })

  it('takes content and exclude separately; an empty list falls back, a set list replaces', () => {
    const html = {
      exclude: ['.a', '.b'],
      sources: { html: { exclude: [], content: '#h' }, 'html/guide': { exclude: '.x' } },
    }
    const opts = { root: ROOT }
    expect(htmlOptionsFor(html, file('html/other/a.html'), opts)).toEqual({ content: '#h', exclude: ['.a', '.b'] })
    // One source level applies, the longest key: it sets only `exclude`, so
    // `content` falls to the project default, not to the shorter `html` key.
    expect(htmlOptionsFor(html, file('html/guide/a.html'), opts)).toEqual({ content: '', exclude: ['.x'] })
  })

  it('lets a flag override every config level', () => {
    const html = { content: '#d', sources: { html: { content: '#h' } } }
    const out = htmlOptionsFor(html, file('html/a.html'), { root: ROOT, flags: { content: '#flag' } })
    expect(out.content).toBe('#flag')
  })

  it('resolves two keys of equal specificity to the first in key order, on every run', () => {
    const html = { sources: { 'html/a': { content: '#first' }, 'html/b': { content: '#second' } } }
    // Equal length, and the target sits under neither prefix twice: both keys
    // can only tie when they name the same directory.
    const tie = { sources: { './html': { content: '#first' }, 'html/': { content: '#second' } } }
    for (let i = 0; i < 3; i++) {
      expect(htmlOptionsFor(tie, file('html/x.html'), { root: ROOT }).content).toBe('#first')
      expect(htmlOptionsFor(html, file('html/a/x.html'), { root: ROOT }).content).toBe('#first')
    }
  })
})

describe('htmlConfigProblems — a malformed config is named, not guessed at', () => {
  it('accepts nothing, and a well-formed object', () => {
    expect(htmlConfigProblems(null)).toEqual([])
    expect(htmlConfigProblems(undefined)).toEqual([])
    expect(
      htmlConfigProblems({ content: '#a', exclude: ['.x'], sources: { html: { content: '#b', exclude: '.y' } } }),
    ).toEqual([])
  })

  it('names the dotted key of each problem', () => {
    expect(htmlConfigProblems({ content: 3 }).join('\n')).toContain('docPilot.html.content')
    expect(htmlConfigProblems({ exclude: [1] }).join('\n')).toContain('docPilot.html.exclude')
    expect(htmlConfigProblems({ colour: 'x' }).join('\n')).toContain('colour')
    expect(htmlConfigProblems('nope')).toHaveLength(1)
    expect(htmlConfigProblems({ sources: [] }).join('\n')).toContain('docPilot.html.sources')
    expect(htmlConfigProblems({ sources: { 'https://acme.test': { exclude: 5 } } })).toEqual([
      'docPilot.html.sources["https://acme.test"].exclude must be a string or a list of strings',
    ])
    expect(htmlConfigProblems({ sources: { html: { colour: 'x' } } }).join('\n')).toContain('colour')
  })

  it('stops index --html-dir before any page is read, with one line per problem', () => {
    const root = copyFixture()
    const p = path.join(root, 'docpilot.config.mjs')
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('importDir:', "html: { content: 3, colour: 'x' },\n  importDir:"))
    const r = build(root, '--html-dir=html')
    expect(r.status).not.toBe(0)
    const out = r.stderr + r.stdout
    expect(out).toContain('docPilot.html is not valid')
    expect(out).toContain('docPilot.html.content')
    expect(out).toContain('colour')
    expect(out).not.toContain('skipped')
  })
})

describe('HTML-01 edges, through extractHtml', () => {
  const PROSE = '<p>' + 'Every request is counted against a window and reported. '.repeat(6) + '</p>'
  const wrap = (body) => `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`

  it('adjacency: an element matching content and exclude stays the root', async () => {
    const html = wrap(`<div class="box">${PROSE}<span class="box">inner box text kept out</span></div>`)
    const opts = htmlOptionsFor({ content: '.box', exclude: '.box' }, 'a.html')
    const out = await extractHtml(html, opts)
    expect(out.ok).toBe(true)
    expect(out.markdown).toContain('Every request is counted')
    expect(out.markdown).not.toContain('inner box text')
  })

  it('empty: a blank selector falls back to the landmark, a miss skips the page', async () => {
    const html = wrap(`<main>${PROSE}</main>`)
    const blank = await extractHtml(html, htmlOptionsFor({ content: '   ', exclude: [] }, 'a.html'))
    expect(blank.ok).toBe(true)
    expect(blank.scope).toBe('main')
    const warnings = []
    const miss = await extractHtml(html, { ...htmlOptionsFor({ content: '.no-such' }, 'a.html'), warn: (m) => warnings.push(m) })
    expect(miss.ok).toBe(false)
    expect(miss.markdown || '').not.toContain('Every request')
  })

  it('ordering: several matches give the first in document order, on every run', async () => {
    const html = wrap(
      `<section class="pick"><p>${'First block text goes here and carries the prose. '.repeat(4)}</p></section>` +
        `<section class="pick"><p>${'Second block text goes here and carries the prose. '.repeat(4)}</p></section>`,
    )
    const opts = htmlOptionsFor({ content: '.pick' }, 'a.html')
    for (let i = 0; i < 3; i++) {
      const out = await extractHtml(html, opts)
      expect(out.ok).toBe(true)
      expect(out.markdown).toContain('First block text')
      expect(out.markdown).not.toContain('Second block text')
    }
  })
})

describe('page metadata on the document (D-12)', () => {
  const rec = { route: '/x', file: '/p/x.html', src: '# X', title: 'X' }

  it('maps canonical, lang and dateModified of a built page', () => {
    const doc = htmlRecordToDoc({ ...rec, canonical: 'https://acme.test/x', lang: 'de', dateModified: '2026-01-02' })
    expect(doc.url).toBe('https://acme.test/x')
    expect(doc.locale).toBe('de')
    expect(doc.updatedAt).toBe('2026-01-02')
    expect(doc.source).toBe('html-dir')
  })

  it('leaves them empty when the page names none', () => {
    const doc = htmlRecordToDoc({ ...rec, canonical: null, lang: '', dateModified: null })
    expect(doc.url).toBeNull()
    expect(doc.locale).toBeUndefined()
    expect(doc.updatedAt).toBeUndefined()
  })

  it('maps lang and dateModified of a kb page from its front matter', () => {
    const kb = tmp('dp-kb-')
    fs.writeFileSync(path.join(kb, 'a.md'), '---\ntitle: A\nlang: fr\ndateModified: 2026-03-04\n---\n\nBody text of the page.\n')
    fs.writeFileSync(path.join(kb, 'b.md'), '---\ntitle: B\n---\n\nBody text of the page.\n')
    const [a, b] = readKbDocs({ kbDir: kb, externalPrefix: '/ext' })
    expect(a.locale).toBe('fr')
    expect(a.updatedAt).toBe('2026-03-04')
    expect(b.locale).toBeUndefined()
    expect(b.updatedAt).toBeUndefined()
  })
})
