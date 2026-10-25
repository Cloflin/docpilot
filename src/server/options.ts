/**
 * The server-only half of `docPilot.server` — engine-specs 031 and 033.
 *
 * `server.endpoint` is the one key both halves read: the panel posts to it and
 * the handler answers on it, so it lives in `config.ts` and crosses into
 * themeConfig. Everything here is the OPERATOR's — limits, deadlines, caches,
 * who may read the metrics — and none of it may reach a reader's page, so it is
 * resolved here, in the module only Node imports, and `themeDocPilot` never
 * sees it.
 *
 * DEFAULTS ARE ON, AND CONSERVATIVE. A server install answers on a port with
 * no proxy in front (that is what `docpilot serve` and the Docker image do), so
 * the safe value is the shipped value: a per-client rate, a daily count, a
 * concurrency cap and a whole-turn deadline. `limits: false` is how a deployment
 * that has a proxy doing this says so.
 */

import type { LimitSettings } from './limits.js'

export interface ServerOperatorSettings {
  /** `true` (default): loopback, or a bearer token when one is set. `false`: no route. */
  metrics?: boolean | { token?: string | null }
  limits?: LimitSettings | false
  /** Proxy hops whose `X-Forwarded-For` entry may name the client. Default none. */
  trustProxy?: boolean | number
  /** The whole turn, request to settle. A local 8B answers in under a minute. */
  turnTimeoutMs?: number
  /** One embedding request, retries included. */
  embedTimeoutMs?: number
  cache?: {
    /** Query vectors kept, by (model, text). `0`/`false` keeps none. */
    embeddings?: number | false
    /** Whole first-turn answers. Off unless set. */
    answers?: false | { ttlMs?: number; max?: number }
  }
  /** Origins allowed to POST a turn. Default: the request's own host only. */
  allowedOrigins?: string[] | null
}

export const SERVER_DEFAULTS = {
  metrics: true,
  limits: { perMinute: 10, burst: 10, perDay: 500, concurrent: 16, perClient: 3 },
  trustProxy: false,
  turnTimeoutMs: 300000,
  embedTimeoutMs: 20000,
  cache: { embeddings: 1000, answers: false as false | { ttlMs: number; max: number } },
  allowedOrigins: null as string[] | null,
}

const positive = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt)

export interface ServerOptions {
  metrics: false | { token: string | null }
  limits: false | LimitSettings
  trustProxy: boolean | number
  turnTimeoutMs: number
  embedTimeoutMs: number
  cache: { embeddings: number; answers: false | { ttlMs: number; max: number } }
  allowedOrigins: string[] | null
}

export function resolveServerOptions(
  server: ServerOperatorSettings = {},
  env: Record<string, string | undefined> = {},
): ServerOptions {
  const s = server || {}
  const token = (typeof s.metrics === 'object' && s.metrics?.token) || env.DOCPILOT_METRICS_TOKEN || null
  const limits =
    s.limits === false
      ? false
      : { ...SERVER_DEFAULTS.limits, ...(typeof s.limits === 'object' ? s.limits : {}) }
  const answers = s.cache?.answers
  return {
    metrics: s.metrics === false ? false : { token },
    limits,
    trustProxy: s.trustProxy ?? SERVER_DEFAULTS.trustProxy,
    turnTimeoutMs: positive(s.turnTimeoutMs, SERVER_DEFAULTS.turnTimeoutMs),
    embedTimeoutMs: positive(s.embedTimeoutMs, SERVER_DEFAULTS.embedTimeoutMs),
    cache: {
      embeddings:
        s.cache?.embeddings === false ? 0 : positive(s.cache?.embeddings, SERVER_DEFAULTS.cache.embeddings),
      answers: answers
        ? { ttlMs: positive(answers.ttlMs, 3600000), max: positive(answers.max, 500) }
        : false,
    },
    allowedOrigins: Array.isArray(s.allowedOrigins) ? s.allowedOrigins.map(String) : null,
  }
}
