/**
 * `@cloflin/docpilot/server` — the turn on the owner's server (engine-spec 028).
 *
 * Use with `runtime: 'server'` in the `docPilot` settings. The handler answers
 * `GET {server.endpoint}/manifest` and `POST {server.endpoint}`; every other
 * path is a 404 from `handle` and a `next()` from `node`.
 */
import type { DocPilotSettings } from './config.js'

export interface TurnLogOptions {
  /** A directory; one `turns-YYYY-MM-DD.jsonl` per UTC day. */
  dir?: string | null
  /** Or your own sink — called with each `docpilot.turn/1` record. */
  write?: ((record: TurnRecord) => void | Promise<void>) | null
  /** Keep the final prompt as `messages` on each record. Off by default. */
  prompts?: boolean
  /** Delete day files older than this. Null keeps everything. */
  retentionDays?: number | null
}

/** One line of the turn log — engine-spec 028 §3. */
export interface TurnRecord {
  kind: 'docpilot.turn'
  v: 1
  at: string
  messageId: string
  conversationId: string
  question: string
  quote: string
  lang: string
  scope: { kind: string; paths: string[] }
  depth: number
  outcome:
    | 'answer'
    | 'opener'
    | 'refused'
    | 'not-answerable'
    | 'social'
    | 'credential'
    | 'results'
    | 'error'
    | 'aborted'
    | 'rate-limited'
  refusal: string | null
  gate: {
    pass: boolean
    G: number | null
    D: number | null
    L: number | null
    channel: string | null
    antecedent: string | null
    mode: string | null
    threshold: number | null
  } | null
  retrievedIds: string[]
  emitted: string[]
  citations: string[]
  answer: string
  summary: string | null
  confidence: number | null
  support: number | null
  tentative: boolean
  iterations: number
  requests: number
  latencyMs: number
  usage: { promptTokens: number; outputTokens: number; cachedTokens: number | null } | null
  model: string | null
  provider: string | null
  embedModel: string | null
  indexHash: string | null
  promptHash: string | null
  messages?: Array<{ role: string; content: unknown }>
  error: string | null
}

export interface DocPilotServerOptions {
  settings?: DocPilotSettings
  env?: Record<string, string | undefined>
  /** The index directory `docpilot index` wrote, or its http(s) base URL. */
  index: string
  log?: TurnLogOptions | null
  /** Return a Response to refuse a request; nothing to allow it. */
  authorize?: ((request: Request) => Response | null | undefined | Promise<Response | null | undefined>) | null
}

export interface DocPilotServer {
  /** Web-standard handler: Node 20+, Bun, Deno, Workers, edge functions. */
  handle(request: Request): Promise<Response>
  /** `node:http` / Express / Connect middleware. */
  node(req: any, res: any, next?: (err?: unknown) => void): Promise<void>
  endpoint: string
  /** The shell the panel receives: pages and sections, no thresholds or corpus. */
  manifest(): { version: number; hash: string; chunkCount: number; pages: unknown[]; sections: unknown[]; orphanPages: string[] }
}

export function createDocPilotServer(options: DocPilotServerOptions): Promise<DocPilotServer>

/** Delete turn-log day files older than `days`. Returns the names removed. */
export function prune(dir: string, days: number, now?: Date): string[]
