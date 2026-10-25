/**
 * The index manifest → an llms.txt.
 *
 * The manifest already holds what the file needs: every page's route and title,
 * and its sidebar group (`tail`) in sidebar order (`sections[].pageIdx`). So the
 * file is grouped the way the site's own sidebar is, and ordered the way a
 * reader would walk it — introduction first, reference later, the changelog in
 * `## Optional`, which the spec reserves for links an agent may skip.
 *
 * Pure. Descriptions come in as a map because finding them means reading
 * source files (the CLI's job); the chunks only carry them inline.
 */

import type {ManifestPage} from './lint.js'

export interface BuildOptions {
  manifest: {pages?: ManifestPage[]; sections?: {label: string; pageIdx?: number[]; depth?: number}[]}
  /** page path → one-sentence description (frontmatter `description`). */
  descriptions?: Record<string, string>
  title?: string | null
  summary?: string | null
  /** Published origin and base, e.g. https://docs.example.com/ — makes URLs absolute. */
  site?: string | null
  /** Link `<path>.md` instead of the rendered route. */
  md?: boolean
  /** Characters a note may keep. */
  noteChars?: number
}

const INTRO = /intro|overview|get(?:ting)?[\s-]*started|quick[\s-]*start|start here|basics/i
const GUIDE = /guide|tutorial|how[\s-]*to|concept|feature|understanding|usage/i
const REFERENCE = /reference|\bapi\b|cli|config|options|schema/i
const OPTIONAL = /changelog|release|migrat|history|archive|legacy|deprecated/i

const rankOf = (label: string) =>
  INTRO.test(label) ? 0 : GUIDE.test(label) ? 1 : REFERENCE.test(label) ? 3 : 2

const isOptional = (label: string, pages: ManifestPage[]) =>
  OPTIONAL.test(label) || pages.every((p) => OPTIONAL.test(p.path.split('/').pop() || ''))

/** Collapse whitespace and cut at a word boundary. */
export function trimNote(s: string | null | undefined, n = 120): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const cut = t.slice(0, n - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—-]+$/, '')}…`
}

const escName = (s: string) => s.replace(/([\[\]\\])/g, '\\$1')
const escUrl = (s: string) => s.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')

/** A page route → the URL the file links. */
export function pageUrl(path: string, o: {site?: string | null; md?: boolean} = {}): string {
  let p = path.startsWith('/') ? path : `/${path}`
  if (o.md) p = p === '/' || p.endsWith('/') ? `${p}index.md` : `${p.replace(/\.html$/, '')}.md`
  if (!o.site) return escUrl(p)
  return escUrl(`${o.site.replace(/\/+$/, '')}${p}`)
}

const firstSegment = (p: string) => p.split('/').filter(Boolean)[0] || 'Pages'
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function buildLlmsTxt(o: BuildOptions): string {
  const all = o.manifest.pages ?? []
  const pages = all.map((p, i) => ({p, i})).filter(({p}) => !p.external || p.route)
  const desc = o.descriptions ?? {}
  const n = o.noteChars ?? 120

  // Sidebar order: the order pages first appear in `sections`, then the rest.
  const order = new Map<number, number>()
  for (const s of o.manifest.sections ?? []) for (const i of s.pageIdx ?? []) if (!order.has(i)) order.set(i, order.size)
  const pos = (i: number) => order.get(i) ?? order.size + i

  const groups = new Map<string, {label: string; first: number; pages: {p: ManifestPage; i: number}[]}>()
  for (const e of pages) {
    const label = e.p.tail || (e.p.kind ? titleCase(e.p.kind) : titleCase(firstSegment(e.p.path)))
    const g = groups.get(label) ?? {label, first: Infinity, pages: []}
    g.first = Math.min(g.first, pos(e.i))
    g.pages.push(e)
    groups.set(label, g)
  }

  const main: {label: string; first: number; pages: {p: ManifestPage; i: number}[]}[] = []
  const optional: {p: ManifestPage; i: number}[] = []
  for (const g of groups.values()) {
    if (g.label.toLowerCase() === 'optional' || isOptional(g.label, g.pages.map((x) => x.p))) optional.push(...g.pages)
    else main.push(g)
  }
  main.sort((a, b) => rankOf(a.label) - rankOf(b.label) || a.first - b.first)

  const title =
    o.title?.trim() ||
    all.find((p) => /^\/(index|introduction)?$/.test(p.path))?.title ||
    all[0]?.title ||
    'Documentation'
  const summary =
    o.summary?.trim() || desc['/'] || desc['/index'] || desc['/introduction'] || ''

  const item = ({p}: {p: ManifestPage}, heading: string) => {
    const route = p.external ? (p.route as string) : p.path
    const note = trimNote(desc[p.path] || (p.tail && p.tail !== heading ? p.tail : ''), n)
    return `- [${escName(p.title || route)}](${pageUrl(route, o)})${note ? `: ${note}` : ''}`
  }

  const out: string[] = [`# ${title.replace(/\s+/g, ' ')}`, '']
  if (summary) out.push(`> ${summary.replace(/\s+/g, ' ').trim()}`, '')
  const byPos = (a: {i: number}, b: {i: number}) => pos(a.i) - pos(b.i)
  for (const g of main) {
    out.push(`## ${g.label}`, '')
    for (const e of [...g.pages].sort(byPos)) out.push(item(e, g.label))
    out.push('')
  }
  if (optional.length) {
    out.push('## Optional', '')
    for (const e of [...optional].sort(byPos)) out.push(item(e, 'Optional'))
    out.push('')
  }
  return `${out.join('\n').trimEnd()}\n`
}
