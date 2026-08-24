#!/usr/bin/env node
/**
 * DocPilot index builder — RAG-SPEC 2.
 *
 *   npx docpilot index             build the index into `${indexDir}` (docs/public/rag by default)
 *   npx docpilot index --dry       chunk and report, no embeddings, no Ollama
 *   npx docpilot index --no-embed  build a lexical-only index — no vectors, BM25 retrieval
 *
 * Idempotent: identical input produces byte-identical output, which is why no
 * timestamp appears in any artefact and the version is a content hash.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'


import { chunkMarkdown } from './lib/chunker.js'
import { chunkOpenapi } from './lib/openapi-chunker.js'
import { resolveSections, orphanPages, tailFor } from './lib/sections.js'
import { parseAllowlist, checkSource } from './lib/sources.js'
import { providerFor } from '../theme/docpilot/providers.js'
import { routeOf } from '../theme/docpilot/route.js'
import { LEVER_NAMES } from '../theme/docpilot/retriever.js'
import { nodeEmbedTarget, noEmbed } from '../config.js'
import {
  settings as docPilot,
  ROOT,
  DOCS,
  RAG as OUT,
  CALIBRATION_OUT,
  TUNING_OUT,
  CONFIG,
  fileEnv,
} from '../cli-context.js'
import { l2normalise, toInt8, quantisationError } from './lib/quantize.js'
import { terms, estTokens } from '../theme/docpilot/text.js'


const SHARD_SIZE = 250
const DF_TERMS = 4000
const MANIFEST_MAX_BYTES = 64 * 1024
const WARN_BYTES = 3 * 1024 * 1024
const FAIL_BYTES = 5 * 1024 * 1024

const DRY = process.argv.includes('--dry')
/**
 * A lexical-only index: no embedder, no vectors, BM25 alone.
 *
 * Two spellings, because they answer different questions. `embed: false` in the
 * config is the site's standing decision and needs no flag. `--no-embed` is a
 * one-off, so it has to work on a config that still names an embedder — which
 * is why it is read here, ahead of the resolution below, and applied by turning
 * the setting off rather than by branching around `nodeEmbedTarget`. What a
 * no-embed target looks like is then stated in exactly one place, config.js,
 * instead of a second copy here that drifts from it.
 */
const NO_EMBED = process.argv.includes('--no-embed') || noEmbed(docPilot)
/**
 * The embedder is declared ONCE, as `docPilot.embed` in docs/.vitepress/config.mjs,
 * and read here rather than restated: the index and the runtime must agree, and
 * the runtime only compares vector WIDTH, so a second copy of this decision is a
 * copy that drifts and takes retrieval down to lexical-only with nothing logged.
 * Changing embedder is one edit there, then `npx docpilot index`. Keys still come
 * from .env.local; nothing is stored.
 */
const EMBED = nodeEmbedTarget(NO_EMBED ? { ...docPilot, embed: false } : docPilot, {
  ...(await fileEnv()),
  ...process.env,
})
const EMBED_URL = EMBED.baseURL
/**
 * NOT a constant when the embedder is a pool.
 *
 * `embed: 'auto'` on a provider whose free tier is shared — OpenRouter's — names
 * no model, and the one that ends up in the manifest is whichever member of the
 * pool answered when this ran. That is the honest record: the index IS bound to
 * the model that built it, and pretending the choice was made in the config file
 * would put a second, wrong answer where the browser reads the first.
 */
let EMBED_MODEL = EMBED.model
const EMBED_POOL = EMBED.models || []
const EMBED_KEY = EMBED.apiKey
// The ADAPTER, not the brand: `nodeEmbedTarget` returns 'openai' for every
// service that copied the OpenAI API, and the two things this name decides —
// the response shape and the `ollama serve` hint — are adapter-level, not
// brand-level. Same value `providerFor` is keyed on, one line below.
const EMBED_PROVIDER = EMBED.provider
const embedder = providerFor(EMBED.provider)

const EXCLUDE = new Set(['/index', '/new-file'])

const warn = (m) => console.warn(`  warn  ${m}`)
const die = (m) => {
  console.error(`\n  FAIL  ${m}\n`)
  process.exit(1)
}

// A provider the adapters cannot reach without the `/ai` rewrite in front of
// them — Gemini today. Said here rather than discovered as a 404 on chunk 1.
// A lexical-only build has no endpoint to reach BY DESIGN, so the same null
// baseURL means the opposite thing and must not stop it.
if (!DRY && !NO_EMBED && !EMBED_URL) {
  die(
    `docPilot.embed.provider is "${EMBED.id}", which this script cannot call directly.\n` +
      `        Build the index with ollama or openai and switch back afterwards.`,
  )
}

function walkMarkdown(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.vitepress' && entry.name !== 'public') walkMarkdown(p, acc)
    } else if (entry.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

/**
 * The route a page is published at.
 *
 * The mapping itself lives in `route.js` and is shared with the panel, which has
 * to name the SAME route for the current page or the *this page* scope matches
 * nothing. This function is now only the part that is genuinely the builder's:
 * turning an absolute path into one relative to `docsDir`.
 */
function routeFor(file) {
  return routeOf(path.relative(DOCS, file))
}

/**
 * Imported pages — RAG corpus only, no page on the site.
 *
 * They live OUTSIDE `docsDir` on purpose: VitePress never sees them, so no route
 * is built, nothing enters the sidebar, the sitemap or llms.txt, and the mirror
 * cannot compete with the original in search. What they get instead is a
 * mandatory `source:`, which is the only place their citation can point.
 */
const KB = docPilot.importDir ? path.resolve(ROOT, docPilot.importDir) : null

/**
 * The id of an EXTERNAL page — one that lives under `importDir` and has no route
 * on this site at all.
 *
 * It looks like a route and is not one. Everything downstream keys a page by
 * `path` — `sourceRow`, `closest`, the citation validator, the golden set — so
 * an external page needs a value in that slot, and it needs to be one no real
 * route can collide with. Derived from the directory name rather than fixed, and
 * checked against the indexed routes below rather than assumed to be free.
 */
const EXTERNAL_PREFIX = KB ? `/${path.basename(KB)}` : null

function externalIdFor(file) {
  const rel = path.relative(KB, file).replace(/\\/g, '/').replace(/\.md$/, '')
  return `${EXTERNAL_PREFIX}/${rel}`
}

function kindFor(route) {
  if (route.startsWith('/reference/')) return 'reference'
  if (route.startsWith('/extensions')) return 'extensions'
  return 'guide'
}

/**
 * A batch response, in REQUEST order.
 *
 * `data[].index` is the position in the request, and the OpenAI embeddings
 * contract does not promise the array comes back in it. Reading it positionally
 * is a silent corruption waiting for the first provider that batches
 * concurrently: every chunk keeps its text and gets somebody else's vector, the
 * build succeeds, every size is right, and retrieval is nonsense with nothing
 * anywhere to point at. Sorted when the field is present; left alone when it is
 * not, which is Ollama's bare array.
 */
export function embeddingsOf(json, isOllama) {
  if (isOllama) return json?.embeddings
  const rows = Array.isArray(json?.data) ? [...json.data] : []
  return rows.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map((d) => d?.embedding)
}

/** One batch, one model, no dying — the caller decides what a failure means. */
async function embedBatch(model, texts) {
  // The search_document:/search_query: prefixes are a nomic-embed-text
  // requirement, not a general one. bge-m3 and the e5 family are trained
  // without them and applying one measurably degrades the vector.
  const prefix = /nomic/i.test(model) ? 'search_document: ' : ''
  const batch = texts.map((t) => `${prefix}${t}`)
  let res
  try {
    res = await fetch(embedder.embedUrl(EMBED_URL), {
      method: 'POST',
      headers: embedder.headers(EMBED_KEY),
      body: JSON.stringify(embedder.embedBody(model, batch)),
    })
  } catch (e) {
    // No status: the host is unreachable. Another model is served from the same
    // host, so this is fatal however many are left in the pool.
    return { fatal: `embed endpoint unreachable at ${EMBED_URL} — ${e.message}` }
  }
  if (!res.ok) {
    const after = Number(res.headers.get('retry-after'))
    return {
      error: `HTTP ${res.status}`,
      status: res.status,
      retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : null,
    }
  }
  const json = await res.json().catch(() => null)
  const vectors = embeddingsOf(json, EMBED_PROVIDER === 'ollama')
  if (!vectors?.length) return { error: 'the response carried no vectors' }
  if (vectors.some((v) => !v?.length)) return { error: 'the response carried an empty vector' }
  return { vectors }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A batch, with the wait a shared free tier asks for.
 *
 * 429 is the pool's normal weather, not a fault: it says somebody else is
 * embedding right now. `retry-after` is the server's own estimate of when it
 * will not be, and it is a better number than any backoff curve — but three
 * waits is the ceiling, past which the model is treated as gone and the pool
 * moves on.
 */
async function embedBatchWithWaits(model, texts) {
  for (let attempt = 1; ; attempt++) {
    const out = await embedBatch(model, texts)
    if (out.vectors || out.fatal) return out
    const retryable = out.status === 429 || out.status === 503 || out.status >= 500
    if (!retryable || attempt >= 3) return out
    await sleep(Math.min(out.retryAfterMs ?? 1000 * 2 ** (attempt - 1), 20000))
  }
}

/**
 * The pool policy, with the transport handed in — RAG-SPEC 2.4.
 *
 * Separated from the fetch beneath it for one reason: the interesting behaviour
 * here is what happens when an embedder stops answering HALFWAY, and a rule that
 * can only be exercised by waiting for a free tier to saturate is a rule nobody
 * re-checks. Everything that decides — choose, restart, give up — takes its
 * failures from a function it was given.
 *
 * `fail` throws or exits; it never returns. The build's own `die` is what the
 * caller below passes.
 */
export function createEmbedder({
  model,
  pool = [],
  batch,
  fail,
  batchSize = 32,
  onChoose = () => {},
  onSkip = () => {},
  onRestart = () => {},
  onProgress = () => {},
}) {
  let chosen = model || null
  const tried = new Set()

  /**
   * The embedder, chosen — once, and out loud.
   *
   * With a model named this is a no-op. With a POOL it is the moment the index
   * acquires the identity it will be queried under, so the caller is told: a
   * build log that says which free embedder answered is the only place that fact
   * exists before the manifest does.
   */
  async function choose() {
    if (chosen) return chosen
    if (!pool.length) fail('embed.model is not set and this provider has no free pool')
    const refused = []
    for (const candidate of pool) {
      // Recorded BEFORE the verdict. A candidate that failed its probe is a
      // candidate that has been tried, and `all()` picks its restart from the
      // same set — without this, an embedder that refused at the start of the
      // build was the first one reached for when the winner died halfway
      // through it.
      tried.add(candidate)
      const out = await batch(candidate, ['docpilot embedder probe'])
      if (out.fatal) fail(out.fatal)
      if (out.vectors) {
        chosen = candidate
        onChoose(candidate, out.vectors[0].length, pool.length)
        return chosen
      }
      refused.push(`${candidate} — ${out.error}`)
      onSkip(candidate, out.error)
    }
    fail(
      `no free embedder answered. Tried ${pool.length}:\n        ` +
        refused.join('\n        ') +
        '\n        Name one explicitly with embed: {provider: …, model: …} if this persists.',
    )
  }

  /**
   * Every chunk, embedded by ONE model.
   *
   * The restart is the part worth reading. If the chosen embedder dies partway
   * through, the vectors already collected are thrown away rather than topped up
   * by its replacement: half an index in one vector space and half in another
   * scores every query against a coin flip, and nothing downstream — not the
   * width check in the retriever, not the calibrated gate — can see that it
   * happened. Re-embedding a corpus is cheap; an index that is quietly half
   * wrong is not.
   */
  async function all(texts) {
    await choose()
    for (;;) {
      tried.add(chosen)
      const vectors = []
      let failure = null
      for (let i = 0; i < texts.length; i += batchSize) {
        const out = await batch(chosen, texts.slice(i, i + batchSize))
        if (out.fatal) fail(out.fatal)
        if (!out.vectors) {
          failure = out
          break
        }
        for (const v of out.vectors) vectors.push(l2normalise(v))
        onProgress(Math.min(i + batchSize, texts.length), texts.length)
      }
      if (!failure) return { model: chosen, vectors }

      const next = pool.find((m) => !tried.has(m))
      if (!next) {
        fail(
          `embed endpoint returned ${failure.error} — model "${chosen}"` +
            (pool.length > 1 ? '\n        every model in the free pool has been tried' : ''),
        )
      }
      onRestart(chosen, next, failure.error)
      chosen = next
    }
  }

  return { all, choose, chosen: () => chosen }
}

async function embedAll(texts) {
  const run = createEmbedder({
    model: EMBED_MODEL,
    pool: EMBED_POOL,
    batch: embedBatchWithWaits,
    fail: (m) => die(m),
    onChoose: (model, dims, size) =>
      console.log(`  embedder  ${model} · ${dims}d — chosen from ${size} free model(s)`),
    onSkip: (model, why) => warn(`${model} is not answering (${why}); trying the next free embedder`),
    onRestart: (from, to, why) => {
      process.stdout.write('\n')
      warn(
        `"${from}" stopped answering mid-pass (${why}) — restarting on "${to}". ` +
          'Vectors already collected are discarded: one index, one vector space.',
      )
    },
    onProgress: (done, total) => process.stdout.write(`\r  embedding ${done}/${total}`),
  })
  const out = await run.all(texts)
  // The manifest, the guard and the nomic prefix all read this, and until now it
  // was a guess made in the config file rather than the answer the pool gave.
  EMBED_MODEL = out.model
  process.stdout.write('\n')
  return out.vectors
}

/**
 * The guard the manifest ships — RAG-SPEC 5.6.
 *
 * `tau`, `tauLexical`, `wDense` and `wLexical` are set ONLY by `docpilot calibrate`
 * (RAG-SPEC 7). This function does not choose them; it decides whether the
 * measured ones still apply to the index being built, and says so out loud.
 *
 * A calibration is bound to the corpus it was measured on. If `calibratedAt`
 * does not match this build's hash, the corpus moved underneath it and the
 * numbers describe a different index. RAG-SPEC 5.6 is explicit about what
 * happens then: the build **warns and inlines the provisional values; it never
 * fails the build.** Documentation must stay publishable when a threshold is
 * stale — a broken deploy is a worse outcome than a conservative gate.
 */
export function guardFor(hash, opts = {}) {
  // `in`, not `??`: null is a VALUE in this slot — it is what a no-embed build
  // resolves to, and the whole of how the branches below know they are on one —
  // and `??` would read it as "not supplied" and substitute the module's.
  const embedModel = 'embedModel' in opts ? opts.embedModel : EMBED_MODEL
  /**
   * The file `docpilot calibrate` actually writes — resolved from the same
   * `evalDir` setting rather than restated here as a literal.
   *
   * This used to read `ROOT/eval/calibration.json`, a path nothing has written
   * since the CLI grew `evalDir` (default `docpilot/`). The failure was silent in
   * the worst way available: `calibrate` succeeded, wrote its thresholds, and
   * every subsequent `index` reported "no calibration" and inlined the
   * provisional guard anyway. One name, one place.
   */
  const file = opts.file ?? CALIBRATION_OUT
  const shown = path.relative(ROOT, file)
  const log = opts.warn ?? warn
  const note = opts.note ?? ((m) => console.log(`  ${m}`))

  const provisional = {
    tau: 0.3,
    tauLexical: 0.3,
    wDense: 0.75,
    wLexical: 0.25,
    // The dense channel reads the ABSOLUTE cosine of the best in-scope chunk,
    // not the z-score of its separation from the corpus median. Measured on
    // this corpus with bge-m3: z-score gave 15% over-refusal for 42% of
    // off-topic questions caught; cosine gives 0% for 67%. `zscore` remains
    // available for anisotropic embedders where the absolute value is
    // meaningless — nomic-embed-text is one.
    denseMode: /nomic/i.test(embedModel) ? 'zscore' : 'cosine',
    // D = 0 at cosFloor, 1 at cosCeil. With tau 0.30 and wDense 0.75, a query
    // with no lexical overlap must reach cosine 0.52 to pass.
    cosFloor: 0.44,
    cosCeil: 0.64,
    source: 'provisional',
    calibratedAt: null,
    zexp: null,
    zexpSource: 'closed-form',
    overRefusalUB95: null,
    gatePrecision: null,
  }

  const stale = (why) => {
    log(`${why} — inlining the provisional guard (tau ${provisional.tau}, source "provisional").`)
    log(`      run \`npx docpilot calibrate\` to measure thresholds for this index.`)
    return provisional
  }

  if (!fs.existsSync(file)) return stale(`no ${shown}`)

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return stale(`${shown} is unreadable (${e.message})`)
  }
  const g = doc?.guard
  /**
   * A vectorless index is calibrated on ONE threshold, and the file says so.
   *
   * `docpilot calibrate` measures `tauLexical` there and writes `tau: null`
   * rather than a number nothing measured. Requiring both to be numbers threw
   * the whole document away — including the `tauLexical` the run existed to
   * find — so the provisional 0.3 was re-inlined on every rebuild, over the one
   * threshold a lexical-only gate consults, and the warning told the operator to
   * run the command they had just run.
   *
   * `doc.lexicalOnly`, not the null alone: a HYBRID run writes the same null
   * when no threshold in its grid is feasible, and that is a broken score
   * function to fix rather than a measurement that is finished.
   */
  const lexicalDoc = doc?.lexicalOnly === true && g?.tau === null
  if (!g || (typeof g.tau !== 'number' && !lexicalDoc) || typeof g.tauLexical !== 'number') {
    return stale(`${shown} carries no usable guard`)
  }
  // The other half of the pairing: half a guard measured with no dense channel
  // describes nothing this build's dense channel does, and `cosFloor`, `cosCeil`
  // and `zexp` would come back untouched from a run that never scored a cosine.
  if (lexicalDoc && embedModel != null) {
    return stale(
      `${shown} was measured on an index with no vectors, this build embeds ` +
        `with "${embedModel}" — it carries no hybrid threshold`,
    )
  }
  if (g.calibratedAt !== hash) {
    return stale(`${shown} is for index ${g.calibratedAt}, this build is ${hash}`)
  }
  // The thresholds are bound to the pair (corpus, embedder), and the hash above
  // covers only the corpus — it is sha256 over chunk text and moves for no other
  // reason. Swap the embed model and every cosine moves while the hash does not,
  // so without this line a calibration measured on bge-m3 inlines itself onto an
  // OpenAI index in silence. That is not hypothetical: it is what shipped.
  if (doc.embedModel && doc.embedModel !== embedModel) {
    return stale(
      `${shown} was measured with "${doc.embedModel}", this build embeds ` +
        `with "${embedModel}" — a cosine threshold does not survive an embedder swap`,
    )
  }
  // A cosine threshold measured against a z-score channel is not the same
  // number. The embed model decides the mode, so a swap invalidates the run even
  // when the chunk hash happens to survive it.
  if (g.denseMode !== provisional.denseMode) {
    return stale(
      `${shown} was measured in denseMode "${g.denseMode}", this build is ` +
        `"${provisional.denseMode}" (${embedModel})`,
    )
  }
  /**
   * The hybrid threshold a vectorless index ships is the provisional one.
   *
   * Nothing on this index reads it — `verdict()` scores `G = L` against
   * `tauLexical` on every turn — but `assertWeights` runs at every retriever
   * init and rejects a guard whose `wLexical` is not below `tau`, so a null in
   * that slot is a panel that cannot open. `source` is what stops the number
   * being read as measured: `calibrated-reduced-lexical` names which half was.
   */
  const tau = lexicalDoc ? provisional.tau : g.tau
  // RAG-SPEC 3.4.4, asserted here as well as in gate.js: a guard that fails it
  // throws at runtime, and a build that inlines it ships a panel that cannot open.
  if (!(g.wLexical < tau)) {
    return stale(
      `${shown} has wLexical ${g.wLexical} >= tau ${tau}, which gate.js rejects at init`,
    )
  }

  note(
    `guard: calibrated ${g.calibratedAt}, tau ${tau}${lexicalDoc ? ' (provisional — a vectorless index has no hybrid threshold to measure)' : ''}, ` +
      `tauLexical ${g.tauLexical}, source "${g.source}"` +
      (doc.probeCount ? ` (${doc.probeCount} probes: ${JSON.stringify(doc.byStratum)})` : ''),
  )
  return {
    tau,
    tauLexical: g.tauLexical,
    wDense: g.wDense,
    wLexical: g.wLexical,
    denseMode: g.denseMode,
    cosFloor: g.cosFloor,
    cosCeil: g.cosCeil,
    // Stamped from the file, not hard-coded: `calibrated-reduced` is what a
    // below-spec probe set earns, and RAG-SPEC 5.6 forbids presenting a
    // provisional or partial threshold as a fully measured one.
    source: g.source,
    calibratedAt: g.calibratedAt,
    zexp: g.zexp?.length ? g.zexp : null,
    zexpSource: g.zexp?.length ? g.zexpSource : 'closed-form',
    overRefusalUB95: g.overRefusalUB95 ?? null,
    gatePrecision: g.gatePrecision ?? null,
  }
}

/**
 * The levers `tuningFor` will inline — deliberately NARROWER than `LEVER_NAMES`.
 *
 * `LEVER_NAMES` is the complete set `resolveLevers` resolves and `DOCPILOT_*` can
 * reach. This is the set allowed to travel through a committed file into a shipped
 * bundle, and the two are not the same question. `buildTuningDoc` in eval/tune.js
 * writes exactly these two names and says why: a key in `tuning.json` is a CLAIM
 * that the number was measured on this corpus, and the sweep measures nothing else.
 *
 * The gap between the two sets was a hole, not an oversight to tidy. `CANDIDATES`
 * sizes the lexical candidate list and `evaluate()` reads the gate's lexical
 * evidence off `lexIds.slice(0, 3)`, so a hand-edited `CANDIDATES: 1` flipped an
 * answerable question from pass to refuse — no threshold touched, no model called,
 * and no warning printed, because the eight-name allowlist waved it through. A
 * refusal verdict is `calibrate`'s to move; anything that can move one has to hit
 * a wall here. Keep this list in step with `buildTuningDoc`: what the sweep cannot
 * measure must not be inlinable, whatever else it does.
 */
const MEASURED_LEVER_NAMES = ['MMR_LAMBDA', 'GATE_K']

/**
 * The retrieval levers the manifest ships — the delivery half of `docpilot tune`.
 *
 * Read `guardFor` above first: this is the same shape, deliberately, because the
 * two answer the same question about different numbers. It differs in exactly
 * three ways, and each one is a decision:
 *
 * 1. A MISSING FILE IS SILENT. The guard is mandatory — every turn scores against
 *    a threshold, so a missing calibration has to say so. Tuning is optional: the
 *    literals in retriever.js are measured values, not placeholders, and a site
 *    that never runs `tune` is not misconfigured. Warning it on every build would
 *    train the operator to ignore the warn column, which is where the stale-hash
 *    line has to be read.
 * 2. FAILURE RETURNS null, not a provisional object. There is nothing to inline:
 *    `resolveLevers(null)` in the browser resolves every name to the module
 *    literal, which is the same value this build shipped before tuning existed.
 * 3. THE KEYS ARE AN ALLOWLIST, not a spread — and it is `MEASURED_LEVER_NAMES`,
 *    not `LEVER_NAMES`. `tuning.json` is a file a consumer commits and may
 *    hand-edit, and it rides into the manifest that the guard also rides in. Only
 *    what `docpilot tune` measured may cross: a `tau` in there is dropped loudly
 *    because "levers are tune's, thresholds are calibrate's" (RAG-SPEC 7) is worth
 *    a wall rather than a convention, and a `CANDIDATES` is dropped just as loudly
 *    because it reaches the same refusal verdict by a road that never names a
 *    threshold. `resolveLevers` is the second wall.
 */
export function tuningFor(hash, opts = {}) {
  // `in`, not `??`, for the same reason as guardFor: null is the VALUE a
  // no-embed build resolves to, and the equality below has to be able to see it.
  const embedModel = 'embedModel' in opts ? opts.embedModel : EMBED_MODEL
  const file = opts.file ?? TUNING_OUT
  const shown = path.relative(ROOT, file)
  const log = opts.warn ?? warn
  const note = opts.note ?? ((m) => console.log(`  ${m}`))

  const drop = (why) => {
    log(`${why} — shipping the default levers.`)
    log(`      run \`npx docpilot tune\` to measure them for this index.`)
    return null
  }

  if (!fs.existsSync(file)) return null

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return drop(`${shown} is unreadable (${e.message})`)
  }
  if (doc?.version !== 1) return drop(`${shown} is version ${doc?.version}, this build reads version 1`)
  if (doc.tunedAt !== hash) {
    return drop(`${shown} is for index ${doc.tunedAt}, this build is ${hash}`)
  }
  /**
   * MMR_LAMBDA is cosine geometry: it weighs relevance against similarity in the
   * embedder's own vector space, and a lambda measured on bge-m3 describes
   * nothing about where text-embedding-3-small puts its cosines. The chunk hash
   * above cannot catch this — it is sha256 over chunk TEXT and an embedder swap
   * leaves it identical, which is exactly the hole a calibration fell through
   * before `guardFor` grew the same line.
   *
   * Strict `!==` over `??`-style tolerance: `docpilot tune` on a vectorless index
   * writes `embedModel: null`, and that must fail against every embedder while
   * still matching the vectorless build it was measured on.
   */
  if (doc.embedModel !== embedModel) {
    return drop(
      `${shown} was tuned with "${doc.embedModel}", this build embeds with ` +
        `"${embedModel}" — a swept lambda does not survive an embedder swap`,
    )
  }

  const src = doc.levers ?? {}
  const levers = {}
  for (const [key, value] of Object.entries(src)) {
    if (!MEASURED_LEVER_NAMES.includes(key)) {
      // Three different mistakes, told apart rather than lumped in with typos,
      // because each says something different about how the file got this way and
      // only one of them is a spelling error.
      let why
      if (['tau', 'tauLexical', 'wDense', 'wLexical'].includes(key)) {
        // The guard's four. A file carrying one is either hand-edited or written
        // by something that does not know the rule; either way the operator hears it.
        why =
          `carries a guard threshold (${key}) — dropped. ` +
          'Thresholds are set by `npx docpilot calibrate` and by nothing else.'
      } else if (LEVER_NAMES.includes(key)) {
        // A real lever the sweep never sweeps. It resolves fine at runtime, which
        // is exactly why it needs saying: the value looks measured because it sits
        // in a file `tune` wrote, and `CANDIDATES` alone can turn an answerable
        // question into a refusal without any threshold moving.
        why =
          `carries an unmeasured lever (${key}) — dropped. ` +
          `\`npx docpilot tune\` sweeps ${MEASURED_LEVER_NAMES.join(' and ')} and nothing else, ` +
          'so a value here was never measured on this corpus.'
      } else {
        why = `carries an unknown lever "${key}" — dropped.`
      }
      log(`${shown} ${why}`)
      continue
    }
    // A non-number reaches `resolveLevers` intact — `tuning?.[name] ?? FALLBACK`
    // only rejects null and undefined — and then poisons every comparison it
    // touches as NaN. Cheaper to refuse it here, where there is somebody to tell.
    if (!Number.isFinite(value)) {
      log(`${shown} has ${key} ${JSON.stringify(value)}, which is not a number — dropped.`)
      continue
    }
    levers[key] = value
  }
  const names = Object.keys(levers)
  // Nothing survived, so `source: 'tuned'` would be a claim about an empty
  // object: the browser would resolve every literal anyway while the manifest
  // said the corpus had been measured.
  if (!names.length) return drop(`${shown} carries no usable lever`)

  note(
    `tuning: ${names.map((n) => `${n} ${levers[n]}`).join(', ')} — tuned ${doc.tunedAt}` +
      (doc.level ? ` on level ${doc.level}` : '') +
      (doc.records ? ` (${doc.records} records)` : ''),
  )
  return { ...levers, source: 'tuned', tunedAt: doc.tunedAt }
}

async function main() {
  console.log(`\nDocPilot index${DRY ? ' (dry run — no embeddings)' : ''}\n`)

  // ── sidebar ────────────────────────────────────────────────────────────────
  // `?? {}` because the DEFAULT export is optional: the settings come from the
  // named `docPilot` export, and a project whose site is not VitePress — a config
  // file that exports the settings and nothing else — has no VitePress config to
  // default-export. Without it that project died here on a TypeError naming
  // `themeConfig`, which says nothing about what is actually missing.
  //
  // No sidebar means no section grouping: every chunk keeps its page and its
  // headings, and only the "which part of the docs is this" label goes.
  const configUrl = pathToFileURL(CONFIG).href
  const config = (await import(configUrl)).default ?? {}
  const sidebar = config.themeConfig?.sidebar || {}

  // ── markdown ───────────────────────────────────────────────────────────────
  // The allowlist is declared beside every other DocPilot decision and read here,
  // not restated: a second copy is a copy that drifts, and this one decides what
  // may become an `href` in the answer panel.
  const { entries: allowedOrigins, errors: allowErrors } = parseAllowlist(docPilot.sources)
  if (allowErrors.length) die(allowErrors.join('\n        '))

  const files = walkMarkdown(DOCS)
  const chunks = []
  const pages = new Map()
  let rawBytes = 0
  let imported = 0

  // A declared `source` fails the BUILD rather than being dropped with a
  // warning. Dropping it silently indexes imported text with no provenance, and
  // for an external page it would leave a citation with nowhere to point.
  const originFor = (source, id) => {
    const checked = checkSource(source, allowedOrigins)
    if (checked.error) {
      die(
        `${id}: ${checked.error}\n` +
          `        Add the origin to docPilot.sources.allow, or drop the frontmatter source.`,
      )
    }
    imported++
    return checked.href
  }

  /**
   * Which `/reference/` routes an OpenAPI spec is about to claim.
   *
   * Discovered here rather than in the openapi block below, which runs after this
   * loop, because the markdown pass needs the answer before it decides what to
   * skip. The skip used to be the whole PREFIX — `/reference/` was read as
   * "generated stubs, the YAML is indexed instead" — and that is true only of the
   * stub a spec generates. Every hand-written reference page a project keeps under
   * that path was dropped from its own index in silence: this package's own
   * `config`, `cli`, `highlighting` and `skills` pages among them, which is how a
   * question about a documented setting came back as not covered by the docs, and
   * why `sidebar link has no indexed content: /reference/config` printed on every
   * build. A spec claims one route; it does not claim the directory.
   */
  const specDir = path.join(DOCS, 'public', 'openapi')
  const specs = fs.existsSync(specDir)
    ? fs.readdirSync(specDir).filter((f) => /\.ya?ml$/.test(f))
    : []
  const specRoutes = new Set(specs.map((f) => `/reference/${f.replace(/\.ya?ml$/, '')}`))

  for (const file of files) {
    const route = routeFor(file)
    if (EXCLUDE.has(route)) continue
    if (specRoutes.has(route)) continue

    const src = fs.readFileSync(file, 'utf8')
    rawBytes += src.length
    const { chunks: c, warnings, title, source } = chunkMarkdown({
      src,
      path: route,
      kind: kindFor(route),
    })
    warnings.forEach(warn)
    if (!c.length) continue

    const origin = source ? originFor(source, route) : null

    chunks.push(...c)
    pages.set(route, {
      path: route,
      title,
      kind: kindFor(route),
      chunks: c.length,
      ...(origin ? { origin } : {}),
    })
  }

  // ── imported pages ─────────────────────────────────────────────────────────
  // Same chunker, same rules, one extra obligation: an external page has no
  // route, so a missing or unusable `source` leaves its citation pointing at a
  // page that does not exist. That is a build failure, not a warning.
  let external = 0
  const externalLinks = []
  if (KB && fs.existsSync(KB)) {
    // `EXTERNAL_PREFIX` is an id space, and an id space that collides with a
    // real route makes a citation ambiguous. Checked against the routes just
    // collected rather than assumed to be free.
    for (const route of pages.keys()) {
      if (route === EXTERNAL_PREFIX || route.startsWith(`${EXTERNAL_PREFIX}/`)) {
        die(
          `importDir "${docPilot.importDir}" claims the id prefix "${EXTERNAL_PREFIX}", ` +
            `which is already a route of this site: ${route}.\n` +
            `        Rename the import directory, or move that page.`,
        )
      }
    }

    for (const file of walkMarkdown(KB)) {
      const id = externalIdFor(file)
      if (pages.has(id)) die(`imported page id collides with a real route: ${id}`)

      const src = fs.readFileSync(file, 'utf8')
      rawBytes += src.length

      // `vitepress build` checks dead links for every page it renders, and it
      // never sees this one. Collected here and checked below, once the real
      // routes — including the generated `/reference/` ones — are all known.
      for (const m of src.matchAll(/\]\((\/[^)\s#]*)(?:#[^)\s]*)?\)/g)) {
        externalLinks.push({ file: path.relative(ROOT, file), href: m[1] })
      }
      const { chunks: c, warnings, title, source } = chunkMarkdown({ src, path: id, kind: 'guide' })
      warnings.forEach(warn)
      if (!c.length) {
        warn(`imported page produced no chunks: ${path.relative(ROOT, file)}`)
        continue
      }
      if (!source) {
        die(
          `${path.relative(ROOT, file)} has no frontmatter source.\n` +
            `        A page under ${docPilot.importDir}/ has no route on this site, so its citation has\n` +
            `        nowhere else to point. Add "source: https://…" or move the page into ${docPilot.docsDir}/.`,
        )
      }

      chunks.push(...c)
      pages.set(id, {
        path: id,
        title,
        kind: 'guide',
        chunks: c.length,
        origin: originFor(source, path.relative(ROOT, file)),
        // Read by the client as "this path is not navigable": its source row and
        // its `[n]` marker open the origin, and the citation validator must not
        // treat the id as a link the model may emit.
        external: true,
      })
      external++
    }
  }

  // ── openapi ────────────────────────────────────────────────────────────────
  // Optional, and absent in most projects — `specDir` and `specs` are resolved
  // above the markdown pass, which needs to know which routes these will claim.
  // `existsSync` guards the directory: `readdirSync` on one that is not there
  // throws ENOENT out of the middle of the build, which took the whole command
  // down for every consumer who does not publish an OpenAPI spec.
  for (const f of specs) {
    const name = f.replace(/\.ya?ml$/, '')
    const yamlText = fs.readFileSync(path.join(specDir, f), 'utf8')
    rawBytes += yamlText.length
    const { chunks: c, title } = await chunkOpenapi(yamlText, name)
    if (!c.length) {
      warn(`openapi spec produced no operations: ${f}`)
      continue
    }
    chunks.push(...c)
    pages.set(`/reference/${name}`, {
      path: `/reference/${name}`,
      title,
      kind: 'reference',
      chunks: c.length,
    })
  }

  if (!chunks.length) die('empty index — 0 chunks')

  // A link out of an imported page into the docs. An asset (`/img/…`) is skipped
  // by its extension; `/` is the home page, which is `layout: home` and produces
  // no chunk by design.
  for (const { file, href } of externalLinks) {
    const p = href.replace(/\/$/, '') || '/'
    if (p === '/' || /\.\w+$/.test(p)) continue
    if (!pages.has(p)) {
      die(`${file}: link to "${href}", which is not a page of this site`)
    }
  }

  // Ids address chunks everywhere downstream — in emittedIds, in citations, in
  // the golden set. A duplicate makes a citation ambiguous, so it fails here.
  //
  // The id is derived from the heading, so it appears nowhere in the source and
  // an author handed the bare id has nothing to search for. Name both headings
  // that collided and the anchor they landed on instead.
  const idSeen = new Map()
  for (const c of chunks) {
    const first = idSeen.get(c.id)
    if (first) {
      die(
        `duplicate chunk id: ${c.id} — two sections of ${c.path} resolve to the anchor ` +
          `"${c.anchor}": "${first.title}" and "${c.title}". Rename one heading, or give it a ` +
          `VitePress custom anchor (\`## Heading {#unique-id}\`).`,
      )
    }
    idSeen.set(c.id, c)
  }

  // ── sections ───────────────────────────────────────────────────────────────
  const indexed = new Set(pages.keys())
  const { sections, warnings: secWarn } = resolveSections(sidebar, (p) => indexed.has(p))
  secWarn.forEach(warn)
  const orphans = orphanPages([...indexed], sections)

  const pageList = [...pages.values()].map((p) => ({ ...p, tail: tailFor(p.path, sections) }))

  // A duplicate (title, tail) pair renders two identical picker rows and two
  // identical source rows with nothing to tell them apart.
  const seenTitles = new Map()
  for (const p of pageList) {
    const key = `${p.title}\x00${p.tail}`
    if (seenTitles.has(key)) {
      die(`two pages share (title, tail) = ("${p.title}", "${p.tail}"): ${seenTitles.get(key)} and ${p.path}`)
    }
    seenTitles.set(key, p.path)
  }

  const idx = new Map(pageList.map((p, i) => [p.path, i]))
  const sectionOut = sections.map((s) => ({
    id: s.id,
    label: s.label,
    scope: s.scope,
    depth: s.depth,
    pageIdx: s.paths.map((p) => idx.get(p)).filter((i) => i !== undefined),
  }))

  // ── document frequencies ───────────────────────────────────────────────────
  const df = new Map()
  for (const c of chunks) {
    for (const t of new Set(terms(c.text))) df.set(t, (df.get(t) || 0) + 1)
  }
  const dfTop = Object.fromEntries(
    [...df.entries()].sort((a, b) => b[1] - a[1]).slice(0, DF_TERMS),
  )

  // ── report ─────────────────────────────────────────────────────────────────
  const lens = chunks.map((c) => c.text.length).sort((a, b) => a - b)
  const pct = (q) => lens[Math.floor(lens.length * q)] || 0
  const normBytes = chunks.reduce((a, c) => a + c.text.length, 0)

  console.log(
    `  pages            ${pageList.length}` +
      (imported ? ` (${imported} imported, ${external} of them external)` : ''),
  )
  console.log(`  chunks           ${chunks.length}`)
  console.log(`  sections         ${sectionOut.length}`)
  console.log(`  orphan pages     ${orphans.length}${orphans.length ? ` (${orphans.join(', ')})` : ''}`)
  console.log(`  raw source       ${rawBytes.toLocaleString()} chars`)
  console.log(`  normalised text  ${normBytes.toLocaleString()} chars (${((100 * normBytes) / rawBytes).toFixed(1)}%)`)
  console.log(`  est tokens       ${estTokens(chunks.map((c) => c.text).join('')).toLocaleString()}`)
  console.log(`  chunk chars      p50 ${pct(0.5)} · p90 ${pct(0.9)} · max ${lens[lens.length - 1]}`)
  console.log(`  vocabulary       ${df.size.toLocaleString()} types (df.json keeps ${Object.keys(dfTop).length})`)

  if (DRY) {
    console.log('\n  dry run — nothing written\n')
    return
  }

  // ── embeddings ─────────────────────────────────────────────────────────────
  /**
   * Lexical-only is announced where the vectors would have been reported.
   *
   * `manifest.vectors === null` sends every reader — the store, the retriever,
   * the gate — down the BM25 path without another word, and a build log that
   * merely omits the quantisation error and the vector file is indistinguishable
   * from one where embedding was skipped by accident. That index still deploys,
   * so the difference has to be visible at the moment it is made.
   */
  let dims = 0
  let flat = null
  if (NO_EMBED) {
    console.log('  retrieval        lexical-only (BM25) — no embedder, no vectors')
  } else {
    const vectors = await embedAll(chunks.map((c) => c.text))
    if (vectors.length !== chunks.length) die('embedding count does not match chunk count')

    const qErr = quantisationError(vectors)
    console.log(`  quantisation err ${qErr.toFixed(5)} mean |Δcos|`)
    if (qErr > 0.01) die(`int8 quantisation error ${qErr.toFixed(4)} exceeds 0.01`)

    dims = vectors[0].length
    flat = new Int8Array(dims * vectors.length)
    vectors.forEach((v, i) => flat.set(toInt8(v), i * dims))
  }

  // ── write ──────────────────────────────────────────────────────────────────
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(chunks.map((c) => c.id + c.text)))
    .digest('hex')
    .slice(0, 8)

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const shards = []
  for (let i = 0; i < chunks.length; i += SHARD_SIZE) {
    const name = `chunks-${String(i / SHARD_SIZE).padStart(2, '0')}.${hash}.json`
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(chunks.slice(i, i + SHARD_SIZE)))
    shards.push(name)
  }
  const vecName = NO_EMBED ? null : `vectors.${hash}.bin`
  if (vecName) fs.writeFileSync(path.join(OUT, vecName), Buffer.from(flat.buffer))
  fs.writeFileSync(path.join(OUT, `df.${hash}.json`), JSON.stringify({ n: chunks.length, df: dfTop }))

  const manifest = {
    version: 3,
    hash,
    embedModel: NO_EMBED ? null : EMBED_MODEL,
    dims,
    chunkCount: chunks.length,
    shards,
    vectors: vecName,
    df: `df.${hash}.json`,
    pages: pageList,
    sections: sectionOut,
    orphanPages: orphans,
    guard: guardFor(hash),
    // ~120 bytes, and `version` stays 3: store.js reads `chunkCount`, `dims`,
    // `vectors`, `shards` and `df` and hands the manifest on whole, so an
    // additive optional key is invisible to every reader that predates it.
    // null on every build that has not run `docpilot tune`, which is most of them.
    tuning: tuningFor(hash),
  }

  const manifestJson = JSON.stringify(manifest)
  if (manifestJson.length > MANIFEST_MAX_BYTES) {
    die(`manifest is ${manifestJson.length} bytes, over the ${MANIFEST_MAX_BYTES} ceiling`)
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), manifestJson)

  const total = fs
    .readdirSync(OUT)
    .reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0)

  console.log(
    `\n  written to ${path.relative(ROOT, OUT)}/  ${(total / 1024).toFixed(0)} KB total`,
  )
  console.log(`    manifest.json    ${(manifestJson.length / 1024).toFixed(1)} KB`)
  if (vecName) console.log(`    ${vecName}  ${(flat.length / 1024).toFixed(0)} KB`)
  else console.log('    no vectors file  lexical-only — this index carries no embeddings')
  console.log(`    ${shards.length} chunk shard(s)`)
  console.log(`  hash ${hash}`)

  if (total > FAIL_BYTES) die(`artefacts total ${(total / 1024 / 1024).toFixed(1)} MB, over the 5 MB ceiling`)
  if (total > WARN_BYTES) warn(`artefacts total ${(total / 1024 / 1024).toFixed(1)} MB — Plan B applies (RAG-SPEC 2.4)`)
  console.log('')
}

// `guardFor` and `tuningFor` are exported and unit-tested, so importing this
// module must not start a build. Nothing else in here is importable, and that is
// deliberate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message))
}
