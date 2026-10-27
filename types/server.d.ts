/**
 * `@cloflin/docpilot/server` — the turn on the owner's server (engine-spec 028).
 *
 * Use with `runtime: 'server'` in the `docPilot` settings. The handler answers
 * `GET {server.endpoint}/manifest`, `GET {server.endpoint}/metrics` (2.0) and
 * `POST {server.endpoint}`; every other path is a 404 from `handle` and a
 * `next()` from `node`.
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
  /** 2.0 — the ranking the turn ran on, top eight, on the channel it won. */
  rankedIds?: string[]
  /** 2.0 — where the time went; `null` is "this stage did not run". */
  timing?: {
    embedMs: number | null
    embedRequests: number
    retrieveMs: number | null
    probeMs: number | null
    probeWaitMs: number | null
    loop: 'agentic' | 'one-shot' | null
    modelMs: number | null
    firstThoughtMs: number | null
    firstTokenMs: number | null
    totalMs: number
  }
  /** 2.0 — prior answers in the request that carried this server's signature. */
  historySigned?: number
  /** 2.0 — the answer quoted the owner's private instructions and was withheld. */
  leakBlocked?: boolean
  /** 2.0 — served from `server.cache.answers`. */
  cached?: boolean
  /** Each site function call — engine-spec 038 — never its arguments or its reply. */
  tools?: Array<{ tool: string; ok: boolean; ms: number }>
  /** The citable ids those calls handed out, `tool:<name>:<n>`. */
  toolIds?: string[]
  messages?: Array<{ role: string; content: unknown }>
  error: string | null
}

/** `GET {endpoint}/metrics?format=json` — engine-spec 031. */
export interface MetricsSnapshot {
  kind: 'docpilot.metrics'
  v: 1
  startedAt: string
  now: string
  uptimeS: number
  model: string | null
  embedModel: string | null
  index: { hash: string | null; chunks: number | null }
  turns: { total: number; inFlight: number; byOutcome: Record<TurnRecord['outcome'], number> }
  latencyMs: { p50: number | null; p95: number | null; p99: number | null; count: number }
  ttftMs: { p50: number | null; p95: number | null; p99: number | null; count: number }
  stagesMs: Record<'embed' | 'retrieve' | 'rerank' | 'model', { p50: number | null; p95: number | null }>
  requests: { chat: number; embed: number; rerank: number }
  tokens: { prompt: number; output: number; cached: number }
  cache: { embedHits: number; embedMisses: number; answerHits: number; answerMisses: number }
  limits: { rateLimited: number; rejected: number }
  perMinute: number[]
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
  /**
   * Web-standard handler: Node 20+, Bun, Deno, Workers, edge functions. `info`
   * carries what a `Request` cannot: the client's address, for the limiter and
   * for loopback-only metrics. Without it every request is one client.
   */
  handle(request: Request, info?: { remoteAddress?: string | null } | null): Promise<Response>
  /** `node:http` / Express / Connect middleware. */
  node(req: any, res: any, next?: (err?: unknown) => void): Promise<void>
  endpoint: string
  /** The in-memory counters behind `/metrics`. */
  metrics: { snapshot(extra?: Record<string, unknown>): MetricsSnapshot; prometheus(extra?: Record<string, unknown>): string }
  /** The shell the panel receives: pages and sections, no thresholds or corpus. */
  manifest(): { version: number; hash: string; chunkCount: number; pages: unknown[]; sections: unknown[]; orphanPages: string[] }
}

export function createDocPilotServer(options: DocPilotServerOptions): Promise<DocPilotServer>

/** Delete turn-log day files older than `days`. Returns the names removed. */
export function prune(dir: string, days: number, now?: Date): string[]
