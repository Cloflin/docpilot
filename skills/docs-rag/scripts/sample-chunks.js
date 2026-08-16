#!/usr/bin/env node
/**
 * Stratified chunk sampling for `docs-rag generate` — RAG-SPEC 7.
 *
 *   node .claude/skills/docs-rag/scripts/sample-chunks.js [--per-section=3] [--seed=1] \
 *     [--rag=docs/public/rag]
 *
 * Prints compact candidates — id, breadcrumb, title, a text head — so the
 * authoring pass can read a representative slice of the corpus without loading
 * 1191 chunks.
 *
 * The stratification is the whole point. Documentation is never evenly sized:
 * on the corpus this was developed against, one section held 916 of 1191
 * chunks, so sampling proportionally to chunk mass would have made 77% of the
 * golden set questions about that one section — an eval that measures a corner
 * of the docs and calls itself an eval of the docs. Sampling per SECTION
 * instead of per chunk gives every registered section a voice, which is also
 * what the scope picker exposes to a reader.
 *
 * Deterministic: same corpus and seed produce the same sample, so a regenerated
 * golden set is reviewable as a diff rather than as a new file.
 */

import fs from 'node:fs'
import path from 'node:path'

// Run from the project root. The index directory is `docPilot.indexDir`, which
// defaults to `<docsDir>/public/rag` — pass `--rag=` when it was moved.
const ROOT = process.cwd()
const ragArg = process.argv.find((a) => a.startsWith('--rag='))
const RAG = path.resolve(ROOT, ragArg ? ragArg.split('=')[1] : 'docs/public/rag')

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : dflt
}

const PER_SECTION = Number(arg('per-section', '3'))
const SEED = Number(arg('seed', '1'))
const HEAD = Number(arg('head', '180'))
/** A chunk under this many content terms cannot ground a question. */
const MIN_TERMS = 40

/** Deterministic PRNG — Math.random would make the sample unreviewable. */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

function load() {
  const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
  const chunks = manifest.shards.flatMap((s) =>
    JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')),
  )
  return { manifest, chunks }
}

const terms = (t) => String(t).split(/\W+/).filter((w) => w.length > 2).length

function main() {
  const { manifest, chunks } = load()
  const rand = rng(SEED)

  const pageByPath = new Map(manifest.pages.map((p) => [p.path, p]))
  const byPath = new Map()
  for (const c of chunks) {
    if (terms(c.text) < MIN_TERMS) continue
    if (!byPath.has(c.path)) byPath.set(c.path, [])
    byPath.get(c.path).push(c)
  }

  const picked = []
  const seenPages = new Set()

  for (const section of manifest.sections) {
    const paths = section.pageIdx.map((i) => manifest.pages[i]?.path).filter(Boolean)
    const pool = paths.flatMap((p) => byPath.get(p) || [])
    if (!pool.length) continue

    // Prefer a page the sample has not touched yet: one question per page
    // teaches more than three questions about one page.
    const shuffled = [...pool].sort(() => rand() - 0.5)
    const fresh = shuffled.filter((c) => !seenPages.has(c.path))
    const take = (fresh.length ? fresh : shuffled).slice(0, PER_SECTION)
    for (const c of take) {
      seenPages.add(c.path)
      picked.push({ section: section.label, chunk: c })
    }
  }

  console.log(
    `# ${picked.length} candidates from ${manifest.sections.length} sections ` +
      `(index ${manifest.hash}, seed ${SEED}, ${PER_SECTION}/section)\n`,
  )
  let current = null
  for (const { section, chunk: c } of picked) {
    if (section !== current) {
      current = section
      console.log(`\n## ${section}`)
    }
    const page = pageByPath.get(c.path)
    const head = c.text.replace(/\s+/g, ' ').slice(0, HEAD)
    console.log(`- ${c.id}`)
    console.log(`  kind=${c.kind} page=${page?.title || '?'}`)
    console.log(`  ${head}…`)
  }
}

main()
