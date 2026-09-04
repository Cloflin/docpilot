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
import { TAXONOMY_ORDER } from './metrics.js'

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
  'citationRecall',
  'supportPrecision',
  'language',
  'negativesCaughtRate',
  'noAnswerPrecision',
  'scopeContainment',
  // A prompt served out of the provider's cache is a prompt paid for once. The
  // count beside it is neutral and rides in LOWER_IS_BETTER only so the table
  // prints it; read the share.
  'cachedShare',
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
  'cachedTokens',
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
      /**
       * THE CORPUS HASH DOES NOT COVER THE VECTOR SPACE.
       *
       * `indexHash` is sha256 over chunk id and text, so one corpus embedded by
       * two models is one prefix and two retrievals. Measured on this
       * repository's own pair at corpus `08e7a87e` — `docs/public/rag` under
       * `nvidia/nemotron-3-embed-1b:free` and `docs/public/rag-local` under
       * `bge-m3` — recall@8 0.925 against 0.912, MRR 0.762 against 0.669 and
       * negativesCaught 0.125 against 0.438 were reported as a change caused by
       * whatever was edited in between.
       *
       * Absent reads as UNKNOWN and pairs, by the rule `goldenSha` established:
       * a report written before the field existed must not announce a change to
       * everybody on the day it lands.
       */
      if (doc.meta?.embedModel && meta.embedModel && doc.meta.embedModel !== meta.embedModel)
        continue
      return doc
    } catch {
      // A half-written report is not a comparison; skip it.
    }
  }
  return null
}

/**
 * The per-language keys, spelled `mrr[ru]`, appended to the tracked list.
 *
 * The 2-point revert rule is applied to whatever this function emits, and a
 * headline mean can sit still while one language gains four points and the other
 * loses four. Derived from the run being written rather than from a fixed list,
 * because the languages a golden set contains are the author's business, not
 * this module's.
 */
function languageKeys(summary) {
  const langs = Object.keys(summary?.byLanguage || {})
  const keys = []
  for (const lang of langs) {
    for (const metric of Object.keys(summary.byLanguage[lang] || {})) {
      if (metric === 'positives' || metric === 'negatives') continue
      keys.push({ key: `${metric}[${lang}]`, metric, lang })
    }
  }
  return keys
}

/**
 * The per-depth keys, spelled `mrr[depth=2]`, appended to the tracked list.
 *
 * `languageKeys` one axis over, and for the same reason. A question asked cold
 * and a question three turns into a chain are answered by different machinery:
 * the elliptical one is scored on a composition, and which antecedent went into
 * it is decided by `chainAntecedent` (src/theme/docpilot/gate.js). A change to
 * that rule moves the deep buckets and leaves depth 0 exactly where it was — a
 * shape the headline mean is built to hide, and which nothing else in this
 * report would name.
 *
 * Derived from the run being written, like the language keys: how deep a golden
 * set's chains run is the author's business, not this module's.
 */
function depthKeys(summary) {
  const depths = Object.keys(summary?.byDepth || {})
  const keys = []
  for (const depth of depths) {
    for (const metric of Object.keys(summary.byDepth[depth] || {})) {
      if (metric === 'positives' || metric === 'negatives') continue
      keys.push({ key: `${metric}[depth=${depth}]`, metric, depth })
    }
  }
  return keys
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
  // A language present in one run and not the other has no delta to report: the
  // two runs scored different populations, which is the same reason a level
  // change partitions rather than annotates.
  for (const { key, metric, lang } of languageKeys(next)) {
    const a = prev?.summary?.byLanguage?.[lang]?.[metric]
    const b = next.byLanguage[lang][metric]
    if (typeof a !== 'number' || typeof b !== 'number') continue
    const delta = b - a
    if (!delta) continue
    const better = HIGHER_IS_BETTER.has(metric) ? delta > 0 : delta < 0
    out.push({ key, from: a, to: b, delta, better })
  }
  // The same rule one axis over: a depth only one of the two runs scored is two
  // different populations. It is also what makes a report written before
  // `byDepth` existed pair silently — no bucket on the previous side, no delta,
  // and no marker announcing a change nobody made.
  for (const { key, metric, depth } of depthKeys(next)) {
    const a = prev?.summary?.byDepth?.[depth]?.[metric]
    const b = next.byDepth[depth][metric]
    if (typeof a !== 'number' || typeof b !== 'number') continue
    const delta = b - a
    if (!delta) continue
    const better = HIGHER_IS_BETTER.has(metric) ? delta > 0 : delta < 0
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
  /**
   * ENFORCED OR NOT, NAMED SEPARATELY FROM THE THRESHOLD ABOVE — engine-spec
   * 019. The line above is `guard.denseMode`, how distance is measured; this
   * is `docPilot.guard.mode`, whether a failing verdict ended a row at all.
   * `guardMode` is absent on a report written before this field existed —
   * `'off'` became the default in 1.3, so an absent key reads as the OLD
   * default rather than the new one, which is what a report generated by an
   * older version of this package actually measured.
   */
  L.push(`- guard.mode \`${meta.guardMode ?? 'dense-only'}\``)
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

  if (summary.byLanguage) {
    const langs = Object.keys(summary.byLanguage)
    L.push('## By language')
    L.push('')
    L.push('> The corpus has one language; the readers do not. A mean over the whole')
    L.push('> set describes neither population when they differ.')
    L.push('')
    L.push('| lang | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const lang of langs) {
      const b = summary.byLanguage[lang]
      L.push(
        `| ${lang} | ${b.positives} | ${b.negatives} | ${fmt(b.recall8)} | ${fmt(b.mrr)} | ` +
          `${fmt(b.answerF1)} | ${fmt(b.identifierRecall)} | ${fmt(b.negativesCaughtRate)} |`,
      )
    }
    L.push('')
  }

  if (summary.byDepth) {
    const depths = Object.keys(summary.byDepth)
    L.push('## By chain depth')
    L.push('')
    L.push('> A question asked cold and a follow-up three turns into a chain are not')
    L.push('> the same question, and a mean over both describes neither.')
    L.push('')
    L.push('| depth | pos | neg | recall8 | mrr | answerF1 | identifierRecall | negCaught |')
    L.push('|---|---|---|---|---|---|---|---|')
    for (const depth of depths) {
      const b = summary.byDepth[depth]
      L.push(
        `| ${depth} | ${b.positives} | ${b.negatives} | ${fmt(b.recall8)} | ${fmt(b.mrr)} | ` +
          `${fmt(b.answerF1)} | ${fmt(b.identifierRecall)} | ${fmt(b.negativesCaughtRate)} |`,
      )
    }
    L.push('')
  }

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

  if (summary.taxonomy) {
    const buckets = Object.keys(summary.taxonomy).sort((a, b) => {
      const rank = (k) => {
        const i = TAXONOMY_ORDER.findIndex((t) => k === t || k.startsWith(`${t}:`))
        return i === -1 ? TAXONOMY_ORDER.length : i
      }
      return rank(a) - rank(b) || a.localeCompare(b)
    })
    L.push('## Failure taxonomy')
    L.push('')
    L.push('> What moved, not how much. The four positive buckets have four')
    L.push('> different fixes: a corpus edit, a ranking lever, the answer side,')
    L.push('> and the gate.')
    L.push('')
    L.push('| bucket | n | ids |')
    L.push('|---|---|---|')
    for (const bucket of buckets) {
      const ids = summary.taxonomy[bucket]
      L.push(`| ${bucket} | ${ids.length} | ${ids.join(', ')} |`)
    }
    L.push('')
  }

  if (summary.missPages?.undescribed?.length) {
    L.push('## Pages behind the misses that never say what they are for')
    L.push('')
    L.push('> A frontmatter `description` lands on the page\'s FIRST chunk and is')
    L.push('> the one measured dense lever on this pipeline. A lead, not a verdict:')
    L.push('> the answer may simply not be written anywhere.')
    L.push('')
    L.push('| page | records |')
    L.push('|---|---|')
    for (const p of summary.missPages.undescribed) {
      L.push(`| \`${p.page}\` | ${p.records.join(', ')} |`)
    }
    L.push('')
  }

  if (summary.reSearch?.crossLanguage) {
    const r = summary.reSearch
    L.push('## Re-search')
    L.push('')
    L.push(
      `${r.turns} of ${r.ofTurns} turns searched again in the model's own words; ` +
        `**${r.crossLanguage}** of those crossed language.`,
    )
    L.push('')
    L.push(
      '> A re-search moves the lexical half only: the dense half still scores the' +
        " reader's original question. " +
        (r.crossLanguageIds.length ? `Records: ${r.crossLanguageIds.join(', ')}.` : ''),
    )
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
    // A row measured in another vector space is not a row of this matrix, for
    // the same reason `previousReport` refuses the pair one screen up.
    if (m.embedModel && meta.embedModel && m.embedModel !== meta.embedModel) continue
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
    /**
     * THE SAME COUNT IS NOT THE SAME SET.
     *
     * `records` moves when the set GROWS and not when it is edited, so a
     * rewritten question inside an existing record — a different measurement
     * under the same name — passed every one of the four markers above.
     * `goldenSha` is the file itself.
     *
     * ABSENT READS AS UNKNOWN, not as different: a report written before this
     * field existed carries no sha, and announcing "the golden set changed" at
     * every reader who upgrades would be a marker that cries wolf once per
     * install. Same rule `meta.level` already established for pre-level history.
     */
    if (prev.meta.goldenSha && meta.goldenSha && prev.meta.goldenSha !== meta.goldenSha) {
      incomparable.push(`Golden set edited: ${prev.meta.goldenSha} → ${meta.goldenSha}`)
    }
    if (prev.meta.numCtx !== meta.numCtx) {
      incomparable.push(`num_ctx changed: ${prev.meta.numCtx} → ${meta.numCtx}`)
    }
    /**
     * THE TWO ARMS OF AN A/B, which is the one pair of runs this file was
     * otherwise guaranteed to mislabel.
     *
     * `DOCPILOT_HISTORY_CONDENSE` and `DOCPILOT_ANTECEDENT_HOPS` exist so both
     * arms run on one build — same index, same prompt, same golden set, same
     * level, same levers. Every marker above therefore passes, `reportName` is
     * the same string, the second arm overwrites the first, and the deltas land
     * under "Change since the previous run" as though something had been fixed.
     * They are two systems, and the header has to say so.
     *
     * ABSENT READS AS UNKNOWN — `goldenSha`'s rule four checks up, for its
     * reason: a report written before these fields existed carries neither, and
     * announcing a changed arm at every reader who upgrades is a marker that
     * cries wolf once per install. `!= null` rather than `goldenSha`'s
     * truthiness test, because `false` is a legal value of `historyCondense`
     * and truthiness would silently drop the off arm — the half of the A/B the
     * knob was added to make runnable.
     */
    if (
      prev.meta.historyCondense != null &&
      meta.historyCondense != null &&
      prev.meta.historyCondense !== meta.historyCondense
    ) {
      const arm = (v) => (v ? 'on' : 'off')
      incomparable.push(
        `History condense: ${arm(prev.meta.historyCondense)} → ${arm(meta.historyCondense)}`,
      )
    }
    if (
      prev.meta.antecedentHops != null &&
      meta.antecedentHops != null &&
      prev.meta.antecedentHops !== meta.antecedentHops
    ) {
      incomparable.push(
        `Antecedent hops: ${prev.meta.antecedentHops} → ${meta.antecedentHops}`,
      )
    }
  }
  incomparable.push(...siblingMismatches(dir, meta))
  const diff = diffSummaries(prev, summary)

  const doc = { meta, summary, incomparable, diff, rows }
  /**
   * THE PREVIOUS RUN SURVIVES THIS ONE.
   *
   * `reportName` is a pure function of the inputs — index hash, model, flags,
   * level, prompt hash — which is what makes `previousReport` work at all, and
   * which also means a rerun with nothing changed writes over the file it is
   * being compared against. `previousReport` picks the newest by mtime, so it
   * diffs against a file that is about to cease to exist.
   *
   * So the existing file is copied aside first, under its own `ranAt`. The name,
   * `latest.json` and `previousReport` are all untouched: that function reads
   * this directory with a non-recursive `readdirSync` and takes only
   * `report-….json`, so a subdirectory does not exist as far as it is concerned.
   *
   * `ranAt` is missing on every report written before this spec, and the first
   * rerun after upgrading is exactly the case that would name the copy
   * `undefined`. The file's own mtime answers it.
   *
   * NOT COMMITTED — long-term history is git. This protects the last run inside
   * one working cycle, between the run and the decision about what to keep.
   */
  const target = path.join(dir, name)
  if (fs.existsSync(target)) {
    try {
      const history = path.join(dir, 'history')
      fs.mkdirSync(history, { recursive: true })
      let stamp
      try {
        stamp = JSON.parse(fs.readFileSync(target, 'utf8')).meta?.ranAt
      } catch {
        // An unreadable previous report is still worth keeping a copy of; the
        // mtime names it as well as its own field would have.
      }
      const when = String(stamp || fs.statSync(target).mtime.toISOString()).replace(/[:.]/g, '-')
      fs.copyFileSync(target, path.join(history, name.replace(/\.json$/, `.${when}.json`)))
    } catch {
      // Keeping a copy must never be the reason a run loses its report. The
      // write below is the product; this is insurance.
    }
  }
  fs.writeFileSync(target, JSON.stringify(doc, null, 1))
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
