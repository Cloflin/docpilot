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
 *   3. unfold tab panels and accordions, so each panel is visible and carries
 *      its label (html-tabs.ts);
 *   4. remove the `exclude` selectors, then `prune` the furniture;
 *   5. serialise the root to Markdown;
 *   6. normalise to NFC;
 *   7. refuse a page with nothing left in it.
 *
 * It makes no network call, reads no clock or locale and calls no model. A
 * page-level problem is a typed result (`ok: false` plus a reason), never a
 * throw, so one bad page cannot stop a directory of good ones.
 */

import { parseDocument } from './dom.js'
import { metadata, pickMain, prune, robotsNoindex, textOf } from './html-extract.js'
import { createLinkResolver } from './html-links.js'
import { unfoldPanels } from './html-tabs.js'
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
  /**
   * The value of the HTTP `X-Robots-Tag` header the page was served with. It
   * is applied with the same rule as `<meta name="robots">` (engine-spec 043,
   * D-27); the caller that fetched the page passes it.
   */
  robots?: string
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

/**
 * An absolute http(s) URL for `value` against `base`, or '' when it is neither.
 * Only http and https survive: a `javascript:` or `data:` canonical is ignored
 * (engine-spec 043, T-02-07).
 */
function webUrl(value: string, base = ''): string {
  if (!value) return ''
  try {
    const url = new URL(value, base || undefined)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

/**
 * The base a relative link resolves against (engine-spec 043, D-10, research
 * Pattern 4): the page's own `<base href>` first, because that is what a
 * browser uses; then its canonical URL, the best address a built page has of
 * itself; then the `base` option (the --html-base value or the import source
 * URL). Only an http(s) result counts, and '' means no base is known
 * (T-02-07: a `javascript:` base or canonical is ignored).
 */
export function linkBaseFor(meta: { baseHref?: string; canonical?: string }, base = ''): string {
  return webUrl(meta.baseHref || '', base) || webUrl(meta.canonical || '', base) || webUrl(base)
}

/** Extract an already parsed document. Synchronous. */
export function extractDocument(document, options: ExtractOptions = {}): ExtractResult {
  const { content = '', exclude = [], base = '', id = '' } = options
  try {
    const meta = metadata(document)
    const title = meta.title.normalize('NFC')
    const description = meta.description.normalize('NFC')
    const lang = meta.lang
    const report = emptyReport()
    report.totalChars = points(textOf(document.body || document.documentElement))
    const canonical = webUrl(meta.canonical, base) || null
    const dateModified = meta.dateModified || null
    const known = { title, description, lang, canonical, dateModified, report }
    // A page that asks not to be indexed is never extracted (D-27).
    if (meta.noindex || robotsNoindex(options.robots || '')) {
      return failure('noindex', { ...known, noindex: true })
    }

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

    // Pipeline step 5 of the research diagram: it must precede `exclude` and
    // the prune, which would delete every inactive panel as `hidden` and every
    // tab label as a `button` (P-01, P-02; engine-spec 043, HTML-05).
    unfoldPanels(root)

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

    const links = createLinkResolver({ base: linkBaseFor(meta, base), id })
    const rendered = toMarkdown(root, { origin: linkBaseFor(meta, base), links })
    const markdown = rendered.markdown.normalize('NFC')

    report.dropped = dropped
    report.keptChars = points(textOf(root))
    report.droppedChars = Math.max(0, report.totalChars - report.keptChars)
    report.linksResolved = links.stats.resolved
    report.linksDegraded = links.stats.degraded
    if (links.stats.degraded > 0) {
      const named = links.stats.samples.map((s) => `"${s}"`).join(', ')
      const line =
        `${id}: ${links.stats.degraded} link(s) had no usable base URL and became text ` +
        `(e.g. ${named}) — set --html-base, or give the page a rel=canonical`
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
