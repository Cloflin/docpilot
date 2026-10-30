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
 *   node scripts/bundle-report.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

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

/** Builds the IIFE in memory with the publish options plus a source map. */
export async function buildIife() {
  const { build } = await import('vite')
  const vue = (await import('@vitejs/plugin-vue')).default
  const { webBuildOptions } = await import('../bin/web-build-config.js')
  const output = await build(
    webBuildOptions({
      root: ROOT,
      outDir: path.join(ROOT, 'dist'),
      vue,
      formats: ['iife'],
      write: false,
      sourcemap: true,
    }),
  )
  const files = [].concat(output).flatMap((o) => o.output || [])
  const chunk = files.find((f) => f.type === 'chunk' && f.fileName === 'docpilot.web.js')
  const mapFile = files.find((f) => f.fileName === 'docpilot.web.js.map')
  if (!chunk || !mapFile) throw new Error('the in-memory build produced no IIFE chunk or no source map')
  // A `//# sourceMappingURL=` trailer is not in the published file.
  const code = chunk.code.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, '')
  return { code, map: JSON.parse(String(mapFile.source ?? mapFile.code)) }
}

const kb = (n) => (n / 1024).toFixed(1).padStart(9)

async function main() {
  const { code, map } = await buildIife()
  const total = Buffer.byteLength(code)
  const bySource = attribute(code, map)
  const byContributor = new Map()
  for (const [source, n] of bySource) {
    const id = contributorOf(source)
    byContributor.set(id, (byContributor.get(id) || 0) + n)
  }
  const rows = [...byContributor].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  console.log('contributor'.padEnd(44), '     bytes', '      KB', '  share')
  for (const [id, n] of rows.slice(0, 25)) {
    console.log(id.padEnd(44), String(n).padStart(10), kb(n), `${((n / total) * 100).toFixed(1).padStart(5)}%`)
  }
  const sum = rows.reduce((a, [, n]) => a + n, 0)
  console.log(`total ${total} bytes (attributed ${sum})`)
  if (sum !== total) {
    console.error('[bundle-report] attribution does not sum to the output length')
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.stack || e)
    process.exit(1)
  })
}
