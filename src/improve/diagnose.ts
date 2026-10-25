/**
 * Why a golden record failed, from the report alone — engine-spec 035.
 *
 * `eval` says THAT a record failed and, in its taxonomy, roughly where. What an
 * author needs is the edit: which page, which words, which section. Everything
 * that edit depends on is already in a report row and the index — the ranked
 * eight, the primed five, the gold pins, the chunk text — so the diagnosis is
 * deterministic, costs no model call and gives the same answer twice. The
 * WRITING of the edit is not deterministic and is not done here: that is the
 * author's, or the tuning agent's (spec 036).
 *
 * ONE CAUSE PER FAILURE, checked in the order a turn spends its evidence:
 *
 *   vocabulary-gap   the gold was not in the ranked eight, and most of the
 *                    question's words never occur in the gold text — the
 *                    reader's words are not the page's
 *   ranking          not in the ranked eight, though the words are there —
 *                    another page outranks it
 *   not-primed       in the eight but not in the five the model is primed with
 *   structure        primed, answered badly, and the gold spans chunks the
 *                    turn did not all see — the answer is split across sections
 *   generation       primed, whole, and answered badly anyway: prompt or model,
 *                    not the corpus
 *   false-refusal    primed and refused
 *   answered-negative  a question the docs cannot answer, answered
 */

import { LOW_ANSWER_F1, matchesGold } from '../eval/metrics.js'

export type Cause =
  | 'vocabulary-gap'
  | 'ranking'
  | 'not-primed'
  | 'structure'
  | 'generation'
  | 'false-refusal'
  | 'answered-negative'

export interface Finding {
  record: string
  cause: Cause
  question: string
  lang: string | null
  /** The gold's page(s), route form (`/guides/retries`). */
  pages: string[]
  /** Question terms the gold text never contains (vocabulary-gap). */
  missingTerms?: string[]
  /** The pages that ranked above the gold (ranking). */
  outranking?: string[]
  /** Gold chunks the turn never saw (structure). */
  unseen?: string[]
  /** The row's own numbers, for the plan's evidence line. */
  numbers: Record<string, number | null>
}

/** At least this share of a question's terms missing from the gold text is a vocabulary gap. */
export const VOCAB_GAP_SHARE = 0.5

const pageOfId = (id) => `/${String(id).split('#')[0]}`

export interface DiagnoseInput {
  rows: any[]
  /** Golden records by id — the report rows do not carry `gold_chunks` or `identifiers`. */
  records: Map<string, any>
  /** Every chunk of the index the report measured. */
  chunks: { id: string; text: string }[]
  /** The tokenizer the index was built with (`terms` from text.ts). */
  terms: (s: string) => string[]
  /** `meta.gateOnly`: no model ran, so only the retrieval causes can be named. */
  gateOnly?: boolean
}

export function diagnose({ rows, records, chunks, terms, gateOnly = false }: DiagnoseInput): Finding[] {
  const out: Finding[] = []
  for (const row of rows) {
    const rec = records.get(row.id)
    if (!rec) continue
    const numbers = {
      recall8: row.recall8 ?? null,
      mrr: row.mrr ?? null,
      answerF1: row.answerF1 ?? null,
      identifierRecall: row.identifierRecall ?? null,
      citationRecall: row.citationRecall ?? null,
    }
    const base = { record: row.id, question: rec.question, lang: rec.lang || null, numbers }

    const negative = String(rec.expect).startsWith('refuse') || row.scoredAsNegative
    if (negative) {
      if (row.observed === 'answer' && !gateOnly) out.push({ ...base, cause: 'answered-negative', pages: [] })
      continue
    }

    const gold = rec.gold_chunks || []
    if (!gold.length) continue
    const ranked = row.rankedIds || []
    const primed = row.retrievedIds || []
    const goldPages: string[] = [...new Set<string>(gold.map((g) => `/${String(g).split('#')[0]}`))]
    const inRanked = ranked.some((id) => matchesGold(id, gold))
    const inPrimed = primed.some((id) => matchesGold(id, gold))
    const answered = row.observed === 'answer'
    const scoredAnswer = typeof row.answerF1 === 'number'
    const weakAnswer =
      scoredAnswer &&
      (row.answerF1 < LOW_ANSWER_F1 ||
        (typeof row.identifierRecall === 'number' && row.identifierRecall < 0.8) ||
        (typeof row.citationRecall === 'number' && row.citationRecall < 0.5))

    if (!inRanked) {
      const goldText = chunks.filter((c) => matchesGold(c.id, gold)).map((c) => c.text).join('\n')
      const have = new Set(terms(goldText))
      const asked: string[] = [...new Set<string>(terms(rec.question))]
      const missing = asked.filter((t) => !have.has(t))
      if (asked.length && missing.length / asked.length >= VOCAB_GAP_SHARE) {
        out.push({ ...base, cause: 'vocabulary-gap', pages: goldPages, missingTerms: missing })
      } else {
        const above: string[] = [...new Set<string>(ranked.map(pageOfId))].filter((p) => !goldPages.includes(p)).slice(0, 3)
        out.push({ ...base, cause: 'ranking', pages: goldPages, outranking: above })
      }
      continue
    }
    if (!inPrimed) {
      out.push({ ...base, cause: 'not-primed', pages: goldPages })
      continue
    }
    if (!answered && !gateOnly && row.observed !== 'error') {
      out.push({ ...base, cause: 'false-refusal', pages: goldPages })
      continue
    }
    if (weakAnswer) {
      const seen = new Set([...primed, ...(row.citations || [])])
      const unseen: string[] = gold.filter((g) => ![...seen].some((id) => matchesGold(id, [g])))
      out.push(
        gold.length > 1 && unseen.length
          ? { ...base, cause: 'structure', pages: goldPages, unseen }
          : { ...base, cause: 'generation', pages: goldPages },
      )
    }
  }
  return out
}
