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
import { chunkOpenapi, specFiles } from './lib/openapi-chunker.js'
import { readHtmlDir } from './lib/html-dir.js'
import { resolveSections, orphanPages, tailFor } from './lib/sections.js'
import { parseAllowlist, checkSource } from './lib/sources.js'
import { discoverEmbedModels, embedPoolOf } from './lib/embed-discovery.js'
import { providerFor } from '../theme/docpilot/providers.js'
import { routeOf } from '../theme/docpilot/route.js'
import { LEVER_NAMES } from '../theme/docpilot/retriever.js'
import { nodeEmbedTarget, noEmbed, resolveEmbed, assertVocabulary } from '../config.js'
import {
  settings as docPilot,
  ROOT,
  DOCS,
  RAG as OUT,
  CALIBRATION_OUT,
  TUNING_OUT,
  CONFIG,
  VOCABULARY_OUT,
  EMBED_CACHE_DIR,
  fileEnv,
} from '../cli-context.js'
import { openEmbedCache } from './lib/embed-cache.js'
import { l2normalise, toInt8, quantisationError } from './lib/quantize.js'
import { bakeOpeners, renderOpenerReport } from './lib/openers.js'
import { resolveSuggestions, DEFAULT_SUGGESTIONS } from '../theme/docpilot/switches.js'
import { openerQuestions } from '../theme/docpilot/openers.js'
import { questionsHash } from '../theme/docpilot/text.js'
import { promptHash } from '../theme/docpilot/prompt.js'
import { nodeChatTarget } from '../config.js'
import {
  terms,
  estTokens,
  setVocabulary,
  vocabularyHash,
  setTokenizer,
  tokenizerConfig,
} from '../theme/docpilot/text.js'


const SHARD_SIZE = 250
const DF_TERMS = 4000
const MANIFEST_MAX_BYTES = 64 * 1024
const WARN_BYTES = 3 * 1024 * 1024
const FAIL_BYTES = 5 * 1024 * 1024

const DRY = process.argv.includes('--dry')

/**
 * A flag that carries a value, in both spellings people type.
 *
 * `--html-select "main .content"` and `--html-select=main` are the same flag,
 * and a builder that accepted one of them would be a builder whose documentation
 * is right half the time. The next token is refused when it looks like another
 * flag, so a forgotten value fails as "empty" here rather than swallowing the
 * flag that followed it.
 */
const argValue = (name) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = process.argv.indexOf(`--${name}`)
  const next = i >= 0 ? process.argv[i + 1] : undefined
  return next && !next.startsWith('--') ? next : ''
}

/**
 * `--html-dir` — the corpus is a directory of built pages, not only markdown.
 *
 * Additive by construction: markdown is walked exactly as before and an HTML
 * page whose route a markdown page already claims is skipped, so pointing this
 * at a VitePress `dist/` beside the `docs/` it was built from changes nothing.
 * The flag is a flag rather than a setting because it names a build artefact —
 * a path that exists after `npm run build` and not in a checkout — and a setting
 * that is wrong in a fresh clone is a setting that fails CI for a reason nobody
 * can see.
 */
const HTML_DIR = argValue('html-dir')
const HTML_SELECT = argValue('html-select')
const HTML_BASE = argValue('html-base')
const SITEMAP = argValue('sitemap')
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
 * `--refresh-embeddings` — buy every vector again, and rewrite the cache.
 *
 * Same shape and same name as `calibrate --refresh`: the flag skips the READ,
 * never the write, so it also repairs a file that went bad. The cache cannot go
 * stale by construction — model, host and text are all in the key — so this is
 * for the case where you suspect the provider itself changed under a stable
 * name, which no key can see.
 */
const REFRESH_EMBEDDINGS = process.argv.includes('--refresh-embeddings')

/**
 * `embed.fallback: 'lexical'` — what to do when the embedder will not answer.
 *
 * WITHOUT IT this build dies and there is no index, which is the right default:
 * an index quietly missing its vectors is a site whose retrieval got materially
 * worse with nothing said. With it, a refusal produces the mode this package
 * already ships and tests — `embed: false`, BM25 over the chunk text — instead
 * of nothing at all.
 *
 * It is OPT-IN for the reason the numbers below say. Measured on this corpus:
 * recall@8 0.97 → 0.41, retrieval F1 0.35 → 0.18, 11 of 44 answerable questions
 * refused outright, and zero retrieval for a question asked in a language the
 * corpus is not written in. A regression that size must be a decision, never a
 * consequence of somebody else's free tier being busy.
 */
const EMBED_FALLBACK_LEXICAL = resolveEmbed(docPilot).fallback === 'lexical'
/**
 * The embedder is declared ONCE, as `docPilot.embed` in docs/.vitepress/config.mjs,
 * and read here rather than restated: the index and the runtime must agree, and
 * the runtime only compares vector WIDTH, so a second copy of this decision is a
 * copy that drifts and takes retrieval down to lexical-only with nothing logged.
 * Changing embedder is one edit there, then `npx docpilot index`. Keys still come
 * from .env.local; nothing is stored.
 */
/**
 * The environment both halves resolve against, named once.
 *
 * The chat half needs it too now — the openers pass writes answers with the
 * shipped harness — and re-reading `.env.local` for the second caller would be
 * a second answer to "which key is this build using".
 */
const BUILD_ENV = { ...(await fileEnv()), ...process.env }
const EMBED = nodeEmbedTarget(NO_EMBED ? { ...docPilot, embed: false } : docPilot, BUILD_ENV)
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

/**
 * `.md` and `.mdx`.
 *
 * `.mdx` was missing while the Docusaurus adapter shipped — an adapter mounting
 * a panel over a corpus that contained none of the pages it was mounted on,
 * because a Docusaurus project writes `.mdx` and this walk did not look at it.
 * The module syntax MDX adds is removed in `normalise.js`; nothing else about
 * the two extensions differs here.
 */
function walkMarkdown(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.vitepress' && entry.name !== 'public') walkMarkdown(p, acc)
    } else if (/\.mdx?$/.test(entry.name)) acc.push(p)
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
  const rel = path.relative(KB, file).replace(/\\/g, '/').replace(/\.mdx?$/, '')
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
  // A SHORT BATCH IS A PROVIDER THAT SILENTLY DROPPED INPUTS, and the caller
  // assembles by position. Guessing which ones came back is how a chunk gets
  // somebody else's vector — and with the cache below, keeps it. `calibrate.js`
  // has checked this since its own batching landed; this side had not.
  if (vectors.length !== texts.length) {
    return { error: `the response carried ${vectors.length} vectors for ${texts.length} inputs` }
  }
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
  cacheFor = (_model: string) => null,
  onChoose = (_model: string, _dims: number, _size: number) => {},
  onSkip = (_model: string, _why: string) => {},
  onRestart = (_from: string, _to: string, _why: string) => {},
  onProgress = (_done: number, _total: number) => {},
  onCache = (_hits: number, _total: number) => {},
}: {
  model?: string | null
  pool?: string[]
  batch: (model: string, texts: string[]) => Promise<any>
  fail: (message: string) => never
  batchSize?: number
  cacheFor?: (model: string) => any
  onChoose?: (model: string, dims: number, size: number) => void
  onSkip?: (model: string, why: string) => void
  onRestart?: (from: string, to: string, why: string) => void
  onProgress?: (done: number, total: number) => void
  onCache?: (hits: number, total: number) => void
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
      `no embedder answered. Tried ${pool.length}:\n        ` +
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
      /**
       * The cache is opened PER MODEL, inside the restart loop.
       *
       * That is not tidiness, it is the restart invariant restated: the model
       * name is in the cache key, so a restart lands on a namespace that is cold
       * by construction and cannot top up one vector space out of another. It is
       * also why the cache cannot be opened before `choose()` — until then there
       * is no model name to key it with.
       */
      const cache = cacheFor(chosen)
      const vectors = new Array(texts.length)
      const miss = []
      for (let i = 0; i < texts.length; i++) {
        const hit = cache?.get(texts[i])
        if (hit) vectors[i] = hit
        else miss.push(i)
      }
      onCache(texts.length - miss.length, texts.length)

      let failure = null
      for (let i = 0; i < miss.length; i += batchSize) {
        const rows = miss.slice(i, i + batchSize)
        const out = await batch(chosen, rows.map((j) => texts[j]))
        if (out.fatal) fail(out.fatal)
        if (!out.vectors) {
          failure = out
          break
        }
        out.vectors.forEach((v, k) => {
          const vec = l2normalise(v)
          vectors[rows[k]] = vec
          cache?.set(texts[rows[k]], vec)
        })
        onProgress(Math.min(i + batchSize, miss.length), miss.length)
      }
      if (!failure) {
        // Written only on a complete pass, and with exactly the texts this run
        // used — so a corpus that lost a chunk stops paying disk for it, and a
        // run that died halfway leaves the previous file intact.
        cache?.commit(texts)
        return { model: chosen, vectors }
      }

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

/**
 * Thrown by `fail` when the fallback is what happens next, and caught two lines
 * below. A sentinel rather than a return value because `createEmbedder`'s
 * contract for `fail` is "throws or exits; it never returns", and every one of
 * its call sites is written on that promise.
 */
class LexicalFallback extends Error {}

/**
 * The candidates this build may embed with, in the order to try them.
 *
 * THREE CASES, and only the middle one is new.
 *
 * An AUTHOR'S name is used as given: `embed: {provider: …, model: …}` is a
 * sentence, `createEmbedder` returns it without walking anything, and one
 * request is spent on the corpus rather than on asking questions.
 *
 * A STATIC POOL — OpenRouter's free tier — is walked as it always was. Which
 * free embedder is serving right now is exactly what that list exists to
 * discover, and the catalogue behind it is already read by `fetchFreePool`.
 *
 * A NAME FROM THE PROVIDER TABLE becomes the HEAD OF A POOL instead of a fixed
 * model. That table says of itself that its names are defaults rather than
 * guarantees — catalogues change — and the cost of a stale one is this build
 * dying on its first chunk with a 404 naming a model nobody typed. So the
 * provider is asked what it actually serves and its answer lines up behind the
 * table's, which means the ordinary build picks exactly what it always picked
 * and pays one extra request for the case where it could not have.
 *
 * Discovery never moves the PROVIDER — see the header of embed-discovery.js for
 * why the proxy makes that a config-time decision and nothing else.
 */
async function embedCandidatesFor() {
  if (!EMBED.modelAuto || EMBED_POOL.length) {
    return { model: EMBED_MODEL, pool: EMBED_POOL }
  }
  const discovered = await discoverEmbedModels({
    provider: EMBED_PROVIDER,
    baseURL: EMBED_URL,
    apiKey: EMBED_KEY,
  })
  const pool = embedPoolOf(EMBED_MODEL, discovered)
  // Silent when the catalogue added nothing — a line saying "1 candidate" on
  // every ordinary build is noise, and the `embedder` line below already names
  // what was chosen. Loud when it did, because "chosen from 4" is otherwise a
  // number from nowhere.
  if (pool.length > 1) {
    console.log(
      `  embedders ${pool.length} to try — ${EMBED.id} offers ` +
        `${discovered.length}, and ${EMBED_MODEL || 'no model'} is configured`,
    )
  }
  // A pool of one is a pool: `createEmbedder` probes its single member and
  // reports the refusal through the same path a longer walk would.
  return { model: null, pool }
}

async function embedAll(texts) {
  const { model, pool } = await embedCandidatesFor()
  const run = createEmbedder({
    model,
    pool,
    batch: embedBatchWithWaits,
    /**
     * THE ONE PLACE THE FALLBACK LIVES. Every way the embedding half can give up
     * — no model named and no pool, every pool member refusing the probe, the
     * chosen model dying mid-pass with nothing left to restart on — arrives
     * here, because `createEmbedder` was built with exactly one exit.
     */
    fail: (m) => {
      if (!EMBED_FALLBACK_LEXICAL) die(m)
      process.stdout.write('\n')
      console.log(
        `\n  FELL BACK  no embedder answered, and embed.fallback is "lexical".\n` +
          `             ${m.split('\n')[0]}\n` +
          `             This index ships WITHOUT VECTORS: retrieval is BM25 over the\n` +
          `             chunk text alone. Measured on a 1191-chunk corpus, that is\n` +
          `             recall@8 0.97 → 0.41 and 11 of 44 answerable questions refused,\n` +
          `             and a question asked in another language than the corpus scores\n` +
          `             zero. Rebuild when the embedder is answering again.\n`,
      )
      throw new LexicalFallback(m)
    },
    // Not "free model(s)" any more: a pool is no longer only OpenRouter's free
    // tier — it is also the provider's own catalogue standing behind a name from
    // the table — and calling a paid embedder free is the kind of small lie a
    // build log gets quoted for.
    onChoose: (model, dims, size) =>
      console.log(`  embedder  ${model} · ${dims}d — chosen from ${size} candidate(s)`),
    onSkip: (model, why) => warn(`${model} is not answering (${why}); trying the next embedder`),
    onRestart: (from, to, why) => {
      process.stdout.write('\n')
      warn(
        `"${from}" stopped answering mid-pass (${why}) — restarting on "${to}". ` +
          'Vectors already collected are discarded: one index, one vector space.',
      )
    },
    onProgress: (done, total) => process.stdout.write(`\r  embedding ${done}/${total}`),
    onCache: (hits, total) => {
      if (hits) console.log(`  cache     ${hits}/${total} vectors already bought`)
    },
    /**
     * Opened per model, and only here — `createEmbedder` never learns what a
     * provider or a base URL is. The prefix is recomputed rather than passed:
     * it is a function of the model name (`embedBatch` above), and deriving it
     * in both places from the same rule is what stops the key describing a
     * request the build did not make.
     */
    cacheFor: (model) =>
      openEmbedCache({
        dir: EMBED_CACHE_DIR,
        model,
        provider: EMBED_PROVIDER,
        baseURL: EMBED_URL,
        prefix: /nomic/i.test(model) ? 'search_document: ' : '',
        refresh: REFRESH_EMBEDDINGS,
        warn,
      }),
  })
  let out
  try {
    out = await run.all(texts)
  } catch (e) {
    // Only ours. Anything else is a real failure and belongs to the caller.
    if (!(e instanceof LexicalFallback)) throw e
    return null
  }
  // The manifest, the guard and the nomic prefix all read this, and until now it
  // was a guess made in the config file rather than the answer the pool gave.
  EMBED_MODEL = out.model
  process.stdout.write('\n')
  return out.vectors
}

/**
 * THE VOCABULARY THE INDEX IS BUILT WITH — the map, resolved and installed.
 *
 * Two sources, and the split is the same one `guard.tau` draws over a measured
 * threshold: `docpilot vocabulary` PROPOSES into a sidecar the author commits,
 * and `vocabulary` in the config file is the author OVERRIDING it. Per canonical
 * term rather than wholesale, so adding one pair by hand does not silently
 * discard the twenty a model found.
 *
 * `{}` in the config is not the same statement as an omitted key: it is
 * "declared, and empty", and it takes nothing — including the sidecar. Omitted
 * (`null`) is "declared none" and takes the file. The same split `chat.model`
 * draws between `null` and a name.
 *
 * IT IS INSTALLED, NOT ONLY RETURNED. `terms()` is module state, and every
 * tokenisation after this line — `df.json` here, MiniSearch and the gate in the
 * browser — has to see the same map or the index is scored against a vocabulary
 * it was not built with. The manifest carries it onward; `assembleIndex` is the
 * other end.
 */
export function vocabularyFor(
  opts: {
    file?: string
    note?: (message: string) => void
    warn?: (message: string) => void
    own?: unknown
  } = {},
) {
  const file = opts.file ?? VOCABULARY_OUT
  const shown = path.relative(ROOT, file)
  const note = opts.note ?? ((m) => console.log(`  ${m}`))
  const own = 'own' in opts ? opts.own : docPilot.vocabulary

  let fromFile = null
  if (own && typeof own === 'object' && !Object.keys(own).length) {
    // Declared empty. Not an oversight and not a reason to reach for a file.
    setVocabulary(null)
    return null
  }
  if (fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      fromFile = doc && typeof doc === 'object' ? (doc.terms ?? doc) : null
    } catch (e) {
      // A malformed sidecar is a broken file, not a broken corpus. The build
      // that reports it is still a publishable build.
      warn(`${shown} is not readable JSON (${e.message}) — building with no vocabulary`)
      fromFile = null
    }
  }

  const merged = {...((fromFile || {}) as object), ...((own || {}) as object)}
  if (!Object.keys(merged).length) {
    setVocabulary(null)
    return null
  }
  // Shape only, and it throws: an author-written map with a cycle in it is
  // somebody's mistake to hear about now rather than a silent drop later.
  assertVocabulary({vocabulary: merged})
  const report = setVocabulary(merged)
  for (const s of report.skipped) note(`vocabulary: skipped "${s.alias}" — ${s.why}`)
  const sources = [fromFile && `${shown}`, own && Object.keys(own).length && 'config'].filter(Boolean)
  note(
    `vocabulary: ${report.terms} term(s), ${report.aliases} alias(es) from ${sources.join(' + ')} ` +
      `— hash ${vocabularyHash()}`,
  )
  return merged
}

/**
 * WHICH calibration belongs to THIS index.
 *
 * `${evalDir}/calibration.json` is one path per project and an index directory
 * is not. A repository that commits a second index of one corpus — the floor
 * described in the indexing guide, or the target of a `calibrate --transfer` —
 * has two guards and one filename to keep them in, so whichever build ran last
 * would decide what the other one inlines.
 *
 * A per-index name is tried FIRST and the shared one is the fallback, which
 * leaves every single-index project reading exactly the file it always read
 * while giving a second index somewhere of its own to be measured into.
 */
export function calibrationPathFor(indexDir = OUT) {
  const named = path.join(
    path.dirname(CALIBRATION_OUT),
    `calibration.${path.basename(indexDir)}.json`,
  )
  return fs.existsSync(named) ? named : CALIBRATION_OUT
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

/**
 * Every `guard.source` `docpilot calibrate` writes, and nothing else.
 *
 * Keep in step with the ternary in `buildDoc` (`eval/calibrate.js`), which is
 * the only writer: it produces `transferred-window`, `calibrated-reduced-lexical`
 * or `calibrated-reduced`. `calibrated` is kept because files written before
 * that split carry it. See the warn-and-pass block in `guardFor` for why an
 * unknown value is reported rather than refused.
 */
const SOURCE_VOCABULARY = [
  'calibrated',
  'calibrated-reduced',
  'calibrated-reduced-lexical',
  'transferred-window',
]

export function guardFor(hash, opts: {
    file?: string
    warn?: (message: string) => void
    note?: (message: string) => void
    embedModel?: string | null
  } = {},) {
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
  const file = opts.file ?? calibrationPathFor()
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
  /**
   * THE VOCABULARY IS THE THIRD THING A THRESHOLD IS BOUND TO, after the corpus
   * and the embedder, and it is the one with no natural signal.
   *
   * `hash` is over chunk TEXT. Change the map and every lexical score moves
   * while the hash does not — the same silence the embedder check two blocks
   * down was added to break, and the same silence the stemmer shipped into: the
   * CHANGELOG says in as many words that "nothing in the build can detect that
   * it is due". `vocabHash` is what makes it detectable, so this is the line
   * that turns that sentence false.
   *
   * A calibration written before the field existed carries `undefined`, and a
   * build with no vocabulary produces `null`. Those are the same state — nothing
   * declared — so they compare equal rather than reporting a stale guard on
   * every existing deployment's first rebuild.
   */
  const vocabNow = 'vocabHash' in opts ? opts.vocabHash : vocabularyHash()
  if ((doc.vocabHash ?? null) !== (vocabNow ?? null)) {
    return stale(
      `${shown} was measured with vocabulary ${doc.vocabHash ?? 'none'}, this build ` +
        `tokenises with ${vocabNow ?? 'none'} — every lexical score moved and the index ` +
        'hash cannot see it',
    )
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

  /**
   * `source` IS A CLAIM ABOUT EVIDENCE, AND IT TRAVELS FURTHER THAN THE GUARD.
   *
   * The projection below stamps it verbatim out of a file a consumer commits and
   * may hand-edit. From `manifest.guard` it reaches `session.js`, which writes it
   * onto EVERY feedback record, and `report.js`, which prints it into EVERY eval
   * report. So a hand-written `"calibrated"` in `calibration.json` does not just
   * mislabel one build: it re-labels the whole evidence trail the project
   * produces about itself, and nothing downstream can tell.
   *
   * WARN AND PASS, never reject. `guardFor`'s contract is that documentation
   * stays publishable — every other fault here degrades to `provisional` rather
   * than stopping the build — and refusing an unknown string would be a
   * strictness this function does not have anywhere else. The value still ships;
   * it just stops shipping silently.
   *
   * `'provisional'` is deliberately absent: it is this function's own OUTPUT
   * (see `provisional` above), never an input, so a file carrying it is a
   * hand-edit and earns the warning. `'config'` is absent for the opposite
   * reason — `session.js` mints it after the manifest is written, when the
   * author sets `guard.tau` by hand, and it never passes through here.
   *
   * `'calibrated'` has no producer today; `calibrate.js` writes one of the other
   * three. It stays for the calibration files written before that split.
   */
  if (!SOURCE_VOCABULARY.includes(g.source)) {
    log(
      `${shown} carries source "${g.source}", which is not a value this package writes — ` +
        `inlining it as given, but every feedback record and eval report will repeat it.`,
    )
    log(`      the values calibrate produces are: ${SOURCE_VOCABULARY.join(', ')}.`)
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
export function tuningFor(hash, opts: {
    file?: string
    warn?: (message: string) => void
    note?: (message: string) => void
    embedModel?: string | null
  } = {},) {
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
  //
  // AND THE FILE MAY NOT BE THERE AT ALL. `CONFIG` falls back to VitePress's
  // default path when the CLI found no config to point at, which is the whole
  // zero-config case — settings from the environment, no file to read. That is
  // a build with no sidebar, exactly as above, and not a build that stops: the
  // corpus is markdown either way and the section label is the only loss.
  const configUrl = pathToFileURL(CONFIG).href
  let config: Record<string, any> = {}
  try {
    config = (await import(configUrl)).default ?? {}
  } catch (e) {
    // A config that EXISTS and throws is a different fault and has to stay
    // loud — a syntax error reported as "no sections" is an hour of looking in
    // the wrong place.
    if (fs.existsSync(CONFIG)) throw e
    console.warn(`  no config at ${CONFIG} — indexing without sidebar sections`)
  }
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
  const { files: specs, errors: specErrors } = specFiles(
    docPilot.openapi,
    path.join(docPilot.docsDir, 'public', 'openapi'),
    ROOT,
  )
  if (specErrors.length) die(specErrors.join('\n        '))

  /**
   * A spec is named by its BASENAME, and the basename is the route.
   *
   * That was harmless while every spec lived in one directory, where the
   * filesystem enforced uniqueness for free. `docPilot.openapi` can name two
   * directories, and `v1/api.yaml` beside `v2/api.yaml` then claims
   * `/reference/api` twice — the second silently overwriting the first's page
   * entry while both sets of chunks stay in the index under one id space.
   * Which one should win is not a decision this package can make.
   */
  const specNameOf = (f) => path.basename(f).replace(/\.ya?ml$/i, '')
  const specByName = new Map()
  for (const f of specs) {
    const name = specNameOf(f)
    const prior = specByName.get(name)
    if (prior) {
      die(
        `two OpenAPI specs claim /reference/${name}:\n` +
          `        ${path.relative(ROOT, prior)}\n        ${path.relative(ROOT, f)}\n` +
          `        Rename one of them — the file name is the route.`,
      )
    }
    specByName.set(name, f)
  }
  const specRoutes = new Set([...specByName.keys()].map((n) => `/reference/${n}`))

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

  // ── a built site ───────────────────────────────────────────────────────────
  // `--html-dir` only. Nothing here runs without the flag, and with it nothing
  // above changes: markdown has already claimed its routes and keeps them, so
  // the two sources cannot disagree about a page — the source file wins over the
  // artefact built from it, which is the only ordering that is ever right.
  let htmlPages = 0
  let htmlShadowed = 0
  if (HTML_DIR) {
    const dir = path.resolve(ROOT, HTML_DIR)
    let found
    try {
      found = await readHtmlDir({
        dir,
        select: HTML_SELECT,
        base: HTML_BASE,
        sitemap: SITEMAP ? path.resolve(ROOT, SITEMAP) : '',
        warn,
      })
    } catch (e) {
      die(String(e?.message || e))
    }

    for (const { route, file, src, title } of found) {
      if (EXCLUDE.has(route)) continue
      if (specRoutes.has(route)) continue
      if (pages.has(route)) {
        htmlShadowed++
        continue
      }

      rawBytes += src.length
      const { chunks: c, warnings } = chunkMarkdown({
        src,
        path: route,
        kind: kindFor(route),
        sidebarTitle: title,
      })
      warnings.forEach(warn)
      if (!c.length) {
        warn(`built page produced no chunks: ${path.relative(ROOT, file)}`)
        continue
      }

      chunks.push(...c)
      pages.set(route, { path: route, title: title || route, kind: kindFor(route), chunks: c.length })
      htmlPages++
    }

    if (!htmlPages) {
      warn(
        `--html-dir ${HTML_DIR} produced no pages` +
          (htmlShadowed ? ` (${htmlShadowed} shadowed by markdown of the same route)` : ''),
      )
    }
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
  // Optional, and absent in most projects — `specs` is resolved above the
  // markdown pass, which needs to know which routes these will claim. A missing
  // default directory is legal and yields an empty list; a path somebody WROTE in
  // `docPilot.openapi` and got wrong stops the build there rather than here.
  for (const f of specs) {
    const name = specNameOf(f)
    const yamlText = fs.readFileSync(f, 'utf8')
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

  /**
   * `DOCPILOT_SPLIT_IDENTIFIERS=1` — the identifier-parts tokenizer.
   *
   * An environment variable rather than a setting, and OFF by default, because
   * it is a lever to be swept before it is a decision to be shipped: it moves
   * every lexical score in the corpus, and the number that says whether it moved
   * them the right way is `docpilot eval`, on the consumer's own corpus. A
   * default nobody measured is the thing this package refuses to ship.
   *
   * Installed here, before the vocabulary and before anything is tokenised, and
   * written into the manifest so the reader's browser follows.
   */
  setTokenizer({ splitIdentifiers: /^(1|true|yes)$/i.test(String(process.env.DOCPILOT_SPLIT_IDENTIFIERS || '')) })

  // ── the vocabulary, installed before anything is tokenised ─────────────────
  // Ahead of `df` on purpose and by one line: `terms()` is module state, so the
  // frequencies below and every query the browser ever runs have to be produced
  // by the same map or the gate measures itself against a vocabulary it cannot
  // reproduce — RAG-SPEC 3.4.3, the same sentence text.js opens with.
  const vocabulary = vocabularyFor()

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
  // Printed only when the flag was used, and printed even when it found nothing:
  // "0 built pages, 412 shadowed" is the answer to the only question a consumer
  // has after pointing this at the wrong directory.
  if (HTML_DIR) {
    console.log(
      `  built pages      ${htmlPages}` +
        (htmlShadowed ? ` (${htmlShadowed} shadowed by markdown)` : '') +
        ` from ${HTML_DIR}`,
    )
  }
  console.log(`  chunks           ${chunks.length}`)
  console.log(`  sections         ${sectionOut.length}`)
  // Listed, but not all of them. A sidebar covers a documentation site and does
  // not cover a built one — `--html-dir` on a project with no `themeConfig.sidebar`
  // makes EVERY page an orphan, and a single line naming four hundred routes is a
  // line nobody reads and a terminal nobody can scroll. The count is the signal;
  // the names are the sample that tells you which kind of page they are.
  const ORPHAN_SAMPLE = 8
  const orphanNote = orphans.length
    ? ` (${orphans.slice(0, ORPHAN_SAMPLE).join(', ')}${orphans.length > ORPHAN_SAMPLE ? `, +${orphans.length - ORPHAN_SAMPLE} more` : ''})`
    : ''
  console.log(`  orphan pages     ${orphans.length}${orphanNote}`)
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
  /**
   * THE MODE THIS BUILD ARRIVED AT, which is not always the mode it was told.
   *
   * `NO_EMBED` is the declaration — `embed: false`, or `--no-embed`. This is
   * that, plus the case where an embedder was configured, refused, and
   * `embed.fallback: 'lexical'` said what to do about it. Everything written
   * below reads THIS: a manifest that named an embedder it never reached would
   * be a manifest the browser believes.
   */
  let vectorless = NO_EMBED
  if (!NO_EMBED) {
    const vectors = await embedAll(chunks.map((c) => c.text))
    // `null`, not an empty array: the fallback fired and there is nothing to
    // check the length of. `embedAll` has already said so, loudly.
    if (vectors === null) vectorless = true
    else if (vectors.length !== chunks.length) die('embedding count does not match chunk count')
    else {

      const qErr = quantisationError(vectors)
      console.log(`  quantisation err ${qErr.toFixed(5)} mean |Δcos|`)
      if (qErr > 0.01) die(`int8 quantisation error ${qErr.toFixed(4)} exceeds 0.01`)

      dims = vectors[0].length
      flat = new Int8Array(dims * vectors.length)
      vectors.forEach((v, i) => flat.set(toInt8(v), i * dims))
    }
  }
  if (vectorless) {
    console.log('  retrieval        lexical-only (BM25) — no embedder, no vectors')
  }

  // ── write ──────────────────────────────────────────────────────────────────
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(chunks.map((c) => c.id + c.text)))
    .digest('hex')
    .slice(0, 8)

  /**
   * The bundle the LAST build wrote, read before the directory is wiped.
   *
   * It is the answer cache and nothing else: an answer whose question, corpus,
   * prompt and model are all unchanged is the same answer, and regenerating it
   * would spend a model request to arrive at a string already on disk. On a
   * fifty-a-day allowance that is the difference between the openers pass being
   * something you run and something you avoid running.
   *
   * Read here rather than after `rmSync` for the obvious reason, and wrapped
   * because every way this can fail — no previous build, a hand-deleted file,
   * half-written JSON — means the same thing: no cache, bake everything.
   */
  let previousOpeners = null
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'))
    if (prev.openers) {
      previousOpeners = JSON.parse(fs.readFileSync(path.join(OUT, prev.openers), 'utf8'))
    }
  } catch {
    previousOpeners = null
  }

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const shards = []
  for (let i = 0; i < chunks.length; i += SHARD_SIZE) {
    const name = `chunks-${String(i / SHARD_SIZE).padStart(2, '0')}.${hash}.json`
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(chunks.slice(i, i + SHARD_SIZE)))
    shards.push(name)
  }
  const vecName = vectorless ? null : `vectors.${hash}.bin`
  if (vecName) fs.writeFileSync(path.join(OUT, vecName), Buffer.from(flat.buffer))
  fs.writeFileSync(path.join(OUT, `df.${hash}.json`), JSON.stringify({ n: chunks.length, df: dfTop }))

  /**
   * Hoisted out of the manifest literal because the openers pass needs the SAME
   * values — it runs the real gate, and a gate run against a different threshold
   * than the one that ships would print a verdict no reader will reproduce.
   */
  const guard = guardFor(hash)
  const tuning = tuningFor(hash)

  const manifest = {
    version: 3,
    hash,
    embedModel: vectorless ? null : EMBED_MODEL,
    dims,
    chunkCount: chunks.length,
    shards,
    vectors: vecName,
    df: `df.${hash}.json`,
    pages: pageList,
    sections: sectionOut,
    orphanPages: orphans,
    guard,
    // ~120 bytes, and `version` stays 3: store.js reads `chunkCount`, `dims`,
    // `vectors`, `shards` and `df` and hands the manifest on whole, so an
    // additive optional key is invisible to every reader that predates it.
    // null on every build that has not run `docpilot tune`, which is most of them.
    tuning,
    /**
     * The map the reader's browser has to tokenise with, and a hash of it.
     *
     * BOTH, and the second is not redundant. `hash` above is sha256 over chunk
     * TEXT and moves for no other reason — so a changed vocabulary produces a
     * differently-tokenised index under an identical hash, which is exactly the
     * blind spot the stemmer fell into and `guardFor` now reads `vocabHash` to
     * close. null on every build that declared none, which keeps a manifest
     * without a vocabulary byte-identical to the ones that shipped.
     */
    vocabulary,
    vocabHash: vocabularyHash(),
    /**
     * How this index was TOKENISED, so the browser tokenises the same way.
     *
     * The same contract as `vocabulary` directly above and for the same reason:
     * `df.json` is produced by the tokenizer, the gate scores against `df.json`,
     * and a browser that splits identifiers against an index that did not is
     * measuring itself against a vocabulary it cannot reproduce.
     *
     * The flag itself is folded into `vocabHash`, which is what makes an index
     * built with it and a calibration measured without it disagree through the
     * guard that already exists rather than through a second one.
     */
    tokenizer: tokenizerConfig(),
    /**
     * The openers this build resolved — engine-specs/009. Filled in below,
     * because resolving them needs this object.
     *
     * Declared null rather than left off, on the same terms as `vectors`:
     * `store.js` reads a strict null as "there is nothing to fetch" and a
     * missing key as the same thing, and stating it keeps the two shapes one.
     * `version` stays 3 — an additive optional key is invisible to every reader
     * that predates it.
     */
    openers: null,
  }

  /**
   * ── the openers, resolved — engine-specs/009 ───────────────────────────────
   *
   * LAST, because it needs everything above it: the model the pool actually
   * settled on, the corpus hash, the shards, the vector blob, and the guard the
   * manifest is about to carry. It runs the production retriever over the index
   * this build just produced, which is the only arrangement in which the score
   * it prints is the score a reader will get.
   *
   * Written before the size check below on purpose — the bundle's bytes are part
   * of what ships, so they are part of what the ceilings see.
   */
  const suggestions = resolveSuggestions(docPilot, warn)
  const openerList = suggestions.precomputed ? openerQuestions(suggestions) : []
  if (openerList.length) {
    const chatTarget = nodeChatTarget(docPilot, BUILD_ENV)
    const { bundle, json, entries, report } = await bakeOpeners({
      questions: openerList,
      manifest,
      chunks,
      vectorBuffer: vectorless ? null : flat.buffer,
      dfDoc: { n: chunks.length, df: dfTop },
      hash,
      embed: {
        model: EMBED_MODEL,
        provider: EMBED_PROVIDER,
        baseURL: EMBED_URL,
        apiKey: EMBED_KEY,
        /**
         * The query-side cache, in its OWN DIRECTORY — and the directory is the
         * fix rather than a filing preference.
         *
         * `openEmbedCache` derives its namespace from model, provider, baseURL
         * and prefix. For a nomic model the prefixes differ (`search_query: `
         * against `search_document: `) and the two sides land in separate files
         * on their own. For every other model BOTH prefixes are empty, so the
         * two passes resolve to the SAME file — and `commit` is self-evicting by
         * design: it rewrites the pair with exactly the texts its caller used.
         * This pass commits three questions, so it replaced 476 chunk vectors
         * with three and reported a healthy cache while doing it. The next build
         * then re-bought the whole corpus, which on a metered embedder is
         * fifteen requests a build, silently, forever.
         *
         * A separate directory makes the two caches incapable of meeting,
         * whatever the model is called.
         */
        cache: vectorless
          ? null
          : openEmbedCache({
              dir: path.join(EMBED_CACHE_DIR, 'openers'),
              model: EMBED_MODEL,
              provider: EMBED_PROVIDER,
              baseURL: EMBED_URL,
              prefix: /nomic/i.test(EMBED_MODEL) ? 'search_query: ' : '',
              refresh: REFRESH_EMBEDDINGS,
              warn,
            }),
      },
      chat: {
        searchOnly: chatTarget.searchOnly === true,
        model: chatTarget.model,
        promptHash: promptHash(docPilot.prompt, docPilot.product),
        maxIterations: docPilot.maxIterations ?? 4,
        llm: {
          provider: chatTarget.provider,
          baseURL: chatTarget.baseURL,
          model: chatTarget.model,
          apiKey: chatTarget.apiKey,
          temperature: 0.2,
          stepTimeoutMs: 180000,
          numCtx: chatTarget.numCtx ?? undefined,
        },
      },
      docPilot,
      answers: suggestions.answers,
      matchTau: suggestions.matchTau,
      previous: previousOpeners,
      warn,
    })
    if (bundle) {
      const name = `openers.${hash}.json`
      fs.writeFileSync(path.join(OUT, name), json)
      manifest.openers = name
      for (const line of renderOpenerReport({
        entries,
        report,
        matchTau: suggestions.matchTau,
        configHash: bundle.configHash,
      })) {
        console.log(line)
      }
    }
  } else if (!suggestions.precomputed) {
    console.log('  openers          suggestions.precomputed is off — nothing resolved, nothing read')
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
  if (manifest.openers) {
    console.log(
      `    ${manifest.openers}  ` +
        `${(fs.statSync(path.join(OUT, manifest.openers)).size / 1024).toFixed(1)} KB`,
    )
  }
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
