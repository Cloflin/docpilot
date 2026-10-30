/**
 * The size ceilings are per runtime — STORE-08, D-12, engine-spec 041.
 *
 * A browser reader downloads the manifest when the panel opens and the shards
 * it needs after that, so the browser build refuses a manifest over 64 KB and
 * artefacts over 5 MB. A server-runtime corpus is read only by `docpilot serve`,
 * so the same corpus builds there. `docPilot.runtime` in the config is the only
 * switch: no flag and no environment variable lifts a ceiling.
 *
 * Every project lives under `fs.mkdtempSync`, built for real by the CLI with
 * `--no-embed` (no network, no model).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve('bin/docpilot.js')
const SERVER = ", runtime: 'server', server: { endpoint: '/ai/turn' }"
const TIMEOUT = 120000

/** A throwaway site with two small pages; `extra` is spliced into the config. */
function project(extra = '') {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-ceil-')), 'site')
  fs.mkdirSync(path.join(root, 'docs', 'guide'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'docpilot.config.mjs'),
    `export const docPilot = { product: 'Acme', embed: false, chat: false${extra} }\nexport default {}\n`,
  )
  const para = (w) => `${w} `.repeat(160)
  fs.writeFileSync(path.join(root, 'docs', 'index.md'), `# Acme\n\n${para('intro')}\n`)
  fs.writeFileSync(
    path.join(root, 'docs', 'guide', 'retries.md'),
    `---\ntitle: Retries\n---\n\n# Retries\n\n## Backoff\n\n${para('backoff')}\n`,
  )
  return root
}

/** `n` pages with a long title each: the manifest's page rows pass 64 KB near 400. */
function addManyPages(root, n = 900) {
  const title = 'A long page title '.repeat(12)
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(root, 'docs', 'guide', `p${i}.md`), `---\ntitle: ${title}${i}\n---\n\nbody of page ${i}\n`)
  }
}

/** `n` pages of about 60 KB of distinct text each: the stage passes 5 MB, the manifest stays small. */
function addBigPages(root, n = 100, kb = 60) {
  for (let i = 0; i < n; i++) {
    const lines = []
    for (let j = 0; lines.join('\n').length < kb * 1024; j++) {
      lines.push(`word${i}x${j} alpha${(i * 7919 + j * 104729) % 99991} beta${(j * 31 + i) % 9973} `.repeat(6))
    }
    fs.writeFileSync(path.join(root, 'docs', 'guide', `big${i}.md`), `---\ntitle: Big ${i}\n---\n\n${lines.join('\n\n')}\n`)
  }
}

const build = (root, args = [], env = {}) =>
  spawnSync(process.execPath, [BIN, 'index', '--no-embed', '--yes', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
const output = (r) => `${r.stdout}\n${r.stderr}`
const snapshot = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]),
  )
const ragOf = (root) => path.join(root, 'docs', 'public', 'rag')

describe('the manifest ceiling is per runtime', () => {
  it('builds a 900-page corpus (manifest over 64 KB) under runtime: server', () => {
    const root = project(SERVER)
    addManyPages(root)
    const t0 = Date.now()
    const r = build(root)
    const ms = Date.now() - t0
    expect(r.status, output(r)).toBe(0)
    const manifest = fs.readFileSync(path.join(ragOf(root), 'manifest.json'))
    expect(manifest.length).toBeGreaterThan(64 * 1024)
    expect(ms).toBeLessThan(30000)
  }, TIMEOUT)

  it('refuses the same corpus under the default runtime, naming the way out', () => {
    const root = project()
    addManyPages(root)
    const r = build(root)
    expect(r.status).not.toBe(0)
    expect(output(r)).toMatch(/manifest is \d+ bytes, over the 65536 ceiling/)
    expect(output(r)).toContain("runtime: 'server'")
    expect(output(r)).toMatch(/shard/)
    expect(fs.existsSync(ragOf(root))).toBe(false)
  }, TIMEOUT)

  it('leaves the previous index byte for byte when a browser build is refused', () => {
    const root = project()
    expect(build(root).status).toBe(0)
    const before = snapshot(ragOf(root))
    addManyPages(root, 400)
    const r = build(root)
    expect(r.status).not.toBe(0)
    expect(output(r)).toMatch(/manifest is \d+ bytes, over the 65536 ceiling/)
    expect(snapshot(ragOf(root))).toEqual(before)
    expect(fs.readdirSync(path.join(root, 'docs', 'public'))).toEqual(['rag'])
  }, TIMEOUT)
})
