/**
 * Group failed questions into the gaps they point at.
 *
 * PURE. Greedy single pass, deterministic in input order: a question joins the
 * first cluster whose head it overlaps by term Jaccard ≥ `tau`, or shares a
 * RARE term with — a term the corpus has in at most `rareShare` of its chunks,
 * or does not have at all. The second rule is the one that finds a gap: two
 * readers asking about "webhooks" in different words share almost nothing
 * except the one word the docs never use.
 *
 * NOT `faq.ts`'s `clusterQuestions`. That one groups what an opener would catch
 * at `matchTau`, and it filters refused questions OUT on purpose — the opposite
 * population from this one.
 */

import {jaccard, termSet, pageOfId, type Turn} from './turns.js'

export interface DfDoc {
  n: number
  df: Record<string, number>
}

export interface Cluster {
  id: string
  head: string
  terms: string[]
  turns: Turn[]
  count: number
  /** Pages the retriever returned for these questions, most often first. */
  closest: Array<{page: string; count: number}>
}

/** Rare in the corpus, or absent from it. Without a df nothing is rare. */
export function rareTerms(set: Set<string>, df: DfDoc | null, rareShare = 0.01): Set<string> {
  if (!df?.df || !df.n) return new Set()
  const out = new Set<string>()
  for (const t of set) {
    if (t.length < 4) continue
    const n = df.df[t] ?? 0
    if (n / df.n <= rareShare) out.add(t)
  }
  return out
}

export function clusterTurns(
  turns: Turn[],
  {
    df = null,
    tau = 0.5,
    rareShare = 0.01,
    paths = null,
    prefix = 'gap',
  }: {df?: DfDoc | null; tau?: number; rareShare?: number; paths?: Map<string, string> | null; prefix?: string} = {},
): Cluster[] {
  const groups: Array<{head: Turn; set: Set<string>; rare: Set<string>; turns: Turn[]}> = []
  for (const t of turns) {
    const set = termSet(t.question)
    const rare = rareTerms(set, df, rareShare)
    const near = groups.find(
      (g) => jaccard(g.set, set) >= tau || [...rare].some((r) => g.rare.has(r)),
    )
    if (near) {
      near.turns.push(t)
      for (const r of rare) near.rare.add(r)
      continue
    }
    groups.push({head: t, set, rare, turns: [t]})
  }
  return groups
    .map((g) => {
      const pages = new Map<string, number>()
      for (const t of g.turns) {
        const seen = new Set((t.retrievedIds || []).map((id) => pageOfId(id, paths)))
        for (const p of seen) pages.set(p, (pages.get(p) || 0) + 1)
      }
      return {
        head: g.head.question,
        terms: [...g.set],
        turns: g.turns,
        count: g.turns.length,
        closest: [...pages.entries()]
          .map(([page, count]) => ({page, count}))
          .sort((a, b) => b.count - a.count || a.page.localeCompare(b.page))
          .slice(0, 3),
      }
    })
    .sort((a, b) => b.count - a.count || a.head.localeCompare(b.head))
    .map((c, i) => ({id: `${prefix}-${String(i + 1).padStart(3, '0')}`, ...c}))
}
