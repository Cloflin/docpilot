/**
 * Answer rendering and link integrity — UI-SPEC 11.
 *
 * Citation integrity is the product's one non-negotiable promise, so the filter
 * runs over the markdown-it TOKEN STREAM, before v-html ever receives anything.
 * A regex over the rendered HTML string would be a second parser disagreeing
 * with the first.
 */

import MarkdownIt from 'markdown-it'
import { highlight, resolveLang } from './highlight.js'
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

md.renderer.rules.fence = (tokens, idx, options, env) => {
  const token = tokens[idx]
  const code = token.content.replace(/\n$/, '')
  // `resolveLang`, not a lookup written here. The info string is model output
  // and the value it resolves to reaches an attribute unescaped, so the table
  // has to be the only thing that can answer — and it lives beside the
  // highlighter registry, which is the only thing allowed to extend it.
  const lang = resolveLang(md.utils.unescapeAll(token.info))
  // One branch for three cases: no language, a language we do not ship, and a
  // highlighter that has not finished loading. All three render the same block.
  const body =
    (lang && highlight(code, lang)) ||
    `<pre tabindex="0"><code>${md.utils.escapeHtml(code)}</code></pre>`
  // `env.copy === false` is the passage — a retrieved chunk shown as evidence.
  // The button is dropped there rather than everywhere: a copy control inside a
  // 240px quotation box sits under the turn's own copy button and adds a tab
  // stop to a scroller that already is one, and nobody copies a citation's code
  // out of the citation when the page it came from is one click away.
  const copy = env?.copy === false ? '' : COPY_BUTTON
  return `<div class="docpilot__code"${lang ? ` data-lang="${lang}"` : ''}>${copy}${body}</div>\n`
}

/**
 * Tables — ui-specs/009.
 *
 * A comparison table is the genre norm for a documentation answer: *option ·
 * default · what it does* is how half this package's own reference pages are
 * written, so it is how the model writes back. Nothing styled one, and nothing
 * contained one either — the panel is 360–460px wide and a three-column table
 * simply ran out the side of it.
 *
 * The wrapper is the code card's device, one floor down: the scroller is a
 * sibling problem and gets the sibling answer. Like `pre` it is a **tab stop**,
 * because a scroller nobody can reach by keyboard is a scroller with content
 * behind it that some readers cannot get to.
 *
 * It carries NO ROLE. `role="region"` is what a scrollable table container
 * usually gets, and it needs a name to be worth having; a table that arrived
 * from a model has no caption to take one from, and an unnamed region landmark
 * is worse than no landmark. The same call `pre` already makes above.
 *
 * The class must not contain `language-`, for the reason the fence rule states.
 */
md.renderer.rules.table_open = () => '<div class="docpilot__table" tabindex="0">\n<table>\n'
md.renderer.rules.table_close = () => '</table>\n</div>\n'

/**
 * `scope="col"` on every header cell.
 *
 * GFM tables have one header row and no row headers, so every `th` this renderer
 * ever sees is a column header — which is what makes the attribute safe to set
 * unconditionally. Through `renderToken` rather than a literal string, because
 * markdown-it puts the alignment on `style` and a hand-written tag would drop it.
 */
md.renderer.rules.th_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('scope', 'col')
  return self.renderToken(tokens, idx, options)
}

/** markdown-it does not export Token from its package root; take it from a parse. */
const Token = md.parse('x', {})[0].constructor as new (
  type: string,
  tag: string,
  nesting: number,
) => import('markdown-it').Token

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
        ] as Array<[string, string]>
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
 * Every link in the stream, tested against the manifest — UI-SPEC 11.
 *
 * Shared by both renderers below, and shared rather than copied on purpose:
 * citation integrity is the product's one non-negotiable promise, and a second
 * copy of this walk is a second thing to keep in step with it.
 *
 * @param {import('markdown-it').Token[]} tokens  parsed, mutated in place
 * @param {Set<string>} known  manifest.pages[].path
 * @returns {string[]}  the hrefs that were de-linked
 */
function filterLinks(tokens, known) {
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
  const stack = []
  const repair = (list) => {
    for (const token of list) {
      if (token.children) repair(token.children)
      if (token.type === 'link_open') stack.push(token.tag)
      if (token.type === 'link_close') token.tag = stack.pop() || 'span'
    }
  }
  repair(tokens)

  return delinked
}

/**
 * @param {string} text     answer markdown
 * @param {Set<string>} known  manifest.pages[].path
 * @param {Array<{n:number, href:string, title:string}>} sources  validated citations, in order
 * @returns {{ html: string, delinked: string[] }}
 */
export function renderAnswer(text, known, sources = []) {
  const tokens = md.parse(String(text || ''), {})
  const delinked = filterLinks(tokens, known)

  if (sources.length) linkMarkers(tokens, sources)

  return { html: md.renderer.render(tokens, md.options, {}), delinked }
}

/**
 * The retrieved chunk behind a citation, as the page reads it — ui-specs/009.
 *
 * The passage is CORPUS MARKDOWN, not prose about it: `## Heading`, `**bold**`,
 * a fence, a table. Shown as a text node it was the one surface in the panel
 * that made a reader parse markdown themselves, next to an answer that never
 * asks them to. Rendering it changes nothing about *what* is shown — the whole
 * chunk, still uncut, which is the invariant 009 argues for — only whether the
 * syntax is in front of the text or behind it.
 *
 * The same link filter as the answer, and NOT because a chunk can lie: it can't,
 * it is what the site's own author wrote. It is because a corpus link is written
 * relative to the page it sits on (`./config.md`, `../guide/`), and resolved
 * against a panel teleported to `body` it points at nothing. `isKnownPath`
 * already answers exactly that question, so a link that survives it is one the
 * reader can follow and every other one degrades to the text it wrapped.
 *
 * No `sources`, so no `linkMarkers`: a literal `[1]` in the corpus is prose
 * about a footnote on that page, not a citation into this turn's list.
 *
 * @param {string} text  the chunk, verbatim
 * @param {Set<string>} known  manifest.pages[].path
 * @returns {string}  html
 */
export function renderPassage(text, known) {
  const tokens = md.parse(String(text || ''), {})
  filterLinks(tokens, known)
  return md.renderer.render(tokens, md.options, { copy: false })
}

/**
 * Markdown as the text under it — the search-only snippet.
 *
 * A result row shows a 220-character window of a chunk so a reader can tell
 * whether it is the one they want, and 220 characters spent on `**`, `##` and
 * `](/guide/config#tokens)` are characters that do not help them decide.
 *
 * Over the TOKEN STREAM rather than a set of regexes, for the reason at the top
 * of this file: a regex here would be a second parser that one day disagrees
 * with the first, and this one runs on text a reader then searches by eye.
 *
 * Blocks are separated by a single newline and inline breaks become spaces, so
 * the result survives being cut mid-sentence — which is what `excerptWindow`
 * does to it next.
 *
 * @param {string} text  markdown
 * @returns {string}  plain text
 */
export function toPlainText(text) {
  const out = []

  const walk = (list) => {
    for (const token of list) {
      if (token.children) {
        walk(token.children)
        continue
      }
      if (token.type === 'text' || token.type === 'code_inline') out.push(token.content)
      // A fence is content the reader is looking for as much as any sentence —
      // half the answers in a documentation corpus ARE the code block.
      else if (token.type === 'fence' || token.type === 'code_block')
        out.push(`${token.content.trim()}\n`)
      else if (token.type === 'softbreak' || token.type === 'hardbreak') out.push(' ')
      else if (token.type === 'hr') out.push('\n')
      // A row of cells is one line, so the cells need a separator of their own;
      // every other block close ends the line.
      else if (token.type === 'th_close' || token.type === 'td_close') out.push(' ')
      // `token.block` is the whole test: an `em_close` or a `link_close` sits
      // INSIDE a sentence, and ending the line there would cut every emphasised
      // phrase in the corpus in half.
      else if (token.block && token.nesting === -1) out.push('\n')
    }
  }

  walk(md.parse(String(text || ''), {}))

  return out
    .join('')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Inline citation markers `[1]` → a placeholder the component turns into buttons. */
export function extractMarkers(text) {
  return [...String(text || '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
}
