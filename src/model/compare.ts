/**
 * `compare` — did the candidate checkpoint get worse on THIS documentation? PURE.
 *
 * THE INPUTS ARE TWO `docpilot eval` REPORTS, run against two endpoints that
 * differ only in the weights behind them. Everything else must be held still,
 * and three hashes in `meta` say whether it was:
 *
 *   indexHash   the chunks retrieval returned from
 *   promptHash  the system prompt the model read
 *   goldenSha   the questions and gold answers it was scored on
 *
 * If one differs, a delta measures that change plus the model, and nothing
 * here can separate the two. So the comparison is REFUSED, and
 * `allowIncomparable` turns the refusal into a warning printed at the top of
 * the report. Absent reads as unknown and pairs — the rule `eval`'s own
 * `previousReport` uses for `goldenSha`, so an old report is not a wolf-cry.
 *
 * ONE BINARY OUTCOME PER RECORD, `ok`: the record ended the way the golden set
 * expected (answer vs. refusal), and when an answer was expected it cited at
 * least half right and invented no citation. That is what a reader feels; the
 * continuous metrics get bootstrap intervals beside it.
 */

import {mcnemarExact, mcnemarMinFlips, pairedBootstrap} from './stats.js'
import {printable} from '../build/lib/terminal.js'

/** Each one, if it differs, makes the delta measure more than the model. */
export const PINNED = ['indexHash', 'promptHash', 'goldenSha']

/** These differ legitimately less often; a difference is printed, not refused. */
const NOTED = ['embedModel', 'level', 'gateOnly', 'lexical', 'maxIterations', 'numCtx']

/** Continuous metrics with a bootstrap CI. `better` says which direction is an improvement. */
export const METRICS = [
  {key: 'answerF1', get: (r) => r.answerF1, better: 'higher'},
  {key: 'citationPrecision', get: (r) => r.citationPrecision, better: 'higher'},
  {key: 'citationRecall', get: (r) => r.citationRecall, better: 'higher'},
  {key: 'recall8', get: (r) => r.recall8, better: 'higher'},
  {key: 'latencyMs', get: (r) => r.latencyMs, better: 'lower'},
  {key: 'promptTokens', get: (r) => r.cost?.promptTokens, better: 'lower'},
]

/**
 * `eval`'s own reading of "ended the way the golden set expected" — `expectEff`
 * and the MISS line in `src/eval/run.ts`, restated because that module starts a
 * CLI on import. Any refusal settles a negative: authored causes are
 * `refuse:no-evidence` and `refuse:out-of-scope`, while a model-side refusal —
 * every refusal under `guard.mode: 'off'` — observes `refuse:not-answerable`.
 * Demanding the exact cause scored those correct refusals not-ok on both
 * sides, so a candidate that stopped refusing showed no flip at all. A
 * positive whose gold is outside its own scope (`scoredAsNegative`) is one.
 */
export function isOk(r) {
  const expect = r.scoredAsNegative ? 'refuse:out-of-scope' : r.expect
  if (String(expect).startsWith('refuse')) return String(r.observed).startsWith('refuse')
  if (r.observed !== expect) return false
  if (expect !== 'answer') return true
  return (r.citationPrecision ?? 0) >= 0.5 && !(r.hallucinated > 0) && r.unlinked !== true
}

/** The pinned and noted fields that differ between two report metas. */
export function incomparability(baseMeta = {}, candMeta = {}) {
  const diff = (keys) =>
    keys
      .filter((k) => baseMeta[k] != null && candMeta[k] != null && JSON.stringify(baseMeta[k]) !== JSON.stringify(candMeta[k]))
      .map((k) => ({field: k, base: baseMeta[k], candidate: candMeta[k]}))
  return {refused: diff(PINNED), noted: diff(NOTED)}
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * @param base a parsed `docpilot eval` report
 * @param candidate the same, for the candidate weights
 * @param o.baseManifest / o.candidateManifest parsed `fingerprint` manifests
 */
export function compareReports(
  base,
  candidate,
  o: {
    alpha?: number
    maxRegression?: number
    seed?: number
    resamples?: number
    allowIncomparable?: boolean
    baseManifest?: any
    candidateManifest?: any
  } = {},
) {
  const {alpha = 0.05, maxRegression = 0.02, seed = 1, resamples = 10_000, allowIncomparable = false} = o
  const {refused, noted} = incomparability(base?.meta, candidate?.meta)
  const weights = {
    base: weightsOf(base?.meta, o.baseManifest),
    candidate: weightsOf(candidate?.meta, o.candidateManifest),
  }
  if (refused.length && !allowIncomparable) {
    return {refused: true, incomparable: refused, noted, weights}
  }

  const byId = new Map((candidate.rows || []).map((r) => [r.id, r]))
  const pairs = []
  for (const b of base.rows || []) if (byId.has(b.id)) pairs.push([b, byId.get(b.id)])
  const paired = new Set(pairs.map(([b]) => b.id))
  const unpaired = {
    base: (base.rows || []).filter((r) => !paired.has(r.id)).length,
    candidate: (candidate.rows || []).filter((r) => !paired.has(r.id)).length,
  }

  let b = 0
  let c = 0
  let baseOk = 0
  let candOk = 0
  const flipped = {worse: [], better: []}
  for (const [x, y] of pairs) {
    const ox = isOk(x)
    const oy = isOk(y)
    baseOk += +ox
    candOk += +oy
    if (ox && !oy) {
      b++
      flipped.worse.push(flipRow(x, y))
    } else if (!ox && oy) {
      c++
      flipped.better.push(flipRow(x, y))
    }
  }
  const n = pairs.length
  const okRate = {base: n ? baseOk / n : null, candidate: n ? candOk / n : null, delta: n ? (candOk - baseOk) / n : null}
  const p = mcnemarExact(b, c)

  const metrics = {}
  for (const m of METRICS) {
    const deltas = []
    for (const [x, y] of pairs) {
      const vx = num(m.get(x))
      const vy = num(m.get(y))
      if (vx != null && vy != null) deltas.push(vy - vx)
    }
    metrics[m.key] = {...pairedBootstrap(deltas, {seed, resamples}), better: m.better}
  }

  const f1 = metrics['answerF1']
  const dropped = okRate.delta != null && okRate.delta < -maxRegression && p < alpha
  const rose = okRate.delta != null && okRate.delta > maxRegression && p < alpha
  const reasons = []
  if (dropped) reasons.push(`ok-rate fell ${pp(-okRate.delta)} (> ${pp(maxRegression)}) with McNemar p = ${fmtP(p)} < ${alpha}`)
  if (f1.hi != null && f1.hi < 0) reasons.push(`answerF1 95% CI [${f3(f1.lo)}, ${f3(f1.hi)}] lies below zero`)
  let verdict = 'no-significant-difference'
  if (reasons.length) verdict = 'regression'
  else {
    // A regression on either measure wins over an improvement on the other: a
    // CI gate should stop on the evidence that something got worse.
    if (rose) reasons.push(`ok-rate rose ${pp(okRate.delta)} (> ${pp(maxRegression)}) with McNemar p = ${fmtP(p)} < ${alpha}`)
    if (f1.lo != null && f1.lo > 0) reasons.push(`answerF1 95% CI [${f3(f1.lo)}, ${f3(f1.hi)}] lies above zero`)
    if (reasons.length) verdict = 'improvement'
  }

  const minFlips = mcnemarMinFlips(alpha)
  const resolution = {
    pairs: n,
    minFlips,
    minDetectableOkDelta: n ? minFlips / n : null,
    answerF1CiWidth: f1.lo != null ? f1.hi - f1.lo : null,
  }

  return {
    refused: false,
    incomparable: refused,
    noted,
    weights,
    params: {alpha, maxRegression, seed, resamples},
    pairs: n,
    unpaired,
    okRate,
    mcnemar: {b, c, p},
    metrics,
    verdict,
    reasons,
    resolution,
    flipped,
  }
}

function flipRow(x, y) {
  return {
    id: x.id,
    question: x.question ?? y.question ?? null,
    expect: x.expect,
    base: {observed: x.observed, citationPrecision: x.citationPrecision ?? null, hallucinated: x.hallucinated ?? null},
    candidate: {observed: y.observed, citationPrecision: y.citationPrecision ?? null, hallucinated: y.hallucinated ?? null},
  }
}

/** What the report can say about WHICH weights produced it. */
function weightsOf(meta, manifest) {
  return {
    model: meta?.model ?? null,
    provider: meta?.provider ?? null,
    ranAt: meta?.ranAt ?? null,
    digest: manifest?.digest ?? null,
    summary: manifest?.summary ?? null,
  }
}

const pp = (x) => `${(x * 100).toFixed(1)} pp`
const f3 = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(3))
const fmtP = (p) => (p < 0.001 ? p.toExponential(2) : p.toFixed(4))
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)

function fmtMetric(key, x) {
  if (x == null) return '—'
  if (key === 'latencyMs') return `${x >= 0 ? '+' : ''}${Math.round(x)} ms`
  if (key === 'promptTokens') return `${x >= 0 ? '+' : ''}${Math.round(x)}`
  return f3(x)
}

function weightsLine(label, w) {
  const s = w.summary
  const params = s?.parameters ? `${(s.parameters / 1e9).toFixed(2)}B params` : null
  // name, arch, format and base are copied out of the model file's own
  // metadata: escaped, so the report cannot drive the terminal it is printed to.
  const p = printable
  const bits = [
    w.model && `model \`${p(w.model)}\``,
    w.provider && `via ${p(w.provider)}`,
    s?.name && `name ${p(s.name)}`,
    s?.architecture && `arch ${p(s.architecture)}`,
    params,
    s?.format && p(s.format),
    s?.adapter ? `adapter on ${p(s.base ?? 'unknown base')}` : null,
    w.digest ? `digest \`${w.digest.slice(0, 16)}…\`` : 'no manifest — the weights are named, not identified',
  ].filter(Boolean)
  return `- **${label}**: ${bits.join(' · ')}`
}

/** The markdown report. PURE — the caller writes it. */
export function renderCompare(r, meta: {base?: string; candidate?: string; generatedAt?: string} = {}) {
  const out = []
  out.push('# Model comparison')
  out.push('')
  if (meta.generatedAt) out.push(`_Generated ${meta.generatedAt}. Base: ${meta.base ?? '?'} · candidate: ${meta.candidate ?? '?'}._\n`)

  if (r.incomparable?.length) {
    out.push(r.refused ? '## REFUSED — the reports are not comparable' : '## WARNING — the reports are not comparable')
    out.push('')
    for (const d of r.incomparable) out.push(`- \`meta.${d.field}\`: ${d.base} → ${d.candidate}`)
    out.push('')
    out.push(
      'A delta between these reports measures that change plus the model, and nothing here can separate the two. ' +
        (r.refused
          ? 'Re-run both evals on the same index, prompt and golden set, or pass `--allow-incomparable` to see the numbers anyway.'
          : 'The numbers below were produced under `--allow-incomparable`. Do not read them as a model comparison.'),
    )
    out.push('')
  }

  out.push('## Weights measured')
  out.push('')
  out.push(weightsLine('base', r.weights.base))
  out.push(weightsLine('candidate', r.weights.candidate))
  if (r.weights.base.digest && r.weights.base.digest === r.weights.candidate.digest) {
    out.push('')
    out.push('Both manifests have the SAME digest: these are the same weights, and any difference below is run-to-run noise.')
  }
  out.push('')
  if (r.refused) return out.join('\n') + '\n'

  if (r.noted.length) {
    out.push('Also differs (not refused, but read the numbers with it in mind):')
    for (const d of r.noted) out.push(`- \`meta.${d.field}\`: ${JSON.stringify(d.base)} → ${JSON.stringify(d.candidate)}`)
    out.push('')
  }

  out.push(`## Verdict: **${r.verdict}**`)
  out.push('')
  for (const why of r.reasons) out.push(`- ${why}`)
  if (!r.reasons.length) out.push('- Neither the ok-rate test nor the answerF1 interval separates the two checkpoints.')
  out.push('')

  out.push('## Outcome per record')
  out.push('')
  out.push(`${r.pairs} records paired by id` + (r.unpaired.base || r.unpaired.candidate ? ` (ignored: ${r.unpaired.base} only in base, ${r.unpaired.candidate} only in candidate)` : '') + '.')
  out.push('')
  out.push('| | base | candidate | delta |')
  out.push('| --- | --- | --- | --- |')
  out.push(`| ok-rate | ${pct(r.okRate.base)} | ${pct(r.okRate.candidate)} | ${r.okRate.delta == null ? '—' : pp(r.okRate.delta)} |`)
  out.push('')
  out.push(
    `McNemar exact (two-sided): ${r.mcnemar.b} record(s) got worse, ${r.mcnemar.c} got better, p = ${fmtP(r.mcnemar.p)}. ` +
      '`ok` = the record ended as expected, and an expected answer cited at least half right with no invented citation.',
  )
  out.push('')

  out.push('## Continuous metrics (candidate − base, paired bootstrap 95% CI)')
  out.push('')
  out.push('| metric | n | mean delta | 95% CI | better |')
  out.push('| --- | --- | --- | --- | --- |')
  for (const [k, m] of Object.entries<any>(r.metrics)) {
    out.push(`| ${k} | ${m.n} | ${fmtMetric(k, m.mean)} | [${fmtMetric(k, m.lo)}, ${fmtMetric(k, m.hi)}] | ${m.better} |`)
  }
  out.push('')

  const res = r.resolution
  out.push('## What this golden set can see')
  out.push('')
  out.push(
    `With ${res.pairs} pairs, McNemar needs at least ${res.minFlips} records to flip in one direction, with none the other way, ` +
      `to reach p < ${r.params.alpha}. An ok-rate change smaller than ${pct(res.minDetectableOkDelta)} can never be called ` +
      'significant here, whatever its true size' +
      (res.answerF1CiWidth != null ? `, and the answerF1 interval is ${res.answerF1CiWidth.toFixed(3)} wide` : '') +
      '. "No significant difference" on a small set means "not measured", not "equal". Add golden records to see smaller deltas.',
  )
  out.push('')

  const flips = (title, rows) => {
    out.push(`## ${title} (${rows.length})`)
    out.push('')
    if (!rows.length) {
      out.push('_None._\n')
      return
    }
    out.push('| id | question | expect | base | candidate |')
    out.push('| --- | --- | --- | --- | --- |')
    const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\s+/g, ' ')
    const side = (x) => `${x.observed}${x.citationPrecision != null ? `, cp ${x.citationPrecision.toFixed(2)}` : ''}${x.hallucinated > 0 ? `, ${x.hallucinated} invented` : ''}`
    for (const f of rows) out.push(`| ${cell(f.id)} | ${cell(f.question)} | ${f.expect} | ${side(f.base)} | ${side(f.candidate)} |`)
    out.push('')
  }
  flips('Got worse (base ok → candidate not)', r.flipped.worse)
  flips('Got better (base not ok → candidate ok)', r.flipped.better)
  return out.join('\n')
}
