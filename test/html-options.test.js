import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { htmlOptionsFor } from '../src/build/lib/html-options.js'

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
