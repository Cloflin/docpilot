/**
 * Which part of a fetched page is the documentation, and which part is furniture.
 *
 * This is the half of an import that used to be done by reading the page and
 * deciding. Deciding is fine; doing it in a language model is not, because the
 * output of that decision is the corpus itself — see the extraction rule in
 * `skills/docs-import/SKILL.md`, where a summarising fetch was measured dropping
 * the one sentence that stated a product guarantee. A rule that runs in code
 * drops the same things on every page, says which ones it dropped, and can be
 * argued with by editing a list rather than by re-running a prompt.
 *
 * The rules here are the SKILL's, in the order it states them: headings and
 * prose stay, lists and tables of real content stay, code samples stay, tooltips
 * are content; navigation, footers, banners, share widgets, CTAs and anything
 * whose meaning is a button go.
 *
 * NO DOM IS CONSTRUCTED HERE. Every function takes a node and returns nodes or
 * facts, so the suite drives it with whatever DOM the caller parsed.
 */

import { printable } from './terminal.js'

/**
 * Elements removed outright, by what they ARE rather than by what they say.
 *
 * Landmarks first, because they are the ones the HTML spec already named — a
 * `<nav>` is navigation whatever its class attribute claims. Then the media and
 * scripting nodes, which carry no text an answer could cite. `img` is here for
 * the reason the skill gives: an import is text, and an image that survived
 * would be a link into a host we do not control.
 *
 * `figure` is NOT here. A highlighter or a docs generator may wrap a code
 * sample or a table in one, and dropping the wrapper took the sample with it
 * (P-05); `dropReason` drops a figure that holds neither (engine-spec 043).
 */
export const DROP_TAGS = [
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'dialog',
  'template',
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'iframe',
  'video',
  'audio',
  'source',
  'track',
  'object',
  'embed',
  'img',
  'picture',
  'select',
  'input',
  'textarea',
]

/**
 * ARIA landmarks that mean the same thing as the tags above.
 *
 * `alertdialog` is a dialog that demands an answer, which is what a consent
 * prompt is: the cookie notice of a page that marks it up as an alert dialog is
 * the same furniture as one marked `dialog` (engine-spec 043, D-07).
 */
export const DROP_ROLES = [
  'navigation',
  'banner',
  'contentinfo',
  'dialog',
  'alertdialog',
  'search',
  'menubar',
]

/**
 * Class and id fragments that name furniture.
 *
 * Matched as substrings of a lowercased `class` or `id`, which is blunt and
 * deliberately so: these are the words a marketing page uses for the parts a
 * reader scrolls past. The cost of a false positive is one dropped block, and
 * every drop is reported — the cost of a false negative is a "book a demo"
 * sentence sitting in the corpus, retrievable, citable and wrong.
 */
export const DROP_HINTS = [
  'cookie',
  'consent',
  'gdpr',
  'breadcrumb',
  'share',
  'social-links',
  'newsletter',
  'subscribe',
  'testimonial',
  'carousel',
  'related-post',
  'related-articles',
  'comments',
  'author-card',
  'cta',
  'call-to-action',
  'skip-link',
  'back-to-top',
  'lang-switch',
  'language-switch',
]

/**
 * The named furniture lists of engine-spec 043 (D-07), one per kind of widget a
 * reader scrolls past. Unlike DROP_HINTS they are matched against TOKENS, not
 * substrings: a token equals the word, or has it at a `-` or `_` boundary, so
 * `page-toc` matches `toc` and `stock-chart` does not. The haystack is the
 * `class` tokens, the `id` and the `aria-label` of the element, lowercased.
 * Every entry is a word a generator or a help centre really writes; a kind that
 * a list misses is added here with its reason, never matched by a looser
 * pattern. Every removal is reported with the kind that took it.
 */

/** Cookie and consent banners beyond the substring hints: a consent bar is never content. */
export const CONSENT_TOKENS = ['cookiebar', 'cookie-banner', 'privacy-banner', 'cmp']

/** "Was this helpful?" widgets: the question and its Yes/No buttons say nothing a reader asks about. */
export const FEEDBACK_TOKENS = [
  'feedback',
  'article-feedback',
  'was-this-helpful',
  'article-votes',
  'article-rating',
  'reactions',
]

/** Share bars: links to other sites' share forms, with no text of the page in them. */
export const SHARE_TOKENS = ['sharing', 'social-share', 'share-bar', 'share-buttons']

/** Table-of-contents sidebars: a second copy of the headings, which the chunker rebuilds. */
export const TOC_TOKENS = ['toc', 'table-of-contents', 'article-toc', 'page-toc', 'on-this-page']

/** Breadcrumbs: the path to the page is the source row's job, not the body's. */
export const BREADCRUMB_TOKENS = ['breadcrumbs', 'crumbs']

/** Help-centre bylines and avatars: who wrote it and when is metadata, and a retrievable lie in a chunk. */
export const BYLINE_TOKENS = [
  'byline',
  'author',
  'article-author',
  'author-info',
  'article-meta',
  'post-meta',
  'avatar',
]

/**
 * How much of a `class`, `id` or `aria-label` the token lists read. A page
 * chooses its own attributes, and a megabyte class would make every list scan
 * a megabyte; the words a list names sit in the first lines of any real one.
 */
const SIGNATURE_MAX = 2000

/**
 * The text rules below apply to an element with at most this many element
 * children (a byline is a line, maybe with a name in a link and a date in a
 * `<time>`) and at most FURNITURE_TEXT_MAX characters once collapsed. The
 * length check comes BEFORE any regular expression, so a regex never sees more
 * than FURNITURE_TEXT_MAX characters (T-02-18).
 */
export const FURNITURE_MAX_CHILDREN = 4
export const FURNITURE_TEXT_MAX = 120

/**
 * The raw text above which an element is not measured at all. Template
 * indentation and newlines inflate raw text, so this is far above
 * FURNITURE_TEXT_MAX; it only keeps the whitespace collapse off a megabyte of
 * text on every ancestor of a large block.
 */
const FURNITURE_RAW_MAX = 1000

/**
 * Help-centre furniture by its text, anchored and bounded: no nested
 * quantifier, no unbounded repeat after the anchor (engine-spec 043, D-07).
 *
 * `UPDATED_TEXT` demands a year, a numeric date or a relative time, so
 * "Updated pricing applies from May." is a sentence and stays. The rules are
 * compared with lowercased NFC text, hence the `i` flag.
 */
export const BYLINE_TEXT = /^(?:written|posted|published|authored|created) by\s.{1,80}$/i
export const UPDATED_TEXT =
  /^(?:last )?(?:updated|modified|edited)\b[^.!?]{0,40}(?:\d{4}|\d{1,2}[./-]\d{1,2}|\bago\b|\byesterday\b|\btoday\b)[^.!?]{0,20}$/i
export const TOC_TITLE_TEXT = /^(?:table of contents|contents|on this page|in this article)$/i
export const FEEDBACK_TEXT = /^was this (?:article|page|answer|section) (?:helpful|useful)\b.{0,60}$/i

/**
 * What a byline's tail looks like (WR-07). `BYLINE_TEXT` alone matched every
 * short sentence that opens with "Created by" or "Posted by": "Created by
 * default when the webhook handler runs." is documentation, and a drop removes
 * it from the corpus. A byline names a person, or dates the post. The tail
 * therefore has to be a run of one to four capitalised words (a name), a name
 * and a date, or a short phrase that ends in "on <date>". Every quantifier is
 * bounded, as in the other rules, and the pattern is case-sensitive on purpose:
 * `BYLINE_TEXT` carries the `i` flag, which would let "default" pass as a name.
 */
const NAME_WORD = "\\p{Lu}[\\p{L}\\p{M}'’.-]{0,30}"
const NAME_RUN = `${NAME_WORD}(?: ${NAME_WORD}){0,3}`
const MONTH = '\\p{Lu}\\p{L}{2,8}\\.?'
const BYLINE_DATE =
  `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|${MONTH} \\d{1,2},? \\d{4}|\\d{1,2} ${MONTH},? \\d{4})`
export const BYLINE_SHAPE = new RegExp(
  `^\\S{1,12} [Bb][Yy] (?:${NAME_RUN}(?:,| on| ·| [-–|]) ${BYLINE_DATE}|${NAME_RUN}|.{1,40} on ${BYLINE_DATE})$`,
  'u',
)

/**
 * Each text rule with the reason that reaches the report. `shape`, when there is
 * one, must also accept the text: the rule says what the line starts with, the
 * shape says what the rest has to look like.
 */
const TEXT_RULES: { rule: RegExp; reason: string; shape?: RegExp }[] = [
  { rule: BYLINE_TEXT, reason: 'help-centre byline ("written by …")', shape: BYLINE_SHAPE },
  { rule: UPDATED_TEXT, reason: 'help-centre date line ("updated …")' },
  { rule: TOC_TITLE_TEXT, reason: 'table-of-contents title' },
  { rule: FEEDBACK_TEXT, reason: 'feedback question ("was this helpful?")' },
]

/**
 * Elements whose short text is DATA, not furniture: a table cell that reads
 * "Updated 2026-03-01" is a changelog column, and a list item that does is an
 * entry. The text rules skip them (a byline is never a cell).
 */
const DATA_TAGS = ['td', 'th', 'li', 'dt', 'dd', 'summary']

/** The token lists with the kind each one names, in the order they are asked. */
const NOISE_LISTS = [
  { tokens: CONSENT_TOKENS, kind: 'consent banner' },
  { tokens: FEEDBACK_TOKENS, kind: 'feedback widget' },
  { tokens: SHARE_TOKENS, kind: 'share bar' },
  { tokens: TOC_TOKENS, kind: 'table of contents' },
  { tokens: BREADCRUMB_TOKENS, kind: 'breadcrumb' },
  { tokens: BYLINE_TOKENS, kind: 'byline' },
]

/**
 * The share of a list's text that must be link text for the list to be an
 * in-page table of contents. A list of jump links with prose around them is
 * content that happens to link to itself.
 */
const TOC_LINK_SHARE = 0.8

/**
 * Hints that are furniture ONLY when they are not carrying content.
 *
 * Measured on a real page: a pricing table lived in a `<div class="slider">`,
 * and the unconditional list above took the entire price comparison with it —
 * the one thing the skill says to copy verbatim, because a plan table with the
 * numbers removed answers nothing. These words describe a WIDGET, and a widget
 * is a container: whether it is furniture depends on what is inside it, so that
 * is what gets asked. A block with a table, or with a paragraph's worth of
 * prose, is content that happens to be in a carousel.
 */
export const SOFT_HINTS = ['slider', 'sidebar', 'popup', 'modal', 'overlay', 'banner', 'promo']

/**
 * Text below this, and no table, means the widget held no documentation.
 *
 * Counted as RAW text rather than as prose, and the difference is the whole
 * point: the pricing block that survives because of this rule is built out of
 * `<div>`s and `<span>`s, so `proseLength` — which counts paragraphs, list items
 * and cells — scores the entire price comparison at zero.
 *
 * The floor is LOW on purpose. It is not "does this look like documentation",
 * which no character count can answer; it is "does this have words in it at
 * all". A decorative slider says "Next" and "Previous"; a plan comparison may
 * say no more than "Free $0 Startup $100 Business $200", and those numbers are
 * the thing the skill says to copy verbatim. A promo banner that clears the
 * floor survives here and is what the annotation pass wraps in
 * `<llm-exclude>` — a marketing sentence in the file is recoverable, a deleted
 * price list is not.
 */
export const SOFT_TEXT_FLOOR = 40

/**
 * A link that is really a button.
 *
 * Two independent tests, because the two ways to build one do not overlap: a
 * styled `<a class="btn">`, and a bare link whose text is an offer. The text
 * list is short and literal on purpose. "Learn more" is NOT on it — it is a
 * navigation label inside prose as often as it is a button, and prose is what
 * this whole file exists to keep.
 */
export const BUTTON_CLASS = /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i
export const BUTTON_TEXT =
  /^(get started|start (free|now)|try (it )?(free|now)|book a demo|request a demo|schedule a demo|contact sales|talk to sales|sign up|sign in|log in|register( now)?|buy now|subscribe|download( now)?|start (your )?free trial)\b/i

/** Attributes whose value is the only definition a term has on the page. */
export const TOOLTIP_ATTRS = [
  'data-tippy-content',
  'data-tooltip',
  'data-title',
  'data-original-title',
]

const has = (el, name) => typeof el?.getAttribute === 'function' && el.getAttribute(name) != null

/** `class` + `id`, lowercased, as one haystack. */
function signature(el) {
  const cls = el.getAttribute?.('class') || ''
  const id = el.getAttribute?.('id') || ''
  return `${cls} ${id}`.toLowerCase()
}

/**
 * The class tokens, the id and the aria-label as `-token-` strings, `_` read
 * as `-`, so `-toc-` finds the word `toc` at a boundary and nowhere inside
 * another word. The aria-label counts as one token with its spaces as `-`.
 */
function signatureTokens(el): string[] {
  const read = (name: string) =>
    String(el.getAttribute?.(name) || '')
      .slice(0, SIGNATURE_MAX)
      .normalize('NFC')
      .toLowerCase()
  const names = [
    ...read('class').split(/\s+/),
    read('id'),
    read('aria-label').trim().replace(/\s+/g, '-'),
  ]
  return names.filter(Boolean).map((name) => `-${name.replace(/_/g, '-')}-`)
}

/** The reason an element goes by a named token list, or null. */
function noiseListReason(el): string | null {
  const names = signatureTokens(el)
  for (const { tokens, kind } of NOISE_LISTS) {
    for (const word of tokens) {
      const needle = `-${word}-`
      const hit = names.find((name) => name.includes(needle))
      // `reason` ends up on a terminal, in a report and in every later consumer
      // of `report.dropped`, and the token came off the page: escaped HERE, so
      // no consumer has to remember to (engine-spec 043).
      if (hit) return `class/id token "${printable(hit.slice(1, -1))}" (${kind})`
    }
  }
  if (String(el.getAttribute?.('itemtype') || '').slice(0, SIGNATURE_MAX).toLowerCase().includes('breadcrumblist')) {
    return 'itemtype BreadcrumbList (breadcrumb)'
  }
  return null
}

/**
 * The reason a short, block-free element goes by its text, or null.
 *
 * Every cheap test runs before the first regular expression, so no rule sees
 * more than FURNITURE_TEXT_MAX characters (T-02-18). A match inside code is
 * code, not furniture.
 */
function textRuleReason(el, tag: string): string | null {
  if (DATA_TAGS.includes(tag)) return null
  if ((el.children?.length || 0) > FURNITURE_MAX_CHILDREN) return null
  if (String(el.textContent || '').length > FURNITURE_RAW_MAX) return null
  const text = textOf(el).normalize('NFC')
  if (!text || text.length > FURNITURE_TEXT_MAX) return null
  if (el.querySelector?.('p, ul, ol, dl, table, pre')) return null
  const found = TEXT_RULES.find(({ rule }) => rule.test(text))
  if (!found) return null
  if (found.shape && !found.shape.test(text)) return null
  if (el.closest?.('pre, code')) return null
  return found.reason
}

/** The visible text of a subtree, whitespace collapsed. */
export function textOf(el) {
  return String(el?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Elements whose text is code or markup for a machine, never prose: the report
 * does not count it as text the page had (WR-09).
 */
export const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'])

/**
 * `textOf` without the text of `NON_TEXT_TAGS`. The extraction report's
 * `totalChars` is the baseline that `droppedChars` is read against, and an inline
 * tracking script is not text the extractor dropped: counting it made a page full
 * of scripts read as a large loss. The walk keeps its own stack, so a page nested
 * thousands deep costs memory, not a RangeError.
 */
export function visibleTextOf(el) {
  const parts: string[] = []
  const stack = el ? [el] : []
  while (stack.length) {
    const node = stack.pop()
    if (node.nodeType === 3) {
      parts.push(String(node.data ?? node.textContent ?? ''))
      continue
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) continue
    if (node !== el && NON_TEXT_TAGS.has(String(node.tagName || '').toUpperCase())) continue
    const kids = node.childNodes
    for (let i = (kids?.length || 0) - 1; i >= 0; i--) stack.push(kids[i])
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/**
 * Is this element furniture?
 *
 * Ordered cheapest-first, and each branch returns the REASON rather than a
 * boolean, because the reason is what the command prints. A drop nobody can
 * explain is indistinguishable from a bug in this file.
 *
 * @returns {string|null} why it goes, or null to keep it
 */
export function dropReason(el) {
  const tag = String(el.tagName || '').toLowerCase()
  if (!tag) return null
  if (DROP_TAGS.includes(tag)) return `<${tag}>`

  const role = (el.getAttribute?.('role') || '').toLowerCase()
  if (DROP_ROLES.includes(role)) return `role="${role}"`

  // A figure is a wrapper, and what is inside it decides (P-05): code and
  // tables stay with their caption, a figure of pictures goes.
  if (tag === 'figure' && !el.querySelector?.('pre, table')) return '<figure> with no code or table'

  // Hidden from the accessibility tree is hidden from the reader, and a reader
  // is who the corpus answers. `hidden` and `display:none` inline say the same.
  if ((el.getAttribute?.('aria-hidden') || '') === 'true') return 'aria-hidden'
  if (has(el, 'hidden')) return 'hidden'
  if (/display\s*:\s*none/i.test(el.getAttribute?.('style') || '')) return 'display:none'

  const sig = signature(el)
  const hint = DROP_HINTS.find((h) => sig.includes(h))
  if (hint) return `class/id ~ "${hint}"`

  const listed = noiseListReason(el)
  if (listed) return listed

  const worded = textRuleReason(el, tag)
  if (worded) return worded

  const soft = SOFT_HINTS.find((h) => sig.includes(h))
  if (soft && !el.querySelector?.('table') && textOf(el).length < SOFT_TEXT_FLOOR) {
    return `class/id ~ "${soft}" (no text in it)`
  }

  if (tag === 'a') {
    if (BUTTON_CLASS.test(sig)) return 'link styled as a button'
    if ((el.getAttribute?.('role') || '') === 'button') return 'role="button"'
    const text = textOf(el)
    if (text && BUTTON_TEXT.test(text)) return `call to action ("${printable(text.slice(0, 40))}")`
  }

  return null
}

/**
 * The subtree that is the page.
 *
 * `<main>` is asked first because a site that has one has already answered this
 * question. The scoring fallback exists for the sites that have not: it prefers
 * the block with the most PROSE, counted as text inside paragraphs and list
 * items rather than as raw characters, so a navigation column of forty links
 * does not beat three paragraphs of documentation.
 */
export function pickMain(document) {
  const direct =
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.querySelector('article')
  if (direct && proseLength(direct) > 200) return direct

  const body = document.body || document.documentElement
  let best = body
  let bestScore = proseLength(body) * 0.5 // the body wins only if nothing else does
  for (const el of body.querySelectorAll('div, section, article, main')) {
    const score = proseLength(el)
    if (score > bestScore) {
      best = el
      bestScore = score
    }
  }
  return best
}

/** Text that lives in prose blocks, which is the text an answer can be built from. */
export function proseLength(el) {
  let n = 0
  for (const p of el.querySelectorAll('p, li, td, th, pre, blockquote, dd')) n += textOf(p).length
  return n
}

/**
 * Remove each in-page table of contents, with its title, and report both.
 *
 * A list of at least two links where EVERY link is fragment-only and the link
 * text is at least TOC_LINK_SHARE of the list's text is a copy of the page's
 * own headings. It has no class to match on in a lot of help centres, so it is
 * recognised by what it is. The element just before it goes too when its text
 * is a title ("Table of contents") — a title over nothing is an orphan line.
 * A list of real links, or of one jump link, is content and stays.
 */
function dropTocLists(root, dropped) {
  const reason = 'in-page table of contents'
  for (const list of [...root.querySelectorAll('ul, ol')]) {
    if (!root.contains(list)) continue
    const links = [...list.querySelectorAll('a')]
    if (links.length < 2) continue
    if (!links.every((a) => String(a.getAttribute('href') || '').trim().startsWith('#'))) continue
    const text = textOf(list)
    const linkText = links.reduce((sum, a) => sum + textOf(a).length, 0)
    if (!text || linkText < text.length * TOC_LINK_SHARE) continue

    const title = list.previousElementSibling
    if (
      title &&
      String(title.textContent || '').length <= FURNITURE_RAW_MAX &&
      textOf(title).length <= FURNITURE_TEXT_MAX &&
      TOC_TITLE_TEXT.test(textOf(title).normalize('NFC'))
    ) {
      dropped.push({ reason: `${reason} (title)`, text: textOf(title) })
      title.remove()
    }
    dropped.push({ reason, text })
    list.remove()
  }
}

/**
 * Remove the furniture, in place, and report every removal.
 *
 * Depth-first with the children snapshotted before the walk, because removing a
 * node while iterating a live NodeList skips its sibling — the classic way a
 * pruner half-works and nobody notices until a footer survives on one page.
 *
 * @param {any} root
 * @returns {{ reason: string, text: string }[]} what went, longest first
 */
export function prune(root) {
  const dropped = []

  dropTocLists(root, dropped)

  const walk = (el) => {
    for (const child of [...(el.children || [])]) {
      const reason = dropReason(child)
      if (reason) {
        const text = textOf(child)
        // A drop worth reporting is one that took text with it. Removing an
        // empty `<svg>` is noise in a report nobody would then read.
        if (text) dropped.push({ reason, text })
        child.remove()
        continue
      }
      walk(child)
    }
  }
  walk(root)

  dropped.sort((a, b) => b.text.length - a.text.length)
  return dropped
}

/**
 * Tooltips inside a subtree, as `{ term, definition }`.
 *
 * Collected rather than inlined: the skill's rule is that a tooltip is content
 * and belongs as a note under the table it annotates, which is a decision about
 * placement that the serialiser makes, not this file.
 */
export function tooltips(el) {
  const out = []
  const seen = new Set()
  for (const node of [el, ...el.querySelectorAll('*')]) {
    for (const attr of TOOLTIP_ATTRS) {
      const value = node.getAttribute?.(attr)
      if (!value) continue
      const definition = String(value).replace(/\s+/g, ' ').trim()
      const term = textOf(node)
      if (!definition || !term || definition === term) continue
      const key = `${term}\u0000${definition}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ term, definition })
    }
  }
  return out
}

/**
 * A JSON-LD block is a few KB; a larger one is not metadata and is not parsed
 * (engine-spec 043, T-02-08: a hostile page cannot make the build parse
 * megabytes of "metadata").
 */
export const MAX_JSONLD_CHARS = 100_000

/**
 * How deep the JSON-LD walk goes into nested objects, arrays and `@graph`.
 * An Article sits at depth 0 to 2 in practice (engine-spec 043, T-02-08).
 */
const JSONLD_DEPTH = 4

/**
 * A date is kept as the page wrote it when it is ISO 8601, and never parsed
 * into a Date, so no clock or locale enters the output (engine-spec 043, D-12).
 * Anchored, one optional group per part, no nested quantifier.
 */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** `<html lang>`, as a bare lowercase subtag; '' when the page names none. */
export function langOf(document): string {
  const raw = String(document.documentElement?.getAttribute?.('lang') || '')
  return raw.trim().split(/[-_]/)[0].toLowerCase()
}

/**
 * Does a robots value (a `<meta name="robots">` content or an `X-Robots-Tag`
 * header) ask not to be indexed? `none` is `noindex, nofollow` by definition
 * (engine-spec 043, D-27).
 */
export function robotsNoindex(value): boolean {
  return String(value || '')
    .toLowerCase()
    .split(/[\s,]+/)
    .some((token) => token === 'noindex' || token === 'none')
}

/** The first string `dateModified` in a parsed JSON-LD value, '' when none. */
function jsonLdDate(value, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > JSONLD_DEPTH) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = jsonLdDate(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value.dateModified === 'string') return value.dateModified.trim()
  return jsonLdDate(value['@graph'], depth + 1)
}

/** The page's modification date as written, when it is ISO 8601; else ''. */
function modifiedOf(document): string {
  const accept = (raw) => {
    const value = String(raw || '').trim()
    return ISO_DATE.test(value) ? value : ''
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent || ''
    if (!text || text.length > MAX_JSONLD_CHARS) continue
    try {
      const found = accept(jsonLdDate(JSON.parse(text)))
      if (found) return found
    } catch {
      /* not JSON: the page's own problem, and no date */
    }
  }
  return (
    accept(document.querySelector('meta[property="article:modified_time"]')?.getAttribute('content')) ||
    accept(document.querySelector('meta[itemprop="dateModified"]')?.getAttribute('content')) ||
    accept(document.querySelector('time[itemprop="dateModified"][datetime]')?.getAttribute('datetime'))
  )
}

/**
 * What the page claims about itself, read BEFORE anything is removed — a
 * JSON-LD `dateModified` sits in a `<script>` the pruner deletes
 * (engine-spec 043, D-12).
 *
 * Title and description are read rather than written: a description is the
 * strongest dense lever the corpus has, and one invented here would be a
 * sentence nobody at the source wrote sitting in the highest-weighted chunk of
 * the page. What this returns is what the page claims about itself; making it
 * the question a reader would ask is an editing decision, and the command says
 * so when the page offered none.
 */
export function metadata(document) {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || ''
  const title =
    meta('meta[property="og:title"]') ||
    textOf(document.querySelector('h1')) ||
    document.querySelector('title')?.textContent?.trim() ||
    ''
  const description =
    meta('meta[name="description"]') || meta('meta[property="og:description"]') || ''
  const canonicalLink = [...document.querySelectorAll('link[rel][href]')].find((link) =>
    String(link.getAttribute('rel') || '')
      .toLowerCase()
      .split(/\s+/)
      .includes('canonical'),
  )
  const robots = [...document.querySelectorAll('meta[name][content]')].some(
    (m) =>
      String(m.getAttribute('name') || '').trim().toLowerCase() === 'robots' &&
      robotsNoindex(m.getAttribute('content')),
  )
  return {
    // A site name glued on by a template — "Page — Acme" — is noise in a source
    // row that already names the host. The separator must be SURROUNDED BY
    // SPACES, which is not pedantry: without it the hyphen in "HTML-листів" is
    // a separator, and a real page lost half its title to that.
    title: title.replace(/\s+[|·—–-]\s+[^|·—–-]{1,40}$/u, '').trim() || title,
    description,
    canonical: String(canonicalLink?.getAttribute('href') || '').trim(),
    baseHref: String(document.querySelector('base[href]')?.getAttribute('href') || '').trim(),
    lang: langOf(document),
    dateModified: modifiedOf(document),
    noindex: robots,
  }
}
