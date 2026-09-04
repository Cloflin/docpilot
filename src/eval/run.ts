#!/usr/bin/env node
/**
 * Evaluation run — RAG-SPEC 6.
 *
 *   npx docpilot eval
 *   npx docpilot eval --models=qwen3.5:9b,phi4:14b,qwen3:8b
 *   npx docpilot eval --gate-only            retrieval + gate only, seconds
 *   npx docpilot eval --lexical              no embedder at all: BM25 only
 *   npx docpilot eval --level=medium         the low + medium pool, not a head-slice
 *   npx docpilot eval --limit=3              short loop while tuning
 *   npx docpilot eval --resume               reuse rows already on disk
 *
 * Needs a running Ollama unless `--gate-only` is given, in which case only the
 * embed endpoint is used — and not even that under `--lexical`.
 *
 * `--lexical` measures the configuration where the panel has ONE provider and no
 * embedder: it is what the runtime already falls back to when embedding fails,
 * so the question "what does the embedder buy" has an answer on this corpus
 * rather than an opinion. Run it against the same records as a normal
 * `--gate-only` pass and compare retrieval F1 and recall@8.
 *
 * An index built by `npx docpilot index --no-embed` carries no vectors at all,
 * and a run against one takes that same path whether or not the flag is given.
 * There is no hybrid measurement to be had on it, and asking an embedder for one
 * would score this corpus in a vector space it was never built in.
 *
 * Retrieval and the gate are MODEL-INDEPENDENT and are computed once per record,
 * then shared by every model in the matrix: a three-model run makes one set of
 * embed calls, not three, and every model is scored against byte-identical
 * evidence rather than against three separate samples of the same function.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { assembleIndex } from '../theme/docpilot/store.js'
import { embedQuery } from '../theme/docpilot/embed.js'
import { createRetrieval, resolveLevers } from '../theme/docpilot/retriever.js'
import { ANTECEDENT_HOPS, enforces } from '../theme/docpilot/gate.js'
import { detectTools, detectCapabilities } from '../theme/docpilot/llm.js'
import { runTurn } from '../theme/docpilot/harness.js'
import { promptHash } from '../theme/docpilot/prompt.js'
import { fnv1a32 } from '../theme/docpilot/text.js'
import {
  retrievalF1Loose,
  recallAtK,
  mrr,
  scopeContainment,
  tokenF1,
  identifierRecall,
  languageMatch,
  citationPrecision,
  citationRecall,
  normaliseAnswer,
  pageOf,
  hallucinatedCitationRate,
  classifyRow,
  langOf,
  underPath,
  wilsonUpper95,
  mean,
  percentile,
  hardGatesFailed,
} from './metrics.js'
import { writeReport } from './report.js'
import { filterByLevel, parseLevelArg, DEFAULT_RUN_LEVEL } from './levels.js'
import { chainDepth, isFollowUp, priorQuestions } from './record.js'
import { chainTexts, resolveChain } from './conversation.js'
import { nodeEmbedTarget } from '../config.js'

import { ROOT, RAG, REPORTS, GOLDEN, DOCS, settings as docPilot } from '../cli-context.js'
import { applyFileEnv } from '../cli-env.js'
import { prefetchEmbeddings } from './prefetch.js'
import { COMMANDS, entryFlagError, flagValue, flagGiven } from '../cli-flags.js'
import { printError, codeFor, tick, tock, FAILED, USAGE } from '../cli-exit.js'

/**
 * The hash of the instruction THIS project sends, not of the shipped default.
 *
 * It names every report file and is what `diffSummaries` compares two runs on,
 * so it has to move when the instruction moves — and `docPilot.product` and
 * `docPilot.prompt.override`/`extend` all move it. Reading the module constant
 * instead would file a report about a customised prompt under the stock one's
 * name and report "no change" across a rewrite.
 */
const PROMPT_HASH = promptHash(docPilot.prompt, docPilot.product)

/**
 * `.env.local`, through the same loader `config.mjs` uses.
 *
 * Until now the eval could only be given a key by exporting it on the command
 * line, which puts a live credential into shell history and into any transcript
 * of the run. The file is already gitignored; this makes it the single place a
 * key has to exist. Existing environment wins, so CI and a one-off export both
 * still override it.
 */
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
const arg = (name: string, dflt?: string) => flagValue('eval', FLAGS, name) ?? dflt
const has = (name: string) => flagGiven('eval', FLAGS, name)

/**
 * Declared here, above the flags, and not in the `main` section below with the
 * rest of the output helpers: `--level=` is validated at module scope, and a
 * `const` declared further down is in its temporal dead zone there — a mistyped
 * tier would print a ReferenceError instead of the six legal ones.
 */
const die = (m) => {
  printError(m)
  process.exit(FAILED)
}

/**
 * Every flag `arg()` reads, with an example of the form it wants. The booleans
 * `has()` reads — `--gate-only`, `--lexical`, `--resume` — are deliberately not
 * here: for them the bare form IS the form.
 *
 * `arg()` matches `--name=` and nothing else, so a bare `--name value` leaves the
 * value as a stray positional and the flag reads as absent. On `--level` that is
 * silent and destructive: `parseLevelArg(undefined)` returns `ultra`, so
 * `docpilot eval --level low` scores all sixty records, stamps `meta.level:
 * 'ultra'`, and — because `reportName` adds no segment for ultra — OVERWRITES the
 * full-set baseline report and diffs itself against it. The header line that
 * names the pool is suppressed for ultra, so nothing on screen contradicts the
 * tier the author thought they asked for. `--limit 5` and `--num-ctx 4096` have
 * the same shape: the run silently uses the default and reports it as fact.
 *
 * cli.md promises that "an unknown tier is refused rather than defaulted, by
 * every command that takes the flag"; a bare flag is the same promise, and
 * `parseLevelArg` cannot keep it — by the time it is called the flag is gone.
 *
 * Exported for the unit test, which cannot exercise the module-scope check
 * without ending the worker in `process.exit`.
 */
export const VALUE_FLAGS = Object.fromEntries(
  COMMANDS.eval.flags.filter((f) => f.kind !== 'bool').map((f) => [f.name, f.example]),
)

/** The first value-taking flag in `argv` written without its `=`, or null. */
export function bareValueFlag(argv, flags = VALUE_FLAGS) {
  // Exact match: `--level` alone. `--level=low` and `--levels` both start with
  // the name and neither is the mistake being caught here.
  return Object.keys(flags).find((name) => argv.includes(`--${name}`)) ?? null
}

/**
 * The whole check now, not just the bare-flag half of it.
 *
 * `bareValueFlag` stays exported because it is what the unit test can call — the
 * module-scope guard below ends the worker in `process.exit` — but the guard is
 * `flagErrors`, which catches the three cases this file used to wave through:
 * `--levle=low` (unknown, so the flag read as absent and `ultra` ran),
 * `--limit=abc` (NaN, falsy, so the whole pool ran) and `--fallback=grbge`
 * (neither 'on' nor 'off', so it silently meant 'auto').
 */
const BAD_FLAG = entryFlagError('eval', import.meta.url)
// `2`, not `die`'s `1`: nothing was attempted, so this is not a failed run.
if (BAD_FLAG) {
  printError(BAD_FLAG)
  process.exit(USAGE)
}

// --models is the matrix; --model stays as the one-model alias it always was.
const MODELS = String(arg('models', arg('model', 'qwen3:8b')))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const LIMIT = Number(arg('limit', '0'))
/**
 * The POPULATION this run scores, where `--limit` is only how much of it gets
 * measured.
 *
 * The two are not interchangeable and the difference shows up in the report:
 * `--limit=10` is the head of the file, so the "quick" run and the full run
 * disagree about which questions matter and neither number explains the other. A
 * level is a declared pool — every larger pool contains every smaller one — so a
 * `--level=low` regression is a regression in the full set too, and two reports
 * at the same tier are comparable by construction (report.js refuses to diff
 * across tiers for exactly that reason).
 *
 * `parseLevelArg` throws rather than defaulting: a typo that fell through to
 * `ultra` would print a pool nobody asked for and be read as the tier the author
 * thought they ran. It is a bad VALUE, so it exits `2` like every other
 * mis-typed command line — `codeFor` carries that off the throw.
 */
let RUN_LEVEL = DEFAULT_RUN_LEVEL
try {
  RUN_LEVEL = parseLevelArg(arg('level'))
} catch (e) {
  printError(e.message, e)
  process.exit(codeFor(e))
}
const BASE = process.env.DOCPILOT_BASE_URL || 'http://localhost:11434'
const GATE_ONLY = has('gate-only')
/**
 * The flag is one of two routes into the same measurement; a vectorless index is
 * the other, and `main()` raises this once the manifest has been read.
 *
 * It cannot be a `const` for that reason, and it cannot be derived from the index
 * either — `reportName` and `probeRecords` both read it, and the flag has to be
 * known before anything is loaded. Left false against an index built with
 * `--no-embed`, the run would ask an embedder for vectors this corpus never had
 * and file the answer under the hybrid report name, beside numbers produced by a
 * channel it does not have.
 */
let LEXICAL = has('lexical')
const RESUME = has('resume')
// Defaults to what the product ships (config.mjs / session.js), so an eval with
// no flags measures the configuration a reader actually gets.
const MAX_ITERATIONS = Number(arg('max-iterations', '0')) || 2

// auto | on | off. `auto` probes each model for tool support, which is the only
// way phi4:14b — advertised in RAG-SPEC 4.6 as a native tool caller, and shipped
// by this Ollama build with `completion` alone — is measured on the transport it
// will actually run on.
const FALLBACK_MODE = String(arg('fallback', 'auto'))

/**
 * Ollama's server default context is 4096 tokens — verified on this machine with
 * /api/ps, which reported `qwen3:8b ctx=4096` while a primed turn was already
 * sending more than that. Pinning it is what makes a matrix comparable at all:
 * unpinned, each model silently truncates at a different point and the run
 * measures three different prompts. 16384 is phi4:14b's ceiling, so it is the
 * largest value every row of the matrix can honour.
 */
const NUM_CTX = Number(arg('num-ctx', '8192'))

/**
 * THE SEED — the same constant `calibrate` draws its anchors with.
 *
 * Every answer metric in this report was one UNSEEDED sample. The transport has
 * accepted a seed all along — `providers.ts:164` writes `body.options.seed` for
 * ollama and `applyTuning` writes `body.seed` for the openai-compatible half —
 * and it never arrived for one reason: `config.llm` here carried no `tuning`, so
 * the guard `if (tuning?.seed != null)` never fired.
 *
 * SENT, NOT GUARANTEED, and the report says which. Anthropic's API has no such
 * parameter and its adapter declares `seed: false`; a provider that takes the
 * field still decides what to do with it. The arbiter of answer reproducibility
 * remains `bench runs`, which measures spread across three runs rather than
 * claiming there is none.
 *
 * `DOCPILOT_EVAL_SEED=""` sends nothing — the behaviour before this spec.
 */
const SEED = (() => {
  const raw = process.env.DOCPILOT_EVAL_SEED
  if (raw === '') return null
  const n = Number(raw ?? 20260829)
  return Number.isFinite(n) ? n : 20260829
})()

/** The temperature the turn has always used, named once so `meta` can record it. */
const TEMPERATURE = 0.2

/**
 * The version that produced the report, read rather than baked in.
 *
 * A constant here is a constant a release forgets to bump — the same reason
 * `bin/docpilot.js` reads it out of the manifest for `--version`.
 */
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  } catch {
    return null
  }
})()

/**
 * WHICH golden set — sha1 of the file, truncated to 16 hex.
 *
 * The same truncation `sigOf` uses in `calibrate.js`, and for the same reason:
 * sixteen hex is enough to name a file and short enough to read in a table.
 * Computed from the bytes on disk rather than from the parsed records, so a
 * reordering or a reformatting shows up — the question being answered is
 * "was this the same file", not "were these the same questions".
 */
const goldenSha = () => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(GOLDEN)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

/**
 * THE WITNESSES — the half of `meta` that describes the CIRCUMSTANCES.
 *
 * Eighteen fields described the INPUT: the corpus hash, the prompt hash, the
 * levers, the flags. Not one described the run. A report taken against a metered
 * provider and one taken against a laptop's Ollama were byte-identical here —
 * `provider` is the name of an API family, not the host that answered — and a
 * rerun a week later was indistinguishable from the one it overwrote.
 *
 * `goldenSha` is a MARKER and not a filter: `previousReport` still pairs a run
 * with its predecessor across an edit, and `report.js` says the set moved.
 * Absent in an older report reads as "unknown", which is the rule `meta.level`
 * already established.
 *
 * `temperature` and `seed` are written even when the seed is off, so a report
 * says which era it is from rather than leaving that to be inferred from an
 * absence.
 *
 * EXPORTED for the same reason `reportName` is: the module-scope guard below
 * ends the process, so the only way to assert this shape is to call it.
 */
export function provenance() {
  return {
    ranAt: new Date().toISOString(),
    chatBase: originOf(BASE),
    embedBase: originOf(EMBED_BASE),
    node: process.version,
    package: PACKAGE_VERSION,
    goldenSha: goldenSha(),
    temperature: TEMPERATURE,
    seed: SEED,
  }
}

/**
 * THE ARM THIS RUN IS — the other half of the witnesses, one axis over.
 *
 * `DOCPILOT_HISTORY_CONDENSE` and `DOCPILOT_ANTECEDENT_HOPS` exist so both arms
 * of a measurement run on ONE build rather than on two checkouts. Neither
 * reached `meta`, so both arms got the same `reportName`, the second overwrote
 * the first, and `diffSummaries` presented the pair as "Change since the
 * previous run" with nothing on the page saying an arm had moved — which is the
 * failure `meta.lexical`, `meta.level`, `meta.goldenSha` and `levers` were each
 * added to prevent, arrived at through the one input none of them covers.
 *
 * RE-DERIVED RATHER THAN IMPORTED, and that is an assumption, not a preference:
 * gate.js reads the hops through a module-private `hops()` and prompt.js reads
 * the condense flag through a module-private `historyCondense()`, and neither
 * is exported. The two expressions below are those verbatim — including the
 * clamp, whose ceiling is IMPORTED rather than written `2`, so a third hop moves
 * the report with the behaviour instead of reporting the old range. Export
 * either reader and this becomes a call to it.
 *
 * READ AT CALL TIME, for the reason those two readers were moved to call time:
 * `applyFileEnv()` runs after every import in this file, so a knob set in
 * `.env.local` is not yet in `process.env` while any module body is evaluating.
 * A constant here would name the default while the run took the other arm —
 * the same divergence one level down.
 *
 * EXPORTED for the same reason `provenance` is: the module-scope guard below
 * ends the process, so calling it is the only way to assert the shape.
 */
export function abKnobs() {
  const raw = process.env.DOCPILOT_ANTECEDENT_HOPS
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return {
    historyCondense: process.env.DOCPILOT_HISTORY_CONDENSE !== '0',
    antecedentHops: Number.isFinite(n)
      ? Math.min(Math.max(Math.trunc(n), 1), ANTECEDENT_HOPS)
      : ANTECEDENT_HOPS,
  }
}

/**
 * An address, without the path and without anything that could be a credential.
 *
 * A report taken against a metered provider and one taken against
 * `localhost:11434` were byte-identical in `meta`: `provider` is the name of an
 * API family, not the host that answered it. The ORIGIN is the fact worth
 * keeping; a full URL can carry a key in its query and this file is committed.
 */
const originOf = (url) => {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// Same three adapters the panel uses, so an eval run measures the transport the
// readers will actually get. Keys come from the environment; nothing is stored.
const PROVIDER = arg('provider', process.env.DOCPILOT_PROVIDER || 'ollama')
const API_KEY =
  process.env.DOCPILOT_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENROUTER_API_KEY ||
  null
/**
 * The embedder comes from `docPilot.embed`, not from the CHAT provider.
 *
 * The two are configured separately for a reason — Anthropic answers and cannot
 * embed — and deriving one from the other meant that a project whose index was
 * built with a hosted embedder had its eval queries embedded against a local
 * Ollama. Either it failed on an unreachable endpoint, or, if one happened to be
 * running, it scored queries in a foreign vector space and reported the result
 * as this corpus's retrieval quality. `nodeEmbedTarget` is the same resolver
 * `docpilot index` uses. The environment still wins.
 */
const EMBED_TARGET = nodeEmbedTarget(docPilot, process.env)
const EMBED_PROVIDER = process.env.DOCPILOT_EMBED_PROVIDER || EMBED_TARGET.provider
const EMBED_BASE = process.env.DOCPILOT_EMBED_URL || EMBED_TARGET.baseURL
const EMBED_KEY = process.env.DOCPILOT_EMBED_KEY || EMBED_TARGET.apiKey || null

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

/**
 * The artefacts are read off disk rather than fetched, but assembled by the same
 * function the browser uses — a second copy of the integrity checks is a copy
 * that stops matching the format it guards.
 */
function loadIndex() {
  const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
  const shards = manifest.shards.map((s) => JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')))
  // A `--no-embed` index writes `vectors: null` and no blob beside it. Reading it
  // unconditionally is what made `eval --lexical` demand the one file it then
  // never touches — the flag turns the dense channel off, and the read happened
  // anyway, three lines before anything could ask whether it was wanted.
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

/** RAG-SPEC 6: an unreachable endpoint must produce a command, not a stack trace. */
function endpointHelp(what, url, provider, e) {
  const hint =
    provider === 'ollama'
      ? `\n        start it with:  ollama serve` +
        `\n        check models:   ollama list`
      : `\n        check DOCPILOT_BASE_URL and the API key in .env.local`
  return `${what} endpoint unreachable at ${url} — ${e.message || e}${hint}`
}

/**
 * ONE PURCHASE FOR THE WHOLE RUN.
 *
 * `embed()` below sends one text per request, which is right for a reader typing
 * a question and wrong for a measurement: this repository's golden set is 58
 * requests that way and 2 through the batcher `calibrate` has used since spec
 * 008. Against a fifty-a-day free tier that is the difference between a run you
 * can repeat and a run you cannot.
 *
 * The map is a CACHE and never a second code path: every failure inside
 * `prefetchEmbeddings` leaves it short, and `embed()` falls through to
 * `embedQuery` exactly as it always did — including the endpoint diagnosis,
 * which lives there and is worded better than anything a batcher could say.
 */
const PREFETCHED = new Map<string, Float64Array>()

async function embed(text, model) {
  // The batch and the per-text path produce the same vector to the bit —
  // `scaleToIndexDomain` is `embedQuery`'s own tail — so the width check below
  // applies to both. Checking only the fetched half would let the batcher's
  // vectors past the one guard that stops a foreign vector space being reported
  // as this corpus's retrieval quality.
  const vec =
    PREFETCHED.get(text) ??
    (await embedQuery(text, {
      provider: EMBED_PROVIDER,
      baseURL: EMBED_BASE,
      model,
      apiKey: EMBED_KEY,
    }))
  // Fail loudly on a width mismatch instead of degrading.
  //
  // The retriever's own response to a foreign vector is to drop queryVec and
  // fall back to lexical-only — correct for a browser, wrong for a measurement,
  // because the run then reports retrieval numbers for a channel that was never
  // used and never says so. This bites the moment DOCPILOT_PROVIDER is switched to
  // a hosted service without also setting DOCPILOT_EMBED_PROVIDER: the embed call
  // follows the chat provider, and text-embedding-3-small is 1536 dims against
  // this index's 1024.
  if (EXPECTED_DIMS && vec.length !== EXPECTED_DIMS) {
    die(
      `embed model mismatch: ${EMBED_PROVIDER}/${model} returned ${vec.length} dims, ` +
        `the index was built with ${EXPECTED_DIMS} (${model === undefined ? '?' : model}).\n` +
        `        The index is bge-m3/1024. Point the embedder at it:\n` +
        `          DOCPILOT_EMBED_PROVIDER=ollama\n` +
        `          DOCPILOT_EMBED_URL=http://localhost:11434\n` +
        `        Retrieval and generation are configured separately on purpose — a hosted\n` +
        `        chat provider does not have to be the one that embeds.`,
    )
  }
  return vec
}

let EXPECTED_DIMS = null

const pad = (s, n) => String(s).padEnd(n)
const pct = (v) => (v == null ? '  —  ' : `${(100 * v).toFixed(0).padStart(3)}%`)
const num = (v, d = 2) => (v == null ? ' — ' : v.toFixed(d))
const kchars = (v) => (v == null ? ' — ' : `${(v / 1000).toFixed(1)}k`)

// ── stage A: retrieval and the gate, once per record ─────────────────────────

/**
 * Everything here is a pure function of (index, guard, record). It is computed
 * before any model is contacted and reused across the whole matrix.
 */
async function probeRecords(index, guard, records) {
  /**
   * Every text this pass will ask for, bought before the loop asks for the
   * first. Both channels: a follow-up record embeds its composed query too, and
   * missing it here would leave a quarter of the run buying one at a time. The
   * priming turns' own questions are in it too, for the gates they now run
   * under: bought here or bought one at a time later, and the batcher exists
   * because a free tier meters requests.
   *
   * THE LIST IS ENUMERATED, NOT GUESSED — `chainTexts` (src/eval/conversation.js).
   * A chain's antecedents are not knowable at this point and cannot be made so:
   * turn i composes against whichever question turn i-1 won its gate on, and no
   * gate has been run yet. The enumeration walks `chainAntecedent` itself over
   * both values of the single flag that function reads, so the batcher cannot
   * ask for a string the probe will not and the probe cannot ask for one the
   * batcher did not — the second of those is the expensive direction, because a
   * miss falls through `embed()` to one request per text.
   *
   * NO EXISTING RUN CHANGES ITS REQUEST COUNT. A depth-0 record still buys one
   * text and a depth-1 record still buys the same three the literal here spelled
   * out; `prefetchEmbeddings` dedupes through a Set and drops falsy entries, so
   * the composition of a first turn costs nothing. Only a depth >= 2 record —
   * which no golden set could express before engine-spec 023 — adds one.
   */
  if (!LEXICAL) {
    const wanted = records.flatMap((rec) => chainTexts(rec))
    const { vectors, requests } = await prefetchEmbeddings(
      wanted,
      {
        provider: EMBED_PROVIDER,
        baseURL: EMBED_BASE,
        apiKey: EMBED_KEY,
        model: index.manifest.embedModel,
      },
      { onTick: (done, total) => tick(`embedded ${done}/${total} queries…`) },
    )
    for (const [t, v] of vectors) PREFETCHED.set(t, v)
    if (vectors.size) tock(`embedded ${vectors.size} queries in ${requests} request(s)`)
  }

  const probes = []
  for (const rec of records) {
    const scope = rec.scope || ALL_SCOPE
    // `tuning` is not optional here even though the parameter is. The manifest
    // carries what `docpilot tune` measured on THIS corpus, and it is what the
    // browser bundle resolves its levers from — omitting it would score the
    // package defaults and file the result as this deployment's retrieval
    // quality, which is the one thing a report may never be wrong about.
    const retrieval = createRetrieval({ index, scope, guard, tuning: index.manifest.tuning })

    let vec
    if (!LEXICAL) {
      try {
        vec = await embed(rec.question, index.manifest.embedModel)
      } catch (e) {
        die(endpointHelp('embed', EMBED_BASE, EMBED_PROVIDER, e))
      }
    }

    /**
     * THE PRIMING TURNS NEED THEIR OWN GATES, and running them without one is a
     * measurement error rather than an economy.
     *
     * Every question before the scored one is a real turn: in production it runs
     * its own retrieval and is primed with what ITS question found. Here they
     * were handed `probe.g` — the gate of the SCORED question — so a priming
     * turn answered its own question from evidence retrieved for another.
     *
     * Two consequences, and the second is what made this worth an embedding.
     * The answer that becomes history was written from the wrong excerpts, so
     * the window §4.5 exercises is not the window production builds. And
     * anything the scored turn INHERITS from a priming one — spec 013 primes it
     * with the chunks that answer cited — is inherited out of the scored turn's
     * own gate result, lands in `primed` already, and dedupes away to nothing.
     * The feature was structurally unmeasurable: byte-identical prompt tokens on
     * all eight follow-ups, which is what sent us looking.
     *
     * ONLY THE ARITY MOVED. `resolveChain` runs that same argument once per hop
     * — every prior question in order, each gated against the antecedent the
     * turn before it left — because the antecedent the SCORED question inherits
     * is a function of which channel each of those gates won on and not of where
     * a question sits in the array. A `map` over the chain would have to invent
     * each hop's antecedent from its index, which is the position test
     * `chainAntecedent` refuses.
     */
    const { priorGates, priorVecs, antecedent, composedQuery } = await resolveChain({
      rec,
      retrieval,
      // The closure carries THIS file's endpoint diagnosis across a boundary
      // `conversation.js` keeps pure by contract. Wrapping the `resolveChain`
      // call itself instead would file a `retrieval.evaluate` throw under
      // "embed endpoint unreachable" and send a reader to restart Ollama over a
      // corrupt index.
      embed: async (text) => {
        try {
          return await embed(text, index.manifest.embedModel)
        } catch (e) {
          die(endpointHelp('embed', EMBED_BASE, EMBED_PROVIDER, e))
        }
      },
      lexical: LEXICAL,
    })

    // A follow-up record's first turn is a real turn: the composed channel only
    // exists when there is an antecedent to compose with. The string arrives
    // from `resolveChain`, which builds it with `composeQuery`, so the vector
    // embedded here and the query `evaluate()` composes internally can never
    // drift apart.
    let composedVec
    if (composedQuery && !LEXICAL) {
      composedVec = await embed(composedQuery, index.manifest.embedModel)
    }
    // A composed follow-up still has a lexical channel, so the composed run must
    // happen under --lexical too: `undefined` skips it, `null` runs it with no
    // vector. Skipping it would score follow-ups on the raw channel alone and
    // charge the difference to the missing embedder.
    if (LEXICAL && composedQuery) composedVec = null

    const g = retrieval.evaluate({
      question: rec.question,
      previousQuestion: antecedent,
      queryVec: vec,
      composedVec,
      mode: LEXICAL ? 'lexical-only' : 'hybrid',
    })

    const retrievedIds = g.chunks.map((c) => c.id)
    // Recall and MRR need a longer ranked list than the gate's k=5. The
    // retriever clamps k at 8 for the model, and a diagnostic is not a reason to
    // widen the choke point's public contract — so this is recall@8, named as
    // such, rather than the spec's @10 measured through a back door.
    //
    // It must rank on the channel the gate ACTUALLY WON ON, not on the bare
    // question. `evaluate()` runs two channels and keeps the higher-G admissible
    // one; on a follow-up that is normally `composed`, and the chunks the model
    // then sees come from it. Ranking the bare question instead measured a query
    // no turn ever issues: `q-25` scored recall8 = 0 with its gold at rank 1 of
    // `retrievedIds`. Both halves of the channel move together — `evaluate()`
    // composes the lexical query and the vector, so pairing a raw `query` with a
    // `composedVec` would invent a third configuration that production has no
    // path to.
    const ranked =
      g.channel === 'composed' && composedVec
        ? { query: composedQuery, queryVec: composedVec }
        : { query: rec.question, queryVec: vec }
    const rankedIds = retrieval.search({ ...ranked, k: 8 }).map((c) => c.id)

    // RAG-SPEC 5.1: for a scoped record whose gold set does not intersect the
    // scope, the correct outcome is a refusal — scoring it as F1 0 would punish
    // the gate for doing exactly what the scope asked of it.
    //
    // `?? []` because the LINTER, which docs/guide/evaluation.md names as the
    // authority on this schema, does not require the field on a negative record:
    // it errors only on a `refuse:no-evidence` record whose gold list is
    // NON-empty. Every negative in this repository's own set happens to carry
    // `gold_chunks: []`, so the bare read worked by convention rather than by
    // contract — and the first authored record that left the key out took the
    // whole run down with `Cannot read properties of undefined`, after the
    // embedder had already been paid for all 279 queries. A runner that crashes
    // on a record the linter passes is the two of them disagreeing about the
    // schema, and the runner is the one that must yield.
    const gold = rec.gold_chunks ?? []
    const goldInScope =
      scope.kind === 'all' || !scope.paths.length
        ? gold
        : gold.filter((gc) => scope.paths.some((p) => underPath(`/${gc}`, p)))
    const scoredAsNegative = gold.length > 0 && goldInScope.length === 0

    probes.push({
      rec,
      scope,
      retrieval,
      vec,
      composedVec,
      // The composed query `composedVec` belongs to, carried rather than rebuilt
      // at the two places that read it — `ranked` below and the scored turn's
      // own call. A second `composeQuery` here would be a second place for the
      // antecedent to be chosen, and the cascade is the only one entitled to.
      composedQuery,
      g,
      // The gate each PRIOR turn ran under, oldest first — empty for a record
      // with no chain, and never consulted for the scored turn.
      priorGates,
      // And that turn's own query vector, same length and same order. It rides
      // beside the gate because `primingProbe` has to swap the two TOGETHER: the
      // vector `vec` two fields up is `embed(rec.question)`, the question the
      // priming hop has not been asked yet. Bought inside `resolveChain` for the
      // hop's own gate and prefetched by `chainTexts`, so carrying it here costs
      // no request.
      priorVecs,
      // What the index was built with, so a turn can buy a vector for a query
      // the model writes without reaching back for the manifest — spec 015.
      embedModel: index.manifest.embedModel,
      retrievedIds,
      // The ranked eight the two retrieval metrics are read off. It was built
      // here and thrown away, so a report could say recall@8 was 1 and never say
      // WHERE the gold sat — the difference between a ranking problem and a
      // corpus problem, and the two have different fixes.
      rankedIds,
      goldPages: [...new Set(goldInScope.map((g) => pageOf(g)))],
      scoredAsNegative,
      retrieval_f1: goldInScope.length ? retrievalF1Loose(retrievedIds, goldInScope) : null,
      recall8: goldInScope.length ? recallAtK(rankedIds, goldInScope, 8) : null,
      mrr: goldInScope.length ? mrr(rankedIds, goldInScope) : null,
      scopeContainment: scopeContainment(retrievedIds, scope),
    })
  }
  return probes
}

/**
 * The probe the PRIMING turn at `hop` runs under — that hop's own gate AND that
 * hop's own query vector, or the record's if it has none to run under (a record
 * with no chain has no hop, so nothing reaches this; a hop past the end of
 * `priorGates` falls back rather than handing the harness `undefined` in the
 * middle of a matrix).
 *
 * THE VECTOR MOVES WITH THE GATE, and swapping only the gate was half a fix.
 * `probe.vec` is `embed(rec.question)` — the SCORED question, which at this
 * point has not been asked — so a hop left with it ran `search_docs` fusing
 * BM25 over its own question with cosine over a later one. That is not a
 * harmless mis-ranking of a throwaway turn: the priming answer becomes the
 * scored turn's history and its spec-013 priming, so the wrong vector arrives
 * in the measured row by the same route the right one would have. The defect
 * predates the chain records at one hop; a depth-2 record runs it twice.
 *
 * ONE INDEX READS BOTH LISTS. `resolveChain` returns them same-length and
 * same-order by contract, so `hop` addresses a matched pair; `?.` on the vector
 * list is for the probe that carries no vectors at all — `--lexical`, where
 * `probe.vec` is `undefined` too and both arms therefore agree.
 *
 * Exported because it is the whole of the fix and a one-line ternary inside an
 * await is a line nothing can pin: the defect it repairs was invisible in every
 * metric and surfaced only as eight byte-identical follow-up prompts.
 */
export function primingProbe(probe, hop) {
  if (!probe?.priorGates?.[hop]) return probe
  return { ...probe, g: probe.priorGates[hop], vec: probe.priorVecs?.[hop] }
}

// ── stage B: one model over the probed records ───────────────────────────────

async function runModel({ model, probes, guard, fallback, thinkSupported }) {
  const rows = []

  for (const probe of probes) {
    const { rec, g } = probe
    const wantRefusal = rec.expect.startsWith('refuse')

    const row: Record<string, any> = {
      id: rec.id,
      question: rec.question,
      kind: rec.kind || null,
      expect: rec.expect,
      scoped: probe.scope.kind !== 'all',
      followUp: isFollowUp(rec),
      // Not the boolean one field up. `0`, `1` and `>= 2` are three populations
      // — a cold question, the single hop that shipped, and a chain that can
      // reach the second antecedent — and `followUp` folds the last two into one
      // bucket, which is the fold `byDepth` exists to undo.
      depth: chainDepth(rec),
      G: g.G,
      D: g.D,
      L: g.L,
      channel: g.channel,
      gatePass: g.pass,
      retrievedIds: probe.retrievedIds,
      rankedIds: probe.rankedIds,
      // The record's own claim where it has one, detection where it does not.
      // Every metric below is a mean over a set whose language composition is
      // invisible in it: this corpus is English and a quarter of its readers are
      // not, and the two populations do not score alike.
      lang: langOf(rec),
      // The pages the gold lives on, so a miss can name a PAGE and not just a
      // record id. Retrieval is fixed on pages, not on question ids.
      goldPages: probe.goldPages,
      retrieval: probe.retrieval_f1,
      recall8: probe.recall8,
      mrr: probe.mrr,
      scopeContainment: probe.scopeContainment,
      scoredAsNegative: probe.scoredAsNegative,
    }

    /**
     * `enforces`, NOT a bare `!g.pass` — engine-spec 019.
     *
     * `g` is scored the same whatever `docPilot.guard.mode` says; whether a
     * failing one ends the row here is the same decision `session.js` makes
     * before ever calling the model. Hard-coding `!g.pass` measured a
     * behaviour the shipped default (`'off'`) does not produce: every negative
     * probe would show up as `refuse:no-evidence`/`refuse:out-of-scope` here
     * while the deployed panel sent every one of them to the model instead.
     * With the gate not enforcing, a probe now falls through to the same
     * model call an `answer`-expecting row makes, and lands on whatever
     * `row.observed` the post-model check below assigns —
     * `refuse:not-answerable` or `answer` — which is the measurement that
     * actually describes what ships.
     */
    if (enforces(docPilot.guard.mode, g.mode) && !g.pass) {
      row.observed = g.wouldPassUnscoped ? 'refuse:out-of-scope' : 'refuse:no-evidence'
      row.latencyMs = 0
      rows.push(row)
      report(row)
      continue
    }

    if (GATE_ONLY) {
      row.observed = 'answer'
      row.latencyMs = 0
      rows.push(row)
      report(row)
      continue
    }

    // A follow-up record is its chain plus one. Every priming answer becomes
    // history, which is the only way §4.5's three-pair window is exercised at
    // all — and the window is what a chain deeper than one hop is FOR, since
    // `buildMessages` keeps three pairs verbatim and condenses what is older.
    const chain = priorQuestions(rec)
    const history = []
    /**
     * THE FAILURE IS RECORDED, NOT `continue`d — the loop is nested now.
     *
     * Guarded like the scored turn below, for the reason that guard was added:
     * unguarded, one transport hiccup on a priming turn threw out into
     * `main().catch → die`, taking every row already run with it, because the
     * report is only written after the whole model finishes. But `continue`
     * inside this loop abandons a HOP and runs the scored turn anyway, against a
     * history with a gap in it and a row that says nothing happened. The flag is
     * what keeps the old meaning: the record is abandoned, once, after the
     * break.
     */
    let primingError = null
    for (const [hop, question] of chain.entries()) {
      let first
      try {
        first = await turn({
          // This hop's own gate, so the priming turn answers from what its own
          // question retrieved — see `priorGates` where they are built.
          probe: primingProbe(probe, hop),
          model,
          fallback,
          thinkSupported,
          guard,
          question,
          // ACCUMULATING, not `[]`: hop 2 is answered with hop 1 already in its
          // window, which is the whole difference between a chain and two
          // unrelated first turns. Handing every hop an empty history would
          // measure a conversation the reader never had.
          history,
        })
      } catch (e) {
        // Which hop, and of how many. "priming turn: fetch failed" on a
        // three-question record names neither the turn that broke nor whether
        // the ones before it had already landed.
        primingError = `priming turn ${hop + 1}/${chain.length}: ${String(e.message || e)}`
        break
      }
      // The citations travel with the answer: spec 013 primes a follow-up with the
      // evidence its antecedent stood on, and a history entry without them would
      // measure the turn the panel does not run.
      if (first?.text?.trim())
        history.push({ question, answer: first.text, citations: first.citations || [] })
    }
    if (primingError) {
      row.observed = 'error'
      row.error = primingError
      row.latencyMs = 0
      rows.push(row)
      report(row)
      continue
    }

    const t0 = Date.now()
    let res
    try {
      res = await turn({
        probe,
        model,
        fallback,
        thinkSupported,
        guard,
        question: rec.question,
        history,
        composedQuery: probe.composedQuery,
        composedVec: probe.composedVec,
      })
    } catch (e) {
      row.observed = 'error'
      row.error = String(e.message || e)
      row.latencyMs = Date.now() - t0
      rows.push(row)
      report(row)
      continue
    }

    row.latencyMs = Date.now() - t0
    row.iterations = res.iterations
    // Not `cost.steps`, which counts the chat() calls the harness made. This is
    // what the transport actually posted — rotation, retries and continuations
    // included — and on a metered free tier it is the whole bill: OpenRouter
    // caps the day at 50 REQUESTS and does not look at tokens at all. Without it
    // "a turn costs three or four requests" is a claim nobody can check here.
    row.requests = res.requests
    row.rejectedFetches = res.rejectedFetches
    row.support = res.support
    row.cost = res.cost
    // What the model searched for on its own, and in which language. The turn's
    // query vector is the reader's question whatever the model then asks for, so
    // a re-search in another language scores a foreign sentence's vector against
    // the corpus — the evidence spec 015 is written against, and it has to be
    // measured before it is believed.
    const searched = (res.trace || [])
      .filter((t) => t.kind === 'search')
      .map((t) => String(t.data?.query || ''))
      .filter(Boolean)
    /**
     * MEASURED AGAINST THE TEXT THE TURN WAS SCORED ON, both halves of it.
     *
     * `harness.js` resolves a `search_docs` carrying no `query` of its own to
     * `args.query || composedQuery || question` and traces the RESOLVED string.
     * On a composed-channel follow-up that default is the composition, which is
     * not `rec.question` — so comparing against the raw question alone filed
     * every such call as a query the model chose. Nobody chose it: it is this
     * turn's own query, arriving through a default, and it inflates `reSearch`
     * on precisely the follow-ups the composed channel exists for.
     *
     * Built from `researchPair`'s own output rather than from a predicate that
     * matches it, so the set cannot name a composition the harness was not
     * given — including under `DOCPILOT_RESEARCH_VEC=raw`, where the harness is
     * given none and every composed default the arm removes would otherwise be
     * filed as a query the model chose.
     */
    const sentPair = researchPair(probe, probe.composedQuery, probe.composedVec)
    const ownQuery = new Set(
      [rec.question, sentPair.composedQuery].filter(Boolean).map((q) => normaliseAnswer(q)),
    )
    row.reSearch = searched.filter((q) => !ownQuery.has(normaliseAnswer(q)))
    row.reSearchLang = [...new Set(row.reSearch.map((q) => langOf({ question: q })))]
    row.hallucinated = hallucinatedCitationRate(res.citations, res.emitted)
    row.emittedContainment = scopeContainment(res.emitted, probe.scope)

    const answered = res.text.trim() && res.citations.length && res.confidence >= 0.4
    row.observed = answered ? 'answer' : 'refuse:not-answerable'

    if (answered && !wantRefusal) {
      row.answerF1 = tokenF1(res.text, rec.gold_answer)
      row.identifierRecall = identifierRecall(res.text, rec.identifiers)
      row.language = languageMatch(rec.question, res.text)
      row.citationPrecision = citationPrecision(res.citations, rec.gold_chunks ?? [])
      // Precision divides by what the answerer chose and recall by what the
      // record pinned; at |gold| = 1 the first moves with terseness alone.
      row.citationRecall = citationRecall(res.citations, rec.gold_chunks ?? [])
    }
    row.text = res.text
    rows.push(row)
    report(row)
  }

  return rows
}

/**
 * `DOCPILOT_EMBED_MODEL_QUERY=1` — engine-spec 015, and OFF here for the reason
 * the spec gives about itself.
 *
 * The lever lets a `search_docs` query the MODEL wrote reach the dense channel
 * instead of scoring the reader's original question. On THIS corpus it has
 * almost nothing to move: the report's own `Re-search` section counted two turns
 * in seventy. So it ships switched off and is measured where re-searching
 * actually happens — a corpus whose readers do not all write in its language.
 */
const EMBED_MODEL_QUERY = /^(1|true|yes)$/i.test(
  String(process.env.DOCPILOT_EMBED_MODEL_QUERY || ''),
)

/**
 * `DOCPILOT_RESEARCH_VEC=raw` — the other arm of engine-spec 022c, on ONE build.
 *
 * The A/B this exists for is not a comparison of two checkouts. `SEED_FROM_HISTORY`
 * established the rule for spec 013 and the reason has not changed: the priming
 * fixes, the golden set and the prompt all move between two builds, so a delta
 * measured across them is a delta of everything that was edited in between. A
 * switch keeps the corpus, the records, the vectors and the prompt hash fixed
 * and moves the one thing under test.
 *
 * It is EVAL-ONLY and it is not a configuration key. No resolver reads it, no
 * site can set it, `types/` does not name it, and the panel has no equivalent —
 * `session.js` follows the winning channel unconditionally, which is what 022c
 * decided. This reproduces the behaviour that decision replaced, for as long as
 * it takes to measure whether replacing it paid.
 */
const RESEARCH_VEC_RAW = /^raw$/i.test(String(process.env.DOCPILOT_RESEARCH_VEC || ''))

/**
 * The pair a model-issued `search_docs` re-searches on — the vector, and the
 * text that vector was embedded from.
 *
 * ONE FUNCTION FOR BOTH SLOTS, and that is the whole point of it existing rather
 * than two ternaries at the call site. `harness.js` resolves a `search_docs`
 * carrying no query of its own to `args.query || composedQuery || question`, so
 * the text half decides the BM25 query while the vector half decides the cosine
 * one. Send a composed vector beside a raw text — or a raw vector beside a
 * composed text — and the fusion runs over two different questions, which is the
 * defect 022c names. Returning them together makes that state unreachable, and
 * it is why the switch below flips both rather than the vector it is named for.
 *
 * Exported for the same reason `primingProbe` is: a predicate spelled inline
 * inside an argument list is a line no test can pin, and this one has three
 * callers' worth of consequences.
 */
export function researchPair(probe, composedQuery, composedVec) {
  const won = probe?.g?.channel === 'composed' && composedVec
  if (RESEARCH_VEC_RAW || !won) return { queryVec: probe?.vec ?? null, composedQuery: null }
  return { queryVec: composedVec, composedQuery: composedQuery ?? null }
}

/**
 * @param composedQuery  the composed query this turn's gate was scored on, with
 *   `composedVec` beside it. PER-TURN and deliberately not read off the probe,
 *   which is the same distinction `primingProbe` draws: a priming hop is handed
 *   the probe with its OWN gate swapped in, while the probe's composed pair
 *   belongs to the SCORED question. Read from the probe, a hop whose gate won on
 *   `composed` would re-search against a composition of questions that had not
 *   been asked yet. The two callers below say which they are by passing the pair
 *   or omitting it.
 */
function turn({
  probe,
  model,
  fallback,
  thinkSupported,
  guard,
  question,
  history,
  composedQuery = null,
  composedVec = null,
}) {
  return runTurn({
    embedQuery: EMBED_MODEL_QUERY ? (text) => embed(text, probe.embedModel) : null,
    retrieval: probe.retrieval,
    gateResult: probe.g,
    question,
    history,
    addendum: '',
    config: {
      llm: {
        provider: PROVIDER,
        baseURL: BASE,
        model,
        apiKey: API_KEY,
        temperature: TEMPERATURE,
        // The one field that makes the answer half of this report repeatable at
        // all. `harness.js` no longer drops the whole record on a model that
        // cannot think — see `sampling()` there — so the seed reaches the call
        // that writes the answer rather than only the loop steps.
        tuning: SEED == null ? undefined : { seed: SEED },
        stepTimeoutMs: 180000,
        numCtx: PROVIDER === 'ollama' ? NUM_CTX : undefined,
        thinkSupported,
      },
      maxIterations: MAX_ITERATIONS ?? 4,
      guard,
      scope: { promptListLimit: 12 },
      // The eval must send the instruction this project actually ships. Leaving
      // these out measured the stock prompt and filed the result under the
      // project's own name.
      prompt: docPilot.prompt,
      product: docPilot.product,
    },
    fallback,
    /**
     * BOTH HALVES FOLLOW THE CHANNEL THE GATE WON ON — engine-spec 022c, and the
     * predicate is `session.js:2625`'s verbatim, on both lines.
     *
     * The panel hands the harness the composed vector whenever the gate won on
     * the composed channel; this handed `probe.vec` unconditionally, so a
     * follow-up the composed channel rescued was measured with the model
     * re-searching against the bare tail — «а я могу его стилизировать?» on its
     * own, a query no turn in production issues. The truthiness guard is
     * load-bearing rather than defensive: `null` means "score it with no vector"
     * and `undefined` means "there is no second query", and a lexical-only turn
     * settles `composedVec` at `null` by design, so both arms resolve to the raw
     * value there.
     *
     * ONE PREDICATE, TWO SLOTS, and gating only the vector reintroduced exactly
     * what 022c removed from the panel. `resolveChain` builds `composedQuery`
     * for every record that has a chain, whatever channel then wins, so passing
     * it bare handed the harness a composed lexical default beside a raw cosine
     * — one RRF over two different queries, which is the shape 022c was written
     * against, arrived at from the other side. It lands only on rows that have
     * an antecedent, which is precisely the population `byDepth` was added to
     * report; before that section existed such a divergence had nowhere to show
     * up at all.
     *
     * Both slots come out of `researchPair` in one object rather than out of two
     * ternaries that happened to share a predicate: the sharing was the
     * invariant, and a shared predicate is only an invariant while nobody edits
     * one line of it. `DOCPILOT_RESEARCH_VEC=raw` reproduces the pre-022c pair
     * there, for the A/B, and reproduces it on BOTH halves.
     */
    ...researchPair(probe, composedQuery, composedVec),
  })
}

// ── output ───────────────────────────────────────────────────────────────────

/**
 * What this record is actually expecting, once scope is taken into account.
 *
 * A record whose gold set falls entirely outside its own scope has one correct
 * outcome — a refusal — and `probeRecords` says so in as many words. Its `expect`
 * field still reads `answer`, though, so every consumer that compared against it
 * was measuring the gate against a bar the gate is not supposed to clear:
 * `causeExact` could never credit it, dragging `noAnswerPrecision` down however
 * well the gate behaved, and the correct refusal printed as MISS.
 */
const expectEff = (r) => (r.scoredAsNegative ? 'refuse:out-of-scope' : r.expect)

function report(row) {
  const expect = expectEff(row)
  const ok =
    row.observed === expect || (expect.startsWith('refuse') && row.observed.startsWith('refuse'))
  console.log(
    `${ok ? ' ok ' : 'MISS'} ${pad(row.id, 6)} G=${num(row.G)} ` +
      `ret=${row.retrieval ? num(row.retrieval.f1) : ' — '} ` +
      `ans=${num(row.answerF1)} lang=${row.language == null ? '—' : row.language ? 'ok' : 'WRONG'} ` +
      `${((row.latencyMs || 0) / 1000).toFixed(0)}s  ${row.question.slice(0, 42)}`,
  )
}

/** Every aggregate the summary and the markdown report share. */
export function summarise(rows) {
  const positives = rows.filter((r) => r.expect === 'answer' && !r.scoredAsNegative)
  const negatives = rows.filter((r) => r.expect.startsWith('refuse') || r.scoredAsNegative)
  const answered = positives.filter((r) => r.observed === 'answer')

  const gateOverRefusal = positives.filter((r) => !r.gatePass).length
  const answerOverRefusal = positives.filter(
    (r) => r.gatePass && r.observed.startsWith('refuse'),
  ).length
  const caught = negatives.filter((r) => r.observed.startsWith('refuse')).length
  // Credited only when the observed cause equals the expected one: a gate that
  // refuses for the wrong reason used to score a perfect 1.0.
  const causeExact = negatives.filter((r) => r.observed === expectEff(r)).length

  const supported = answered.filter((r) => typeof r.support === 'number')
  const unsupported = supported.filter((r) => r.support < 0.5).length

  const containment = rows
    .map((r) => r.scopeContainment)
    .concat(rows.map((r) => r.emittedContainment))
    .filter((v) => typeof v === 'number')

  return {
    positives: positives.length,
    negatives: negatives.length,
    retrievalF1: mean(positives.map((r) => r.retrieval?.f1)),
    recall8: mean(positives.map((r) => r.recall8)),
    mrr: mean(positives.map((r) => r.mrr)),
    answerF1: mean(positives.map((r) => r.answerF1)),
    identifierRecall: mean(positives.map((r) => r.identifierRecall)),
    citationPrecision: mean(positives.map((r) => r.citationPrecision)),
    citationRecall: mean(positives.map((r) => r.citationRecall)),
    supportPrecision: mean(supported.map((r) => r.support)),
    unsupportedAnswerRate: supported.length ? unsupported / supported.length : null,
    language: mean(positives.map((r) => r.language)),
    gateOverRefusal,
    gateOverRefusalUB95: wilsonUpper95(gateOverRefusal, positives.length),
    answerOverRefusal,
    answerOverRefusalUB95: wilsonUpper95(answerOverRefusal, positives.length),
    negativesCaught: caught,
    negativesCaughtRate: negatives.length ? caught / negatives.length : null,
    noAnswerPrecision: negatives.length ? causeExact / negatives.length : null,
    hallucinated: mean(rows.map((r) => r.hallucinated)),
    scopeContainment: containment.length ? Math.min(...containment) : null,
    rejectedFetches: rows.reduce((a, r) => a + (r.rejectedFetches || 0), 0),
    iterationsPerAnswer: mean(answered.map((r) => r.iterations)),
    requestsPerTurn: mean(rows.map((r) => r.requests)),
    promptTokens: mean(rows.map((r) => r.cost?.promptTokens)),
    outputTokens: mean(rows.map((r) => r.cost?.outputTokens)),
    // Null on a transport that reports no cache — see `usageOf`. The share is
    // what the number is FOR: every observation is re-sent on every step, and
    // whether that costs full price is a fact about the provider's prefix cache
    // that nothing here could previously answer.
    cachedTokens: mean(rows.map((r) => r.cost?.cachedTokens)),
    cachedShare: cachedShare(rows),
    // The headline economy number: everything the machine had to think about,
    // divided by the answers it actually delivered. A model that refuses cheaply
    // is not cheap.
    tokensPerAcceptedAnswer: answered.length
      ? rows.reduce((a, r) => a + (r.cost?.promptTokens || 0) + (r.cost?.outputTokens || 0), 0) /
        answered.length
      : null,
    promptChars: mean(rows.map((r) => r.cost?.promptChars)),
    promptCharsPeak: mean(rows.map((r) => r.cost?.promptCharsPeak)),
    observationChars: mean(rows.map((r) => r.cost?.observationChars)),
    answerChars: mean(rows.map((r) => r.cost?.answerChars)),
    latencyP50: percentile(rows.map((r) => r.latencyMs), 0.5),
    latencyP95: percentile(rows.map((r) => r.latencyMs), 0.95),
    misses: rows
      .filter((r) => {
        const expect = expectEff(r)
        return !(
          r.observed === expect ||
          (expect.startsWith('refuse') && r.observed.startsWith('refuse'))
        )
      })
      .map((r) => `${r.id}(${r.observed})`),
    languageFailures: positives.filter((r) => r.language === 0).map((r) => r.id),
    byLanguage: byLanguage(positives, negatives),
    byDepth: byDepth(positives, negatives),
    taxonomy: taxonomyOf(rows),
    reSearch: reSearchSummary(rows),
    missPages: missPages(rows),
  }
}

/**
 * The pages behind the retrieval misses, and whether each states what it is FOR.
 *
 * The measured dense lever on this pipeline is a frontmatter `description`: it
 * lands on the page's first chunk and says, in the words a question uses, what
 * every heading on the page phrases as a topic. On one page it moved that
 * chunk's cosine 0.426 → 0.556. So a miss whose page has no `description` is a
 * documentation edit before it is a retrieval constant, and that distinction is
 * the whole reason `corpus` mode exists — but nothing pointed at the file.
 *
 * READ IT AS A LEAD, NOT A VERDICT. A page may be missing for three innocent
 * reasons: the corpus was built from HTML or OpenAPI rather than markdown, the
 * route does not map onto a path under `docsDir`, or the answer genuinely is not
 * written anywhere. Only pages that resolve to a real markdown file are named,
 * and a page whose file cannot be found is left out rather than guessed at.
 */
function missPages(rows) {
  const missed = rows.filter((r) => {
    const bucket = classifyRow(r)
    return bucket === 'retrieval-miss' || bucket === 'gold-below-primed'
  })
  const pages = [...new Set(missed.flatMap((r) => r.goldPages || []))]
  if (!pages.length) return null

  const out = []
  for (const page of pages) {
    const rel = String(page).replace(/^\//, '')
    const candidates = [`${rel}.md`, `${rel}/index.md`, `${rel}.mdx`]
    let file = null
    for (const c of candidates) {
      const full = path.join(DOCS, c)
      if (fs.existsSync(full)) {
        file = full
        break
      }
    }
    if (!file) continue
    let head = ''
    try {
      head = fs.readFileSync(file, 'utf8').slice(0, 2000)
    } catch {
      continue
    }
    // Frontmatter only: a `description:` further down the page is prose about
    // something else, and the chunker reads the block at the top.
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
    const described = Boolean(fm && /^description:\s*\S/m.test(fm[1]))
    out.push({ page, described, records: missed.filter((r) => r.goldPages?.includes(page)).map((r) => r.id) })
  }
  const undescribed = out.filter((p) => !p.described)
  return undescribed.length ? { undescribed, checked: out.length } : null
}

/**
 * How often the model re-searched, and how often it did so in another language
 * than the question. The second number is the one that costs: the dense channel
 * keeps scoring the reader's original sentence.
 */
function reSearchSummary(rows) {
  const withSearch = rows.filter((r) => r.reSearch?.length)
  if (!withSearch.length) return null
  const crossed = withSearch.filter(
    (r) => r.reSearchLang?.some((l) => l !== (r.lang || 'und')),
  )
  return {
    turns: withSearch.length,
    ofTurns: rows.length,
    crossLanguage: crossed.length,
    crossLanguageIds: crossed.map((r) => r.id),
  }
}

/** Cached prompt tokens over prompt tokens, across the rows that report one. */
function cachedShare(rows) {
  const measured = rows.filter((r) => typeof r.cost?.cachedTokens === 'number')
  if (!measured.length) return null
  const prompt = measured.reduce((a, r) => a + (r.cost.promptTokens || 0), 0)
  if (!prompt) return null
  return measured.reduce((a, r) => a + r.cost.cachedTokens, 0) / prompt
}

/**
 * The same metrics, split by the language the question was asked in.
 *
 * A mean over a mixed set hides the one difference that is structural rather
 * than incidental: BM25 shares no term across writing systems, so a question in
 * a language the corpus is not written in arrives ordered by the dense channel
 * alone. Measured on the development deployment, MRR was 0.318 for one language
 * and 0.509 for the other while the headline sat between them, describing
 * neither. Only populations with something in them are emitted, so a
 * single-language set gains one bucket and no noise.
 */
function byLanguage(positives, negatives) {
  const langs = [...new Set([...positives, ...negatives].map((r) => r.lang || 'und'))].sort()
  if (langs.length < 2) return null
  const out = {}
  for (const lang of langs) {
    const pos = positives.filter((r) => (r.lang || 'und') === lang)
    const neg = negatives.filter((r) => (r.lang || 'und') === lang)
    const caught = neg.filter((r) => r.observed.startsWith('refuse')).length
    out[lang] = {
      positives: pos.length,
      negatives: neg.length,
      recall8: mean(pos.map((r) => r.recall8)),
      mrr: mean(pos.map((r) => r.mrr)),
      answerF1: mean(pos.map((r) => r.answerF1)),
      identifierRecall: mean(pos.map((r) => r.identifierRecall)),
      citationRecall: mean(pos.map((r) => r.citationRecall)),
      language: mean(pos.map((r) => r.language)),
      negativesCaughtRate: neg.length ? caught / neg.length : null,
    }
  }
  return out
}

/**
 * The same metrics, split by how many questions preceded the one being scored.
 *
 * `byLanguage` one axis over, and the mean hides the same shape for a different
 * reason. A question asked cold and a question three turns into a chain are not
 * answered by the same machinery: the cold one is scored on its own text, the
 * elliptical one on a composition, and which antecedent went into that
 * composition is `chainAntecedent`'s decision (src/theme/docpilot/gate.js) taken
 * from how the turn before it won its gate. So a change to the chaining rule
 * moves the deep buckets and leaves depth 0 exactly where it was — and depth 0
 * is most of any golden set, so it holds the headline still while the one
 * population the change was written for moves underneath it.
 *
 * EVERY METRIC EMITTED HERE IS IN `HIGHER_IS_BETTER` — read in report.js and
 * checked name by name, not assumed. `depthKeys` there mints a tracked diff key
 * for every member of a bucket except `positives`/`negatives`, and
 * `diffSummaries` reads a metric that is in neither direction set as
 * lower-is-better; a key added here that is not in that set would print a real
 * improvement as a regression with nothing on the page to say so.
 *
 * Below two buckets it returns null, so a chain-free set renders exactly as it
 * does today — the rule `byLanguage` uses for a single-language set, and for the
 * same reason: one bucket is the headline with an extra heading over it.
 */
function byDepth(positives, negatives) {
  const depths = [...new Set([...positives, ...negatives].map((r) => r.depth || 0))].sort(
    (a, b) => a - b,
  )
  if (depths.length < 2) return null
  const out = {}
  for (const depth of depths) {
    const pos = positives.filter((r) => (r.depth || 0) === depth)
    const neg = negatives.filter((r) => (r.depth || 0) === depth)
    const caught = neg.filter((r) => r.observed.startsWith('refuse')).length
    out[depth] = {
      positives: pos.length,
      negatives: neg.length,
      recall8: mean(pos.map((r) => r.recall8)),
      mrr: mean(pos.map((r) => r.mrr)),
      answerF1: mean(pos.map((r) => r.answerF1)),
      identifierRecall: mean(pos.map((r) => r.identifierRecall)),
      citationRecall: mean(pos.map((r) => r.citationRecall)),
      negativesCaughtRate: neg.length ? caught / neg.length : null,
    }
  }
  return out
}

/**
 * Every row filed under the failure it actually is — `metrics.js` decides, this
 * only groups. Ids rather than counts: the point of the section is that a reader
 * can go and look at the records, and a count of four is not a lead.
 */
function taxonomyOf(rows) {
  const out = {}
  for (const r of rows) {
    const bucket = classifyRow(r)
    ;(out[bucket] = out[bucket] || []).push(r.id)
  }
  return out
}

function printSummary(s) {
  const line = (k, v) => console.log(`  ${pad(k, 26)} ${v}`)

  console.log('\n── summary ─────────────────────────────────────────────')
  line('positives / negatives', `${s.positives} / ${s.negatives}`)
  line('retrieval F1 (mean)', num(s.retrievalF1))
  line('recall@8 / MRR', `${num(s.recall8)} / ${num(s.mrr)}`)
  line('answer token-F1 (mean)', num(s.answerF1))
  line('identifier recall', pct(s.identifierRecall))
  line('citation precision', pct(s.citationPrecision))
  line('citation recall', pct(s.citationRecall))
  line('support precision', num(s.supportPrecision))
  line('unsupported answers', pct(s.unsupportedAnswerRate))
  line('LANGUAGE MATCH', pct(s.language))
  line('gate over-refusal', `${s.gateOverRefusal}/${s.positives}  UB95 ${num(s.gateOverRefusalUB95)}`)
  line(
    'answer over-refusal',
    `${s.answerOverRefusal}/${s.positives}  UB95 ${num(s.answerOverRefusalUB95)}`,
  )
  line('negatives caught', `${s.negativesCaught}/${s.negatives}  ${pct(s.negativesCaughtRate)}`)
  line('no-answer precision', pct(s.noAnswerPrecision))
  line('hallucinated citations', pct(s.hallucinated))
  line('SCOPE CONTAINMENT', num(s.scopeContainment))
  line('rejected fetches', s.rejectedFetches)
  console.log('  ── cost ──')
  line('PROMPT TOKENS / turn', kchars(s.promptTokens))
  line('output tokens / turn', kchars(s.outputTokens))
  line('tokens / accepted answer', kchars(s.tokensPerAcceptedAnswer))
  if (s.cachedShare != null) line('prompt served from cache', pct(s.cachedShare))
  line('prompt chars / turn', `${kchars(s.promptChars)}  peak ${kchars(s.promptCharsPeak)}`)
  line('observation chars', kchars(s.observationChars))
  line('answer chars', kchars(s.answerChars))
  line('iterations per answer', num(s.iterationsPerAnswer))
  line('requests / turn', num(s.requestsPerTurn))
  line(
    'latency p50 / p95',
    `${((s.latencyP50 || 0) / 1000).toFixed(0)}s / ${((s.latencyP95 || 0) / 1000).toFixed(0)}s`,
  )

  if (s.byLanguage) {
    console.log('  ── by language ──')
    for (const [lang, b] of Object.entries<any>(s.byLanguage)) {
      line(
        `${lang}  (${b.positives}+ / ${b.negatives}-)`,
        `recall8 ${num(b.recall8)}  mrr ${num(b.mrr)}  answerF1 ${num(b.answerF1)}`,
      )
    }
  }
  if (s.byDepth) {
    console.log('  ── by chain depth ──')
    for (const [depth, b] of Object.entries<any>(s.byDepth)) {
      line(
        `depth ${depth}  (${b.positives}+ / ${b.negatives}-)`,
        `recall8 ${num(b.recall8)}  mrr ${num(b.mrr)}  answerF1 ${num(b.answerF1)}`,
      )
    }
  }
  if (s.missPages?.undescribed?.length) {
    console.log('  ── missed pages with no frontmatter description ──')
    for (const p of s.missPages.undescribed) console.log(`  ${p.page}  ${p.records.join(' ')}`)
  }
  if (s.taxonomy) {
    console.log('  ── taxonomy ──')
    for (const [bucket, ids] of Object.entries<any>(s.taxonomy)) {
      if (bucket === 'ok') continue
      line(bucket, `${ids.length}  ${ids.slice(0, 8).join(' ')}`)
    }
  }

  console.log('')
  // Each gate says the threshold it broke, because "0.02 > 0" is a fact and
  // "hallucinated citations" alone is a mood. The ids follow on the misses line.
  if (s.hallucinated) {
    console.log(`  HARD GATE FAILED: hallucinated citations ${num(s.hallucinated)} > 0 — a cited id was not in the evidence`)
  }
  if (s.scopeContainment != null && s.scopeContainment < 1) {
    console.log(`  HARD GATE FAILED: scope containment ${num(s.scopeContainment)} < 1.0 — a chunk outside the record's scope was used`)
  }
  if (s.languageFailures.length) console.log(`  LANGUAGE FAILURES: ${s.languageFailures.join(', ')}`)
  if (s.misses.length) console.log(`  misses: ${s.misses.join(', ')}`)
  console.log('')
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * `--lexical` earns its own filename. Two runs that differ in whether a whole
 * retrieval channel was used are different measurements, and writing them to one
 * path means the diagnostic silently replaces the baseline it was run to be
 * compared against — which is exactly what happened the first time.
 *
 * `-novec` is the second half of that rule, and it is needed because `indexHash`
 * cannot carry it: the hash is sha256 over chunk id and text, so a corpus indexed
 * with vectors and the same corpus indexed `--no-embed` share it exactly. Both
 * runs are `LEXICAL`, so both wanted the same path — and the documented order of
 * operations walks straight into it: measure `--gate-only --lexical` first to see
 * what the embedder is worth, then switch to `embed: false` and measure again. The
 * second run was overwriting the baseline the first one existed to be.
 *
 * `-lvl-<level>` is the same rule for the same reason, with one asymmetry: a run
 * with no `--level` must keep BYTE-IDENTICAL to the name it has always had, or
 * every report on disk stops pairing with its successor and the whole history
 * goes dark on the day levels landed. So `ultra` — which is what "no flag" means
 * — adds no segment, and only a narrowed run is filed apart.
 *
 * `-emb-<hash>` IS THE THIRD HALF OF THE SAME RULE, and it was the one missing.
 *
 * `indexHash` is sha256 over chunk id and text — the CORPUS — and it does not
 * cover the vector space. So a corpus indexed by two embedders produces two
 * indexes, two different retrievals and one filename. This repository ships
 * exactly that pair: `docs/public/rag` and `docs/public/rag-local` are the same
 * corpus at `08e7a87e` under `nvidia/nemotron-3-embed-1b:free` and `bge-m3`.
 * Measured here, the collision is not subtle — the same golden set, the same
 * gate, the same levers: recall@8 0.925 against 0.912, MRR 0.762 against 0.669,
 * negativesCaught 0.125 against 0.438. Each run overwrote the other's baseline
 * and then reported the difference between two embedders as "changes since the
 * previous run", with nothing on the page naming the cause.
 *
 * The name is hashed rather than spelled: a provider-qualified model id carries
 * `/` and `:`, and a report name is a path. `fnv1a32` is the hash the prompt
 * segment already uses.
 *
 * THIS BREAKS PAIRING WITH PRE-1.2.0 REPORTS ONCE, deliberately and visibly —
 * the alternative is keeping a name that pairs two measurements which were never
 * comparable. `previousReport` refuses the cross-embedder pair as well, so the
 * wall is built twice: the filename stops the OVERWRITE, the filter stops the
 * COMPARISON, and neither depends on the other being right.
 */
export const reportName = ({ indexHash, model, vectorlessIndex, level, embedModel }) =>
  `report-${indexHash}-${String(model).replace(/[^\w.-]+/g, '_')}` +
  `${LEXICAL ? '-lexical' : ''}${vectorlessIndex ? '-novec' : ''}` +
  `${embedModel ? `-emb-${fnv1a32(String(embedModel))}` : ''}` +
  `${!level || level === DEFAULT_RUN_LEVEL ? '' : `-lvl-${level}`}` +
  `-${PROMPT_HASH}.json`

/**
 * The tunables actually in force. Two reports built from the same index, prompt
 * and golden set but different constants are different measurements, and without
 * this they would be indistinguishable on disk.
 *
 * It used to REGEX the `tune('NAME', <default>)` literals out of retriever.js's
 * own source and prefer an environment override. That was a hack while the
 * literals were the only layer; now that a lever can also arrive through
 * `manifest.tuning`, the scrape reports a value this run did not use — the report
 * would name the package default while the retriever ranked on the tuned one.
 * `resolveLevers` is the single implementation of the precedence, so the
 * fingerprint is by construction the values the probes were computed with.
 *
 * The keys are SORTED. report.js raises `Levers changed` on a JSON string
 * mismatch, which makes key ORDER load-bearing in a way nothing else here is:
 * reordering `LEVER_NAMES` — a refactor that changes no value anywhere — would
 * otherwise declare every run after it incomparable to every run before it.
 * (Sorting is itself one such reordering, so the first report written after this
 * change flags once against its predecessor. That is the last time.)
 *
 * @param {object|null} tuning  index.manifest.tuning — the corpus's own levers
 */
export function leverFingerprint(tuning = null) {
  const fields = {
    ...resolveLevers(tuning),
    maxIterations: MAX_ITERATIONS ?? 4,
    numCtx: PROVIDER === 'ollama' ? NUM_CTX : null,
  }
  const out = {}
  for (const k of Object.keys(fields).sort()) out[k] = fields[k]
  return out
}

async function main() {
  const index = loadIndex()
  const guard = index.manifest.guard
  EXPECTED_DIMS = index.manifest.dims
  // `manifest.vectors === null` is what a `--no-embed` build writes, and it is the
  // whole of the signal. Converging on `--lexical` here — rather than failing at
  // the first embed call, or worse succeeding and reporting a dense channel that
  // scored nothing — keeps one code path for both routes into this measurement.
  const vectorless = index.manifest.vectors === null
  if (vectorless) LEXICAL = true
  // A project that has not run `init` has no golden set, and the bare ENOENT
  // this used to throw named a path the author never chose and no next step.
  if (!fs.existsSync(GOLDEN)) {
    die(`no golden set at ${path.relative(ROOT, GOLDEN)} — run \`npx docpilot init\` to scaffold one`)
  }
  const golden = fs
    .readFileSync(GOLDEN, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  // Level first, limit second, and the order is the whole point. The level
  // chooses WHICH records this run is about; `--limit` then truncates that
  // choice. Slicing first would take the head of the entire file and keep
  // whichever of those N happened to sit in the tier, so `--level=low --limit=5`
  // would score a handful of records nobody selected and print a pool size that
  // was never the pool.
  const inLevel = filterByLevel(golden, RUN_LEVEL)
  if (!inLevel.length) {
    // The likely cause is named because the filter has no way to distinguish it
    // from an honest empty pool: a set authored before levels existed carries no
    // `level` at all, every record of it reads as `high`, and so `--level=low`
    // on a perfectly good 60-record file selects nothing.
    die(
      golden.length === 0
        ? `no records in ${GOLDEN}.\n` + `        scaffold a golden set:  npx docpilot init`
        : `no records at level ${RUN_LEVEL} — ${GOLDEN} holds ${golden.length}.\n` +
            `        a record with no "level" field runs as "high", so a set that predates\n` +
            `        levels is empty below it and whole at high and above.\n` +
            `        see the tiers:      npx docpilot lint\n` +
            `        run the whole set:  npx docpilot eval`,
    )
  }
  const records = inLevel.slice(0, LIMIT || undefined)

  console.log(
    `\nDocPilot eval — ${records.length} records, ` +
      `${GATE_ONLY ? 'gate only' : `models ${MODELS.join(', ')}`}` +
      `${LEXICAL ? `, LEXICAL ONLY (${vectorless ? 'index has no vectors' : 'no embedder'})` : ''}`,
  )
  // Only for a narrowed run: at `ultra` the pool IS the file and the line would
  // say `60 of 60` on every run anybody has ever done. The counts are the pool
  // against the file, not against `--limit` — the line above already reports how
  // many of them are actually scored.
  if (RUN_LEVEL !== DEFAULT_RUN_LEVEL) {
    console.log(`level ${RUN_LEVEL} — ${inLevel.length} of ${golden.length} records`)
  }
  console.log(
    `guard: mode=${guard.denseMode} tau=${guard.tau} source=${guard.source} ` +
      `cos=[${guard.cosFloor}, ${guard.cosCeil}] index=${index.manifest.hash} ` +
      `chunks=${index.manifest.chunkCount} prompt=${PROMPT_HASH}\n`,
  )

  console.log('  retrieval + gate (shared across the matrix)…')
  const probes = await probeRecords(index, guard, records)

  const runs = []
  for (const model of GATE_ONLY ? ['(gate only)'] : MODELS) {
    let fallback = false
    let thinkSupported = true
    let caps = null

    if (!GATE_ONLY) {
      // The server's capability list first; the behavioural probe only where no
      // such endpoint exists. This is what routes phi4:14b — `completion` only on
      // this build, whatever RAG-SPEC 4.6 says — onto the fallback transport,
      // and what stops `think` being sent to a model that will reject it.
      caps = await detectCapabilities({ provider: PROVIDER, baseURL: BASE, model, apiKey: API_KEY })
      if (caps) {
        fallback = !caps.tools
        thinkSupported = caps.thinking
      } else {
        fallback = !(await detectTools({ provider: PROVIDER, baseURL: BASE, model, apiKey: API_KEY }))
      }
      if (FALLBACK_MODE === 'on') fallback = true
      if (FALLBACK_MODE === 'off') fallback = false

      const reportPath = path.join(
        REPORTS,
        reportName({
          indexHash: index.manifest.hash,
          model,
          vectorlessIndex: vectorless,
          level: RUN_LEVEL,
          embedModel: index.manifest.embedModel,
        }),
      )
      if (RESUME && fs.existsSync(reportPath)) {
        console.log(`\n── ${model} — resumed from ${path.basename(reportPath)}, not re-run`)
        runs.push(JSON.parse(fs.readFileSync(reportPath, 'utf8')))
        continue
      }

      console.log(
        `\n── ${model} — ${fallback ? 'FALLBACK transport (no tool calling)' : 'native tools'}` +
          `, think ${thinkSupported ? 'on' : 'unsupported'}` +
          `${caps?.contextLength ? `, model ctx ${caps.contextLength}` : ''}` +
          `${PROVIDER === 'ollama' ? `, num_ctx pinned to ${NUM_CTX}` : ''} ──`,
      )
    }

    const rows = await runModel({ model, probes, guard, fallback, thinkSupported })
    const s = summarise(rows)
    printSummary(s)

    const meta = {
      model,
      fallback,
      thinkSupported,
      capabilities: caps,
      gateOnly: GATE_ONLY,
      // Written down, not just encoded in the filename. A lexical-only run and a
      // hybrid run measure different systems, which is why they get separate
      // paths — but nothing downstream could TELL them apart, because the flag
      // existed only as a substring of the name.
      lexical: LEXICAL,
      // `lexical` is now true for two different reasons and this is the one that
      // separates them. A diagnostic run has a hybrid twin to be read against;
      // a `--no-embed` index has none and never will, so "what does the embedder
      // buy" is not a question this report is an answer to — it is the report of
      // a deployment that made the choice. Without the key the two are one
      // filename apart and identical inside.
      vectorlessIndex: vectorless,
      provider: PROVIDER,
      indexHash: index.manifest.hash,
      promptHash: PROMPT_HASH,
      chunkCount: index.manifest.chunkCount,
      embedModel: index.manifest.embedModel,
      guard,
      // WHETHER the verdict above ended a row, not what it was scored against —
      // `guard.denseMode`/`guard.tau` describe the THRESHOLD; this describes the
      // deployment's own `enforces()` decision, engine-spec 019. Two reports a
      // tau apart are comparable; two a guardMode apart measure different
      // systems — one where the model decided a probe's fate, one where a
      // scalar did — and report.js's header says so rather than leaving it to
      // be inferred from `refuse:*` counts that silently mean different things.
      guardMode: docPilot.guard.mode,
      records: records.length,
      // Always written, `'ultra'` and all — never omitted for the unfiltered
      // case. report.js partitions the history on `meta.level ?? 'ultra'`, so an
      // absent key is read as the whole set: correct for the reports that
      // predate levels, and a lie the moment a narrowed run leaves it out and
      // gets diffed against a full one.
      level: RUN_LEVEL,
      maxIterations: MAX_ITERATIONS ?? 4,
      numCtx: PROVIDER === 'ollama' ? NUM_CTX : null,
      levers: leverFingerprint(index.manifest.tuning),
      // `historyCondense` and `antecedentHops`: WHICH ARM, so report.js can
      // label a pair of them instead of diffing them. See `abKnobs` above.
      ...abKnobs(),
      ...provenance(),
    }
    writeReport({ dir: REPORTS, name: reportName(meta), meta, summary: s, rows })
    runs.push({ meta, summary: s })
  }

  return runs
}

/**
 * A breached hard gate exits 1 AFTER every model has run and every report has
 * been written.
 *
 * Not `process.exit` at the point of detection: a matrix is several models and
 * the reports are what the failure has to be diagnosed from, so stopping at the
 * first bad row would destroy the evidence for the sake of a faster exit. Every
 * row is measured, every report lands, and the exit code is the last thing that
 * happens.
 */
// `pathToFileURL`, not a template literal, and the same guard build-rag-index.js
// and calibrate.js carry: `bin/docpilot.js` repoints `argv[1]` at this module
// before importing it, so the comparison holds under the launcher, and the unit
// tests can read `reportName` and `leverFingerprint` out of here without a run
// starting underneath them — which, with no index on disk, would exit(1) out of
// the test process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((runs) => {
      const failed = runs.filter((r) => hardGatesFailed(r.summary)).map((r) => r.meta.model)
      if (!failed.length) return
      printError(
        `hard gate breached: ${failed.join(', ')}\n` +
          `        every report was written first — the offending rows are in ` +
          `${path.relative(ROOT, REPORTS)}/`,
      )
      process.exitCode = FAILED
    })
    .catch((e) => {
      printError(e.message || String(e), e)
      process.exit(FAILED)
    })
}
