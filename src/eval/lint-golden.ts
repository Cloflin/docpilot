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
import { priorQuestions, chainDepth, isFollowUp } from './record.js'
import { entryFlagError, flagValue, flagGiven } from '../cli-flags.js'
import { applyFileEnv } from '../cli-env.js'
import { printError, FAILED, USAGE } from '../cli-exit.js'

/**
 * `.env.local`, as a SECOND belt.
 *
 * The launcher applies it before it dispatches (spec 010), so under
 * `npx docpilot …` this is a no-op — every key it would add is already set.
 * It is here for the other caller: `node dist/eval/…` run directly, which is
 * how this module is driven in a shard and in a script. A command that reads
 * the file under the launcher and not under `node` is the same divergence one
 * level down.
 */
await applyFileEnv()

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
 * `--json` — the whole of stdout is one object.
 *
 * Same contract as `doctor --json`: the counts and the two lists a script wants
 * to act on, the exit code unchanged, and every human line silenced rather than
 * interleaved. The prose form stays the default because it is what a person
 * reads while editing the golden set.
 */
const JSON_OUT = flagGiven('lint', FLAGS, 'json')
const say = (m) => {
  if (!JSON_OUT) console.log(m)
}

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

    /**
     * THE CONVERSATION, which `priorQuestions` deliberately hands over unrepaired.
     *
     * Two spellings, and the accessor arbitrates by returning `prev_questions`
     * whenever it is present. That is the right thing for a pure accessor and the
     * wrong thing to leave unsaid: a record carrying both fields states two
     * different conversations, one of them is scored and the other is not, and
     * nothing downstream reports the discrepancy — the run's rows say `depth: 2`
     * and the author reads them as the chain they wrote in the field that lost.
     * Hence an error and not a warning: the set still produces numbers, and the
     * numbers are for a question nobody asked. `prev_question` ALONE stays legal
     * forever — every golden file and probe file in the wild carries it and must
     * score identically after chains existed. This rule is about AUTHORING BOTH,
     * never about the legacy spelling.
     */
    if (r.prev_questions != null && r.prev_question != null) {
      err(id, 'both prev_questions and prev_question are authored — priorQuestions returns prev_questions, so the conversation in prev_question is never asked; drop one')
    }
    if (r.prev_questions != null && !Array.isArray(r.prev_questions)) {
      err(id, `prev_questions is ${typeof r.prev_questions}, not an array — a chain is the prior questions in order, oldest first`)
    }
    /**
     * A BLANK PRIOR IS NOT A SHORTER CHAIN, which is the whole reason
     * `priorQuestions` passes one through: `composeQuery(question, '')` returns
     * null (gate.js:209 — `previousQuestion ?` on a falsy string), so the record
     * runs with no composed channel at all while every row it produces still
     * reads as a follow-up of this depth. Repaired silently by the accessor it
     * would be a first turn wearing a follow-up's label; named here it is one
     * edit. The position is in the message because a chain of four reports
     * nothing an author can act on otherwise.
     */
    priorQuestions(r).forEach((q, i) => {
      if (typeof q === 'string' && q.trim()) return
      const field = Array.isArray(r.prev_questions) ? `prev_questions[${i}]` : 'prev_question'
      err(id, `${field} is not a question: ${String(JSON.stringify(q))} — every prior is asked verbatim, and a blank one composes to no query while the record still reports as a follow-up`)
    })
    /**
     * FOUR IS WHERE THE PROMPT CHANGES SHAPE, and it is a warning because that is
     * a reason to author one rather than a defect. `buildMessages`
     * (src/theme/docpilot/prompt.js:784) filters history to the pairs that
     * actually answered, then splits it `answered.slice(-3)` / `answered.slice(0,
     * -3)`: the last three go out as verbatim user/assistant pairs and anything
     * older is collapsed into a single user line, "Earlier in this session the
     * reader asked about: <q>; <q>". With three priors `older` is empty and that
     * line does not exist. The fourth pair is the first to render it, and no eval
     * has ever reached it.
     */
    const depth = chainDepth(r)
    if (depth >= 4) {
      warn(id, `chain of ${depth} — from the 4th pair buildMessages keeps only the last three verbatim and condenses the rest into one "Earlier in this session the reader asked about:" line`)
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
  /**
   * A project with no index yet, named as such.
   *
   * The catch added in spec 010 turned this from an unhandled rejection into
   * one line — but the line was the raw `ENOENT`, which names a path the reader
   * never chose and no next step. The rule this file already states about an
   * unreachable endpoint holds here too: produce a command, not an error.
   */
  const manifestPath = path.join(RAG, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    fail(
      `no index at ${path.relative(ROOT, RAG)} — lint measures the golden set against ` +
        `the index it names.\n        Build one:  npx docpilot index`,
    )
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
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
  // `records.filter((r) => r.prev_question)` counted the legacy field and nothing
  // else, so a set authored entirely with `prev_questions` reported zero
  // follow-ups here and in `--json` while every one of its records is one.
  const followUps = records.filter(isFollowUp).length
  const byKind = {}
  for (const r of records) byKind[r.kind || '?'] = (byKind[r.kind || '?'] || 0) + 1
  /**
   * The histogram, because the count above cannot distinguish the two things an
   * author most wants distinguished. Eight follow-ups is eight one-hop records
   * and eight two-hop chains alike, and the second antecedent is only exercised
   * by the latter — a set believed to hold chains and holding none reports the
   * pre-023 behaviour under the new records' names, and the eval that would have
   * shown it costs a run. This is the one place that is readable before spending
   * one.
   */
  const byDepth = {}
  for (const r of records) byDepth[chainDepth(r)] = (byDepth[chainDepth(r)] || 0) + 1

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          file: path.relative(ROOT, FILE),
          indexHash: manifest.hash,
          records: records.length,
          positives,
          negatives,
          scoped,
          followUps,
          byDepth,
          byKind,
          byLevel: levelSummary(records),
          warnings,
          errors,
          ok: errors.length === 0,
        },
        null,
        2,
      ),
    )
    // The object is the report; the sentence explaining the code still goes to
    // stderr, and the code is the same one the prose form returns.
    if (errors.length) {
      fail(`${errors.length} error(s) — the golden set does not match the index`)
    }
    return
  }

  say(`\ngolden lint — ${path.relative(ROOT, FILE)} against index ${manifest.hash}\n`)
  say(`  records          ${records.length}`)
  say(`  positives / neg  ${positives} / ${negatives}`)
  say(`  scoped           ${scoped}`)
  say(`  follow-up        ${followUps}`)
  say(`  by depth         ${JSON.stringify(byDepth)}`)
  say(`  by kind          ${JSON.stringify(byKind)}`)
  say(`  by level         ${levelSummary(records)}`)

  if (warnings.length) {
    say(`\n  ${warnings.length} warning(s):`)
    for (const w of warnings) say(`    ~ ${w}`)
  }
  if (errors.length) {
    say(`\n  ${errors.length} error(s):`)
    for (const e of errors) say(`    ! ${e}`)
    fail(`${errors.length} error(s) — the golden set does not match the index`)
  }
  say('\n  ok\n')
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
