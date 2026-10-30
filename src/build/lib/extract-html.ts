/**
 * One extractor for every HTML path — engine-spec 043.
 *
 * `docpilot import <url>`, `docpilot index --html-dir` and the Phase 3
 * connectors all turn a rendered page into Markdown. Until this file each of
 * them ran its own copy of the pipeline, so a rule changed in one path stayed
 * old in the others. `extractHtml` is the only place the pipeline order lives:
 *
 *   1. parse, then read the metadata BEFORE any removal (a title can sit in
 *      the `<header>` the pruner is about to take);
 *   2. choose the root (a content selector, else `pickMain`);
 *   3. remove the `exclude` selectors, then `prune` the furniture;
 *   4. serialise the root to Markdown;
 *   5. normalise to NFC;
 *   6. refuse a page with nothing left in it.
 *
 * It makes no network call, reads no clock or locale and calls no model. A
 * page-level problem is a typed result (`ok: false` plus a reason), never a
 * throw, so one bad page cannot stop a directory of good ones.
 */

import { parseDocument } from './dom.js'
import { metadata, pickMain, prune, textOf } from './html-extract.js'
import { createLinkResolver } from './html-links.js'
import { toMarkdown } from './html-to-md.js'

/**
 * The version of the Markdown this module produces.
 *
 * 1 is the 2.x extractor, which wrote no stamp, so a page with no `extractor:`
 * key reads as 1. Bump on ANY change to the Markdown this module produces, a
 * parser upgrade included (PARSER_PINS in dom.ts). It enters the corpus hash
 * only for a corpus holding --html-dir pages (engine-spec 043, D-05): a
 * Markdown-only corpus has no extractor in it, and its committed index must
 * stay byte-identical.
 */
export const EXTRACTOR_VERSION = 2

/**
 * Fewer characters than this and the body is a label, not a sentence
 * ("Loading…", "Page not found"). Low on purpose, like SOFT_TEXT_FLOOR: a
 * one-sentence help answer is documentation, and a skipped page is reported
 * (engine-spec 043). Counted in Unicode code points of the NFC,
 * whitespace-collapsed text, so Cyrillic and CJK pages count as people read
 * them, not as UTF-16 units or bytes.
 */
export const MIN_EXTRACTED_CHARS = 24

/**
 * A rendered article is tens to hundreds of KB. The parser holds the whole tree
 * in memory, so a larger page is a data dump or an attack, and it is skipped
 * before it is parsed (engine-spec 043).
 */
export const MAX_HTML_BYTES = 8 * 1024 * 1024

export interface ExtractOptions {
  /** CSS selector for the page body; empty means `pickMain`. */
  content?: string
  /** Selectors removed from inside the body before pruning. */
  exclude?: string | string[]
  /** The URL the page was served at; resolves relative links. */
  base?: string
  /** The name a warning uses for this page. */
  id?: string
  warn?: (message: string) => void
}

export interface ExtractReport {
  totalChars: number
  keptChars: number
  droppedChars: number
  dropped: { reason: string; text: string }[]
  linksResolved: number
  linksDegraded: number
  warnings: string[]
}

interface ExtractMeta {
  title: string
  description: string
  lang: string
  canonical: string | null
  dateModified: string | null
  noindex: boolean
  report: ExtractReport
}

/**
 * `ok: true` carries the Markdown; `ok: false` carries the reason. One flat
 * shape rather than a union, because tsconfig has `strict` off and a union on
 * `ok` would not narrow: the unused half is '' on either side.
 */
export interface ExtractResult extends ExtractMeta {
  ok: boolean
  reason: string
  markdown: string
  scope: string
  links: string[]
}

/** Unicode code points, not UTF-16 units. */
const points = (text: string) => [...text].length

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

function emptyReport(): ExtractReport {
  return {
    totalChars: 0,
    keptChars: 0,
    droppedChars: 0,
    dropped: [],
    linksResolved: 0,
    linksDegraded: 0,
    warnings: [],
  }
}

/** The result of a page that gave nothing, with whatever metadata was read. */
function failure(reason: string, meta: Partial<ExtractMeta> = {}): ExtractResult {
  return {
    ok: false,
    reason,
    markdown: '',
    scope: '',
    links: [],
    title: '',
    description: '',
    lang: '',
    canonical: null,
    dateModified: null,
    noindex: false,
    report: emptyReport(),
    ...meta,
  }
}

/** The primary subtag of `<html lang>`, lowercased; '' when the page names none. */
function langOf(document): string {
  const raw = String(document.documentElement?.getAttribute?.('lang') || '')
  return raw.trim().split(/[-_]/)[0].toLowerCase()
}

/** Extract an already parsed document. Synchronous. */
export function extractDocument(document, options: ExtractOptions = {}): ExtractResult {
  const { content = '', exclude = [], base = '', id = '' } = options
  try {
    const meta = metadata(document)
    const title = meta.title.normalize('NFC')
    const description = meta.description.normalize('NFC')
    const lang = langOf(document)
    const report = emptyReport()
    report.totalChars = points(textOf(document.body || document.documentElement))
    const known = { title, description, lang, report }

    let root
    const selector = String(content || '').trim()
    if (selector) {
      try {
        root = document.querySelector(selector)
      } catch {
        return failure(`invalid selector "${selector}"`, known)
      }
      if (!root) return failure(`content selector "${selector}" matched nothing`, known)
    } else {
      root = pickMain(document)
    }

    const dropped: { reason: string; text: string }[] = []
    const excludes = (Array.isArray(exclude) ? exclude : [exclude])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
    for (const sel of excludes) {
      let found
      try {
        found = [...root.querySelectorAll(sel)]
      } catch {
        return failure(`invalid selector "${sel}"`, known)
      }
      for (const el of found) {
        // An earlier selector may have removed the ancestor of this match.
        if (el === root || !root.contains(el)) continue
        const text = textOf(el)
        if (text) dropped.push({ reason: `exclude "${sel}"`, text })
        el.remove()
      }
    }
    dropped.push(...prune(root))
    dropped.sort((a, b) => b.text.length - a.text.length)

    const links = createLinkResolver({ base, id })
    const rendered = toMarkdown(root, { origin: base, links })
    const markdown = rendered.markdown.normalize('NFC')

    report.dropped = dropped
    report.keptChars = points(textOf(root))
    report.droppedChars = Math.max(0, report.totalChars - report.keptChars)
    report.linksResolved = links.stats.resolved
    report.linksDegraded = links.stats.degraded
    if (links.stats.degraded > 0) {
      const line =
        `${id}: ${links.stats.degraded} link(s) had no usable base URL and became text ` +
        `(first: "${links.stats.firstDegraded}") — set --html-base, or give the page a rel=canonical`
      report.warnings.push(line)
      options.warn?.(line)
    }

    const size = points(collapse(markdown))
    if (size < MIN_EXTRACTED_CHARS) {
      return failure(`near-empty (${size} characters)`, known)
    }

    const scope = [
      String(root.tagName || 'body').toLowerCase(),
      root.getAttribute?.('id') ? `#${root.getAttribute('id')}` : '',
    ].join('')

    return {
      ok: true,
      reason: '',
      markdown,
      scope,
      links: rendered.links as string[],
      ...known,
      canonical: null,
      dateModified: null,
      noindex: false,
    }
  } catch (e) {
    // A RangeError from a page nested too deep to walk lands here.
    return failure(`extraction failed: ${(e as Error)?.message || e}`)
  }
}

/** Extract an HTML string. */
export async function extractHtml(html: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const bytes = Buffer.byteLength(String(html), 'utf8')
  if (bytes > MAX_HTML_BYTES) return failure(`too large (${bytes} bytes)`)
  let document
  try {
    document = await parseDocument(html)
  } catch (e) {
    return failure(`parse failed: ${(e as Error)?.message || e}`)
  }
  return extractDocument(document, options)
}
