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

/**
 * Elements removed outright, by what they ARE rather than by what they say.
 *
 * Landmarks first, because they are the ones the HTML spec already named — a
 * `<nav>` is navigation whatever its class attribute claims. Then the media and
 * scripting nodes, which carry no text an answer could cite. `img` and `figure`
 * are here for the same reason the skill gives: an import is text, and an image
 * that survived would be a link into a host we do not control.
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
  'figure',
  'select',
  'input',
  'textarea',
]

/** ARIA landmarks that mean the same thing as the tags above. */
export const DROP_ROLES = ['navigation', 'banner', 'contentinfo', 'dialog', 'search', 'menubar']

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

/** The visible text of a subtree, whitespace collapsed. */
export function textOf(el) {
  return String(el?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
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

  // Hidden from the accessibility tree is hidden from the reader, and a reader
  // is who the corpus answers. `hidden` and `display:none` inline say the same.
  if ((el.getAttribute?.('aria-hidden') || '') === 'true') return 'aria-hidden'
  if (has(el, 'hidden')) return 'hidden'
  if (/display\s*:\s*none/i.test(el.getAttribute?.('style') || '')) return 'display:none'

  const sig = signature(el)
  const hint = DROP_HINTS.find((h) => sig.includes(h))
  if (hint) return `class/id ~ "${hint}"`

  const soft = SOFT_HINTS.find((h) => sig.includes(h))
  if (soft && !el.querySelector?.('table') && textOf(el).length < SOFT_TEXT_FLOOR) {
    return `class/id ~ "${soft}" (no text in it)`
  }

  if (tag === 'a') {
    if (BUTTON_CLASS.test(sig)) return 'link styled as a button'
    if ((el.getAttribute?.('role') || '') === 'button') return 'role="button"'
    const text = textOf(el)
    if (text && BUTTON_TEXT.test(text)) return `call to action ("${text.slice(0, 40)}")`
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
      const key = `${term} ${definition}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ term, definition })
    }
  }
  return out
}

/**
 * Title and description, from the page's own metadata.
 *
 * Read rather than written: a description is the strongest dense lever the
 * corpus has, and one invented here would be a sentence nobody at the source
 * wrote sitting in the highest-weighted chunk of the page. What this returns is
 * what the page claims about itself; making it the question a reader would ask
 * is an editing decision, and the command says so when the page offered none.
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
  return {
    // A site name glued on by a template — "Page — Acme" — is noise in a source
    // row that already names the host. The separator must be SURROUNDED BY
    // SPACES, which is not pedantry: without it the hyphen in "HTML-листів" is
    // a separator, and a real page lost half its title to that.
    title: title.replace(/\s+[|·—–-]\s+[^|·—–-]{1,40}$/u, '').trim() || title,
    description,
  }
}
