#!/usr/bin/env node
/**
 * results/*.json → results/RESULTS.md and results/results.json.
 *
 * Every number printed is read from an eval report `bench/run.mjs` saved; the
 * paired intervals are computed here, from the reports' own rows, with the same
 * bootstrap `docpilot improve compare` uses.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'harborline', 'results')
const { pairedBootstrap } = await import(path.resolve(HERE, '..', 'dist', 'model', 'stats.js'))

const read = (f) => {
  const p = path.join(RESULTS, f)
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}
const files = fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS) : []
const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : '—')
const pct = (v) => (typeof v === 'number' ? `${(100 * v).toFixed(0)}%` : '—')
const sec = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '—')

function paired(a, b, key) {
  if (!a || !b) return null
  const by = new Map(b.rows.map((r) => [r.id, r]))
  const d = a.rows.filter((r) => typeof r[key] === 'number' && typeof by.get(r.id)?.[key] === 'number').map((r) => by.get(r.id)[key] - r[key])
  if (!d.length) return null
  return pairedBootstrap(d, { resamples: 4000, seed: 7 })
}
const delta = (ci) => (ci ? `${ci.mean >= 0 ? '+' : ''}${ci.mean.toFixed(3)} [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]${ci.lo > 0 || ci.hi < 0 ? ' *' : ''}` : '—')

const out = ['# Harborline — DocPilot 2.0 measured', '']
const json = { retrieval: {}, perf: read('perf.json'), answers: {}, security: {} }

// ── retrieval ───────────────────────────────────────────────────────────────
const RK = ['recall1', 'recall3', 'recall5', 'recall8', 'mrr', 'ndcg8', 'contextPrecision5']
const arms = [...new Set(files.filter((f) => /^retrieval-.*-(dev|test)\.json$/.test(f)).map((f) => f.replace(/^retrieval-/, '').replace(/-(dev|test)\.json$/, '')))]
if (arms.length) {
  out.push('## Retrieval (gate-only, bge-m3, test split)', '')
  out.push(`| arm | ${RK.join(' | ')} | ΔnDCG@8 vs base | ΔMRR vs base |`)
  out.push(`|---|${RK.map(() => '---').join('|')}|---|---|`)
  const base = read('retrieval-base-test.json')
  for (const a of arms) {
    const r = read(`retrieval-${a}-test.json`)
    if (!r) continue
    const vsBase = a === 'base' ? null : { ndcg8: paired(base, r, 'ndcg8'), mrr: paired(base, r, 'mrr') }
    json.retrieval[a] = { test: r.summary, dev: read(`retrieval-${a}-dev.json`)?.summary ?? null, vsBase }
    out.push(`| ${a} | ${RK.map((k) => fmt(r.summary[k])).join(' | ')} | ${vsBase ? delta(vsBase.ndcg8) : '—'} | ${vsBase ? delta(vsBase.mrr) : '—'} |`)
  }
  out.push('', '`*` — the paired 95% bootstrap interval excludes zero.', '')
}

// ── bytes ───────────────────────────────────────────────────────────────────
if (json.perf?.length) {
  out.push('## What a reader downloads (static install)', '')
  out.push('| arm | raw | on the wire (brotli) | of which vectors |', '|---|---|---|---|')
  for (const p of json.perf) out.push(`| ${p.arm} | ${p.rawKB} KB | ${p.wireKB} KB | ${p.vectorsWireKB} KB |`)
  out.push('')
}

// ── answers ─────────────────────────────────────────────────────────────────
// Releases first, then the 2.0 server variants, the default before its alternative.
const ORDER = ['v1.5-static', 'v2.0-static', 'v2.0-server', 'v2.0-server-agentic', 'v2.0-static-calibrated', 'v2.0-server-calibrated']
const ordered = (names) => [...names].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))
const systems = ordered(files.filter((f) => /^answers-.*\.json$/.test(f)).map((f) => f.replace(/^answers-/, '').replace(/\.json$/, '')))
if (systems.length) {
  out.push('## Answers (golden set, local model)', '')
  out.push('| system | answer F1 | ΔF1 vs 1.5 | identifiers | citation P | citation R | negatives caught | over-refusal | p50 | p95 | first token p50 | requests/turn |')
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  const v15 = read('answers-v1.5-static.json')
  for (const s of systems) {
    const r = read(`answers-${s}.json`)
    if (!r) continue
    const m = r.summary
    const vs15 = s === 'v1.5-static' ? null : { answerF1: paired(v15, r, 'answerF1'), citationRecall: paired(v15, r, 'citationRecall') }
    json.answers[s] = { meta: { model: r.meta?.model, runtime: r.meta?.runtime ?? 'browser', records: r.meta?.records }, summary: m, vs15 }
    out.push(
      `| ${s} | ${fmt(m.answerF1)} | ${vs15 ? delta(vs15.answerF1) : '—'} | ${pct(m.identifierRecall)} | ${pct(m.citationPrecision)} | ${pct(m.citationRecall)} | ${pct(m.negativesCaughtRate)} | ${m.answerOverRefusal ?? '—'}/${m.positives} | ${sec(m.latencyP50)} | ${sec(m.latencyP95)} | ${sec(m.ttftP50)} | ${fmt(m.requestsPerTurn, 2)} |`,
    )
  }
  out.push('', 'ΔF1 is paired by record against `v1.5 static`; `*` marks an interval that excludes zero.', '')
}

// ── security ────────────────────────────────────────────────────────────────
const sec2 = ordered(files.filter((f) => /^security-.*\.json$/.test(f)).map((f) => f.replace(/^security-/, '').replace(/\.json$/, '')))
if (sec2.length) {
  out.push('## Security probes', '')
  out.push('| system | probes | attack success | refused when it should | answered safely | breaches |', '|---|---|---|---|---|---|')
  for (const s of sec2) {
    const a = read(`security-${s}.json`)?.summary?.adversarial
    if (!a) continue
    json.security[s] = a
    out.push(`| ${s} | ${a.probes} | ${pct(a.attackSuccessRate)} | ${pct(a.refusalAccuracy)} | ${pct(a.safeAnswerRate)} | ${a.breaches.join(', ') || '—'} |`)
  }
  out.push('')
}

fs.mkdirSync(RESULTS, { recursive: true })
fs.writeFileSync(path.join(RESULTS, 'RESULTS.md'), `${out.join('\n')}\n`)
fs.writeFileSync(path.join(RESULTS, 'results.json'), JSON.stringify(json, null, 2))
console.log(out.join('\n'))
