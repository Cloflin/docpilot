/**
 * Findings → the edits worth making, most records first — engine-spec 035.
 *
 * One item per (cause, page): five questions that miss the dead-letter page for
 * want of the word "DLQ" are one edit, not five. Each item says what to change,
 * in which file, and which records will prove it — so an author, or the tuning
 * agent, can make the edit and know what to re-measure.
 *
 * THE LEVERS, and which cause each answers:
 *
 *   describe-page      vocabulary-gap → the page's description in llms.txt and
 *                      its frontmatter, written in the readers' words; for a
 *                      question in another language, `docpilot vocabulary`
 *   alias              vocabulary-gap → a `vocabulary.json` entry mapping the
 *                      reader's term to the page's
 *   retitle-section    ranking → the heading says what the section answers
 *   summarise-section  not-primed, structure → an `<llm-only>` line at the top
 *                      of the section stating the answer whole
 *   tune               not-primed across many pages → `docpilot tune` (GATE_K)
 *   investigate        generation, false-refusal, answered-negative → not the
 *                      corpus: the prompt, the model, or the guard
 *
 * The plan NEVER proposes new product behaviour. A record whose answer is not
 * in the docs is a content gap, and the fix for a content gap is a person who
 * knows the product writing the page — or the record becoming a negative.
 */

import type { Cause, Finding } from './diagnose.js'

export type Lever = 'describe-page' | 'alias' | 'retitle-section' | 'summarise-section' | 'tune' | 'investigate'

export interface PlanItem {
  id: string
  lever: Lever
  cause: Cause
  page: string | null
  records: string[]
  /** Reader terms the page lacks, most frequent first (describe-page, alias). */
  terms?: string[]
  languages?: string[]
  outranking?: string[]
  unseen?: string[]
  /** One sentence: what to change. */
  action: string
  /** Where the change goes. */
  files: string[]
}

const LEVER_OF: Record<Cause, Lever> = {
  'vocabulary-gap': 'describe-page',
  ranking: 'retitle-section',
  'not-primed': 'summarise-section',
  structure: 'summarise-section',
  generation: 'investigate',
  'false-refusal': 'investigate',
  'answered-negative': 'investigate',
}

/** A route → its markdown source under `docsDir`, the way the indexer maps them. */
const sourceOf = (docsDir, page) =>
  page === '/' ? `${docsDir}/index.md` : page.endsWith('/') ? `${docsDir}${page}index.md` : `${docsDir}${page}.md`

export function planOf(findings: Finding[], { docsDir = 'docs', llmsFile = null as string | null } = {}): PlanItem[] {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    const page = f.pages[0] ?? null
    const key = `${f.cause}\u0000${page}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }

  const items: PlanItem[] = []
  for (const [, fs] of groups) {
    const f0 = fs[0]
    const page = f0.pages[0] ?? null
    const lever = LEVER_OF[f0.cause]
    const records = fs.map((f) => f.record)
    const languages = [...new Set(fs.map((f) => f.lang).filter(Boolean))]
    const foreign = languages.some((l) => !/^en/i.test(String(l)))
    const item: PlanItem = { id: '', lever, cause: f0.cause, page, records, action: '', files: [] }

    if (f0.cause === 'vocabulary-gap') {
      const counts = new Map<string, number>()
      for (const f of fs) for (const t of f.missingTerms || []) counts.set(t, (counts.get(t) || 0) + 1)
      item.terms = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 12)
      item.languages = languages
      item.action = foreign
        ? `Readers ask about ${page} in ${languages.join(', ')}; propose aliases with \`docpilot vocabulary --languages=${languages.join(',')}\`, and add the English words they translate to the page's description.`
        : `Rewrite ${page}'s description in the readers' words — they ask with "${item.terms.slice(0, 5).join('", "')}", which the page never uses.`
      item.files = [llmsFile, sourceOf(docsDir, page)].filter(Boolean)
    } else if (f0.cause === 'ranking') {
      item.outranking = [...new Set(fs.flatMap((f) => f.outranking || []))].slice(0, 4)
      item.action = `${page} has the words but ${item.outranking.join(', ') || 'other pages'} rank above it; make the answering section's heading name what it answers, and its first sentence state it.`
      item.files = [sourceOf(docsDir, page)]
    } else if (f0.cause === 'not-primed') {
      item.action = `${page} ranks in the top eight but not the five the model is primed with; add a one-line <llm-only> summary at the top of the answering section, or run \`docpilot tune\` if many pages share this.`
      item.files = [sourceOf(docsDir, page)]
    } else if (f0.cause === 'structure') {
      item.unseen = [...new Set(fs.flatMap((f) => f.unseen || []))]
      item.action = `The answer on ${page} is split across ${item.unseen.join(', ')}; add an <llm-only> summary to the first section that states the whole answer.`
      item.files = [sourceOf(docsDir, page)]
    } else {
      item.action =
        f0.cause === 'answered-negative'
          ? 'Questions the docs cannot answer were answered: read the answers for invented facts; consider guard.mode "calibrated" after `docpilot calibrate`.'
          : f0.cause === 'false-refusal'
            ? `The evidence for ${page} reached the model and it refused; read the turn — a prompt or model matter, not a corpus one.`
            : `The evidence for ${page} reached the model whole and the answer was still weak; compare models or the prompt — not a corpus edit.`
    }
    items.push(item)
  }

  // Too many not-primed pages is one lever, not N section summaries.
  const notPrimed = items.filter((i) => i.cause === 'not-primed')
  if (notPrimed.length >= 4) {
    items.push({
      id: '',
      lever: 'tune',
      cause: 'not-primed',
      page: null,
      records: notPrimed.flatMap((i) => i.records),
      action: `${notPrimed.length} pages rank in the eight and miss the primed five: run \`docpilot tune\` to measure a larger GATE_K before editing sections one by one.`,
      files: [],
    })
  }

  const corpusFirst = (i: PlanItem) => (i.lever === 'investigate' ? 1 : 0)
  items.sort((a, b) => corpusFirst(a) - corpusFirst(b) || b.records.length - a.records.length)
  items.forEach((i, n) => (i.id = `P${n + 1}`))
  return items
}
