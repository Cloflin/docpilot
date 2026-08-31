import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { stripMdx, normaliseMarkdown } from '../src/build/lib/normalise.js'
import { specFiles } from '../src/build/lib/openapi-chunker.js'
import { routeOf } from '../src/theme/docpilot/route.js'

/**
 * `.mdx` and `docPilot.openapi` — engine-specs/002.
 */

describe('stripMdx — module syntax is not prose', () => {
  it('drops the import forms an MDX page opens with', () => {
    const src = [
      "import Tabs from '@theme/Tabs'",
      "import './styles.css'",
      '',
      '## Install',
    ].join('\n')
    expect(stripMdx(src).trim()).toBe('## Install')
  })

  it('drops a multi-line import as one statement, not line by line', () => {
    const src = ['import {', '  Tabs,', '  TabItem,', "} from '@theme/Tabs'", '', 'Real prose.'].join('\n')
    expect(stripMdx(src).trim()).toBe('Real prose.')
  })

  /**
   * The end of a statement is bracket balance, not a guess. `export const toc = [`
   * runs until its `]` however many lines that takes; anything that stopped
   * earlier would resume in the middle of an expression and index half of it.
   */
  it('drops a multi-line export to its closing bracket and no further', () => {
    const src = [
      'export const toc = [',
      "  { value: 'Install', id: 'install' },",
      "  { value: 'Usage', id: 'usage' },",
      ']',
      '',
      'Real prose.',
    ].join('\n')
    expect(stripMdx(src).trim()).toBe('Real prose.')
  })

  it('drops a whole-line JSX comment', () => {
    expect(stripMdx('{/* a note to the author */}\n\nReal prose.').trim()).toBe('Real prose.')
  })

  /**
   * The guard that matters most: this pass runs over EVERY page, not only over
   * `.mdx`, so a false positive deletes documentation. `import` needs a quoted
   * specifier or a `from '…'`; `export` needs a declaration keyword.
   */
  it('leaves prose that happens to begin with import or export', () => {
    const src = [
      "import the file's contents with the button in the top right",
      'export the data as CSV when you are done',
      'exports are listed below',
    ].join('\n')
    expect(stripMdx(src)).toBe(src)
  })

  it('never reaches inside a fence, so a page documenting MDX keeps its sample', () => {
    const src = ['```mdx', "import Tabs from '@theme/Tabs'", '', '## Install', '```'].join('\n')
    expect(stripMdx(src)).toBe(src)
  })

  it('runs inside the pipeline, ahead of the tag pass', () => {
    const out = normaliseMarkdown(["import Tabs from '@theme/Tabs'", '', '# Title', '', 'Body.'].join('\n'))
    expect(out.text).not.toContain('@theme/Tabs')
    expect(out.text).toContain('Body.')
  })
})

describe('routeOf — .mdx is a page like any other', () => {
  it('maps an mdx file to the same route its md twin would take', () => {
    expect(routeOf('guide/install.mdx')).toBe('/guide/install')
    expect(routeOf('guide/index.mdx')).toBe('/guide')
    expect(routeOf('index.mdx')).toBe('/')
  })
})

describe('specFiles — where the OpenAPI specs are', () => {
  const tmp = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-spec-'))
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body)
    }
    return dir
  }
  const names = (r) => r.files.map((f) => path.basename(f)).sort()

  it('falls back to the documented directory when nothing is configured', () => {
    const root = tmp({ 'docs/public/openapi/api.yaml': 'openapi: 3.0.0', 'docs/public/openapi/notes.md': '#' })
    const out = specFiles(null, 'docs/public/openapi', root)
    expect(names(out)).toEqual(['api.yaml'])
    expect(out.errors).toEqual([])
  })

  it('is silent when the default directory is simply absent', () => {
    const out = specFiles(null, 'docs/public/openapi', tmp({ 'readme.md': '#' }))
    expect(out.files).toEqual([])
    expect(out.errors).toEqual([])
  })

  it('takes a directory, a file, and a name pattern', () => {
    const root = tmp({
      'api/one.yaml': 'a',
      'api/two.yml': 'b',
      'partners/partner.yaml': 'c',
      'specs/v1.yaml': 'd',
      'specs/v2.yaml': 'e',
      'specs/draft.yaml': 'f',
    })
    expect(names(specFiles(['api'], 'x', root))).toEqual(['one.yaml', 'two.yml'])
    expect(names(specFiles(['partners/partner.yaml'], 'x', root))).toEqual(['partner.yaml'])
    expect(names(specFiles(['specs/v*.yaml'], 'x', root))).toEqual(['v1.yaml', 'v2.yaml'])
  })

  it('merges several entries and never lists one file twice', () => {
    const root = tmp({ 'api/one.yaml': 'a', 'api/two.yaml': 'b' })
    const out = specFiles(['api', 'api/one.yaml'], 'x', root)
    expect(names(out)).toEqual(['one.yaml', 'two.yaml'])
  })

  /**
   * A configured path that does not exist is a typo, and a silent one leaves a
   * documented `/reference/` route with nothing behind it on a live site.
   */
  it('reports a path somebody wrote and got wrong', () => {
    const out = specFiles(['api/openapi.yaml'], 'x', tmp({ 'readme.md': '#' }))
    expect(out.files).toEqual([])
    expect(out.errors.join()).toContain('does not exist')
  })

  it('refuses a * outside the file name rather than matching nothing', () => {
    const out = specFiles(['spec*/api.yaml'], 'x', tmp({ 'specs/api.yaml': 'a' }))
    expect(out.errors.join()).toContain('a * in a directory name')
  })

  it('refuses an entry that is not a path', () => {
    expect(specFiles([42], 'x', tmp({})).errors.join()).toContain('not a path')
  })
})
