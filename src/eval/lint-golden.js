#!/usr/bin/env node
/**
 * Golden-set lint — run before every eval.
 *
 *   npx docpilot lint [--file=<path to golden.jsonl>]
 *
 * A golden set that has drifted from the index measures nothing, and the way it
 * drifts is silent: `retrievalF1Loose` prefix-matches, so a `gold_chunks` entry
 * naming a page that was renamed simply never matches and the record reports a
 * flat 0 that reads as a retrieval regression. This turns that into an error
 * with the record's id on it.
 *
 * The length rule exists for a different reason. `tokenF1` computes
 * `P = overlap/|pred|`, so a 25-word gold answer against the ~150-word answer
 * the product actually writes caps F1 near 0.29 whatever the model says — the
 * measured 0.14 is mostly that ceiling, not a quality signal. A gold answer has
 * to be written at the length the product produces, or the metric measures
 * length.
 */

import fs from 'node:fs'
import path from 'node:path'

import { ROOT, RAG, GOLDEN } from '../cli-context.js'

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : dflt
}

const FILE = arg('file') ? path.resolve(ROOT, arg('file')) : GOLDEN

/** The band `CORE`'s "under 200 words" actually yields. */
const MIN_WORDS = 90
const MAX_WORDS = 160

const EXPECTED = new Set([
  'answer',
  'refuse:no-evidence',
  'refuse:out-of-scope',
])

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
  const chunks = manifest.shards.flatMap((s) =>
    JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')),
  )
  const ids = new Set(chunks.map((c) => c.id))
  const pages = new Set(manifest.pages.map((p) => p.path))

  const records = fs
    .readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        fail(`line ${i + 1} is not JSON: ${e.message}`)
      }
    })

  const errors = []
  const warnings = []
  const seen = new Set()
  const err = (id, m) => errors.push(`${id}: ${m}`)
  const warn = (id, m) => warnings.push(`${id}: ${m}`)

  for (const r of records) {
    const id = r.id || '(no id)'
    if (seen.has(id)) err(id, 'duplicate id')
    seen.add(id)

    if (!r.question?.trim()) err(id, 'empty question')
    if (!EXPECTED.has(r.expect)) {
      err(id, `expect "${r.expect}" is not one of ${[...EXPECTED].join(' | ')}`)
    }

    // `refuse:not-answerable` is an OBSERVED outcome, never an authored one: it
    // depends on what the model did, so the same record would flip between rows
    // of a matrix and the set would grade the model against itself.
    if (r.expect === 'refuse:not-answerable') {
      err(id, 'refuse:not-answerable is observed-only and may not be authored')
    }

    const positive = r.expect === 'answer'

    for (const g of r.gold_chunks || []) {
      const isId = ids.has(g)
      const isPage = pages.has(`/${g}`) || pages.has(g)
      const prefixes = [...ids].some((i) => i.startsWith(g))
      if (!isId && !isPage && !prefixes) {
        err(id, `gold_chunks entry "${g}" matches nothing in index ${manifest.hash}`)
      } else if (!isId && !isPage) {
        warn(id, `gold_chunks entry "${g}" matches only by prefix — anchor it`)
      }
    }

    if (positive) {
      if (!r.gold_chunks?.length) err(id, 'positive record has no gold_chunks')
      const words = String(r.gold_answer || '').trim().split(/\s+/).filter(Boolean).length
      if (!words) {
        err(id, 'positive record has no gold_answer')
      } else if (words < MIN_WORDS || words > MAX_WORDS) {
        warn(id, `gold_answer is ${words} words, outside ${MIN_WORDS}–${MAX_WORDS}`)
      }
      for (const ident of r.identifiers || []) {
        if (!String(r.gold_answer || '').includes(ident)) {
          err(id, `identifier "${ident}" is absent from its own gold_answer`)
        }
      }
    } else {
      if (r.gold_chunks?.length && r.expect === 'refuse:no-evidence') {
        err(id, 'refuse:no-evidence record carries gold_chunks')
      }
      if (String(r.gold_answer || '').trim()) {
        warn(id, 'negative record carries a gold_answer; it is never scored')
      }
    }

    if (r.scope && r.expect === 'refuse:out-of-scope') {
      const inScope = (r.gold_chunks || []).some((g) =>
        (r.scope.paths || []).some((p) => `/${g}`.startsWith(p)),
      )
      if (inScope) err(id, 'refuse:out-of-scope record has gold chunks INSIDE its scope')
    }
  }

  const positives = records.filter((r) => r.expect === 'answer').length
  const negatives = records.length - positives
  const scoped = records.filter((r) => r.scope).length
  const followUps = records.filter((r) => r.prev_question).length
  const byKind = {}
  for (const r of records) byKind[r.kind || '?'] = (byKind[r.kind || '?'] || 0) + 1

  console.log(`\ngolden lint — ${path.relative(ROOT, FILE)} against index ${manifest.hash}\n`)
  console.log(`  records          ${records.length}`)
  console.log(`  positives / neg  ${positives} / ${negatives}`)
  console.log(`  scoped           ${scoped}`)
  console.log(`  follow-up        ${followUps}`)
  console.log(`  by kind          ${JSON.stringify(byKind)}`)

  if (warnings.length) {
    console.log(`\n  ${warnings.length} warning(s):`)
    for (const w of warnings) console.log(`    ~ ${w}`)
  }
  if (errors.length) {
    console.log(`\n  ${errors.length} error(s):`)
    for (const e of errors) console.log(`    ! ${e}`)
    fail(`${errors.length} error(s) — the golden set does not match the index`)
  }
  console.log('\n  ok\n')
}

function fail(m) {
  console.error(`\n  FAIL  ${m}\n`)
  process.exit(1)
}

main()
