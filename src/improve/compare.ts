/**
 * Did the edit help — two eval reports of the same records, before and after —
 * engine-spec 035.
 *
 * `docpilot model compare` answers this for two CHECKPOINTS and refuses when the
 * index hash moved, which is right there and wrong here: a corpus edit moves the
 * index hash by definition. What stays pinned is the population — the same
 * golden records, the same level, the same split — and the comparison is paired
 * by record id, so a question that was hard before is compared with itself.
 *
 * THE VERDICT IS THE RULE THE SKILL HAS ALWAYS STATED: a regression of more than
 * two percentage points on any metric is reverted. A change is kept only when
 * something moved for the better beyond noise — a bootstrap interval clear of
 * zero, or the McNemar test on the per-record outcome — and nothing moved for
 * the worse past the line. Everything else is `neutral`, and neutral is not a
 * reason to keep an edit nobody can show helped.
 *
 * A GATE-ONLY PAIR IS NOT A SAMPLE. It calls no model, so the same corpus ranks
 * the same records the same way on every run: a record that ranked better is the
 * edit's effect, not a draw. There an edit is also kept when it is a Pareto
 * move — some record better on some metric, none worse on any. The interval
 * rule alone could never keep a targeted fix: two questions fixed out of thirty,
 * nothing worse, leaves a bootstrap lower bound of exactly zero (measured on
 * DocPilot's own docs, spec 036).
 */

import { LOW_ANSWER_F1 } from '../eval/metrics.js'
import { mcnemarExact, pairedBootstrap } from '../model/stats.js'

export const COMPARED = [
  { key: 'recall8', label: 'recall@8' },
  { key: 'recall5', label: 'recall@5' },
  { key: 'mrr', label: 'MRR' },
  { key: 'ndcg8', label: 'nDCG@8' },
  { key: 'contextPrecision5', label: 'context precision@5' },
  { key: 'answerF1', label: 'answer F1' },
  { key: 'identifierRecall', label: 'identifier recall' },
  { key: 'citationPrecision', label: 'citation precision' },
  { key: 'citationRecall', label: 'citation recall' },
]

/**
 * The per-record outcome McNemar counts. A negative is right when it is
 * refused — for ANY cause: with the guard off only the model refuses, and its
 * refusal is `not-answerable`, which the exact-cause rule in `model/compare.ts`
 * counted as wrong on every negative of every run.
 */
export function okOf(r) {
  const negative = String(r.expect).startsWith('refuse') || r.scoredAsNegative
  if (negative) return String(r.observed).startsWith('refuse')
  if (r.observed !== 'answer') return false
  if (typeof r.answerF1 === 'number' && r.answerF1 < LOW_ANSWER_F1) return false
  if (typeof r.citationPrecision === 'number' && r.citationPrecision < 0.5) return false
  return true
}

export function compareRuns(before, after, { maxRegression = 0.02, seed = 1, resamples = 4000 } = {}) {
  const byId = new Map((after?.rows || []).map((r) => [r.id, r]))
  const pairs = (before?.rows || []).filter((r) => byId.has(r.id)).map((r) => [r, byId.get(r.id)])

  let b = 0
  let c = 0
  const worse = []
  const better = []
  for (const [x, y] of pairs) {
    const ox = okOf(x)
    const oy = okOf(y)
    if (ox && !oy) {
      b++
      worse.push(x.id)
    } else if (!ox && oy) {
      c++
      better.push(x.id)
    }
  }
  const n = pairs.length
  const ok = {
    before: n ? pairs.filter(([x]) => okOf(x)).length / n : null,
    after: n ? pairs.filter(([, y]) => okOf(y)).length / n : null,
  }
  const p = mcnemarExact(b, c)

  const metrics = []
  for (const m of COMPARED) {
    const d = pairs
      .filter(([x, y]) => typeof x[m.key] === 'number' && typeof y[m.key] === 'number')
      .map(([x, y]) => y[m.key] - x[m.key])
    if (!d.length) continue
    const ci = pairedBootstrap(d, { resamples, seed })
    metrics.push({
      ...m,
      n: ci.n,
      delta: ci.mean,
      lo: ci.lo,
      hi: ci.hi,
      improved: ci.lo > 0,
      regressed: ci.mean < -maxRegression,
    })
  }

  const reasons = []
  const regressions = metrics.filter((m) => m.regressed)
  for (const m of regressions) reasons.push(`${m.label} fell ${(100 * -m.delta).toFixed(1)} points, past the ${(100 * maxRegression).toFixed(0)}-point line`)
  if (ok.after != null && ok.before != null && ok.after - ok.before < -maxRegression) {
    reasons.push(`the share of records ending right fell ${(100 * (ok.before - ok.after)).toFixed(1)} points`)
  }
  const gains = metrics.filter((m) => m.improved)
  for (const m of gains) reasons.push(`${m.label} rose ${(100 * m.delta).toFixed(1)} points, 95% interval [${(100 * m.lo).toFixed(1)}, ${(100 * m.hi).toFixed(1)}]`)
  if (p < 0.05 && c > b) reasons.push(`${c} records went from wrong to right and ${b} the other way (McNemar p = ${p.toFixed(3)})`)

  const deterministic = Boolean(before?.meta?.gateOnly && after?.meta?.gateOnly)
  const moved = (sign) =>
    pairs
      .filter(([x, y]) => COMPARED.some((m) => typeof x[m.key] === 'number' && typeof y[m.key] === 'number' && sign * (y[m.key] - x[m.key]) > 1e-9))
      .map(([x]) => x.id)
  const ranked = { better: moved(1), worse: moved(-1) }
  const pareto = deterministic && ranked.better.length > 0 && ranked.worse.length === 0 && b === 0
  if (pareto) reasons.push(`${ranked.better.length} record${ranked.better.length === 1 ? '' : 's'} ranked better and none worse — a gate-only run is deterministic, so that is the edit's effect, not noise`)

  const verdict = reasons.some((r) => /fell/.test(r)) ? 'revert' : gains.length || (p < 0.05 && c > b) || pareto ? 'keep' : 'neutral'
  return { pairs: n, ok, mcnemar: { b, c, p }, worse, better, deterministic, ranked, metrics, verdict, reasons }
}
