/**
 * `docpilot.turn/1` records — read, validated, joined to their votes.
 *
 * PURE. No fs, no network, no clock. `cli.ts` reads the files; this module only
 * decides what a line means. Engine-spec 028 §3 is the format.
 *
 * NEVER A SILENT DROP. A bad line is counted and named, and the count reaches
 * the summary every command prints. A log written by a server that crashed
 * mid-line has one torn record at the end of a day file, and that record must
 * cost one line of the report, not the whole run — and not zero lines either,
 * because a count nobody sees is the bug class this package keeps meeting.
 */

import {dedupe} from '../feedback/aggregate.js'
import {normalise, terms} from '../theme/docpilot/text.js'

export const TURN_KIND = 'docpilot.turn'
export const TURN_VERSION = 1

/** Every `outcome` a turn can settle with, in the order a report prints them. */
export const OUTCOMES = [
  'answer',
  'opener',
  'refused',
  'not-answerable',
  'social',
  'credential',
  'results',
  'error',
  'aborted',
  'rate-limited',
]

/** Outcomes that say something about the CORPUS, not about the infrastructure. */
export const CONTENT_FAILURES = ['refused', 'not-answerable']
/** Outcomes that say nothing about the corpus: the turn never finished. */
export const INFRA = ['error', 'aborted', 'rate-limited']

export interface Feedback {
  verdict: 'up' | 'down' | null
  reasons: string[]
  comment: string | null
  revision: number
}

export interface Turn {
  kind: string
  v: number
  at: string
  messageId: string
  conversationId?: string | null
  question: string
  quote?: string | null
  lang?: string | null
  scope?: {kind?: string; paths?: string[]} | null
  depth?: number
  outcome: string
  refusal?: string | null
  gate?: Record<string, any> | null
  retrievedIds?: string[]
  emitted?: string[]
  citations?: string[]
  answer?: string | null
  summary?: string | null
  confidence?: string | number | null
  support?: number | null
  tentative?: boolean | null
  iterations?: number | null
  requests?: number | null
  latencyMs?: number | null
  usage?: {promptTokens?: number; outputTokens?: number; cachedTokens?: number} | null
  model?: string | null
  provider?: string | null
  embedModel?: string | null
  indexHash?: string | null
  promptHash?: string | null
  messages?: Array<Record<string, any>>
  error?: string | null
  /** Joined by `joinFeedback`; absent when nobody voted. */
  feedback?: Feedback | null
}

export interface Malformed {
  file?: string
  line: number | null
  why: string
}

/** Why a record is not a `docpilot.turn/1`, or null when it is one. */
export function validateTurn(r: any): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object'
  if (r.kind !== TURN_KIND) return `kind is ${JSON.stringify(r.kind)}, not "${TURN_KIND}"`
  if (r.v !== TURN_VERSION) return `v is ${JSON.stringify(r.v)}, this reader knows ${TURN_VERSION}`
  if (typeof r.messageId !== 'string' || !r.messageId) return 'no messageId'
  if (typeof r.question !== 'string') return 'no question'
  if (!OUTCOMES.includes(r.outcome)) return `unknown outcome ${JSON.stringify(r.outcome)}`
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return 'no parseable "at"'
  for (const k of ['retrievedIds', 'emitted', 'citations']) {
    if (r[k] != null && !Array.isArray(r[k])) return `${k} is not an array`
  }
  if (r.messages != null && !Array.isArray(r.messages)) return 'messages is not an array'
  return null
}

export interface RowEntry {
  row: any
  line: number | null
  file?: string
}

/** JSONL, or a JSON array — sniffed like `parseRows`, but a bad line is counted, never thrown. */
export function splitRows(text: string, file?: string): {rows: RowEntry[]; malformed: Malformed[]} {
  const rows: RowEntry[] = []
  const malformed: Malformed[] = []
  const tag = file ? {file} : {}
  const s = String(text || '').trim()
  if (s[0] === '[') {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) arr.forEach((row, i) => rows.push({row, line: i + 1, ...tag}))
      else malformed.push({...tag, line: null, why: 'a JSON document that is not an array'})
    } catch (e) {
      malformed.push({...tag, line: null, why: `a JSON array that does not parse — ${e.message}`})
    }
  } else if (s) {
    for (const [i, line] of s.split('\n').entries()) {
      const t = line.trim()
      if (!t) continue
      try {
        rows.push({row: JSON.parse(t), line: i + 1, ...tag})
      } catch {
        malformed.push({...tag, line: i + 1, why: 'not JSON'})
      }
    }
  }
  return {rows, malformed}
}

/**
 * Text, parsed rows, or `splitRows` output → valid turns plus every reason a
 * row was not one.
 *
 * A messageId logged twice keeps the LAST record and counts the rest as
 * duplicates — a retried write is the ordinary way that happens.
 */
export function parseTurns(input: string | any[] | {rows: RowEntry[]; malformed: Malformed[]}): {
  turns: Turn[]
  malformed: Malformed[]
  duplicates: number
  total: number
} {
  const split =
    typeof input === 'string'
      ? splitRows(input)
      : Array.isArray(input)
        ? {rows: input.map((row, i) => ({row, line: i + 1}) as RowEntry), malformed: []}
        : {rows: input?.rows || [], malformed: [...(input?.malformed || [])]}
  const malformed: Malformed[] = [...split.malformed]
  const total = split.rows.length + split.malformed.length

  const byId = new Map<string, Turn>()
  let duplicates = 0
  for (const {row, line, file} of split.rows) {
    const why = validateTurn(row)
    if (why) {
      malformed.push(file ? {file, line, why} : {line, why})
      continue
    }
    if (byId.has(row.messageId)) {
      duplicates++
      byId.delete(row.messageId)
    }
    byId.set(row.messageId, row)
  }
  return {turns: [...byId.values()], malformed, duplicates, total}
}

/** Turns at or after `since` (YYYY-MM-DD, UTC). `null` keeps everything. */
export function sinceFilter(turns: Turn[], since: string | null): Turn[] {
  if (!since) return turns
  const floor = Date.parse(`${since}T00:00:00Z`)
  if (!Number.isFinite(floor)) return turns
  return turns.filter((t) => Date.parse(t.at) >= floor)
}

/**
 * Votes → onto the turns they were cast on, by `messageId`.
 *
 * The receiver is told to upsert on messageId with the highest revision winning
 * (docs/guide/production.md); a receiver that stored every revision is repaired
 * here by `dedupe`, the same function `docpilot feedback` uses. A withdrawn vote
 * is `verdict: null` under a raised revision, and it is joined as exactly that:
 * a retraction, not an up-vote and not a missing row.
 */
export function joinFeedback(turns: Turn[], rows: any[] = []): {
  turns: Turn[]
  joined: number
  orphans: number
  rows: number
} {
  const latest = new Map<string, any>()
  for (const r of dedupe(rows || [])) latest.set(r.messageId, r)
  let joined = 0
  const out = turns.map((t) => {
    const r = latest.get(t.messageId)
    if (!r) return t
    joined++
    latest.delete(t.messageId)
    const verdict = r.verdict === 'up' || r.verdict === 'down' ? r.verdict : null
    return {
      ...t,
      feedback: {
        verdict,
        reasons: Array.isArray(r.reasons) ? r.reasons : [],
        comment: typeof r.comment === 'string' ? r.comment : null,
        revision: Number(r.revision) || 0,
      },
    }
  })
  return {turns: out, joined, orphans: latest.size, rows: (rows || []).length}
}

// ── text helpers shared by traffic and dataset ─────────────────────────────

export const verdictOf = (t: Turn) => t.feedback?.verdict ?? null

/** A failure about content: refused, not answerable, or a reader said no. */
export const failed = (t: Turn) =>
  CONTENT_FAILURES.includes(t.outcome) || (verdictOf(t) === 'down' && !INFRA.includes(t.outcome))

/** The stemmed content terms of a question, as a set — the index's own tokenizer. */
export const termList = (s: string): string[] => terms(String(s || '')) as string[]
export const termSet = (s: string) => new Set<string>(termList(s))

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** The scope a question was asked in, as a stable key. */
export const scopeKey = (t: Turn) =>
  `${t.scope?.kind || 'all'}:${[...(t.scope?.paths || [])].sort().join(',')}`

/**
 * The page a chunk id belongs to. With the index loaded the chunk's own `path`
 * answers; without it the id is read: `guide/production#the-body` →
 * `/guide/production`, `features/index#x` → `/features`.
 */
export function pageOfId(id: string, paths?: Map<string, string> | null): string {
  const known = paths?.get(id)
  if (known) return known
  const base = String(id).split('#')[0].replace(/(^|\/)index$/, '')
  return '/' + base.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Golden questions as lookup keys — normalised text and term sets — so both
 * commands exclude by the same test.
 */
export function goldenIndex(golden: any[] = []) {
  const norms = new Set<string>()
  const sets: Set<string>[] = []
  for (const g of golden || []) {
    if (typeof g?.question !== 'string') continue
    norms.add(normalise(g.question))
    sets.push(termSet(g.question))
  }
  return {norms, sets}
}

/** Does `question` match a golden one — the same text, or ≥ `tau` term overlap? */
export function inGolden(question: string, gi: ReturnType<typeof goldenIndex>, tau = 0.8): boolean {
  if (gi.norms.has(normalise(question))) return true
  const s = termSet(question)
  if (!s.size) return false
  return gi.sets.some((g) => jaccard(s, g) >= tau)
}

/** `<think>…</think>` out, and a dangling opening tag with everything after it. */
export function stripThink(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim()
}
