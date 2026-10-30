/**
 * The one shape every source reads into — engine-spec 041.
 *
 * INTERNAL UNTIL PHASE 3 (D-09). Nothing here is in `types/` or in
 * `package.json#exports`: a connector author does not get this type until the
 * connector contract is designed against real connectors, because a public type
 * is a promise and the first shape is never the last. No I/O, no network, no
 * embedding — a reader returns `SourceDoc[]`, and these functions only judge it.
 *
 * Phase 1 changes no byte of `docpilot index`'s output. The contract is defined
 * here and wired into `main()` by the plans that follow the characterisation of
 * today's builder.
 */

import crypto from 'node:crypto'

import { normaliseMarkdown } from './normalise.js'

/**
 * `openapi` is a body format of its own because OpenAPI bypasses the Markdown
 * chunker: `chunkOpenapi` builds its chunks from the YAML itself.
 */
export type SourceBody = { format: 'markdown'; markdown: string } | { format: 'openapi'; yaml: string }

export interface SourceDoc {
  /** Today's chunk `path`: a route, `EXTERNAL_PREFIX/rel` for a KB page, `/reference/<name>`. */
  id: string
  source: 'markdown' | 'kb' | 'html-dir' | 'openapi'
  /** Canonical URL. A KB page: its allow-checked `source:` href; elsewhere the route is the URL. */
  url: string | null
  title: string | null
  body: SourceBody
  /**
   * Never hashed and never written in Phase 1. It never comes from a file's
   * mtime: that differs on every checkout, and an index must not.
   */
  updatedAt?: string
  locale?: string
  /**
   * DENY BY DEFAULT (D-10). The field is required: no type in this file lets a
   * document become public by omission. A reader sets it; the static writer
   * refuses `'internal'` through `assertPublic`.
   */
  visibility: 'public' | 'internal'
  breadcrumb: string[]
  tags: string[]
  /** Computed by the pipeline with `contentHashOf`; in memory only in Phase 1. */
  contentHash: string
}

/**
 * sha256 hex of the UTF-8 JSON of `[id, title, description, text]`, taken over
 * the NORMALISED Markdown (`[id, yaml]` for OpenAPI). `updatedAt` is not an
 * input, so two documents that differ only in it hash equal. This is a
 * document hash, not a fourth corpus hash: `manifest.hash` keeps its single
 * definition in the builder.
 */
export function contentHashOf({ id, body }: Pick<SourceDoc, 'id' | 'body'>): string {
  let parts: string[]
  if (body.format === 'openapi') {
    parts = [id, body.yaml]
  } else {
    const n = normaliseMarkdown(body.markdown)
    parts = [id, n.title, n.description, n.text]
  }
  return crypto.createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}

/** Raised when a document that is not public reaches a static index. */
export class NonPublicDocument extends Error {
  ids: string[]
  constructor(ids: string[]) {
    super(
      `[docpilot] not public: ${ids.join(', ')} — the static index takes documents with visibility 'public' only (engine-spec 041)`,
    )
    this.name = 'NonPublicDocument'
    this.ids = ids
  }
}

/**
 * The static index is downloaded by every reader, so it takes `'public'`
 * documents and nothing else. Anything else, including a value that is not one
 * of the two literals, is refused — and every refused document is named.
 */
export function assertPublic(docs: Pick<SourceDoc, 'id' | 'visibility'>[]): void {
  const refused = docs.filter((d) => d.visibility !== 'public').map((d) => d.id)
  if (refused.length) throw new NonPublicDocument(refused)
}

/**
 * Browser runtime: a reader downloads the manifest on the first question and
 * every shard it needs after that. 64 KB keeps the first question cheap; 3 MB
 * is where RAG-SPEC 2.4's Plan B starts to apply; 5 MB is where the build stops.
 * The sizes count UTF-8 bytes, which is what the network carries.
 */
export const BROWSER_LIMITS = {
  manifestMaxBytes: 64 * 1024,
  warnBytes: 3 * 1024 * 1024,
  failBytes: 5 * 1024 * 1024,
} as const

/**
 * Server runtime: the index is read only by `docpilot serve`, and the browser
 * gets the shell manifest instead. No reader downloads these bytes, so no
 * ceiling protects one.
 */
export const SERVER_LIMITS = {
  manifestMaxBytes: Infinity,
  warnBytes: Infinity,
  failBytes: Infinity,
} as const

/**
 * Only the literal `'server'` lifts the ceilings. `undefined`, a typo and every
 * other value read as the browser, because the browser limits are the safe side
 * to fail toward (D-12).
 */
export function limitsFor(runtime?: unknown): typeof BROWSER_LIMITS | typeof SERVER_LIMITS {
  return runtime === 'server' ? SERVER_LIMITS : BROWSER_LIMITS
}
