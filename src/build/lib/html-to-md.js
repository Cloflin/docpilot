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

import { textOf, tooltips } from './html-extract.js'

/** Block elements that end a paragraph run. Everything else is inline. */
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'br', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
])

/**
 * Characters that would change the meaning of the line they land in.
 *
 * Deliberately not the full CommonMark set. Escaping every `*` and `_` inside
 * ordinary prose produces a file full of backslashes that a human then has to
 * read, and the ones that actually bite are the line-leading markers — a
 * sentence beginning "- " becomes a list, "# " becomes a heading. So inline
 * escaping covers the two delimiters that pair up (`[`, `` ` ``) and the rest is
 * handled per line, at the only place it can be a marker.
 */
function escapeInline(text) {
  return text.replace(/([[\]`])/g, '\\$1')
}

/** A line that would be read as a block marker gets its leader escaped. */
function escapeLeader(line) {
  return line.replace(/^(\s*)([-+*>#]|\d+[.)])(\s)/, '$1\\$2$3')
}

/** `<a href>` → absolute, or null for a link that is not one. */
function absolute(href, origin) {
  if (!href) return null
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return null
  // Only http(s) survives. `javascript:` and `data:` are the two with names and
  // the allowlist already refuses them at build time; dropping them here means
  // they never reach a file that somebody could then trust.
  try {
    const url = new URL(raw, origin || undefined)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** The language of a `<pre><code class="language-js">` fence, if it names one. */
function fenceLanguage(el) {
  const code = el.querySelector?.('code') || el
  const cls = code.getAttribute?.('class') || ''
  const m = /(?:language|lang|highlight)[-_]([a-z0-9+#]+)/i.exec(cls)
  return m ? m[1].toLowerCase() : ''
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
  const kids = () => [...(node.childNodes || [])].map((n) => inline(n, ctx)).join('')

  switch (tag) {
    case 'br':
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
      const raw = String(node.textContent || '').replace(/\s+/g, ' ').trim()
      if (!raw) return ''
      const ticks = '`'.repeat(Math.max(...[...raw.matchAll(/`+/g)].map((m) => m[0].length), 0) + 1)
      return `${ticks}${raw}${ticks}`
    }
    case 'del':
    case 's':
      return kids()
    case 'a': {
      const inner = kids().trim()
      if (!inner) return ''
      const href = absolute(node.getAttribute('href'), ctx.origin)
      // A link the reader cannot follow is still a sentence they can read.
      return href ? `[${inner}](${href})` : inner
    }
    default:
      return kids()
  }
}

/** One table row's cells, already inline-serialised and pipe-safe. */
function rowCells(tr, ctx) {
  return [...tr.children]
    .filter((c) => /^(td|th)$/i.test(c.tagName || ''))
    .map((c) => inline(c, ctx).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim())
}

/**
 * A GFM table, or null when the element is a layout table rather than data.
 *
 * The distinction is not cosmetic: a one-column "table" is a list, and marketing
 * pages use tables for columns of unrelated blocks. Emitting those as tables
 * produces chunks whose every line is a pipe, which retrieves for nothing.
 */
function table(el, ctx) {
  const rows = [...el.querySelectorAll('tr')].map((tr) => rowCells(tr, ctx)).filter((r) => r.length)
  if (rows.length < 2) return null
  const width = Math.max(...rows.map((r) => r.length))
  if (width < 2) return null

  const pad = (r) => [...r, ...Array(width - r.length).fill('')]
  const head = pad(rows[0])
  const body = rows.slice(1).map(pad)
  return [
    `| ${head.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

/** A `<ul>`/`<ol>`, nested lists included, at the given indent. */
function list(el, ctx, depth = 0) {
  const ordered = /^ol$/i.test(el.tagName || '')
  const indent = '  '.repeat(depth)
  const out = []
  let n = Number(el.getAttribute?.('start') || 1)

  for (const li of [...(el.children || [])].filter((c) => /^li$/i.test(c.tagName || ''))) {
    const nested = []
    const own = []
    for (const child of [...(li.childNodes || [])]) {
      const tag = String(child.tagName || '').toLowerCase()
      if (tag === 'ul' || tag === 'ol') {
        nested.push(list(child, ctx, depth + 1))
      } else if (tag === 'p' || tag === 'div') {
        own.push(inline(child, ctx))
      } else {
        own.push(inline(child, ctx))
      }
    }
    const text = own.join(' ').replace(/\s+/g, ' ').trim()
    if (!text && !nested.length) continue
    const marker = ordered ? `${n++}.` : '-'
    out.push(`${indent}${marker} ${text}`.trimEnd())
    for (const block of nested) if (block) out.push(block)
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
  for (const child of [...(el.children || [])]) {
    const tag = String(child.tagName || '').toLowerCase()
    if (tag === 'dt') term = inline(child, ctx).replace(/\s+/g, ' ').trim()
    else if (tag === 'dd') {
      const def = inline(child, ctx).replace(/\s+/g, ' ').trim()
      if (def) out.push(term ? `- **${term}** — ${def}` : `- ${def}`)
    }
  }
  return out.join('\n')
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

    if (/^h[1-6]$/.test(tag)) {
      const text = inline(node, ctx).replace(/\s+/g, ' ').trim()
      if (text) yield { kind: 'h', level: Number(tag[1]), text }
      continue
    }

    if (tag === 'p') {
      const text = inline(node, ctx).replace(/[ \t]+/g, ' ').trim()
      if (text) yield { kind: 'p', text: escapeLeader(text) }
      continue
    }

    if (tag === 'pre') {
      const code = String(node.textContent || '').replace(/\n+$/, '')
      if (code.trim()) yield { kind: 'code', lang: fenceLanguage(node), text: code }
      continue
    }

    if (tag === 'ul' || tag === 'ol') {
      const text = list(node, ctx)
      if (text.trim()) yield { kind: 'list', text }
      continue
    }

    if (tag === 'dl') {
      const text = definitions(node, ctx)
      if (text.trim()) yield { kind: 'list', text }
      continue
    }

    if (tag === 'table') {
      const text = table(node, ctx)
      if (text) {
        yield { kind: 'table', text, notes: tooltips(node) }
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
    if ([...(node.children || [])].length) {
      yield* blocks(node, ctx)
      continue
    }
    const text = inline(node, ctx).replace(/\s+/g, ' ').trim()
    if (text) yield { kind: 'p', text: escapeLeader(text) }
  }
}

/**
 * The page body, as markdown.
 *
 * @param {any} root the pruned subtree from `pickMain` + `prune`
 * @param {{ origin?: string, minHeading?: number }} [options]
 *   `origin` resolves relative hrefs. `minHeading` is the level the shallowest
 *   heading is normalised to — 2, so the file's single `#` stays the title the
 *   frontmatter names and the source page's own `<h1>` does not compete with it.
 * @returns {{ markdown: string, headings: string[], links: string[] }}
 */
export function toMarkdown(root, { origin = '', minHeading = 2 } = {}) {
  const ctx = { origin }
  const found = [...blocks(root, ctx)]

  // Normalise the heading ladder before rendering. A page whose sections are
  // `<h3>` because of how its template nests would otherwise produce a file
  // with no `##` at all, and the chunker splits on heading level.
  const levels = found.filter((b) => b.kind === 'h').map((b) => b.level)
  const shift = levels.length ? minHeading - Math.min(...levels) : 0

  const out = []
  const headings = []
  const links = new Set()

  for (const block of found) {
    if (block.kind === 'h') {
      const level = Math.min(6, Math.max(minHeading, block.level + shift))
      headings.push(block.text)
      out.push(`${'#'.repeat(level)} ${block.text}`)
      continue
    }
    if (block.kind === 'code') {
      // The fence is as long as it needs to be: a sample that itself contains a
      // ``` line — every page documenting markdown has one — would otherwise
      // close the block in the middle of itself.
      const longest = Math.max(0, ...[...block.text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1].length))
      const fence = '`'.repeat(Math.max(3, longest + 1))
      out.push(`${fence}${block.lang}\n${block.text}\n${fence}`)
      continue
    }
    out.push(block.text)
    if (block.kind === 'table' && block.notes?.length) {
      // The skill's rule, and the reason it exists: a `data-tippy-content` is
      // frequently the only definition a term in the table has anywhere on the
      // page, and it is invisible to anything that reads text nodes.
      out.push(block.notes.map((n) => `- **${n.term}** — ${n.definition}`).join('\n'))
    }
  }

  for (const m of out.join('\n').matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) links.add(m[1])

  const markdown = out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()

  return { markdown, headings, links: [...links] }
}
