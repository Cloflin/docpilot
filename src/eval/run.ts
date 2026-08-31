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
import { pathToFileURL } from 'node:url'

import { assembleIndex } from '../theme/docpilot/store.js'
import { embedQuery } from '../theme/docpilot/embed.js'
import { createRetrieval, resolveLevers } from '../theme/docpilot/retriever.js'
import { composeQuery } from '../theme/docpilot/gate.js'
import { detectTools, detectCapabilities } from '../theme/docpilot/llm.js'
import { runTurn } from '../theme/docpilot/harness.js'
import { promptHash } from '../theme/docpilot/prompt.js'
import {
  retrievalF1Loose,
  recallAtK,
  mrr,
  scopeContainment,
  tokenF1,
  identifierRecall,
  languageMatch,
  citationPrecision,
  hallucinatedCitationRate,
  underPath,
  wilsonUpper95,
  mean,
  percentile,
  hardGatesFailed,
} from './metrics.js'
import { writeReport } from './report.js'
import { filterByLevel, parseLevelArg, DEFAULT_RUN_LEVEL } from './levels.js'
import { nodeEmbedTarget } from '../config.js'

import { ROOT, RAG, REPORTS, GOLDEN, settings as docPilot, fileEnv } from '../cli-context.js'

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
for (const [k, v] of Object.entries(await fileEnv())) {
  if (process.env[k] === undefined) process.env[k] = v
}

const arg = (name: string, dflt?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

/**
 * Declared here, above the flags, and not in the `main` section below with the
 * rest of the output helpers: `--level=` is validated at module scope, and a
 * `const` declared further down is in its temporal dead zone there — a mistyped
 * tier would print a ReferenceError instead of the six legal ones.
 */
const die = (m) => {
  console.error(`\n  FAIL  ${m}\n`)
  process.exit(1)
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
export const VALUE_FLAGS = {
  level: 'low',
  limit: '5',
  model: 'qwen3:8b',
  models: 'qwen3:8b,phi4:14b',
  provider: 'ollama',
  fallback: 'auto',
  'max-iterations': '2',
  'num-ctx': '8192',
}

/** The first value-taking flag in `argv` written without its `=`, or null. */
export function bareValueFlag(argv, flags = VALUE_FLAGS) {
  // Exact match: `--level` alone. `--level=low` and `--levels` both start with
  // the name and neither is the mistake being caught here.
  return Object.keys(flags).find((name) => argv.includes(`--${name}`)) ?? null
}

const BARE = bareValueFlag(process.argv)
if (BARE) die(`--${BARE} takes a value: --${BARE}=${VALUE_FLAGS[BARE]}`)

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
 * thought they ran. The `[docpilot] ` prefix comes off because `die` frames the
 * line itself.
 */
let RUN_LEVEL = DEFAULT_RUN_LEVEL
try {
  RUN_LEVEL = parseLevelArg(arg('level'))
} catch (e) {
  die(e.message.replace(/^\[docpilot\] /, ''))
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

async function embed(text, model) {
  const vec = await embedQuery(text, {
    provider: EMBED_PROVIDER,
    baseURL: EMBED_BASE,
    model,
    apiKey: EMBED_KEY,
  })
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

    // A follow-up record's first turn is a real turn: the composed channel only
    // exists when there is a previous question to compose with. The string is
    // built by `composeQuery` rather than inlined, so the vector embedded here
    // and the query `evaluate()` composes internally can never drift apart.
    const composedQuery = composeQuery(rec.question, rec.prev_question)
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
      previousQuestion: rec.prev_question,
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
    const goldInScope =
      scope.kind === 'all' || !scope.paths.length
        ? rec.gold_chunks
        : rec.gold_chunks.filter((gc) => scope.paths.some((p) => underPath(`/${gc}`, p)))
    const scoredAsNegative = rec.gold_chunks.length > 0 && goldInScope.length === 0

    probes.push({
      rec,
      scope,
      retrieval,
      vec,
      composedVec,
      g,
      retrievedIds,
      scoredAsNegative,
      retrieval_f1: goldInScope.length ? retrievalF1Loose(retrievedIds, goldInScope) : null,
      recall8: goldInScope.length ? recallAtK(rankedIds, goldInScope, 8) : null,
      mrr: goldInScope.length ? mrr(rankedIds, goldInScope) : null,
      scopeContainment: scopeContainment(retrievedIds, scope),
    })
  }
  return probes
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
      followUp: Boolean(rec.prev_question),
      G: g.G,
      D: g.D,
      L: g.L,
      channel: g.channel,
      gatePass: g.pass,
      retrievedIds: probe.retrievedIds,
      retrieval: probe.retrieval_f1,
      recall8: probe.recall8,
      mrr: probe.mrr,
      scopeContainment: probe.scopeContainment,
      scoredAsNegative: probe.scoredAsNegative,
    }

    if (!g.pass) {
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

    // A follow-up record is two turns. The first turn's answer becomes history,
    // which is the only way §4.5's three-pair window is exercised at all.
    const history = []
    if (rec.prev_question) {
      // Guarded like the scored turn below. Unguarded, one transport hiccup on a
      // priming turn threw out of the loop and into `main().catch → die`, taking
      // every row already run with it — the report is only written after the
      // whole model finishes, so a matrix that had been running for an hour left
      // nothing behind.
      let first
      try {
        first = await turn({
          probe,
          model,
          fallback,
          thinkSupported,
          guard,
          question: rec.prev_question,
          history: [],
        })
      } catch (e) {
        row.observed = 'error'
        row.error = `priming turn: ${String(e.message || e)}`
        row.latencyMs = 0
        rows.push(row)
        report(row)
        continue
      }
      if (first?.text?.trim()) history.push({ question: rec.prev_question, answer: first.text })
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
    row.hallucinated = hallucinatedCitationRate(res.citations, res.emitted)
    row.emittedContainment = scopeContainment(res.emitted, probe.scope)

    const answered = res.text.trim() && res.citations.length && res.confidence >= 0.4
    row.observed = answered ? 'answer' : 'refuse:not-answerable'

    if (answered && !wantRefusal) {
      row.answerF1 = tokenF1(res.text, rec.gold_answer)
      row.identifierRecall = identifierRecall(res.text, rec.identifiers)
      row.language = languageMatch(rec.question, res.text)
      row.citationPrecision = citationPrecision(res.citations, rec.gold_chunks)
    }
    row.text = res.text
    rows.push(row)
    report(row)
  }

  return rows
}

function turn({ probe, model, fallback, thinkSupported, guard, question, history }) {
  return runTurn({
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
        temperature: 0.2,
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
    queryVec: probe.vec,
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
  }
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
  line('prompt chars / turn', `${kchars(s.promptChars)}  peak ${kchars(s.promptCharsPeak)}`)
  line('observation chars', kchars(s.observationChars))
  line('answer chars', kchars(s.answerChars))
  line('iterations per answer', num(s.iterationsPerAnswer))
  line('requests / turn', num(s.requestsPerTurn))
  line(
    'latency p50 / p95',
    `${((s.latencyP50 || 0) / 1000).toFixed(0)}s / ${((s.latencyP95 || 0) / 1000).toFixed(0)}s`,
  )

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
 */
export const reportName = ({ indexHash, model, vectorlessIndex, level }) =>
  `report-${indexHash}-${String(model).replace(/[^\w.-]+/g, '_')}` +
  `${LEXICAL ? '-lexical' : ''}${vectorlessIndex ? '-novec' : ''}` +
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
      console.error(
        `  FAIL  hard gate breached: ${failed.join(', ')}\n` +
          `        every report was written first — the offending rows are in ` +
          `${path.relative(ROOT, REPORTS)}/\n`,
      )
      process.exitCode = 1
    })
    .catch((e) => die(e.stack || e.message))
}
