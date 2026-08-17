/**
 * Metric functions — RAG-SPEC 5.
 *
 * Pure and deterministic. No LLM judge anywhere: a metric that needs a model to
 * compute cannot be a gate, because it moves when the judge does.
 */

import { detectLanguage } from '../theme/docpilot/prompt.js'

// ── 5.1 retrieval ────────────────────────────────────────────────────────────

export function retrievalF1(retrievedIds, goldIds) {
  const R = new Set(retrievedIds)
  const G = new Set(goldIds)
  if (!G.size) return { p: 0, r: 0, f1: 0 }
  let hit = 0
  for (const id of R) if (G.has(id)) hit++
  const p = R.size ? hit / R.size : 0
  const r = hit / G.size
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 }
}

/**
 * Gold chunks may be given as page paths; a chunk id starts with its path.
 *
 * The prefix has to end on a separator. A bare `startsWith` made the gold page
 * `guide/scope` match `guide/scoped-page#anchor`, which is a different page —
 * so retrieval F1, recall@k, MRR and citation precision were all being credited
 * for chunks the answer could not have used. The runtime is strict about this
 * (`retriever.js` scopes by exact path), and a metric that is more generous than
 * the thing it measures reports a system that does not exist.
 */
export function matchesGold(id, gold) {
  return gold.some((g) => underPath(id, g))
}

/**
 * Is `id` the path `prefix`, or something beneath it?
 *
 * The one place the boundary rule lives, so the four call sites that need it
 * cannot drift apart: a chunk id is `<page>#<anchor>`, a nested page is
 * `<page>/<child>`, and anything else that merely shares leading characters —
 * `guide/scoped-page` under `guide/scope` — is a different page.
 */
export function underPath(id, prefix) {
  const p = String(prefix).replace(/\/+$/, '')
  return id === p || id.startsWith(`${p}#`) || id.startsWith(`${p}/`)
}

export function retrievalF1Loose(retrievedIds, gold) {
  const hit = retrievedIds.filter((id) => matchesGold(id, gold)).length
  const covered = gold.filter((g) => retrievedIds.some((id) => matchesGold(id, [g]))).length
  const p = retrievedIds.length ? hit / retrievedIds.length : 0
  const r = gold.length ? covered / gold.length : 0
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 }
}

/**
 * Recall@k over a ranked list. F1 alone cannot tell "the right chunk ranked 9th"
 * from "the right chunk is not in the corpus", and those two have opposite fixes:
 * one is an RRF-weight problem, the other a chunking or authoring problem.
 */
export function recallAtK(rankedIds, gold, k = 10) {
  if (!gold.length) return null
  const top = rankedIds.slice(0, k)
  const covered = gold.filter((g) => top.some((id) => matchesGold(id, [g]))).length
  return covered / gold.length
}

/** Reciprocal rank of the first gold hit; 0 when none is present. */
export function mrr(rankedIds, gold) {
  if (!gold.length) return null
  for (let i = 0; i < rankedIds.length; i++) {
    if (matchesGold(rankedIds[i], gold)) return 1 / (i + 1)
  }
  return 0
}

/** A chunk id's page: ids are `<path-without-leading-slash>#<anchor>`. */
export function pageOf(id) {
  return `/${String(id).split('#')[0]}`
}

/**
 * RAG-SPEC 5.4 — a HARD gate at 1.0. Every id handed to the model must belong to
 * a page inside the turn's frozen scope. `gate2()` already enforces this inside
 * the retriever; measuring it here is what proves the enforcement ran, rather
 * than trusting that it did.
 */
export function scopeContainment(retrievedIds, scope) {
  if (!retrievedIds.length) return null
  if (!scope || scope.kind === 'all' || !scope.paths?.length) return 1
  const allow = new Set(scope.paths)
  return retrievedIds.filter((id) => allow.has(pageOf(id))).length / retrievedIds.length
}

// ── 5.2 answer ───────────────────────────────────────────────────────────────

/** SQuAD normalisation: lowercase, strip punctuation, drop articles, collapse. */
export function normaliseAnswer(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenF1(pred, gold) {
  const P = normaliseAnswer(pred).split(' ').filter(Boolean)
  const G = normaliseAnswer(gold).split(' ').filter(Boolean)
  if (!P.length || !G.length) return 0
  const count = (arr) => arr.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map())
  const cp = count(P)
  const cg = count(G)
  let overlap = 0
  for (const [t, n] of cp) overlap += Math.min(n, cg.get(t) || 0)
  if (!overlap) return 0
  const p = overlap / P.length
  const r = overlap / G.length
  return (2 * p * r) / (p + r)
}

/** Exact-match recall of the identifiers a human marked as load-bearing. */
export function identifierRecall(answer, identifiers) {
  if (!identifiers?.length) return null
  const hit = identifiers.filter((id) => String(answer).includes(id)).length
  return hit / identifiers.length
}

// ── language ─────────────────────────────────────────────────────────────────

/**
 * The product promises an answer in the language of the question, and the whole
 * corpus is English — so this is the one metric whose failure mode is invisible
 * to every other metric here: an English answer to a Russian question scores
 * perfectly on token-F1 against an English gold answer.
 */
export function languageMatch(question, answer) {
  const want = detectLanguage(question)
  const got = detectLanguage(stripCode(answer))
  if (!want || !got) return null
  return want === got ? 1 : 0
}

/** Code, identifiers and paths stay in their own language and must not vote. */
function stripCode(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\/[\w./-]+/g, ' ')
}

// ── citations ────────────────────────────────────────────────────────────────

export function citationPrecision(cited, gold) {
  if (!cited.length) return null
  return cited.filter((id) => matchesGold(id, gold)).length / cited.length
}

export function hallucinatedCitationRate(cited, observed) {
  if (!cited.length) return 0
  const seen = new Set(observed)
  return cited.filter((id) => !seen.has(id)).length / cited.length
}

// ── statistics ───────────────────────────────────────────────────────────────

/**
 * One-sided upper Wilson bound. A point estimate on a small probe set is one
 * probe wide, so a 2% bound would literally mean "at most two may fail" — the
 * bound makes the claim honest about the sample it was measured on.
 */
export function wilsonUpper95(failures, n) {
  if (!n) return 1
  const z = 1.6449
  const p = failures / n
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.min(1, (centre + margin) / denom)
}

export function mean(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
}

export function percentile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.floor(v.length * q))]
}
