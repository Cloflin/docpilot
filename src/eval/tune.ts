#!/usr/bin/env node
/**
 * Retrieval lever sweep — RAG-SPEC 7 levers 1 and 2, measured instead of guessed.
 *
 *   npx docpilot tune
 *   npx docpilot tune --level=medium          a smaller pool while authoring
 *   npx docpilot tune --lambda=0.5:1.0:0.05   the MMR relevance/diversity knob
 *   npx docpilot tune --k=4:12                how many excerpts prime the turn
 *   npx docpilot tune --dry                   report only, write no tuning.json
 *
 * ONLY A FULL-POOL RUN WRITES `tuning.json`. `--level` and `--limit` both narrow
 * the pool, and both make this report-only for the reason spelled out at
 * `NARROWED` in main(): the file is inlined into every reader's bundle, so it is
 * written from the whole golden set or not at all. A narrowed run files its
 * report apart, the way `eval` and `bench emit` file theirs.
 *
 * A SWEPT AXIS MAY NOT BE ENV-PINNED. `DOCPILOT_MMR_LAMBDA` or `DOCPILOT_GATE_K`
 * in the shell — or in `.env.local`, which is loaded below — outranks the tuning
 * object this command varies per cell, which makes the whole grid degenerate.
 * `assertNoPinnedAxis` refuses the run rather than measuring 99 copies of one
 * cell; pin an axis with a bare `lo` (`--lambda=0.9`) instead.
 *
 * WHY THIS IS A COMMAND. Every number in the comments around `MMR_LAMBDA` and
 * `GATE_K` in retriever.js came out of a hand-run loop: export `DOCPILOT_*`,
 * re-run `eval --gate-only`, read four figures off the summary, repeat. That
 * procedure is written down in `skills/docs-rag/SKILL.md` and it was performed by
 * eyeball, once, against ONE corpus — and then every consumer's bundle shipped
 * the literals it produced. This file is that loop with the eyeball removed, and
 * `tuning.json` is where its answer gets to live instead of in a code comment.
 *
 * NEEDS THE EMBED ENDPOINT ONLY, and only in stage A. No chat model is contacted
 * and there is no LLM judge — the same constraint `calibrate.js` and
 * `eval/metrics.js` state, for the same reason: a lever chosen by a generator
 * moves when the generator does.
 *
 * THE GATE IS INVARIANT UNDER THIS GRID, which is what makes ~100 cells cost one
 * embedding pass rather than a hundred. Read `evaluate()` in retriever.js:
 *   - `L` comes from `lexIds.slice(0, 3)`, and `lexIds` is `lexical(query,
 *     CANDIDATES)` — no λ, no k;
 *   - `D` comes from `dense.scopedMax`, the best cosine over the WHOLE scope, not
 *     over the k that survive re-ranking;
 *   - the raw/composed channel choice is `c.G > best.G` over those two, and
 *     `admissible` reads the same lexical evidence;
 *   - `wouldPassUnscoped` reads the full cosine array.
 * λ and GATE_K reach only `mmr()` and `rank({k})`, i.e. WHICH excerpts are handed
 * over once the turn is already admitted. So the sweep cannot flip a single
 * refusal, pure retrieval metrics are sufficient, and no cell can buy F1 by
 * refusing the hard questions. That is a property of today's code rather than a
 * law, so every cell measures the over-refusal count anyway and the report prints
 * it as a sanity row — the day it stops being constant, this comment is wrong and
 * the table says so.
 *
 * WHICH k. `GATE_K` is the excerpt count that matters: `evaluate()` primes the
 * turn with `rank({k: GATE_K})` and retrieval F1 is measured on exactly that set.
 * `CANDIDATES` and `FUSED` are pool construction and stay fixed here — they move
 * what can be selected, not what is shown. The model's own `search_docs` k stays
 * clamped 1..8 by `search()`, so a tuned GATE_K above 8 widens the primed
 * excerpts only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assembleIndex } from '../theme/docpilot/store.js'
import { embedQuery } from '../theme/docpilot/embed.js'
import { createRetrieval, resolveLevers, envPin, LEVER_NAMES } from '../theme/docpilot/retriever.js'
import { composeQuery } from '../theme/docpilot/gate.js'
import { retrievalF1Loose, recallAtK, mrr, underPath, mean } from './metrics.js'
import { filterByLevel, parseLevelArg, DEFAULT_RUN_LEVEL } from './levels.js'
import { nodeEmbedTarget } from '../config.js'
import { applyFileEnv } from '../cli-env.js'
import { flagErrors, flagValue, flagGiven } from '../cli-flags.js'
import { printError, codeFor, tick, tock, FAILED, USAGE } from '../cli-exit.js'

import {
  ROOT,
  RAG,
  GOLDEN,
  DOCPILOT_DIR,
  TUNING_OUT,
  settings as docPilot,
} from '../cli-context.js'

/**
 * The path is `cli-context.js`'s, not this file's: `build-rag-index.js` reads
 * back what is written here, and a writer and a reader that each spell one path
 * out for themselves is the drift `guardFor` was written about. The local alias
 * only pairs it with the report beside it at the two use sites below.
 */
const OUT_JSON = TUNING_OUT

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
const arg = (name: string, dflt?: string) => flagValue('tune', FLAGS, name) ?? dflt
const has = (name: string) => flagGiven('tune', FLAGS, name)

/**
 * Every flag this command reads, and the `=` form of each — because `arg()` only
 * matches `--name=`, so `--level low` left `low` as a stray positional, handed
 * `parseLevelArg` an `undefined` that means "no preference", and swept the WHOLE
 * pool while the author read the report as the smoke tier they thought they had
 * asked for. A flag that silently means its opposite is worse than one that
 * throws, and the `=` is the only spelling the parser has ever supported.
 */
/**
 * The check, which now lives in src/cli-flags.js as `flagErrors` — this function
 * WAS that code, and it was the only command in the package that had it. The
 * ones that did not were exactly the ones that spend money: `calibrate --limt=3`
 * embedded all 597 probes, `eval --limit=abc` ran the whole pool, and
 * `<cmd> --help` on four of them was a purchase order.
 *
 * Generalising it changed no wording: `flagErrors('tune', …)` emits the same
 * three sentences this file wrote, so a reader who meets one here and one in
 * `eval` reads a single dialect.
 *
 * Still called before anything is loaded or embedded — a typo that is going to
 * abort the run has to abort it before the two-minute embedding pass, not after.
 */
function assertKnownFlags() {
  const [bad] = flagErrors('tune', process.argv.slice(2))
  // `2`, not `die`'s `1`: nothing was attempted, so this is not a failed sweep.
  if (bad) {
    printError(bad)
    process.exit(USAGE)
  }
}

const DRY = has('dry')
const LIMIT = Number(arg('limit', '0'))

/**
 * The two levers this command sweeps AND writes. Named once because the env
 * guard, `buildTuningDoc`'s `levers` and the grid all have to mean the same pair:
 * a lever that is written into `tuning.json` is a lever whose axis must be free.
 */
const SWEPT = ['MMR_LAMBDA', 'GATE_K']

/**
 * A run that scored a narrowed pool files its report apart — the rule `eval`'s
 * `-lvl-<level>` and `bench emit`'s `.<level>` already follow, with the same
 * asymmetry: a full run keeps `tuning.report.md` BYTE-IDENTICAL to the name it
 * has always had, so no existing report is orphaned, and only a narrowed one
 * gains a segment.
 *
 * `--limit` earns a segment too. It is the same hazard by a different flag — a
 * head-slice of the tier is not the tier — and `--level=low --limit=5` names both
 * because it is neither.
 */
const narrowSuffix = (level) =>
  `${level && level !== DEFAULT_RUN_LEVEL ? `-lvl-${level}` : ''}${LIMIT ? `-n${LIMIT}` : ''}`
const isNarrowed = (level) => narrowSuffix(level) !== ''
const reportPath = (level) => path.join(DOCPILOT_DIR, `tuning${narrowSuffix(level)}.report.md`)

/**
 * The embedder, from the project's own settings — the same resolver
 * `docpilot index` uses, so a sweep cannot score this corpus in a vector space it
 * was never built in. The environment still wins, for a run against a second
 * endpoint. Read but never printed: no log line below carries a credential.
 */
const EMBED_TARGET = nodeEmbedTarget(docPilot, process.env)
const EMBED_PROVIDER = process.env.DOCPILOT_EMBED_PROVIDER || EMBED_TARGET.provider
const EMBED_BASE = process.env.DOCPILOT_EMBED_URL || EMBED_TARGET.baseURL
const EMBED_KEY = process.env.DOCPILOT_EMBED_KEY || EMBED_TARGET.apiKey || null

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

const die = (m) => {
  printError(m)
  process.exit(FAILED)
}
const num = (v, d = 3) => (v == null || Number.isNaN(v) ? '  —  ' : v.toFixed(d))
const pct = (v) => (v == null ? '  — ' : `${(100 * v).toFixed(1)}%`)
const r4 = (v) => (v == null || Number.isNaN(v) ? null : Number(v.toFixed(4)))

// ── the grid ─────────────────────────────────────────────────────────────────

/**
 * `lo:hi:step` → the axis it names.
 *
 * Written as a parser rather than as three flags because the whole point of the
 * command is that the grid is an argument: a corpus whose lambda plateau sits
 * somewhere else needs `--lambda=0.2:0.8:0.02`, not a patch. `lo` alone is a
 * single-point axis, which is how you pin one lever and sweep the other.
 *
 * It THROWS on anything it cannot read, and never falls back to the default.
 * A silent fallback here is the worst failure this command has: the sweep would
 * run for two minutes over a grid nobody asked for and write its winner to a
 * file that gets inlined into a bundle, with the typo still on screen.
 */
export function parseRange(
  raw,
  opts: {
    name?: string
    step?: number
    min?: number
    max?: number
    integer?: boolean
    example?: string
  } = {},
) {
  const { name = 'range', step: dfltStep = 1, min = -Infinity, max = Infinity, integer = false, example = 'lo:hi:step' } = opts
  const bad = (why) => {
    throw new Error(
      `[docpilot] --${name}="${raw}" — ${why}\n` +
        `    write it as lo:hi:step, e.g. --${name}=${example}\n` +
        `    a bare lo pins the axis to one value`,
    )
  }
  const parts = String(raw ?? '').trim().split(':')
  if (parts.length > 3) bad('too many parts')
  const nums = parts.map((p) => (p.trim() === '' ? NaN : Number(p)))
  if (nums.some((n) => !Number.isFinite(n))) bad('not a number')
  const [lo, hi = lo, step = dfltStep] = nums

  if (step <= 0) bad(`step ${step} must be > 0 — a zero step is an infinite grid`)
  if (hi < lo) bad(`hi ${hi} is below lo ${lo}`)
  if (lo < min || hi > max) bad(`outside the admissible range ${min}..${max}`)
  if (integer && ![lo, hi, step].every(Number.isInteger)) bad('must be whole numbers')

  const out = []
  // `+1e-9` before the floor, and the same slack on the ceiling test: 0.5 + 10 ×
  // 0.05 lands on 0.9999999999999999 in binary floating point, and without the
  // slack the documented default grid would quietly drop its own top row.
  const count = Math.floor((hi - lo) / step + 1e-9) + 1
  if (count > 200) bad(`yields ${count} points — that is a sweep, not a grid`)
  for (let i = 0; i < count; i++) {
    const v = Number((lo + i * step).toFixed(6))
    if (v <= hi + 1e-9) out.push(v)
  }
  return out
}

/**
 * The winning cell — argmax mean retrieval F1, and then three tie-breaks.
 *
 * `recall8` and `mrr` break ties for a reason worth stating: both are measured on
 * `search({k: 8})`, which is NOT affected by GATE_K, so on an F1 tie they are the
 * λ opinion with the k opinion removed. The last tie-break is proximity to the
 * levers already in force, because the alternative is churn — a redeploy, a new
 * index hash and a new number in a committed file, bought with a difference of
 * zero. Distance is normalised per axis or the k axis (span 8) would drown the λ
 * axis (span 0.5) and "nearest" would mean "same k, any lambda".
 *
 * EPSILON, not `===`: two cells that differ in the eleventh decimal are the same
 * measurement, and letting float noise decide is exactly the churn the last
 * tie-break exists to prevent.
 */
export function chooseCell(cells, baseline, { epsilon = 1e-9 } = {}) {
  if (!cells.length) return null
  const span = (key) => {
    const vs = cells.map((c) => c[key])
    const s = Math.max(...vs) - Math.min(...vs)
    return s > 0 ? s : 1
  }
  const lSpan = span('MMR_LAMBDA')
  const kSpan = span('GATE_K')
  const dist = (c) =>
    Math.abs(c.MMR_LAMBDA - baseline.MMR_LAMBDA) / lSpan + Math.abs(c.GATE_K - baseline.GATE_K) / kSpan

  // `?? -1` so an unmeasurable cell — no positive carried a gold chunk — loses to
  // every measured one instead of tying with a perfect score at null.
  const better = (a, b) => {
    for (const key of ['retrievalF1', 'recall8', 'mrr']) {
      const d = (a[key] ?? -1) - (b[key] ?? -1)
      if (Math.abs(d) > epsilon) return d > 0
    }
    const dd = dist(a) - dist(b)
    if (Math.abs(dd) > epsilon) return dd < 0
    return false // a full tie keeps the incumbent, so grid order decides
  }
  return cells.reduce((best, c) => (better(c, best) ? c : best))
}

/**
 * `tuning.json` as `tuningFor()` in build-rag-index.js reads it back.
 *
 * `levers` carries the two this command measures and nothing else. The other six
 * `LEVER_NAMES` are deliberately absent rather than written at their current
 * values: a key in this file is a CLAIM that the number was measured on this
 * corpus, and `resolveLevers` already falls through to the module literal for
 * anything missing. Writing all eight would freeze six unmeasured constants into
 * a consumer's manifest and make a later change to the shipped defaults invisible.
 */
export function buildTuningDoc({ indexHash, embedModel, level, records, chosen, baseline, cells, sweptAt }) {
  return {
    version: 1,
    tunedAt: indexHash,
    /**
     * NULL ON A VECTORLESS INDEX, and that is the point. λ weighs relevance
     * against redundancy in the embedder's own cosine space; measured with no
     * embedder at all it describes BM25 order and nothing else. `tuningFor`
     * compares this strictly against the build's embed model, so a
     * lexically-measured lambda can never be inlined into a vector build — it
     * only matches the vectorless build it came from.
     */
    embedModel: embedModel ?? null,
    level,
    records,
    levers: { MMR_LAMBDA: chosen.MMR_LAMBDA, GATE_K: chosen.GATE_K },
    metrics: {
      retrievalF1: r4(chosen.retrievalF1),
      recall8: r4(chosen.recall8),
      mrr: r4(chosen.mrr),
      n: chosen.n,
      baseline: {
        MMR_LAMBDA: baseline.MMR_LAMBDA,
        GATE_K: baseline.GATE_K,
        retrievalF1: r4(baseline.retrievalF1),
        recall8: r4(baseline.recall8),
        mrr: r4(baseline.mrr),
      },
    },
    // The whole grid, rounded: the report is prose about the shape of the
    // surface, and this is the shape itself, so a later reader can ask whether
    // the winner sat on a plateau or on a spike without re-running the sweep.
    grid: cells.map((c) => ({
      MMR_LAMBDA: c.MMR_LAMBDA,
      GATE_K: c.GATE_K,
      retrievalF1: r4(c.retrievalF1),
      recall8: r4(c.recall8),
      mrr: r4(c.mrr),
    })),
    sweptAt,
  }
}

// ── loading ──────────────────────────────────────────────────────────────────

function loadIndex() {
  const mf = path.join(RAG, 'manifest.json')
  if (!fs.existsSync(mf)) {
    die(`no index at ${path.relative(ROOT, RAG)} — run \`npx docpilot index\` first`)
  }
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'))
  const shards = manifest.shards.map((s) => JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')))
  // A `--no-embed` index writes `vectors: null` and no blob beside it.
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

function loadGolden(level) {
  if (!fs.existsSync(GOLDEN)) {
    die(`no golden set at ${path.relative(ROOT, GOLDEN)} — run \`npx docpilot init\` to scaffold one`)
  }
  const all = fs
    .readFileSync(GOLDEN, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (e) {
        die(`${path.relative(ROOT, GOLDEN)}:${i + 1} is not JSON — ${e.message}`)
      }
    })
  const atLevel = filterByLevel(all, level)
  if (!atLevel.length) {
    die(
      `level ${level} selects 0 of ${all.length} records in ${path.relative(ROOT, GOLDEN)}\n` +
        `        levels are cumulative — a record with no "level" runs as "high".`,
    )
  }
  return { all, records: LIMIT ? atLevel.slice(0, LIMIT) : atLevel }
}

async function embed(text, index) {
  const vec = await embedQuery(text, {
    provider: EMBED_PROVIDER,
    baseURL: EMBED_BASE,
    model: index.manifest.embedModel,
    apiKey: EMBED_KEY,
  })
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

// ── stage A: embed once per record ───────────────────────────────────────────

/**
 * One embedding per record, plus one per follow-up for the composed channel —
 * the pattern `run.js probeRecords` uses, and the reason the grid below is free.
 * Nothing here depends on λ or GATE_K, so it happens once for the whole sweep.
 *
 * `goldInScope` and `scoredAsNegative` are settled here too: RAG-SPEC 5.1 says a
 * scoped record whose gold set falls outside its own scope is CORRECT to refuse,
 * so scoring it as F1 0 would punish the retriever for obeying the scope. That
 * reclassification is a property of (record, scope), not of a cell, and computing
 * it once is what keeps the grid's numbers identical to `eval`'s.
 */
async function probeRecords(index, records, lexical) {
  const probes = []
  let embedded = 0
  for (const rec of records) {
    const scope = rec.scope || ALL_SCOPE
    let vec
    let composedVec
    const composedQuery = composeQuery(rec.question, rec.prev_question)

    if (!lexical) {
      try {
        vec = await embed(rec.question, index)
        embedded++
        if (composedQuery) {
          composedVec = await embed(composedQuery, index)
          embedded++
        }
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
    } else if (composedQuery) {
      // A composed follow-up still HAS a lexical channel: `undefined` means "no
      // second query", `null` means "score it with no vector". Collapsing them
      // would drop the composed channel from every follow-up in the set.
      composedVec = null
    }

    const gold = rec.gold_chunks || []
    const goldInScope =
      scope.kind === 'all' || !scope.paths.length
        ? gold
        : gold.filter((gc) => scope.paths.some((p) => underPath(`/${gc}`, p)))
    const scoredAsNegative = gold.length > 0 && goldInScope.length === 0

    probes.push({
      rec,
      scope,
      vec,
      composedVec,
      composedQuery,
      goldInScope,
      scoredAsNegative,
      positive: rec.expect === 'answer' && !scoredAsNegative,
    })
    if (embedded && embedded % 20 === 0) tick(`embedded ${embedded}…`)
  }
  if (embedded) tock(`embedded ${embedded} queries for ${probes.length} records`)
  return probes
}

// ── stage B: the grid, in process, with nothing re-embedded ──────────────────

/**
 * One cell. Reproduces `run.js probeRecords` lines 292–318 exactly, because a
 * tuning report whose F1 means something slightly different from the eval's F1 is
 * a report that cannot be compared against the run it is supposed to improve.
 *
 * `createRetrieval` is called per scope rather than per record: `miniSearchFor`
 * is memoised on the index, so what a fresh retrieval actually costs is one
 * `chunks.filter` for a scoped record and nothing at all for an unscoped one.
 */
function measureCell({ index, guard, probes, MMR_LAMBDA, GATE_K, lexical }) {
  const tuning = { MMR_LAMBDA, GATE_K }
  const byScope = new Map()
  const retrievalFor = (scope) => {
    let r = byScope.get(scope)
    if (!r) {
      r = createRetrieval({ index, scope, guard, tuning })
      byScope.set(scope, r)
    }
    return r
  }

  const rows = []
  for (const p of probes) {
    const retrieval = retrievalFor(p.scope)
    const g = retrieval.evaluate({
      question: p.rec.question,
      previousQuestion: p.rec.prev_question,
      queryVec: p.vec,
      composedVec: p.composedVec,
      mode: lexical ? 'lexical-only' : 'hybrid',
    })
    const retrievedIds = g.chunks.map((c) => c.id)

    // Ranked on the channel the gate ACTUALLY WON ON. Ranking the bare question
    // of a follow-up measures a query no turn ever issues — run.js records
    // `q-25` scoring recall8 = 0 with its gold at rank 1 for exactly that reason.
    const ranked =
      g.channel === 'composed' && p.composedVec
        ? { query: p.composedQuery, queryVec: p.composedVec }
        : { query: p.rec.question, queryVec: p.vec }
    const rankedIds = retrieval.search({ ...ranked, k: 8 }).map((c) => c.id)

    rows.push({
      id: p.rec.id,
      positive: p.positive,
      pass: g.pass,
      // recall@8 and MRR are measured through `search()`, whose k is clamped
      // 1..8 for the model — so they move with λ and are BLIND to GATE_K. That
      // is why they are the tie-breaks: on an F1 tie they are the λ opinion.
      f1: p.goldInScope.length ? retrievalF1Loose(retrievedIds, p.goldInScope).f1 : null,
      recall8: p.goldInScope.length ? recallAtK(rankedIds, p.goldInScope, 8) : null,
      mrr: p.goldInScope.length ? mrr(rankedIds, p.goldInScope) : null,
    })
  }

  const positives = rows.filter((r) => r.positive)
  const negatives = rows.filter((r) => !r.positive)
  return {
    MMR_LAMBDA,
    GATE_K,
    retrievalF1: mean(positives.map((r) => r.f1)),
    recall8: mean(positives.map((r) => r.recall8)),
    mrr: mean(positives.map((r) => r.mrr)),
    n: positives.length,
    // The sanity row. Both of these are gate verdicts, and the header explains
    // why no cell of this grid can move either one.
    overRefused: positives.filter((r) => !r.pass).length,
    negativesCaught: negatives.filter((r) => !r.pass).length,
    negatives: negatives.length,
    rows,
  }
}

/**
 * The ten records that moved most in each direction, chosen minus baseline.
 *
 * A headline of +0.02 mean F1 over 60 records is one record going 0 → 1 and 59
 * going nowhere at least as often as it is a broad shift, and those two have
 * opposite readings — the first is a gold-chunk authoring artefact, the second is
 * a lever. The two lists are computed independently rather than as head and tail
 * of one sort, or on a set where fewer than twenty records moved they would
 * report the same record as both a gain and a loss.
 */
function movers(chosenRows, baselineRows) {
  const base = new Map<string, any>(baselineRows.map((r) => [r.id, r]))
  const deltas = []
  for (const r of chosenRows) {
    const b = base.get(r.id)
    if (!b || r.f1 == null || b.f1 == null) continue
    const d = r.f1 - b.f1
    if (Math.abs(d) < 1e-9) continue
    deltas.push({ id: r.id, from: b.f1, to: r.f1, delta: d })
  }
  deltas.sort((a, b) => b.delta - a.delta)
  return {
    gained: deltas.filter((d) => d.delta > 0).slice(0, 10),
    lost: deltas.filter((d) => d.delta < 0).slice(-10).reverse(),
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * A swept axis may not be pinned by the environment — and this is NOT a
 * restatement of the precedence bug in `resolveLevers`; it survives that fix.
 *
 * `env > tuning object > literal` is the right rule for a RUNNING retriever: an
 * operator with a variable exported on their shell has made the newest statement
 * about that lever. It is precisely the wrong rule for a command whose entire job
 * is to VARY that tuning object. `measureCell` passes `{MMR_LAMBDA, GATE_K}` per
 * cell; a set `DOCPILOT_MMR_LAMBDA` outranks all ~99 of them, so every cell
 * measures the identical retrieval, all three metrics tie everywhere, and
 * `chooseCell` falls through to its proximity tie-break and returns a winner
 * NOTHING ON THE GRID MEASURED. That winner is then written to `tuning.json` and
 * inlined by `docpilot index` into every reader's bundle — which is how a shell
 * variable ships, against the promise `skills/docs-rag/SKILL.md` and
 * `docs/reference/config.md` both make that "env never ships".
 *
 * We `die` rather than unsetting it: the environment is the operator's, this
 * process shares it with whatever launched it, and a command that silently
 * rewrites it to get its own job done is a worse surprise than the one it fixed.
 * The axis already HAS a first-class way to be pinned — a bare `lo`, as in
 * `--lambda=0.9` — so nothing legitimate is lost.
 *
 * The other six levers are reported, not refused: `DOCPILOT_FUSED=20` widens the
 * pool this sweep selects from, which is a real thing to want to measure. It is
 * still worth a line, because `tuning.json` records only λ and k — so the answer
 * was measured under a pool the file does not mention.
 */
function assertNoPinnedAxis() {
  for (const name of SWEPT) {
    const pin = envPin(name)
    if (!pin) continue
    die(
      `${pin.env} is set (${pin.value}), and it pins the axis this command sweeps.\n` +
        `        Every cell would measure the same retrieval, and the winner would be a\n` +
        `        value nothing on the grid scored — then inlined into every reader's bundle.\n` +
        `        unset it and re-run:  unset ${pin.env}\n` +
        `        (check .env.local too — it is loaded into the environment before this runs)\n` +
        `        to hold the axis at one value, pin it on the grid instead: --${
          name === 'MMR_LAMBDA' ? `lambda=${pin.value}` : `k=${pin.value}`
        }`,
    )
  }
}

/** The other six, which change what was measured without being recorded. */
function warnPinnedLevers() {
  for (const name of LEVER_NAMES) {
    if (SWEPT.includes(name)) continue
    const pin = envPin(name)
    if (pin) {
      console.log(`  NOTE  ${pin.env}=${pin.value} is in force — the grid is measured under it,`)
      console.log(`        and tuning.json records only MMR_LAMBDA and GATE_K.`)
    }
  }
}

async function main() {
  // Before the index is loaded and long before stage A embeds anything: a run
  // that is going to be refused must be refused while it is still free.
  assertKnownFlags()
  assertNoPinnedAxis()

  // Every flag that can be malformed is refused HERE, not by the catch at the
  // bottom of the file: that one is for a sweep that started and failed, and it
  // exits `1`. A value nobody could have meant is `2`, and it is printed as one
  // line rather than under a stack the operator cannot act on.
  let level
  try {
    level = parseLevelArg(arg('level', DEFAULT_RUN_LEVEL))
  } catch (e) {
    printError(e.message, e)
    process.exit(codeFor(e))
  }

  /**
   * WHY A NARROWED SWEEP IS REPORT-ONLY, and not merely filed under another name.
   *
   * `eval` and `bench emit` both answer this hazard by suffixing their outputs,
   * and the first instinct is to copy them. It is the wrong instinct here,
   * because their outputs and this one are different KINDS of artefact. A report
   * is reading material: a narrowed one is legitimately useful, it just must not
   * overwrite the full-set one, and a suffix is exactly enough.
   *
   * `tuning.json` is not reading material. Its ENTIRE purpose is to be read back
   * by `docpilot index` — from one fixed path, `TUNING_OUT` — and inlined into
   * every reader's shipped bundle. So a suffixed `tuning-lvl-low.json` has only
   * two possible fates, and both are worse than not writing it: nothing ever
   * reads it, or something does and the smoke-pool answer ships anyway. Writing
   * it to the fixed path is worse still, and is the defect itself — ten smoke
   * records silently replacing levers that took the whole golden file to earn,
   * with `tuningFor` waving it through because the version, the index hash and
   * the embed model all still match.
   *
   * So: the report is suffixed, the artefact is withheld, and the completion line
   * says which. `--dry` already had the vocabulary for it.
   */
  const NARROWED = isNarrowed(level)
  const OUT_MD = reportPath(level)

  const index = loadIndex()
  const guard = index.manifest.guard
  const hash = index.manifest.hash
  /**
   * `manifest.vectors === null` — a `--no-embed` build. There is no cosine space
   * here, so λ is being measured against BM25 order; the run still means
   * something (GATE_K is real either way) but the report says so on every page
   * and `embedModel: null` keeps the answer from crossing into a vector build.
   */
  const LEXICAL = index.manifest.vectors === null

  /**
   * The levers actually in force, through the ONE implementation of the
   * precedence rule — env > manifest.tuning > module literal. Re-deriving it here
   * is how a report ends up naming a value the retrieval did not use.
   */
  const effective = resolveLevers(index.manifest.tuning)
  const baseLevers = { MMR_LAMBDA: effective.MMR_LAMBDA, GATE_K: effective.GATE_K }

  let lambdas
  let ks
  try {
    lambdas = parseRange(arg('lambda', '0.5:1.0:0.05'), {
      name: 'lambda',
      step: 0.05,
      min: 0,
      max: 1,
      example: '0.5:1.0:0.05',
    })
    ks = parseRange(arg('k', '4:12'), {
      name: 'k',
      step: 1,
      min: 1,
      // FUSED is the pool `mmr()` picks from, so a k above it selects the whole
      // pool and every larger k measures the identical cell. Bounded by the
      // RESOLVED value, not the literal, or a tuned FUSED would move the ceiling
      // without moving the check.
      max: effective.FUSED,
      integer: true,
      example: '4:12',
    })
  } catch (e) {
    die(e.message)
  }

  const { all, records } = loadGolden(level)

  console.log(`\nDocPilot retrieval tuning — RAG-SPEC 7 levers 1 and 2`)
  console.log(
    `  index ${hash}  chunks ${index.manifest.chunkCount}  ` +
      (LEXICAL ? 'no vectors — LEXICAL-ONLY sweep' : `embed ${index.manifest.embedModel}`),
  )
  console.log(
    `  level ${level} — ${records.length} of ${all.length} records` +
      `${LIMIT ? ` (--limit=${LIMIT})` : ''}` +
      // `!NARROWED`, not `level === DEFAULT_RUN_LEVEL`: `--limit=3` at the default
      // level is 3 of 60 records, and this clause used to call that "the whole
      // pool" — the same over-claim the completion line was making.
      `${NARROWED ? '' : '  — the whole pool, which is what tuning wants and what it costs'}`,
  )
  console.log(
    `  levers in: MMR_LAMBDA=${baseLevers.MMR_LAMBDA} GATE_K=${baseLevers.GATE_K} ` +
      `(source ${index.manifest.tuning?.source || 'default'})`,
  )
  console.log(`  grid ${lambdas.length} λ × ${ks.length} k = ${lambdas.length * ks.length} cells`)
  if (NARROWED) {
    console.log(`  narrowed pool — REPORT ONLY, ${path.relative(ROOT, OUT_JSON)} will not be written`)
  }
  warnPinnedLevers()
  console.log('')

  console.log(
    LEXICAL
      ? '  stage A — no embedder to call; the sweep runs on lexical semantics'
      : '  stage A — embedding once per record…',
  )
  const probes = await probeRecords(index, records, LEXICAL)
  const positives = probes.filter((p) => p.positive)
  const withGold = positives.filter((p) => p.goldInScope.length)
  if (!withGold.length) {
    die(
      `no positive record at level ${level} carries gold_chunks inside its own scope — ` +
        `there is nothing for retrieval F1 to be measured against.\n` +
        `        author gold_chunks, then \`npx docpilot lint\` to verify they resolve.`,
    )
  }

  console.log(`\n  stage B — sweeping ${lambdas.length * ks.length} cells in process (no re-embedding)…`)
  const cells = []
  for (const MMR_LAMBDA of lambdas) {
    const row = []
    for (const GATE_K of ks) {
      const cell = measureCell({ index, guard, probes, MMR_LAMBDA, GATE_K, lexical: LEXICAL })
      cells.push(cell)
      row.push(num(cell.retrievalF1))
    }
    console.log(`    λ ${MMR_LAMBDA.toFixed(2)}   F1 ${row.join(' ')}`)
  }

  /**
   * The levers in force are measured whatever the grid says, and then ADDED to
   * the candidate pool when the grid stepped past them — `--k=4:12:2` does not
   * contain the shipped GATE_K 5, and neither does any λ grid whose step misses
   * a tuned 0.87.
   *
   * Without that, the sweep is structurally unable to answer "leave it alone":
   * every cell it can return is a change, so on a plateau it would recommend
   * moving to whichever end of the plateau floating point put first. Measuring
   * it is also what the report's delta column is against — a winner with no
   * baseline beside it is a number, not a result.
   */
  const onGrid = cells.find(
    (c) => c.MMR_LAMBDA === baseLevers.MMR_LAMBDA && c.GATE_K === baseLevers.GATE_K,
  )
  const baseline = onGrid || measureCell({ index, guard, probes, ...baseLevers, lexical: LEXICAL })
  const pool = onGrid ? cells : [...cells, baseline]

  const chosen = chooseCell(pool, baseLevers)
  const isBaseline =
    chosen.MMR_LAMBDA === baseline.MMR_LAMBDA && chosen.GATE_K === baseline.GATE_K

  // Every cell's gate verdicts, which the header argues cannot differ. Measured
  // rather than asserted: this is the one line that would catch the invariant
  // breaking, and it costs a comparison over an array already in memory.
  const invariant =
    pool.every((c) => c.overRefused === baseline.overRefused) &&
    pool.every((c) => c.negativesCaught === baseline.negativesCaught)

  console.log('\n── chosen ──────────────────────────────────────────────────────')
  const line = (k, v) => console.log(`  ${String(k).padEnd(28)} ${v}`)
  line('MMR_LAMBDA', `${chosen.MMR_LAMBDA}   (was ${baseline.MMR_LAMBDA})`)
  line('GATE_K', `${chosen.GATE_K}   (was ${baseline.GATE_K})`)
  line('retrieval F1 (mean)', `${num(chosen.retrievalF1)}   ${delta(chosen.retrievalF1, baseline.retrievalF1)}`)
  line('recall@8', `${num(chosen.recall8)}   ${delta(chosen.recall8, baseline.recall8)}`)
  line('MRR', `${num(chosen.mrr)}   ${delta(chosen.mrr, baseline.mrr)}`)
  line('positives scored', `${chosen.n} of ${records.length} records`)
  line(
    'gate over-refusal',
    `${chosen.overRefused}/${chosen.n}  ${pct(chosen.n ? chosen.overRefused / chosen.n : null)} — ` +
      (invariant ? 'identical in every cell (the grid cannot move it)' : 'MOVED ACROSS THE GRID — see the report'),
  )

  const doc = buildTuningDoc({
    indexHash: hash,
    embedModel: LEXICAL ? null : index.manifest.embedModel,
    level,
    records: records.length,
    chosen,
    baseline,
    cells: pool,
    sweptAt: new Date().toISOString(),
  })

  // The report is written whether or not `tuning.json` is: `--dry` exists to
  // produce exactly this file, and a sweep you cannot read is a sweep you have
  // to run again.
  fs.mkdirSync(DOCPILOT_DIR, { recursive: true })
  fs.writeFileSync(
    OUT_MD,
    markdown({
      doc,
      chosen,
      baseline,
      cells,
      lambdas,
      ks,
      level,
      records,
      all,
      index,
      lexical: LEXICAL,
      invariant,
      isBaseline,
      narrowed: NARROWED,
      limit: LIMIT,
      movers: movers(chosen.rows, baseline.rows),
    }),
  )

  if (DRY) {
    console.log(`\n  --dry — wrote ${path.relative(ROOT, OUT_MD)}, left ${path.relative(ROOT, OUT_JSON)} untouched\n`)
    return
  }

  if (NARROWED) {
    // Deliberately NOT the `[docpilot] wrote …` line: that one reads as an
    // unqualified result, and this run does not have one. It measured a pool it
    // chose, on purpose, and the artefact that ships is not written from a pool
    // somebody chose.
    console.log(
      `\n  narrowed pool (${records.length} of ${all.length} records` +
        `${level !== DEFAULT_RUN_LEVEL ? `, --level=${level}` : ''}${LIMIT ? `, --limit=${LIMIT}` : ''}) —` +
        ` report only`,
    )
    console.log(`  left ${path.relative(ROOT, OUT_JSON)} untouched: it is inlined into every reader's`)
    console.log(`  bundle by \`npx docpilot index\`, so it is written from the whole pool or not at all`)
    console.log(`  re-run \`npx docpilot tune\` with no --level and no --limit to write it`)
    console.log(`  report: ${path.relative(ROOT, OUT_MD)}\n`)
    return
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n')
  if (isBaseline) {
    // Written anyway, and this is the whole reason: an unwritten winner is a
    // value that survives only as a module literal, and the next release of that
    // literal moves this corpus without anybody deciding to.
    console.log(`\n  the sweep chose the levers already in force — pinned rather than skipped,`)
    console.log(`  so a later change to the shipped defaults cannot move this corpus silently`)
  }
  console.log(
    `\n[docpilot] wrote ${path.relative(ROOT, OUT_JSON)} — run npx docpilot index to inline the tuned levers`,
  )
  console.log(`  report: ${path.relative(ROOT, OUT_MD)}\n`)
}

const delta = (a, b) => {
  if (a == null || b == null) return ''
  const d = a - b
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(3)}`
}

// ── the report ───────────────────────────────────────────────────────────────

function markdown(ctx) {
  const { doc, chosen, baseline, cells, lambdas, ks, level, records, all, index, lexical, invariant, isBaseline, narrowed, limit, movers } = ctx
  const L = []
  const n3 = (v) => (v == null ? '—' : v.toFixed(3))
  const at = (l, k) => cells.find((c) => c.MMR_LAMBDA === l && c.GATE_K === k)

  L.push(`# Retrieval tuning — \`${doc.tunedAt}\``)
  L.push('')
  L.push(`Produced by \`npx docpilot tune\`. Embed endpoint only in stage A, nothing at all in`)
  L.push(`stage B: no chat model, no LLM judge, no unseeded randomness. Same index + same`)
  L.push(`golden set ⇒ same output.`)
  L.push('')
  // WHEN. `sweptAt` has been in `tuning.json` all along and was the one
  // timestamp in this subsystem that existed only there — the report a person
  // reads could not say whether it described this morning or last month.
  if (doc.sweptAt) {
    L.push(`Swept \`${doc.sweptAt}\` against index \`${doc.indexHash}\` (\`${doc.embedModel ?? 'lexical only'}\`).`)
    L.push('')
  }

  if (narrowed) {
    L.push(`> ## Narrowed pool — no \`tuning.json\` was written`)
    L.push(`>`)
    L.push(
      `> This sweep scored ${records.length} of ${all.length} records` +
        `${level !== DEFAULT_RUN_LEVEL ? ` (\`--level=${level}\`)` : ''}` +
        `${limit ? ` (\`--limit=${limit}\`)` : ''}, so its answer describes that pool and not`,
    )
    L.push(`> the corpus. \`tuning.json\` is read back by \`docpilot index\` and inlined into every`)
    L.push(`> reader's bundle, so it is written from the whole pool or not at all — the levers`)
    L.push(`> already in force are untouched. Read the grid below as a shape, not as a decision;`)
    L.push(`> re-run \`npx docpilot tune\` with no \`--level\` and no \`--limit\` to make it one.`)
    L.push('')
  }

  if (lexical) {
    L.push(`> ## Lexical-only index`)
    L.push(`>`)
    L.push(`> \`${doc.tunedAt}\` was built with \`--no-embed\`, so there are no cosines. \`MMR_LAMBDA\``)
    L.push(`> weighs relevance against redundancy IN THE EMBEDDER'S SPACE — with no vectors every`)
    L.push(`> \`rel\` is 0, the greedy pick ties, and what is really being swept here is BM25 order`)
    L.push(`> plus \`GATE_K\`. \`embedModel\` is written as \`null\` for that reason: \`tuningFor()\``)
    L.push(`> compares it strictly, so this file can only ever be inlined into a vectorless build.`)
    L.push('')
  }

  L.push(`| | |`)
  L.push(`|---|---|`)
  L.push(`| index | \`${doc.tunedAt}\`, ${index.manifest.chunkCount} chunks, ${lexical ? 'no embedder (BM25 only)' : doc.embedModel} |`)
  L.push(`| level | \`${level}\` — ${records.length} of ${all.length} records, ${chosen.n} scored positives |`)
  L.push(`| grid | ${lambdas.length} λ × ${ks.length} k = ${cells.length} cells |`)
  L.push(`| **MMR_LAMBDA** | **${chosen.MMR_LAMBDA}** (was ${baseline.MMR_LAMBDA}) |`)
  L.push(`| **GATE_K** | **${chosen.GATE_K}** (was ${baseline.GATE_K}) |`)
  L.push('')

  if (isBaseline) {
    L.push(`The sweep chose the levers **already in force**. \`tuning.json\` is written anyway: an`)
    L.push(`unwritten winner survives only as a literal in \`retriever.js\`, and the next release`)
    L.push(`that moves that literal would move this corpus without anybody deciding to. Pinning`)
    L.push(`it is the difference between "measured and unchanged" and "never measured".`)
    L.push('')
  }

  L.push(`## Chosen vs baseline`)
  L.push('')
  L.push(`| metric | baseline (λ ${baseline.MMR_LAMBDA}, k ${baseline.GATE_K}) | chosen (λ ${chosen.MMR_LAMBDA}, k ${chosen.GATE_K}) | Δ |`)
  L.push(`|---|---|---|---|`)
  for (const [label, key] of [['retrieval F1 (mean)', 'retrievalF1'], ['recall@8', 'recall8'], ['MRR', 'mrr']]) {
    L.push(`| ${label} | ${n3(baseline[key])} | ${n3(chosen[key])} | ${delta(chosen[key], baseline[key]) || '—'} |`)
  }
  L.push('')
  L.push(`Selection is argmax mean retrieval F1, then recall@8, then MRR, then proximity to the`)
  L.push(`levers already in force. The last tie-break is not cosmetic: a tie decided by float`)
  L.push(`noise would churn a committed file, a rebuilt index and a redeployed bundle for a`)
  L.push(`difference of zero.`)
  L.push('')
  if (chosen.GATE_K > 8) {
    L.push(`\`GATE_K\` **${chosen.GATE_K} is above 8**, and that is legal but partial: it widens the`)
    L.push(`excerpts that PRIME the turn, which is what retrieval F1 is measured on. A`)
    L.push(`\`search_docs\` call the model makes itself is still clamped to 1..8 by \`search()\`, so`)
    L.push(`the model cannot reach this k on its own. Read the gain as a gain on the first turn.`)
    L.push('')
  }

  L.push(`## The grid`)
  L.push('')
  L.push(`Mean retrieval F1 over the ${chosen.n} scored positives. Rows are λ, columns \`GATE_K\`.`)
  L.push('')
  L.push(`| λ \\ k | ${ks.join(' | ')} |`)
  L.push(`|---|${ks.map(() => '---').join('|')}|`)
  for (const l of lambdas) {
    L.push(
      `| **${l}** | ` +
        ks
          .map((k) => {
            const c = at(l, k)
            const win = c && c.MMR_LAMBDA === chosen.MMR_LAMBDA && c.GATE_K === chosen.GATE_K
            return win ? `**${n3(c.retrievalF1)}**` : n3(c?.retrievalF1)
          })
          .join(' | ') +
        ' |',
    )
  }
  L.push('')
  L.push(`Columns above 8 are legal but partial: \`GATE_K\` sizes the excerpts that PRIME the`)
  L.push(`turn, which is what retrieval F1 is measured on, while a \`search_docs\` call the model`)
  L.push(`makes for itself is clamped to 1..8 by \`search()\`. \`CANDIDATES\` and \`FUSED\` are pool`)
  L.push(`construction and are not swept here — they move what CAN be selected, not what is shown.`)
  L.push('')
  L.push(`recall@8 and MRR are constant down each column and vary only down the λ axis, by`)
  L.push(`construction: both are measured through \`search({k: 8})\`, whose k is the model's`)
  L.push(`clamp and not \`GATE_K\`. They are in \`tuning.json\`'s \`grid\` per cell.`)
  L.push('')

  L.push(`## Gate invariance — the sanity row`)
  L.push('')
  L.push(`Nothing on this grid may change a refusal, and the argument is structural:`)
  L.push(`\`evaluate()\` derives \`D\` from \`dense.scopedMax\` (the best cosine in the whole scope),`)
  L.push(`\`L\` from \`lexIds.slice(0, 3)\`, and the raw/composed channel choice from those two Gs.`)
  L.push(`\`MMR_LAMBDA\` and \`GATE_K\` reach only \`mmr()\` and \`rank({k})\` — which excerpts are`)
  L.push(`handed over AFTER the turn is admitted. So pure retrieval metrics are sufficient here`)
  L.push(`and no cell can buy F1 by refusing the questions it is bad at.`)
  L.push('')
  L.push(`| | value | across the grid |`)
  L.push(`|---|---|---|`)
  L.push(
    `| gate over-refusal | ${chosen.overRefused}/${chosen.n} | ` +
      `${invariant ? 'identical in all ' + doc.grid.length + ' cells' : '**MOVED — the invariant above is broken**'} |`,
  )
  L.push(
    `| negatives caught | ${chosen.negativesCaught}/${chosen.negatives} | ` +
      `${invariant ? 'identical in all ' + doc.grid.length + ' cells' : '**MOVED — the invariant above is broken**'} |`,
  )
  L.push('')
  if (!invariant) {
    L.push(`**The invariant is broken.** A cell of this grid changed a gate verdict, which means`)
    L.push(`retrieval metrics alone no longer decide these levers — a cell can now win by`)
    L.push(`refusing the questions it scores badly on. Do not inline this result: find what`)
    L.push(`made \`evaluate()\` depend on λ or \`GATE_K\` first.`)
    L.push('')
  }

  L.push(`## What moved`)
  L.push('')
  L.push(`Per-record retrieval F1 at the chosen cell against the baseline cell. This is where a`)
  L.push(`headline delta of +0.02 turns out to be one record going 0 → 1 and nine going nowhere.`)
  L.push('')
  if (!movers.gained.length && !movers.lost.length) {
    L.push(`No record moved: the chosen cell and the baseline cell retrieve identically.`)
    L.push('')
  } else {
    L.push(`| record | baseline | chosen | Δ |`)
    L.push(`|---|---|---|---|`)
    for (const m of movers.gained) {
      L.push(`| \`${m.id}\` | ${n3(m.from)} | ${n3(m.to)} | +${m.delta.toFixed(3)} |`)
    }
    for (const m of movers.lost) {
      L.push(`| \`${m.id}\` | ${n3(m.from)} | ${n3(m.to)} | ${m.delta.toFixed(3)} |`)
    }
    L.push('')
  }

  L.push(`## What happens next`)
  L.push('')
  if (narrowed) {
    L.push(`**Nothing, from this run.** A narrowed sweep writes this report and no \`tuning.json\`;`)
    L.push(`the levers in force are unchanged. Everything below describes what a full-pool run`)
    L.push(`would do.`)
    L.push('')
  }
  L.push(`\`docpilot tune\` writes \`tuning.json\` and stops. It is \`npx docpilot index\` that reads`)
  L.push(`it — through \`tuningFor()\`, which drops the file if it names another index hash or`)
  L.push(`another embed model — and inlines the levers into \`manifest.tuning\`, from where`)
  L.push(`\`resolveLevers\` hands them to every retrieval in the browser and in the eval.`)
  L.push('')
  L.push(`Thresholds are not levers: \`tau\`, \`tauLexical\`, \`wDense\` and \`wLexical\` are set by`)
  L.push(`\`npx docpilot calibrate\` and by nothing else (RAG-SPEC 7). A key of that kind in`)
  L.push(`\`tuning.json\` is dropped loudly at build time.`)
  L.push('')
  L.push(`And six of the eight levers are not inlinable either. \`tuningFor()\` lets only`)
  L.push(`\`MMR_LAMBDA\` and \`GATE_K\` — the two this sweep measures — cross from a committed`)
  L.push(`file into a shipped bundle; \`RRF_K\`, \`W_LEXICAL_RRF\`, \`W_DENSE_RRF\`, \`CANDIDATES\`,`)
  L.push(`\`FUSED\` and \`EXPAND_BELOW_TOKENS\` are dropped with a line saying they were never`)
  L.push(`measured on this corpus. They resolve perfectly well at runtime, which is exactly`)
  L.push(`why they need the wall: \`CANDIDATES\` sizes the list \`evaluate()\` reads the gate's`)
  L.push(`lexical evidence from, so a hand-edited value there turns an answerable question`)
  L.push(`into a refusal with no threshold named and nothing printed. Set those six in the`)
  L.push(`environment for an exploratory run, where they cannot ship.`)
  L.push('')
  return L.join('\n')
}

// `pathToFileURL`, not a template literal: a path with a space or a non-ASCII
// segment does not survive plain concatenation, and the failure mode is this
// whole command silently doing nothing and exiting 0. The bin dispatcher rewrites
// `process.argv[1]` to this module, so the comparison holds for `docpilot tune`
// as well as for a direct `node src/eval/tune.js`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    printError(e.message || String(e), e)
    process.exit(FAILED)
  })
}
