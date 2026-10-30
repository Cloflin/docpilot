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
import { replaceInProse } from './markdown-code.js'
import { EXTRACTOR_VERSION } from './extract-html.js'
import { chunkOpenapi } from './openapi-chunker.js'
import { frontmatterValue, kindFor } from './readers.js'
import { assertPublic, contentHashOf, NonPublicDocument } from './source-doc.js'
import { printable } from './terminal.js'
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
}

/**
 * How many re-import commands the stale-extractor warning lists. A site that
 * changed extractors holds dozens of old pages and a warning that long is not
 * read; the full list is one command away in `docpilot doctor` (plan 02-10)
 * (engine-spec 043, D-05).
 */
export const MAX_STALE_LISTED = 5

/**
 * The extractor stamp of an imported page. `docpilot import` writes `extractor:`
 * from extractor 2; the 2.x extractor wrote none, so a page with `importedAt:`
 * and no usable stamp reads as 1 (engine-spec 043, D-05).
 */
export function extractorOf(src: string): number {
  const n = Number(frontmatterValue(src, 'extractor'))
  return Number.isInteger(n) && n > 0 ? n : 1
}

/**
 * The `--out` value that makes `docpilot import` write `file` again: its path
 * under `importDir`, in forward slashes, with no `.md`. `readKbDocs` reads nested
 * files and `runImport` joins the slug under `importDir` and creates the
 * directories, so a page at `guides/x.md` is refreshed by `--out guides/x`; the
 * bare file name wrote a second page beside the stale one and the warning never
 * cleared (WR-05).
 */
export function importSlug(importDir: string, file: string): string {
  return path.relative(importDir, file).split(path.sep).join('/').replace(/\.md$/i, '')
}

/** A word safe in a shell command as it stands; anything else is single-quoted. */
const SHELL_SAFE = /^[A-Za-z0-9_\-./:@%+=,~]+$/
export const shellWord = (w: string) => (SHELL_SAFE.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

/**
 * A link target an imported page may keep: `/`, an asset (a path ending in an
 * extension, the 2.x rule) or a route this build has. Anything else is a route
 * of the site the page was copied from.
 */
const ASSET_PATH = /\.\w+$/

/**
 * `[text](/path)`, `[text](/path#frag)` and `[text](/path "title")`. An image
 * (`![alt](…)`) is not matched: degrading one would leave a stray `!` and the
 * panel never follows an image href. The text may not hold `]`, so a link with
 * nested brackets is left as written rather than half-rewritten.
 */
const ROOT_LINK = /(?<!!)\[([^\]]*)\]\((\/[^)\s#]*)(#[^)\s]*)?(\s+(?:"[^"]*"|'[^']*'))?\)/g

/**
 * An imported page's links, held to this site's routes (D-10, F-08).
 *
 * `vitepress build` checks dead links for every page it renders and never sees
 * an imported one, whose links point at the routes of the site it was copied
 * from. A link to a route this build lacks is written as its text, so the panel
 * never renders a link into a missing page, and `onDead` reports it. Fenced
 * code and inline code spans are samples, not links: they are never read and
 * never rewritten. The front matter is copied unchanged.
 */
function degradeDeadLinks(src: string, known: (route: string) => boolean, onDead: (href: string) => void): string {
  const front = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(src)
  const head = front ? front[0] : ''
  const body = replaceInProse(src.slice(head.length), ROOT_LINK, (whole, text, href) => {
    const route = href.replace(/\/$/, '') || '/'
    if (route === '/' || ASSET_PATH.test(route) || known(route)) return whole
    onDead(href)
    return text
  })
  return head + body
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
  // A DOCUMENT THAT NO PASS BELOW WOULD READ IS A BUILD FAILURE. The passes
  // select by `source` and by body format, and a document that matches none of
  // them used to vanish from the index without a word — the silent-loss class
  // the old `/reference/` prefix skip was (readers.ts). A connector's documents
  // (Phase 3) must not meet it.
  const orphans = readDocs.filter((d) => {
    if (d.source === 'openapi') return d.body.format !== 'openapi'
    if (d.source === 'kb') return !ctx.externalPrefix || d.body.format !== 'markdown'
    if (d.source === 'markdown' || d.source === 'html-dir') return d.body.format !== 'markdown'
    return true
  })
  if (orphans.length) {
    die(
      `no stage reads: ${orphans.map((d) => `${d.id} (${d.source}, ${d.body.format})`).join(', ')}.\n` +
        `        A kb document needs externalPrefix, and a body format must match its source.`,
    )
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

    // What an imported page may link to: the routes collected so far (Markdown
    // and `--html-dir`), the OpenAPI routes, and every imported page — all known
    // before the first one is chunked, which is why the check can live here and
    // not in the builder after the fact.
    const kbIds = new Set(of('kb').map((d) => d.id))
    const known = (route: string) => pages.has(route) || specRoutes.has(route) || kbIds.has(route)

    // Imported pages an older (or newer) extractor wrote, named after the loop.
    // Only a page `docpilot import` wrote has `importedAt:`; a hand-written one
    // has none and is never flagged. The warning changes no byte of the index:
    // the Markdown on disk already reflects the extractor that wrote it, so the
    // corpus hash takes no extractor term for these pages (D-05, D-26).
    const stale: { file: string; source: string; slug: string; extractor: number }[] = []
    const newer: { file: string; extractor: number }[] = []

    for (const doc of of('kb')) {
      const id = doc.id
      if (pages.has(id)) die(`imported page id collides with a real route: ${id}`)

      const original = markdownOf(doc)
      rawBytes += original.length

      if (frontmatterValue(original, 'importedAt')) {
        const extractor = extractorOf(original)
        const file = rel(doc)
        if (extractor < EXTRACTOR_VERSION) {
          const slug = ctx.importDir
            ? importSlug(path.resolve(root, ctx.importDir), path.resolve(root, doc.file ?? doc.id))
            : path.basename(file).replace(/\.md$/i, '')
          stale.push({ file, source: doc.url ?? '', slug, extractor })
        } else if (extractor > EXTRACTOR_VERSION) {
          newer.push({ file, extractor })
        }
      }

      // A dead link in imported content is the page's, not the owner's: it
      // degrades to text with a warning, and the build goes on (D-10).
      const src = degradeDeadLinks(original, known, (href) =>
        warn(
          `${rel(doc)}: link to "${href}" is not a page of this site — written as text ` +
            `(an imported page is not held to this site's routes; engine-spec 043)`,
        ),
      )
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

    if (stale.length) {
      const old = [...new Set(stale.map((p) => p.extractor))].sort((a, b) => a - b).join(' and ')
      warn(
        `${stale.length} imported page(s) under ${ctx.importDir}/ were written by extractor ${old} ` +
          `(this build's is ${EXTRACTOR_VERSION}); re-import to apply the current rules:\n` +
          stale
            .slice(0, MAX_STALE_LISTED)
            .map((p) => `        npx docpilot import ${p.source ? shellWord(printable(p.source)) : '<source>'} --out ${shellWord(p.slug)} --force`)
            .join('\n') +
          (stale.length > MAX_STALE_LISTED ? `\n        …and ${stale.length - MAX_STALE_LISTED} more` : ''),
      )
    }
    for (const p of newer) {
      warn(
        `${p.file}: written by a newer extractor (${p.extractor}) than this build's (${EXTRACTOR_VERSION}); ` +
          `update docpilot to read it as it was written`,
      )
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

  return { docs, chunks, pages, rawBytes, counts: { htmlPages, htmlShadowed, external } }
}
