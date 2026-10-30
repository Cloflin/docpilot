/**
 * The one path from a document to chunks and page rows — engine-spec 041.
 *
 * `documentsToChunks` is the only place a `SourceDoc` reaches `chunkMarkdown` or
 * `chunkOpenapi`. No reader keeps a private path to a chunker, so a rule applied
 * here is applied to every source.
 *
 * It is the stage `main()` used to be, from the first file read to the last
 * page row, and nothing else: the duplicate-id check, sections, df, embedding,
 * quantisation and the writes stay in the builder. Its output is bytes — a
 * chunk's position decides its shard, a page row's key order is in the manifest
 * — so what moved here moved verbatim.
 *
 * The sources are staged in the order the builder has always indexed them:
 * Markdown, `--html-dir`, `--kb`, OpenAPI. Within a source the reader's order
 * is kept. The order matters twice: an `--html-dir` page defers to a Markdown
 * page of the same route, and an imported page is checked against every route
 * collected before it.
 */

import path from 'node:path'

import { chunkMarkdown } from './chunker.js'
import { chunkOpenapi } from './openapi-chunker.js'
import { kindFor } from './readers.js'
import { assertPublic, contentHashOf, NonPublicDocument } from './source-doc.js'
import type { ReadDoc, SourceDoc } from './source-doc.js'

export interface DocumentsContext {
  embedContext: 'off' | 'path' | 'path+desc'
  /** llms.txt descriptions by route; empty when no file was read. */
  llmsAbout: Map<string, string>
  /** Checks a front-matter `source` against the allowlist; returns the href, or dies. */
  originFor: (source: string, id: string) => string
  warn: (message: string) => void
  /** Stops the build. A test passes one that throws. */
  die: (message: string) => never | void
  /** The project root, which file names in messages are relative to. */
  root?: string
  /** Routes the `--html-dir` pass leaves alone: the home and scratch pages. */
  exclude?: Set<string>
  /** `/reference/` routes an OpenAPI spec claims. */
  specRoutes?: Set<string>
  /** The `--html-dir` value; empty when the flag is absent. */
  htmlDir?: string
  /** The id space of imported pages; null when there is no `importDir` on disk. */
  externalPrefix?: string | null
  importDir?: string
  docsDir?: string
}

export interface DocumentsResult {
  /** The input, each document stamped with its `contentHash` (in memory only). */
  docs: SourceDoc[]
  chunks: any[]
  /** Page rows by id, in insertion order — the manifest's `pages` before `tail`. */
  pages: Map<string, any>
  /** Raw source size in characters, as the corpus figures print it. */
  rawBytes: number
  counts: { htmlPages: number; htmlShadowed: number; external: number }
  /** Links out of imported pages into the docs, checked once every route is known. */
  externalLinks: { file: string; href: string }[]
}

export async function documentsToChunks(readDocs: ReadDoc[], ctx: DocumentsContext): Promise<DocumentsResult> {
  const { embedContext, llmsAbout, originFor, warn, die } = ctx
  const root = ctx.root ?? process.cwd()
  const exclude = ctx.exclude ?? new Set<string>()
  const specRoutes = ctx.specRoutes ?? new Set<string>()
  const rel = (doc: SourceDoc) => path.relative(root, doc.file ?? doc.id)

  // BEFORE ANY CHUNK EXISTS. The static index is downloaded by every reader, so
  // a document that is not public must not get as far as a chunk (T-1-27).
  try {
    assertPublic(readDocs)
  } catch (e) {
    if (e instanceof NonPublicDocument) die(e.message)
    throw e
  }
  const docs: SourceDoc[] = readDocs.map((d) => ({ ...d, contentHash: contentHashOf(d) }))
  const of = (source: SourceDoc['source']) => docs.filter((d) => d.source === source)
  const markdownOf = (doc: SourceDoc) => (doc.body.format === 'markdown' ? doc.body.markdown : '')

  const chunks = []
  const pages = new Map()
  let rawBytes = 0

  // ── markdown ───────────────────────────────────────────────────────────────
  for (const doc of of('markdown')) {
    const route = doc.id
    const src = markdownOf(doc)
    rawBytes += src.length
    const { chunks: c, warnings, title, source, description } = chunkMarkdown({
      src,
      path: route,
      kind: kindFor(route),
      embedContext,
      pageDescription: llmsAbout.get(route) ?? null,
    })
    warnings.forEach(warn)
    if (!c.length) continue

    const origin = source ? originFor(source, route) : null

    chunks.push(...c)
    const about = llmsAbout.get(route) || null
    pages.set(route, {
      path: route,
      title,
      kind: kindFor(route),
      chunks: c.length,
      ...(origin ? { origin } : {}),
      // The page's own words about itself for the lexical channel: its note in
      // llms.txt. Only when that file was read, so a default build's pages are
      // the pages they always were. (`description` is already in the text.)
      ...(about && about !== description ? { about } : {}),
    })
  }

  // ── a built site ───────────────────────────────────────────────────────────
  // `--html-dir` only. Nothing here runs without the flag, and with it nothing
  // above changes: markdown has already claimed its routes and keeps them, so
  // the two sources cannot disagree about a page — the source file wins over the
  // artefact built from it, which is the only ordering that is ever right.
  let htmlPages = 0
  let htmlShadowed = 0
  for (const doc of of('html-dir')) {
    const route = doc.id
    const src = markdownOf(doc)
    const title = doc.title
    if (exclude.has(route)) continue
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
      sidebarTitle: title ?? undefined,
      embedContext,
    })
    warnings.forEach(warn)
    if (!c.length) {
      warn(`built page produced no chunks: ${rel(doc)}`)
      continue
    }

    chunks.push(...c)
    pages.set(route, { path: route, title: title || route, kind: kindFor(route), chunks: c.length })
    htmlPages++
  }

  if (ctx.htmlDir && !htmlPages) {
    warn(
      `--html-dir ${ctx.htmlDir} produced no pages` +
        (htmlShadowed ? ` (${htmlShadowed} shadowed by markdown of the same route)` : ''),
    )
  }

  // ── imported pages ─────────────────────────────────────────────────────────
  // Same chunker, same rules, one extra obligation: an external page has no
  // route, so a missing or unusable `source` leaves its citation pointing at a
  // page that does not exist. That is a build failure, not a warning.
  let external = 0
  const externalLinks = []
  const prefix = ctx.externalPrefix
  if (prefix) {
    // `externalPrefix` is an id space, and an id space that collides with a
    // real route makes a citation ambiguous. Checked against the routes just
    // collected rather than assumed to be free.
    for (const route of pages.keys()) {
      if (route === prefix || route.startsWith(`${prefix}/`)) {
        die(
          `importDir "${ctx.importDir}" claims the id prefix "${prefix}", ` +
            `which is already a route of this site: ${route}.\n` +
            `        Rename the import directory, or move that page.`,
        )
      }
    }

    for (const doc of of('kb')) {
      const id = doc.id
      if (pages.has(id)) die(`imported page id collides with a real route: ${id}`)

      const src = markdownOf(doc)
      rawBytes += src.length

      // `vitepress build` checks dead links for every page it renders, and it
      // never sees this one. Collected here and checked by the builder, once the
      // real routes — including the generated `/reference/` ones — are all known.
      for (const m of src.matchAll(/\]\((\/[^)\s#]*)(?:#[^)\s]*)?\)/g)) {
        externalLinks.push({ file: rel(doc), href: m[1] })
      }
      const { chunks: c, warnings, title, source } = chunkMarkdown({ src, path: id, kind: 'guide', embedContext })
      warnings.forEach(warn)
      if (!c.length) {
        warn(`imported page produced no chunks: ${rel(doc)}`)
        continue
      }
      if (!source) {
        die(
          `${rel(doc)} has no frontmatter source.\n` +
            `        A page under ${ctx.importDir}/ has no route on this site, so its citation has\n` +
            `        nowhere else to point. Add "source: https://…" or move the page into ${ctx.docsDir}/.`,
        )
      }

      chunks.push(...c)
      pages.set(id, {
        path: id,
        title,
        kind: 'guide',
        chunks: c.length,
        origin: originFor(source, rel(doc)),
        // Read by the client as "this path is not navigable": its source row and
        // its `[n]` marker open the origin, and the citation validator must not
        // treat the id as a link the model may emit.
        external: true,
      })
      external++
    }
  }

  // ── openapi ────────────────────────────────────────────────────────────────
  // Optional, and absent in most projects. A missing default directory is legal
  // and yields no document; a path somebody WROTE in `docPilot.openapi` and got
  // wrong stops the build in the reader's discovery rather than here.
  for (const doc of of('openapi')) {
    if (doc.body.format !== 'openapi') continue
    const yamlText = doc.body.yaml
    rawBytes += yamlText.length
    const { chunks: c, title } = await chunkOpenapi(yamlText, doc.id.slice('/reference/'.length))
    if (!c.length) {
      warn(`openapi spec produced no operations: ${doc.file ?? doc.id}`)
      continue
    }
    chunks.push(...c)
    pages.set(doc.id, {
      path: doc.id,
      title,
      kind: 'reference',
      chunks: c.length,
    })
  }

  return { docs, chunks, pages, rawBytes, counts: { htmlPages, htmlShadowed, external }, externalLinks }
}
