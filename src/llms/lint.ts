/**
 * The lint rules for llms.txt, and the coverage check against the index.
 *
 * Every finding carries a rule id, a severity, a line (null when it is about the
 * file as a whole) and a fix. Severity follows the spec's own words:
 *
 *   error   the spec says MUST or the file fails at its one job — no H1, two
 *           H1s, a list item an agent cannot follow.
 *   warn    allowed by the grammar but costs the reader — no summary, a
 *           relative URL, a page the index has and the file does not link.
 *   info    a recommendation — `.md` versions of pages, an llms-full.txt.
 *
 * Pure. The CLI reads files and fetches URLs; this module reads a string and a
 * manifest object.
 */

import {parseLlmsTxt, type ParsedLlms} from './parse.js'
import {printable} from '../build/lib/terminal.js'

export type Severity = 'error' | 'warn' | 'info'

export interface Finding {
  rule: string
  severity: Severity
  line: number | null
  message: string
  fix: string
  /** Extra items a finding is about — the unlinked pages, for example. */
  items?: string[]
}

/** ~100 KB. The file is an index meant to fit a context window beside a question. */
export const MAX_BYTES = 100 * 1024
/** Notes are one line about a link, not the page itself. */
export const MAX_NOTES = 200

export const RULES: Record<string, {severity: Severity; summary: string}> = {
  'h1-missing': {severity: 'error', summary: 'no H1 — the one required section'},
  'h1-duplicate': {severity: 'error', summary: 'more than one H1'},
  'h1-not-first': {severity: 'error', summary: 'content before the H1'},
  'summary-missing': {severity: 'warn', summary: 'no blockquote summary after the H1'},
  'summary-late': {severity: 'warn', summary: 'the blockquote comes after body text'},
  'body-heading': {severity: 'warn', summary: 'H3+ heading before the first H2'},
  'section-heading': {severity: 'warn', summary: 'H3+ heading inside a file list'},
  'item-format': {severity: 'error', summary: 'list item is not `[name](url)`'},
  'item-separator': {severity: 'warn', summary: 'notes not introduced by `:`'},
  'section-prose': {severity: 'warn', summary: 'non-list text inside a file list'},
  'section-empty': {severity: 'warn', summary: 'H2 section with no links'},
  'section-duplicate': {severity: 'warn', summary: 'two H2 sections share a name'},
  'url-duplicate': {severity: 'warn', summary: 'the same URL is linked twice'},
  'url-relative': {severity: 'warn', summary: 'relative URL'},
  'link-not-md': {severity: 'info', summary: 'link is not to a .md version'},
  'notes-long': {severity: 'warn', summary: `notes longer than ${MAX_NOTES} characters`},
  'file-size': {severity: 'warn', summary: `file larger than ${MAX_BYTES / 1024} KB`},
  'optional-misplaced': {severity: 'info', summary: '## Optional is not the last section'},
  'full-missing': {severity: 'info', summary: 'no llms-full.txt beside it'},
  'page-unlinked': {severity: 'warn', summary: 'indexed pages the file does not link'},
  'link-not-indexed': {severity: 'warn', summary: 'link to a path that is not an indexed page'},
}

const f = (rule: string, line: number | null, message: string, fix: string, items?: string[]): Finding => ({
  rule,
  severity: RULES[rule].severity,
  line,
  message,
  fix,
  ...(items ? {items} : {}),
})

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** The origin most absolute links share — the site, when `--site` was not given. */
export function dominantOrigin(parsed: ParsedLlms): string | null {
  const counts = new Map<string, number>()
  for (const s of parsed.sections)
    for (const it of s.items) {
      try {
        if (!/^https?:/i.test(it.url)) continue
        const o = new URL(it.url).origin
        counts.set(o, (counts.get(o) ?? 0) + 1)
      } catch {}
    }
  let best: string | null = null
  let n = 0
  for (const [o, c] of counts) if (c > n) [best, n] = [o, c]
  return best
}

const originOf = (site?: string | null): string | null => {
  if (!site) return null
  try {
    return new URL(site).origin
  } catch {
    return null
  }
}

/** Is a URL on the documented site (relative, or same origin)? */
const onSite = (url: string, origin: string | null) => {
  if (!ABSOLUTE.test(url)) return true
  if (!origin) return false
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/**
 * @param text the llms.txt content
 * @param o.site the published origin (and base), e.g. https://docs.example.com/
 * @param o.fullPresent whether llms-full.txt sits beside it; null = unknown
 */
export function lintLlmsTxt(
  text: string,
  o: {site?: string | null; fullPresent?: boolean | null} = {},
): {parsed: ParsedLlms; findings: Finding[]} {
  const parsed = parseLlmsTxt(text)
  const out: Finding[] = []
  const origin = originOf(o.site) ?? dominantOrigin(parsed)

  if (!parsed.h1s.length) {
    out.push(f('h1-missing', 1, 'The file has no H1. It is the only section the spec requires.', 'Start the file with `# <project or site name>`.'))
  } else {
    if (parsed.preamble.length) {
      const first = parsed.preamble[0]
      out.push(f('h1-not-first', first.line, `${parsed.preamble.length} line(s) come before the H1, starting with "${clip(first.text, 60)}".`, 'Move the H1 to the top; only a byte-order mark may precede it.'))
    }
    for (const h of parsed.h1s.slice(1))
      out.push(f('h1-duplicate', h.line, `A second H1, "${clip(h.text, 60)}". The spec allows exactly one.`, 'Make it an H2 (`## `) if it starts a file list, or plain text if it does not.'))
  }

  if (parsed.h1s.length && !parsed.summary) {
    if (parsed.lateQuote)
      out.push(f('summary-late', parsed.lateQuote.line, 'The blockquote summary comes after other text.', 'Move the `> summary` directly under the H1.'))
    else
      out.push(f('summary-missing', parsed.h1s[0].line + 1, 'No blockquote summary under the H1.', 'Add `> one or two sentences on what this project is` under the H1 — it is the context an agent reads first.'))
  }

  for (const h of parsed.bodyHeadings)
    out.push(f('body-heading', h.line, `An H${h.level} ("${clip(h.text, 50)}") in the body. The body may hold any markdown except headings.`, 'Make it bold text, or an H2 if it starts a file list.'))

  const seenSections = new Map<string, number>()
  const seenUrls = new Map<string, number>()
  const nonMd: string[] = []
  let nonMdLine: number | null = null
  const relative: string[] = []
  let relativeLine: number | null = null

  parsed.sections.forEach((s, idx) => {
    const key = s.name.toLowerCase()
    if (seenSections.has(key))
      out.push(f('section-duplicate', s.line, `"## ${s.name}" also appears on line ${seenSections.get(key)}.`, 'Merge the two lists under one heading.'))
    else seenSections.set(key, s.line)

    if (key === 'optional' && idx !== parsed.sections.length - 1)
      out.push(f('optional-misplaced', s.line, '"## Optional" is not the last section. Agents that trim context drop it; readers expect it at the end.', 'Move `## Optional` to the end of the file.'))

    for (const h of s.subheadings)
      out.push(f('section-heading', h.line, `An H${h.level} ("${clip(h.text, 50)}") inside "## ${s.name}". File lists are flat: one H2, one list.`, 'Split it into its own `## ` section, or drop the heading.'))
    for (const b of s.badItems)
      out.push(f('item-format', b.line, `"${clip(b.raw.trim(), 70)}" is not a link item.`, 'Write each item as `- [name](url): optional notes`.'))
    for (const b of s.badSeparators)
      out.push(f('item-separator', b.line, `Text after the link is not introduced by ":" — "${clip(b.raw.trim(), 70)}".`, 'Write `- [name](url): notes`.'))
    for (const p of s.prose)
      out.push(f('section-prose', p.line, `Text in "## ${s.name}" that is not a list item: "${clip(p.text.trim(), 60)}".`, 'Move prose above the first H2, or make it a link item.'))
    if (!s.items.length && !s.badItems.length)
      out.push(f('section-empty', s.line, `"## ${s.name}" has no links.`, 'Add `- [name](url)` items or delete the heading.'))

    for (const it of s.items) {
      const norm = it.url.replace(/#.*$/, '')
      if (seenUrls.has(norm))
        out.push(f('url-duplicate', it.line, `${it.url} is already linked on line ${seenUrls.get(norm)}.`, 'Link each URL once; the duplicate costs context and says nothing new.'))
      else seenUrls.set(norm, it.line)

      if (!ABSOLUTE.test(it.url)) {
        relative.push(`L${it.line} ${it.url}`)
        relativeLine ??= it.line
      }
      if (onSite(it.url, origin) && !isMdOrTxt(it.url)) {
        nonMd.push(`L${it.line} ${it.url}`)
        nonMdLine ??= it.line
      }
      if (it.notes && it.notes.length > MAX_NOTES)
        out.push(f('notes-long', it.line, `Notes for "${clip(it.name, 40)}" are ${it.notes.length} characters.`, `Keep notes to one sentence (≤ ${MAX_NOTES}); the linked page carries the detail.`))
    }
  })

  if (relative.length)
    out.push(f('url-relative', relativeLine, `${relative.length} relative URL(s). An agent reads this file from somewhere else and cannot resolve them.`, 'Make every URL absolute — `docpilot llms build --site=https://docs.example.com` does it.', relative))
  if (nonMd.length)
    out.push(f('link-not-md', nonMdLine, `${nonMd.length} link(s) to rendered pages, not .md versions.`, 'The spec recommends a clean markdown copy at `<page>.md`; link that (`docpilot llms build --md`) and serve it as text/markdown.', nonMd))

  if (parsed.bytes > MAX_BYTES)
    out.push(f('file-size', null, `${Math.round(parsed.bytes / 1024)} KB. llms.txt is an index meant to fit a context window beside the question; the pages carry the content.`, 'Trim notes, move secondary links to `## Optional`, and put the full text in llms-full.txt.'))

  if (o.fullPresent === false)
    out.push(f('full-missing', null, 'No llms-full.txt beside it.', 'Optional, but common: one file with every page concatenated, for agents that load everything at once.'))

  return {parsed, findings: out}
}

const isMdOrTxt = (url: string) => /\.(md|txt)$/i.test(url.replace(/[?#].*$/, ''))

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * A link URL → a manifest page path, or null for a link off the site.
 *
 * Strips the origin, the base, `.html.md` / `.md` / `.html`, a trailing
 * `/index` and a trailing slash, so `https://docs.x.com/docs/guide/index.md`
 * and `/docs/guide/` both become `/guide` under base `/docs/`.
 */
export function toPagePath(url: string, o: {origin?: string | null; base?: string | null} = {}): string | null {
  let p: string
  if (ABSOLUTE.test(url)) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return null
    }
    if (!o.origin || u.origin !== o.origin) return null
    p = u.pathname
  } else {
    p = url.replace(/[?#].*$/, '')
  }
  try {
    p = decodeURI(p)
  } catch {}
  if (!p.startsWith('/')) p = `/${p}`
  const base = normBase(o.base)
  if (base !== '/' && (p === base.slice(0, -1) || p.startsWith(base))) p = `/${p.slice(base.length)}`
  return normPath(p)
}

/** The same normalisation for both sides, so a manifest `/guide/index` matches a link `/guide/`. */
export function normPath(p: string): string {
  let s = String(p || '/')
  s = s.replace(/\.html\.md$/i, '').replace(/\.md$/i, '').replace(/\.html$/i, '')
  s = s.replace(/\/index$/i, '/')
  if (s.length > 1) s = s.replace(/\/+$/, '')
  if (!s.startsWith('/')) s = `/${s}`
  return s
}

const normBase = (b?: string | null) => {
  let s = (b || '/').trim()
  if (!s.startsWith('/')) s = `/${s}`
  if (!s.endsWith('/')) s = `${s}/`
  return s
}

export interface ManifestPage {
  path: string
  title: string
  kind?: string
  chunks?: number
  tail?: string
  external?: boolean
  origin?: string
  route?: string
}

/**
 * The file against the index: which indexed pages it never links, and which of
 * its links name no indexed page.
 *
 * @param o.site the published URL, origin and base — `https://x.com/docs/`
 * @param o.base a base path when `site` does not carry one
 */
export function coverage(
  parsed: ParsedLlms,
  manifest: {pages?: ManifestPage[]},
  o: {site?: string | null; base?: string | null} = {},
): {pages: number; linked: number; unlinked: string[]; notIndexed: {url: string; line: number; path: string}[]; findings: Finding[]} {
  const origin = originOf(o.site) ?? dominantOrigin(parsed)
  let base = o.base ?? null
  if (!base && o.site) {
    try {
      base = new URL(o.site).pathname
    } catch {}
  }
  const pages = (manifest.pages ?? []).filter((p) => !p.external || p.route)
  const byPath = new Map(pages.map((p) => [normPath(p.external ? (p.route as string) : p.path), p]))
  const linked = new Set<string>()
  const notIndexed: {url: string; line: number; path: string}[] = []

  for (const s of parsed.sections)
    for (const it of s.items) {
      const path = toPagePath(it.url, {origin, base})
      if (path === null) continue
      if (/\.txt$/i.test(it.url.replace(/[?#].*$/, ''))) continue
      if (byPath.has(path)) linked.add(path)
      else notIndexed.push({url: it.url, line: it.line, path})
    }

  const unlinked = [...byPath.entries()].filter(([k]) => !linked.has(k)).map(([k, p]) => `${k}  (${p.title})`)
  const findings: Finding[] = []
  if (unlinked.length)
    findings.push(f('page-unlinked', null, `${unlinked.length} of ${byPath.size} indexed page(s) are not linked from llms.txt.`, 'Link them, or regenerate with `docpilot llms build`. A page an agent cannot find is a page it answers without.', unlinked))
  for (const n of notIndexed)
    findings.push(f('link-not-indexed', n.line, `${n.url} → ${n.path} is not a page in the index — a 404, or a page the indexer skipped.`, 'Fix the link, or reindex if the page is new (`npx docpilot index`). Pass --site if the link is absolute and the origin was guessed wrong.'))
  return {pages: byPath.size, linked: linked.size, unlinked, notIndexed, findings}
}

const ORDER: Severity[] = ['error', 'warn', 'info']

/** 100, minus 20 per error, 5 per warning, 1 per info; never below 0. */
export const scoreOf = (findings: Finding[]) =>
  Math.max(0, 100 - findings.reduce((s, x) => s + (x.severity === 'error' ? 20 : x.severity === 'warn' ? 5 : 1), 0))

export const countOf = (findings: Finding[]) => ({
  error: findings.filter((x) => x.severity === 'error').length,
  warn: findings.filter((x) => x.severity === 'warn').length,
  info: findings.filter((x) => x.severity === 'info').length,
})

/** The readable report: grouped by severity, a fix under each, a score line last. */
export function renderLint(
  findings: Finding[],
  o: {file?: string; cover?: {pages: number; linked: number} | null; maxItems?: number} = {},
): string {
  const lines: string[] = []
  // Messages and items quote the file, which can be any URL's llms.txt: its
  // control bytes are escaped so it cannot clear the screen and draw its own
  // "No findings", or reach the clipboard through OSC 52.
  const p = printable
  if (o.file) lines.push(`llms.txt lint — ${p(o.file)}`, '')
  const label = {error: 'ERRORS', warn: 'WARNINGS', info: 'INFO'}
  const max = o.maxItems ?? 20
  for (const sev of ORDER) {
    const group = findings.filter((x) => x.severity === sev).sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    if (!group.length) continue
    lines.push(`${label[sev]} (${group.length})`)
    for (const x of group) {
      lines.push(`  ${(x.line ? `L${x.line}` : '—').padEnd(6)}${x.rule.padEnd(20)}${p(x.message)}`)
      for (const it of (x.items ?? []).slice(0, max)) lines.push(`${' '.repeat(28)}${p(it)}`)
      if ((x.items?.length ?? 0) > max) lines.push(`${' '.repeat(28)}… ${x.items!.length - max} more (--json lists all)`)
      lines.push(`${' '.repeat(26)}fix: ${p(x.fix)}`)
    }
    lines.push('')
  }
  if (!findings.length) lines.push('No findings.', '')
  const c = countOf(findings)
  const cov = o.cover ? ` · ${o.cover.linked}/${o.cover.pages} indexed pages linked` : ''
  lines.push(`score ${scoreOf(findings)}/100 · ${c.error} error(s) · ${c.warn} warning(s) · ${c.info} info${cov}`)
  return lines.join('\n')
}
