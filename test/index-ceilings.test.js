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
import { afterAll, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve('bin/docpilot.js')
const SERVER = ", runtime: 'server', server: { endpoint: '/ai/turn' }"
const TIMEOUT = 120000

/** Every temp directory a test made: a server build here writes more than 5 MB, so none may stay. */
const made = []
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

/** A throwaway site with two small pages; `extra` is spliced into the config. */
function project(extra = '') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-ceil-'))
  made.push(base)
  const root = path.join(base, 'site')
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
    const r = build(root)
    expect(r.status, output(r)).toBe(0)
    const manifest = fs.readFileSync(path.join(ragOf(root), 'manifest.json'))
    expect(manifest.length).toBeGreaterThan(64 * 1024)
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

describe('the 5 MB ceiling is per runtime', () => {
  it('builds a corpus of over 5 MB under runtime: server and prints the shell size without a warning', () => {
    const root = project(SERVER)
    addBigPages(root)
    const r = build(root)
    expect(r.status, output(r)).toBe(0)
    const rag = ragOf(root)
    const total = fs.readdirSync(rag).reduce((a, f) => a + fs.statSync(path.join(rag, f)).size, 0)
    expect(total).toBeGreaterThan(5 * 1024 * 1024)
    expect(fs.statSync(path.join(rag, 'manifest.json')).size).toBeLessThan(64 * 1024)
    expect(r.stdout).toMatch(/shell manifest\s+\d+\.\d KB/)
    expect(output(r)).not.toMatch(/shell manifest[^\n]*(warn|over|ceiling)/i)
    expect(output(r)).not.toMatch(/Plan B applies/)
  }, TIMEOUT)

  it('refuses the same corpus under the default runtime and keeps a previous index byte for byte', () => {
    const root = project()
    expect(build(root).status).toBe(0)
    const before = snapshot(ragOf(root))
    addBigPages(root)
    const r = build(root)
    expect(r.status).not.toBe(0)
    expect(output(r)).toMatch(/artefacts total [\d.]+ MB, over the 5 MB ceiling/)
    expect(output(r)).toContain("runtime: 'server'")
    expect(snapshot(ragOf(root))).toEqual(before)
    expect(fs.readdirSync(path.join(root, 'docs', 'public'))).toEqual(['rag'])
  }, TIMEOUT)

  it('warns "Plan B applies" for a browser build between 3 MB and 5 MB, and a server build does not', () => {
    const browser = project()
    addBigPages(browser, 65)
    const rb = build(browser)
    expect(rb.status, output(rb)).toBe(0)
    expect(output(rb)).toMatch(/Plan B applies \(RAG-SPEC 2\.4\)/)

    const server = project(SERVER)
    addBigPages(server, 65)
    const rs = build(server)
    expect(rs.status, output(rs)).toBe(0)
    expect(output(rs)).not.toMatch(/Plan B applies/)
  }, TIMEOUT)
})

describe('docPilot.runtime in the config is the only switch', () => {
  it('builds the server corpus twice into the same project with identical output', () => {
    const root = project(SERVER)
    addManyPages(root)
    expect(build(root).status).toBe(0)
    const first = snapshot(ragOf(root))
    expect(build(root).status).toBe(0)
    expect(snapshot(ragOf(root))).toEqual(first)
  }, TIMEOUT)

  it('still refuses a browser build when DOCPILOT_RUNTIME=server is in the environment', () => {
    const root = project()
    addManyPages(root)
    const r = build(root, [], { DOCPILOT_RUNTIME: 'server' })
    expect(r.status).not.toBe(0)
    expect(output(r)).toMatch(/manifest is \d+ bytes, over the 65536 ceiling/)
  }, TIMEOUT)

  it('rejects --runtime=server as an unknown flag', () => {
    const root = project()
    addManyPages(root)
    const r = build(root, ['--runtime=server'])
    expect(r.status).not.toBe(0)
    expect(output(r)).toMatch(/unknown flag --runtime=server/)
    expect(fs.existsSync(ragOf(root))).toBe(false)
  }, TIMEOUT)

  it('keeps no ceiling arithmetic in the build module', () => {
    const src = fs.readFileSync(path.resolve('src/build/build-rag-index.ts'), 'utf8')
    expect(src).not.toMatch(/64\s*\*\s*1024/)
    expect(src).not.toMatch(/[35]\s*\*\s*1024\s*\*\s*1024/)
    expect(src).not.toMatch(/MANIFEST_MAX_BYTES|WARN_BYTES|FAIL_BYTES/)
    expect(src).toContain('limitsFor(docPilot.runtime)')
  })

  it('imports the shell from its own module, never the server entry', () => {
    const src = fs.readFileSync(path.resolve('src/build/build-rag-index.ts'), 'utf8')
    expect(src).toContain("from '../server/shell.js'")
    expect(src).not.toContain("from '../server/index.js'")
  })
})
