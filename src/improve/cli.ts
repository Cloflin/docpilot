/**
 * `docpilot improve` — from a report's failures to the edits worth making, and
 * back to a verdict — engine-spec 035.
 *
 *   docpilot improve [plan]    diagnose the newest dev-split report: one item
 *                              per (cause, page), the file to edit, the records
 *                              that will prove it — `<evalDir>/improve/plan.*`
 *   docpilot improve compare   two reports of the same records, before and
 *                              after an edit: keep, revert or neutral, by the
 *                              2-point rule
 *   docpilot improve check     the edit since a git ref copies no TEST gold
 *                              answer, and touched no eval set
 *
 * Nothing here calls a model or writes a page. The plan is read by a person or
 * by the tuning agent (spec 036), who writes the edit; `index` and `eval` measure
 * it; `compare` says whether it stays.
 */

import fs from 'node:fs'
import path from 'node:path'

import { flagErrors, flagValue, flagGiven, helpFor } from '../cli-flags.js'
import { FAILED, OK, USAGE } from '../cli-exit.js'
import { printable } from '../build/lib/terminal.js'

const MODES = ['plan', 'compare', 'check']

/** The newest report in `dir`, preferring the dev split — what `plan` reads when not told. */
export function newestReport(dir: string) {
  if (!fs.existsSync(dir)) return null
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
    .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  const dev = files.find((x) => x.f.includes('-split-dev'))
  return path.join(dir, (dev || files[0])?.f ?? '') || null
}

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : []

function renderPlan(items, meta) {
  const out = []
  out.push(`# Improvement plan`)
  out.push('')
  out.push(`From \`${meta.report}\` — ${meta.rows} records${meta.split ? `, split ${meta.split}` : ''}, ${meta.findings} failing.`)
  out.push('')
  if (!items.length) out.push('Nothing to change: no failing record in this report has a corpus cause.')
  for (const i of items) {
    out.push(`## ${i.id} · ${i.lever}${i.page ? ` · ${i.page}` : ''}`)
    out.push('')
    out.push(i.action)
    out.push('')
    out.push(`- records: ${i.records.join(', ')}`)
    if (i.terms?.length) out.push(`- readers' words the page lacks: ${i.terms.join(', ')}`)
    if (i.outranking?.length) out.push(`- ranked above it: ${i.outranking.join(', ')}`)
    if (i.unseen?.length) out.push(`- gold the turn never saw: ${i.unseen.join(', ')}`)
    if (i.files.length) out.push(`- edit: ${i.files.join(', ')}`)
    out.push('')
  }
  out.push('Never write product behaviour the docs do not already state; a question the docs cannot answer is a negative, not an edit.')
  return `${out.join('\n')}\n`
}

export async function runImprove({ docPilot, argv = [], env = process.env }: { docPilot: any; argv?: string[]; env?: Record<string, string | undefined> }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(helpFor('improve'))
    return OK
  }
  const errors = flagErrors('improve', argv)
  if (errors.length) {
    for (const e of errors) console.error(`[docpilot] ${e}`)
    return USAGE
  }
  const mode = argv.find((a) => !a.startsWith('-')) || 'plan'
  if (!MODES.includes(mode)) {
    console.error(`[docpilot] improve takes ${MODES.join(', ')} — not "${printable(mode)}"`)
    return USAGE
  }
  const json = flagGiven('improve', argv, 'json')
  const ctx = await import('../cli-context.js')

  if (mode === 'compare') {
    const before = flagValue('improve', argv, 'before')
    const after = flagValue('improve', argv, 'after')
    if (!before || !after) {
      console.error('[docpilot] improve compare needs --before=<report.json> and --after=<report.json>')
      return USAGE
    }
    const { compareRuns } = await import('./compare.js')
    const r = compareRuns(JSON.parse(fs.readFileSync(before, 'utf8')), JSON.parse(fs.readFileSync(after, 'utf8')))
    if (json) {
      console.log(JSON.stringify(r, null, 2))
      return OK
    }
    console.log(`\n  improve compare — ${r.pairs} records paired by id\n`)
    console.log(`  verdict          ${r.verdict.toUpperCase()}`)
    for (const why of r.reasons) console.log(`                   ${why}`)
    console.log(`  ended right      ${pctOf(r.ok.before)} → ${pctOf(r.ok.after)}  (${r.mcnemar.c} better, ${r.mcnemar.b} worse, McNemar p ${r.mcnemar.p.toFixed(3)})`)
    for (const m of r.metrics) {
      console.log(`  ${m.label.padEnd(20)} ${signed(m.delta)}  95% [${signed(m.lo)}, ${signed(m.hi)}]  n=${m.n}`)
    }
    console.log('')
    return OK
  }

  if (mode === 'check') {
    const { addedSince, leaks, measurementTouched } = await import('./check.js')
    const since = flagValue('improve', argv, 'since') || 'HEAD'
    let added
    let touched
    try {
      added = addedSince(ctx.ROOT, path.relative(ctx.ROOT, ctx.DOCS) || '.', since)
      touched = measurementTouched(ctx.ROOT, path.relative(ctx.ROOT, ctx.DOCPILOT_DIR) || '.', since)
    } catch (e) {
      console.error(`[docpilot] improve check needs git: ${e?.message || e}`)
      return FAILED
    }
    const found = leaks(added, readJsonl(ctx.GOLDEN), { split: 'test' })
    const result = { since, filesChanged: added.size, leaks: found, measurementTouched: touched, ok: !found.length && !touched.length }
    if (json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`\n  improve check — ${added.size} doc file(s) changed since ${since}\n`)
      console.log(`  test gold copied  ${found.length ? `${found.length} run(s) of ${8} words` : 'none'}`)
      for (const l of found.slice(0, 10)) console.log(`    ${l.file}  "${l.ngram}"  ← ${l.records.join(', ')}`)
      console.log(`  eval sets edited  ${touched.length ? touched.join(', ') : 'none'}`)
      console.log(result.ok ? '\n  ok — the edit can be measured\n' : '\n  NOT OK — undo the copied text and the eval-set edits before measuring\n')
    }
    return result.ok ? OK : FAILED
  }

  // ── plan ──────────────────────────────────────────────────────────────────
  const reportPath = flagValue('improve', argv, 'report') || newestReport(ctx.REPORTS)
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(`[docpilot] no report to read — run \`npx docpilot eval --split=dev\` first (or pass --report=)`)
    return FAILED
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const records = new Map(readJsonl(ctx.GOLDEN).map((r) => [r.id, r]))
  const { readIndexDir } = await import('../server/index.js')
  let index
  try {
    index = readIndexDir(ctx.RAG)
  } catch (e) {
    console.error(`[docpilot] could not read the index at ${path.relative(ctx.ROOT, ctx.RAG)}: ${e?.message || e}`)
    return FAILED
  }
  if (report.meta?.indexHash && report.meta.indexHash !== index.manifest.hash) {
    console.error(
      `[docpilot] the report measured index ${report.meta.indexHash}, the index on disk is ${index.manifest.hash} — ` +
        're-run eval on this index first, or the plan names chunks that moved',
    )
    return FAILED
  }
  // `readIndexDir` → `assembleIndex` already installed the index's own
  // tokenizer and vocabulary, so `terms` here tokenises the way retrieval did.
  const { terms } = await import('../theme/docpilot/text.js')
  const { diagnose } = await import('./diagnose.js')
  const { planOf } = await import('./plan.js')
  const findings = diagnose({ rows: report.rows || [], records, chunks: index.chunks, terms, gateOnly: Boolean(report.meta?.gateOnly) })
  // Relative to the project when the docs are inside it, absolute when not —
  // `../../../..` is a path nobody can read.
  const shown = (p) => {
    const rel = path.relative(ctx.ROOT, p)
    return rel.startsWith('..') ? p : rel || '.'
  }
  const llmsCandidate = path.join(ctx.DOCS, 'public', 'llms.txt')
  const items = planOf(findings, {
    docsDir: shown(ctx.DOCS),
    llmsFile: fs.existsSync(llmsCandidate) ? shown(llmsCandidate) : null,
  })
  const meta = { report: path.relative(ctx.ROOT, reportPath), rows: (report.rows || []).length, split: report.meta?.split ?? null, findings: findings.length }
  const outDir = path.join(ctx.DOCPILOT_DIR, 'improve')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify({ meta, items, findings }, null, 2))
  fs.writeFileSync(path.join(outDir, 'plan.md'), renderPlan(items, meta))
  if (json) {
    console.log(JSON.stringify({ meta, items }, null, 2))
    return OK
  }
  console.log(`\n  improve — ${meta.findings} failing of ${meta.rows} records in ${meta.report}\n`)
  const counts = {}
  for (const f of findings) counts[f.cause] = (counts[f.cause] || 0) + 1
  for (const [cause, n] of Object.entries(counts)) console.log(`  ${cause.padEnd(18)} ${n}`)
  console.log('')
  for (const i of items.slice(0, 12)) console.log(`  ${i.id.padEnd(4)} ${i.lever.padEnd(18)} ${String(i.records.length).padStart(2)} rec  ${printable(i.page || '')}`)
  if (items.length > 12) console.log(`  … ${items.length - 12} more`)
  console.log(`\n  plan written to ${path.relative(ctx.ROOT, path.join(outDir, 'plan.md'))}\n`)
  return OK
}

const pctOf = (v) => (v == null ? '—' : `${(100 * v).toFixed(1)}%`)
const signed = (v) => (v == null ? '  —  ' : `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1)}`)
