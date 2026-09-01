/**
 * Feedback rows → one candidate per question the readers actually asked.
 *
 * PURE. No fs, no network, no clock — the caller stamps time and writes files,
 * for the same reason `src/eval/metrics.js` is pure: this is the part worth
 * testing, and it is only testable if it is the part that touches nothing.
 *
 * ONE ROW PER MESSAGE, then one candidate per question. Both collapses matter:
 * a down-vote with a comment arrives twice under one `messageId` — the thumb,
 * then the form — and counting both would inflate the volume of exactly the
 * questions that got a sentence written about them, which are the ones a
 * reviewer is most likely to act on. The receiver is told to upsert; a receiver
 * that stored every revision instead is repaired here.
 */

import {suggest} from './stratum.js'
import {normalise} from '../theme/docpilot/text.js'

/**
 * The grouping key, and it lives in text.js now.
 *
 * It was defined here, and then the indexer needed the same key to stamp a baked
 * opener with (`build-rag-index.js`) and the panel needed it to match against
 * that stamp (`theme/docpilot/openers.js`). Three copies of the function that
 * decides whether two typings are ONE question is three chances for two of them
 * to disagree, and the disagreement would be silent: candidates that fail to
 * merge, or an opener that fails to fire.
 *
 * Re-exported rather than only imported, because this module's own consumers —
 * `report.js`, `cli.js` and the tests — already import it from here.
 */
export {normalise}

/** Highest revision wins, per messageId. */
export function dedupe(rows) {
  const best = new Map()
  for (const r of rows) {
    if (!r || typeof r.question !== 'string' || !r.messageId) continue
    const prev = best.get(r.messageId)
    if (!prev || (r.revision ?? 0) >= (prev.revision ?? 0)) best.set(r.messageId, r)
  }
  return [...best.values()]
}

const tally = (map, key) => {
  if (key == null) return
  map.set(String(key), (map.get(String(key)) || 0) + 1)
}
const obj = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]))
const top = (map) => {
  let best = null
  let n = -1
  for (const [k, v] of map) if (v > n) [best, n] = [k, v]
  return best
}

function quantiles(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
  return {p50: at(0.5), min: s[0], max: s[s.length - 1]}
}

/**
 * @param {object[]} rows raw feedback records
 * @returns {object[]} candidates, sorted by normalised question
 */
export function aggregate(rows) {
  const groups = new Map()

  for (const r of dedupe(rows)) {
    const key = normalise(r.question)
    if (!key) continue
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        question: r.question,
        variants: new Set(),
        messageIds: [],
        sessions: new Set(),
        conversations: new Set(),
        up: 0,
        down: 0,
        reasons: new Map(),
        comments: [],
        refusals: new Map(),
        channels: new Map(),
        antecedents: new Map(),
        modes: new Map(),
        scopes: new Map(),
        models: new Map(),
        G: [],
        taus: [],
        ns: [],
        wouldPassUnscoped: 0,
        degraded: 0,
        // Numbers or nothing. `pull` reads "anything", and a source that hands
        // back an ISO string here used to seed the group with one — after which
        // `Math.min(string, number)` on the next row is NaN, and `iso` below
        // threw RangeError out of the whole report.
        firstSeen: typeof r.ts === 'number' ? r.ts : null,
        lastSeen: typeof r.ts === 'number' ? r.ts : null,
      }
      groups.set(key, g)
    }

    g.variants.add(r.question)
    g.messageIds.push(r.messageId)
    if (r.sessionId) g.sessions.add(r.sessionId)
    if (r.conversationId) g.conversations.add(r.conversationId)
    if (r.verdict === 'up') g.up++
    if (r.verdict === 'down') g.down++
    for (const reason of r.reasons || []) tally(g.reasons, reason)
    if (r.comment) g.comments.push(r.comment)
    // `null` is a real outcome — the turn answered — and counting it is what
    // makes "refused 11 times out of 14" readable.
    tally(g.refusals, r.refusal ?? 'none')
    tally(g.scopes, r.scope?.kind || 'all')
    if (r.model) tally(g.models, r.model)
    if (r.gate) {
      tally(g.channels, r.gate.channel)
      // What the composed channel composed WITH. `null` is a real value here —
      // a first turn has no antecedent at all — and counting it is what makes
      // "composed 9 times, 7 of them from a quote" readable.
      tally(g.antecedents, r.gate.antecedent ?? 'none')
      tally(g.modes, r.gate.mode)
      // A lexical-only turn is either an embedder that stopped answering or the
      // mode the site was built in, and `mode` is the same string for both. A
      // record written before the panel said which can only be the outage —
      // that was the only way the mode existed then — so an absent value counts
      // as one rather than quietly joining the declared population.
      if (r.gate.mode === 'lexical-only' && (r.gate.degraded ?? true)) g.degraded++
      if (typeof r.gate.G === 'number') g.G.push(r.gate.G)
      if (typeof r.gate.tau === 'number') g.taus.push(r.gate.tau)
      if (typeof r.gate.n === 'number') g.ns.push(r.gate.n)
      if (r.gate.wouldPassUnscoped) g.wouldPassUnscoped++
    }
    if (typeof r.ts === 'number') {
      g.firstSeen = Math.min(g.firstSeen ?? r.ts, r.ts)
      g.lastSeen = Math.max(g.lastSeen ?? r.ts, r.ts)
    }
  }

  return [...groups.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((g, i) => finish(g, i))
}

function finish(g, i) {
  const voted = g.up + g.down
  const G = quantiles(g.G)
  const tau = quantiles(g.taus)
  const modes = obj(g.modes)
  const gate = g.G.length
    ? {
        G,
        tau: tau?.p50 ?? null,
        marginP50: G && tau ? round(G.p50 - tau.p50) : null,
        channel: obj(g.channels),
        antecedent: obj(g.antecedents),
        mode: modes,
        degraded: g.degraded,
        nP50: quantiles(g.ns)?.p50 ?? null,
        wouldPassUnscoped: g.wouldPassUnscoped,
      }
    : null

  const candidate: Record<string, any> = {
    id: `fb-${String(i + 1).padStart(4, '0')}`,
    question: g.question,
    variants: [...g.variants],
    asked: g.messageIds.length,
    voted,
    up: g.up,
    down: g.down,
    downRate: voted ? round(g.down / voted) : null,
    sessions: g.sessions.size,
    reasons: obj(g.reasons),
    comments: g.comments,
    refusals: obj(g.refusals),
    gate,
    scope: {kind: top(g.scopes) || 'all', counts: obj(g.scopes)},
    model: top(g.models),
    firstSeen: iso(g.firstSeen),
    lastSeen: iso(g.lastSeen),
    conversationIds: [...g.conversations],
    sourceIds: g.messageIds,
  }

  // The shape `suggest` reads: the modal outcome of this question, not any one
  // record of it.
  const refusal = top(g.refusals)
  const verdict = g.down > g.up ? 'down' : g.up > 0 ? 'up' : null
  const {target, stratum, stratumOptions, expect, needsReview, note} = suggest({
    gate: gate && {
      G: gate.G?.p50 ?? null,
      tau: gate.tau,
      mode: top(g.modes),
      // Without this the lexical-only branch in stratum.js cannot tell a broken
      // embedder from a site that never had one, and this projection is a
      // whitelist: a field it does not name does not exist as far as `suggest`
      // is concerned.
      degraded: g.degraded > 0,
      channel: top(g.channels),
      // Without this the quoted-turn branch in stratum.js can never fire: this
      // projection is a whitelist, and a field it does not name does not exist
      // as far as `suggest` is concerned.
      antecedent: top(g.antecedents),
      wouldPassUnscoped: g.wouldPassUnscoped > 0,
    },
    refusal: refusal === 'none' ? null : refusal,
    verdict,
    reasons: Object.keys(candidate.reasons),
    scope: candidate.scope,
  })

  candidate.target = target
  candidate.stratum = stratum
  candidate.stratumOptions = stratumOptions
  if (expect) candidate.expect = expect
  candidate.needsReview = needsReview
  candidate.promoted = false
  candidate.note = note
  return candidate
}

const round = (n) => Math.round(n * 1000) / 1000
// `Number.isFinite`, not `typeof === 'number'`: NaN passes the second test and
// then `new Date(NaN).toISOString()` throws rather than returning anything.
const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : null)

/**
 * A re-pull must not undo a review.
 *
 * `stratum`, `target`, `expect`, `promoted` and `note` are the columns a human
 * edits, and a run that reset them would resurface finished work every time —
 * which is a file nobody opens twice. Counts and gate statistics are refreshed
 * from the new data, because those are the point of running it again.
 */
export function merge(existing = [], fresh = []) {
  const byKey = new Map(existing.map((c) => [normalise(c.question), c]))
  const out = fresh.map((c) => {
    const prior = byKey.get(normalise(c.question))
    if (!prior) return c
    byKey.delete(normalise(c.question))
    // TOUCHED BY A PERSON, not merely written by a previous run. A stratum this
    // file suggested last time is not a review — treating it as one would let
    // the first run silently clear the review flag on everything it guessed at,
    // which is the opposite of what the flag is for. The signals are: the row
    // says something different from what would be suggested now, or somebody
    // cleared `needsReview`, or it is already promoted.
    const edited =
      !!prior.promoted ||
      prior.needsReview === false ||
      prior.target !== c.target ||
      (prior.stratum ?? null) !== (c.stratum ?? null) ||
      (prior.expect ?? null) !== (c.expect ?? null)
    return {
      ...c,
      id: prior.id,
      target: edited ? prior.target : c.target,
      stratum: edited ? (prior.stratum ?? null) : c.stratum,
      ...(edited && prior.expect ? {expect: prior.expect} : c.expect ? {expect: c.expect} : {}),
      promoted: !!prior.promoted,
      // An edited row stops asking. An untouched one keeps the fresh suggestion,
      // which may have moved: more votes can change what the signals say.
      needsReview: edited ? false : c.needsReview,
      note: edited ? prior.note : c.note,
    }
  })
  // A question nobody asked this time still had work done on it. Dropping it
  // would delete a reviewer's decision because the sample moved.
  for (const orphan of byKey.values()) {
    if (orphan.promoted || orphan.needsReview === false) out.push(orphan)
  }
  return renumber(out).sort((a, b) =>
    a.question < b.question ? -1 : a.question > b.question ? 1 : 0,
  )
}

/**
 * Make the ids unique again after a merge.
 *
 * Fresh candidates are numbered by their position in THIS pull, while a row that
 * matched a prior one keeps the prior id — so the two schemes collide as soon as
 * the sample changes. Concretely: {apple: fb-0001, banana: fb-0002} reviewed,
 * then a pull returning {banana, cherry} numbers them fb-0001 and fb-0002,
 * banana takes back fb-0002 from its prior, and cherry is still fb-0002. The
 * duplicate is then written to candidates.jsonl and inherited by every later
 * run, so a reviewer promoting "fb-0002" has two rows to choose from.
 *
 * Reviewed rows keep their ids — that is what a reviewer refers to. Only the
 * unclaimed ones move, and they move above the highest id in use.
 */
function renumber(rows) {
  const taken = new Set()
  const free = []
  // Reviewed rows claim first, so a collision is always resolved against the row
  // nobody has referred to yet.
  const reviewed = (r) => !!r.promoted || r.needsReview === false
  for (const row of [...rows].sort((a, b) => Number(reviewed(b)) - Number(reviewed(a)))) {
    if (row.id && !taken.has(row.id)) taken.add(row.id)
    else free.push(row)
  }
  let next = 0
  for (const id of taken) {
    const n = /^fb-(\d+)$/.exec(String(id))
    if (n) next = Math.max(next, Number(n[1]))
  }
  for (const row of free) {
    let id
    do {
      next++
      id = `fb-${String(next).padStart(4, '0')}`
    } while (taken.has(id))
    taken.add(id)
    row.id = id
  }
  return rows
}
