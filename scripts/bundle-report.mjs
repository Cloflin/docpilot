#!/usr/bin/env node
/**
 * What is inside dist/docpilot.web.js — the self-contained IIFE — byte by byte.
 *
 * Phase 8 moves features out of this bundle. It has to decide from numbers, and
 * the numbers have to be repeatable, so this is a script and not a one-off
 * measurement.
 *
 * WHY SOURCEMAPS. The honest unit is bytes of the file a reader downloads, which
 * is post-minify. A source map of the minified output says, for every stretch of
 * generated code, which source file it came from — so attributing each stretch
 * to its file gives contributors that sum EXACTLY to the output length. The
 * alternative, `OutputChunk.modules[*].renderedLength`, is measured before
 * minification and sums to 1.5x the file; it cannot say what a feature costs.
 * The decoder below is hand-written (about thirty lines) so the measurement
 * adds no dependency.
 *
 * WHAT IT BUILDS. The same options `npm run build:web` publishes with, from
 * bin/web-build-config.js — never a copy — with `write: false` and
 * `sourcemap: true`. NOTHING IS WRITTEN UNDER dist/: the published bytes are not
 * touched by measuring them (BNDL-01).
 *
 * OUTPUT. A table on stdout, and with `--out=<file>` the same numbers as JSON
 * (schema 1, no timestamp — two runs on one tree give identical files). Phase 8
 * reads that JSON for its size table and budgets; the frozen 2.1.1 composition
 * is docpilot/baselines/bundle-2.1.1.json.
 *
 * COMPRESSION IS A WHOLE-FILE NUMBER. gzip and brotli are reported for the file
 * and for each ES chunk, never per contributor: a contributor's compressed cost
 * depends on what sits beside it, so a per-contributor figure would not be a
 * measurement of anything. Raw bytes are the only unit that adds up.
 *
 *   node scripts/bundle-report.mjs [--out=<file>]
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]))

/** Decodes one base64 VLQ segment into its signed integer fields. */
function decodeSegment(text) {
  const fields = []
  let value = 0
  let shift = 0
  for (const char of text) {
    const digit = B64_VALUE.get(char)
    if (digit === undefined) throw new Error(`bad base64 VLQ digit ${JSON.stringify(char)}`)
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      continue
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return fields
}

/**
 * Bytes of each UTF-16 code unit of `line`, as a prefix-sum array, so a column
 * (which a source map counts in code units) converts to a byte offset. A
 * surrogate pair is charged whole to its high half: a cut between the two
 * halves still partitions the line exactly, which `Buffer.byteLength` of a
 * slice would not.
 */
function byteOffsets(line) {
  const offsets = new Uint32Array(line.length + 1)
  for (let i = 0; i < line.length; i++) {
    const unit = line.charCodeAt(i)
    let bytes
    if (unit < 0x80) bytes = 1
    else if (unit < 0x800) bytes = 2
    else if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < line.length) {
      const next = line.charCodeAt(i + 1)
      bytes = next >= 0xdc00 && next < 0xe000 ? 4 : 3
    } else if (unit >= 0xdc00 && unit < 0xe000 && i > 0) {
      const prev = line.charCodeAt(i - 1)
      bytes = prev >= 0xd800 && prev < 0xdc00 ? 0 : 3
    } else bytes = 3
    offsets[i + 1] = offsets[i] + bytes
  }
  return offsets
}

export const UNMAPPED = 'unmapped'

/**
 * Attributes every byte of `code` to a source of `map`. Returns
 * `Map<source, bytes>`; bytes with no mapping (the wrapper, newlines, code the
 * bundler generated) go to `UNMAPPED`. The values sum to
 * `Buffer.byteLength(code)`.
 */
export function attribute(code, map) {
  const bytes = new Map()
  const add = (key, n) => {
    if (n) bytes.set(key, (bytes.get(key) || 0) + n)
  }
  const lines = code.split('\n')
  const mappingLines = map.mappings.split(';')
  let sourceIndex = 0
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l]
    const offsets = byteOffsets(line)
    const total = offsets[line.length]
    // The newline that ended this line belongs to no source.
    if (l < lines.length - 1) add(UNMAPPED, 1)
    const segments = (mappingLines[l] || '').split(',').filter(Boolean)
    let column = 0
    // Each entry is [startColumn, sourceName | UNMAPPED]
    const starts = []
    for (const text of segments) {
      const f = decodeSegment(text)
      column += f[0]
      if (f.length >= 4) {
        sourceIndex += f[1]
        starts.push([column, map.sources[sourceIndex]])
      } else starts.push([column, UNMAPPED])
    }
    if (!starts.length) {
      add(UNMAPPED, total)
      continue
    }
    // Code before the first segment of a line has no mapping.
    add(UNMAPPED, offsets[Math.min(starts[0][0], line.length)])
    for (let s = 0; s < starts.length; s++) {
      const from = Math.min(starts[s][0], line.length)
      const to = s + 1 < starts.length ? Math.min(starts[s + 1][0], line.length) : line.length
      add(starts[s][1], offsets[to] - offsets[from])
    }
  }
  return bytes
}

/**
 * A source of the map -> the thing that contributed it. Map sources are relative
 * to the map's own directory (`dist/`), so a repo file is `../src/...`.
 * `../node_modules/.../node_modules/@scope/pkg/dist/a.js` -> `@scope/pkg`; a repo
 * file becomes its repo-relative path; a `?query` (Vue sub-blocks) is dropped.
 */
export function contributorOf(source) {
  if (source === UNMAPPED) return UNMAPPED
  const clean = source.replace(/\\/g, '/').replace(/[?#].*$/, '')
  const at = clean.lastIndexOf('node_modules/')
  if (at >= 0) {
    const parts = clean.slice(at + 'node_modules/'.length).split('/')
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  }
  return clean.replace(/^(\.\.\/)+/, '').replace(/^\//, '')
}

/**
 * WHERE EACH CONTRIBUTOR GOES — the one table Phase 8 edits.
 *
 * A contributor is a package name (`@shikijs/langs`) or a repo path
 * (`src/theme/docpilot/session.ts`). The first group whose test matches wins, so
 * the order is the policy: `optionalFeatures` sits before `panelRuntime` and
 * carves the switchable modules out of it.
 */

/**
 * The `src/theme/docpilot/` modules a site can turn off, or that only one
 * runtime needs (ui-specs/009 rule 11: every reader-visible action can be
 * removed by the project that mounts the panel). A path ending in `/` is a
 * directory. Phase 8 sizes the lazy-loadable features from this list, so add a
 * module here when it becomes switchable and not before.
 *
 *   scope, history, prompt-store   scope picker, saved threads, reader instruction
 *   tools                          site-defined tools (engine-spec 038)
 *   openers, social, credentials   answers settled before the gate or the model
 *   feedback                       votes and reports
 *   selection                      the "Ask AI" selection watcher behind quote
 *   highlight, highlighters/       the code highlighter seam (Shiki's weight is
 *                                  counted under `shiki`, not here)
 *   budget                         the free-tier request counter
 *   remote                         the server-runtime half of a turn
 */
export const OPTIONAL_FEATURES = [
  'src/theme/docpilot/scope.ts',
  'src/theme/docpilot/history.ts',
  'src/theme/docpilot/prompt-store.ts',
  'src/theme/docpilot/tools.ts',
  'src/theme/docpilot/openers.ts',
  'src/theme/docpilot/social.ts',
  'src/theme/docpilot/credentials.ts',
  'src/theme/docpilot/feedback.ts',
  'src/theme/docpilot/selection.ts',
  'src/theme/docpilot/highlight.ts',
  'src/theme/docpilot/highlighters/',
  'src/theme/docpilot/budget.ts',
  'src/theme/docpilot/remote.ts',
]

const isOptionalFeature = (id) => OPTIONAL_FEATURES.some((f) => (f.endsWith('/') ? id.startsWith(f) : id === f))

/** Shiki and everything it pulls in: the grammar and theme packs, the regex engines, the HTML serialiser. */
const SHIKI =
  /^(@shikijs\/|shiki$|vscode-textmate$|oniguruma-|regex(-recursion|-utilities)?$|hast-util-|property-information$|stringify-entities$|character-entities|zwitch$|ccount$|html-void-elements$|comma-separated-tokens$|space-separated-tokens$)/
/** markdown-it and its closure. `entities` is markdown-it's, not Shiki's (Shiki's are `character-entities-*`). */
const MARKDOWN_IT = /^(markdown-it$|linkify-it$|uc\.micro$|mdurl$|punycode\.js$|entities$|argparse$)/

/** Every key `groups` has, in report order. */
export const GROUP_KEYS = [
  'vue',
  'shiki',
  'markdownIt',
  'minisearch',
  'panelRuntime',
  'panelComponents',
  'optionalFeatures',
  'other',
  'unmapped',
]

export const GROUPS = [
  ['vue', (id) => /^(@vue\/|vue$)/.test(id)],
  ['shiki', (id) => SHIKI.test(id)],
  ['markdownIt', (id) => MARKDOWN_IT.test(id)],
  ['minisearch', (id) => id === 'minisearch'],
  ['optionalFeatures', isOptionalFeature],
  ['panelRuntime', (id) => id.startsWith('src/theme/docpilot/')],
  ['panelComponents', (id) => id.startsWith('src/theme/components/')],
  ['other', () => true],
]

export const groupOf = (id) => (id === UNMAPPED ? 'unmapped' : GROUPS.find(([, test]) => test(id))[0])

/** Builds the IIFE in memory with the publish options plus a source map. */
export async function buildIife() {
  const output = await runBuild({ formats: ['iife'], sourcemap: true })
  const chunk = output.find((f) => f.type === 'chunk' && f.fileName === 'docpilot.web.js')
  const mapFile = output.find((f) => f.fileName === 'docpilot.web.js.map')
  if (!chunk || !mapFile) throw new Error('the in-memory build produced no IIFE chunk or no source map')
  // A `//# sourceMappingURL=` trailer is not in the published file.
  const code = chunk.code.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, '')
  return { code, map: JSON.parse(String(mapFile.source ?? mapFile.code)) }
}

/**
 * The ES entry and its lazy chunks, in memory, as the publish build writes them.
 * (Compared with dist/ on 2026-10-30 they were byte-equal; the report does not
 * depend on that, it states what it built.)
 */
export async function buildEsm() {
  const output = await runBuild({ formats: ['es'], sourcemap: false })
  return output
    .filter((f) => f.type === 'chunk')
    .map((f) => ({ file: f.fileName, code: f.code }))
}

async function runBuild({ formats, sourcemap }) {
  const { build } = await import('vite')
  const vue = (await import('@vitejs/plugin-vue')).default
  const { webBuildOptions } = await import('../bin/web-build-config.js')
  const output = await build(
    webBuildOptions({ root: ROOT, outDir: path.join(ROOT, 'dist'), vue, formats, write: false, sourcemap }),
  )
  return [].concat(output).flatMap((o) => o.output || [])
}

const sizes = (text) => {
  const buf = Buffer.from(text)
  return {
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  }
}

const share = (bytes, total) => Math.round((bytes / total) * 10000) / 10000

/** How many repo files `files` lists. */
const TOP_FILES = 15

/**
 * The report object for one IIFE build. Pure: it reads nothing from disk except
 * through the `meta` it is given, and it carries no timestamp.
 *
 * @param {{ code: string, map: object, esm?: Array<{file: string, code: string}>, meta?: object }} output
 */
export function reportFor({ code, map, esm = [], meta = {} }) {
  const total = Buffer.byteLength(code)
  const byContributor = new Map()
  for (const [source, n] of attribute(code, map)) {
    const id = contributorOf(source)
    byContributor.set(id, (byContributor.get(id) || 0) + n)
  }
  const groups = Object.fromEntries(GROUP_KEYS.map((k) => [k, 0]))
  const contributors = []
  for (const [id, bytes] of byContributor) {
    const group = groupOf(id)
    groups[group] += bytes
    if (id !== UNMAPPED) contributors.push({ id, group, bytes, share: share(bytes, total) })
  }
  contributors.sort((a, b) => b.bytes - a.bytes || (a.id < b.id ? -1 : 1))
  const files = contributors
    .filter((c) => c.id.startsWith('src/theme/'))
    .slice(0, TOP_FILES)
    .map(({ id, group, bytes, share }) => ({ id, group, bytes, share }))
  const lazy = [...esm].sort((a, b) => {
    const entry = (f) => (f === 'docpilot.web.mjs' ? 0 : 1)
    return entry(a.file) - entry(b.file) || (a.file < b.file ? -1 : 1)
  })
  return {
    schema: 1,
    builtFrom: meta.builtFrom ?? { package: null, commit: null },
    file: 'dist/docpilot.web.js',
    totals: sizes(code),
    groups,
    contributors,
    files,
    esm: lazy.map(({ file, code: text }) => ({ file, ...sizes(text) })),
  }
}

const kb = (n) => (n / 1024).toFixed(1).padStart(9)

function print(report) {
  const { totals, groups } = report
  console.log(`${report.file}  raw ${totals.raw}  gzip ${totals.gzip}  brotli ${totals.brotli}\n`)
  console.log('group'.padEnd(18), '     bytes', '      KB', '  share')
  for (const key of GROUP_KEYS) {
    const n = groups[key]
    console.log(key.padEnd(18), String(n).padStart(10), kb(n), `${((n / totals.raw) * 100).toFixed(1).padStart(5)}%`)
  }
  console.log('\n' + 'contributor'.padEnd(44), '     bytes', '      KB', '  share')
  for (const c of report.contributors.slice(0, 25)) {
    console.log(c.id.padEnd(44), String(c.bytes).padStart(10), kb(c.bytes), `${(c.share * 100).toFixed(1).padStart(5)}%`)
  }
  console.log('\nES entry and lazy chunks')
  for (const e of report.esm) {
    console.log(e.file.padEnd(44), String(e.raw).padStart(10), String(e.gzip).padStart(10), String(e.brotli).padStart(10))
  }
}

/** package version and short HEAD, or null where git is not there. */
function builtFrom() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  let commit = null
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    /* not a git checkout */
  }
  return { package: pkg, commit }
}

async function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='))
  const [iife, esm] = [await buildIife(), await buildEsm()]
  const report = reportFor({ ...iife, esm, meta: { builtFrom: builtFrom() } })
  const attributed = Object.values(report.groups).reduce((a, b) => a + b, 0)
  if (attributed !== report.totals.raw) {
    console.error(`[bundle-report] attribution (${attributed}) does not sum to the output length (${report.totals.raw})`)
    process.exit(1)
  }
  print(report)
  if (outArg) {
    const file = path.resolve(outArg.slice('--out='.length))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
    console.log(`\nwrote ${path.relative(process.cwd(), file) || file}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.stack || e)
    process.exit(1)
  })
}
