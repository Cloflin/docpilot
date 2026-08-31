/**
 * The block stream — the one shape every source format is converted INTO.
 *
 * `html-to-md.js` has always produced this: a flat, ordered list of blocks with
 * a `kind`, written by a generator so the caller could see the sequence rather
 * than a finished string. It was private, and it was immediately serialised to
 * markdown — which the chunker then parses back into blocks. That round trip is
 * fine for one format and is the whole cost of adding a second: `.rst`, `.adoc`
 * and a notebook's cells are all lists of headings, paragraphs, code and tables,
 * and every one of them would otherwise write its own markdown emitter and get
 * the fence-length rule, the pipe escaping and the heading ladder subtly wrong.
 *
 * SO THE TYPE GETS A NAME AND THE RENDERER GETS A DOOR. A new format is now a
 * function that yields `Block`s; `renderBlocks` turns them into the markdown
 * `chunkMarkdown` already knows how to cut, with the three rules that are easy
 * to get wrong written once:
 *
 *   · the heading ladder is NORMALISED, not copied. A page whose sections are
 *     `<h3>` because of how its template nests would otherwise produce a file
 *     with no `##` at all, and the chunker splits on heading level.
 *   · a fence is as long as it needs to be. A sample that itself contains a
 *     ``` line — every page documenting markdown has one — closes the block in
 *     the middle of itself with a three-backtick fence.
 *   · a table's notes follow the table. A `data-tippy-content` is frequently the
 *     only definition a term in that table has anywhere on the page.
 *
 * THIS FILE IS AN EXTRACTION, NOT A DESIGN. Every line of `renderBlocks` was
 * `toMarkdown`'s second half, moved verbatim, and the requirement on the change
 * was that the corpus hash did not move.
 */

/**
 * One block of a document.
 *
 * `kind` is a closed set on purpose. A format that has something else — an
 * admonition, a footnote, a definition list — converts it into one of these,
 * which is the same decision `html-to-md` already makes for `<dl>`: the shape a
 * chunker can act on is heading, prose, code, list, table, quote, rule.
 *
 * `level` is meaningful for `h` only. `lang` is meaningful for `code` only, and
 * is the empty string rather than null when a fence carries no language, because
 * it is concatenated straight into the opening fence. `notes` is meaningful for
 * `table` only.
 */
export type Block = {
  kind: 'p' | 'h' | 'code' | 'list' | 'table' | 'quote' | 'hr'
  text: string
  level?: number
  lang?: string
  notes?: { term: string; definition: string }[]
}

/**
 * Blocks to markdown.
 *
 * @param {Block[]} found blocks in document order
 * @param {{ minHeading?: number }} [options]
 *   `minHeading` is the level the shallowest heading is normalised to — 2, so a
 *   file's single `#` stays the title its frontmatter names and the source's own
 *   `<h1>` does not compete with it.
 * @returns {{ markdown: string, headings: string[], links: string[] }}
 */
export function renderBlocks(found, { minHeading = 2 } = {}) {
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
      const longest = Math.max(0, ...[...block.text.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1].length))
      const fence = '`'.repeat(Math.max(3, longest + 1))
      out.push(`${fence}${block.lang}\n${block.text}\n${fence}`)
      continue
    }
    out.push(block.text)
    if (block.kind === 'table' && block.notes?.length) {
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
