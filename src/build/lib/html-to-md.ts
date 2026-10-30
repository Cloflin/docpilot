/**
 * DOM → Markdown, for an imported page.
 *
 * Not a general-purpose converter, and the difference matters. A general one
 * asks "what does this HTML look like"; this one asks "what of this HTML is
 * documentation", which is why it emits a small, closed set of constructs —
 * headings, paragraphs, lists, tables, code, quotes, links — and drops
 * everything it does not recognise rather than inventing a representation for
 * it. Anything that survives here is something the chunker, the gate and a
 * reader all already understand.
 *
 * The output is markdown the repository's own indexer reads: no raw HTML, no
 * images, no reference links, no hard-wrapped lines. Hard wrapping is worth a
 * word — the chunker splits on blank lines and headings, so a wrapped paragraph
 * is the same chunk either way, but a wrapped TABLE is not a table any more.
 *
 * Absolute URLs only. A relative `href` on an imported page points at a route of
 * the SOURCE site, not of this one, and resolving it later — after the file has
 * been written and the origin forgotten — is not possible.
 */

import { textOf } from './html-extract.js'
import { codeBlock, isCodeBlock } from './html-code.js'
import { createLinkResolver } from './html-links.js'
import { tableBlock } from './html-table.js'
import { renderBlocks } from './ir.js'

/** Block elements that end a paragraph run. Everything else is inline. */
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'br', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
])

/**
 * The ids a heading may carry into `## Title {#id}`.
 *
 * The form the chunker's `{#…}` rule accepts, and the length a hand-written
 * anchor has. Anything else — a space, a leading digit, a 300-character
 * generated hash — would become an anchor nobody can link to (engine-spec 043,
 * HTML-04).
 */
const HEADING_ID = /^[A-Za-z][\w-]{0,63}$/

/** Elements whose text is never page text: code, styling, inert markup, graphics. */
const INERT = new Set(['script', 'style', 'template', 'svg', 'noscript'])

/**
 * Characters that would change the meaning of the line they land in.
 *
 * Deliberately not the full CommonMark set. Escaping every `*` and `_` inside
 * ordinary prose produces a file full of backslashes that a human then has to
 * read, and the ones that actually bite are the line-leading markers — a
 * sentence beginning "- " becomes a list, "# " becomes a heading. So inline
 * escaping covers the two delimiters that pair up (`[`, `` ` ``) and the rest is
 * handled per line, at the only place it can be a marker.
 *
 * The backslash comes first. Left alone, page text `\[a\](https://x.test)`
 * became `\\[a\\](https://x.test)`, where `\\` is a literal backslash and
 * the brackets are live: a link the resolver never saw and the counters never
 * counted (WR-04, engine-spec 043).
 */
export function escapeInline(text) {
  return (
    text
      .replace(/([\\[\]`])/g, '\\$1')
      // A decoded `&lt;llm-exclude&gt;` is the text `<llm-exclude>`, and left raw
      // it is an annotation tag: `applyLlmTags` would drop the rest of the page
      // (engine-spec 043, T-02-17). `&lt;` renders as `<` (markdown-it, html:
      // false). Code spans and fences never pass through here and keep the raw
      // character, which `applyLlmTags` masks.
      .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
  )
}

/** A line that would be read as a block marker gets its leader escaped. */
export function escapeLeader(line) {
  return line.replace(/^(\s*)([-+*>#]|\d+[.)])(\s)/, '$1\\$2$3')
}

/** The text of an inline code span, a `br` read as the space it stands for. */
function spanText(node) {
  if (node.nodeType === 3) return String(node.data || '')
  if (node.nodeType !== 1) return ''
  if (String(node.tagName || '').toLowerCase() === 'br') return ' '
  return [...(node.childNodes || [])].map(spanText).join('')
}

/**
 * Inline serialisation: the text of a node with its emphasis kept.
 *
 * Recursive over children rather than reading `textContent`, because the whole
 * point is the markup — a `<code>` span that arrives as bare text is a term the
 * reader can no longer tell from prose, and the identifiers inside code spans
 * are what the lexical half of the gate scores on.
 */
function inline(node, ctx) {
  if (node.nodeType === 3) return escapeInline(String(node.data || '').replace(/\s+/g, ' '))
  if (node.nodeType !== 1) return ''

  const tag = String(node.tagName || '').toLowerCase()
  if (INERT.has(tag)) return ''
  const kids = () => [...(node.childNodes || [])].map((n) => inline(n, ctx)).join('')

  switch (tag) {
    case 'br':
      // A code span cannot hold a newline in Markdown, so inside prose a `br`
      // is a space. A block of code built from `br` lines is read before this
      // function is reached, by `html-code.ts`.
      return ' '
    case 'strong':
    case 'b': {
      const inner = kids().trim()
      return inner ? `**${inner}**` : ''
    }
    case 'em':
    case 'i': {
      const inner = kids().trim()
      return inner ? `_${inner}_` : ''
    }
    case 'code':
    case 'kbd':
    case 'samp': {
      // Backticks inside the sample decide the fence width, so a snippet
      // containing a backtick still round-trips.
      const raw = spanText(node).replace(/\s+/g, ' ').trim()
      if (!raw) return ''
      const ticks = '`'.repeat(Math.max(...[...raw.matchAll(/`+/g)].map((m) => m[0].length), 0) + 1)
      return `${ticks}${raw}${ticks}`
    }
    case 'del':
    case 's':
      return kids()
    case 'a': {
      if (ctx.heading && isPermalink(node)) return ''
      const inner = kids().trim()
      if (!inner) return ''
      const href = ctx.links.resolve(node.getAttribute('href'))
      // A link the reader cannot follow is still a sentence they can read.
      return href ? `[${inner}](${href})` : inner
    }
    default:
      return kids()
  }
}

/**
 * What one `li` holds, in source order: a line of text, a code block, or a
 * nested list already written at its own indent.
 *
 * Inline content between blocks is one line of text, joined as it always was.
 * A `p` or a `div` is a line of its own, and a block of code stays a block: the
 * old reading ran every child through `inline()` and joined with a space, so
 * `npm install` and `npm test` in a step's sample became one line of prose and
 * two paragraphs became one (WR-08, engine-spec 043, F-01).
 */
function itemParts(li, ctx, depth) {
  const parts = []
  let run = []
  const flush = () => {
    const text = run.join(' ').replace(/\s+/g, ' ').trim()
    run = []
    if (text) parts.push({ text })
  }
  const walk = (parent) => {
    for (const child of [...(parent.childNodes || [])]) {
      const tag = String(child.tagName || '').toLowerCase()
      if (tag === 'ul' || tag === 'ol') {
        flush()
        const nested = list(child, ctx, depth + 1)
        if (nested) parts.push({ nested })
      } else if (child.nodeType === 1 && isCodeBlock(child)) {
        flush()
        const block = codeBlock(child)
        if (block) parts.push({ block })
      } else if (tag === 'div' && containsBlock(child)) {
        // A wrapper around a sample or a list: its blocks are the item's.
        flush()
        walk(child)
        flush()
      } else if (tag === 'p' || tag === 'div') {
        flush()
        run.push(inline(child, ctx))
        flush()
      } else {
        run.push(inline(child, ctx))
      }
    }
  }
  walk(li)
  flush()
  return parts
}

/** A `<ul>`/`<ol>`, nested lists included, at the given indent. */
function list(el, ctx, depth = 0) {
  const ordered = /^ol$/i.test(el.tagName || '')
  const indent = '  '.repeat(depth)
  const out = []
  // A non-numeric `start` is 1: `Number('abc')` wrote `NaN.` as a marker (IN-03).
  const start = Number.parseInt(el.getAttribute?.('start') || '1', 10)
  let n = Number.isFinite(start) ? start : 1

  for (const li of [...(el.children || [])].filter((c) => /^li$/i.test(c.tagName || ''))) {
    const parts = itemParts(li, ctx, depth)
    if (!parts.length) continue
    const marker = ordered ? `${n++}.` : '-'

    // The first line of text sits on the marker's line. Everything after it is
    // a continuation line under the item's text, with no blank line between:
    // the chunker splits on blank lines, and a split would cut a step from its
    // own sample.
    const lead = parts[0] as any
    const first = typeof lead.text === 'string' ? lead.text : ''
    out.push(`${indent}${marker} ${first}`.trimEnd())

    const under = indent + ' '.repeat(marker.length + 1)
    for (const part of (first ? parts.slice(1) : parts) as any[]) {
      if (part.nested) out.push(part.nested)
      else if (part.block) {
        const fenced = renderBlocks([part.block]).markdown
        out.push(fenced.split('\n').map((l) => (l ? under + l : l)).join('\n'))
      } else out.push(under + escapeLeader(part.text))
    }
  }
  return out.join('\n')
}

/**
 * A definition list, as bold term plus its definition.
 *
 * `<dl>` has no markdown of its own, and the two candidate shapes — a table, or
 * a bullet list — are both worse than this one: a table implies a second column
 * that does not exist, and a bare bullet loses which half is the term.
 */
function definitions(el, ctx) {
  const out = []
  let term = ''
  for (const child of termsAndDefinitions(el)) {
    const tag = String(child.tagName || '').toLowerCase()
    if (tag === 'dt') term = inline(child, ctx).replace(/\s+/g, ' ').trim()
    else {
      const def = inline(child, ctx).replace(/\s+/g, ' ').trim()
      if (def) out.push(term ? `- **${term}** — ${def}` : `- ${def}`)
    }
  }
  return out.join('\n')
}

/**
 * The `dt` and `dd` children of a `dl`, in order, looking through `div`
 * wrappers: HTML5 allows `<dl><div><dt/><dd/></div></dl>` and generators use it
 * for parameter lists. A `dl` read by its direct children alone came out empty
 * and the list vanished (CR-02, engine-spec 043).
 */
function termsAndDefinitions(el): any[] {
  const out = []
  for (const child of [...(el.children || [])]) {
    const tag = String(child.tagName || '').toLowerCase()
    if (tag === 'div') out.push(...termsAndDefinitions(child))
    else if (tag === 'dt' || tag === 'dd') out.push(child)
  }
  return out
}

/**
 * Does this element hold a block anywhere beneath it?
 *
 * Descendants, not just children: a `<div><span><p>…</p></span></div>` is still
 * a container, and flattening it would merge paragraphs the source separated.
 */
function containsBlock(el) {
  for (const child of [...(el.children || [])]) {
    if (BLOCK.has(String(child.tagName || '').toLowerCase())) return true
    if (containsBlock(child)) return true
  }
  return false
}

/**
 * A permalink a site adds inside its own heading: a fragment-only link whose
 * text has no letter or digit (`#`, `¶`, `§`, a zero-width space). It is
 * furniture, and left in it puts a symbol into the title (engine-spec 043).
 */
function isPermalink(a) {
  const href = String(a.getAttribute?.('href') || '').trim()
  return href.startsWith('#') && !/[\p{L}\p{N}]/u.test(String(a.textContent || ''))
}

/**
 * The id a heading carries, or null: its own `id`, else the `id` or `name` of a
 * direct child anchor with no `href`, whichever is a usable id first.
 */
function headingId(el) {
  const own = el.getAttribute?.('id')
  if (own && HEADING_ID.test(own)) return own
  for (const child of [...(el.children || [])]) {
    if (String(child.tagName || '').toLowerCase() !== 'a' || child.hasAttribute?.('href')) continue
    for (const name of ['id', 'name']) {
      const value = child.getAttribute?.(name)
      if (value && HEADING_ID.test(value)) return value
    }
  }
  return null
}

/**
 * Blocks, in document order.
 *
 * A generator rather than a string builder so the caller can see the sequence:
 * the command needs to know where the first heading is (it becomes the page's
 * `#`) and where the tables are (their tooltips become notes underneath).
 */
function* blocks(el, ctx) {
  for (const node of [...(el.childNodes || [])]) {
    if (node.nodeType === 3) {
      const text = String(node.data || '').replace(/\s+/g, ' ').trim()
      if (text) yield { kind: 'p', text: escapeLeader(escapeInline(text)) }
      continue
    }
    if (node.nodeType !== 1) continue

    const tag = String(node.tagName || '').toLowerCase()

    // Code is asked before any other branch: a `pre`, a highlighter's wrapper
    // and a `br`-built sample all have to be recognised before a generic
    // container branch walks into them and splits the lines (engine-spec 043).
    if (isCodeBlock(node)) {
      const b = codeBlock(node)
      if (b) yield b
      continue
    }

    if (/^h[1-6]$/.test(tag)) {
      const text = inline(node, { ...ctx, heading: true }).replace(/\s+/g, ' ').trim()
      const id = headingId(node)
      // The custom-anchor form `chunker.ts` reads and strips (engine-spec 043).
      if (text) yield { kind: 'h', level: Number(tag[1]), text: id ? `${text} {#${id}}` : text }
      continue
    }

    // The label of a `details` is its lead line; the content that follows is
    // walked as a container below, opened or not. Tab panels and ARIA
    // accordions are `html-tabs.ts`'s, not this branch's.
    if (tag === 'summary') {
      // `**` inside the label would nest bold markers into `****x****`.
      const label = inline(node, ctx).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
      if (label) yield { kind: 'p', text: `**${label}**` }
      continue
    }

    if (tag === 'p') {
      const text = inline(node, ctx).replace(/[ \t]+/g, ' ').trim()
      if (text) yield { kind: 'p', text: escapeLeader(text) }
      continue
    }

    if (tag === 'ul' || tag === 'ol') {
      const text = list(node, ctx)
      if (text.trim()) yield { kind: 'list', text }
      continue
    }

    if (tag === 'dl') {
      const text = definitions(node, ctx)
      if (text.trim()) {
        yield { kind: 'list', text }
        continue
      }
      // No pair, but text: a `dl` of another shape is a container, and the
      // walk below keeps its words instead of dropping them (CR-02).
      if (!String(node.textContent || '').trim()) continue
    }

    if (tag === 'table') {
      const found = tableBlock(node, { inline: (n) => inline(n, ctx) })
      if (found) {
        yield found
        continue
      }
      // A layout table is a container, so walk into it rather than past it.
      yield* blocks(node, ctx)
      continue
    }

    if (tag === 'blockquote') {
      const inner = [...blocks(node, ctx)]
        .map((b) => b.text)
        .join('\n\n')
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n')
      if (inner.trim()) yield { kind: 'quote', text: inner }
      continue
    }

    if (tag === 'hr') {
      yield { kind: 'hr', text: '---' }
      continue
    }

    // A container: recurse. A leaf that is not one of the above but carries
    // text — a `<span>` used as a paragraph, which marketing pages are full of
    // — becomes a paragraph, because dropping it would drop a sentence.
    //
    // "Container" means it holds a BLOCK element, not merely that it holds
    // elements. That is what the BLOCK set above is for, and until now nothing
    // consulted it: any node with a child recursed, so `<div>Click <b>Save</b>
    // to continue</div>` came apart into three paragraphs — "Click", "**Save**",
    // "to continue" — one sentence turned into three, and the chunker then
    // indexed the fragments.
    if (containsBlock(node)) {
      yield* blocks(node, ctx)
      continue
    }
    const text = inline(node, ctx).replace(/\s+/g, ' ').trim()
    if (text) yield { kind: 'p', text: escapeLeader(text) }
  }
}

/**
 * Adjacent text nodes, merged into one, throughout the subtree.
 *
 * The parser splits a decoded entity off as a node of its own — `&lt;tag&gt;`
 * arrives as `<`, `tag`, `>` — and `escapeInline` has to see the `<` and the
 * letter after it together to know it starts a tag (engine-spec 043, T-02-17).
 * The DOM is the same document afterwards.
 */
function mergeText(el) {
  let prev = null
  for (const node of [...(el.childNodes || [])]) {
    if (node.nodeType === 3) {
      if (prev) {
        prev.data = String(prev.data || '') + String(node.data || '')
        node.remove()
      } else prev = node
      continue
    }
    prev = null
    if (node.nodeType === 1) mergeText(node)
  }
}

/**
 * The page body, as markdown.
 *
 * Two halves, and only the first is about HTML. `blocks()` reads a DOM and
 * yields the block stream; `renderBlocks` — `ir.js` — turns that stream into
 * markdown, and knows nothing about where it came from. The split is what lets a
 * second format reuse the emitter instead of rewriting the fence-length rule and
 * the heading ladder, and it moved no code: `renderBlocks` is this function's
 * former second half, verbatim.
 *
 * @param {any} root the pruned subtree from `pickMain` + `prune`
 * @param {{ origin?: string, minHeading?: number, links?: any }} [options]
 *   `origin` resolves relative hrefs; `links` is a resolver from `html-links.ts`
 *   when the caller wants the counts (engine-spec 043). `minHeading` is the level the shallowest
 *   heading is normalised to — 2, so the file's single `#` stays the title the
 *   frontmatter names and the source page's own `<h1>` does not compete with it.
 * @returns {{ markdown: string, headings: string[], links: string[] }}
 */
export function toMarkdown(root, { origin = '', minHeading = 2, links = null }: any = {}) {
  const resolver = links || createLinkResolver({ base: origin })
  mergeText(root)
  return renderBlocks([...blocks(root, { origin, links: resolver })], { minHeading })
}
