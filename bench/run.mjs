#!/usr/bin/env node
/**
 * The 2.0 benchmark on Harborline — every claim in the comparison report is
 * produced by this script and nothing else.
 *
 *   node bench/run.mjs index        build one index per arm
 *   node bench/run.mjs calibrate    fit the gate on eval/calibration.jsonl for the calibrated arm
 *   node bench/run.mjs retrieval    eval --gate-only per arm (free, minutes)
 *   node bench/run.mjs answers      the golden set answered, per system (hours on a local model)
 *   node bench/run.mjs security     the adversarial probes, per system
 *   node bench/run.mjs perf         what a reader downloads and computes, per index
 *   node bench/run.mjs report       results/RESULTS.md from everything above
 *
 * An ARM is an index build (how the corpus is chunked, embedded and stored); a
 * SYSTEM is an arm answered by one runtime of one release. `v1.5` runs the
 * released CLI from a worktree of `main` (BASELINE_ROOT), so the baseline is the
 * code that shipped, not a model of it.
 *
 * Environment: OLLAMA_BASE_URL (default the local Ollama), HARBORLINE_CHAT_MODEL
 * (default qwen3:8b), BENCH_LEVEL (default high — 65 golden records), and
 * BASELINE_ROOT (a built checkout of 1.5).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'harborline')
const RESULTS = path.join(FIXTURE, 'results')
const V2 = path.resolve(HERE, '..', 'bin', 'docpilot.js')
const V15 = process.env.BASELINE_ROOT ? path.join(process.env.BASELINE_ROOT, 'bin', 'docpilot.js') : null
const LEVEL = process.env.BENCH_LEVEL || 'high'

/** Index arms. `cli` picks the release that builds it. */
export const ARMS = {
  'v1.5': { cli: 'v1.5', dir: 'docs/public/rag-v15', env: {}, args: [] },
  base: { cli: 'v2', dir: 'docs/public/rag', env: {}, args: [] },
  binary: { cli: 'v2', dir: 'docs/public/rag-binary', env: {}, args: ['--quantize=binary'] },
  'ctx-path': { cli: 'v2', dir: 'docs/public/rag-ctx-path', env: { DOCPILOT_EMBED_CONTEXT: 'path' }, args: [] },
  'ctx-desc': { cli: 'v2', dir: 'docs/public/rag-ctx-desc', env: { DOCPILOT_EMBED_CONTEXT: 'path+desc' }, args: [] },
  llms: { cli: 'v2', dir: 'docs/public/rag-llms', env: { DOCPILOT_LLMS_FILE: 'truth/llms.reference.txt' }, args: [] },
  // The 2.0 default index with the gate's refusals on: thresholds fitted by
  // `calibrate` on eval/calibration.jsonl, which shares no question with the
  // golden set the answers are scored on — or, where calibration fails as it
  // does on Harborline, the provisional tau the build inlines instead.
  calibrated: { cli: 'v2', dir: 'docs/public/rag-calibrated', env: { HARBORLINE_GUARD_MODE: 'calibrated' }, args: [], calibrate: true },
}

/** Answering systems: an arm, a runtime, a release, and the env of its turn policy. */
export const SYSTEMS = {
  'v1.5 static': { arm: 'v1.5', cli: 'v1.5', runtime: 'browser', env: {} },
  'v2.0 static': { arm: 'base', cli: 'v2', runtime: 'browser', env: {} },
  // The 2.0 server default: one-shot, no reasoning before the answer (engine-spec 031).
  'v2.0 server': { arm: 'base', cli: 'v2', runtime: 'server', env: {} },
  // The 1.x server turn, kept as the measured alternative.
  'v2.0 server agentic': { arm: 'base', cli: 'v2', runtime: 'server', env: { DOCPILOT_SERVER_LOOP: 'agentic' } },
  // The gate on (guard.mode 'calibrated'), every other setting as above.
  'v2.0 static calibrated': { arm: 'calibrated', cli: 'v2', runtime: 'browser', env: { HARBORLINE_GUARD_MODE: 'calibrated' } },
  'v2.0 server calibrated': { arm: 'calibrated', cli: 'v2', runtime: 'server', env: { HARBORLINE_GUARD_MODE: 'calibrated' } },
}

const binOf = (cli) => {
  if (cli === 'v2') return V2
  if (!V15 || !fs.existsSync(V15)) throw new Error('BASELINE_ROOT must name a built checkout of 1.5 for the v1.5 arm')
  return V15
}

function cli(which, args, env = {}) {
  const r = spawnSync(process.execPath, [binOf(which), ...args], {
    cwd: FIXTURE,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  })
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

/** The report path an eval run printed last. */
const reportOf = (out) => {
  const m = [...out.matchAll(/report written to (\S+)/g)].pop()
  return m ? path.resolve(FIXTURE, m[1]) : null
}

function save(name, out, file) {
  fs.mkdirSync(RESULTS, { recursive: true })
  fs.writeFileSync(path.join(RESULTS, `${name}.log`), out)
  if (file && fs.existsSync(file)) fs.copyFileSync(file, path.join(RESULTS, `${name}.json`))
  return file
}

const slug = (s) => s.replace(/[^\w.-]+/g, '-')

const steps = {
  index(which = null) {
    for (const [name, a] of Object.entries(ARMS)) {
      if (which && name !== which) continue
      if (a.cli === 'v1.5' && !V15) {
        console.log(`  skip ${name}: no BASELINE_ROOT`)
        continue
      }
      const r = cli(a.cli, ['index', '--yes', ...a.args], { ...a.env, HARBORLINE_INDEX_DIR: a.dir })
      save(`index-${slug(name)}`, r.out)
      const wire = /(\d+) KB on the wire/.exec(r.out)?.[1]
      console.log(`  ${name.padEnd(10)} ${r.status === 0 ? 'built' : 'FAILED'} ${wire ? `${wire} KB wire` : ''}`)
    }
  },
  retrieval(which = null) {
    for (const [name, a] of Object.entries(ARMS)) {
      if (which && name !== which) continue
      if (a.cli === 'v1.5' && !V15) continue
      // The v2 harness scores every arm, the 1.5 index included: retrieval is
      // the same code path, and only v2 reports nDCG and context precision.
      for (const split of ['dev', 'test']) {
        const r = cli('v2', ['eval', '--gate-only', `--split=${split}`, '--quiet'], { ...a.env, HARBORLINE_INDEX_DIR: a.dir })
        save(`retrieval-${slug(name)}-${split}`, r.out, reportOf(r.out))
        console.log(`  ${name.padEnd(10)} ${split} ${r.status === 0 ? 'ok' : 'FAILED'}`)
      }
    }
  },
  answers(which = null) {
    for (const [name, s] of Object.entries(SYSTEMS)) {
      if (which && name !== which) continue
      if (s.cli === 'v1.5' && !V15) continue
      const a = ARMS[s.arm]
      const args = ['eval', `--level=${LEVEL}`, ...(s.cli === 'v2' ? ['--quiet', `--runtime=${s.runtime}`] : [])]
      const t0 = Date.now()
      const r = cli(s.cli, args, { ...s.env, HARBORLINE_INDEX_DIR: a.dir })
      save(`answers-${slug(name)}`, r.out, reportOf(r.out))
      console.log(`  ${name.padEnd(24)} ${r.status === 0 ? 'ok' : `exit ${r.status}`} in ${Math.round((Date.now() - t0) / 60000)} min`)
    }
  },
  security(which = null) {
    for (const [name, s] of Object.entries(SYSTEMS)) {
      if (which && name !== which) continue
      if (s.cli !== 'v2') continue
      const a = ARMS[s.arm]
      const r = cli('v2', ['eval', '--set=adversarial', '--quiet', `--runtime=${s.runtime}`], { ...s.env, HARBORLINE_INDEX_DIR: a.dir })
      save(`security-${slug(name)}`, r.out, reportOf(r.out))
      console.log(`  ${name.padEnd(24)} ${r.status === 0 ? 'ok' : `exit ${r.status}`}`)
    }
  },
  perf() {
    const rows = []
    for (const [name, a] of Object.entries(ARMS)) {
      const dir = path.join(FIXTURE, a.dir)
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue
      let raw = 0
      let br = 0
      let vec = 0
      for (const f of fs.readdirSync(dir)) {
        const b = fs.readFileSync(path.join(dir, f))
        raw += b.length
        const c = zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length
        br += c
        if (f.startsWith('vectors.')) vec += c
      }
      rows.push({ arm: name, rawKB: Math.round(raw / 1024), wireKB: Math.round(br / 1024), vectorsWireKB: Math.round(vec / 1024) })
    }
    fs.mkdirSync(RESULTS, { recursive: true })
    fs.writeFileSync(path.join(RESULTS, 'perf.json'), JSON.stringify(rows, null, 2))
    for (const r of rows) console.log(`  ${r.arm.padEnd(10)} raw ${r.rawKB} KB · wire ${r.wireKB} KB · vectors ${r.vectorsWireKB} KB`)
  },
}

/**
 * Build the calibrated arm, fit its thresholds, and build it again so the
 * manifest carries them — the order `docpilot index` → `calibrate` → `index`
 * the CLI documents. The calibration is named for its index directory, so no
 * other arm reads it.
 */
steps.calibrate = () => {
  for (const [name, a] of Object.entries(ARMS)) {
    if (!a.calibrate) continue
    const env = { ...a.env, HARBORLINE_INDEX_DIR: a.dir }
    const out = `eval/calibration.${path.basename(a.dir)}.json`
    const first = cli(a.cli, ['index', '--yes', ...a.args], env)
    const cal = first.status === 0 ? cli(a.cli, ['calibrate', `--out=${out}`], env) : first
    save(`calibrate-${slug(name)}`, cal.out)
    const again = cal.status === 0 ? cli(a.cli, ['index', '--yes', ...a.args], env) : cal
    save(`index-${slug(name)}`, again.out)
    console.log(`  ${name.padEnd(10)} ${again.status === 0 ? `calibrated → ${out}` : 'FAILED'}`)
  }
}

steps.report = () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'report.mjs')], { stdio: 'inherit' })
  process.exitCode = r.status ?? 1
}

const [step = '', which = null] = process.argv.slice(2)
if (!steps[step]) {
  console.error(`unknown step ${step}: ${Object.keys(steps).join(', ')}`)
  process.exit(2)
}
steps[step](which)
