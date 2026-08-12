/**
 * Markdown normalisation — RAG-SPEC 2.2.
 *
 * Pure, synchronous, no I/O, no Ollama. `scripts/rag-lint.js` re-chunks from
 * source with this module on every PR, which is why it must stay dependency-free.
 */

/** A chunk may never exceed this many characters. RAG-SPEC 2.3 rule 7. */
export const MAX_CHUNK_CHARS = 8000

/**
 * Split a document into fenced and unfenced runs.
 *
 * Every text transform below runs on unfenced lines only. Collapsing runs of
 * spaces inside a code sample would silently reindent it, and the corpus is a
 * developer documentation site where indentation is the content.
 */
function eachUnfencedLine(src, fn) {
  const out = []
  let fenced = false
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      out.push(line)
      continue
    }
    out.push(fenced ? line : fn(line))
  }
  return out.join('\n')
}

/**
 * `<llm-only>` and `<llm-exclude>` — the vitepress-plugin-llms content tags.
 *
 * The plugin honours them when it writes llms.txt / llms-full.txt / the per-page
 * .md files. The RAG index has to honour them too, or one page has two different
 * meanings depending on which consumer read it — and the failure is silent and
 * backwards: `stripHtml` below removes an unknown tag and KEEPS its content, so
 * without this pass an `<llm-exclude>` block would be indexed rather than
 * dropped, which is the exact inverse of what the author asked for.
 *
 * A line state machine rather than a multiline regex, because the tags are
 * block-level and may span fences, and because a fenced sample that DOCUMENTS
 * the tags must survive verbatim.
 *
 *   <llm-exclude>…</llm-exclude>   the block goes, content included
 *   <llm-only>…</llm-only>         the tags go, content stays
 *
 * An unclosed `<llm-exclude>` excludes to end of file: excluding too much is
 * recoverable, publishing something marked private is not.
 */
export function applyLlmTags(src, warn) {
  const out = []
  let fenced = false
  let excluding = false
  let sawExclude = false

  for (const line of String(src).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      if (!excluding) out.push(line)
      continue
    }
    if (fenced) {
      if (!excluding) out.push(line)
      continue
    }

    let l = line

    // Inline forms first, so a one-line pair never opens the state machine.
    l = l.replace(/<llm-exclude>[\s\S]*?<\/llm-exclude>/gi, '')
    l = l.replace(/<llm-only>([\s\S]*?)<\/llm-only>/gi, '$1')

    if (/<\/llm-exclude>/i.test(l)) {
      excluding = false
      l = l.replace(/^[\s\S]*?<\/llm-exclude>/i, '')
      if (!l.trim()) continue
    } else if (excluding) {
      continue
    }

    if (/<llm-exclude>/i.test(l)) {
      sawExclude = true
      excluding = true
      l = l.replace(/<llm-exclude>[\s\S]*$/i, '')
      if (!l.trim()) continue
    }

    // Whatever is left of an <llm-only> wrapper is just a wrapper.
    l = l.replace(/<\/?llm-only>/gi, '')
    out.push(l)
  }

  if (excluding && sawExclude) {
    warn?.('unclosed <llm-exclude> — excluded to end of file')
  }
  return out.join('\n')
}

/** Read one HTML attribute's value, quoted or bare. */
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? ''
}

/**
 * Images carry no text and are never indexed as one. The prose around an image
 * is the content. RAG-SPEC 2.2 rules 1-3.
 *
 * Matching is attribute-aware — the value is read to its closing quote — because
 * a `data:image/svg+xml` payload contains literal `'` and may contain literal `>`.
 */
export function stripImages(src) {
  return eachUnfencedLine(src, (line) => {
    let l = line

    // 1. inline <svg>…</svg> → its <title>, else nothing
    l = l.replace(/<svg\b[\s\S]*?<\/svg>/gi, (el) => {
      const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(el)
      return t ? t[1].trim() : ''
    })

    // 2. <img> → its alt; data: and .svg sources are dropped outright
    l = l.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/gi, (tag) => {
      const alt = (attr(tag, 'alt') ?? '').trim()
      return alt
    })

    // markdown images collapse to their alt text
    l = l.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => alt.trim())

    return l
  })
}

/**
 * Whitespace. RAG-SPEC 2.2 rule 3 — the rule that actually does the work.
 *
 * Markdown pads every cell of a table to the width of the widest cell in its
 * column. One 16 KB <img> tag therefore pads its column's other 204 rows to
 * ~16 KB each: measured, `icons-management.md` was 93.3% literal spaces, and
 * stripping only the data: URIs removed 6.5% of it and left 3.07 MB behind.
 */
export function collapseWhitespace(src) {
  return eachUnfencedLine(src, (line) => {
    let l = line
    // A table delimiter row is padding by construction.
    if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) l = l.replace(/-{4,}/g, '---')
    return l.replace(/ {2,}/g, ' ').replace(/\s+$/, '')
  })
}

/**
 * Frontmatter → { title, description, layout, body }.
 *
 * `description` is kept as well as the title because it is the one sentence an
 * author has already written that says what the whole page is FOR — the same
 * string vitepress-plugin-llms puts beside the page's link in llms.txt. Section
 * headings say what a passage contains; nothing else on the page says what the
 * reader would have come there to do, which is what a question is phrased as.
 */
export function splitFrontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src)
  if (!m) return { title: null, description: null, layout: null, body: src }
  const title = /^title:\s*(.+)$/m.exec(m[1])
  const description = /^description:\s*(.+)$/m.exec(m[1])
  const layout = /^layout:\s*(.+)$/m.exec(m[1])
  const clean = (v) => (v ? v[1].trim().replace(/^['"]|['"]$/g, '') : null)
  return {
    title: clean(title),
    description: clean(description),
    layout: clean(layout),
    body: src.slice(m[0].length),
  }
}

/**
 * Custom containers are unwrapped into text rather than dropped: a `::: warning`
 * block is often the only place a constraint is stated.
 */
export function unwrapContainers(src) {
  return src
    .replace(/^:::\s*success\s*$/gim, 'Note:')
    .replace(/^:::\s*info-clear\s*$/gim, 'Note:')
    .replace(/^:::\s*custom-warning\s*$/gim, 'Warning:')
    .replace(/^:::\s*image-wrap.*$/gim, '')
    .replace(/^:::\s*openapi\s+(\S+)\s*$/gim, (_m, name) => `See API reference: /reference/${name}`)
    .replace(/^:::\s*$/gm, '')
}

/** Vue islands. FaqAccordion is extracted separately, before this runs. */
export function stripVue(src) {
  return src
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<FaqAccordion[\s\S]*?\/>/gi, '')
}

/**
 * Extract the question/answer pairs of a <FaqAccordion :items="[…]"> island so
 * they become chunks of their own instead of vanishing with the tag.
 */
export function extractFaq(src) {
  const out = []
  const re = /question:\s*(['"`])([\s\S]*?)\1[\s\S]{0,40}?answer:\s*(['"`])([\s\S]*?)\3/g
  let m
  while ((m = re.exec(src))) out.push({ question: m[2].trim(), answer: m[4].trim() })
  return out
}

/** Links keep their route: the model must see `/getting-started` to be able to cite it. */
export function flattenLinks(src) {
  return src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) =>
    href.startsWith('#') ? text : `${text} (${href})`,
  )
}

/** Remaining HTML tags go; their text content stays. */
export function stripHtml(src) {
  return eachUnfencedLine(src, (line) =>
    line.replace(/<\/?[a-z][^>]*>/gi, '').replace(/&nbsp;/g, ' '),
  )
}

/**
 * The full pipeline, in the order RAG-SPEC 2.2 specifies.
 * Returns { title, description, layout, faq, text, warnings }.
 */
export function normaliseMarkdown(src) {
  const { title, description, layout, body } = splitFrontmatter(src)
  const warnings = []
  const faq = extractFaq(body)
  let t = body
  // Before stripVue and, critically, before stripHtml: an unknown tag reaching
  // stripHtml loses its brackets and keeps its content.
  t = applyLlmTags(t, (m) => warnings.push(m))
  t = stripVue(t)
  t = unwrapContainers(t)
  t = stripImages(t)
  t = flattenLinks(t)
  t = stripHtml(t)
  t = collapseWhitespace(t)
  t = t.replace(/\n{3,}/g, '\n\n')
  return { title, description, layout, faq, text: t.trim(), warnings }
}
