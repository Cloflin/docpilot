#!/usr/bin/env node
/**
 * Rewrites every printed index figure to match docs/public/rag/manifest.json.
 *
 * The claims below are a verbatim copy of the `claims` table in
 * test/docs-links.test.js ("docs — the printed index figures match the
 * committed index"). Each template is turned into a regex whose numeric parts
 * are wildcards, so the OLD values do not have to be known: whatever number is
 * printed today is replaced by the number derived from the manifest today.
 *
 * Run AFTER `npx docpilot index`, then re-run the test suite.
 *
 *   node refresh-figures.mjs [--check]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const RAG = path.join(ROOT, 'docs', 'public', 'rag')
const MANIFEST = path.join(RAG, 'manifest.json')
const CHECK = process.argv.includes('--check')

const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const vectors = path.join(RAG, m.vectors ?? '')
const bytes = fs.statSync(vectors).size

if (m.quant !== 'binary' || bytes !== m.chunkCount * Math.ceil(m.dims / 8)) {
  console.error(
    `blob is not one bit per dimension: ${bytes} bytes vs ${m.chunkCount} × ${m.dims} / 8 = ${m.chunkCount * Math.ceil(m.dims / 8)}.\n` +
      `The figure templates assume a 1-bit index (engine-spec 027, src/build/lib/quantize.js).\n` +
      `They need rewriting, not re-running.`,
  )
  process.exit(1)
}

const n = m.chunkCount
const dims = m.dims
const kb = `${Math.round(bytes / 1024)} KB`
const int8 = `${((n * dims) / 1024 / 1024).toFixed(1)} MB`
const mb = `${((n * dims * 4) / 1024 / 1024).toFixed(1)} MB`
const grouped = bytes.toLocaleString('en-US')

// [file, target text, regex matching the same sentence with any figures in it]
const NUM = String.raw`[\d,]+`
const SIZE = String.raw`[\d.,]+\s*(?:KB|MB|GB)`

const claims = [
  [
    'docs/introduction.md',
    `${kb} for ${n} chunks at ${dims} dimensions`,
    new RegExp(`${SIZE} for ${NUM} chunks at ${NUM} dimensions`, 'g'),
  ],
  [
    'docs/guide/comparison.md',
    `${kb} for this site's ${n} chunks at ${dims} dimensions`,
    new RegExp(`${SIZE} for this site(?:'|’)s ${NUM} chunks at ${NUM} dimensions`, 'g'),
  ],
  [
    'docs/guide/comparison.md',
    `${n} chunks, ${dims} dimensions`,
    new RegExp(`${NUM} chunks, ${NUM} dimensions`, 'g'),
  ],
  [
    'docs/guide/comparison.md',
    `${kb} of 1-bit vectors`,
    new RegExp(`${SIZE} of 1-bit vectors`, 'g'),
  ],
  [
    'docs/guide/indexing.md',
    `indexes ${n} chunks at ${dims} dimensions`,
    new RegExp(`indexes ${NUM} chunks at ${NUM} dimensions`, 'g'),
  ],
  [
    'docs/guide/indexing.md',
    `${grouped} bytes — ${kb}, where int8 would have been ${int8} and float32 ${mb}`,
    new RegExp(`${NUM} bytes — ${SIZE}, where int8 would have been ${SIZE} and float32 ${SIZE}`, 'g'),
  ],
  [
    'README.md',
    `${kb} for this project's own ${n}-chunk index, where int8 would be ${int8} and float32 ${mb}`,
    new RegExp(`${SIZE} for this project(?:'|’)s own ${NUM}-chunk index, where int8 would be ${SIZE} and float32 ${SIZE}`, 'g'),
  ],
  [
    'README.md',
    `${kb} for this site's ${n} chunks`,
    new RegExp(`${SIZE} for this site(?:'|’)s ${NUM} chunks`, 'g'),
  ],
  // The cost page states the same blob from the site owner's side. Registered
  // here rather than left as prose because it is the one figure on that page a
  // reader is invited to multiply by their own corpus size, and a stale one
  // would understate the only cost that scales with the corpus rather than with
  // the traffic.
  [
    'docs/guide/what-it-costs.md',
    `${kb} for this site's ${n} chunks at ${dims} dimensions`,
    new RegExp(`${SIZE} for this site(?:'|’)s ${NUM} chunks at ${NUM} dimensions`, 'g'),
  ],
  [
    'docs/guide/what-it-costs.md',
    `at \`float32\` the same blob would be ${mb}`,
    new RegExp(String.raw`at \`float32\` the same blob would be ${SIZE}`, 'g'),
  ],
]

const byFile = new Map()
for (const [file, target, re] of claims) {
  if (!byFile.has(file)) byFile.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

let changed = 0
let unmatched = []
const out = new Map()

for (const [file] of byFile) out.set(file, byFile.get(file))

for (const [file, target, re] of claims) {
  const src = out.get(file)
  if (src.includes(target)) continue // already current
  re.lastIndex = 0
  if (!re.test(src)) {
    unmatched.push(`${file}: no sentence matching /${re.source}/ — expected to write "${target}"`)
    continue
  }
  re.lastIndex = 0
  out.set(file, src.replace(re, target))
  changed++
  console.log(`${file}\n  → ${target}`)
}

if (unmatched.length) {
  console.error('\nUNMATCHED — these need a hand edit:\n' + unmatched.map((u) => '  ' + u).join('\n'))
}

if (!changed) {
  console.log(`\nall ${claims.length} figures already current (${n} chunks, ${dims} dims, ${grouped} bytes)`)
} else if (!CHECK) {
  for (const [file, src] of out) fs.writeFileSync(path.join(ROOT, file), src)
  console.log(`\nwrote ${out.size} files, ${changed}/${claims.length} claims updated`)
} else {
  console.log(`\n--check: ${changed} claims would change, nothing written`)
}

process.exit(unmatched.length ? 1 : 0)
