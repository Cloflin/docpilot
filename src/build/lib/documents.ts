/**
 * The one path from a document to chunks and page rows — engine-spec 041.
 *
 * `documentsToChunks` is the only place a `SourceDoc` reaches `chunkMarkdown`
 * (or, from the next step on, `chunkOpenapi`). No reader keeps a private path
 * to a chunker, so a rule applied here is applied to every source.
 *
 * It is the stage `main()` used to be, from the first file read to the last
 * page row, and nothing else: the duplicate-id check, sections, df, embedding,
 * quantisation and the writes stay in the builder. Its output is bytes — a
 * chunk's position decides its shard, a page row's key order is in the manifest
 * — so what moved here moved verbatim.
 */

import { chunkMarkdown } from './chunker.js'
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
}

export interface DocumentsResult {
  /** The input, each document stamped with its `contentHash` (in memory only). */
  docs: SourceDoc[]
  chunks: any[]
  /** Page rows by id, in insertion order — the manifest's `pages` before `tail`. */
  pages: Map<string, any>
  /** Raw source size in characters, as the corpus figures print it. */
  rawBytes: number
}

export function documentsToChunks(readDocs: ReadDoc[], ctx: DocumentsContext): DocumentsResult {
  const { embedContext, llmsAbout, originFor, warn, die } = ctx

  // BEFORE ANY CHUNK EXISTS. The static index is downloaded by every reader, so
  // a document that is not public must not get as far as a chunk (T-1-27).
  try {
    assertPublic(readDocs)
  } catch (e) {
    if (e instanceof NonPublicDocument) die(e.message)
    throw e
  }
  const docs: SourceDoc[] = readDocs.map((d) => ({ ...d, contentHash: contentHashOf(d) }))

  const chunks = []
  const pages = new Map()
  let rawBytes = 0

  for (const doc of docs) {
    if (doc.source !== 'markdown' || doc.body.format !== 'markdown') continue
    const route = doc.id
    const src = doc.body.markdown
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

  return { docs, chunks, pages, rawBytes }
}
