/**
 * Markdown normalisation — RAG-SPEC 2.2.
 *
 * Pure, synchronous, no I/O, no Ollama. `scripts/rag-lint.js` re-chunks from
 * source with this module on every PR, which is why it must stay dependency-free.
 */

/** A chunk may never exceed this many characters. RAG-SPEC 2.3 rule 7. */
export const MAX_CHUNK_CHARS = 8000

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/

/**
 * A fence opener, or null: the character, its run length, the indent it sits at
 * and its info string.
 *
 * Exported because `chunker.js` needs exactly this pair and currently keeps its
 * own copy. It imports this module already, and this module imports nothing, so
 * the shared home for the scan is here.
 */
export function openFence(line) {
  const m = FENCE.exec(line)
  return m ? { char: m[2][0], len: m[2].length, indent: m[1], info: m[3] } : null
}

/** CommonMark: same character, at least as long as the opener, nothing else on the line. */
export function closesFence(line, open) {
  const m = FENCE.exec(line)
  return !!m && m[2][0] === open.char && m[2].length >= open.len && !m[3].trim()
}

/**
 * THE fence scan. Every pass in this module reads fences through this one
 * function, so no two of them can disagree about which lines are code.
 *
 * A disagreement here is not a formatting nit: `applyLlmTags` decides whether an
 * author's `<llm-exclude>` is honoured, and `extractFaq` decides whether a Q&A
 * shown in a sample is published as if the page had asserted it.
 *
 * CLOSED BY CommonMark's RULE, not by a toggle. The toggle this replaces flipped
 * on any /^\s*(```|~~~)/ line, so one fence shown INSIDE another inverted it and
 * every line after the sample read as code — or, worse, the other way round.
 * Both directions lose content silently. Reading real prose as code makes
 * `applyLlmTags` copy an `<llm-exclude>` block straight through, publishing what
 * the author marked private; reading a sample as prose hands its body to
 * `stripVue`, and one unterminated `<script>` in a documented snippet then
 * deletes every line to end of file. A page that shows one fence style inside
 * the other is not exotic — it is what every page documenting markdown does.
 *
 * The fence line itself is reported as code, so no transform ever rewrites an
 * opener or a closer. An unclosed fence runs to end of file, which is the
 * reading the toggle gave it too.
 */
function eachLine(src, fn) {
  let open = null
  for (const line of String(src).split('\n')) {
    if (open) {
      if (closesFence(line, open)) open = null
      fn(line, true)
      continue
    }
    const o = openFence(line)
    if (o) {
      open = o
      fn(line, true)
      continue
    }
    fn(line, false)
  }
}

/**
 * Every text transform below runs on unfenced lines only. Collapsing runs of
 * spaces inside a code sample would silently reindent it, and the corpus is a
 * developer documentation site where indentation is the content.
 */
function eachUnfencedLine(src, fn) {
  const out = []
  eachLine(src, (line, fenced) => out.push(fenced ? line : fn(line)))
  return out.join('\n')
}

/**
 * The unfenced text as the RUNS it falls into, not as one joined string.
 *
 * For the one pass that matches ACROSS lines. Concatenating the prose either
 * side of a removed fence would let a pattern span the gap and pair two things
 * the document never put next to each other — see `extractFaq`.
 */
function unfencedRuns(src) {
  const runs = []
  let cur = []
  eachLine(src, (line, fenced) => {
    if (!fenced) {
      cur.push(line)
      return
    }
    if (cur.length) runs.push(cur.join('\n'))
    cur = []
  })
  if (cur.length) runs.push(cur.join('\n'))
  return runs
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
 *
 * INLINE CODE IS MASKED before any of that, on the same terms the fence already
 * had. A sentence that names the tag in backticks is prose ABOUT the feature, not
 * a directive — and the page most likely to contain one is the page documenting
 * it. This package's own `reference/cli` said "this pass may add `<llm-only>` and
 * `<llm-exclude>`", which opened the machine on a page nobody had marked private
 * and dropped every line after it from the index; `guide/imported-pages` did the
 * same. The rule above is unchanged for a tag anyone actually wrote: an unclosed
 * one still excludes to end of file, and only the backticks are read as quoting.
 */
const SPAN = '\uE000'
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1/g

/** Backticked runs out, placeholders in — see `applyLlmTags`. */
function maskCode(line) {
  const spans = []
  const masked = line.replace(CODE_SPAN, (m) => {
    spans.push(m)
    return `${SPAN}${spans.length - 1}${SPAN}`
  })
  return { masked, spans }
}

/**
 * Placeholders back out. A line the machine TRUNCATED can end mid-placeholder —
 * the truncated half is excluded text, so what is left of a broken marker is
 * dropped rather than restored.
 */
function unmaskCode(line, spans) {
  return line
    .replace(new RegExp(`${SPAN}(\\d+)${SPAN}`, 'g'), (_, i) => spans[Number(i)] ?? '')
    .replace(new RegExp(`${SPAN}\\d*`, 'g'), '')
}

export function applyLlmTags(src, warn) {
  const out = []
  let excluding = false
  let sawExclude = false

  eachLine(src, (line, fenced) => {
    if (fenced) {
      if (!excluding) out.push(line)
      return
    }

    const { masked, spans } = maskCode(line)
    let l = masked

    // Inline forms first, so a one-line pair never opens the state machine.
    l = l.replace(/<llm-exclude>[\s\S]*?<\/llm-exclude>/gi, '')
    l = l.replace(/<llm-only>([\s\S]*?)<\/llm-only>/gi, '$1')

    if (/<\/llm-exclude>/i.test(l)) {
      excluding = false
      l = l.replace(/^[\s\S]*?<\/llm-exclude>/i, '')
      if (!unmaskCode(l, spans).trim()) return
    } else if (excluding) {
      return
    }

    if (/<llm-exclude>/i.test(l)) {
      sawExclude = true
      excluding = true
      l = l.replace(/<llm-exclude>[\s\S]*$/i, '')
      if (!unmaskCode(l, spans).trim()) return
    }

    // Whatever is left of an <llm-only> wrapper is just a wrapper.
    l = l.replace(/<\/?llm-only>/gi, '')
    out.push(unmaskCode(l, spans))
  })

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
 * Frontmatter → { title, description, layout, source, body }.
 *
 * `description` is kept as well as the title because it is the one sentence an
 * author has already written that says what the whole page is FOR — the same
 * string vitepress-plugin-llms puts beside the page's link in llms.txt. Section
 * headings say what a passage contains; nothing else on the page says what the
 * reader would have come there to do, which is what a question is phrased as.
 *
 * `source` is the external page this one was imported from. It is read here
 * rather than parsed at the call site so that ONE regex decides what a
 * provenance line looks like, and it is deliberately anchored at column 0: a
 * nested `source:` under some other key belongs to that key, not to the page.
 * The value is not validated here — `sources.js` owns the allowlist, and this
 * module stays dependency-free and I/O-free by contract.
 */
export function splitFrontmatter(src) {
  // CRLF is matched as well as LF. A Windows checkout — or `core.autocrlf` on a
  // Unix one — otherwise misses here entirely, and the failure is loud in the
  // wrong place: the frontmatter is never removed, so its raw YAML is indexed as
  // prose, title and description come back null, and an imported page whose
  // `source:` line is sitting right there fails the provenance check with "has
  // no frontmatter source". The sibling parser in markdown-alternate.js already
  // accepts both endings; these two must not disagree about what a document is.
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { title: null, description: null, layout: null, source: null, body: src }
  const title = /^title:\s*(.+)$/m.exec(m[1])
  const description = /^description:\s*(.+)$/m.exec(m[1])
  const layout = /^layout:\s*(.+)$/m.exec(m[1])
  const source = /^source:\s*(.+)$/m.exec(m[1])
  // A double-quoted scalar is unquoted through JSON.parse rather than by
  // trimming the quote characters, so a value containing an escape — which is
  // how `import.js` writes every value it takes off a remote page — reads back
  // as what it was, not as its source text with the outer quotes shaved off.
  const clean = (v) => {
    if (!v) return null
    const raw = v[1].trim()
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw)
      } catch {
        // Not JSON after all; fall through to the plain form.
      }
    }
    return raw.replace(/^['"]|['"]$/g, '')
  }
  return {
    title: clean(title),
    description: clean(description),
    layout: clean(layout),
    source: clean(source),
    body: src.slice(m[0].length),
  }
}

/**
 * Custom containers are unwrapped into text rather than dropped: a `::: warning`
 * block is often the only place a constraint is stated.
 */
export function unwrapContainers(src) {
  return eachUnfencedLine(src, (line) =>
    line
      .replace(/^:::\s*success\s*$/i, 'Note:')
      .replace(/^:::\s*info-clear\s*$/i, 'Note:')
      .replace(/^:::\s*custom-warning\s*$/i, 'Warning:')
      .replace(/^:::\s*image-wrap.*$/i, '')
      .replace(/^:::\s*openapi\s+(\S+)\s*$/i, (_m, name) => `See API reference: /reference/${name}`)
      .replace(/^:::\s*$/, ''),
  )
}

/**
 * Vue islands. FaqAccordion is extracted separately, before this runs.
 *
 * A line state machine on the same pattern as `applyLlmTags`, and for the same
 * reason: a page that DOCUMENTS a `<script>` embed puts one in a fenced sample,
 * and the multiline regex this replaces reached straight into that fence and
 * deleted the sample's body. That is content loss at index time with nothing to
 * show for it — the page still renders the example, the index no longer has it.
 */
export function stripVue(src) {
  const out = []
  /** The closing tag being waited on, or null when not inside an island. */
  let closing = null

  eachLine(src, (line, fenced) => {
    if (fenced) {
      out.push(line)
      return
    }

    let l = line
    if (closing) {
      const end = closing.exec(l)
      if (!end) return
      l = l.slice(end.index + end[0].length)
      closing = null
    }

    // Inline forms first, so a one-line island never opens the state machine.
    l = l
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<FaqAccordion[\s\S]*?\/>/gi, '')

    // What is left of an opener runs to a later line.
    const open = /<(script|style)\b[^>]*>|<FaqAccordion\b/i.exec(l)
    if (open) {
      closing = open[1] ? new RegExp(`</${open[1]}>`, 'i') : /\/>/
      l = l.slice(0, open.index)
    }
    out.push(l)
  })
  return out.join('\n')
}

/**
 * Extract the question/answer pairs of a <FaqAccordion :items="[…]"> island so
 * they become chunks of their own instead of vanishing with the tag.
 *
 * A FENCED SAMPLE IS NOT AN ISLAND. This used to read the whole page, so a page
 * DOCUMENTING the component — `<FaqAccordion :items="[{ question: 'Sample
 * question?', answer: 'Sample answer.' }]" />` inside a ```vue fence — produced a
 * `#faq-1` chunk asserting a question and an answer the page never gave. A
 * fabricated chunk is worse than a missing one: nothing downstream can tell it
 * apart from a real one, and it is retrieved, quoted and cited like any other.
 *
 * Each unfenced RUN is scanned on its own, never the runs joined back together:
 * the pattern tolerates 40 characters between `question:` and `answer:`, so a
 * join across a removed fence could pair one island's question with the answer
 * of whatever came after the sample.
 */
export function extractFaq(src) {
  const out = []
  for (const run of unfencedRuns(src)) {
    // Fresh per run — a /g regex carries `lastIndex` between calls, and a shared
    // one would start each run wherever the previous one stopped.
    const re = /question:\s*(['"`])([\s\S]*?)\1[\s\S]{0,40}?answer:\s*(['"`])([\s\S]*?)\3/g
    let m
    while ((m = re.exec(run))) out.push({ question: m[2].trim(), answer: m[4].trim() })
  }
  return out
}

/**
 * An ATX heading, on markdown-it's terms: up to three spaces of indent, one to
 * six `#`, then whitespace or end of line. `#tag` is not a heading.
 */
const ATX_HEADING = /^ {0,3}#{1,6}(\s|$)/

/**
 * Links keep their route: the model must see `/getting-started` to be able to
 * cite it.
 *
 * A HEADING KEEPS ITS TEXT AND NOTHING ELSE. The heading line is what the
 * chunker slugs into the anchor a citation points at, and VitePress builds its
 * anchor from the heading's rendered TEXT — markdown-it-anchor never sees a
 * link's destination. Anything added here makes the two disagree:
 * `### [Template Modifications](/extensions/tutorials/how-to/template-modifications)`
 * became `### Template Modifications (/extensions/…/template-modifications)` and
 * slugged to `template-modifications-extensionstutorialshow-totemplate-modifications`
 * against a real anchor of `template-modifications`, so all four sections of
 * stripo-docs' `extensions/tutorials.md` cited fragments that exist nowhere,
 * under a citation label with the raw route printed inside it.
 *
 * The brackets go with the route rather than being left behind: `slug()` drops
 * `[`, `]`, `(` and `)` but not the slashes between them, so leaving the link
 * syntax in place would slug to `template-modificationsextensions…` — wrong the
 * same way, and with the markup showing in the label.
 *
 * Dropping the destination costs nothing: a heading's link is navigation, the
 * page it points at is indexed under its own route, and this is already exactly
 * how a `#fragment` link is treated everywhere else on the page.
 */
export function flattenLinks(src) {
  // Unfenced only, like every other transform here: a fenced sample showing
  // markdown link syntax is documentation about links, not a link.
  return eachUnfencedLine(src, (line) => {
    const heading = ATX_HEADING.test(line)
    return line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) =>
      heading || href.startsWith('#') ? text : `${text} (${href})`,
    )
  })
}

/** Remaining HTML tags go; their text content stays. */
export function stripHtml(src) {
  return eachUnfencedLine(src, (line) =>
    line
      // Autolinks are unwrapped before the tag sweep, not swept by it. `<https://
      // example.com>` starts with a letter, so the tag pattern below matches the
      // whole thing and takes the URL with it — losing the address entirely,
      // while an ordinary [text](url) link keeps its href through flattenLinks.
      .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&nbsp;/g, ' '),
  )
}

/**
 * The full pipeline, in the order RAG-SPEC 2.2 specifies.
 * Returns { title, description, layout, source, faq, text, warnings }.
 */
export function normaliseMarkdown(src) {
  const { title, description, layout, source, body } = splitFrontmatter(src)
  const warnings = []
  // Before stripVue and, critically, before stripHtml: an unknown tag reaching
  // stripHtml loses its brackets and keeps its content.
  let t = applyLlmTags(body, (m) => warnings.push(m))
  // THE FAQ COMES OFF applyLlmTags' OUTPUT, NEVER OFF `body`.
  //
  // It used to be extracted from the raw page, one line above this pass, which
  // made `<llm-exclude>` a no-op over a FaqAccordion island: applyLlmTags never
  // saw the island, stripVue deleted the tag from the prose stream a step later
  // so the page looked correctly redacted, and the Q&A was already sitting in
  // `faq[]` on its way to becoming an indexed, citable `#faq-n` chunk. Excluding
  // too much is recoverable; publishing something an author marked private is
  // not — and here the author had marked it, and it was published anyway.
  //
  // Still before stripVue, which is what deletes the island this reads.
  const faq = extractFaq(t)
  t = stripVue(t)
  t = unwrapContainers(t)
  t = stripImages(t)
  t = flattenLinks(t)
  t = stripHtml(t)
  t = collapseWhitespace(t)
  t = t.replace(/\n{3,}/g, '\n\n')
  return { title, description, layout, source, faq, text: t.trim(), warnings }
}
