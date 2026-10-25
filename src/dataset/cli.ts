/**
 * `docpilot dataset <sft|kto|dpo>` — training files from the turn log and votes.
 *
 * The IO half; build.ts is the part that decides. Every filter is counted and
 * printed, so a row that did not make it into the file is a number on screen,
 * not a silence.
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {FAILED, OK, USAGE} from '../cli-exit.js'
import {parseFlags, renderHelp, type FlagSpec} from '../traffic/args.js'
import {loadTraffic} from '../traffic/cli.js'
import {evalDirOf, loadIndexBits, readJsonl} from '../traffic/source.js'
import {buildDpo, buildKto, buildSft, splitHoldout, type Counts} from './build.js'

export const DATASET_MODES = ['sft', 'kto', 'dpo']

export const DATASET_FLAGS: Record<string, FlagSpec> = {
  'from': {kind: 'value', help: 'turn log: a file, a directory of turns-YYYY-MM-DD.jsonl, or a URL (default ${evalDir}/turns)'},
  'feedback': {kind: 'value', help: 'feedback export joined by messageId — the votes every mode learns from'},
  'out': {kind: 'value', help: 'output JSONL (default ${evalDir}/dataset-<mode>.jsonl); the holdout goes beside it as *.holdout.jsonl'},
  'golden': {kind: 'value', help: 'golden set to exclude from training (default ${evalDir}/golden.jsonl)'},
  'include-unvoted': {kind: 'bool', help: 'sft only: also take unvoted answers with citations, support ≥ 0.8, not tentative'},
  'holdout': {kind: 'number', help: 'share of conversations held out, split by hash of conversationId (default 0.1; 0 disables)'},
  'system': {kind: 'value', help: 'file whose text replaces the system message'},
  'json': {kind: 'bool', help: 'print the summary as JSON only'},
}

export const HELP = () =>
  renderHelp(
    'Usage: docpilot dataset <sft|kto|dpo> [options]\n\n' +
      '  sft   {"messages": [...]} from up-voted answers (OpenAI chat / TRL SFT)\n' +
      '  kto   {"prompt", "completion", "label"} from up (true) and down (false) votes — TRL KTO\n' +
      '  dpo   {"prompt", "chosen", "rejected"} where one question has both an up- and a\n' +
      '        down-voted answer — TRL DPO\n\n' +
      'Questions matching golden.jsonl are always excluded.',
    DATASET_FLAGS,
  )

const holdoutPath = (out: string) => (out.endsWith('.jsonl') ? out.slice(0, -6) : out) + '.holdout.jsonl'

function filterLines(c: Counts) {
  const lines = [
    `in ${c.in}`,
    `not an answer ${c.notAnswer}`,
    `matches golden ${c.golden}`,
    `no usable vote ${c.noVote}`,
  ]
  if (c.notGoodEnough) lines.push(`unvoted, below the bar ${c.notGoodEnough}`)
  for (const [why, n] of Object.entries(c.noPrompt)) lines.push(`${why} ${n}`)
  if (c.historyDropped) lines.push(`client-sent history removed ${c.historyDropped}`)
  lines.push(`empty answer ${c.noAnswer}`, `duplicate ${c.duplicate}`, `out ${c.out}`)
  return lines
}

export async function runDataset({
  docPilot,
  argv = [],
  env = {},
}: {
  docPilot: any
  argv?: string[]
  env?: Record<string, string | undefined>
}): Promise<number> {
  const {mode, flags, error, help} = parseFlags(argv, DATASET_FLAGS)
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
  if (!DATASET_MODES.includes(mode)) {
    console.error(`[docpilot] unknown mode "${mode}". One of: ${DATASET_MODES.join(', ')}`)
    return USAGE
  }
  if (flags['include-unvoted'] && mode !== 'sft') {
    console.error('[docpilot] --include-unvoted is for sft only: kto and dpo learn from the vote itself')
    return USAGE
  }
  const ratio = flags.holdout ?? 0.1
  if (ratio < 0 || ratio >= 1) {
    console.error(`[docpilot] --holdout is a share in [0, 1), got ${ratio}`)
    return USAGE
  }

  const evalDir = evalDirOf(docPilot)
  const out = path.resolve(flags.out || path.join(evalDir, `dataset-${mode}.jsonl`))
  const goldenFile = path.resolve(flags.golden || path.join(evalDir, 'golden.jsonl'))
  if (out === goldenFile || path.basename(out) === 'golden.jsonl' || path.basename(out) === 'calibration.jsonl') {
    console.error('[docpilot] --out names an eval set. Training files are never written over one.')
    return USAGE
  }

  let system = null
  if (flags.system) {
    const f = path.resolve(flags.system)
    if (!existsSync(f)) {
      console.error(`[docpilot] no such file: ${f}`)
      return FAILED
    }
    system = readFileSync(f, 'utf8').trim()
  }

  const log = flags.json ? () => {} : (m: string) => console.error(m)
  let data
  try {
    data = await loadTraffic({docPilot, flags, env, log})
  } catch (e) {
    console.error(`[docpilot] could not read the turn log or the feedback — ${e.message}`)
    return FAILED
  }
  if (!flags.feedback && !(mode === 'sft' && flags['include-unvoted'])) {
    console.error(
      `[docpilot] no --feedback: the turn log carries no votes, so ${mode} has nothing to learn from.\n` +
        `  Pass your feedback export with --feedback${mode === 'sft' ? ', or --include-unvoted' : ''}.`,
    )
    return USAGE
  }

  let golden
  try {
    golden = readJsonl(goldenFile)
  } catch (e) {
    console.error(`[docpilot] ${goldenFile} could not be read — ${e.message}`)
    return FAILED
  }
  if (!golden.length) log(`[docpilot] no golden set at ${goldenFile} — nothing to exclude; eval contamination is unchecked`)

  const needsIndex = data.turns.some((t) => !Array.isArray(t.messages) || !t.messages.length)
  const index = needsIndex ? loadIndexBits(docPilot) : null
  if (index && !index.chunks) log(`[docpilot] ${index.why || 'index chunks unreadable'} — turns without logged messages are skipped`)
  const opts = {golden, chunks: index?.chunks ?? null, system}

  let result: {items: any[]; counts: Counts}
  const extra: Record<string, any> = {}
  if (mode === 'sft') result = buildSft(data.turns, {...opts, includeUnvoted: !!flags['include-unvoted']})
  else if (mode === 'kto') {
    const r = buildKto(data.turns, opts)
    result = r
    extra.balance = r.balance
    extra.warning = r.warning
  } else {
    const r = buildDpo(data.turns, opts)
    result = r
    extra.pairs = r.pairs
    extra.unpaired = r.unpaired
  }

  const {train, holdout} = splitHoldout(result.items, ratio)
  const hout = holdoutPath(out)
  mkdirSync(path.dirname(out), {recursive: true})
  const write = (f: string, rows: any[]) => writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  write(out, train)
  if (ratio > 0) write(hout, holdout)

  const summary = {
    mode,
    out: path.relative(process.cwd(), out),
    holdoutOut: ratio > 0 ? path.relative(process.cwd(), hout) : null,
    read: data.read,
    malformed: data.malformed.length,
    duplicates: data.duplicates,
    feedback: data.feedback,
    filters: result.counts,
    train: train.length,
    holdout: holdout.length,
    holdoutRatio: ratio,
    ...extra,
  }
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2))
    return OK
  }
  console.log(
    `[docpilot] ${summary.out} — ${train.length} row(s)` +
      (ratio > 0 ? `; ${summary.holdoutOut} — ${holdout.length} held out` : '') +
      `\n           ${data.read} row(s) read, ${data.malformed.length} malformed, ${data.duplicates} duplicate messageId(s)` +
      `\n           ${filterLines(result.counts).join(' · ')}`,
  )
  if (result.counts.golden) {
    console.log(`           ${result.counts.golden} turn(s) excluded because they match golden.jsonl — eval would measure memory otherwise.`)
  }
  if (mode === 'kto') {
    console.log(`           labels: ${extra.balance.desirable} true / ${extra.balance.undesirable} false`)
    if (extra.warning) console.warn(`[docpilot] ${extra.warning}`)
  }
  if (mode === 'dpo') {
    console.log(
      `           ${extra.pairs} pair(s); ${extra.unpaired} voted answer(s) had no opposite vote on the same question.\n\n` +
        '  DPO needs a PAIR: one question, one answer readers liked and one they did not.\n' +
        '  Thumbs on a docs site are almost never paired, so this file is usually small.\n' +
        '  Plain up/down votes are what KTO is for: `npx docpilot dataset kto`.',
    )
  }
  return OK
}
