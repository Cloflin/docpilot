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
/**
 * Does a chunk id fall under a gold entry — RAG-SPEC 5.1.
 *
 * THREE SHAPES OF GOLD, and the middle one was silently broken.
 *
 *   `guide/auth`            a bare page path. Matches that page's chunks and the
 *                           chunks of pages nested under it, and NOT a sibling
 *                           whose route merely extends the string: `guide/scope`
 *                           must not swallow `guide/scoped-page`. That boundary
 *                           is why this function exists at all.
 *   `guide/auth#`           a PAGE-LEVEL PIN. The authoring rule is stated in
 *                           `skills/docs-rag/SKILL.md`: "pin it to the lead chunk
 *                           `path#`, which prefix-matches every anchor of that
 *                           page and nothing else" — the shape a class-overview
 *                           question is supposed to use.
 *   `guide/auth#request`    one section.
 *
 * The bug: `id === p || startsWith(p + '#') || startsWith(p + '/')` gave the page
 * pin no meaning at all. For `ExtensionBuilder#` it matched the lead chunk and
 * nothing else, because `p + '#'` is `ExtensionBuilder##`, which no id begins
 * with. Fourteen of the 33 distinct gold entries in the development golden set
 * are page pins or split sections, and the 14 covering the reference pages point
 * at pages of 3 to 14 chunks each — so retrieving the right page and the right
 * section scored a miss unless the retriever happened to return the lead chunk.
 * Measured over the 44 answerable records: **recall@8 0.761 → 0.830**, English
 * 0.797 → 0.859, Russian 0.667 → 0.750. Every retrieval metric this package
 * reported was understated by about seven points, and the gap against the
 * ancestor project's own reports — which use a boundary-free `startsWith` and
 * were therefore right about page pins and wrong about siblings — was read as
 * the ancestor being generous rather than as this being broken.
 *
 * A SPLIT SECTION IS THE SAME SECTION — AND `-N` IS NOT HOW IT IS SPELLED.
 * `chunker.js` gives the second and later parts of one heading the ids
 * `#anchor~2`, `#anchor~3`, so gold pinned to `#anchor` must accept those.
 *
 * The TILDE is the whole point. Continuations used to be `-N`, which is also how
 * VitePress — and `chunker.js`, matching it — disambiguates a REPEATED HEADING:
 * the second `### Parameters` on a page is `#parameters-1`, the third
 * `#parameters-2`. One namespace, two meanings, so this rule credited gold
 * pinned at `api/users#parameters` for a retrieval of `api/users#parameters-1`,
 * which is a DIFFERENT endpoint's Parameters section and could not have carried
 * the answer. That scored `recallAtK` 1 and `retrievalF1Loose` {p:1,r:1,f1:1} on
 * a miss, inflating recall@8, MRR, retrieval F1 and citation precision together
 * — and since `docpilot tune` sweeps against exactly that objective, it steered
 * the levers toward the wrong section. It was also the precise over-generosity
 * the paragraph at the top of this block says this function exists to prevent.
 * `~` cannot come out of `slug()` (it sits in the character class `slug()`
 * strips), so nothing but a continuation part ever wears one.
 *
 * The suffix rule stays restricted to gold that already names an anchor: a bare
 * path must never match a sibling page via a numeric suffix.
 *
 * Gold pinned at a continuation part changes spelling with the ids — an entry
 * reading `#actions-api-3` now matches nothing, which is what `docpilot lint`
 * reports and how such entries are found and repointed.
 */
export function underPath(id, prefix) {
  const p = String(prefix).replace(/\/+$/, '')
  if (p.endsWith('#')) return id.startsWith(p)
  if (id === p) return true
  if (!id.startsWith(p)) return false
  const rest = id.slice(p.length)
  if (rest.startsWith('#') || rest.startsWith('/')) return true
  return p.includes('#') && /^~\d+$/.test(rest)
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

/**
 * How much of the gold the citations COVER — the other half of the pair above.
 *
 * `citationPrecision` divides by how many citations the ANSWERER chose, so at
 * |gold| = 1 the same retrieval scores 1.00 or 0.33 depending on how terse the
 * answer was. That makes it a statement about restraint, not about whether the
 * evidence the reader needs was named at all, and the skill has said "read
 * citationRecall beside it, always" while nothing here computed one.
 *
 * Per gold entry, mirroring the `covered` arm of `retrievalF1Loose`, so a page
 * pin `path#` counts as covered by any anchor of that page and a sibling route
 * cannot cover it. An answer with no citations covers nothing and scores 0 —
 * `null` is reserved for a record that pinned no gold to cover.
 */
export function citationRecall(cited, gold) {
  if (!gold?.length) return null
  return gold.filter((g) => cited.some((id) => matchesGold(id, [g]))).length / gold.length
}

export function hallucinatedCitationRate(cited, observed) {
  if (!cited.length) return 0
  const seen = new Set(observed)
  return cited.filter((id) => !seen.has(id)).length / cited.length
}

// ── failure taxonomy ─────────────────────────────────────────────────────────

/**
 * Below this, an answer that had its evidence in front of it is not an answer.
 *
 * Read against the ceiling `tokenF1` carries: a 25-word gold against a 150-word
 * answer caps P at ~0.29 whatever the model writes, so this is a floor on the
 * INSTRUMENT, not a quality bar. Records under it are the ones where the
 * evidence was primed and the answer still shares almost nothing with the gold —
 * a different failure from a retrieval miss, and it has a different fix.
 */
export const LOW_ANSWER_F1 = 0.25

/**
 * Which failure a row is — RAG-SPEC 5, the diagnosis half.
 *
 * The metric table says how much moved; it never says WHAT moved, and the four
 * buckets below have four different fixes that no summary number separates:
 *
 *   `retrieval-miss`      the gold is not in the ranked eight at all — a corpus,
 *                         chunking or vocabulary problem.
 *   `gold-below-primed`   the gold IS in the ranked eight and did not make the
 *                         window the model was primed with — a `GATE_K` and
 *                         ranking problem, and the one a `tune` sweep can reach.
 *   `primed-low-f1`       the evidence was in front of the model and the answer
 *                         still missed — an answer-side problem: the prompt, the
 *                         model, or a gold_answer written at the wrong length.
 *   `over-refused`        the gate admitted it and the turn refused anyway.
 *
 * PURE, and a function of the row alone. `retrieval.r` is the share of the gold
 * covered by the chunks that PRIMED the turn; `recall8` is the same share over
 * the ranked eight. The gap between those two is the whole distinction between
 * the first two buckets, which is why both are recorded per row.
 */
export function classifyRow(row) {
  if (!row || row.observed === 'error') return 'error'

  const negative = String(row.expect || '').startsWith('refuse') || row.scoredAsNegative
  if (negative) {
    return String(row.observed || '').startsWith('refuse')
      ? 'neg-caught'
      : `neg-answered:${row.expect}`
  }

  if (!String(row.observed || '').startsWith('answer')) return 'over-refused'

  // A record with no gold to find cannot miss it; it is scored on its answer.
  const primed = row.retrieval?.r
  if (typeof primed === 'number' && primed === 0) {
    return row.recall8 ? 'gold-below-primed' : 'retrieval-miss'
  }

  if (typeof row.answerF1 === 'number' && row.answerF1 < LOW_ANSWER_F1) return 'primed-low-f1'
  return 'ok'
}

/** Every bucket, in the order a reader should meet them. Report column order. */
export const TAXONOMY_ORDER = [
  'ok',
  'gold-below-primed',
  'retrieval-miss',
  'primed-low-f1',
  'over-refused',
  'neg-caught',
  'neg-answered',
  'error',
]

/**
 * The language a record is asked in, as ONE name whatever the source said.
 *
 * The record's own `lang` wins where an author wrote one — a claim about intent
 * that a detector cannot make — and detection fills in for every golden file
 * that predates the field, which is all of this package's own.
 *
 * THE TWO SOURCES DO NOT SPEAK THE SAME LANGUAGE, and merging them naively is a
 * report with `ru` and `Russian` as separate rows over one population: golden
 * files write the ISO code, `detectLanguage` returns the English name. The code
 * is widened into the name rather than the other way round, because the name is
 * what the panel already says to the model in `languageDirective` and there is
 * no reverse table to keep in step. `Intl.DisplayNames` is the widening — a tag
 * it cannot resolve comes back as itself, so an unknown or already-spelled-out
 * value passes through instead of being dropped.
 */
let displayNames = null
export function langOf(rec) {
  const declared = rec?.lang
  // Only a TAG is widened. `Intl.DisplayNames` accepts anything that parses as
  // one and answers `russian` for the string `Russian` — lowercasing a name that
  // was already correct — so a value that is not a 2-3 letter primary subtag is
  // taken as already spelled out and returned untouched.
  if (declared && /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(declared)) {
    if (!displayNames) {
      try {
        displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
      } catch {
        displayNames = { of: (x) => x }
      }
    }
    try {
      return displayNames.of(declared) || declared
    } catch {
      return declared
    }
  }
  if (declared) return declared
  return detectLanguage(rec?.question || '') || 'und'
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

/**
 * The two hard gates, as a VERDICT rather than as two printed lines.
 *
 * RAG-SPEC 5.5 says a hallucinated citation "fails the whole run regardless of
 * every other metric", and 5.4 says the same of scope containment below 1.0.
 * `run.js` printed both sentences and then exited 0, so nothing downstream could
 * act on either: `lint`, `calibrate` and `doctor` all exit 1 on their own
 * failures, and this was the one command whose failure a script could not see. A
 * gate that cannot fail a build is a comment.
 *
 * It lives here, beside the metrics it reads, because this module is the one
 * that is pure by contract — and the thing that decides pass/fail is exactly what
 * must not be reachable only by running the whole eval.
 *
 * NULL IS NOT A FAILURE, and the distinction is the whole of the logic. A
 * `--gate-only` pass runs no model, so no citation exists to be checked and
 * `hallucinated` is null; a run with nothing retrieved leaves `scopeContainment`
 * null the same way. Only a measured breach fails.
 */
export function hardGatesFailed(summary) {
  const s = summary || {}
  const hallucinated = typeof s.hallucinated === 'number' && s.hallucinated > 0
  const escaped = typeof s.scopeContainment === 'number' && s.scopeContainment < 1
  return hallucinated || escaped
}
