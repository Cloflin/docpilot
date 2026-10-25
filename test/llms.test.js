import {describe, it, expect, vi, afterEach} from 'vitest'
import {mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {parseLlmsTxt} from '../src/llms/parse.js'
import {lintLlmsTxt, coverage, toPagePath, normPath, renderLint, scoreOf, MAX_BYTES, RULES} from '../src/llms/lint.js'
import {buildLlmsTxt, trimNote, pageUrl} from '../src/llms/build.js'
import {runLlms, parseArgs} from '../src/llms/cli.js'

const VALID = `# FastHTML

> FastHTML is a python library which brings together Starlette, Uvicorn, HTMX, and fastcore.

Important notes:

- Although parts of its API are inspired by FastAPI, it is *not* compatible with FastAPI syntax

## Docs

- [FastHTML quick start](https://fastht.ml/docs/tutorials/quickstart_for_web_devs.html.md): A brief overview of many FastHTML features
- [HTMX reference](https://raw.githubusercontent.com/path/reference.md): Brief description of all HTMX attributes

## Optional

- [Starlette full documentation](https://gist.githubusercontent.com/path/starlette-sml.md): A subset of the Starlette documentation
`

const rules = (findings) => findings.map((f) => f.rule)

describe('parseLlmsTxt', () => {
  it('reads the spec example into H1, summary, body and file lists', () => {
    const p = parseLlmsTxt(VALID)
    expect(p.h1s).toEqual([{text: 'FastHTML', line: 1}])
    expect(p.summary.text).toMatch(/^FastHTML is a python library/)
    expect(p.summary.line).toBe(3)
    expect(p.body.length).toBe(2)
    expect(p.sections.map((s) => s.name)).toEqual(['Docs', 'Optional'])
    expect(p.sections[0].items[0]).toMatchObject({
      name: 'FastHTML quick start',
      url: 'https://fastht.ml/docs/tutorials/quickstart_for_web_devs.html.md',
      notes: 'A brief overview of many FastHTML features',
      line: 11,
    })
    expect(p.sections[1].items).toHaveLength(1)
  })

  it('accepts a BOM, CRLF, items without notes, and skips fenced code', () => {
    const p = parseLlmsTxt('﻿# X\r\n\r\n> s\r\n\r\n```\r\n# not a heading\r\n```\r\n\r\n## A\r\n\r\n- [a](https://x.dev/a.md)\r\n')
    expect(p.bom).toBe(true)
    expect(p.h1s).toHaveLength(1)
    expect(p.sections[0].items[0].notes).toBeNull()
  })

  it('the spec example lints with no errors or warnings', () => {
    const {findings} = lintLlmsTxt(VALID)
    expect(findings.filter((f) => f.severity !== 'info')).toEqual([])
  })
})

describe('lintLlmsTxt — each rule fires', () => {
  const fires = (text, rule, o = {}) => {
    const {findings} = lintLlmsTxt(text, o)
    expect(rules(findings)).toContain(rule)
    const f = findings.find((x) => x.rule === rule)
    expect(f.severity).toBe(RULES[rule].severity)
    expect(f.fix).toBeTruthy()
    return f
  }

  it('h1-missing', () => expect(fires('> s\n\n## A\n\n- [a](https://x.dev/a.md)\n', 'h1-missing').severity).toBe('error'))
  it('h1-duplicate', () => expect(fires('# A\n\n> s\n\n# B\n', 'h1-duplicate').line).toBe(5))
  it('h1-not-first', () => expect(fires('intro\n# A\n\n> s\n', 'h1-not-first').line).toBe(1))
  it('summary-missing', () => fires('# A\n\nSome text.\n', 'summary-missing'))
  it('summary-late', () => fires('# A\n\nSome text.\n\n> late summary\n', 'summary-late'))
  it('body-heading', () => fires('# A\n\n> s\n\n### Notes\n', 'body-heading'))
  it('section-heading', () => expect(fires('# A\n\n> s\n\n## Docs\n\n### Sub\n\n- [a](https://x.dev/a.md)\n', 'section-heading').line).toBe(7))
  it('item-format', () => expect(fires('# A\n\n> s\n\n## Docs\n\n- just text\n- <https://x.dev>\n', 'item-format').severity).toBe('error'))
  it('item-separator', () => fires('# A\n\n> s\n\n## Docs\n\n- [a](https://x.dev/a.md) - notes\n', 'item-separator'))
  it('section-prose', () => fires('# A\n\n> s\n\n## Docs\n\nA paragraph.\n\n- [a](https://x.dev/a.md)\n', 'section-prose'))
  it('section-empty', () => fires('# A\n\n> s\n\n## Docs\n\n## More\n\n- [a](https://x.dev/a.md)\n', 'section-empty'))
  it('section-duplicate', () => fires('# A\n\n> s\n\n## Docs\n\n- [a](https://x.dev/a.md)\n\n## docs\n\n- [b](https://x.dev/b.md)\n', 'section-duplicate'))
  it('url-duplicate', () => fires('# A\n\n> s\n\n## Docs\n\n- [a](https://x.dev/a.md)\n- [a2](https://x.dev/a.md#x)\n', 'url-duplicate'))
  it('url-relative suggests --site', () => {
    const f = fires('# A\n\n> s\n\n## Docs\n\n- [a](/guide/a.md)\n', 'url-relative')
    expect(f.fix).toMatch(/--site/)
    expect(f.items).toEqual(['L7 /guide/a.md'])
  })
  it('link-not-md (same-site only)', () => {
    const f = fires('# A\n\n> s\n\n## Docs\n\n- [a](https://x.dev/a)\n- [b](https://x.dev/b.md)\n- [gh](https://github.com/o/r)\n', 'link-not-md', {site: 'https://x.dev'})
    expect(f.items).toEqual(['L7 https://x.dev/a'])
  })
  it('notes-long', () => fires(`# A\n\n> s\n\n## Docs\n\n- [a](https://x.dev/a.md): ${'word '.repeat(60)}\n`, 'notes-long'))
  it('file-size says why', () => {
    const big = `# A\n\n> s\n\n${'filler text '.repeat(MAX_BYTES / 10)}\n`
    expect(fires(big, 'file-size').message).toMatch(/context window/)
  })
  it('optional-misplaced', () => fires('# A\n\n> s\n\n## Optional\n\n- [a](https://x.dev/a.md)\n\n## Docs\n\n- [b](https://x.dev/b.md)\n', 'optional-misplaced'))
  it('full-missing only when told it is absent', () => {
    fires(VALID, 'full-missing', {fullPresent: false})
    expect(rules(lintLlmsTxt(VALID, {fullPresent: true}).findings)).not.toContain('full-missing')
    expect(rules(lintLlmsTxt(VALID).findings)).not.toContain('full-missing')
  })
})

const MANIFEST = {
  pages: [
    {path: '/changelog', title: 'Changelog', kind: 'guide', chunks: 3, tail: 'Releases'},
    {path: '/guide', title: 'Quick start', kind: 'guide', chunks: 2, tail: 'Get started'},
    {path: '/guide/panel', title: 'The panel', kind: 'guide', chunks: 2, tail: 'Guide'},
    {path: '/introduction', title: 'Введение', kind: 'guide', chunks: 2, tail: 'Get started'},
    {path: '/reference/cli', title: 'CLI', kind: 'reference', chunks: 2, tail: 'Reference'},
    {path: 'ext:abc', title: 'Imported', kind: 'guide', chunks: 1, external: true, origin: 'https://other.dev/x'},
  ],
  sections: [
    {label: 'Get started', pageIdx: [3, 1]},
    {label: 'Releases', pageIdx: [0]},
    {label: 'Guide', pageIdx: [2]},
    {label: 'Reference', pageIdx: [4]},
  ],
}

describe('coverage', () => {
  it('maps URLs to manifest paths: origin, base, .md/.html, /index', () => {
    const o = {origin: 'https://x.dev', base: '/docs/'}
    expect(toPagePath('https://x.dev/docs/guide/index.md', o)).toBe('/guide')
    expect(toPagePath('https://x.dev/docs/guide/', o)).toBe('/guide')
    expect(toPagePath('/docs/guide/panel.html', o)).toBe('/guide/panel')
    expect(toPagePath('https://x.dev/docs/reference/cli.html.md', o)).toBe('/reference/cli')
    expect(toPagePath('https://x.dev/docs/', o)).toBe('/')
    expect(toPagePath('https://github.com/a/b', o)).toBeNull()
    expect(normPath('/index')).toBe('/')
  })

  it('lists unlinked indexed pages and links to no page; external pages are not expected', () => {
    const text = `# Docs\n\n> s\n\n## Docs\n\n- [Intro](https://x.dev/docs/introduction.md)\n- [Panel](https://x.dev/docs/guide/panel)\n- [Gone](https://x.dev/docs/guide/gone.md)\n- [GitHub](https://github.com/o/r)\n`
    const {parsed} = lintLlmsTxt(text)
    const c = coverage(parsed, MANIFEST, {site: 'https://x.dev/docs/'})
    expect(c.pages).toBe(5)
    expect(c.linked).toBe(2)
    expect(c.unlinked.map((u) => u.split(' ')[0])).toEqual(['/changelog', '/guide', '/reference/cli'])
    expect(c.notIndexed).toEqual([{url: 'https://x.dev/docs/guide/gone.md', line: 9, path: '/guide/gone'}])
    expect(rules(c.findings)).toEqual(['page-unlinked', 'link-not-indexed'])
    expect(c.findings[0].severity).toBe('warn')
  })

  it('guesses the site origin from the links when --site is absent', () => {
    const text = `# D\n\n> s\n\n## A\n\n- [a](https://x.dev/guide.md)\n- [b](https://x.dev/guide/panel.md)\n- [c](https://github.com/o)\n`
    const c = coverage(lintLlmsTxt(text).parsed, MANIFEST)
    expect(c.linked).toBe(2)
    expect(c.notIndexed).toEqual([])
  })
})

describe('buildLlmsTxt', () => {
  const descriptions = {'/introduction': 'Что это и зачем — встраиваемый ассистент.', '/guide/panel': 'The panel, ' + 'long '.repeat(60)}

  it('groups by sidebar, intro first, reference later, changelog under Optional', () => {
    const t = buildLlmsTxt({manifest: MANIFEST, descriptions, title: 'DocPilot', site: 'https://x.dev/docs/'})
    const heads = t.split('\n').filter((l) => l.startsWith('## '))
    expect(heads).toEqual(['## Get started', '## Guide', '## Reference', '## Optional'])
    expect(t).toMatch(/^# DocPilot\n\n> Что это и зачем — встраиваемый ассистент\.\n/)
    expect(t).toContain('- [Введение](https://x.dev/docs/introduction): Что это и зачем — встраиваемый ассистент.')
    expect(t.indexOf('Введение')).toBeLessThan(t.indexOf('Quick start'))
    expect(t).toContain('- [Changelog](https://x.dev/docs/changelog): Releases')
    expect(t).not.toContain('Imported')
    const panel = t.split('\n').find((l) => l.startsWith('- [The panel]'))
    expect(panel.split(': ')[1].length).toBeLessThanOrEqual(120)
    expect(panel.endsWith('…')).toBe(true)
  })

  it('round-trips through lint with zero errors and zero warnings, and full coverage', () => {
    for (const md of [false, true]) {
      const t = buildLlmsTxt({manifest: MANIFEST, descriptions, site: 'https://x.dev/docs/', md})
      const {parsed, findings} = lintLlmsTxt(t, {site: 'https://x.dev/docs/'})
      expect(findings.filter((f) => f.severity !== 'info')).toEqual([])
      const c = coverage(parsed, MANIFEST, {site: 'https://x.dev/docs/'})
      expect(c.unlinked).toEqual([])
      expect(c.notIndexed).toEqual([])
      if (md) expect(rules(findings)).not.toContain('link-not-md')
    }
  })

  it('Cyrillic titles and paths survive build → parse', () => {
    const manifest = {pages: [{path: '/руководство/начало', title: 'Начало [работы]', tail: 'Руководство'}]}
    const t = buildLlmsTxt({manifest, title: 'Документация', summary: 'Кратко.', md: true})
    const p = parseLlmsTxt(t)
    expect(p.h1s[0].text).toBe('Документация')
    expect(p.sections[0].name).toBe('Руководство')
    expect(p.sections[0].items[0]).toMatchObject({name: 'Начало [работы]', url: '/руководство/начало.md'})
    expect(toPagePath(p.sections[0].items[0].url)).toBe('/руководство/начало')
  })

  it('falls back to the first path segment when there is no tail or kind; pageUrl handles index routes', () => {
    const t = buildLlmsTxt({manifest: {pages: [{path: '/api/x', title: 'X'}]}})
    expect(t).toContain('## Api')
    expect(pageUrl('/', {md: true})).toBe('/index.md')
    expect(pageUrl('/a b', {site: 'https://x.dev/'})).toBe('https://x.dev/a%20b')
    expect(trimNote('a  b\n c')).toBe('a b c')
  })
})

describe('renderLint', () => {
  it('groups by severity and ends with a score line', () => {
    const {findings} = lintLlmsTxt('# A\n\n## Docs\n\n- bad\n- [a](/a)\n')
    const out = renderLint(findings, {cover: {pages: 3, linked: 1}})
    expect(out.indexOf('ERRORS')).toBeLessThan(out.indexOf('WARNINGS'))
    expect(out.indexOf('WARNINGS')).toBeLessThan(out.indexOf('INFO'))
    expect(out.trim().split('\n').pop()).toMatch(/^score \d+\/100 · 1 error\(s\) · \d+ warning\(s\) · \d+ info · 1\/3 indexed pages linked$/)
    expect(scoreOf([])).toBe(100)
  })
})

describe('renderLint on a hostile file', () => {
  it('prints no control byte the file carried', () => {
    const evil = 'https://x.dev/a\u001b[2J\u001b[H\u001b]52;c;eA==\u0007'
    const {findings} = lintLlmsTxt(`# A\n\n## Docs\n\n- [a](${evil})\n- [b](${evil})\n`)
    const out = renderLint(findings, {file: 'https://x.dev/llms.txt\u001b[8m'})
    expect(out).not.toMatch(/[\u001b\u0007]/)
    expect(out).toContain('\\x1b[8m')
    expect(out).toContain('x.dev/a\\x1b[2J')
  })
})

describe('runLlms', () => {
  let logs
  afterEach(() => vi.restoreAllMocks())
  const capture = () => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')))
  }
  const project = () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'llms-'))
    mkdirSync(path.join(cwd, 'docs/public/rag'), {recursive: true})
    writeFileSync(path.join(cwd, 'docs/public/rag/manifest.json'), JSON.stringify(MANIFEST))
    mkdirSync(path.join(cwd, 'docs/guide'), {recursive: true})
    writeFileSync(path.join(cwd, 'docs/introduction.md'), '---\ndescription: Встраиваемый ассистент.\n---\n# Введение\n')
    writeFileSync(path.join(cwd, 'docs/guide/index.md'), '---\ndescription: Start here.\n---\n# Quick start\n')
    return cwd
  }

  it('parses flags in both forms and rejects unknown ones', () => {
    expect(parseArgs(['build', '--site=https://x.dev', '--md']).flags).toEqual({site: 'https://x.dev', md: true})
    expect(parseArgs(['lint', '--file', 'a.txt']).flags).toEqual({file: 'a.txt'})
    expect(parseArgs(['lint', '--nope']).error).toMatch(/unknown option/)
    expect(parseArgs(['lint', '--md']).error).toMatch(/not an option/)
  })

  it('usage errors exit 2, --help exits 0', async () => {
    capture()
    expect(await runLlms({argv: ['--help']})).toBe(0)
    expect(await runLlms({argv: ['frob']})).toBe(2)
    expect(await runLlms({argv: ['lint', '--bogus']})).toBe(2)
    expect(await runLlms({argv: ['build', '--site=docs.x.dev']})).toBe(2)
  })

  it('build writes, refuses to overwrite without --force, notes vitepress-plugin-llms; lint reads it back', async () => {
    const cwd = project()
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({devDependencies: {'vitepress-plugin-llms': '^1.0.0'}}))
    capture()
    const docPilot = {docsDir: 'docs', product: 'DocPilot'}
    expect(await runLlms({docPilot, cwd, argv: ['build', '--site=https://x.dev/']})).toBe(0)
    const out = path.join(cwd, 'docs/public/llms.txt')
    const text = readFileSync(out, 'utf8')
    expect(text).toContain('> Встраиваемый ассистент.')
    expect(text).toContain('- [Quick start](https://x.dev/guide): Start here.')
    expect(logs.join('\n')).toMatch(/vitepress-plugin-llms is in package.json/)

    expect(await runLlms({docPilot, cwd, argv: ['build']})).toBe(1)
    expect(logs.join('\n')).toMatch(/--force/)
    expect(await runLlms({docPilot, cwd, argv: ['build', '--force', '--out=out/llms.txt']})).toBe(0)
    expect(existsSync(path.join(cwd, 'out/llms.txt'))).toBe(true)

    logs = []
    expect(await runLlms({docPilot, cwd, argv: ['lint', '--json', '--site=https://x.dev/']})).toBe(0)
    const report = JSON.parse(logs.join('\n'))
    expect(report.counts.error).toBe(0)
    expect(report.coverage).toMatchObject({pages: 5, linked: 5})
    expect(rules(report.findings)).toContain('full-missing')
  })

  it('lint exits 1 on an error and tells the user where to point when no file exists', async () => {
    const cwd = project()
    capture()
    expect(await runLlms({docPilot: {docsDir: 'docs'}, cwd, argv: ['lint']})).toBe(1)
    expect(logs.join('\n')).toMatch(/--file=/)
    writeFileSync(path.join(cwd, 'bad.txt'), '## no h1\n\n- [a](/a)\n')
    expect(await runLlms({docPilot: {docsDir: 'docs'}, cwd, argv: ['lint', '--file=bad.txt']})).toBe(1)
    expect(logs.join('\n')).toMatch(/h1-missing/)
  })

  it('lint fetches a URL and probes llms-full.txt beside it', async () => {
    capture()
    const fetch = vi.fn(async (url, init) => {
      if (init?.method === 'HEAD') return {ok: true}
      return {ok: true, status: 200, text: async () => VALID}
    })
    const cwd = mkdtempSync(path.join(tmpdir(), 'llms-'))
    expect(await runLlms({cwd, fetch, argv: ['lint', '--file=https://fastht.ml/docs/llms.txt']})).toBe(0)
    expect(fetch.mock.calls[1][0]).toBe('https://fastht.ml/docs/llms-full.txt')
    expect(logs.join('\n')).not.toMatch(/full-missing/)
  })
})
