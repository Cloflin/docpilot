/**
 * `docpilot feedback <pull|report>` — the way back from your readers' votes to
 * the eval loop.
 *
 * THIS COMMAND IS OUTSIDE THE LOOP, and deliberately does not write into it.
 * `calibrate` reads a `stratum` — a judgement about what a question was FOR —
 * and `eval` reads a `gold_answer` somebody wrote. Neither can be derived from a
 * thumb. So `pull` produces CANDIDATES with a suggested stratum, the reasoning
 * for it, and `needsReview: true`; a person, or the `docs-rag` skill, promotes
 * them. Writing production questions straight into `calibration.jsonl` would let
 * a biased sample move a threshold that governs every reader.
 *
 * The IO half. Everything worth testing is in aggregate.js, stratum.js,
 * report.js and source.js, which touch nothing.
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {DOCPILOT_DIR, REPORTS} from '../cli-context.js'
import {aggregate, merge} from './aggregate.js'
import {parseRows, fetchRows, TOKEN_ENV} from './source.js'
import {renderReport} from './report.js'
import {clusterQuestions, against, renderFaqReport} from './faq.js'
import {resolveSuggestions} from '../theme/docpilot/switches.js'
import {openerQuestions} from '../theme/docpilot/openers.js'

const MODES = ['pull', 'report', 'faq']
const CANDIDATES = path.join(DOCPILOT_DIR, 'candidates.jsonl')

const USAGE = `
  docpilot feedback <mode> --from <source>

    pull      aggregate votes into ${path.basename(CANDIDATES)} for review
    report    write a markdown summary of what readers said
    faq       rank the questions readers ask, grouped the way the panel groups
              them, and propose a \`suggestions.questions\` block to paste

  --from <path|url>   a JSONL/JSON export of your own storage, or a GET endpoint
  --since <ISO>       passed through to a URL source as ?since=
  --max-pages <n>     stop after n pages of a paginated URL source (default 50)
  --out <path>        override the output path

  This package ships no database driver: the panel POSTs to an endpoint you run,
  into storage you chose, and you export from it. \`--from ./export.jsonl\` reads
  anything — including what \`window.__docPilot.exportFeedback()\` prints. A URL
  source sends \`Authorization: Bearer $${TOKEN_ENV}\` when that variable is set.
`

function parseArgs(argv): {
    mode: string | null
    from: string | null
    since: string | null
    maxPages: number
    out: string | null
    help: boolean
    /** Present only on the early return that names the offending flag. */
    unknown?: string
} {
  const args = {mode: null, from: null, since: null, maxPages: 50, out: null, help: false}
  const rest = [...argv]
  while (rest.length) {
    const a = rest.shift()
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--from') args.from = rest.shift()
    else if (a.startsWith('--from=')) args.from = a.slice(7)
    else if (a === '--since') args.since = rest.shift()
    else if (a.startsWith('--since=')) args.since = a.slice(8)
    else if (a === '--out') args.out = rest.shift()
    else if (a.startsWith('--out=')) args.out = a.slice(6)
    else if (a === '--max-pages') args.maxPages = Number(rest.shift())
    else if (a.startsWith('--max-pages=')) args.maxPages = Number(a.slice(12))
    else if (!args.mode && !a.startsWith('-')) args.mode = a
    else return {...args, unknown: a}
  }
  return args
}

const isUrl = (s) => /^https?:\/\//i.test(s || '')

function readCandidates(file) {
  if (!existsSync(file)) return []
  try {
    return parseRows(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`[docpilot] ${file} could not be read — ${e.message}`)
    return []
  }
}

/**
 * @param {object} o
 * @param {object} o.docPilot resolved settings
 * @param {string[]} o.argv everything after `feedback`
 * @param {Record<string, string|undefined>} [o.env]
 * @returns {Promise<number>} exit code
 */
export async function runFeedback({docPilot, argv = [], env = {}}) {
  const args = parseArgs(argv)

  if (args.help || !args.mode) {
    console.log(USAGE)
    return args.mode ? 0 : args.help ? 0 : 1
  }
  if (args.unknown) {
    console.error(`[docpilot] unknown option "${args.unknown}"\n${USAGE}`)
    return 1
  }
  if (!MODES.includes(args.mode)) {
    console.error(`[docpilot] unknown mode "${args.mode}". One of: ${MODES.join(', ')}`)
    return 1
  }
  if (!args.from) {
    console.error(
      `[docpilot] --from is required.\n\n` +
        `  Export what your endpoint collected, then point at it:\n` +
        `    npx docpilot feedback ${args.mode} --from ./export.jsonl\n\n` +
        `  Or read it back over HTTP, if you serve one:\n` +
        `    npx docpilot feedback ${args.mode} --from https://example.com/feedback\n`,
    )
    return 1
  }

  let rows
  try {
    if (isUrl(args.from)) {
      if (!env[TOKEN_ENV]) {
        console.warn(`[docpilot] ${TOKEN_ENV} is not set — the request goes out unauthenticated`)
      }
      console.log(`[docpilot] reading ${new URL(args.from).origin}${new URL(args.from).pathname}`)
      rows = await fetchRows({
        from: args.from,
        env,
        since: args.since,
        maxPages: args.maxPages,
        log: (m) => console.log(m),
      })
    } else {
      const file = path.resolve(args.from)
      if (!existsSync(file)) {
        console.error(`[docpilot] no such file: ${file}`)
        return 1
      }
      rows = parseRows(readFileSync(file, 'utf8'))
      console.log(`[docpilot] read ${rows.length} rows from ${path.relative(process.cwd(), file)}`)
    }
  } catch (e) {
    console.error(`[docpilot] could not read the feedback source — ${e.message}`)
    return 1
  }

  if (!rows.length) {
    console.error('[docpilot] the source is empty — nothing to aggregate')
    return 1
  }

  const candidates = aggregate(rows)
  const send = docPilot?.feedback?.send ?? 'both'

  /**
   * The openers a real reader population would have asked for.
   *
   * Grouped with the panel's own paraphrase scorer at this site's own
   * `matchTau`, so a cluster is exactly what one opener would catch at runtime
   * rather than a plausible-looking grouping the runtime then disagrees with.
   *
   * `df` is deliberately NOT loaded from the index here. The scorer weights by
   * term rarity and falls back to "unlisted means maximally rare", which over a
   * few dozen candidate questions is the conservative direction: it makes
   * clustering stricter, so a proposal is under-merged rather than over-merged,
   * and an author reads two rows instead of silently losing one. Reading the
   * index would also make this command fail on a project that has not built one,
   * for a report about questions rather than about chunks.
   */
  if (args.mode === 'faq') {
    const suggestions = resolveSuggestions(docPilot, () => {})
    const configured = openerQuestions(suggestions)
    const opts = {df: null, matchTau: suggestions.matchTau}
    const clusters = clusterQuestions(candidates, opts)
    const {rows, unasked} = against(clusters, configured, opts)
    const out = args.out ? path.resolve(args.out) : path.join(REPORTS, 'faq-latest.md')
    mkdirSync(path.dirname(out), {recursive: true})
    writeFileSync(
      out,
      renderFaqReport(rows, {
        configured,
        unasked,
        send,
        source: isUrl(args.from) ? new URL(args.from).origin : path.basename(args.from),
        generatedAt: new Date().toISOString(),
      }),
    )
    console.log(
      `[docpilot] ${path.relative(process.cwd(), out)} — ${rows.length} cluster(s) ` +
        `from ${candidates.length} candidate(s)\n` +
        (unasked.length
          ? `           ${unasked.length} configured opener(s) nobody has ever asked for.\n`
          : '') +
        `\n  Your config was not touched, and this is not a ranking of questions —\n` +
        `  it is a ranking of questions somebody VOTED on. Read the report, choose\n` +
        `  three yourself, then run \`npx docpilot index\`, which resolves them\n` +
        `  against the corpus and names the ones the gate refuses.`,
    )
    return 0
  }

  if (args.mode === 'report') {
    const out = args.out ? path.resolve(args.out) : path.join(REPORTS, 'feedback-latest.md')
    mkdirSync(path.dirname(out), {recursive: true})
    writeFileSync(
      out,
      renderReport(candidates, {
        send,
        source: isUrl(args.from) ? new URL(args.from).origin : path.basename(args.from),
        generatedAt: new Date().toISOString(),
      }),
    )
    console.log(`[docpilot] ${path.relative(process.cwd(), out)}`)
    if (send === 'down') {
      console.log(
        `[docpilot] feedback.send is "down" — only complaints were transmitted, so the\n` +
          `           rate in that report has no denominator. See the report's own note.`,
      )
    }
    return 0
  }

  const out = args.out ? path.resolve(args.out) : CANDIDATES
  const merged = merge(readCandidates(out), candidates)
  mkdirSync(path.dirname(out), {recursive: true})
  writeFileSync(out, merged.map((c) => JSON.stringify(c)).join('\n') + '\n')

  const byTarget = merged.reduce((m, c) => ((m[c.target] = (m[c.target] || 0) + 1), m), {})
  const review = merged.filter((c) => c.needsReview && c.target !== 'none').length
  console.log(
    `[docpilot] ${path.relative(process.cwd(), out)} — ${merged.length} candidates\n` +
      `           calibration ${byTarget.calibration || 0} · golden ${byTarget.golden || 0} · ` +
      `docs ${byTarget.docs || 0} · not usable ${byTarget.none || 0}\n` +
      `           ${review} need review before they can be promoted.\n\n` +
      `  Nothing was written to your eval sets. A stratum is a judgement about what a\n` +
      `  question was for, and a gold_answer is one somebody writes — read the file,\n` +
      `  fix the suggestions, then copy the rows you keep into calibration.jsonl or\n` +
      `  golden.jsonl and run \`npx docpilot lint\`.`,
  )
  return 0
}
