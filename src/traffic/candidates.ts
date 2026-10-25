/**
 * `docpilot traffic candidates` — golden-record CANDIDATES from the turn log.
 *
 * PURE. Same rule as `docpilot feedback pull`, and for the same reason: a
 * `gold_answer` is something a person writes, and an `expect` is a judgement.
 * So every row here is shaped like a golden.jsonl record, carries
 * `needsReview: true` and `source: 'traffic'`, has NO `gold_answer`, and is
 * written to a file that is not golden.jsonl.
 *
 * STRATIFIED, NOT RANKED. Production failures cluster: one missing page can
 * produce forty refusals in a week. Taking the top N would fill the review file
 * with forty paraphrases of one gap and none of the other nine, and a golden set
 * built from that measures one page. So questions are clustered, each cluster
 * gives at most `perCluster` rows, and `limit` is filled round-robin across
 * clusters, largest first.
 */

import {normalise} from '../theme/docpilot/text.js'
import {clusterTurns, type DfDoc} from './cluster.js'
import {INFRA, goldenIndex, inGolden, pageOfId, verdictOf, type Turn} from './turns.js'

/** What made a turn worth a golden record, strongest first. */
export const SIGNALS = [
  'down-voted',
  'not-answerable',
  'refused',
  'answered without citations',
  'low support',
  'up-voted',
] as const

const SKIP = new Set(['social', 'credential', 'opener', 'results', ...INFRA])

/** The failure (or confirmation) signal of one turn, or null when it has none. */
export function signalOf(t: Turn): (typeof SIGNALS)[number] | null {
  if (SKIP.has(t.outcome)) return null
  const v = verdictOf(t)
  if (v === 'down') return 'down-voted'
  if (t.outcome === 'not-answerable') return 'not-answerable'
  if (t.outcome === 'refused') return 'refused'
  if (t.outcome !== 'answer') return null
  if (!(t.citations || []).length) return 'answered without citations'
  if (t.tentative === true || (typeof t.support === 'number' && t.support < 0.5)) return 'low support'
  if (v === 'up') return 'up-voted'
  return null
}

const rank = (t: Turn) => SIGNALS.indexOf(signalOf(t) as any)

function suggestExpect(t: Turn, why: string): {expect: string; expectOptions: string[]; note: string} {
  const retrieved = (t.retrievedIds || []).length > 0
  if (why === 'refused') {
    const cause = t.refusal === 'out-of-scope' ? 'refuse:out-of-scope' : 'refuse:no-evidence'
    return {
      expect: cause,
      expectOptions: [cause, 'answer'],
      note:
        'the gate refused — a SUGGESTION only. If the docs do cover this, it is "answer" and the gate over-refused; ' +
        'if they do not, write the page or keep the refusal.',
    }
  }
  if (why === 'not-answerable' && !retrieved) {
    return {
      expect: 'refuse:no-evidence',
      expectOptions: ['refuse:no-evidence', 'answer'],
      note: 'nothing was retrieved and the model declined — a suggested refusal, unless a page should cover it',
    }
  }
  const notes: Record<string, string> = {
    'down-voted': 'answered and disputed — needs a gold_answer before it can measure anything',
    'not-answerable': 'pages were retrieved and the model declined — write the answer the docs support',
    'answered without citations': 'an answer that cites nothing — check whether the docs support it',
    'low support': 'a tentative or weakly supported answer — check it against the cited pages',
    'up-voted': 'confirmed positive — gold_chunks are the chunks the reader accepted',
  }
  return {expect: 'answer', expectOptions: ['answer'], note: notes[why] || ''}
}

export interface CandidateOptions {
  golden?: any[]
  existing?: any[]
  df?: DfDoc | null
  paths?: Map<string, string> | null
  perCluster?: number
  limit?: number | null
}

export function trafficCandidates(turns: Turn[], opts: CandidateOptions = {}) {
  const {golden = [], existing = [], df = null, paths = null, perCluster = 3, limit = null} = opts
  const gi = goldenIndex(golden)
  const known = new Set<string>()
  const knownIds = new Set<string>()
  for (const c of existing || []) {
    if (typeof c?.question === 'string') known.add(normalise(c.question))
    if (c?.messageId) knownIds.add(c.messageId)
  }

  const counts = {
    turns: turns.length,
    noSignal: 0,
    inGolden: 0,
    alreadyCandidate: 0,
    duplicate: 0,
    capped: 0,
    limited: 0,
    written: 0,
  }

  // One turn per normalised question — the strongest signal, then the latest.
  const best = new Map<string, Turn>()
  for (const t of turns) {
    if (!signalOf(t)) {
      counts.noSignal++
      continue
    }
    if (inGolden(t.question, gi)) {
      counts.inGolden++
      continue
    }
    const key = normalise(t.question)
    if (!key) {
      counts.noSignal++
      continue
    }
    if (known.has(key) || knownIds.has(t.messageId)) {
      counts.alreadyCandidate++
      continue
    }
    const prev = best.get(key)
    if (!prev) best.set(key, t)
    else {
      counts.duplicate++
      if (rank(t) < rank(prev) || (rank(t) === rank(prev) && t.at > prev.at)) best.set(key, t)
    }
  }

  const pool = [...best.values()].sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at))
  const clusters = clusterTurns(pool, {df, paths, prefix: 'tc'})

  // gold_chunks: what readers accepted for this cluster's questions.
  const accepted = (members: Turn[]) => [
    ...new Set(members.filter((t) => verdictOf(t) === 'up').flatMap((t) => t.citations || [])),
  ]

  const picked: Array<{turn: Turn; cluster: string; size: number; gold: string[]}>[] = clusters.map((c) => {
    const ordered = [...c.turns].sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at))
    counts.capped += Math.max(0, ordered.length - perCluster)
    const gold = accepted(c.turns).slice(0, 5)
    return ordered.slice(0, perCluster).map((turn) => ({turn, cluster: c.id, size: c.count, gold}))
  })

  // Round-robin across clusters, largest first, until `limit`.
  const chosen: typeof picked[number] = []
  for (let round = 0; picked.some((p) => p.length > round); round++) {
    for (const p of picked) if (p[round]) chosen.push(p[round])
  }
  const kept = limit != null && limit >= 0 ? chosen.slice(0, limit) : chosen
  counts.limited = chosen.length - kept.length

  let next = 0
  for (const c of existing || []) {
    const m = /^tr-(\d+)$/.exec(String(c?.id || ''))
    if (m) next = Math.max(next, Number(m[1]))
  }

  const candidates = kept.map(({turn: t, cluster, size, gold}) => {
    const why = signalOf(t)
    const {expect, expectOptions, note} = suggestExpect(t, why)
    next++
    const own = verdictOf(t) === 'up' ? t.citations || [] : []
    return {
      id: `tr-${String(next).padStart(4, '0')}`,
      question: t.question,
      expect,
      expectOptions,
      gold_chunks: [...new Set([...own, ...(expect === 'answer' ? gold : [])])].slice(0, 5),
      needsReview: true,
      promoted: false,
      source: 'traffic',
      messageId: t.messageId,
      conversationId: t.conversationId ?? null,
      why,
      note,
      cluster,
      clusterSize: size,
      at: t.at,
      lang: t.lang ?? null,
      scope: t.scope ?? {kind: 'all', paths: []},
      outcome: t.outcome,
      refusal: t.refusal ?? null,
      verdict: verdictOf(t),
      reasons: t.feedback?.reasons || [],
      retrievedPages: [...new Set((t.retrievedIds || []).map((id) => pageOfId(id, paths)))].slice(0, 5),
      promptHash: t.promptHash ?? null,
      indexHash: t.indexHash ?? null,
    }
  })
  counts.written = candidates.length
  return {candidates, counts, clusters: clusters.length}
}
