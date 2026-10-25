/**
 * `docpilot model <fingerprint|verify|compare|contamination>` — the owner's
 * side of a self-hosted checkpoint.
 *
 * This command does not train and does not load weights. It reads headers,
 * hashes files, compares two `docpilot eval` reports run against two endpoints,
 * and checks a training file against the golden set. The three gating modes —
 * verify, compare, contamination — exit `FAILED` on a bad outcome, so each one
 * can stand as a CI step on its own.
 *
 * The IO half. Everything worth testing is in headers.ts, fingerprint.ts,
 * stats.ts, compare.ts and contamination.ts.
 */

import {createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {createInterface} from 'node:readline'
import {FAILED, OK, USAGE, printError, tick, tock} from '../cli-exit.js'
import {checksumLines, fingerprint, verify} from './fingerprint.js'
import {compareReports, renderCompare} from './compare.js'
import {printable} from '../build/lib/terminal.js'
import {createContaminationIndex, extractTrainTexts, renderContamination} from './contamination.js'

const MODES = ['fingerprint', 'verify', 'compare', 'contamination']

/**
 * Flags per mode: `bool` takes no value, `value` takes a string, `number` a
 * finite number. Kept local until the lead moves them into `cli-flags.ts`.
 */
export const MODEL_FLAGS = {
  fingerprint: {out: 'value', format: 'value'},
  verify: {manifest: 'value', json: 'bool'},
  compare: {
    base: 'value',
    candidate: 'value',
    'base-manifest': 'value',
    'candidate-manifest': 'value',
    alpha: 'number',
    'max-regression': 'number',
    seed: 'number',
    json: 'bool',
    out: 'value',
    'allow-incomparable': 'bool',
  },
  contamination: {train: 'value', golden: 'value', n: 'number', json: 'bool'},
}

export const HELP = `docpilot model <mode> [options]

  Identify, verify and compare self-hosted model checkpoints. Reads headers and
  hashes; never loads weights.

  fingerprint <path>        sha256 + parsed header of every weight/config file
    --out=FILE              write the manifest there (default: stdout)
    --format=json|sha256sum json manifest, or sha256sum -c compatible lines

  verify [path]             re-hash against a manifest; exit 1 on any mismatch
    --manifest=FILE         the manifest from fingerprint (required)
    --json                  machine-readable result

  compare                   paired test of two \`docpilot eval\` reports; exit 1 on regression
    --base=REPORT.json      the eval report for the current weights (required)
    --candidate=REPORT.json the eval report for the new weights (required)
    --base-manifest=FILE    fingerprint of the base weights
    --candidate-manifest=FILE fingerprint of the candidate weights
    --alpha=0.05            McNemar significance level
    --max-regression=0.02   ok-rate drop that counts as a regression
    --seed=1                bootstrap PRNG seed
    --allow-incomparable    proceed when index/prompt/golden hashes differ
    --json                  print the result as JSON
    --out=FILE.md           write the markdown report there (default: stdout)

  contamination             training file vs golden set, n-gram overlap; exit 1 if any
    --train=FILE.jsonl      OpenAI chat, TRL prompt/completion/chosen/rejected, or {text}
    --golden=FILE           default: <evalDir>/golden.jsonl
    --n=13                  n-gram length
    --json                  print the result as JSON
`

function usage(message: string) {
  const e: any = new Error(message)
  e.usage = true
  return e
}

/** `mode`, positionals and `--flag[=value]` against the mode's table. Throws a usage error. */
export function parseModelArgs(argv: string[]) {
  const rest = [...argv]
  const out = {mode: null, positional: [], flags: {} as Record<string, any>, help: false}
  while (rest.length) {
    const a = rest.shift()
    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }
    if (!a.startsWith('--')) {
      if (!out.mode) out.mode = a
      else out.positional.push(a)
      continue
    }
    if (!out.mode) throw usage(`a mode comes first: docpilot model <${MODES.join('|')}>`)
    const table = MODEL_FLAGS[out.mode]
    if (!table) throw usage(`unknown mode "${out.mode}". One of: ${MODES.join(', ')}`)
    const eq = a.indexOf('=')
    const name = a.slice(2, eq < 0 ? undefined : eq)
    const kind = table[name]
    if (!kind) throw usage(`unknown option "--${name}" for \`model ${out.mode}\``)
    if (kind === 'bool') {
      if (eq >= 0) throw usage(`--${name} takes no value`)
      out.flags[name] = true
      continue
    }
    let v = eq >= 0 ? a.slice(eq + 1) : rest.shift()
    if (v == null || v === '' || (eq < 0 && v.startsWith('--'))) throw usage(`--${name} needs a value: --${name}=…`)
    if (kind === 'number') {
      const x = Number(v)
      if (!Number.isFinite(x)) throw usage(`--${name} must be a number, got "${v}"`)
      v = x as any
    }
    out.flags[name] = v
  }
  return out
}

const readJson = (file: string, what: string) => {
  const abs = path.resolve(file)
  if (!existsSync(abs)) throw new Error(`no such ${what}: ${abs}`)
  try {
    return JSON.parse(readFileSync(abs, 'utf8'))
  } catch (e) {
    throw new Error(`${what} ${abs} is not JSON — ${e.message}`)
  }
}

const readJsonl = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

const write = (file: string, text: string) => {
  const abs = path.resolve(file)
  mkdirSync(path.dirname(abs), {recursive: true})
  writeFileSync(abs, text)
  return abs
}

/** Hashing progress for files over 64 MB, at most once a second off a terminal. */
function progress() {
  let last = 0
  return ({path: p, done, total}) => {
    if (total < 64 << 20) return
    const now = Date.now()
    if (done < total && now - last < (process.stderr.isTTY ? 200 : 1000)) return
    last = now
    const line = `hashing ${p} ${Math.floor((done / total) * 100)}% of ${(total / 2 ** 30).toFixed(2)} GiB`
    if (done >= total) tock(line)
    else tick(line)
  }
}

async function runFingerprint(args) {
  const [target] = args.positional
  if (!target) throw usage('fingerprint needs a path: docpilot model fingerprint <file|dir>')
  if (!existsSync(target)) throw new Error(`no such path: ${path.resolve(target)}`)
  const format = args.flags.format ?? 'json'
  if (!['json', 'sha256sum'].includes(format)) throw usage(`--format is json or sha256sum, got "${format}"`)
  const m = await fingerprint(target, {onProgress: progress()})
  if (!m.files.length) {
    printError(`no weight or config files under ${m.root}`)
    return FAILED
  }
  const text = format === 'json' ? JSON.stringify(m, null, 2) + '\n' : checksumLines(m.files).join('')
  if (args.flags.out) {
    const abs = write(args.flags.out, text)
    const s = m.summary
    // name, architecture and base come out of the model file itself (GGUF
    // metadata, adapter_config.json), which a model hub upload controls.
    console.error(
      `[docpilot] ${path.relative(process.cwd(), abs)} — ${m.files.length} file(s), digest ${m.digest.slice(0, 16)}…` +
        (s.format ? `\n           ${[s.format, s.architecture, s.name, s.parameters && `${(s.parameters / 1e9).toFixed(2)}B params`, s.adapter && `adapter on ${s.base ?? '?'}`].filter(Boolean).map(printable).join(' · ')}` : ''),
    )
  } else process.stdout.write(text)
  return OK
}

async function runVerify(args) {
  if (!args.flags.manifest) throw usage('verify needs --manifest=FILE (the output of `docpilot model fingerprint`)')
  const manifest = readJson(args.flags.manifest, 'manifest')
  const r = await verify(manifest, args.positional[0], {onProgress: progress()})
  if (args.flags.json) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(`[docpilot] ${printable(r.root)}: ${r.ok.length} ok, ${r.changed.length} changed, ${r.missing.length} missing, ${r.extra.length} extra`)
    for (const c of r.changed) console.log(`  CHANGED  ${printable(c.path)} (${c.reason}: ${printable(c.expected)} → ${printable(c.actual)})`)
    for (const p of r.missing) console.log(`  MISSING  ${printable(p)}`)
    for (const p of r.extra) console.log(`  EXTRA    ${printable(p)}`)
    console.log(r.passed ? '[docpilot] VERIFIED — the files are the ones the manifest names.' : '[docpilot] VERIFY FAILED')
  }
  return r.passed ? OK : FAILED
}

async function runCompare(args) {
  const {flags} = args
  if (!flags.base || !flags.candidate) throw usage('compare needs --base=REPORT.json and --candidate=REPORT.json')
  const alpha = flags.alpha ?? 0.05
  if (!(alpha > 0 && alpha < 1)) throw usage(`--alpha must be in (0, 1), got ${alpha}`)
  const maxRegression = flags['max-regression'] ?? 0.02
  if (!(maxRegression >= 0 && maxRegression < 1)) throw usage(`--max-regression must be in [0, 1), got ${maxRegression}`)
  const base = readJson(flags.base, 'base report')
  const candidate = readJson(flags.candidate, 'candidate report')
  for (const [r, name] of [[base, flags.base], [candidate, flags.candidate]]) {
    if (!Array.isArray(r?.rows) || !r.meta) throw new Error(`${name} is not a \`docpilot eval\` report (no meta or rows)`)
  }
  const r = compareReports(base, candidate, {
    alpha,
    maxRegression,
    seed: flags.seed ?? 1,
    allowIncomparable: Boolean(flags['allow-incomparable']),
    baseManifest: flags['base-manifest'] ? readJson(flags['base-manifest'], 'base manifest') : undefined,
    candidateManifest: flags['candidate-manifest'] ? readJson(flags['candidate-manifest'], 'candidate manifest') : undefined,
  })

  if (r.incomparable.length) {
    const list = r.incomparable.map((d) => printable(`meta.${d.field} ${d.base} → ${d.candidate}`)).join('; ')
    if (r.refused) {
      printError(
        `REFUSED: the reports differ in ${list}. The delta would measure that change plus the model. ` +
          'Re-run both evals on the same index, prompt and golden set, or pass --allow-incomparable.',
      )
      if (flags.json) console.log(JSON.stringify(r, null, 2))
      return FAILED
    }
    printError(`WARNING: comparing incomparable reports (${list}) under --allow-incomparable. Do not read this as a model comparison.`)
  }

  if (flags.json) console.log(JSON.stringify(r, null, 2))
  const md = renderCompare(r, {base: path.basename(flags.base), candidate: path.basename(flags.candidate), generatedAt: new Date().toISOString()})
  if (flags.out) {
    const abs = write(flags.out, md)
    console.error(`[docpilot] ${path.relative(process.cwd(), abs)} — verdict: ${r.verdict}`)
  } else if (!flags.json) process.stdout.write(md)
  if (!flags.out && flags.json) console.error(`[docpilot] verdict: ${r.verdict}`)
  return r.verdict === 'regression' ? FAILED : OK
}

async function runContamination(args, docPilot) {
  const {flags} = args
  if (!flags.train) throw usage('contamination needs --train=FILE.jsonl')
  const n = flags.n ?? 13
  if (!(Number.isInteger(n) && n >= 1)) throw usage(`--n must be a positive integer, got ${n}`)
  const goldenFile = path.resolve(flags.golden ?? path.join(docPilot?.evalDir ?? 'docpilot', 'golden.jsonl'))
  if (!existsSync(goldenFile)) throw new Error(`no golden set at ${goldenFile} — pass --golden=FILE`)
  const trainFile = path.resolve(flags.train)
  if (!existsSync(trainFile)) throw new Error(`no such training file: ${trainFile}`)

  const golden = readJsonl(goldenFile)
  const idx = createContaminationIndex(golden, n)
  let skipped = 0
  const lines = createInterface({input: createReadStream(trainFile, 'utf8'), crlfDelay: Infinity})
  for await (const line of lines) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    for (const t of extractTrainTexts(rec)) idx.scan(t)
  }
  const r = idx.result()
  if (flags.json) console.log(JSON.stringify({...r, train: trainFile, goldenFile, skipped}, null, 2))
  else process.stdout.write(renderContamination(r, {train: path.basename(trainFile), golden: path.basename(goldenFile), skipped}))
  if (skipped) printError(`${skipped} line(s) of ${path.basename(trainFile)} were not JSON and were skipped`)
  return r.contaminated.length ? FAILED : OK
}

/**
 * @param o.docPilot resolved settings — `evalDir` locates the default golden set
 * @param o.argv everything after `model`
 * @returns exit code
 */
export async function runModel({docPilot = null, argv = [], env = process.env}: {docPilot?: any; argv?: string[]; env?: any} = {}) {
  let args
  try {
    args = parseModelArgs(argv)
  } catch (e) {
    printError(e.message, e, env)
    return USAGE
  }
  if (args.help) {
    console.log(HELP)
    return OK
  }
  if (!args.mode) {
    console.log(HELP)
    return USAGE
  }
  if (!MODES.includes(args.mode)) {
    printError(`unknown mode "${args.mode}". One of: ${MODES.join(', ')}`)
    return USAGE
  }
  try {
    if (args.mode === 'fingerprint') return await runFingerprint(args)
    if (args.mode === 'verify') return await runVerify(args)
    if (args.mode === 'compare') return await runCompare(args)
    return await runContamination(args, docPilot)
  } catch (e) {
    printError(e.message, e, env)
    return e.usage ? USAGE : FAILED
  }
}
