/**
 * Report writing and comparison — RAG-SPEC 6.
 *
 * `latest.json` alone cannot answer the only question a tuning loop asks — "did
 * that change help?" — because the previous answer has already been overwritten
 * by the time the new one exists. Every run is therefore written under a name
 * built from the three things that make two runs comparable at all: the index it
 * ran against, the model that ran, and the prompt it was given.
 */

import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_RUN_LEVEL } from './levels.js'

/**
 * The pool a report measured.
 *
 * THE `??` IS THE WHOLE FEATURE. Every report written before levels existed has
 * no `meta.level`, and every one of them measured the entire golden set — which
 * is exactly what a run with no `--level` measures today. Read the absence as
 * anything else (`null`, `'high'`, the string `'undefined'`) and it stops
 * matching the unfiltered runs that follow it: `previousReport` finds no
 * candidate, `diffSummaries` gets no `prev`, and the report history of every
 * existing consumer goes dark on the upgrade — silently, because a report with
 * no "changes since the previous run" section looks exactly like the first run
 * of a new index.
 *
 * One function, called from both readers, so the two can never disagree about
 * what an old file meant.
 */
const levelOf = (m) => m?.level ?? DEFAULT_RUN_LEVEL

/** Metrics where a larger number is better. Everything else reads the other way. */
const HIGHER_IS_BETTER = new Set([
  'retrievalF1',
  'recall8',
  'mrr',
  'answerF1',
  'identifierRecall',
  'citationPrecision',
  'supportPrecision',
  'language',
  'negativesCaughtRate',
  'noAnswerPrecision',
  'scopeContainment',
])

/** Metrics reported as a count or a cost: lower is better, or neutral. */
const LOWER_IS_BETTER = new Set([
  'unsupportedAnswerRate',
  'hallucinated',
  'gateOverRefusal',
  'answerOverRefusal',
  'rejectedFetches',
  'promptTokens',
  'outputTokens',
  'tokensPerAcceptedAnswer',
  'promptChars',
  'promptCharsPeak',
  'observationChars',
  'iterationsPerAnswer',
  'latencyP50',
  'latencyP95',
])

const TRACKED = [...HIGHER_IS_BETTER, ...LOWER_IS_BETTER]

const fmt = (v) => {
  if (v == null) return '—'
  if (typeof v !== 'number') return String(v)
  if (Number.isInteger(v)) return String(v)
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3)
}

/**
 * Find the newest report for the same (index, model) pair and the same golden
 * pool, whatever prompt it used. A prompt change is not a reason to hide the
 * comparison — it is a reason to label every delta in it, which is what §6 asks
 * for. A different pool is a reason to hide it: see `levelOf`.
 */
export function previousReport(dir, meta) {
  if (!fs.existsSync(dir)) return null
  const prefix = `report-${meta.indexHash}-${String(meta.model).replace(/[^\w.-]+/g, '_')}-`
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const c of candidates) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, c.f), 'utf8'))
      if (!doc?.summary) continue
      // The prefix stops at the model, so it also matches the `-lexical-` files
      // written by `docpilot eval --lexical` — a diagnostic run with the dense
      // channel switched off. Diffing a hybrid run against one of those reports
      // "changes since the previous run" that are really the two channels, which
      // is the exact confusion the separate filename was introduced to prevent.
      if (Boolean(doc.meta?.lexical) !== Boolean(meta.lexical)) continue
      // `lexical` is true for two different reasons and only one of them has a
      // hybrid twin. A diagnostic run on a vector-bearing index and the standing
      // measurement of a `--no-embed` deployment agree on the flag, the corpus
      // hash and the model — and comparing them reports as "changes since the
      // previous run" the difference between an experiment and a deployment.
      if (Boolean(doc.meta?.vectorlessIndex) !== Boolean(meta.vectorlessIndex)) continue
      // A level-filtered run scores a DIFFERENT POPULATION, not a smaller sample
      // of the same one: `--level=low` is ten smoke lookups, and its answerF1
      // sits wherever ten easy questions put it. Diffed against the full set the
      // deltas are the difference between two question lists, attributed to
      // whatever was changed in between — every number in the table a lie, with
      // no marker on it. Partitioned rather than labelled `incomparable` for
      // that reason: there is nothing here worth reading.
      if (levelOf(doc.meta) !== levelOf(meta)) continue
      return doc
    } catch {
      // A half-written report is not a comparison; skip it.
    }
  }
  return null
}

export function diffSummaries(prev, next) {
  const out = []
  for (const key of TRACKED) {
    const a = prev?.summary?.[key]
    const b = next?.[key]
    if (typeof a !== 'number' || typeof b !== 'number') continue
    const delta = b - a
    if (!delta) continue
    const better = HIGHER_IS_BETTER.has(key) ? delta > 0 : delta < 0
    out.push({ key, from: a, to: b, delta, better })
  }
  return out
}

function markdown({ meta, summary, diff, incomparable, rows }) {
  const L = []
  L.push(`# DocPilot eval — ${meta.model}`)
  L.push('')
  // `embed null` on a vectorless index reads as a bug rather than as a mode, and
  // this line is the first thing anyone opening the report looks at. The two
  // reasons a run is lexical are said apart for the same reason `previousReport`
  // separates them: one has a hybrid twin to be read against and the other is the
  // whole of what its deployment does.
  L.push(
    `- index \`${meta.indexHash}\` · ${meta.chunkCount} chunks · ` +
      (meta.vectorlessIndex
        ? 'no vectors — **lexical-only index** (`embed: false`)'
        : `embed \`${meta.embedModel}\`${meta.lexical ? ' · **dense channel off for this run**' : ''}`),
  )
  // WHICH POOL. `records 12` is not enough to tell a smoke run from a full set
  // that lost 48 questions, and the two are read very differently. Said only
  // when it is not the whole set, so an unfiltered report renders byte for byte
  // as it did before levels existed and the history stays diffable by eye.
  L.push(
    `- prompt \`${meta.promptHash}\` · records ${meta.records}` +
      (levelOf(meta) === DEFAULT_RUN_LEVEL ? '' : ` · level \`${meta.level}\``) +
      ` · maxIterations ${meta.maxIterations}`,
  )
  L.push(
    `- transport ${meta.fallback ? '**fallback** (no tool calling)' : 'native tools'}` +
      `, think ${meta.thinkSupported ? 'on' : 'unsupported'}` +
      (meta.numCtx ? `, num_ctx \`${meta.numCtx}\`` : ''),
  )
  // WHICH THRESHOLD GATED THESE ROWS. On a lexical-only run every verdict was
  // `G = L` against `tauLexical`, and printing `tau` alone named the one number
  // nothing consulted — while `denseMode` describes a channel that never ran.
  L.push(
    meta.lexical
      ? `- guard tauLexical \`${meta.guard.tauLexical}\` ` +
        `source \`${meta.guard.source}\` calibratedAt \`${meta.guard.calibratedAt ?? 'null'}\`` +
        `${meta.vectorlessIndex ? '' : ` (tau \`${meta.guard.tau}\`, not consulted by this run)`}`
      : `- guard mode \`${meta.guard.denseMode}\` tau \`${meta.guard.tau}\` ` +
        `source \`${meta.guard.source}\` calibratedAt \`${meta.guard.calibratedAt ?? 'null'}\``,
  )
  L.push('')

  L.push('## Hard gates')
  L.push('')
  L.push('| gate | value | verdict |')
  L.push('|---|---|---|')
  L.push(
    `| hallucinated citations | ${fmt(summary.hallucinated)} | ${summary.hallucinated ? '**FAIL**' : 'pass'} |`,
  )
  const sc = summary.scopeContainment
  L.push(
    `| scope containment | ${fmt(sc)} | ${sc != null && sc < 1 ? '**FAIL**' : 'pass'} |`,
  )
  L.push('')

  L.push('## Metrics')
  L.push('')
  L.push('| metric | value |')
  L.push('|---|---|')
  for (const key of TRACKED) {
    if (summary[key] == null) continue
    L.push(`| ${key} | ${fmt(summary[key])} |`)
  }
  L.push('')

  if (incomparable.length) {
    L.push(`> **${incomparable.join(' · ')}** — every delta below is against a different setup.`)
    L.push('')
  }

  if (diff.length) {
    L.push('## Change since the previous run')
    L.push('')
    L.push('| metric | before | after | Δ | |')
    L.push('|---|---|---|---|---|')
    for (const d of diff) {
      L.push(
        `| ${d.key} | ${fmt(d.from)} | ${fmt(d.to)} | ${d.delta > 0 ? '+' : ''}${fmt(d.delta)} | ${d.better ? 'better' : 'worse'} |`,
      )
    }
    L.push('')
  }

  const backlog = rows
    .filter((r) => r.expect === 'answer' && typeof r.G === 'number')
    .sort((a, b) => a.G - b.G)
    .slice(0, 10)
  if (backlog.length) {
    L.push('## Over-refusal backlog — the ten positives closest to the floor')
    L.push('')
    L.push('| id | G | gate | observed | question |')
    L.push('|---|---|---|---|---|')
    for (const r of backlog) {
      L.push(
        `| ${r.id} | ${fmt(r.G)} | ${r.gatePass ? 'pass' : '**refused**'} | ${r.observed} | ${r.question.slice(0, 60)} |`,
      )
    }
    L.push('')
  }

  if (summary.misses.length) {
    L.push('## Misses')
    L.push('')
    for (const m of summary.misses) L.push(`- ${m}`)
    L.push('')
  }

  return L.join('\n')
}

/**
 * Sibling reports: other models measured against the same index and prompt.
 *
 * `previousReport` only ever compares a model with its own past, which is how a
 * matrix row measured on a different transport slipped through unremarked — one
 * model ran through the OpenAI-compatible adapter with no `num_ctx` pin while
 * its neighbours ran native with 8192, and the table read as three comparable
 * rows. A matrix is a claim that its rows differ ONLY by model.
 */
function siblingMismatches(dir, meta) {
  if (meta.gateOnly) return []
  const out = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(`report-${meta.indexHash}-`) || !f.endsWith('.json')) continue
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    } catch {
      continue
    }
    const m = doc?.meta
    if (!m || m.gateOnly || m.model === meta.model) continue
    // Same reason as in `previousReport`: a lexical-only run is not a sibling of
    // a hybrid one, it is a different experiment.
    if (Boolean(m.lexical) !== Boolean(meta.lexical)) continue
    // And the same reason again: a matrix row that ran a different pool is not a
    // row of this matrix. `m.records` below would usually catch it — two pools
    // rarely hold the same count — but "usually" is not a partition, and when
    // the counts do collide the mismatch report reads as three comparable models
    // measured on two different question lists.
    if (levelOf(m) !== levelOf(meta)) continue
    if (m.promptHash !== meta.promptHash || m.records !== meta.records) continue

    const diffs = []
    if (m.provider !== meta.provider) diffs.push(`provider ${m.provider} vs ${meta.provider}`)
    if ((m.numCtx ?? null) !== (meta.numCtx ?? null)) {
      diffs.push(`num_ctx ${m.numCtx ?? 'unset'} vs ${meta.numCtx ?? 'unset'}`)
    }
    if (m.maxIterations !== meta.maxIterations) {
      diffs.push(`maxIterations ${m.maxIterations} vs ${meta.maxIterations}`)
    }
    if (diffs.length) out.push(`Not comparable with ${m.model}: ${diffs.join(', ')}`)
  }
  return out
}

export function writeReport({ dir, name, meta, summary, rows }) {
  fs.mkdirSync(dir, { recursive: true })

  const prev = previousReport(dir, meta)
  const incomparable = []
  if (prev) {
    if (prev.meta.promptHash !== meta.promptHash) {
      incomparable.push(`Prompt changed: ${prev.meta.promptHash} → ${meta.promptHash}`)
    }
    if (JSON.stringify(prev.meta.levers) !== JSON.stringify(meta.levers)) {
      incomparable.push('Levers changed')
    }
    // Still needed, and it means something narrower than it used to. `prev` is
    // now guaranteed to be the same pool, so a count that moved is the golden
    // set having GROWN inside that pool — new questions the previous number
    // never faced. Level partitions the population; this guards growth within a
    // partition, and neither subsumes the other.
    if (prev.meta.records !== meta.records) {
      incomparable.push(`Golden changed: ${prev.meta.records} → ${meta.records} records`)
    }
    if (prev.meta.numCtx !== meta.numCtx) {
      incomparable.push(`num_ctx changed: ${prev.meta.numCtx} → ${meta.numCtx}`)
    }
  }
  incomparable.push(...siblingMismatches(dir, meta))
  const diff = diffSummaries(prev, summary)

  const doc = { meta, summary, incomparable, diff, rows }
  fs.writeFileSync(path.join(dir, name), JSON.stringify(doc, null, 1))
  fs.writeFileSync(
    path.join(dir, name.replace(/\.json$/, '.md')),
    markdown({ meta, summary, diff, incomparable, rows }),
  )
  /**
   * `latest.json` MEANS "the last unfiltered run", and a narrowed run is filed
   * beside it as `latest.<level>.json`.
   *
   * It is the one artefact this change did not partition, and it is the one every
   * external consumer reads — the skill, and anything holding the old path. Left
   * unconditional, `npx docpilot eval` followed by `npx docpilot eval --level=low`
   * left it holding a ten-question smoke score (records 10, answerF1 0.95) where
   * the project's actual number was 0.50 over sixty, with nothing in the file
   * saying which. `meta.level` is inside the document either way, but a consumer
   * that reads a fixed path is not looking.
   *
   * Same rule and the same asymmetry as `reportName`'s `-lvl-` and `bench emit`'s
   * `.<level>`: `ultra` — which is what "no flag" means, and what every report
   * written before levels existed reads as — adds no segment, so the path a
   * consumer already hard-codes keeps pointing at exactly what it always did.
   */
  const level = levelOf(meta)
  const latest = level === DEFAULT_RUN_LEVEL ? 'latest.json' : `latest.${level}.json`
  fs.writeFileSync(path.join(dir, latest), JSON.stringify(doc, null, 1))

  for (const line of incomparable) console.log(`  ${line}`)
  if (diff.length) {
    console.log('  changes since the previous run:')
    for (const d of diff.slice(0, 12)) {
      console.log(
        `    ${d.better ? '+' : '-'} ${d.key.padEnd(24)} ${fmt(d.from)} → ${fmt(d.to)}`,
      )
    }
  }
  // The directory the caller passed, not a literal: `evalDir` moves it.
  console.log(`  report written to ${path.relative(process.cwd(), path.join(dir, name))}\n`)
}
