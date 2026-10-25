/**
 * `docpilot traffic <report|candidates>` — the turn log, read back.
 *
 * THIS COMMAND IS OUTSIDE THE LOOP, like `docpilot feedback`: `report` writes
 * markdown, `candidates` writes `traffic-candidates.jsonl`, and neither touches
 * golden.jsonl or calibration.jsonl. A person promotes a candidate after writing
 * its gold_answer.
 *
 * The IO half. Everything worth testing is in turns.ts, cluster.ts, report.ts
 * and candidates.ts, which touch nothing.
 */

import {mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {FAILED, OK, USAGE} from '../cli-exit.js'
import {parseFlags, renderHelp, SINCE, type FlagSpec} from './args.js'
import {trafficReport} from './report.js'
import {trafficCandidates} from './candidates.js'
import {joinFeedback, parseTurns, sinceFilter, type Turn} from './turns.js'
import {evalDirOf, isUrl, loadIndexBits, readFeedbackRows, readJsonl, readTurnRows, turnLogDir} from './source.js'

export const TRAFFIC_MODES = ['report', 'candidates']

export const TRAFFIC_FLAGS: Record<string, FlagSpec> = {
  'from': {kind: 'value', help: 'turn log: a file, a directory of turns-YYYY-MM-DD.jsonl, or a URL (default ${evalDir}/turns)'},
  'feedback': {kind: 'value', help: 'feedback export to join by messageId: a file or a URL (optional)'},
  'since': {kind: 'value', help: 'only turns on or after this UTC date, YYYY-MM-DD'},
  'out': {kind: 'value', help: 'report: write here instead of stdout; candidates: default ${evalDir}/traffic-candidates.jsonl'},
  'json': {kind: 'bool', help: 'report: print the measured numbers as JSON; candidates: print the summary as JSON'},
  'limit': {kind: 'int', help: 'report: rows per table (default 15); candidates: at most this many new rows'},
}

export const HELP = () =>
  renderHelp(
    'Usage: docpilot traffic <report|candidates> [options]\n\n' +
      '  report       what the turn log says: outcomes, quality, feedback, and six RAG\n' +
      '               sections (gaps, vocabulary, uncited pages, unreached pages,\n' +
      '               language, prompt/index drift), each with the command to run next\n' +
      '  candidates   golden-record candidates from failed and up-voted turns, with\n' +
      '               needsReview: true and no gold_answer — never written to golden.jsonl',
    TRAFFIC_FLAGS,
  )

const PER_CLUSTER = 3

const shortPath = (p: string) => {
  const rel = path.relative(process.cwd(), path.resolve(p))
  return !rel ? '.' : rel.startsWith('..') ? path.resolve(p) : rel
}

/** Read, validate, filter and join — shared with `docpilot dataset`. */
export async function loadTraffic({
  docPilot,
  flags,
  env,
  log = (m: string) => console.error(m),
}: {
  docPilot: any
  flags: Record<string, any>
  env: Record<string, string | undefined>
  log?: (m: string) => void
}): Promise<{
  turns: Turn[]
  malformed: ReturnType<typeof parseTurns>['malformed']
  duplicates: number
  read: number
  outOfWindow: number
  feedback: {rows: number; joined: number; orphans: number} | null
  source: string
}> {
  const from = flags.from || turnLogDir(docPilot)
  const {rows, malformed: torn, files} = await readTurnRows({from, since: flags.since ?? null, env, log})
  const parsed = parseTurns({rows, malformed: torn})
  const windowed = sinceFilter(parsed.turns, flags.since ?? null)
  log(
    `[docpilot] read ${parsed.total} row(s) from ${files.length} source(s): ${parsed.turns.length} turn(s), ` +
      `${parsed.malformed.length} malformed, ${parsed.duplicates} duplicate messageId(s)` +
      (flags.since ? `, ${parsed.turns.length - windowed.length} before ${flags.since}` : ''),
  )
  for (const m of parsed.malformed.slice(0, 3)) log(`           skipped ${m.file ? `${m.file}:` : 'line '}${m.line ?? '?'} — ${m.why}`)
  let turns = windowed
  let feedback = null
  if (flags.feedback) {
    const fb = await readFeedbackRows({from: flags.feedback, since: flags.since ?? null, env, log})
    const j = joinFeedback(turns, fb)
    turns = j.turns
    feedback = {rows: j.rows, joined: j.joined, orphans: j.orphans}
    log(`[docpilot] feedback: ${j.rows} row(s), joined to ${j.joined} turn(s), ${j.orphans} without a turn here`)
  }
  return {
    turns,
    malformed: parsed.malformed,
    duplicates: parsed.duplicates,
    read: parsed.total,
    outOfWindow: parsed.turns.length - windowed.length,
    feedback,
    source: isUrl(from) ? new URL(from).origin : shortPath(from),
  }
}

/**
 * @returns exit code — 0 done, 1 the work failed, 2 the command line was wrong.
 */
export async function runTraffic({
  docPilot,
  argv = [],
  env = {},
}: {
  docPilot: any
  argv?: string[]
  env?: Record<string, string | undefined>
}): Promise<number> {
  const {mode, flags, error, help} = parseFlags(argv, TRAFFIC_FLAGS)
  if (help) {
    console.log(HELP())
    return OK
  }
  if (error) {
    console.error(`[docpilot] ${error}\n\n${HELP()}`)
    return USAGE
  }
  if (!mode) {
    console.log(HELP())
    return USAGE
  }
  if (!TRAFFIC_MODES.includes(mode)) {
    console.error(`[docpilot] unknown mode "${mode}". One of: ${TRAFFIC_MODES.join(', ')}`)
    return USAGE
  }
  if (flags.since && !SINCE.test(flags.since)) {
    console.error(`[docpilot] --since takes YYYY-MM-DD, got "${flags.since}"`)
    return USAGE
  }

  let data
  try {
    data = await loadTraffic({docPilot, flags, env})
  } catch (e) {
    console.error(`[docpilot] could not read the turn log — ${e.message}`)
    return FAILED
  }
  if (!data.turns.length) {
    console.error(
      `[docpilot] no turns to read${data.malformed.length ? ` — all ${data.malformed.length} row(s) were malformed` : ''}.\n` +
        `  The server writes them with log: {dir} (engine-spec 028); point --from at that directory.`,
    )
    return FAILED
  }

  const index = loadIndexBits(docPilot)
  if (index.why) console.error(`[docpilot] ${index.why} — sections that need the index say so`)

  if (mode === 'report') {
    const {stats, markdown} = trafficReport(data.turns, {
      df: index.df,
      pages: index.manifest?.pages ?? null,
      paths: index.paths,
      malformed: data.malformed,
      duplicates: data.duplicates,
      feedback: data.feedback,
      source: data.source,
      since: flags.since ?? null,
      generatedAt: new Date().toISOString(),
      limit: flags.limit ?? 15,
    })
    const text = flags.json ? JSON.stringify(stats, null, 2) + '\n' : markdown
    if (flags.out) {
      const out = path.resolve(flags.out)
      mkdirSync(path.dirname(out), {recursive: true})
      writeFileSync(out, text)
      console.error(`[docpilot] ${path.relative(process.cwd(), out)}`)
    } else process.stdout.write(text)
    return OK
  }

  // candidates
  const evalDir = evalDirOf(docPilot)
  const out = flags.out ? path.resolve(flags.out) : path.join(evalDir, 'traffic-candidates.jsonl')
  const goldenFile = path.join(evalDir, 'golden.jsonl')
  if (path.resolve(out) === goldenFile) {
    console.error('[docpilot] --out names golden.jsonl. Candidates are never written there — a person promotes them.')
    return USAGE
  }
  let golden, existing
  try {
    golden = readJsonl(goldenFile)
    existing = readJsonl(out)
  } catch (e) {
    console.error(`[docpilot] could not read ${goldenFile} or ${out} — ${e.message}`)
    return FAILED
  }
  const {candidates, counts, clusters} = trafficCandidates(data.turns, {
    golden,
    existing,
    df: index.df,
    paths: index.paths,
    perCluster: PER_CLUSTER,
    limit: flags.limit ?? null,
  })
  const merged = [...existing, ...candidates]
  mkdirSync(path.dirname(out), {recursive: true})
  writeFileSync(out, merged.map((c) => JSON.stringify(c)).join('\n') + (merged.length ? '\n' : ''))

  const summary = {
    out: path.relative(process.cwd(), out),
    read: data.read,
    malformed: data.malformed.length,
    duplicates: data.duplicates,
    outOfWindow: data.outOfWindow,
    feedback: data.feedback,
    ...counts,
    clusters,
    perCluster: PER_CLUSTER,
    kept: existing.length,
    total: merged.length,
  }
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2))
    return OK
  }
  const byWhy = candidates.reduce((m, c) => ((m[c.why] = (m[c.why] || 0) + 1), m), {})
  console.log(
    `[docpilot] ${summary.out} — ${candidates.length} new candidate(s), ${existing.length} kept from the last run\n` +
      `           ${Object.entries(byWhy).map(([k, n]) => `${k} ${n}`).join(' · ') || 'nothing new'}\n` +
      `           of ${counts.turns} turn(s): ${counts.noSignal} carried no signal, ${counts.inGolden} already in golden.jsonl, ` +
      `${counts.alreadyCandidate} already candidates, ${counts.duplicate} repeated a question, ` +
      `${counts.capped} over the ${PER_CLUSTER}-per-cluster cap (${clusters} cluster(s))` +
      (counts.limited ? `, ${counts.limited} over --limit` : '') +
      `\n           ${data.malformed.length} malformed row(s) skipped.\n\n` +
      `  Nothing was written to golden.jsonl. Every row has needsReview: true and no\n` +
      `  gold_answer — an expect is a suggestion and an answer is something a person\n` +
      `  writes. Read the file, write gold_answer, fix expect and gold_chunks, then copy\n` +
      `  the rows you keep into golden.jsonl and run \`npx docpilot lint\` and \`npx docpilot eval\`.`,
  )
  return OK
}
