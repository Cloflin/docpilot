/**
 * The eval scorecard — engine-spec 030.
 *
 * The numbers `eval` already prints, as one block: a value, the move since the
 * previous comparable report, coloured by whether that move is GOOD, and —
 * where the caller has the history — a sparkline of the metric across runs.
 *
 * TWO READERS, ONE RENDERER. The end of `eval` draws it on a terminal from the
 * summary it just computed and the report `writeReport` just paired it with;
 * `docpilot status` draws it from the newest report on disk. A second copy of
 * "which metrics, in which order, formatted how" would be the place the two
 * pictures of one run started to disagree.
 *
 * "BETTER" IS NOT DECIDED HERE. It is `HIGHER_IS_BETTER` / `LOWER_IS_BETTER`
 * in `src/eval/report.ts`, the same sets the report's own "change since the
 * previous run" table is coloured by in words.
 *
 * PURE: a summary, the previous one, a `Ui` in; lines out.
 */
import { HIGHER_IS_BETTER, LOWER_IS_BETTER } from './eval/report.js'
import { compact, count, delta, duration, pct, sparkline, table } from './cli-ui.js'
import type { Ui } from './cli-ui.js'

/**
 * The rows, in the order `printSummary` prints them. `answer` marks the ones a
 * gate-only run writes as zeros — it calls no model, so there is no answer to
 * score and a `0.000` there would read as a result.
 */
export const SCORECARD = [
  { key: 'retrievalF1', label: 'retrieval F1', fmt: 'ratio' },
  { key: 'recall8', label: 'recall@8', fmt: 'ratio' },
  { key: 'mrr', label: 'MRR', fmt: 'ratio' },
  // Printed by the summary only when the run scored them, and so here.
  { key: 'ndcg8', label: 'nDCG@8', fmt: 'ratio' },
  { key: 'contextPrecision5', label: 'ctx precision@5', fmt: 'ratio' },
  { key: 'answerF1', label: 'answer F1', fmt: 'ratio', answer: true },
  { key: 'identifierRecall', label: 'identifier recall', fmt: 'pct', answer: true },
  { key: 'citationPrecision', label: 'citation precision', fmt: 'pct', answer: true },
  { key: 'citationRecall', label: 'citation recall', fmt: 'pct', answer: true },
  { key: 'supportPrecision', label: 'support precision', fmt: 'ratio', answer: true },
  { key: 'unsupportedAnswerRate', label: 'unsupported answers', fmt: 'pct', answer: true },
  { key: 'language', label: 'language match', fmt: 'pct', answer: true },
  { key: 'gateOverRefusal', label: 'gate over-refusal', fmt: 'count', of: 'positives' },
  { key: 'answerOverRefusal', label: 'answer over-refusal', fmt: 'count', of: 'positives', answer: true },
  { key: 'negativesCaughtRate', label: 'negatives caught', fmt: 'pct' },
  { key: 'noAnswerPrecision', label: 'no-answer precision', fmt: 'pct' },
  { key: 'tokensPerAcceptedAnswer', label: 'tokens / answer', fmt: 'tokens', answer: true },
  { key: 'cachedShare', label: 'prompt from cache', fmt: 'pct', answer: true },
  { key: 'latencyP50', label: 'latency p50', fmt: 'ms', answer: true },
  { key: 'latencyP95', label: 'latency p95', fmt: 'ms', answer: true },
  { key: 'ttftP50', label: 'first token p50', fmt: 'ms', answer: true },
  { key: 'ttftP95', label: 'first token p95', fmt: 'ms', answer: true },
]

/** Which way is good for a metric, from the one place that says. */
export const betterOf = (key: string): 'higher' | 'lower' | null =>
  HIGHER_IS_BETTER.has(key) ? 'higher' : LOWER_IS_BETTER.has(key) ? 'lower' : null

/** How a value and the size of its move are written, per kind of number. */
const FORMATS = {
  ratio: { value: (v) => v.toFixed(3), delta: (a) => a.toFixed(3) },
  pct: { value: (v) => pct(v), delta: (a) => `${(a * 100).toFixed(1)}pp` },
  count: { value: (v) => count(v), delta: (a) => count(a) },
  tokens: { value: (v) => compact(v), delta: (a) => compact(a) },
  ms: { value: (v) => duration(v), delta: (a) => duration(a) },
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * The rows a summary has numbers for, each with its move and its history.
 *
 * @param prev the PAIRED report's summary — `writeReport`'s `prev`, or the one
 *   `status` pairs by the same rule — or null for the first run of its kind.
 *   A metric the previous run did not score has no delta rather than a delta
 *   from zero.
 * @param series per-metric values across comparable runs, oldest first.
 */
export function scorecardRows(
  summary,
  { prev = null, gateOnly = false, series = null }: { prev?: any; gateOnly?: boolean; series?: Record<string, Array<number | null>> | null } = {},
) {
  return SCORECARD.filter((row) => isNum(summary?.[row.key]) && !(gateOnly && row.answer)).map((row) => {
    const value = summary[row.key]
    const before = prev?.[row.key]
    return {
      key: row.key,
      label: row.label,
      fmt: row.fmt,
      value,
      of: row.of && isNum(summary[row.of]) ? summary[row.of] : null,
      delta: prev ? (isNum(before) ? value - before : null) : null,
      better: betterOf(row.key),
      series: series?.[row.key] ?? null,
    }
  })
}

/**
 * The two gates a run may not breach, as `run.ts`'s `hardGatesFailed` reads
 * them: any hallucinated citation, and any scope containment under 1.
 */
export function hardGates(summary, view: Ui): string {
  const { c, sym } = view
  const parts = []
  if (isNum(summary?.hallucinated)) {
    parts.push(
      summary.hallucinated > 0
        ? c.fail(`${sym.fail} hallucinated citations ${pct(summary.hallucinated)}`)
        : c.ok(`${sym.ok} hallucinated citations 0`),
    )
  }
  if (isNum(summary?.scopeContainment)) {
    parts.push(
      summary.scopeContainment < 1
        ? c.fail(`${sym.fail} scope containment ${summary.scopeContainment.toFixed(3)}`)
        : c.ok(`${sym.ok} scope containment ${summary.scopeContainment.toFixed(3)}`),
    )
  }
  return parts.join(c.muted(' · '))
}

/** The block itself: a header, one row per metric, and the hard gates under them. */
export function renderScorecard(
  rows: ReturnType<typeof scorecardRows>,
  { ui: view, trend = false, summary = null, indent = 2 }: { ui: Ui; trend?: boolean; summary?: any; indent?: number },
): string[] {
  const { c, unicode, color } = view
  const body = rows.map((r) => {
    const f = FORMATS[r.fmt]
    const value = r.of != null ? `${f.value(r.value)} of ${count(r.of)}` : f.value(r.value)
    const moved = r.delta == null ? c.muted('—') : delta(r.delta, r.better, { unicode, color, format: f.delta })
    const cells = [r.label, value, moved]
    if (trend) cells.push(r.series?.some(isNum) ? c.info(sparkline(r.series, { unicode })) : '')
    return cells
  })
  const head = ['metric', 'value', 'Δ', ...(trend ? ['trend'] : [])].map((h) => c.muted(h))
  const lines = table(body, { head, align: ['left', 'right', 'left', 'left'], indent })
  const gates = summary ? hardGates(summary, view) : ''
  if (gates) lines.push(`${' '.repeat(indent)}${gates}`)
  return lines
}
