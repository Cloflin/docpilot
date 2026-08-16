#!/usr/bin/env node
/**
 * DocPilot index builder — RAG-SPEC 2.
 *
 *   npx docpilot index          build the index into `${indexDir}` (docs/public/rag by default)
 *   npx docpilot index --dry  chunk and report, no embeddings, no Ollama
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
import { nodeEmbedTarget } from '../config.js'
import {
  settings as docPilot,
  ROOT,
  DOCS,
  RAG as OUT,
  CALIBRATION_OUT,
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
 * The embedder is declared ONCE, as `docPilot.embed` in docs/.vitepress/config.mjs,
 * and read here rather than restated: the index and the runtime must agree, and
 * the runtime only compares vector WIDTH, so a second copy of this decision is a
 * copy that drifts and takes retrieval down to lexical-only with nothing logged.
 * Changing embedder is one edit there, then `npx docpilot index`. Keys still come
 * from .env.local; nothing is stored.
 */
const EMBED = nodeEmbedTarget(docPilot, { ...(await fileEnv()), ...process.env })
const EMBED_URL = EMBED.baseURL
const EMBED_MODEL = EMBED.model
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
if (!DRY && !EMBED_URL) {
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

function routeFor(file) {
  const rel = path.relative(DOCS, file).replace(/\\/g, '/').replace(/\.md$/, '')
  return `/${rel}`.replace(/\/index$/, '') || '/'
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

async function embedAll(texts) {
  const vectors = []
  const BATCH = 32
  for (let i = 0; i < texts.length; i += BATCH) {
    // The search_document:/search_query: prefixes are a nomic-embed-text
    // requirement, not a general one. bge-m3 and the e5 family are trained
    // without them and applying one measurably degrades the vector.
    const prefix = /nomic/i.test(EMBED_MODEL) ? 'search_document: ' : ''
    const batch = texts.slice(i, i + BATCH).map((t) => `${prefix}${t}`)
    const res = await fetch(embedder.embedUrl(EMBED_URL), {
      method: 'POST',
      headers: embedder.headers(EMBED_KEY),
      body: JSON.stringify(embedder.embedBody(EMBED_MODEL, batch)),
    }).catch((e) =>
      die(
        `embed endpoint unreachable at ${EMBED_URL} — ${e.message}` +
          (EMBED_PROVIDER === 'ollama' ? '\n        start it with: ollama serve' : ''),
      ),
    )
    if (!res.ok) die(`embed endpoint returned ${res.status} — model "${EMBED_MODEL}", provider ${EMBED_PROVIDER}`)
    const json = await res.json()
    const batchVectors =
      EMBED_PROVIDER === 'ollama' ? json.embeddings : (json.data || []).map((d) => d.embedding)
    if (!batchVectors?.length) die('embed response carried no vectors')
    for (const v of batchVectors) vectors.push(l2normalise(v))
    process.stdout.write(`\r  embedding ${Math.min(i + BATCH, texts.length)}/${texts.length}`)
  }
  process.stdout.write('\n')
  return vectors
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
  const embedModel = opts.embedModel ?? EMBED_MODEL
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
  if (!g || typeof g.tau !== 'number' || typeof g.tauLexical !== 'number') {
    return stale(`${shown} carries no usable guard`)
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
  // RAG-SPEC 3.4.4, asserted here as well as in gate.js: a guard that fails it
  // throws at runtime, and a build that inlines it ships a panel that cannot open.
  if (!(g.wLexical < g.tau)) {
    return stale(
      `${shown} has wLexical ${g.wLexical} >= tau ${g.tau}, which gate.js rejects at init`,
    )
  }

  note(
    `guard: calibrated ${g.calibratedAt}, tau ${g.tau}, tauLexical ${g.tauLexical}, ` +
      `source "${g.source}"` +
      (doc.probeCount ? ` (${doc.probeCount} probes: ${JSON.stringify(doc.byStratum)})` : ''),
  )
  return {
    tau: g.tau,
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

  for (const file of files) {
    const route = routeFor(file)
    if (EXCLUDE.has(route)) continue
    if (route.startsWith('/reference/')) continue // generated stubs; the YAML is indexed instead

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
  // Optional, and absent in most projects. `readdirSync` on a directory that is
  // not there throws ENOENT out of the middle of the build, which took the whole
  // command down for every consumer who does not publish an OpenAPI spec.
  const specDir = path.join(DOCS, 'public', 'openapi')
  const specs = fs.existsSync(specDir)
    ? fs.readdirSync(specDir).filter((f) => /\.ya?ml$/.test(f))
    : []
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
  const idSeen = new Set()
  for (const c of chunks) {
    if (idSeen.has(c.id)) die(`duplicate chunk id: ${c.id}`)
    idSeen.add(c.id)
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
    const key = `${p.title} ${p.tail}`
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
  const vectors = await embedAll(chunks.map((c) => c.text))
  if (vectors.length !== chunks.length) die('embedding count does not match chunk count')

  const qErr = quantisationError(vectors)
  console.log(`  quantisation err ${qErr.toFixed(5)} mean |Δcos|`)
  if (qErr > 0.01) die(`int8 quantisation error ${qErr.toFixed(4)} exceeds 0.01`)

  const dims = vectors[0].length
  const flat = new Int8Array(dims * vectors.length)
  vectors.forEach((v, i) => flat.set(toInt8(v), i * dims))

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
  const vecName = `vectors.${hash}.bin`
  fs.writeFileSync(path.join(OUT, vecName), Buffer.from(flat.buffer))
  fs.writeFileSync(path.join(OUT, `df.${hash}.json`), JSON.stringify({ n: chunks.length, df: dfTop }))

  const manifest = {
    version: 3,
    hash,
    embedModel: EMBED_MODEL,
    dims,
    chunkCount: chunks.length,
    shards,
    vectors: vecName,
    df: `df.${hash}.json`,
    pages: pageList,
    sections: sectionOut,
    orphanPages: orphans,
    guard: guardFor(hash),
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
  console.log(`    ${vecName}  ${(flat.length / 1024).toFixed(0)} KB`)
  console.log(`    ${shards.length} chunk shard(s)`)
  console.log(`  hash ${hash}`)

  if (total > FAIL_BYTES) die(`artefacts total ${(total / 1024 / 1024).toFixed(1)} MB, over the 5 MB ceiling`)
  if (total > WARN_BYTES) warn(`artefacts total ${(total / 1024 / 1024).toFixed(1)} MB — Plan B applies (RAG-SPEC 2.4)`)
  console.log('')
}

// `guardFor` is exported and unit-tested, so importing this module must not
// start a build. Nothing else in here is importable, and that is deliberate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message))
}
