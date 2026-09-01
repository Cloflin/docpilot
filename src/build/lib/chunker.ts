/**
 * Chunking — RAG-SPEC 2.3.
 *
 * Rules 1-6 are structural preferences. Rule 7 (MAX_CHUNK_CHARS) is a ceiling
 * and cannot be satisfied by preference; rule 8 (embed context) fails the build,
 * because a chunk whose vector represents its first 1% fails silently at every
 * later stage.
 */

import { normaliseMarkdown, MAX_CHUNK_CHARS, openFence, closesFence } from './normalise.js'
import { estTokens } from '../../theme/docpilot/text.js'

export const TARGET_MIN_TOKENS = 350
export const TARGET_MAX_TOKENS = 500
export const MERGE_BELOW_TOKENS = 120
export const EMBED_CONTEXT_TOKENS = 8192

/** GitHub-style heading slug, matching VitePress anchors closely enough to link to. */
export function slug(s) {
  return s
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

// `openFence`/`closesFence` are imported rather than defined here. Both modules
// scan the same text for the same boundaries, and while they disagreed the
// damage ran in both directions: a `~~~` line inside a ``` sample flipped
// normalise's boolean back, so `stripVue` read a snippet's `<script>` as page
// markup and deleted every line to EOF, while the chunker — reading the same
// page correctly — cut chunks the other module had already emptied. One scanner
// is the only version of this that stays true.

/**
 * A GFM table is a row line whose NEXT line is a delimiter row. The pair is what
 * makes it a table: a lone pipe line is prose — a shell pipeline, an alternation
 * in a grammar — and treating one as a table header would put a header on
 * something that has no columns.
 *
 * WHICH LINE IS THE DISCRIMINATOR. It is the delimiter, never the header. GFM
 * makes the outer pipes optional on every row, so `a | b` is a legal header and
 * so is a one-column `| a |` — which means "starts with a pipe" and "has two or
 * more columns", the two things this used to require, both rejected real tables
 * silently, and a table read as prose is cut without its header re-emitted. That
 * is the exact defect splitTable exists to remove.
 *
 * Dropping those two requirements from the HEADER is only safe because the
 * delimiter carries the whole burden instead: it must contain nothing but pipes,
 * colons, dashes and whitespace, every cell must be `:?-+:?`, it must hold at
 * least one pipe, and its cell count must equal the header's. Prose cannot pass
 * that by accident — `Use foo | bar to filter` over `- a list item` disagrees on
 * both shape and count.
 *
 * The pipe requirement is what keeps a setext heading a heading. `Introduction`
 * over `---` is one cell over one all-dashes cell: counts agree, shape agrees,
 * and every `## Heading` written the underline way would become a table header.
 * GitHub draws the same line — cmark-gfm's table extension wants a pipe in the
 * delimiter row — so this is GFM's rule, not a local patch over a bad one.
 */
const DELIM_CELL = /^:?-+:?$/
const UNESCAPED_PIPE = /(?<!\\)\|/

/**
 * One row's cells. Pipes are the separator unless escaped — `html-to-md.js`
 * writes `\|` for a pipe inside a cell, so a row this project imported itself
 * must not be read as having extra columns.
 *
 * The outer pipes are dropped when present, which is what makes `| a | b |` and
 * `a | b` two spellings of the same two cells, and a bare `|` zero cells rather
 * than one.
 */
function cells(line) {
  const t = line.trim()
  const parts = t.split(UNESCAPED_PIPE)
  if (t.startsWith('|')) parts.shift()
  if (parts.length && t.endsWith('|') && !t.endsWith('\\|')) parts.pop()
  return parts
}

/** A body row: anything non-blank with a live pipe in it. Only ever asked INSIDE a table. */
function isTableRow(line) {
  return line.trim() !== '' && UNESCAPED_PIPE.test(line)
}

/** Can `line` be the delimiter row of a table whose header had `n` cells? */
function isTableDelim(line, n) {
  if (n < 1 || !UNESCAPED_PIPE.test(line) || !/^[\s|:-]+$/.test(line)) return false
  const c = cells(line)
  return c.length === n && c.every((x) => DELIM_CELL.test(x.trim()))
}

/**
 * A heading's display text, and the anchor VitePress will actually render for it.
 *
 * `## Title {#custom-id}` is VitePress's custom-anchor syntax: markdown-it-attrs
 * eats the trailing brace and emits `id="custom-id"`. Reading the line whole is
 * wrong twice over. The citation row label keeps the raw `{#…}` markup in it,
 * and `slug()` folds that markup back into the anchor — `### How to Get API Keys
 * for AI Models {#how-to-get-api-keys-for-ai-models}` (stripo-docs
 * editor-configuration/artificial-intelligence.md) produced the anchor
 * `how-to-get-api-keys-for-ai-models-how-to-get-api-keys-for-ai-models`, which
 * matches no element on the rendered page, so the citation href built in
 * `session.js` dropped the reader at the top of the page instead of at the
 * passage the answer quoted.
 *
 * The custom id is used VERBATIM, never slugged: verbatim is what VitePress puts
 * in the DOM, and matching the DOM is the entire point of having an anchor.
 *
 * Anchoring the pattern at end-of-line is what keeps a heading ABOUT the syntax
 * safe — `## The \`{#id}\` shorthand` ends in a backtick, not a brace, so it is
 * left alone. Requiring a non-space character before the brace keeps a heading
 * that is nothing but an id (`## {#foo}`) out of the branch: an empty title
 * reads downstream as the page's untitled lead section.
 */
function headingParts(text) {
  const m = /^(.*\S)\s*\{#([^}\s]+)\}$/.exec(text)
  return m ? { title: m[1], anchor: m[2] } : { title: text, anchor: null }
}

/** Split into sections at ## and ###. `#` sets the document title, never a boundary. */
function toSections(text, fallbackTitle) {
  const lines = text.split('\n')
  const sections = []
  let h1 = fallbackTitle || null
  let cur = { title: null, anchor: null, level: 0, lines: [] }
  let fence = null

  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null
      cur.lines.push(line)
      continue
    }
    const open = openFence(line)
    if (open) {
      fence = open
      cur.lines.push(line)
      continue
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line)
    if (h) {
      const level = h[1].length
      // Before the level test, so an `# H1 {#custom}` sets a page title without
      // the markup in it — the h1 is the breadcrumb on every chunk of the page.
      const { title, anchor } = headingParts(h[2].trim())
      if (level === 1) {
        h1 = h1 || title
        continue
      }
      if (cur.lines.join('\n').trim() || cur.title) sections.push(cur)
      cur = { title, anchor, level, lines: [] }
      continue
    }
    cur.lines.push(line)
  }
  if (cur.lines.join('\n').trim() || cur.title) sections.push(cur)
  return { h1, sections }
}

/**
 * The blocks a chunk boundary is allowed to fall between: paragraphs, fenced
 * code, GFM tables.
 *
 * Both splitters below work on these rather than on lines, because a line is the
 * wrong unit for the two structures that mean something to the embedder. Half a
 * table is data with unlabelled columns; half a fence is code with no language
 * and, on one side of the cut, no fence at all.
 *
 * Repacking joins blocks with a blank line, which is what separates them in
 * source anyway. The one case where that is not byte-identical to the input is a
 * fence or table butted straight against a paragraph — markdown renders both
 * forms the same, and the vector does not care.
 */
function scanBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let para = []
  const flush = () => {
    for (const p of para.join('\n').split(/\n{2,}/)) {
      if (p.trim()) blocks.push({ type: 'para', text: p.trim() })
    }
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const open = openFence(lines[i])
    if (open) {
      flush()
      const body = [lines[i]]
      let j = i + 1
      for (; j < lines.length; j++) {
        body.push(lines[j])
        if (closesFence(lines[j], open)) break
      }
      // An unclosed fence runs to EOF — the same reading the old toggle gave it,
      // now contained to this block instead of inverting the rest of the file.
      blocks.push({ type: 'fence', text: body.join('\n'), open })
      i = j
      continue
    }
    const width = lines[i].trim() ? cells(lines[i]).length : 0
    if (width && isTableDelim(lines[i + 1] ?? '', width)) {
      flush()
      const [header, delimiter] = [lines[i], lines[i + 1]]
      const rows = []
      let j = i + 2
      for (; j < lines.length && isTableRow(lines[j]); j++) rows.push(lines[j])
      blocks.push({
        type: 'table',
        text: [header, delimiter, ...rows].join('\n'),
        header,
        delimiter,
        rows,
      })
      i = j - 1
      continue
    }
    para.push(lines[i])
  }
  flush()
  return blocks
}

/**
 * The last resort: a cut at an arbitrary offset.
 *
 * The `u` flag makes `[\s\S]` match a whole code point, so the cut lands on a
 * character boundary. Without it the count is in UTF-16 units and a cut can fall
 * between the halves of a surrogate pair — an emoji or a rarer CJK character —
 * leaving a lone surrogate in the shard JSON and in the text handed to the
 * embedder.
 */
function codePointCut(s, limit) {
  return s.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'gu')) || []
}

/** Greedy packing at line boundaries. A unit longer than `limit` rides out oversized. */
function packLines(units, limit) {
  const out = []
  let buf = ''
  for (const u of units) {
    const next = buf ? `${buf}\n${u}` : u
    if (next.length > limit && buf) {
      out.push(buf)
      buf = u
    } else {
      buf = next
    }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * A fence too long for one chunk: close every part, reopen the next with the same
 * fence characters, indent and info string, so no chunk ever holds code outside a
 * fence and the language survives the cut.
 *
 * The repair is reserved on EVERY part, including the two that only need one half
 * of it. That costs one line of slack at the ends and buys a budget that is a
 * constant — and the constant is what makes the output exact. A repaired part
 * over `limit` would be re-cut by the code-point net at the bottom of hardSplit,
 * at an arbitrary offset, undoing the repair it was measured against.
 */
function splitFence(block, limit, onSplit) {
  const { open } = block
  const closer = `${open.indent}${open.char.repeat(open.len)}`
  const reopen = `${closer}${open.info}`
  const budget = limit - closer.length - reopen.length - 2
  if (budget < 1) return null
  const units = block.text
    .split('\n')
    .flatMap((l) => (l.length <= budget ? [l] : codePointCut(l, budget)))
  const parts = packLines(units, budget)
  for (let i = 1; i < parts.length; i++) onSplit?.('code')
  return parts.map(
    (p, i) => `${i ? `${reopen}\n` : ''}${p}${i === parts.length - 1 ? '' : `\n${closer}`}`,
  )
}

/**
 * A table too long for one chunk: cut between rows, and give every continuation
 * the header and delimiter rows again.
 *
 * Without the repeated header the continuation is a grid of values whose columns
 * are unnamed — the embedder sees `| ru | 5 | no |` with nothing to attach it to,
 * and so does the model that later reads the chunk as context. The header costs a
 * few dozen characters per part and is the entire meaning of the rows under it.
 */
function splitTable(block, limit, onSplit) {
  const prefix = `${block.header}\n${block.delimiter}\n`
  const budget = limit - prefix.length
  if (budget < 1 || !block.rows.length) {
    // The header alone does not leave room for a row. Nothing about the structure
    // can be preserved, so the block is cut like any other run of text.
    const parts = codePointCut(block.text, limit)
    for (let i = 1; i < parts.length; i++) onSplit?.('table-row')
    return parts
  }
  let cutRow = false
  const units = block.rows.flatMap((r) => {
    if (r.length <= budget) return [r]
    // One row over the whole budget: a cell holding a base64 payload or a wall of
    // prose. A row cut in half is the one outcome this function exists to avoid,
    // so it is reported separately from an ordinary row-boundary split.
    cutRow = true
    return codePointCut(r, budget)
  })
  const parts = packLines(units, budget)
  if (cutRow) onSplit?.('table-row')
  for (let i = 1; i < parts.length; i++) onSplit?.('table')
  return parts.map((p) => `${prefix}${p}`)
}

/**
 * Rule 7. A section over the ceiling is split unconditionally, at the coarsest
 * boundary that fits: between whole blocks first, then inside the one block that
 * is itself too long — between rows in a table, between lines in a fence or a
 * paragraph, and at a code-point boundary only when a single line or row is over
 * the limit on its own.
 *
 * What the output guarantees, which is what reaches the embedder: every part of a
 * split table carries its header and delimiter rows, and every part of a split
 * fence is closed and reopened with the same language. Rule 5 (never split a code
 * block) still yields to the ceiling — the caller warns, via `onSplit`, and the
 * warning now fires if and only if a fence's interior was actually cut.
 *
 * Every splitter's output is exact — <= limit INCLUDING its repair — so the
 * code-point flatMap at the end is a net that only a paragraph's over-long line
 * ever reaches.
 */
function hardSplit(text, limit, onSplit) {
  if (text.length <= limit) return [text]
  const out = []
  let buf = ''
  for (const b of scanBlocks(text)) {
    const next = buf ? `${buf}\n\n${b.text}` : b.text
    if (next.length <= limit) {
      buf = next
      continue
    }
    if (buf) out.push(buf)
    buf = ''
    if (b.text.length <= limit) {
      buf = b.text
      continue
    }
    const parts =
      (b.type === 'fence' && splitFence(b, limit, onSplit)) ||
      (b.type === 'table' && splitTable(b, limit, onSplit)) ||
      packLines(b.text.split('\n'), limit)
    out.push(...parts.slice(0, -1))
    // The tail stays open so the blocks after it can pack onto the same chunk.
    buf = parts[parts.length - 1] ?? ''
  }
  if (buf) out.push(buf)
  return out.flatMap((p) => (p.length <= limit ? [p] : codePointCut(p, limit)))
}

/**
 * Rule 3: split at block boundaries with one block of overlap.
 *
 * Fences and tables are atomic here even when one of them alone is over the
 * target: TARGET_MAX_TOKENS is a preference, MAX_CHUNK_CHARS in hardSplit is the
 * law, and a code sample cut to satisfy a preference is a cost with no benefit.
 *
 * The overlap is carried only when the trailing block is prose. Prose overlap is
 * cheap and buys continuity across the seam; duplicating a near-ceiling fence or
 * table doubles its embedding cost to say the same thing twice.
 */
function paragraphSplit(text) {
  const blocks = scanBlocks(text)
  if (blocks.length <= 1) return [text]
  const out = []
  let buf = []
  let bufLen = 0
  for (const b of blocks) {
    const t = estTokens(b.text)
    if (bufLen && bufLen + t > TARGET_MAX_TOKENS) {
      out.push(buf.map((x) => x.text).join('\n\n'))
      const prev = buf[buf.length - 1]
      const overlap = prev.type === 'para' ? [prev] : []
      buf = [...overlap, b]
      bufLen = overlap.reduce((n, x) => n + estTokens(x.text), 0) + t
    } else {
      buf.push(b)
      bufLen += t
    }
  }
  if (buf.length) out.push(buf.map((x) => x.text).join('\n\n'))
  return out
}

/**
 * @returns {{ chunks: Array, warnings: string[] }}
 */
export function chunkMarkdown({
  src,
  path,
  kind,
  sidebarTitle,
}: {
  src: string
  path: string
  kind?: string
  sidebarTitle?: string
}) {
  const { title: fmTitle, description, layout, source, faq, text, warnings: normWarnings } =
    normaliseMarkdown(src)
  const warnings = normWarnings.map((w) => `${w} in ${path}`)
  if (layout === 'home')
    return { chunks: [], warnings, title: fmTitle || sidebarTitle, faq: [], source }

  const { h1, sections } = toSections(text, fmTitle || sidebarTitle)
  const pageTitle = fmTitle || sidebarTitle || h1 || path

  // Three ways a block can lose to the ceiling, three things an author can do
  // about it: shorten the sample, break the table into two, or shorten the cell.
  // The `code block split` wording predates the repair and is kept verbatim —
  // build logs and the corpus checklist in the docs-rag skill both match on it.
  const onSplit = (kind) => {
    if (kind === 'code') warnings.push(`code block split by MAX_CHUNK_CHARS in ${path}`)
    else if (kind === 'table')
      warnings.push(`table split at row boundaries by MAX_CHUNK_CHARS in ${path}`)
    else warnings.push(`table row longer than MAX_CHUNK_CHARS cut mid-row in ${path}`)
  }

  // Rule 4: a section under MERGE_BELOW_TOKENS joins the next one at its level.
  const merged = []
  for (const s of sections) {
    const body = s.lines.join('\n').trim()
    const prev = merged[merged.length - 1]
    if (prev && estTokens(body) < MERGE_BELOW_TOKENS && prev.level === s.level) {
      prev.body += `\n\n${s.title ? `${s.title}\n` : ''}${body}`
      continue
    }
    merged.push({ title: s.title, anchor: s.anchor, level: s.level, body })
  }

  const chunks = []
  // Repeated headings on one page produce the same anchor. VitePress
  // disambiguates with a `-1`, `-2` suffix, and matching that rule keeps our
  // anchors equal to the anchors a source link actually has to point at.
  //
  // `-N` MEANS THIS AND ONLY THIS. Continuation parts of one long section use
  // `~N` in their id (see below) precisely so the two suffixes cannot be
  // confused — for what happened while they shared a namespace, read the
  // comment on the id line.
  //
  // TWO STRUCTURES, because a counter alone is not enough — this is how
  // markdown-it-anchor does it, and for the same reason. `anchorSeen` counts
  // occurrences of a BASE anchor; `anchorUsed` holds every anchor actually
  // emitted, so a heading whose own anchor happens to equal a suffix another
  // heading already took cannot silently claim it. `## Parameters` twice plus a
  // literal `## Parameters 1` all want `parameters-1`; so does a custom
  // `{#parameters-1}`, which the verbatim rule above now makes reachable
  // exactly. Without the used-set that is a `duplicate chunk id` build death.
  const anchorSeen = new Map()
  const anchorUsed = new Set()
  for (const s of merged) {
    const breadcrumb = [h1 && h1 !== s.title ? h1 : null].filter(Boolean).join(' › ') || pageTitle
    const heading = s.title || pageTitle
    const context = `${breadcrumb} — ${heading}`
    // A custom `{#id}` wins outright — it is the id VitePress renders — and only
    // a heading without one is slugged.
    //
    // THE EMPTY ANCHOR IS REGISTERED LIKE ANY OTHER. `slug()` keeps only
    // `\p{L}\p{N}\s-`, so a heading with no letters and no digits — `## 🚀` —
    // slugs to the empty string, which is also the anchor an untitled lead
    // section carries. The old `if (anchor)` guard skipped the bookkeeping for
    // exactly that value, so the two collided: both chunks got the id `p#`, the
    // lead's `next` pointed at itself, and the build died on
    // `duplicate chunk id: /p#`. Counting '' costs nothing and closes it.
    //
    // Registering the CUSTOM id too is what keeps chunk ids unique when an
    // author writes the same `{#id}` on two headings. VitePress would emit a
    // duplicate DOM id there and the browser would jump to the first one, so the
    // second's link is already broken in the rendered page; a suffixed anchor at
    // least keeps it addressable instead of failing the whole index build.
    const base = s.anchor ?? (s.title ? slug(s.title) : '')
    let n = anchorSeen.get(base) || 0
    let anchor = n ? `${base}-${n}` : base
    while (anchorUsed.has(anchor)) anchor = `${base}-${++n}`
    anchorSeen.set(base, n + 1)
    anchorUsed.add(anchor)

    // The context line is prepended to every part, so the ceiling applies to
    // body + context, not to body alone.
    //
    // The frontmatter description is prepended too, on the page's first chunk
    // (see `lead` below), and it was not being counted here. A page whose first
    // section filled the budget therefore produced a first chunk over
    // MAX_CHUNK_CHARS, and the assertion at the end of this function turned that
    // into a thrown error — the whole index build failing on a perfectly valid
    // page. Only the first section can carry the lead, so only it pays for it.
    const leadCost = description && chunks.length === 0 ? description.length + 1 : 0
    const budget = Math.max(1, MAX_CHUNK_CHARS - context.length - 1 - leadCost)
    let parts = estTokens(s.body) > TARGET_MAX_TOKENS ? paragraphSplit(s.body) : [s.body]
    parts = parts.flatMap((p) => hardSplit(p, budget, onSplit))

    parts.forEach((body, i) => {
      // The frontmatter description rides on the page's FIRST chunk only. It
      // states what the page is for, in the words a reader would use to ask —
      // and a question is phrased as a task, while every heading on the page is
      // phrased as a topic. Repeating it on every chunk would just add the same
      // vector to all of them and flatten the ranking it is meant to sharpen.
      const lead = description && chunks.length === 0 && i === 0 ? `\n${description}` : ''
      const full = `${context}${lead}\n${body}`.trim()
      if (!body.trim()) return
      chunks.push({
        // `~N`, NOT `-N`, for the second and later parts of one section.
        //
        // `-N` is already taken: it is how a repeated heading is disambiguated,
        // twelve lines up. Sharing one suffix namespace between "the Nth heading
        // called this" and "the Nth part of this heading" made the two collide
        // outright. A page with three `## Parameters`, the first long enough to
        // pack into five parts, produced
        // `[parameters, parameters-2 … parameters-5, parameters-1, parameters-2]`
        // — `parameters-2` twice — and killed the build with
        // `duplicate chunk id: api#parameters-2`, an id that appears nowhere in
        // the author's source. The scheme predates the block-aware splitter, but
        // that splitter changes how many parts a section packs into, so a corpus
        // that indexed cleanly could start failing on a page nobody had touched.
        //
        // It also silently inflated every retrieval metric. `underPath` in
        // `eval/metrics.js` reads a trailing suffix as "a continuation part of
        // the gold section", so gold pinned at `api/users#parameters` was scored
        // a perfect hit for retrieving `api/users#parameters-1` — the OTHER
        // endpoint's Parameters section. recall@8, MRR, retrieval F1 and
        // citation precision were all credited for it, and `docpilot tune`
        // optimises against that objective.
        //
        // `~` is the separator because `slug()` strips it (it is in the
        // `[`*_~[\]()]` class), so the disambiguation path can never produce one
        // and the two namespaces are disjoint by construction. It never reaches
        // a URL either: the citation href is built from the `anchor` FIELD
        // (`session.js`), which every part of a section shares — the suffix
        // lives in the id alone, and every other reader of an id treats it as an
        // opaque key or splits it at the FIRST `#` to get the page.
        //
        // The one way back to a collision is an author writing a custom
        // `{#anchor~2}` on a page where `#anchor` also splits into two or more
        // parts. That is caught by the duplicate-id check in
        // `build-rag-index.js` rather than prevented here, because mangling a
        // custom id would break the link it exists to make work.
        id: `${path.replace(/^\//, '')}#${anchor}${i ? `~${i + 1}` : ''}`,
        path,
        anchor,
        title: heading,
        breadcrumb,
        kind,
        text: full,
      })
    })
  }

  // FAQ islands become their own chunks of kind `faq`.
  //
  // Through the SAME ceiling every section passes, which they were bypassing
  // entirely: appended after `hardSplit` had already run, a FaqAccordion answer
  // over MAX_CHUNK_CHARS met nothing but the assertion at the bottom of this
  // function and killed `docpilot index` with
  // `chunk exceeds MAX_CHUNK_CHARS after rule 7: p#faq-1 (8109)` — blaming a
  // rule that never ran on this path, and naming neither the page nor the
  // question the author has to shorten. Splitting them instead means there is
  // nothing to blame.
  //
  // `faq-N` counts questions, so it belongs to the same namespace as a
  // disambiguated heading, and continuations take `~N` here for the same reason
  // they do above. The budget is measured against the context line the answer
  // ships with, exactly as a section's is. The longest answer in either corpus
  // today is about 1 kB, so every real FAQ chunk is one part and keeps the id it
  // already had.
  faq.forEach((f, i) => {
    const anchor = `faq-${i + 1}`
    const context = `${pageTitle} — ${f.question}`
    const budget = Math.max(1, MAX_CHUNK_CHARS - context.length - 1)
    hardSplit(f.answer, budget, onSplit).forEach((body, j) => {
      chunks.push({
        id: `${path.replace(/^\//, '')}#${anchor}${j ? `~${j + 1}` : ''}`,
        path,
        anchor,
        title: f.question,
        breadcrumb: pageTitle,
        kind: 'faq',
        text: `${context}\n${body}`,
      })
    })
  })

  /**
   * `next` is SAME PAGE ONLY and null at the end, so section expansion can never
   * cross a page boundary. RAG-SPEC 3.1.
   *
   * FORWARD ONLY, and the backward half is derived at load.
   * `engine-specs/004-expand-section.md` decided this and `retriever.js` says it
   * in as many words — a `prev` field in every chunk of every shipped index buys
   * a value one pass over `index.chunks` reconstructs, and the reader downloads
   * it. It was written here anyway, contradicting both, until the field was
   * measured at 4.6% of this corpus's shard bytes with no reader anywhere.
   */
  chunks.forEach((c, i) => {
    c.next = i < chunks.length - 1 ? chunks[i + 1].id : null
  })

  for (const c of chunks) {
    if (c.text.length > MAX_CHUNK_CHARS) {
      throw new Error(`chunk exceeds MAX_CHUNK_CHARS after rule 7: ${c.id} (${c.text.length})`)
    }
    if (estTokens(c.text) > EMBED_CONTEXT_TOKENS) {
      throw new Error(`chunk exceeds the embed context: ${c.id} (${estTokens(c.text)} tokens)`)
    }
  }

  // `source` rides out unvalidated and unattached to any chunk: provenance is a
  // property of the PAGE, and the manifest is where a page's properties live.
  // The caller checks it against the allowlist — this module has no I/O and no
  // configuration, which is what lets the linter re-chunk from source on a PR.
  return { chunks, warnings, title: pageTitle, faq, source }
}
