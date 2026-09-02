#!/usr/bin/env node
/**
 * Gate calibration — RAG-SPEC 5.6.
 *
 *   npx docpilot calibrate
 *   npx docpilot calibrate --refresh        ignore the raw cache, re-embed
 *   npx docpilot calibrate --sweep-only     sweep the cache, embed nothing
 *   npx docpilot calibrate --limit=40       short loop while authoring probes
 *
 * NEEDS THE EMBED ENDPOINT ONLY. No chat model is contacted, ever: a threshold
 * that moves when a generator moves is not a threshold, and the whole point of
 * this file is that the same corpus and the same probes produce the same two
 * numbers on any machine. There is no LLM judge here and there must never be one
 * (`eval/metrics.js` states the same constraint for the same reason).
 *
 * On an index built with `npx docpilot index --no-embed` there is no endpoint to
 * need: no vectors means no dense channel, so only the lexical-only calibration
 * of step 7 runs. `tau` is a threshold ON the dense channel and is left null —
 * unmeasurable is not the same as zero, and writing a number there would stamp a
 * hybrid gate as calibrated on an index that cannot have one.
 *
 * `tau`, `tauLexical`, `wDense` and `wLexical` are set ONLY here (RAG-SPEC 7).
 * Everything downstream reads `${evalDir}/calibration.json`; nothing else may write it.
 *
 * The three expensive things — embedding, retrieval and the zExp ladder — are
 * computed once and cached to `${evalDir}/calibration.raw.jsonl` (gitignored). The
 * sweep is then a pure function of that cache, so re-running step 3 after a
 * change to the selection rule costs milliseconds instead of a full re-embed.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { assembleIndex } from '../theme/docpilot/store.js'
import { embedQuery } from '../theme/docpilot/embed.js'
import { providerFor } from '../theme/docpilot/providers.js'
import { embeddingsOf } from '../build/build-rag-index.js'
import { createRetrieval, resolveLevers } from '../theme/docpilot/retriever.js'
import { wilsonUpper95 } from './metrics.js'
import { nodeEmbedTarget } from '../config.js'
import { applyFileEnv } from '../cli-env.js'
import { entryFlagError, flagValue, flagGiven } from '../cli-flags.js'
import { printError, tick, tock, FAILED, USAGE } from '../cli-exit.js'

import {
  ROOT,
  RAG,
  CALIBRATION_SET,
  CALIBRATION_OUT,
  settings as docPilot,
} from '../cli-context.js'
const EVAL = path.dirname(CALIBRATION_SET)
const PROBES = path.join(EVAL, 'calibration.jsonl')
const RAW = path.join(EVAL, 'calibration.raw.jsonl')
const OUT_JSON_DEFAULT = path.join(EVAL, 'calibration.json')
const OUT_MD = path.join(EVAL, 'calibration.report.md')

/** `.env.local` through the loader config.mjs uses. Existing environment wins. */
/**
 * `.env.local`, applied by the LAUNCHER now — see `src/cli-env.ts`.
 *
 * The loop that stood here was one of five copies of the same six lines, and
 * two other copies elsewhere in the package inverted the law they implemented.
 * It is kept as a no-op-when-already-applied call rather than deleted outright,
 * because this module is also runnable on its own (`node dist/eval/…`), and a
 * command that reads the file under the launcher and not under `node` is the
 * same divergence one level down.
 */
await applyFileEnv()

/**
 * THE FLAGS, read by the table that already validated them.
 *
 * There is no parser here any more. `flagValue` and `flagGiven` are exported by
 * `src/cli-flags.js`, they read the grammar out of the same `COMMANDS` entry
 * `flagErrors` checks, and until this change their only importer in the whole
 * package was the test file. Seven hand-written copies read the flags instead,
 * and they had drifted the way copies drift: one truncated a value at its first
 * `=`, one returned `''` where it had been given a default, and one returned
 * `true` where it had been given a path.
 */
const FLAGS = process.argv.slice(2)
const arg = (name: string, dflt?: string) => flagValue('calibrate', FLAGS, name) ?? dflt
const has = (name: string) => flagGiven('calibrate', FLAGS, name)

/**
 * EVERY FLAG THIS COMMAND TAKES, CHECKED FIRST — before a config is read, before
 * `.env.local` is loaded, and long before anything is embedded. See
 * `src/cli-flags.js` for what it rejects and why each kind of rejection exists.
 */
const BAD_FLAG = entryFlagError('calibrate', import.meta.url)
if (BAD_FLAG) {
  printError(BAD_FLAG)
  process.exit(USAGE)
}

const REFRESH = has('refresh')
const SWEEP_ONLY = has('sweep-only')
const LIMIT = Number(arg('limit', '0'))
/**
 * `--transfer=<calibration.json>` — carry a calibration measured with ANOTHER
 * embedder onto this index, by keeping its thresholds and re-fitting only the
 * cosine window.
 *
 * The split is what makes this legal rather than the thing every other check in
 * this package exists to stop. `denseFromCosine` maps a raw cosine affinely into
 * [0,1], so `tau`, `tauLexical`, `wDense` and `wLexical` are expressed in
 * NORMALISED units and describe the corpus; `cosFloor` and `cosCeil` are the
 * only two numbers that describe where an embedder puts its cosines. Inheriting
 * the window is the failure this package already documents. Inheriting the
 * threshold and re-fitting the window is the opposite operation.
 *
 * What it does NOT do is re-establish the three UB95 bounds: the anchor set is
 * far below the n they need, and a transferred guard is a bounded bet rather
 * than a measurement. Everything downstream of that sentence — the nulled
 * fields in `buildDoc`, `source: 'transferred'` — exists to keep it true.
 */
const TRANSFER = arg('transfer', '')
/**
 * `bounded` — the quota `anchorQuota()` derives from the strata's own ceilings —
 * or `full`, the whole probe set. Not a count: a count below the quota buys a
 * run that refuses every window, and one above it is `full` spelled less
 * clearly.
 */
const ANCHORS = arg('anchors', 'bounded')
/** Where a transfer writes. Never the file it read — see the check below. */
const OUT_ARG = arg('out', '')
/**
 * A transfer defaults to the per-index name the build looks for FIRST
 * (`calibrationPathFor` in build-rag-index.js), so the two agree by
 * construction rather than by the operator remembering to pass `--out`. A full
 * run keeps writing the shared file, which is what every existing project reads.
 */
const OUT_JSON = OUT_ARG
  ? path.resolve(ROOT, OUT_ARG)
  : TRANSFER
    ? path.join(EVAL, `calibration.${path.basename(RAG)}.json`)
    : OUT_JSON_DEFAULT

/**
 * A transfer that wrote over its own source would consume the calibration it
 * was derived from, and `${evalDir}/calibration.json` is one path per project
 * while an index directory is not. Refused rather than resolved for you: which
 * of the two files the build should read is a decision, and guessing it here
 * would make the wrong one arrive silently.
 */
if (TRANSFER && path.resolve(ROOT, TRANSFER) === OUT_JSON) {
  printError(
    `--transfer would overwrite the calibration it reads ` +
      `(${path.relative(ROOT, OUT_JSON)}).\n` +
      `        Name the target: --out=docpilot/calibration.<index>.json`,
  )
  process.exit(USAGE)
}
/**
 * The embedder, from the project's own settings.
 *
 * These three used to default to a local Ollama regardless of what the index was
 * built with, so `docpilot calibrate` on a project embedding with a hosted service
 * either failed on an unreachable `localhost:11434` or — worse, if an Ollama
 * happened to be running — measured thresholds in a foreign vector space and
 * wrote them out as if they described this corpus.
 *
 * `nodeEmbedTarget` is the same resolver `docpilot index` uses, so the calibration
 * and the index cannot disagree about which model produced the vectors. The
 * environment still wins, for a sweep against a second endpoint.
 */
const EMBED_TARGET = nodeEmbedTarget(docPilot, process.env)
const EMBED_PROVIDER = process.env.DOCPILOT_EMBED_PROVIDER || EMBED_TARGET.provider
const EMBED_BASE = process.env.DOCPILOT_EMBED_URL || EMBED_TARGET.baseURL
// Read but never printed. The report and every log line below carry thresholds
// and probe ids, never a credential.
const EMBED_KEY = process.env.DOCPILOT_EMBED_KEY || EMBED_TARGET.apiKey || null

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

// Named once because both probe paths report it, and two copies of a script
// range are two things that stop agreeing. It flags the probes whose lexical
// channel scores zero against an English corpus whatever the answer is worth —
// the single largest cost of the lexical-only mode.
const CYRILLIC = /[Ѐ-ӿ]/

// ── strata ───────────────────────────────────────────────────────────────────

/**
 * The eleven strata of RAG-SPEC 5.6 step 1, and what each one is for.
 *
 * `positive` strata are scored on PASSING; everything else is scored on
 * REFUSING. `bound` is the UB95 ceiling from the RAG-SPEC 5.4 table — only the
 * three positive strata carry one, and `gatePrecision` deliberately does not:
 * step 6 says negative-catch is the objective maximised subject to over-refusal,
 * never a reason to raise tau.
 *
 * EXPORTED so `src/feedback/stratum.js` can suggest a stratum for a question a
 * reader actually asked, and be structurally unable to suggest one this
 * validator would then reject.
 */
export interface Stratum {
  positive: boolean
  label: string
  /** Positives only: the ceiling their refusal rate must stay under. */
  bound?: number
  /** Positives only: which measured rate the bound applies to. */
  metric?: string
}

export const STRATA: Record<string, Stratum> = {
  U: { positive: true, bound: 0.05, metric: 'gateOverRefusal', label: 'unscoped positives' },
  S: { positive: true, bound: 0.05, metric: 'scopedGateOverRefusal', label: 'scoped positives' },
  F: { positive: true, bound: 0.08, metric: 'followupRefusalRate', label: 'follow-up pairs' },
  N1: { positive: false, label: 'adjacent product, absent here' },
  N2: { positive: false, label: 'plausible-but-absent API' },
  N3: { positive: false, label: 'off-domain technical' },
  N4: { positive: false, label: 'off-domain general (blatant)' },
  N5: { positive: false, label: 'off-domain after a legitimate previous turn' },
  N6: { positive: false, label: 'docs excerpt + off-domain ask' },
  X: { positive: false, label: 'scoped, gold outside the scope' },
  P: { positive: false, label: 'scoped, vocabulary overlap without the answer' },
}
const POSITIVE_STRATA = Object.keys(STRATA).filter((s) => STRATA[s].positive)

/** RAG-SPEC 3.4.1: the ladder is measured at these n, as real page scopes. */
const LADDER_N = [2, 6, 20, 40, 100, 300, 700, null] // null → the whole corpus

const die = (m) => {
  printError(m)
  process.exit(FAILED)
}
const num = (v, d = 3) => (v == null || Number.isNaN(v) ? '  —  ' : v.toFixed(d))
const pct = (v) => (v == null ? '  — ' : `${(100 * v).toFixed(1)}%`)

/** Deterministic PRNG. Math.random would make a calibration unreproducible. */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

function loadIndex() {
  const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
  const shards = manifest.shards.map((s) => JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')))
  // A `--no-embed` index writes `vectors: null` and no blob beside it, so there is
  // nothing here to read and no path to build out of `null`.
  let vectorBuffer = null
  if (manifest.vectors !== null) {
    // `.buffer` on a Buffer is NOT the file: Node pools small allocations, so for
    // any vector blob under ~8 KB it is the whole pool and `assembleIndex`'s
    // length check refuses the index. Slice to the view's own bytes.
    const vecBuf = fs.readFileSync(path.join(RAG, manifest.vectors))
    vectorBuffer = vecBuf.buffer.slice(vecBuf.byteOffset, vecBuf.byteOffset + vecBuf.byteLength)
  }
  const dfDoc = JSON.parse(fs.readFileSync(path.join(RAG, manifest.df), 'utf8'))
  return assembleIndex({ manifest, shards, vectorBuffer, dfDoc })
}

function loadProbes() {
  if (!fs.existsSync(PROBES)) die(`no probe set at ${path.relative(ROOT, PROBES)}`)
  const recs = fs
    .readFileSync(PROBES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (e) {
        die(`${path.relative(ROOT, PROBES)}:${i + 1} is not JSON — ${e.message}`)
      }
    })
  const seen = new Set()
  for (const r of recs) {
    if (!r.id || !r.question || !r.stratum) die(`probe ${r.id || '?'} is missing id/question/stratum`)
    if (!STRATA[r.stratum]) die(`probe ${r.id} has unknown stratum "${r.stratum}"`)
    if (seen.has(r.id)) die(`duplicate probe id ${r.id}`)
    seen.add(r.id)
  }
  return LIMIT ? recs.slice(0, LIMIT) : recs
}

/**
 * The calibration a transfer inherits from, and every reason to refuse it.
 *
 * Each refusal here is a case where the two numbers that DO carry across —
 * `tau` and `tauLexical` — would not mean the same thing on the target, so
 * carrying them would be the silent inlining this whole file exists to prevent.
 */
function loadTransferSource(file, index) {
  if (!fs.existsSync(file)) die(`no calibration to transfer at ${file}`)
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    die(`${file} is unreadable — ${e.message}`)
  }
  const g = doc?.guard
  if (!g || typeof g.tau !== 'number' || typeof g.tauLexical !== 'number') {
    die(`${file} carries no usable pair of thresholds to transfer`)
  }
  if (doc.lexicalOnly) {
    die(`${file} was measured on an index with no vectors — it has no window to re-fit and no tau to carry`)
  }
  // A window is a statement about cosines. Under `zscore` D comes off the z
  // ladder instead, so there is nothing here to re-fit and the two tau are not
  // in the same units either.
  if (g.denseMode !== 'cosine' || index.manifest.guard.denseMode !== 'cosine') {
    die(
      `transfer needs both sides in denseMode "cosine" — source is "${g.denseMode}", ` +
        `this index is "${index.manifest.guard.denseMode}"`,
    )
  }
  // THE ASSERTION THAT LICENSES THE WHOLE OPERATION.
  //
  // `manifest.hash` is sha256 over chunk id and text — it does NOT move with the
  // embedder, so two indexes of one corpus embedded differently carry the SAME
  // hash. That is what makes this an equality to assert rather than a stamp to
  // write: under it, `L_raw`, `L_composed`, `admissible` and `n` are identical
  // between the two runs and only the cosines moved. Re-stamping instead would
  // be the silent inline the hash check exists to prevent.
  if (doc.calibratedAt !== index.manifest.hash) {
    die(
      `${file} was measured on corpus ${doc.calibratedAt}, this index is ${index.manifest.hash}.\n` +
        `        A transfer re-anchors the embedder, not the corpus: tau is a statement about how\n` +
        `        well retrieval separates THIS text, and across two corpora it is a different\n` +
        `        question's answer. Rebuild the source's index, or calibrate this one.`,
    )
  }
  if (doc.embedModel && doc.embedModel === index.manifest.embedModel) {
    die(
      `${file} was already measured with "${doc.embedModel}" — this index embeds with the same model, ` +
        `so run \`npx docpilot calibrate\` and measure it rather than transferring it`,
    )
  }
  // The corpus is the one thing a transfer may NOT differ on. tau is a statement
  // about how well retrieval separates THIS corpus; carried onto another one it
  // is not a weaker measurement, it is a different question's answer.
  if ((doc.vocabHash ?? null) !== (index.manifest.vocabHash ?? null)) {
    die(
      `${file} was measured with vocabulary ${doc.vocabHash ?? 'none'}, this index tokenises with ` +
        `${index.manifest.vocabHash ?? 'none'} — every lexical score moved and tau rides on those too`,
    )
  }
  if (!(g.wLexical < g.tau)) {
    die(`${file} has wLexical ${g.wLexical} >= tau ${g.tau}, which gate.js rejects at init`)
  }
  return doc
}

/**
 * The anchors: a stratified, deterministic subset of the probe set.
 *
 * Stratified because the constraint is per-stratum and a uniform sample would
 * leave some stratum with nothing to constrain. Deterministic because two
 * transfers of the same calibration onto the same index must produce the same
 * window — `rng` is the same seeded generator the ladder uses, for the same
 * reason `Math.random` is not.
 */
function anchorQuota() {
  // Derived from the bounds, never written down: the smallest n at which a
  // stratum's UB95 at ZERO failures is still inside its own ceiling. Below it
  // the stratum is infeasible before a single probe is scored, so a run at that
  // size does not produce weak evidence — it produces a refusal, every time.
  const quota: Record<string, number> = {}
  for (const [k, v] of Object.entries(STRATA)) {
    if (v.positive) {
      let n = 2
      while (n < 4096 && wilsonUpper95(0, n) > v.bound) n++
      quota[k] = n
    } else {
      // Negatives carry no bound. N4 is the blatant floor and is kept whole;
      // the rest only have to make `gatePrecision` a number over enough probes
      // to be worth printing.
      quota[k] = k === 'N4' ? 30 : 15
    }
  }
  return quota
}

/**
 * The anchors: a stratified, deterministic subset sized by the bounds.
 *
 * Stratified because the constraint is per-stratum. Deterministic because two
 * transfers of one calibration onto one index must produce one window — `rng`
 * is the seeded generator the ladder already uses, for the reason `Math.random`
 * is not. Sized by `anchorQuota` because a proportional draw at any convenient
 * N puts the bounded strata below their own floor: a 120-probe draw of this set
 * gives U ≈ 34, and `UB95(0, 34) = 0.074` against a 0.05 ceiling.
 */
function pickAnchors(probes, mode) {
  const quota = anchorQuota()
  const rand = rng(20260829)
  const byStratum = new Map<string, any>()
  for (const p of probes) {
    if (!byStratum.has(p.stratum)) byStratum.set(p.stratum, [])
    byStratum.get(p.stratum).push(p)
  }

  const short = []
  for (const [k, want] of Object.entries(quota)) {
    const have = byStratum.get(k)?.length ?? 0
    if (have && have < want) short.push(`${k} has ${have}, needs ${want}`)
  }
  if (short.length && mode !== 'full') {
    die(
      `the probe set is too small to anchor a transfer: ${short.join('; ')}.\n` +
        `        These are not preferences — they are the n at which UB95 at zero failures first\n` +
        `        fits inside each stratum's own bound, so a smaller draw refuses every window in\n` +
        `        the grid before scoring one. Grow the set, or run \`npx docpilot calibrate\` and\n` +
        `        measure this embedder outright.`,
    )
  }

  const out = []
  for (const [stratum, pool] of [...byStratum].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const want = mode === 'full' ? pool.length : Math.min(pool.length, quota[stratum] ?? 15)
    const shuffled = pool
      .map((p) => ({ p, k: rand() }))
      .sort((a, b) => a.k - b.k)
      .map(({ p }) => p)
    out.push(...shuffled.slice(0, want))
  }
  const order = new Map<string, number>(probes.map((p, i) => [p.id, i]))
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

/**
 * The retrieval constants in force, so a cached row from a different sweep is
 * never silently reused. tau and friends are absent on purpose: they are what
 * this file produces, and nothing cached here depends on them.
 *
 * It used to read the eight `DOCPILOT_*` variables straight out of the
 * environment, which was the whole answer while an environment variable was the
 * only way to move a lever. It is not any more: `docpilot tune` writes
 * `tuning.json`, `docpilot index` inlines it as `manifest.tuning`, and a corpus
 * tuned to `MMR_LAMBDA 0.85` therefore probes with a retriever this key could not
 * see. Two indexes of the same corpus with different tuning share a hash — the
 * hash is sha256 over chunk id and text — so the rows of one would have been
 * handed back as the rows of the other, silently, and `calibrate` would publish
 * thresholds measured under levers nobody is running.
 *
 * `resolveLevers` rather than a second read of the manifest: it is the ONE
 * implementation of env > tuning > literal, and a cache key derived from a
 * different precedence rule than the retrieval it keys is a key that is wrong
 * exactly when the two disagree.
 */
function levers(manifest) {
  return resolveLevers(manifest?.tuning)
}

// Bump when a row gains a field the sweep READS, or when one it reads CHANGES
// MEANING. A cache line written before the bump is missing that field, and
// `regate` would hand it back unswept — a silent half-swept run is worse than a
// re-embed that costs a cent. Schema 3 is the second case: `admissible` stopped
// being "a tail term appears in the evidence" and became that OR "the tail is
// not written in this corpus's script", so every cached follow-up row scores
// the composed channel under a rule the retriever no longer runs.
const RAW_SCHEMA = 3 // 3: `admissible` abstains on a foreign tail; 2: per-channel z/L for the window sweep

/**
 * The cache key for one probe's raw measurement.
 *
 * `indexHash` alone is not the identity of the vector space. It is computed from
 * chunk ids and text (build-rag-index.js), so swapping the embed model and
 * rebuilding leaves it unchanged — the file that computes it says so itself:
 * "swap the embed model and every cosine moves while the hash does not". Keyed
 * on the hash alone, a `docpilot calibrate` after an embedder change got a 100%
 * cache hit and published thresholds derived from the OLD model's cosines as the
 * calibration of the new space, silently. `denseMode` joins them because the
 * cached G and z values are computed under it.
 */
const sigOf = (rec, indexHash, lev, embedIdentity) =>
  crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        RAW_SCHEMA,
        indexHash,
        embedIdentity,
        rec.question,
        rec.prev_question || null,
        rec.scope || null,
        rec.stratum,
        lev,
      ]),
    )
    .digest('hex')
    .slice(0, 16)

// ── step 2: retrieval only, once per probe ───────────────────────────────────

/**
 * Page-contiguous scopes for the zExp ladder — RAG-SPEC 3.4.1, which forbids
 * random chunk samples: adjacent paragraphs of one page are exactly the
 * correlation the ladder exists to measure, and a random sample destroys it.
 * The run wraps at the end of the page list, so it is contiguous in sidebar
 * order modulo one seam.
 */
function contiguousScope(pages, targetN, startIdx) {
  const paths = []
  let total = 0
  for (let step = 0; step < pages.length && total < targetN; step++) {
    const p = pages[(startIdx + step) % pages.length]
    paths.push(p.path)
    total += p.chunks
  }
  return { kind: 'section', paths, label: `ladder n≈${targetN}`, n: total }
}

/**
 * The probe texts, embedded in batches before the loop below asks for them.
 *
 * `embedQuery` sends one text per request, which is the right shape for a reader
 * typing a question and the wrong one for a calibration: a bounded transfer
 * draws 271 anchors, 47 of which carry a previous turn and cost a second embed,
 * so the run is 318 requests against a free tier that allows 50 a day. The same
 * texts at the batch size `docpilot index` has always used are ten.
 *
 * IT IS A CACHE AND NEVER A SECOND CODE PATH. Every failure here returns
 * quietly, leaving the map short, and `embed` below falls through to
 * `embedQuery` exactly as it did — so a provider that will not batch degrades to
 * the loop that already worked rather than to an error, and the endpoint
 * diagnosis stays in the one place that words it well.
 *
 * The vectors have to be `embedQuery`'s to the bit, which is why the scaling
 * below is copied from it rather than taken from the indexer's `l2normalise`:
 * that one stops at the unit vector, and it is the ×127 into the int8 domain
 * that makes the runtime dot product a cosine without a per-query rescale.
 */
const PREFETCHED = new Map<string, Float64Array>()

/** `embedQuery`'s tail, verbatim — see the note above about the ×127. */
function scaleToIndexDomain(vec: ArrayLike<number> & Iterable<number>) {
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum) || 1
  const out = new Float64Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] / norm) * 127
  return out
}

const RETRYABLE_BATCH = new Set([408, 409, 429, 500, 502, 503, 504])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * What this run COST, counted where it is spent.
 *
 * The number was already computed and already printed — "embedded 597 probe
 * texts in 19 request(s)" — and then thrown away. It is the one figure that
 * says what a rerun will cost against a fifty-a-day free tier, and the document
 * that records every threshold this run measured did not record it.
 *
 * Counted per ATTEMPT rather than per batch: a retried 429 is a request the
 * provider counted, and a number that pretended otherwise would be the wrong
 * kind of comfortable.
 */
const EMBED_REQUESTS = { count: 0 }

/**
 * An address, without the path and without anything that could be a credential.
 *
 * Two calibrations of one index against two embedding endpoints were
 * indistinguishable in this document. The ORIGIN is the fact worth keeping; a
 * full URL can carry a key in its query and this file is committed.
 */
const originOf = (url) => {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * WHICH probe set — sha1 of the file, truncated to 16 hex.
 *
 * `probeCount` is a count, and a count does not move when a question inside a
 * probe is rewritten. Same truncation `sigOf` uses a few hundred lines below,
 * for the same reason.
 */
const probeSha = () => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(PROBES)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

async function prefetchEmbeddings(texts, index) {
  const model = index.manifest.embedModel
  const p = providerFor(EMBED_PROVIDER)
  if (!p.embedUrl || !model) return

  /**
   * The QUERY prefix. `build-rag-index` applies `search_document: ` across the
   * same asymmetry, so reusing its batch helper here would embed every probe as
   * though it were a chunk — right vectors, wrong side, and nothing downstream
   * could see it.
   */
  const prefix = /nomic/i.test(model) ? 'search_query: ' : ''
  const want = [...new Set<string>(texts)]
  const BATCH = 32
  const requests = Math.ceil(want.length / BATCH)

  for (let i = 0; i < want.length; i += BATCH) {
    const slice = want.slice(i, i + BATCH)
    let vectors = null
    for (let attempt = 1; attempt <= 3 && !vectors; attempt++) {
      let res
      try {
        EMBED_REQUESTS.count++
        res = await fetch(p.embedUrl(EMBED_BASE), {
          method: 'POST',
          headers: p.headers(EMBED_KEY),
          body: JSON.stringify(p.embedBody(model, slice.map((t) => `${prefix}${t}`))),
        })
      } catch {
        return // unreachable: the probe loop words that failure, and words it better
      }
      if (res.ok) {
        const json = await res.json().catch(() => null)
        const got = embeddingsOf(json, EMBED_PROVIDER === 'ollama')
        // A short batch is a provider that silently dropped inputs. Guessing
        // which ones came back is how a probe gets somebody else's vector.
        if (got?.length === slice.length && got.every((v) => v?.length)) vectors = got
        else return
      } else if (RETRYABLE_BATCH.has(res.status) && attempt < 3) {
        const after = Number(res.headers.get('retry-after'))
        await sleep(
          Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1), 20000),
        )
      } else return
    }
    if (!vectors) return
    slice.forEach((t, j) => PREFETCHED.set(t, scaleToIndexDomain(vectors[j])))
    tick(`embedded ${Math.min(i + BATCH, want.length)}/${want.length} probe texts…`)
  }
  if (want.length) {
    tock(`embedded ${want.length} probe texts in ${requests} request(s), ${BATCH} at a time`)
  }
}

async function embed(text, index) {
  // The per-text fallback, and it is a request too — `embedRequests` in the
  // document must count what the provider counted, not what the batcher planned.
  const cached = PREFETCHED.get(text)
  if (cached === undefined) EMBED_REQUESTS.count++
  const vec =
    cached ??
    (await embedQuery(text, {
      provider: EMBED_PROVIDER,
      baseURL: EMBED_BASE,
      model: index.manifest.embedModel,
      apiKey: EMBED_KEY,
    }))
  if (vec.length !== index.manifest.dims) {
    die(
      `embed model mismatch: ${EMBED_PROVIDER} returned ${vec.length} dims, the index is ` +
        `${index.manifest.dims} (${index.manifest.embedModel}). Point the embedder at it:\n` +
        `          DOCPILOT_EMBED_PROVIDER=ollama\n` +
        `          DOCPILOT_EMBED_URL=http://localhost:11434`,
    )
  }
  return vec
}

/**
 * Everything the sweep needs, for one probe, at the guard the index ships.
 *
 * G, D, L, z and n do not depend on tau — the verdict does. `unscopedG` is
 * recorded rather than `wouldPassUnscoped` alone because the boolean IS a
 * function of tau (RAG-SPEC 5.6 step 3) and a sweep that cached only the boolean
 * would be re-deriving a decision from a decision.
 */
async function probeOne({ rec, index, guard, ladderPages }) {
  const scope = rec.scope || ALL_SCOPE
  /**
   * `tuning`, for the reason `levers()` above states about the KEY: `sigOf`
   * resolves env > tuning > literal, so the retrieval it keys has to resolve the
   * same three layers. Without it the key moved with `manifest.tuning` and the
   * measurement did not — which is a claim on disk that these rows are a function
   * of the levers, made by a probe that ignored them.
   *
   * What that cost, measured: after `tune` → `index` → `calibrate`, every sig
   * changed, the whole `calibration.raw.jsonl` cache missed, and each probe was
   * re-embedded against a paid endpoint to reproduce a row identical to the one
   * already on disk — with `--sweep-only` dying on the first probe it could not
   * find. It is `sigOf` that keys on levers, so this does not stop that re-embed;
   * what it buys is that the re-embed is now a real re-measurement.
   *
   * And the direction that actually publishes a wrong number: a lever that moves
   * the gate would reach the browser through `manifest.tuning` and not reach this
   * probe, so tau would be published as calibrated under levers nobody runs. No
   * shipped lever moves a row TODAY — `L` reads the top three LEXICAL ids and `D`
   * the scoped max cosine, neither of which `GATE_K` or `MMR_LAMBDA` touches (only
   * `CANDIDATES`, and only below 3, against a default of 30). That is an
   * implementation detail of `evaluate()`, not a guarantee, and it is not the one
   * the cache key was written against.
   */
  const retrieval = createRetrieval({ index, scope, guard, tuning: index.manifest.tuning })

  if (index.manifest.vectors === null) return probeLexicalOnly({ rec, retrieval, scope })

  const vec = await embed(rec.question, index)
  const composedText = rec.prev_question ? `${rec.prev_question}\n${rec.question}` : null
  const composedVec = composedText ? await embed(composedText, index) : undefined

  const hybrid = retrieval.evaluate({
    question: rec.question,
    previousQuestion: rec.prev_question,
    queryVec: vec,
    composedVec,
  })
  // The two channels, separately, through the public contract: a raw-channel
  // evaluate on the composed TEXT is exactly what the composed channel computes.
  const rawOnly = rec.prev_question
    ? retrieval.evaluate({ question: rec.question, queryVec: vec })
    : hybrid
  const composedOnly = composedText
    ? retrieval.evaluate({ question: composedText, queryVec: composedVec })
    : null

  // Dense disabled — RAG-SPEC 5.6 step 7. queryVec is withheld rather than
  // ignored: `lexical-only` is the mode where the embedder is UNREACHABLE, and
  // fusion behaves differently when there is no vector to fuse.
  const lexical = retrieval.evaluate({
    question: rec.question,
    previousQuestion: rec.prev_question,
    queryVec: null,
    composedVec: composedText ? null : undefined,
    mode: 'lexical-only',
  })

  // retrievalMisses — RAG-SPEC 5.4. `closest()` ignores the threshold and ranks
  // PAGES, which is the granularity this probe set carries (no gold chunk ids,
  // by RAG-SPEC 5.6 step 1). Page level is the more forgiving of the two, so a
  // miss reported here is a miss at chunk level too.
  let retrievalMiss = null
  if (rec.gold_page && STRATA[rec.stratum].positive) {
    const q = composedText || rec.question
    const qv = composedText ? composedVec : vec
    const dense = retrieval.closest({ query: q, queryVec: qv, limit: 20 }).map((p) => p.path)
    const lex = retrieval.closest({ query: q, queryVec: null, limit: 20 }).map((p) => p.path)
    retrievalMiss = !dense.includes(rec.gold_page) && !lex.includes(rec.gold_page)
  }

  // The zExp ladder, over the unscoped positives — RAG-SPEC 3.4.1. Measured in
  // `zscore` mode regardless of what the index ships, because the ladder IS the
  // z statistic; on a cosine-mode index it is inert until an embed-model swap.
  const ladder = []
  if (rec.stratum === 'U' && !rec.prev_question) {
    const zGuard = { ...guard, denseMode: 'zscore' }
    const start = Math.floor(rng(hashSeed(rec.id))() * ladderPages.length)
    for (const target of LADDER_N) {
      const s = target === null ? ALL_SCOPE : contiguousScope(ladderPages, target, start)
      // Same `tuning` as the probe above. The ladder varies ONE thing — the size
      // of the scope — so every other input has to be the one the probe ran
      // under; a rung ranked on the package literals would attribute the lever
      // difference to n.
      const r = createRetrieval({ index, scope: s, guard: zGuard, tuning: index.manifest.tuning })
      const g = r.evaluate({ question: rec.question, queryVec: vec })
      ladder.push({ n: g.n, z: g.z })
    }
  }

  return {
    id: rec.id,
    stratum: rec.stratum,
    scoped: scope.kind !== 'all',
    followUp: Boolean(rec.prev_question),
    russian: CYRILLIC.test(rec.question),
    G: hybrid.G,
    G_raw: rawOnly.G,
    G_composed: composedOnly ? composedOnly.G : null,
    D: hybrid.D,
    L: hybrid.L,
    z: hybrid.z,
    // The window sweep re-derives D from the raw cosine, and in cosine mode `z`
    // IS that cosine (`denseFromCosine` returns it unchanged). It needs the
    // components of EVERY channel, not only the one that won here: which channel
    // wins is `c.G > best.G`, and G moves with the window being swept. Caching
    // the winner alone would pin the follow-up strata to the window the probe
    // happened to run under — the records that decide tau.
    z_raw: rawOnly.z,
    L_raw: rawOnly.L,
    z_composed: composedOnly ? composedOnly.z : null,
    L_composed: composedOnly ? composedOnly.L : null,
    n: hybrid.n,
    mode: hybrid.mode,
    channel: hybrid.channel,
    admissible: hybrid.admissible,
    // Not read by the sweep — `regate` needs the boolean and nothing else. It is
    // recorded because a stratum that moves between two calibrations should say
    // whether the composed channel was admitted on a term match or on a script
    // abstention, which the boolean alone cannot.
    admissibleBy: hybrid.admissibleBy,
    unscopedG: hybrid.unscopedG,
    G_lex: lexical.G,
    channel_lex: lexical.channel,
    unscopedG_lex: lexical.unscopedG,
    retrievalMiss,
    ladder,
  }
}

/**
 * The same probe on an index that has no vectors — RAG-SPEC 5.6 step 7, alone.
 *
 * Every dense-derived field is recorded as NULL rather than filled in from the
 * lexical channel. `sweepRow` reads `r.G`, and `null < tau` is `0 < tau`, so a
 * lexical score parked in the hybrid column would sweep cleanly and publish as
 * `tau` — a threshold on a channel this index does not have, indistinguishable
 * on disk from one that was measured. The lexical numbers live in `G_lex` and
 * `unscopedG_lex`, where the step-7 sweep already looks for them.
 *
 * There is no zExp ladder either: it is the median of `(max c − m)/s` over
 * cosines, and the closed form is only consulted in `zscore` mode, which a
 * vectorless index can never be in.
 */
async function probeLexicalOnly({ rec, retrieval, scope }) {
  const composedText = rec.prev_question ? `${rec.prev_question}\n${rec.question}` : null
  const lexical = retrieval.evaluate({
    question: rec.question,
    previousQuestion: rec.prev_question,
    queryVec: null,
    // undefined means "no second query to score", null means "score it
    // lexically" — the same distinction the hybrid path keeps, for the same
    // reason: collapsing them drops the composed channel from every follow-up.
    composedVec: composedText ? null : undefined,
    mode: 'lexical-only',
  })

  // Only the lexical half of the two-channel check above. A dense `closest()`
  // here would rank on empty cosines and report every gold page as missed,
  // charging the probe set for the absence of an embedder.
  let retrievalMiss = null
  if (rec.gold_page && STRATA[rec.stratum].positive) {
    const lex = retrieval
      .closest({ query: composedText || rec.question, queryVec: null, limit: 20 })
      .map((p) => p.path)
    retrievalMiss = !lex.includes(rec.gold_page)
  }

  return {
    id: rec.id,
    stratum: rec.stratum,
    scoped: scope.kind !== 'all',
    followUp: Boolean(rec.prev_question),
    russian: CYRILLIC.test(rec.question),
    G: null,
    G_raw: null,
    G_composed: null,
    D: null,
    L: lexical.L,
    z: null,
    z_raw: null,
    L_raw: null,
    z_composed: null,
    L_composed: null,
    n: lexical.n,
    mode: lexical.mode,
    channel: lexical.channel,
    admissible: lexical.admissible,
    admissibleBy: lexical.admissibleBy,
    unscopedG: null,
    G_lex: lexical.G,
    channel_lex: lexical.channel,
    unscopedG_lex: lexical.unscopedG,
    retrievalMiss,
    ladder: [],
  }
}

const hashSeed = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ── step 3 and 4: the sweep ──────────────────────────────────────────────────

const TAU_STEPS = Array.from({ length: 101 }, (_, i) => Number((i / 100).toFixed(2)))

/**
 * The cosine window — swept here, not hard-coded upstream.
 *
 * WHY THIS EXISTS. `cosFloor` / `cosCeil` map a raw cosine onto D, and where a
 * raw cosine SITS is a property of the embedder, not of the corpus. The pair
 * [0.44, 0.64] was measured on bge-m3 and reached `guardFor()` in
 * build-rag-index.js as a literal, while this file swept only tau inside it. So
 * an embed-model swap kept a window nobody re-measured, and on
 * text-embedding-3-small — whose positives sit 0.44–0.72 against bge-m3's much
 * higher band — the floor landed inside the positive distribution. Measured
 * consequence: Russian positives scored cosine ≈ 0.49, D ≈ 0.27, G ≈ 0.20
 * against tau 0.30 and were refused with their gold page ranked first, while the
 * English half cleared the same gate on lexical overlap the Russian half cannot
 * have. Twelve probes pinned tau at 0.00 and the run failed `no-feasible-tau`.
 *
 * HOW IT IS CHOSEN, and where this is an interpretation rather than the spec.
 * RAG-SPEC 5.6 step 6 forbids `gatePrecision` from justifying a higher **tau**,
 * and that rule is untouched: inside every candidate window tau is still step
 * 4's largest-feasible, chosen by a selector that never sees the precision. The
 * window is a different axis and the spec does not size it, so the rule written
 * down here is: keep only windows that clear the step-5 hard floor
 * (`blatantRefusalRate >= 0.80`) with a feasible tau above `wLexical`, and among
 * those take the highest `gatePrecision`. Ties go to the larger tau, then to the
 * wider span — a wide window degrades gracefully, a narrow one is a step
 * function pretending to be a score.
 *
 * `unscopedG` is NOT re-derived. It drives the X-stratum cause check and the
 * widen affordance, never the sweep — which scores X on refusal alone — so it
 * keeps the window its probe ran under. Said out loud because a reader comparing
 * `unscopedG` against a swept `G` would otherwise find them inconsistent.
 */
/**
 * THE GRID'S OWN FLOOR WAS THE LAST PLACE AN EMBEDDER'S SCALE WAS ASSUMED.
 *
 * The block above exists because `[0.44, 0.64]` was a bge-m3 literal that no
 * swap re-measured. The grid that replaced it started at 0.16 and reproduced the
 * same class of bug one level up: a floor is the smallest cosine the sweep can
 * call anything other than zero evidence, so a grid that starts at 0.16 can only
 * describe embedders whose positives sit above it.
 *
 * Measured on this corpus at index `aab4ce6a`, carrying bge-m3's calibration
 * onto `nvidia/nemotron-3-embed-1b:free`. That model RANKS the corpus as well —
 * AUC on the raw cosine 0.856 against bge-m3's 0.868 — but its scale is lower:
 * positive median 0.421 against 0.615. Two S positives land at 0.146 and 0.142,
 * below every floor in the old grid, so they clamped to `D = 0` under all 272
 * candidates and scored `G = 0.25 · L`, which cannot reach a tau above
 * `wLexical` no matter what L is. The largest feasible tau over the whole grid
 * was 0.12 — below `wLexical` 0.25, so `assertWeights` rejected it — and the
 * index shipped the provisional guard, which refuses 37% of U, 71% of S and 88%
 * of F. With the floor extended to 0, the same probes admit `[0.00, 0.24]` at
 * tau 0.58, `blatantRefusalRate` 0.93 and U/S/F all 0 — a guard as good as the
 * one bge-m3 measured, on the free embedder.
 *
 * Compare on `z_raw`, never on `D`: `D` is post-clamp, and under the old grid
 * 186 of 271 nemotron probes sat on the floor, which destroys the ordering and
 * invents a separation gap that is not there.
 *
 * A floor of 0 is not a free pass. `cosCeil` is what discriminates, the step-5
 * floor still applies, and `chooseWindow` still ranks by `gatePrecision` and
 * still prefers `rampShare >= 0.33` — a window that calls everything evidence
 * loses on precision before it is ever selected.
 */
const WINDOW_FLOORS = Array.from({ length: 24 }, (_, i) => Number((0 + i * 0.02).toFixed(2)))
const WINDOW_SPANS = Array.from({ length: 17 }, (_, i) => Number((0.08 + i * 0.02).toFixed(2)))

const WINDOWS = WINDOW_FLOORS.flatMap((cosFloor) =>
  WINDOW_SPANS.map((span) => ({ cosFloor, cosCeil: Number((cosFloor + span).toFixed(2)) })),
).filter((w) => w.cosCeil <= 0.95)

/** gate.js `denseFromCosine`, restated over the cache so the sweep stays pure. */
const dOf = (z, { cosFloor, cosCeil }) =>
  Math.min(1, Math.max(0, (z - cosFloor) / Math.max(cosCeil - cosFloor, 1e-6)))

/**
 * Re-score every probe at one candidate window.
 *
 * Mirrors `retriever.evaluate()`'s channel rule exactly — the composed channel
 * replaces the raw one only when it is `admissible` AND scores higher — because
 * a sweep that picked the max unconditionally would measure a retriever nobody
 * ships.
 */
function regate(rows, w, guard) {
  return rows.map((r) => {
    if (r.z_raw == null) return r // pre-window cache line: leave it as measured
    const gOf = (z, L) => guard.wDense * dOf(z, w) + guard.wLexical * L
    const raw = { G: gOf(r.z_raw, r.L_raw), D: dOf(r.z_raw, w), channel: 'raw' }
    let best = raw
    if (r.z_composed != null && r.admissible) {
      const composed = {
        G: gOf(r.z_composed, r.L_composed),
        D: dOf(r.z_composed, w),
        channel: 'composed',
      }
      if (composed.G > best.G) best = composed
    }
    return { ...r, ...best, G_raw: raw.G }
  })
}

/**
 * The window search. Returns the winning window with the sweep it earned, or
 * null when no window in the grid produces a shippable gate at all — which is a
 * real answer, not a failure to search: it means the embedder does not separate
 * this corpus and no threshold can rescue that.
 */
function chooseWindow(scored, guard) {
  const positives = scored.filter((r) => STRATA[r.stratum].positive && r.z_raw != null)

  const viable = []
  for (const w of WINDOWS) {
    const rw = regate(scored, w, guard)
    const sweep = TAU_STEPS.map((t) => sweepRow(rw, t, 'G'))
    const best = chooseTau(sweep)
    if (!best || best.tau < 0.05 || best.tau <= guard.wLexical) continue
    if (best.blatantRefusalRate === null || best.blatantRefusalRate < 0.8) continue

    // How much of the ramp is actually being used. A window narrower than the
    // spread it is mapping saturates D to 0 or 1 for everything and turns the
    // gate into a step on the raw cosine — which scores well here and ships a
    // knife edge: one embedder revision and every probe crosses at once.
    const inside = positives.filter((r) => {
      const d = dOf(r.z_raw, w)
      return d > 0 && d < 1
    }).length
    viable.push({
      window: w,
      sweep,
      best,
      rows: rw,
      span: Number((w.cosCeil - w.cosFloor).toFixed(2)),
      rampShare: positives.length ? inside / positives.length : 0,
    })
  }
  if (!viable.length) return null

  const rank = (a, b) =>
    b.best.gatePrecision - a.best.gatePrecision || b.best.tau - a.best.tau || b.span - a.span

  // Non-degenerate first: a window that leaves at least a third of the positives
  // strictly inside the ramp is scoring them, not bucketing them. Only if the
  // grid offers none does the search fall back to raw precision, and it says so.
  const graded = viable.filter((v) => v.rampShare >= 0.33).sort(rank)
  const pool = graded.length ? graded : viable.slice().sort(rank)

  return {
    ...pool[0],
    viableCount: viable.length,
    gradedCount: graded.length,
    shortlist: pool.slice(0, 6).map((v) => ({
      window: v.window,
      tau: v.best.tau,
      gatePrecision: v.best.gatePrecision,
      blatant: v.best.blatantRefusalRate,
      rampShare: v.rampShare,
    })),
  }
}

/**
 * `chooseWindow`'s sibling for a TRANSFER: the same grid, the same viability
 * rules, but tau is inherited rather than re-derived.
 *
 * WHY THE OBJECTIVE IS NOT THE SAME ONE. `chooseWindow` can afford a bare
 * `gatePrecision` objective because it re-derives tau inside every window, and
 * `chooseTau` will not hand back a cell whose positives break their bounds — so
 * a window that buys precision by refusing everything is discarded before it is
 * ranked. Pinned, that brake is gone. A window that pushes every D down refuses
 * more of EVERYTHING, which reads as better negative-catch while the positives
 * go down with them, and precision-alone would rank it first.
 *
 * So over-refusal becomes a hard CONSTRAINT here rather than something a free
 * tau absorbs: no positive stratum may refuse a larger share of the anchors
 * than the source measured on the full set. What is left to maximise is the
 * thing the source could not measure for this embedder.
 *
 * `sourceRate` is the source calibration's per-stratum refusal rate at its own
 * chosen tau, which is both the constraint and — as an L1 distance — the
 * tie-break: among windows that catch negatives equally well, prefer the one
 * whose behaviour sits closest to the guard that was actually calibrated. That
 * last clause mirrors `tune`'s "proximity to the levers already in force"
 * rather than inventing a second idiom for the same idea.
 */
function fitWindowAtTau(scored, guard, tau, sourceRate) {
  // Not a search failure: `assertWeights` throws on this pair at every retriever
  // init, so no window in the grid could rescue it.
  if (!(tau > guard.wLexical)) return null
  const positives = scored.filter((r) => STRATA[r.stratum].positive && r.z_raw != null)

  const drift = (row) =>
    POSITIVE_STRATA.reduce(
      (sum, k) => (row.byStratum[k].n > 0 ? sum + Math.abs(row.byStratum[k].rate - sourceRate[k]) : sum),
      0,
    )

  const viable = []
  for (const w of WINDOWS) {
    const rw = regate(scored, w, guard)
    const row = sweepRow(rw, tau, 'G')
    // `feasible` is `sweepRow`'s own predicate — every bounded positive stratum
    // inside its UB95 ceiling — and it is what `chooseTau` applies before
    // `gatePrecision` is ever consulted. Reusing it here is what stops the
    // pinned fit degenerating: measured on this corpus's 597 rows, the
    // unfiltered argmax is [0.44, 0.84] at gatePrecision 100% and 77.5%
    // over-refusal on U. With this line, one window of the grid survives and it is
    // the one the joint search chose.
    if (!row.feasible) continue
    if (row.blatantRefusalRate === null || row.blatantRefusalRate < 0.8) continue
    // Second, tighter: never worse than the source measured. At the anchor
    // quota the two coincide wherever the source scored zero, and they diverge
    // only where it did not — in which case the source's own rate is the
    // honest ceiling rather than the stratum's bound.
    if (POSITIVE_STRATA.some((k) => row.byStratum[k].n > 0 && row.byStratum[k].rate > sourceRate[k])) continue

    const inside = positives.filter((r) => {
      const d = dOf(r.z_raw, w)
      return d > 0 && d < 1
    }).length
    viable.push({
      window: w,
      row,
      rows: rw,
      span: Number((w.cosCeil - w.cosFloor).toFixed(2)),
      rampShare: positives.length ? inside / positives.length : 0,
      drift: drift(row),
    })
  }
  if (!viable.length) return null

  // `chooseWindow` ranks gatePrecision -> larger tau -> wider span. The middle
  // key is CONSTANT here, so it is replaced rather than kept as decoration.
  const rank = (a, b) =>
    b.row.gatePrecision - a.row.gatePrecision || a.drift - b.drift || b.span - a.span || a.window.cosFloor - b.window.cosFloor
  const graded = viable.filter((v) => v.rampShare >= 0.33).sort(rank)
  const pool = graded.length ? graded : viable.slice().sort(rank)

  return {
    ...pool[0],
    viableCount: viable.length,
    gradedCount: graded.length,
    shortlist: pool.slice(0, 6).map((v) => ({
      window: v.window,
      tau,
      gatePrecision: v.row.gatePrecision,
      blatant: v.row.blatantRefusalRate,
      rampShare: v.rampShare,
      drift: v.drift,
    })),
  }
}

/**
 * One row of the sweep at a candidate threshold.
 *
 * Positives are scored on PASSING, negatives on REFUSING, and `X` is scored on
 * REFUSAL ALONE, cause-agnostic — RAG-SPEC 5.6 step 3. Scoring `X` on the cause
 * during the sweep would be circular: `wouldPassUnscoped` is itself thresholded
 * at tau, so the cause moves with the very number being chosen. The cause is
 * checked once, at the end, and a miss there is a stratum-authoring miss.
 */
function sweepRow(rows, tau, field = 'G') {
  const refused = (r) => r[field] < tau
  const byStratum: Record<string, any> = {}
  for (const key of Object.keys(STRATA)) {
    const set = rows.filter((r) => r.stratum === key)
    const bad = set.filter((r) => (STRATA[key].positive ? refused(r) : !refused(r)))
    byStratum[key] = {
      n: set.length,
      // For a positive stratum: over-refusals. For a negative one: escapes.
      failures: bad.length,
      rate: set.length ? bad.length / set.length : null,
      ub95: wilsonUpper95(bad.length, set.length),
      ids: bad.map((r) => r.id),
    }
  }
  const negatives = rows.filter((r) => !STRATA[r.stratum].positive)
  const caught = negatives.filter(refused).length
  const n4 = byStratum.N4
  return {
    tau,
    byStratum,
    gatePrecision: negatives.length ? caught / negatives.length : null,
    blatantRefusalRate: n4.n ? 1 - n4.failures / n4.n : null,
    feasible: POSITIVE_STRATA.every((k) => byStratum[k].n === 0 || byStratum[k].ub95 <= STRATA[k].bound),
  }
}

/**
 * RAG-SPEC 5.6 step 4: the LARGEST tau satisfying all three positive bounds
 * simultaneously.
 *
 * Over-refusal is monotone in tau, so the feasible set is a prefix and "largest
 * feasible" is well defined. It is chosen without ever consulting gatePrecision
 * — step 6 forbids negative-catch from justifying a higher tau, and the only way
 * to make that structural rather than aspirational is for the selector not to
 * receive the number.
 */
function chooseTau(sweep) {
  let chosen = null
  for (const row of sweep) {
    if (row.feasible) chosen = row
    else break
  }
  return chosen
}

/**
 * RAG-SPEC 5.6 step 7 — "repeat with dense disabled for tauLexical".
 *
 * Step 4's rule cannot be repeated literally here, and the spec says why in
 * RAG-SPEC 3.2: with dense disabled "the single-channel invariant is
 * unsatisfiable by construction — the mode is a degradation, and its refusal
 * rates are reported as their own row, never pooled." The RAG-SPEC 5.4 table
 * agrees: `lexicalOnlyRefusalRate` is the one refusal metric with no threshold.
 * Applied literally, step 4 returns tauLexical = 0.00 on this corpus — a gate
 * that refuses nothing — because a Russian query has L = 0 against an English
 * index and no positive bound can survive it.
 *
 * So the constraint that carries over is the one step 5 states as a hard floor
 * rather than as a bound: a gate that cannot refuse a blatantly off-domain
 * question is indistinguishable from `guard.mode: 'off'`. The objective flips
 * with it — minimise over-refusal subject to the gate still being a gate:
 *
 *   tauLexical = the SMALLEST threshold whose blatantRefusalRate >= 0.80.
 *
 * This is an interpretation of an ambiguous step, and it is written down here
 * rather than buried: the over-refusal UB95 values it produces are reported
 * beside it, unbounded and unpooled, so the cost is visible either way.
 */
function chooseTauLexical(sweep) {
  return sweep.find((r) => r.tau >= 0.05 && r.blatantRefusalRate !== null && r.blatantRefusalRate >= 0.8) || null
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const index = loadIndex()
  const guard = index.manifest.guard
  const hash = index.manifest.hash
  /**
   * `manifest.vectors === null` — a `--no-embed` build, and the whole of the
   * signal. What follows is step 7 on its own: the cosine window, the tau sweep,
   * the zExp ladder and the three positive UB95 bounds are all statements about a
   * dense channel, and this index has none of one. Skipped rather than measured
   * against nothing, because a sweep over null Gs terminates perfectly happily
   * and produces a number.
   */
  const LEXICAL_ONLY = index.manifest.vectors === null
  // What produced the numbers, as opposed to what produced the text. See sigOf.
  const embedIdentity = [
    index.manifest.embedModel ?? null,
    index.manifest.dims ?? null,
    index.manifest.guard?.denseMode ?? null,
  ]
  const lev = levers(index.manifest)
  const allProbes = loadProbes()

  /**
   * A transfer measures ANCHORS, not the set. The cache cannot help it — `sigOf`
   * carries `embedIdentity`, so a different embedder misses every row, which is
   * the check that stopped an embedder swap from publishing the old model's
   * cosines as the new space's calibration. Every anchor is therefore a live
   * embedding call, and the count is the whole cost of the command.
   */
  const source = TRANSFER ? loadTransferSource(path.resolve(ROOT, TRANSFER), index) : null
  const probes = source ? pickAnchors(allProbes, ANCHORS) : allProbes

  console.log(`\nDocPilot gate calibration — RAG-SPEC 5.6`)
  console.log(
    `  index ${hash}  chunks ${index.manifest.chunkCount}  ` +
      (LEXICAL_ONLY ? 'no vectors — LEXICAL-ONLY (BM25) calibration' : `embed ${index.manifest.embedModel}`),
  )
  console.log(
    `  guard in: mode=${guard.denseMode} tau=${guard.tau} tauLexical=${guard.tauLexical} ` +
      `wDense=${guard.wDense} wLexical=${guard.wLexical} source=${guard.source}`,
  )
  console.log(`  probes ${probes.length} from ${path.relative(ROOT, PROBES)}`)
  if (source) {
    console.log(
      `  TRANSFER from ${path.relative(ROOT, path.resolve(ROOT, TRANSFER))} — ` +
        `measured with "${source.embedModel ?? 'an unnamed embedder'}" on index ${source.calibratedAt}`,
    )
    console.log(
      `    inheriting tau ${source.guard.tau} / tauLexical ${source.guard.tauLexical}; ` +
        `re-fitting the window against "${index.manifest.embedModel}"`,
    )
    console.log(
      `    ${probes.length} anchors of ${allProbes.length} — the UB95 bounds are NOT re-established at this n\n`,
    )
  } else {
    console.log('')
  }

  // ── cache ──────────────────────────────────────────────────────────────────
  const cache = new Map()
  if (!REFRESH && fs.existsSync(RAW)) {
    for (const line of fs.readFileSync(RAW, 'utf8').split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line)
        if (row.sig) cache.set(row.sig, row)
      } catch {
        /* a truncated cache line is a cache miss, not an error */
      }
    }
  }

  /**
   * Every text the loop below is about to embed, fetched in batches, once.
   *
   * Cache hits are left out because they cost nothing; `--sweep-only` is left
   * out because it embeds nothing at all and dies on its first miss instead; and
   * a `--no-embed` index is left out because it has no dense channel to measure.
   * The composed follow-up text is built here by the same expression
   * `probeOne` uses, so the two ask for the same string or the map simply misses.
   */
  if (!SWEEP_ONLY && index.manifest.vectors !== null) {
    const pending = []
    for (const rec of probes) {
      if (cache.has(sigOf(rec, hash, lev, embedIdentity))) continue
      pending.push(rec.question)
      if (rec.prev_question) pending.push(`${rec.prev_question}\n${rec.question}`)
    }
    if (pending.length) await prefetchEmbeddings(pending, index)
  }

  const rows = []
  let embedded = 0
  const ladderPages = index.manifest.pages
  for (const rec of probes) {
    const sig = sigOf(rec, hash, lev, embedIdentity)
    const hit = cache.get(sig)
    if (hit) {
      rows.push(hit)
      continue
    }
    if (SWEEP_ONLY) {
      die(
        `--sweep-only, but ${rec.id} is not in ${path.relative(ROOT, RAW)}. ` +
          `Run without --sweep-only once to populate it.`,
      )
    }
    let row
    try {
      row = await probeOne({ rec, index, guard, ladderPages })
    } catch (e) {
      if (/fetch failed|ECONNREFUSED|embed \d+/i.test(String(e.message || e))) {
        die(
          `embed endpoint unreachable at ${EMBED_BASE} — ${e.message || e}` +
            (EMBED_PROVIDER === 'ollama'
              ? `\n        start it with:  ollama serve` +
                `\n        pull the model: ollama pull ${index.manifest.embedModel}`
              : `\n        check DOCPILOT_EMBED_URL and the key in .env.local`),
        )
      }
      throw e
    }
    row.sig = sig
    rows.push(row)
    embedded++
    if (embedded % 20 === 0) tick(`probed ${embedded} new…`)
  }
  if (embedded) tock(`probed ${embedded} new, ${rows.length - embedded} cached`)
  else console.log(`  all ${rows.length} probes served from the cache`)

  // Rewrite the cache with every row currently known, so a partial run still
  // leaves the file usable and a probe removed from the set stops costing.
  fs.writeFileSync(RAW, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  // ── step 3 + 4 ─────────────────────────────────────────────────────────────
  const positives = rows.filter((r) => STRATA[r.stratum].positive)
  const withGold = positives.filter((r) => r.retrievalMiss !== null)
  const misses = withGold.filter((r) => r.retrievalMiss)
  const retrievalMissRate = withGold.length ? misses.length / withGold.length : 0

  // RAG-SPEC 5.4: retrieval misses are "excluded from the three bounds above".
  // A positive whose gold page is in neither channel's top-20 is measuring the
  // probe set, not the gate — charging its refusal to over-refusal would let a
  // badly authored question drag tau down and call the result a gate property.
  // They are still counted in `retrievalMisses`, which has its own FAIL.
  const missIds = new Set(misses.map((r) => r.id))
  const scored = rows.filter((r) => !missIds.has(r.id))

  // The window is swept beside tau, in cosine mode only — in zscore mode D comes
  // off the z ladder and there is no window to move. `rows` is re-scored IN
  // PLACE at the winner so every downstream reader (the report, the bounding
  // list, `scored`, which shares these objects) sees one consistent G. The RAW
  // cache is already on disk by this point and keeps the values as MEASURED,
  // which is what makes `--sweep-only` able to try a different window for free.
  /**
   * The source's per-stratum over-refusal at its own chosen tau — the ceiling a
   * transferred window may not raise. `sweepDoc` persists failures and n rather
   * than the rate, so it is recomputed here from the pair rather than assumed.
   * A stratum the source never measured constrains nothing and is left at 0,
   * which is the strict reading: no evidence is not permission.
   */
  const sourceRate = source
    ? Object.fromEntries(
        POSITIVE_STRATA.map((k) => {
          const s = source.chosen?.byStratum?.[k]
          return [k, s && s.n > 0 ? s.failures / s.n : 0]
        }),
      )
    : null

  const transferred = source ? fitWindowAtTau(scored, guard, source.guard.tau, sourceRate) : null
  const searched = source
    ? transferred
    : !LEXICAL_ONLY && guard.denseMode === 'cosine'
      ? chooseWindow(scored, guard)
      : null
  const win = searched ? searched.window : { cosFloor: guard.cosFloor, cosCeil: guard.cosCeil }
  if (source && !transferred) {
    die(
      `no window of ${WINDOWS.length} carries tau ${source.guard.tau} onto "${index.manifest.embedModel}" ` +
        `without over-refusing past what the source measured.\n` +
        `        That is an answer about the embedder, not a failure to search: this one does not\n` +
        `        separate the corpus the way the source's did. Measure it — \`npx docpilot calibrate\`.`,
    )
  }
  if (source) {
    regate(rows, win, guard).forEach((r, i) => Object.assign(rows[i], r))
    console.log(
      `  window: [${win.cosFloor}, ${win.cosCeil}] from ${WINDOWS.length} candidates — ` +
        `${transferred.viableCount} viable, ${transferred.gradedCount} non-degenerate  ` +
        `(source measured [${source.guard.cosFloor}, ${source.guard.cosCeil}] on "${source.embedModel}")`,
    )
    console.log('           window        tau   gatePrec  blatant  ramp  drift')
    for (const s of transferred.shortlist) {
      console.log(
        `           [${s.window.cosFloor}, ${s.window.cosCeil}]  ${s.tau.toFixed(2)}   ` +
          `${(100 * s.gatePrecision).toFixed(1)}%     ${(100 * s.blatant).toFixed(0)}%     ` +
          `${(100 * s.rampShare).toFixed(0)}%   ${s.drift.toFixed(3)}`,
      )
    }
  } else if (searched) {
    regate(rows, win, guard).forEach((r, i) => Object.assign(rows[i], r))
    console.log(
      `  window: [${win.cosFloor}, ${win.cosCeil}] from ${WINDOWS.length} candidates — ` +
        `${searched.viableCount} viable, ${searched.gradedCount} non-degenerate  ` +
        `(was [${guard.cosFloor}, ${guard.cosCeil}], ${guard.source})`,
    )
    console.log('           window        tau   gatePrec  blatant  ramp')
    for (const s of searched.shortlist) {
      console.log(
        `           [${s.window.cosFloor}, ${s.window.cosCeil}]  ${s.tau.toFixed(2)}   ` +
          `${(100 * s.gatePrecision).toFixed(1)}%     ${(100 * s.blatant).toFixed(0)}%     ` +
          `${(100 * s.rampShare).toFixed(0)}%`,
      )
    }
  } else if (LEXICAL_ONLY) {
    console.log(`  window: not swept — cosFloor/cosCeil map a cosine, and there are none`)
  } else if (guard.denseMode === 'cosine') {
    console.log(
      `  window: no candidate of ${WINDOWS.length} yields a feasible tau above wLexical ` +
        `with blatantRefusalRate >= 80% — keeping [${win.cosFloor}, ${win.cosCeil}]`,
    )
  }
  const guardOut = { ...guard, cosFloor: win.cosFloor, cosCeil: win.cosCeil }

  // No hybrid sweep on a vectorless index. `sweepRow` compares `r.G < tau`, and
  // `G` is null on every row here — `null < tau` is `0 < tau`, so the sweep would
  // run to completion reporting every probe refused, and `chooseTau` would hand
  // back a row that reads exactly like a measurement of a real distribution.
  /**
   * A transfer derives NO threshold. `best` stays null because `chooseTau` was
   * never asked, and every field downstream that reads it — `doc.chosen`, the
   * two UB95 numbers on the guard — is nulled in `buildDoc` for exactly that
   * reason. What the anchors produce instead is `transferCheck`, which carries
   * its own n so a small-sample rate can never be read as the corpus's.
   */
  const sweep = source ? [] : LEXICAL_ONLY ? [] : searched ? searched.sweep : TAU_STEPS.map((t) => sweepRow(scored, t, 'G'))
  const best = source ? null : LEXICAL_ONLY ? null : searched ? searched.best : chooseTau(sweep)
  const tau = source ? source.guard.tau : best ? best.tau : null

  const sweepLex = source ? [] : TAU_STEPS.map((t) => sweepRow(scored, t, 'G_lex'))
  const bestLex = source ? null : chooseTauLexical(sweepLex)
  const tauLexical = source ? source.guard.tauLexical : bestLex ? bestLex.tau : null

  // The anchors, scored at the pair that is about to ship. `fitWindowAtTau` has
  // already refused anything over the source's rates, so this is a report rather
  // than a second gate — but it is the number the artefact publishes about
  // itself, and the docs quote it rather than the source's.
  const transferCheck = source
    ? {
        anchorCount: probes.length,
        probeCount: allProbes.length,
        window: win,
        byStratum: Object.fromEntries(
          Object.keys(STRATA)
            .filter((k) => transferred.row.byStratum[k].n > 0)
            .map((k) => [
              k,
              {
                n: transferred.row.byStratum[k].n,
                failures: transferred.row.byStratum[k].failures,
                rate: transferred.row.byStratum[k].rate,
                sourceRate: sourceRate[k] ?? null,
              },
            ]),
        ),
        gatePrecision: transferred.row.gatePrecision,
        blatantRefusalRate: transferred.row.blatantRefusalRate,
        rampShare: transferred.rampShare,
        drift: transferred.drift,
      }
    : null

  const fails = []
  // `no-feasible-tau` diagnoses a score function that cannot separate this corpus.
  // A null tau on a vectorless index diagnoses nothing — half the score function
  // is absent by construction — and failing the run for it would leave the one
  // threshold this index does use, `tauLexical`, unwritten.
  if (!LEXICAL_ONLY && (tau === null || tau < 0.05)) {
    fails.push({
      name: 'no-feasible-tau',
      detail:
        `no tau >= 0.05 satisfies all three positive UB95 bounds simultaneously ` +
        `(largest feasible ${tau === null ? 'none' : tau.toFixed(2)}). ` +
        `RAG-SPEC 5.6: a broken score function, or a wrong zExp(n).`,
    })
  }
  if (tau !== null && tau <= guard.wLexical) {
    fails.push({
      name: 'tau-below-wlexical',
      detail:
        `chosen tau ${tau.toFixed(2)} <= wLexical ${guard.wLexical}: the RAG-SPEC 3.4.4 ` +
        `single-channel invariant would be violated — the lexical channel would clear ` +
        `the gate with zero dense evidence.`,
    })
  }
  if (best && best.blatantRefusalRate !== null && best.blatantRefusalRate < 0.8) {
    fails.push({
      name: 'blatant-refusal-below-floor',
      detail:
        `blatantRefusalRate ${pct(best.blatantRefusalRate)} < 80% at tau ${tau.toFixed(2)}: ` +
        `a gate that cannot refuse an off-domain general question is indistinguishable ` +
        `from guard.mode "off" and must never ship stamped as calibrated.`,
    })
  }
  if (retrievalMissRate > 0.05) {
    fails.push({
      name: 'retrieval-misses-above-floor',
      detail:
        `retrievalMisses ${pct(retrievalMissRate)} of ${withGold.length} positives carrying a ` +
        `gold page (> 5%): the probe set is being measured, not the gate. ` +
        `Missed: ${misses.map((r) => r.id).join(', ')}`,
    })
  }
  // The step-7 counterpart. RAG-SPEC 5.4 gives `lexicalOnlyRefusalRate` no
  // over-refusal threshold — the mode is a declared degradation whose rates are
  // "reported separately, never pooled" — so the condition that carries over is
  // the one from step 5's third bullet, applied to the degraded threshold: a
  // tauLexical that cannot refuse a blatantly off-domain question is a gate that
  // is off, and `lexical-only` is precisely the mode nobody can see is on.
  // Not run for a transfer: `tauLexical` is inherited rather than swept, so
  // `bestLex` is null by construction and failing on it would report the absence
  // of a search as the failure of one. The source earned that threshold against
  // the full set, and the lexical channel is BM25 over text — the one half of
  // the score an embedder swap does not move.
  if (!source && bestLex === null) {
    fails.push({
      name: 'lexical-blatant-refusal-below-floor',
      detail:
        `no tauLexical >= 0.05 reaches blatantRefusalRate 80% with dense disabled: the ` +
        `degraded mode would pass off-domain general questions, and RAG-SPEC 3.2 forbids ` +
        `surfacing that it is even in that mode.`,
    })
  }

  // ── step 8: the ladder ─────────────────────────────────────────────────────
  const ladderRows = rows.filter((r) => r.ladder && r.ladder.length === LADDER_N.length)
  const zexp = LADDER_N.map((_, rung) => {
    const ns = ladderRows.map((r) => r.ladder[rung].n).sort((a, b) => a - b)
    const zs = ladderRows.map((r) => r.ladder[rung].z).sort((a, b) => a - b)
    const med = (a) => (a.length ? (a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2) : null)
    // n is rounded: `zExp` interpolates on ln(n) and a half-chunk scope is not
    // a thing that exists. The median is over ACTUAL scoped chunk counts, not
    // over the requested rung, because a page-contiguous scope overshoots.
    return { n: med(ns) == null ? null : Math.round(med(ns)), z: Number(med(zs)?.toFixed(4)) }
  }).filter((e) => e.n != null)

  // What tau would be if the probes that pin it were not in the set. Not a
  // proposal — a robustness number. When one probe out of 315 moves tau by 0.16
  // the result is a property of that probe, and saying so is the difference
  // between a calibration and a coincidence.
  const bounding = boundingProbes(sweep, tau)
  const withoutBounding = bounding.newlyRefused.length
    ? chooseTau(
        TAU_STEPS.map((t) =>
          sweepRow(scored.filter((r) => !bounding.newlyRefused.some((b) => b.id === r.id)), t, 'G'),
        ),
      )
    : null

  const ctx = {
    rows,
    scored,
    sweep,
    sweepLex,
    best,
    bestLex,
    tau,
    tauLexical,
    lexicalOnly: LEXICAL_ONLY,
    fails,
    // Carries the SWEPT window, so `calibration.json` ships the pair that was
    // measured rather than the pair the index happened to be built with.
    guard: guardOut,
    index,
    zexp,
    retrievalMissRate,
    withGold: withGold.length,
    misses,
    bounding,
    withoutBounding,
    probeFile: path.relative(ROOT, PROBES),
    source,
    transferCheck,
  }

  report(ctx)

  // The markdown report is written whether or not calibration passed: RAG-SPEC
  // 5.6 step 5 protects `calibration.json` — the file something downstream
  // CONSUMES — and a failed calibration you cannot read is a failure twice.
  const doc = buildDoc(ctx)
  fs.writeFileSync(OUT_MD, markdown(doc, ctx))

  if (fails.length) {
    /**
     * STDERR, because this is the failure and not the product.
     *
     * It went to stdout, which meant `docpilot calibrate > log.txt` swallowed
     * the only sentence explaining why `calibration.json` had not moved, and a
     * CI job showing the last twenty lines of stdout showed the report it DID
     * write instead. The markdown diagnosis is still written first, and is
     * still where the detail lives.
     */
    console.error(`\n  CALIBRATION FAILED — ${path.relative(ROOT, OUT_JSON)} left untouched`)
    console.error(`  diagnosis written to ${path.relative(ROOT, OUT_MD)}\n`)
    for (const f of fails) console.error(`    ${f.name}\n      ${f.detail}\n`)
    process.exit(FAILED)
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n')
  console.log(`\n  wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`)
  console.log(`  run \`npx docpilot index\` to inline the new guard into the manifest\n`)
}

// ── output ───────────────────────────────────────────────────────────────────

/** Every probe that would flip if tau took one more step. RAG-SPEC 5.6 step 8. */
function boundingProbes(sweep, tau) {
  if (tau === null) return { blocked: [], newlyRefused: [] }
  const next = sweep.find((r) => Math.abs(r.tau - (tau + 0.01)) < 1e-9)
  if (!next) return { blocked: [], newlyRefused: [] }
  const blocked = POSITIVE_STRATA.filter(
    (k) => next.byStratum[k].n > 0 && next.byStratum[k].ub95 > STRATA[k].bound,
  )
  const here = new Set(POSITIVE_STRATA.flatMap((k) => sweep.find((r) => r.tau === tau).byStratum[k].ids))
  const newlyRefused = blocked.flatMap((k) =>
    next.byStratum[k].ids.filter((id) => !here.has(id)).map((id) => ({ id, stratum: k })),
  )
  return { blocked, newlyRefused }
}

function backlog(rows, tau, field = 'G') {
  return rows
    .filter((r) => STRATA[r.stratum].positive && r[field] >= tau)
    .sort((a, b) => a[field] - b[field])
    .slice(0, 10)
    .map((r) => ({ id: r.id, stratum: r.stratum, G: Number(r[field].toFixed(4)), margin: Number((r[field] - tau).toFixed(4)) }))
}

function report(ctx) {
  const { rows, best, bestLex, tau, tauLexical, sweep, sweepLex, lexicalOnly, retrievalMissRate, withGold, misses, bounding } = ctx
  const line = (k, v) => console.log(`  ${String(k).padEnd(30)} ${v}`)

  // The columns mean the same thing either way; what changes is the score under
  // them. On a vectorless index there is no `G` sweep to print, and printing an
  // empty table under the usual heading would read as a run that found nothing.
  const shownSweep = lexicalOnly ? sweepLex : sweep
  console.log(
    lexicalOnly
      ? '\n── sweep on G_lex (every 5th step) ─────────────────────────────'
      : '\n── sweep (every 5th step) ──────────────────────────────────────',
  )
  console.log('   tau    U ovr  UB95    S ovr  UB95    F ovr  UB95   negCaught  N4')
  for (const r of shownSweep) {
    if (Math.round(r.tau * 100) % 5) continue
    const c = (k) => `${String(r.byStratum[k].failures).padStart(3)}/${String(r.byStratum[k].n).padEnd(3)} ${num(r.byStratum[k].ub95)}`
    console.log(
      `  ${r.tau.toFixed(2)}  ${c('U')}  ${c('S')}  ${c('F')}   ` +
        `${pct(r.gatePrecision)}   ${pct(r.blatantRefusalRate)}${r.feasible ? '  ok' : ''}`,
    )
  }

  console.log('\n── chosen ──────────────────────────────────────────────────────')
  // "NONE" means the sweep looked and found nothing shippable. On a vectorless
  // index nothing was swept, and the two must not print the same word.
  line(
    'tau (largest feasible)',
    lexicalOnly ? 'not measurable — index has no vectors' : tau === null ? 'NONE' : tau.toFixed(2),
  )
  line('tauLexical', tauLexical === null ? 'NONE' : tauLexical.toFixed(2))
  if (best) {
    for (const k of POSITIVE_STRATA) {
      const s = best.byStratum[k]
      line(`${STRATA[k].metric}`, `${s.failures}/${s.n}  UB95 ${num(s.ub95)}  (bound ${STRATA[k].bound})`)
    }
    line('gatePrecision (target .60)', pct(best.gatePrecision))
    line('blatantRefusalRate (>= .80)', pct(best.blatantRefusalRate))
    console.log('\n  per stratum at the chosen tau')
    for (const k of Object.keys(STRATA)) {
      const s = best.byStratum[k]
      if (!s.n) continue
      const wrongWay = STRATA[k].positive ? 'refused' : 'escaped'
      line(`  ${k} — ${STRATA[k].label}`, `${wrongWay} ${s.failures}/${s.n}  ${pct(1 - s.rate)} correct`)
    }
  }
  if (bestLex) {
    // On a vectorless index this is not the degradation row RAG-SPEC 3.2 keeps
    // unpooled — there is nothing to pool it with. It is the calibration.
    console.log(
      lexicalOnly
        ? '\n  lexical-only — the whole of the gate on this index'
        : '\n  lexical-only (reported separately, never pooled — RAG-SPEC 3.2)',
    )
    for (const k of POSITIVE_STRATA) {
      const s = bestLex.byStratum[k]
      line(`  ${k} over-refusal`, `${s.failures}/${s.n}  UB95 ${num(s.ub95)}`)
    }
    line('  gatePrecision', pct(bestLex.gatePrecision))
    line('  blatantRefusalRate', pct(bestLex.blatantRefusalRate))
  }
  line(
    'retrievalMisses',
    withGold
      ? `${misses.length}/${withGold}  ${pct(retrievalMissRate)}  (bound 5%)`
      : // `0/0  0%  (bound 5%)` read exactly like a bound that had passed. It is
        // measured over probes carrying `gold_page`, and this repository's 597
        // carry none.
        'bound not armed: no probe carries `gold_page`',
  )

  if (bounding.newlyRefused.length) {
    console.log(`\n  bounding probes (refused at tau ${(tau + 0.01).toFixed(2)}):`)
    for (const b of bounding.newlyRefused.slice(0, 12)) {
      const r = rows.find((x) => x.id === b.id)
      console.log(`    ${b.id.padEnd(8)} ${b.stratum.padEnd(3)} G=${num(r.G)}`)
    }
  }
}

/** The RAG-SPEC 5.6 step-1 sizes, so the report can price its own reduction. */
const SPEC_SIZE = { U: 180, S: 60, F: 60, N1: 30, N2: 30, N3: 30, N4: 30, N5: 30, N6: 30, X: 30, P: 30 }

/** Smallest n at which the bound still holds with `f` failures. */
function nForFailures(bound, f) {
  for (let n = f + 1; n <= 4000; n++) if (wilsonUpper95(f, n) <= bound) return n
  return null
}

function buildDoc(ctx) {
  const { rows, scored, sweep, sweepLex, best, bestLex, tau, tauLexical, lexicalOnly, guard, index, zexp, retrievalMissRate, withGold, misses, probeFile, fails, bounding, withoutBounding, source, transferCheck } = ctx
  const byStratumN = {}
  for (const k of Object.keys(STRATA)) {
    const n = rows.filter((r) => r.stratum === k).length
    if (n) byStratumN[k] = n
  }
  const spec = SPEC_SIZE

  // The sweep row that describes the gate this index actually ships. On a
  // vectorless index that is the lexical one — reporting a calibrated guard with
  // no over-refusal and no precision beside it is the shape of an uncalibrated
  // one, and `source` already says which channel the numbers came off.
  const measured = lexicalOnly ? bestLex : best

  const doc = {
    ok: fails.length === 0,
    fails,
    version: 1,
    /**
     * WHEN, WHERE, AGAINST WHAT, AND AT WHAT COST — the four facts this document
     * described the input with and never the run.
     *
     * `calibratedAt` is the corpus hash: it says which index, and nothing about
     * the circumstances. Two calibrations of one index against two embedding
     * endpoints were indistinguishable here, and `embedRequests` was printed on
     * stdout during the run (`prefetchEmbeddings`) and then thrown away — the
     * one number that says what a rerun will cost.
     *
     * The address is an ORIGIN, never a full URL and never a key: this file is
     * committed, and a query string can carry a credential.
     */
    ranAt: new Date().toISOString(),
    embedBase: originOf(EMBED_BASE),
    probeSha: probeSha(),
    embedRequests: EMBED_REQUESTS.count,
    calibratedAt: index.manifest.hash,
    embedModel: index.manifest.embedModel,
    /**
     * The vocabulary this run tokenised with — read off the MANIFEST rather than
     * off `text.js`'s module state, because the manifest is what the index was
     * built with and the module state is only what happens to be installed.
     *
     * `guardFor` compares it. Without it a threshold measured before a map was
     * declared inlines itself onto an index tokenised with one, and nothing
     * anywhere says so: the index hash is over chunk text and does not move.
     */
    vocabHash: index.manifest.vocabHash ?? null,
    /**
     * Whether the index this was measured on has vectors at all.
     *
     * `guard.tau: null` alone is ambiguous in the one way that matters: it is
     * also what a hybrid run writes when no threshold in the grid is feasible,
     * and that is a FAILURE that must be fixed, while this is a measurement that
     * is finished. `embedModel: null` implies it but does not say it, and
     * RAG-SPEC 6 keeps `manifest.vectors` as the single signal for this — so it
     * is restated here rather than re-derived by every reader of this file.
     */
    lexicalOnly,
    chunkCount: index.manifest.chunkCount,
    probeFile,
    probeCount: rows.length,
    byStratum: byStratumN,
    specStratumSize: spec,
    guard: {
      tau,
      tauLexical,
      wDense: guard.wDense,
      wLexical: guard.wLexical,
      denseMode: guard.denseMode,
      cosFloor: guard.cosFloor,
      cosCeil: guard.cosCeil,
      // NOT "calibrated": the probe set is below the RAG-SPEC 5.6 size, so the
      // UB95 intervals are wider than the spec sized them for. The suffix, and
      // the per-stratum n above, are what stop this being read as the full run.
      //
      // The lexical-only variant says which half of the guard was measured. Half
      // of it — `tau`, `cosFloor`, `cosCeil`, `zexp` — is not stale here, it was
      // never measurable, and a `source` that did not distinguish the two would
      // make an untouched provisional value read as a calibrated one.
      //
      // `transferred-window` is the third case and the weakest claim of the three: the
      // window under it was fitted against this embedder, the thresholds beside
      // it were measured against another one, and the UB95 bounds were not
      // re-established at anchor size. It is stamped into every record of the
      // session for the same reason `provisional` is.
      source: source ? 'transferred-window' : lexicalOnly ? 'calibrated-reduced-lexical' : 'calibrated-reduced',
      calibratedAt: index.manifest.hash,
      zexp,
      zexpSource: zexp.length >= 2 ? 'measured' : 'closed-form',
      // Null on a transfer, and not for want of a number to put here: both come
      // off the winning sweep row, there is no winning sweep row when tau was
      // inherited, and an anchor-scale figure in these two fields would ride
      // into the manifest and every feedback record reading as the corpus's.
      // `transferCheck` carries the anchor numbers WITH their n instead.
      overRefusalUB95: source ? null : measured ? measured.byStratum.U.ub95 : null,
      gatePrecision: source ? null : measured ? measured.gatePrecision : null,
    },
    ...(source
      ? {
          transferredFrom: {
            embedModel: source.embedModel ?? null,
            calibratedAt: source.calibratedAt ?? null,
            source: source.guard.source ?? null,
            probeCount: source.probeCount ?? null,
            tau: source.guard.tau,
            tauLexical: source.guard.tauLexical,
            cosFloor: source.guard.cosFloor,
            cosCeil: source.guard.cosCeil,
          },
          transferCheck,
        }
      : {}),
    // Each bound with the arithmetic that decides whether it can bind at all.
    // `tolerates` is the number of failures the stratum's own n can absorb —
    // when it is 0, tau is decided by a single probe and UB95 has stopped doing
    // the job RAG-SPEC 5.4 introduced it for.
    bounds: Object.fromEntries(
      Object.entries(STRATA)
        .filter(([, v]) => v.positive)
        .map(([k, v]) => {
          const n = byStratumN[k] || 0
          let tolerates = 0
          while (n && wilsonUpper95(tolerates + 1, n) <= v.bound) tolerates++
          return [
            v.metric,
            {
              stratum: k,
              bound: v.bound,
              n,
              specN: spec[k],
              ub95AtZero: n ? wilsonUpper95(0, n) : null,
              tolerates,
              nForOneFailure: nForFailures(v.bound, 1),
            },
          ]
        }),
    ),
    chosen: best && {
      tau,
      byStratum: best.byStratum,
      gatePrecision: best.gatePrecision,
      blatantRefusalRate: best.blatantRefusalRate,
    },
    chosenLexical: bestLex && {
      tauLexical,
      byStratum: bestLex.byStratum,
      gatePrecision: bestLex.gatePrecision,
      blatantRefusalRate: bestLex.blatantRefusalRate,
    },
    /**
     * `armed` — whether this bound was measured on anything at all.
     *
     * `retrievalMiss` is null on a probe with no `gold_page`, and NOT ONE of the
     * 597 probes in this repository's `calibration.jsonl` carries that key. So
     * `withGold` is 0, the rate is 0, the 5 % floor cannot fire, and the report
     * printed `0/0  0%  (bound 5%)` — which reads exactly like a bound that
     * passed. Marking the set empty says the difference out loud; annotating the
     * 597 probes is the author's debt, not this file's.
     */
    retrievalMisses: {
      rate: retrievalMissRate,
      n: withGold,
      armed: withGold > 0,
      ids: misses.map((r) => r.id),
    },
    boundingProbes: bounding,
    tauWithoutBoundingProbes: withoutBounding ? withoutBounding.tau : null,
    // The backlog is the positives nearest the threshold a reader will actually
    // be gated by. On a vectorless index that is `tauLexical` over `G_lex`; asked
    // for `G` it would sort ten nulls and hand back a list of them.
    backlog: lexicalOnly ? backlog(scored, tauLexical, 'G_lex') : backlog(scored, tau, 'G'),
    sweep: sweep.map(sweepDoc),
    /**
     * The step-7 sweep, which had no record on disk at all — only a four-row
     * table in the markdown.
     *
     * `chosenLexical` names the row that was taken without showing how close the
     * alternatives were, so `tauLexical` could not be re-derived or second-guessed
     * from this file the way `tau` always could. On a vectorless index it is the
     * only sweep there is, which is what made the omission worth fixing rather
     * than worth noting.
     */
    sweepLexical: sweepLex.map(sweepDoc),
  }
  return doc
}

/** One sweep row as `calibration.json` records it — both sweeps, one shape. */
const sweepDoc = (r) => ({
  tau: r.tau,
  feasible: r.feasible,
  gatePrecision: r.gatePrecision,
  blatantRefusalRate: r.blatantRefusalRate,
  byStratum: Object.fromEntries(
    Object.entries<any>(r.byStratum).map(([k, v]) => [k, { failures: v.failures, n: v.n, ub95: v.ub95 }]),
  ),
})
/**
 * The line an empty sweep prints instead of a header with nothing under it.
 *
 * Named once because two sections need it and because the source of the
 * inheritance is the fact a reader is missing: "not measured" alone leaves them
 * asking where the threshold above came from.
 */
const inheritedNote = (doc) =>
  doc.transferredFrom
    ? `Inherited from \`${doc.transferredFrom.embedModel ?? 'another embedder'}\` ` +
      `(corpus \`${doc.transferredFrom.calibratedAt ?? '?'}\`) — **not measured on a transfer**. ` +
      `\`--transfer\` keeps the threshold and re-fits only the cosine window, so there is no ` +
      `sweep to show. The window it did fit is in the table above.`
    : 'Not measured on this run.'

function markdown(doc, ctx) {
  const { rows, scored, sweep, sweepLex, best, bestLex, misses } = ctx
  const L = []
  const p = (v) => (v == null ? '—' : `${(100 * v).toFixed(1)}%`)
  const n3 = (v) => (v == null ? '—' : v.toFixed(3))
  const t2 = (v) => (v == null ? '**NONE**' : v.toFixed(2))
  const questionOf = (id) => (QUESTIONS.get(id) || '').replace(/\|/g, '\\|').slice(0, 88)

  /**
   * On a vectorless index every "at the chosen tau" section below is about
   * `tauLexical` over `G_lex`, because that pair IS the shipped gate — there is
   * no second one to keep it separate from. Named once here: `G` is null on
   * every row of such a run, and a table that read it would print a column of
   * dashes under a heading claiming to describe the gate.
   */
  const chosen = doc.lexicalOnly ? bestLex : best
  const gField = doc.lexicalOnly ? 'G_lex' : 'G'
  const uField = doc.lexicalOnly ? 'unscopedG_lex' : 'unscopedG'
  const chosenTau = doc.lexicalOnly ? doc.guard.tauLexical : doc.guard.tau

  L.push(`# Gate calibration — \`${doc.calibratedAt}\``)
  L.push('')
  L.push(
    `Produced by \`npx docpilot calibrate\` (RAG-SPEC 5.6). ` +
      (doc.lexicalOnly
        ? `No endpoint contacted at all — no embedder, no chat model,`
        : `Embed endpoint only — no chat model,`),
  )
  L.push(`no LLM judge, no unseeded randomness. Same corpus + same probes ⇒ same output.`)
  L.push('')

  if (doc.lexicalOnly) {
    L.push(`> ## Lexical-only index`)
    L.push(`>`)
    L.push(`> \`${doc.calibratedAt}\` was built with \`--no-embed\` and carries no vectors, so`)
    L.push(`> there is no dense channel to put a threshold on: **\`tau\` is null**, and null`)
    L.push(`> here means *not measurable*, not *measured and rejected*. \`tauLexical\` below is`)
    L.push(`> the only threshold this run produces, and on this index it is the only one the`)
    L.push(`> gate ever consults — \`G = L\` for every question.`)
    L.push(`>`)
    L.push(`> The lexical channel scores \`L = 0\` for a question asked in a language the corpus`)
    L.push(`> is not written in, whatever the answer is worth. Every over-refusal number below`)
    L.push(`> is to be read against that, and it is a property of the mode, not of \`tauLexical\`.`)
    L.push('')
  }

  if (!doc.ok) {
    L.push(`> ## CALIBRATION FAILED`)
    L.push(`>`)
    L.push(`> \`${path.relative(ROOT, OUT_JSON)}\` was **not** written; \`build-rag-index.js\` will keep`)
    L.push(`> inlining the provisional guard and warning about it. RAG-SPEC 5.6 step 5.`)
    L.push(`>`)
    for (const f of doc.fails) {
      L.push(`> **\`${f.name}\`** — ${f.detail}`)
      L.push(`>`)
    }
    L.push('')
  }

  L.push(`| | |`)
  L.push(`|---|---|`)
  L.push(
    `| index | \`${doc.calibratedAt}\`, ${doc.chunkCount} chunks, ` +
      `${doc.lexicalOnly ? 'no embedder (BM25 only)' : doc.embedModel} |`,
  )
  L.push(`| probes | ${doc.probeCount} from \`${doc.probeFile}\` |`)
  L.push(
    `| **tau** | ${doc.lexicalOnly ? '— *not measurable, no dense channel*' : `**${t2(doc.guard.tau)}**`} |`,
  )
  L.push(`| **tauLexical** | **${t2(doc.guard.tauLexical)}** |`)
  L.push(`| wDense / wLexical | ${doc.guard.wDense} / ${doc.guard.wLexical} |`)
  L.push(
    `| denseMode | ${doc.lexicalOnly ? 'none — the index has no vectors' : `${doc.guard.denseMode}, window [${doc.guard.cosFloor}, ${doc.guard.cosCeil}]`} |`,
  )
  L.push(`| source | \`${doc.guard.source}\` |`)
  L.push(`| gatePrecision | ${p(chosen?.gatePrecision)} (target 60%, never a constraint) |`)
  L.push('')

  L.push(`## Probe set, and what the reduction costs`)
  L.push('')
  L.push(`RAG-SPEC 5.6 sizes the strata at ~540 probes so \`UB95 <= 0.05\` is reachable.`)
  L.push(`With zero failures \`UB95(0,n) = z²/(n+z²)\`, \`z = 1.6449\`, so the 5% bound is`)
  L.push(`**unreachable below n = 52** whatever the gate does, and the 8% bound below n = 32.`)
  L.push(`This run keeps the three bounded positive strata above those floors and cuts the`)
  L.push(`negatives, which are a target (\`gatePrecision >= 0.60\`) and never a constraint.`)
  L.push('')
  L.push(`| stratum | spec n | this run | UB95 at 0 failures | UB95 at spec n | cost of the cut |`)
  L.push(`|---|---|---|---|---|---|`)
  const ub0 = (n) => (n ? 2.7057 / (n + 2.7057) : null)
  for (const [k, v] of Object.entries<any>(doc.byStratum)) {
    const s = doc.specStratumSize[k]
    L.push(
      `| ${k} | ${s} | ${v} | ${n3(ub0(v))} | ${n3(ub0(s))} | ` +
        `${s === v ? '—' : `${v > s ? '−' : '+'}${n3(Math.abs(ub0(v) - ub0(s)))}`} |`,
    )
  }
  L.push('')
  L.push(`The interval width is not the whole cost. What actually decides whether a bound can`)
  L.push(`bind is how many failures it tolerates at the n it has:`)
  L.push('')
  L.push(`| bound | stratum | n | ceiling | failures tolerated | n needed for 1 |`)
  L.push(`|---|---|---|---|---|---|`)
  for (const [metric, b] of Object.entries<any>(doc.bounds)) {
    L.push(
      `| \`${metric}\` | ${b.stratum} | ${b.n} (spec ${b.specN}) | ${b.bound} | ` +
        `**${b.tolerates}** | ${b.nForOneFailure} |`,
    )
  }
  L.push('')
  if (doc.lexicalOnly) {
    L.push(`None of the three bind on this index. \`chooseTauLexical\` does not test feasibility:`)
    L.push(`RAG-SPEC 3.2 makes the single-channel invariant unsatisfiable by construction with`)
    L.push(`dense disabled, so the ceilings above are there to be read against, not cleared.`)
    L.push('')
  }
  const zeroTol = Object.entries<any>(doc.bounds).filter(([, b]) => b.tolerates === 0)
  if (zeroTol.length && !doc.lexicalOnly) {
    L.push(
      `${zeroTol.map(([m]) => `\`${m}\``).join(' and ')} tolerate **zero** failures at this n: a ` +
        `single refused probe decides \`tau\`. That is the outcome RAG-SPEC 5.4 introduced UB95 ` +
        `to prevent, and for \`${zeroTol[0][0]}\` it persists at the spec's own ` +
        `n = ${zeroTol[0][1].specN} — the bound needs n = ${zeroTol[0][1].nForOneFailure} ` +
        `before one failure is survivable. Read \`tau\` accordingly.`,
    )
    L.push('')
  }

  L.push(`## Sweep (RAG-SPEC 5.6 step 3)`)
  L.push('')
  if (doc.lexicalOnly) {
    L.push(`Not run. \`G = wDense·D + wLexical·L\` has no \`D\` on this index, so there is no`)
    L.push(`hybrid threshold to sweep for. The sweep that WAS run is on \`G_lex\`, and it is in`)
    L.push(`[Lexical-only](#lexical-only-rag-spec-56-step-7) below — the same table, over the`)
    L.push(`only score this deployment computes.`)
    L.push('')
  } else {
    L.push(`\`X\` probes are scored on refusal alone, cause-agnostic, during the sweep —`)
    L.push(`\`wouldPassUnscoped\` is itself a function of tau. The cause is checked once, below.`)
    L.push(`Positives that are \`retrievalMisses\` are excluded from the three bounds (RAG-SPEC 5.4).`)
    L.push('')
    /**
     * A HEADING WITH NO ROWS UNDER IT READS AS A MEASUREMENT THAT PASSED.
     *
     * `--transfer` does not sweep — `tau` is inherited and only the cosine
     * window is re-fitted — so `sweep` is empty, and this table printed its
     * header and its separator and stopped. Nothing on the page said the sweep
     * had not been run; it looked like a sweep that had found nothing.
     */
    if (!sweep.length) {
      L.push(inheritedNote(doc))
      L.push('')
    } else {
    L.push(`| tau | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 | feasible |`)
    L.push(`|---|---|---|---|---|---|---|---|---|---|`)
    for (const r of sweep) {
      if (Math.round(r.tau * 100) % 5 && (doc.guard.tau == null || Math.abs(r.tau - doc.guard.tau) > 1e-9)) continue
      const c = (k) => `${r.byStratum[k].failures}/${r.byStratum[k].n}`
      L.push(
        `| ${r.tau.toFixed(2)} | ${c('U')} | ${n3(r.byStratum.U.ub95)} | ${c('S')} | ` +
          `${n3(r.byStratum.S.ub95)} | ${c('F')} | ${n3(r.byStratum.F.ub95)} | ` +
          `${p(r.gatePrecision)} | ${p(r.blatantRefusalRate)} | ${r.feasible ? 'yes' : ''} |`,
      )
    }
    L.push('')
    }
  }

  L.push(`## Every stratum at the chosen ${doc.lexicalOnly ? 'tauLexical' : 'tau'}`)
  L.push('')
  L.push(`| stratum | what it is | n | correct | wrong |`)
  L.push(`|---|---|---|---|---|`)
  for (const [k, v] of Object.entries(STRATA)) {
    const s = chosen?.byStratum[k]
    if (!s?.n) continue
    L.push(
      `| ${k} | ${v.label} | ${s.n} | ${p(1 - s.rate)} | ${s.failures}` +
        `${s.ids.length ? ` — ${s.ids.slice(0, 10).map((i) => `\`${i}\``).join(', ')}${s.ids.length > 10 ? ', …' : ''}` : ''} |`,
    )
  }
  L.push('')
  L.push(`\`gatePrecision\` **${p(chosen?.gatePrecision)}** against a target of 60%. RAG-SPEC 5.6`)
  L.push(`step 6: it may never justify raising the threshold past the rule that chose it, and`)
  L.push(`\`${doc.lexicalOnly ? 'chooseTauLexical' : 'chooseTau'}()\` is not given the number — the`)
  L.push(`constraint is structural, not a promise.`)
  L.push('')

  L.push(`### Where the strata sit on the ${gField} axis`)
  L.push('')
  L.push(`The separability question, before any threshold is chosen.`)
  L.push('')
  L.push(`| stratum | min ${gField} | median ${gField} | max ${gField} |`)
  L.push(`|---|---|---|---|`)
  for (const k of Object.keys(STRATA)) {
    const g = rows.filter((r) => r.stratum === k).map((r) => r[gField]).sort((a, b) => a - b)
    if (!g.length) continue
    L.push(`| ${k} | ${n3(g[0])} | ${n3(g[g.length >> 1])} | ${n3(g[g.length - 1])} |`)
  }
  L.push('')

  L.push(`## The probes that bound the chosen ${doc.lexicalOnly ? 'threshold' : 'tau'}`)
  L.push('')
  if (doc.boundingProbes.blocked.length) {
    L.push(
      `At tau ${(doc.guard.tau + 0.01).toFixed(2)} the bound` +
        `${doc.boundingProbes.blocked.length > 1 ? 's' : ''} ` +
        `${doc.boundingProbes.blocked.map((k) => `\`${STRATA[k].metric}\``).join(', ')} ` +
        `${doc.boundingProbes.blocked.length > 1 ? 'break' : 'breaks'}.`,
    )
    L.push('')
    L.push(`| probe | stratum | G | D | L | question |`)
    L.push(`|---|---|---|---|---|---|`)
    for (const b of doc.boundingProbes.newlyRefused) {
      const r = rows.find((x) => x.id === b.id)
      L.push(`| \`${b.id}\` | ${b.stratum} | ${n3(r.G)} | ${n3(r.D)} | ${n3(r.L)} | ${questionOf(b.id)} |`)
    }
    L.push('')
    if (doc.tauWithoutBoundingProbes != null) {
      L.push(
        `Without ${doc.boundingProbes.newlyRefused.length === 1 ? 'that probe' : 'those probes'}, ` +
          `\`tau\` would be **${doc.tauWithoutBoundingProbes.toFixed(2)}** instead of ` +
          `**${t2(doc.guard.tau)}**. That is a robustness number, not a proposal: deleting the ` +
          `probe that pins \`tau\` in order to make calibration pass is the one edit this ` +
          `procedure exists to prevent.`,
      )
      L.push('')
    }
  } else if (doc.lexicalOnly) {
    L.push(`\`tau\` is not measured on this index, so nothing bounds it. \`tauLexical\` is not`)
    L.push(`bounded by a probe either: \`chooseTauLexical\` takes the smallest threshold clearing`)
    L.push(`the \`N4\` floor, so what pins it is the blatant stratum, not a positive one.`)
    L.push('')
  } else {
    L.push(`No positive probe flips at tau + 0.01, so \`tau\` is not bounded by a named probe.`)
    L.push('')
  }

  L.push(`## Over-refusal backlog — the ten positives closest to ${doc.lexicalOnly ? 'tauLexical' : 'tau'}`)
  L.push('')
  L.push(`These pass today with the least margin: the first questions a reader loses if the`)
  L.push(`threshold moves, and the shortlist for a documentation fix.`)
  L.push('')
  L.push(`| probe | stratum | ${gField} | margin | question |`)
  L.push(`|---|---|---|---|---|`)
  for (const b of doc.backlog) {
    L.push(`| \`${b.id}\` | ${b.stratum} | ${n3(b.G)} | ${n3(b.margin)} | ${questionOf(b.id)} |`)
  }
  L.push('')

  L.push(`## Refusal causes at the chosen ${doc.lexicalOnly ? 'tauLexical' : 'tau'} (RAG-SPEC 5.6 step 3)`)
  L.push('')
  L.push(`\`X\` was scored cause-agnostically during the sweep. Here the cause is checked once:`)
  L.push(`a refused \`X\` probe whose \`wouldPassUnscoped\` is false at this threshold is a`)
  L.push(`**stratum-authoring miss**, not a gate failure.`)
  L.push('')
  if (doc.lexicalOnly) {
    // Not a caveat about this report — a property of the runtime the report
    // describes. `evaluate()` derives unscopedG from the UNSCOPED dense cosines
    // and skips it when there are none, so on a vectorless index the panel
    // cannot offer the widen affordance either. Reporting every refusal as an
    // authoring miss would blame the probe set for that.
    L.push(`\`wouldPassUnscoped\` is **not derivable** here. It comes from the best cosine over`)
    L.push(`the whole corpus, and this index has no cosines — which is also why the panel`)
    L.push(`cannot offer "search all docs" on a refusal in this mode. Every \`X\` probe below is`)
    L.push(`therefore scored on refusal alone, and the \`refuse:out-of-scope\` cause is out of`)
    L.push(`reach for the deployment as well as for the report.`)
    L.push('')
  }
  L.push(`| probe | refused | wouldPassUnscoped | cause | verdict |`)
  L.push(`|---|---|---|---|---|`)
  for (const r of rows.filter((x) => x.stratum === 'X')) {
    const refused = chosenTau != null && r[gField] < chosenTau
    const wpu = r[uField] != null && chosenTau != null && r[uField] >= chosenTau
    const cause = !refused ? '—' : wpu ? '`refuse:out-of-scope`' : '`refuse:no-evidence`'
    const verdict = !refused ? 'ESCAPED' : doc.lexicalOnly ? 'correct' : wpu ? 'correct' : 'authoring miss'
    L.push(`| \`${r.id}\` | ${refused ? 'yes' : 'no'} | ${wpu ? 'yes' : 'no'} | ${cause} | ${verdict} |`)
  }
  L.push('')

  L.push(`## Lexical-only (RAG-SPEC 5.6 step 7)`)
  L.push('')
  if (doc.lexicalOnly) {
    L.push(`Not a degradation on this index — the whole of the gate. There is no hybrid row to`)
    L.push(`keep these numbers out of, and \`G = L\` against \`tauLexical\` is what every reader of`)
    L.push(`this site is scored by.`)
  } else {
    L.push(`Dense disabled — the mode RAG-SPEC 3.2 defines for an unreachable embedder, where`)
    L.push(`\`G = L\` against \`tauLexical\`. Its rates are reported here and **never pooled**`)
    L.push(`with the hybrid numbers.`)
  }
  L.push('')
  L.push(`Step 4's selection rule is not repeated literally: RAG-SPEC 3.2 says the`)
  L.push(`single-channel invariant is *unsatisfiable by construction* in this mode, and`)
  L.push(`RAG-SPEC 5.4 gives \`lexicalOnlyRefusalRate\` no threshold. Applied literally, step 4`)
  L.push(`returns \`tauLexical = 0.00\` on this corpus — a gate that refuses nothing — because a`)
  L.push(`Russian query scores \`L = 0\` against an English index. The rule used instead is the`)
  L.push(`step-5 floor with the objective flipped: **the smallest \`tauLexical\` whose`)
  L.push(`\`blatantRefusalRate >= 0.80\`**, i.e. minimise over-refusal subject to the gate still`)
  L.push(`being a gate. This is an interpretation of an ambiguous step; the numbers it costs`)
  L.push(`are in the table.`)
  L.push('')
  L.push(`| metric | value | bound |`)
  L.push(`|---|---|---|`)
  L.push(`| tauLexical | ${t2(doc.guard.tauLexical)} | — |`)
  for (const k of POSITIVE_STRATA) {
    const s = bestLex?.byStratum[k]
    if (s) L.push(`| ${k} over-refusal | ${s.failures}/${s.n}, UB95 ${n3(s.ub95)} | none (RAG-SPEC 3.2) |`)
  }
  L.push(`| gatePrecision | ${p(bestLex?.gatePrecision)} | — |`)
  L.push(`| blatantRefusalRate | ${p(bestLex?.blatantRefusalRate)} | >= 80% |`)
  L.push('')

  L.push(`### The \`G_lex\` sweep`)
  L.push('')
  if (!sweepLex.length) {
    // The same empty-header defect as the hybrid sweep above, and on a transfer
    // both are empty at once.
    L.push(inheritedNote(doc))
    L.push('')
  } else {
  L.push(`Every fifth step, plus the chosen row. \`chooseTauLexical\` reads the \`N4\` column and`)
  L.push(`nothing else, so this is where the over-refusal it costs becomes visible.`)
  L.push('')
  L.push(`| tauLexical | U | UB95 | S | UB95 | F | UB95 | gatePrecision | N4 |`)
  L.push(`|---|---|---|---|---|---|---|---|---|`)
  for (const r of sweepLex) {
    if (Math.round(r.tau * 100) % 5 && (doc.guard.tauLexical == null || Math.abs(r.tau - doc.guard.tauLexical) > 1e-9)) continue
    const c = (k) => `${r.byStratum[k].failures}/${r.byStratum[k].n}`
    L.push(
      `| ${r.tau.toFixed(2)} | ${c('U')} | ${n3(r.byStratum.U.ub95)} | ${c('S')} | ` +
        `${n3(r.byStratum.S.ub95)} | ${c('F')} | ${n3(r.byStratum.F.ub95)} | ` +
        `${p(r.gatePrecision)} | ${p(r.blatantRefusalRate)} |`,
    )
  }
  L.push('')
  }

  L.push(`## zExp ladder (RAG-SPEC 3.4.1)`)
  L.push('')
  if (doc.lexicalOnly) {
    L.push(`Not measured. The ladder is the median of \`(max c − m)/s\` over cosines and this`)
    L.push(`index has none, so \`zexp\` is empty rather than stale. \`zExp(n)\` is consulted only`)
    L.push(`in \`zscore\` mode, which a vectorless index can never be in — build one with an`)
    L.push(`embedder and \`calibrate\` measures the ladder on that index, not on this one.`)
    L.push('')
  } else {
    L.push(`Median of \`(max c − m)/s\` over the unscoped positives, at real page-contiguous`)
    L.push(`scopes — never random chunk samples, because adjacent paragraphs of one page are`)
    L.push(`exactly the correlation the ladder exists to measure.`)
    L.push('')
    L.push(`| n | z | closed form sqrt(2·ln n) |`)
    L.push(`|---|---|---|`)
    for (const e of doc.guard.zexp) {
      L.push(`| ${e.n} | ${e.z} | ${Math.sqrt(2 * Math.log(Math.max(e.n, 2))).toFixed(4)} |`)
    }
    L.push('')
    L.push(`\`denseMode\` is \`${doc.guard.denseMode}\` on this index, so the ladder is **inert**:`)
    L.push(`\`zExp(n)\` is only consulted in \`zscore\` mode. It is measured and recorded anyway so`)
    L.push(`that a swap to an anisotropic embed model cannot silently inherit the closed form.`)
    L.push('')
  }

  L.push(`## retrievalMisses`)
  L.push('')
  if (!doc.retrievalMisses.armed) {
    // `0/0 (0%, bound 5%)` is what this printed, which reads as a bound that
    // passed. It is measured over probes carrying `gold_page`, and not one of
    // this probe set's records has that key: the bound has never been armed.
    // Annotating the probes is the author's debt; printing a pass it did not
    // measure is this file's.
    L.push(
      `**Bound not armed.** No probe in \`${doc.probeFile}\` carries a \`gold_page\`, so there ` +
        `is nothing to measure retrieval misses over. The 5% floor cannot fail and cannot pass; ` +
        `add \`gold_page\` to the positives to arm it.`,
    )
  } else {
    L.push(
      `${doc.retrievalMisses.ids.length}/${doc.retrievalMisses.n} positives carrying a gold page ` +
        `(${p(doc.retrievalMisses.rate)}, bound 5%).` +
        (doc.retrievalMisses.ids.length
          ? ` Missed: ${doc.retrievalMisses.ids.map((i) => `\`${i}\``).join(', ')} — excluded from the three bounds.`
          : ''),
    )
  }
  L.push('')
  L.push(`Measured at PAGE level through \`retrieval.closest()\`: RAG-SPEC 5.6 step 1 gives the`)
  L.push(`probe set no gold chunk ids, so \`gold_page\` is the granularity available. Page level`)
  L.push(`is the more forgiving of the two — a miss reported here is a miss at chunk level too.`)
  if (doc.lexicalOnly) {
    L.push('')
    L.push(`Over the **lexical top-20 only**. A miss here is a page BM25 cannot reach at any`)
    L.push(`threshold, so it is excluded from \`tauLexical\` for the same reason a hybrid run`)
    L.push(`excludes one from \`tau\`: it measures the probe set, not the gate.`)
  }
  L.push('')
  return L.join('\n')
}

/** Questions are needed for the report only; ids alone would make it unreadable. */
const QUESTIONS = new Map()
for (const line of fs.existsSync(PROBES) ? fs.readFileSync(PROBES, 'utf8').split('\n') : []) {
  if (!line.trim()) continue
  try {
    const r = JSON.parse(line)
    QUESTIONS.set(r.id, r.question)
  } catch {
    /* validated properly in loadProbes */
  }
}

export { sweepRow, chooseTau, contiguousScope, TAU_STEPS }
// The window search, exported for the same reason the tau sweep is: it decides
// a shipped threshold and is a pure function of the cache, so it is testable
// without an embedder.
export { dOf, regate, chooseWindow, fitWindowAtTau, pickAnchors, WINDOWS }

// `pathToFileURL`, not a template literal: a path with a space or a non-ASCII
// segment does not survive plain concatenation, and the failure mode is this
// whole command silently doing nothing and exiting 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    printError(e.message || String(e), e)
    process.exit(FAILED)
  })
}
