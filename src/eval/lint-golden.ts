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
 *
 * `level` is checked here and nowhere else. `filterByLevel` deliberately lets a
 * record with an unrecognised tier fall into every pool rather than delete it
 * from a run, so a typo costs nothing at eval time and would never be noticed —
 * this is the one place that says the word out loud.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT, RAG, GOLDEN } from '../cli-context.js'
import { underPath } from './metrics.js'
import { LEVELS, DEFAULT_RECORD_LEVEL, levelRank, levelHistogram } from './levels.js'
import { entryFlagError, flagValue } from '../cli-flags.js'
import { printError, FAILED, USAGE } from '../cli-exit.js'

/**
 * THE FLAGS, read by the table that already validated them.
 *
 * There is no parser here any more. `flagValue` and `flagGiven` are exported by
 * `src/cli-flags.js`, they read the grammar out of the same `COMMANDS` entry
 * `flagErrors` checks, and until this change their only importer in the whole
 * package was the test file. Seven hand-written copies read the flags instead,
 * and they had drifted the way copies drift: one truncated a value at its first
 * `=`, one returned `''` where it had been given a default, and one returned
 * `true` where it had been given a path.
 */
const FLAGS = process.argv.slice(2)
const arg = (name: string, dflt?: string) => flagValue('lint', FLAGS, name) ?? dflt

const FILE = arg('file') ? path.resolve(ROOT, arg('file')) : GOLDEN

/**
 * EVERY FLAG THIS COMMAND TAKES, CHECKED FIRST — before a config is read, before
 * `.env.local` is loaded, and long before anything is embedded. See
 * `src/cli-flags.js` for what it rejects and why each kind of rejection exists.
 */
const BAD_FLAG = entryFlagError('lint', import.meta.url)
if (BAD_FLAG) {
  printError(BAD_FLAG)
  process.exit(USAGE)
}

/** The band `CORE`'s "under 200 words" actually yields. */
const MIN_WORDS = 90
const MAX_WORDS = 160

const EXPECTED = new Set([
  'answer',
  'refuse:no-evidence',
  'refuse:out-of-scope',
])

/**
 * Every rule that is a statement about the RECORDS rather than about the files
 * they arrived in, so the suite can exercise it without an index on disk.
 *
 * The error/warning split is not severity, it is whether the set still MEASURES
 * anything. A `gold_chunks` entry naming a renamed page scores a flat 0 that
 * reads as a retrieval regression — nothing downstream can tell that apart from
 * a real one, so it is an error. A gold answer twenty words short skews one
 * metric and the report says by how much, so it is a warning.
 *
 * @param {Array<object>} records
 * @param {{ids: Set<string>, pages: Set<string>, indexHash: string}} index
 * @returns {{errors: string[], warnings: string[]}}
 */
export function lintRecords(records, { ids, pages, indexHash }) {
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
      err(id, 'expect "refuse:not-answerable" is observed-only — author refuse:no-evidence or refuse:out-of-scope')
    }

    // Absent is legal and stays legal. `high` is DEFINED as roughly the set that
    // already exists, so a file written before tiers existed scores the same
    // number under `--level=high` as under no flag at all — warning it into
    // existence one record at a time is the whole migration.
    if (r.level == null) {
      warn(id, `no level — runs as "${DEFAULT_RECORD_LEVEL}"`)
    } else if (levelRank(r.level) < 0) {
      err(id, `level "${r.level}" is not one of ${LEVELS.join(' | ')}`)
    }

    const positive = r.expect === 'answer'

    for (const g of r.gold_chunks || []) {
      const isId = ids.has(g)
      const isPage = pages.has(`/${g}`) || pages.has(g)
      const prefixes = [...ids].some((i) => underPath(i, g))
      if (!isId && !isPage && !prefixes) {
        err(id, `gold_chunks entry "${g}" matches nothing in index ${indexHash} — repoint it, or rebuild with npx docpilot index`)
      } else if (!isId && !isPage) {
        warn(id, `gold_chunks entry "${g}" matches only by prefix — anchor it to a chunk id`)
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
        warn(id, 'gold_answer on a negative record is never scored — drop it')
      }
    }

    if (r.scope && r.expect === 'refuse:out-of-scope') {
      const inScope = (r.gold_chunks || []).some((g) =>
        (r.scope.paths || []).some((p) => underPath(`/${g}`, p)),
      )
      if (inScope) err(id, 'refuse:out-of-scope record has gold chunks INSIDE its scope')
    }
  }

  return { errors, warnings }
}

/**
 * `low 10 (+10) · medium 25 (+15) · high 60 (+35) · ultra 60`
 *
 * The bare number is the POOL — what `--level=medium` actually scores — because
 * that is the number the run header prints and the only one two reports may be
 * compared on. `(+n)` is what the tier itself contributed, which is the number
 * an author needs when deciding where the next twenty questions belong.
 *
 * A tier that contributes nothing is dropped, or a set authored at three tiers
 * prints six columns of which three repeat the number to their left. `ultra`
 * survives that rule whatever it contributes: it is the size of a run with no
 * `--level` at all, and leaving it out would hide the total.
 */
export function levelSummary(records) {
  const { levels, unknown } = levelHistogram(records)
  const parts = levels
    .filter((row, i) => row.count > 0 || i === LEVELS.length - 1)
    .map((row) => `${row.level} ${row.cumulative}${row.count ? ` (+${row.count})` : ''}`)
  // Said apart because these sit in EVERY pool, the smallest one included, and
  // are therefore already inside each cumulative above without belonging to any
  // tier of their own. Each one is also an error a few lines up.
  if (unknown) parts.push(`unknown ${unknown}`)
  return parts.join(' · ')
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
  const chunks = manifest.shards.flatMap((s) =>
    JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')),
  )
  const ids = new Set(chunks.map((c) => c.id))
  const pages = new Set(manifest.pages.map((p) => p.path))

  // A project that has not run `init` has no golden set, and the bare ENOENT
  // this used to throw named a path the author never chose and no next step.
  if (!fs.existsSync(FILE)) {
    fail(`no golden set at ${path.relative(ROOT, FILE)} — run \`npx docpilot init\` to scaffold one`)
  }

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

  const { errors, warnings } = lintRecords(records, { ids, pages, indexHash: manifest.hash })

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
  console.log(`  by level         ${levelSummary(records)}`)

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
  printError(m)
  process.exit(FAILED)
}

// Guarded the way build-rag-index.js and calibrate.js are: `lintRecords` is a
// pure function of the records and the suite imports it, and an unguarded
// `main()` would read a manifest that is not there and exit(1) mid-test-run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `lint` and `bench` were the two commands that caught nothing at all, so a
  // missing manifest or an unreadable golden set left the process as an
  // unhandled rejection: node's own banner, this package's stack, and no
  // sentence naming the file.
  try {
    main()
  } catch (e) {
    printError(e.message || String(e), e)
    process.exit(FAILED)
  }
}
