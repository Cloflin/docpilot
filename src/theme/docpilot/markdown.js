/**
 * Answer rendering and link integrity — UI-SPEC 11.
 *
 * Citation integrity is the product's one non-negotiable promise, so the filter
 * runs over the markdown-it TOKEN STREAM, before v-html ever receives anything.
 * A regex over the rendered HTML string would be a second parser disagreeing
 * with the first.
 */

import MarkdownIt from 'markdown-it'
import { highlight, LANGS } from './highlight.js'
import { ICON_ATTRS, symbolId } from './glyphs.js'

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
  typographer: false,
})

// `image` is the only construct here with a network consequence: an enabled
// ![](https://…/?q=…) would fire a request from the docs origin carrying the
// reader's question. `autolink` turns bare text into links the filter then has
// to reason about. Both are disabled explicitly rather than left to defaults.
md.disable(['image', 'autolink'])

/**
 * Normalised membership test — UI-SPEC 11, in this order.
 *
 * Every citation href is `{path}#{anchor}` while every pages[].path is
 * anchorless, so a literal test would de-link every legitimate source link; a
 * permissive "starts with" test would admit any invented route beginning with a
 * real path.
 */
export function isKnownPath(href, known) {
  if (!href) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return false
  let p
  try {
    p = decodeURIComponent(href)
  } catch {
    p = href
  }
  p = p.split('#')[0].split('?')[0]
  if (!p.startsWith('/')) return false
  p = p.replace(/\/$/, '') || '/'
  return known.has(p)
}

/**
 * Code fences — UI-SPEC 506, with one recorded departure.
 *
 * A custom fence rule rather than markdown-it's `highlight` option, because
 * that option's return value is only passed through verbatim when it starts
 * with `<pre`, and this needs a wrapper around the `<pre>` to hang the copy
 * button on.
 *
 * The container class is `docpilot__code` and must never contain the substring
 * `language-`: VitePress binds a window-level click listener to
 * `div[class*="language-"] > button.copy`, the panel is teleported to `body`,
 * and a matching class would put a second, uncancellable copy handler on our
 * button. Not colliding is structural here, not a convention.
 */
// Two `<use>` references, not two inlined path strings — ui-specs/001. This
// button has no component instance to reach `Icon` from, and before the sprite
// it was the one place a second copy of two path values lived.
const COPY_BUTTON =
  '<button type="button" class="docpilot__code-copy" data-copy-code aria-label="Copy code">' +
  `<svg ${ICON_ATTRS}>` +
  `<use class="docpilot__glyph-rest" href="#${symbolId('copy')}"/>` +
  `<use class="docpilot__glyph-done" href="#${symbolId('check')}"/>` +
  '</svg></button>'

function langOf(info) {
  const first = String(info || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
  // `hasOwn`, not a plain lookup. The info string is model output, and a plain
  // lookup reaches Object.prototype: ```constructor and ```__proto__ both return
  // something truthy that is not a language name, and it is that value — not a
  // value from this table — that gets written into the markup downstream. The
  // table is a sanitiser, so it has to be the only thing that can answer.
  return Object.hasOwn(LANGS, first) ? LANGS[first] : null
}

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const code = token.content.replace(/\n$/, '')
  const lang = langOf(md.utils.unescapeAll(token.info))
  // One branch for three cases: no language, a language we do not ship, and a
  // highlighter that has not finished loading. All three render the same block.
  const body =
    (lang && highlight(code, lang)) ||
    `<pre tabindex="0"><code>${md.utils.escapeHtml(code)}</code></pre>`
  return `<div class="docpilot__code"${lang ? ` data-lang="${lang}"` : ''}>${COPY_BUTTON}${body}</div>\n`
}

/** markdown-it does not export Token from its package root; take it from a parse. */
const Token = md.parse('x', {})[0].constructor

const MARKER = /\[(\d+)\]/g

/**
 * Inline `[n]` → the linked superscript marker of UI-SPEC 573.
 *
 * Runs over the token stream for the same reason the link filter does, and it
 * runs AFTER it: these hrefs are host-built from the manifest, not model text,
 * and re-testing them against the filter would only risk one day de-linking the
 * product's own citations.
 *
 * A marker whose citation did not survive validation is DELETED rather than
 * left as text. `[4]` beside three sources is the reader's evidence that
 * something was dropped, which is exactly the impression the validation exists
 * to avoid creating.
 */
function linkMarkers(tokens, sources) {
  // POSITION, not row number: `sources[i]` is what citation i+1 resolved to, and
  // two citations landing on one section share a row, so [1] and [2] both render
  // as the digit of that one row rather than pointing at a row that is not there.
  const rowFor = (marker) => sources[Number(marker) - 1] || null

  const mkText = (content) => {
    const t = new Token('text', '', 0)
    t.content = content
    return t
  }

  const rebuild = (children) => {
    const out = []
    let inLink = 0
    for (const t of children) {
      if (t.type === 'link_open') inLink++
      if (t.type === 'link_close') inLink--
      // Nesting an anchor inside an anchor is invalid HTML, and a marker the
      // model wrote inside its own link is already pointing somewhere.
      if (t.type !== 'text' || inLink > 0 || !t.content.includes('[')) {
        out.push(t)
        continue
      }
      let last = 0
      let hit = false
      for (const m of t.content.matchAll(MARKER)) {
        const src = rowFor(m[1])
        hit = true
        if (m.index > last) out.push(mkText(t.content.slice(last, m.index)))
        last = m.index + m[0].length
        if (!src) continue
        const open = new Token('link_open', 'a', 1)
        // An imported page's marker opens the ORIGINAL, matching its row in the
        // source list — one destination per citation, not two. `rel` is not
        // optional beside `target="_blank"`: the answer is rendered with v-html,
        // and an opened tab that keeps `window.opener` can navigate the panel it
        // came from.
        open.attrs = [
          ['href', src.origin || src.href],
          ['class', 'docpilot__cite'],
          ['data-cite', String(src.n)],
          ['aria-label', `Source ${src.n}: ${src.title}`],
          ...(src.origin ? [['target', '_blank'], ['rel', 'noopener noreferrer']] : []),
        ]
        out.push(open, mkText(String(src.n)), new Token('link_close', 'a', -1))
      }
      if (!hit) {
        out.push(t)
        continue
      }
      if (last < t.content.length) out.push(mkText(t.content.slice(last)))
    }
    return out
  }

  const walk = (list) => {
    for (const token of list) {
      if (!token.children) continue
      walk(token.children)
      token.children = rebuild(token.children)
    }
  }
  walk(tokens)
}

/**
 * @param {string} text     answer markdown
 * @param {Set<string>} known  manifest.pages[].path
 * @param {Array<{n:number, href:string, title:string}>} sources  validated citations, in order
 * @returns {{ html: string, delinked: string[] }}
 */
export function renderAnswer(text, known, sources = []) {
  const tokens = md.parse(String(text || ''), {})
  const delinked = []

  const walk = (list) => {
    for (const token of list) {
      if (token.children) walk(token.children)
      if (token.type !== 'link_open') continue
      const href = token.attrGet('href')
      if (isKnownPath(href, known)) continue
      delinked.push(href)
      // Converted to text, not deleted: the reader still sees what the model
      // wrote, it simply is not offered as a link to a page that does not exist.
      token.tag = 'span'
      token.attrs = null
    }
    // close tags must follow their opener
    for (const token of list) {
      if (token.type === 'link_close' && token.tag === 'a') token.tag = 'span'
    }
  }

  walk(tokens)

  // A link_close is only rewritten when its opener was; walk() above is too
  // blunt, so re-pair by scanning depth.
  let depth = 0
  const stack = []
  const repair = (list) => {
    for (const token of list) {
      if (token.children) repair(token.children)
      if (token.type === 'link_open') stack.push(token.tag)
      if (token.type === 'link_close') token.tag = stack.pop() || 'span'
    }
  }
  repair(tokens)
  void depth

  if (sources.length) linkMarkers(tokens, sources)

  return { html: md.renderer.render(tokens, md.options, {}), delinked }
}

/** Inline citation markers `[1]` → a placeholder the component turns into buttons. */
export function extractMarkers(text) {
  return [...String(text || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
}
