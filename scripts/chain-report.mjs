#!/usr/bin/env node
/**
 * Reads what scripts/chain-bench.mjs wrote and prints the five-arm comparison.
 *
 * Per arm and per turn kind: the mean over every (chain, run), the spread of the
 * five run means (how much a rerun moves it), and the difference to the control
 * arm with a 95 % bootstrap interval over (chain, run) pairs — paired, because
 * the same chain is hard or easy in every arm. An interval that crosses zero is
 * not a difference.
 *
 *   node scripts/chain-report.mjs <out dir> [--control=skeleton] [--json=<file>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { mulberry32 } from '../dist/model/stats.js'

const dir = process.argv[2]
const argOf = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const CONTROL = argOf('control', 'skeleton')
const ARMS = ['skeleton', 'last-full', 'summary-all+last', 'summary-each+last', 'summary-only']
const KINDS = ['base', 'transform', 'relate', 'clarify', 'switch']
const METRICS = {
  answerF1: { kinds: KINDS },
  mustContain: { kinds: KINDS },
  mustKeep: { kinds: ['transform'] },
  citationRecall: { kinds: KINDS },
  leak: { kinds: ['switch'], lowerIsBetter: true },
}

const rows = []
for (const f of fs.readdirSync(dir).filter((f) => /\.run\d+\.jsonl$/.test(f))) {
  for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) rows.push(JSON.parse(l))
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const sd = (xs) => {
  const m = mean(xs)
  return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : NaN
}
/** value of `metric` on turn `kind` for one (arm, chain, run), or null */
const at = new Map()
for (const r of rows) for (const t of r.turns) at.set(`${r.arm}|${r.id}|${r.run}|${t.kind}`, t)
const val = (arm, id, run, kind, metric) => {
  const v = at.get(`${arm}|${id}|${run}|${kind}`)?.[metric]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
const chains = [...new Set(rows.map((r) => r.id))].sort()
const runs = [...new Set(rows.map((r) => r.run))].sort()

// Seeded, so a rerun prints the same interval — and 32-bit, which the LCG this
// replaced was not: `seed * 1103515245` passes 2^53, the double drops the low
// bits before the mask, and the stream repeated after 14 470 draws, inside
// one interval of 4000 resamples.
const rnd = mulberry32(7)
function bootstrap(diffs, n = 4000) {
  if (diffs.length < 2) return [NaN, NaN]
  const ms = []
  for (let b = 0; b < n; b++) {
    let s = 0
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rnd() * diffs.length)]
    ms.push(s / diffs.length)
  }
  ms.sort((a, b) => a - b)
  return [ms[Math.floor(0.025 * n)], ms[Math.floor(0.975 * n)]]
}

const out = { dir, chains: chains.length, runs: runs.length, rows: rows.length, control: CONTROL, table: [] }
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  —  ')
const sgn = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : '  —  ')

console.log(`${rows.length} chain runs · ${chains.length} chains · runs ${runs.join(',')} · control ${CONTROL}\n`)
for (const [metric, { kinds, lowerIsBetter }] of Object.entries(METRICS)) {
  for (const kind of kinds) {
    console.log(`${metric} · ${kind}${lowerIsBetter ? '  (lower is better)' : ''}`)
    for (const arm of ARMS) {
      const all = []
      const perRun = []
      for (const run of runs) {
        const xs = chains.map((id) => val(arm, id, run, kind, metric)).filter((x) => x !== null)
        if (xs.length) perRun.push(mean(xs))
        all.push(...xs)
      }
      const diffs = []
      for (const run of runs)
        for (const id of chains) {
          const a = val(arm, id, run, kind, metric)
          const c = val(CONTROL, id, run, kind, metric)
          if (a !== null && c !== null) diffs.push(a - c)
        }
      const [lo, hi] = arm === CONTROL ? [NaN, NaN] : bootstrap(diffs)
      const d = arm === CONTROL ? NaN : mean(diffs)
      const sig = Number.isFinite(lo) && (lo > 0 || hi < 0) ? ((lowerIsBetter ? hi < 0 : lo > 0) ? '  better' : '  WORSE') : ''
      console.log(
        `  ${arm.padEnd(18)} ${f3(mean(all))}  ±run ${f3(sd(perRun))}   Δ ${sgn(d)} [${sgn(lo)}, ${sgn(hi)}]${sig}   n=${all.length}`,
      )
      out.table.push({ metric, kind, arm, mean: mean(all), runSd: sd(perRun), delta: d, ci: [lo, hi], n: all.length })
    }
    console.log('')
  }
}

// Cost: what each arm spends per turn, prompt-side.
console.log('requests per chain')
for (const arm of ARMS) {
  const rs = rows.filter((r) => r.arm === arm)
  console.log(`  ${arm.padEnd(18)} ${f3(mean(rs.map((r) => r.turns.reduce((a, t) => a + (t.requests || 0), 0))))}   summaries written ${f3(mean(rs.flatMap((r) => r.turns.map((t) => (t.summarised ? 1 : 0)))))}`)
}
const json = argOf('json')
if (json) fs.writeFileSync(json, JSON.stringify(out, null, 1))
