/**
 * A retrieved chunk as a ROW THE READER SEES — search-only mode's answer.
 *
 * The one thing this module is for: in search-only mode nothing writes prose
 * about the passages, so the passages are the answer, and what a reader needs
 * from one is different from what a model needs from one. A model gets 1200
 * characters and an id it can call `fetch_section` with. A reader gets a link
 * they can follow, the heading it lands on, and enough text to tell whether it is
 * the right one.
 *
 * SEPARATE FROM session.js ON PURPOSE. Everything here is a pure function of a
 * chunk and the manifest, so it is testable in Node without standing up a turn —
 * and session.js stays free of render decisions, which is the split that already
 * holds everywhere else in this package.
 */

import { excerptWindow } from './excerpt.js'
import { toPlainText } from './markdown.js'

/**
 * How much of a passage a row shows.
 *
 * Smaller than the model's `SEARCH_CHARS` (1200) by an order of magnitude,
 * because the jobs are different: the model is reasoning from the text and needs
 * the definition, the reader is DECIDING WHICH LINK TO FOLLOW and needs enough to
 * recognise it. Eight rows at 1200 characters is a wall nobody reads.
 */
const SNIPPET_CHARS = 220

/**
 * The context line, removed — and the reason it has to go.
 *
 * Every chunk's text begins with `${breadcrumb} — ${heading}` (chunker.js), which
 * is exactly what the row's own title and breadcrumb already say. Left in, every
 * snippet would open by repeating the line directly above it, and the 220
 * characters that are supposed to help the reader choose would spend their first
 * forty on something they just read.
 *
 * The FIRST line only, and only when there is a second: a one-line chunk is all
 * context line and stripping it would leave an empty row.
 */
function body(text) {
  const src = String(text || '')
  const nl = src.indexOf('\n')
  if (nl === -1) return src
  return src.slice(nl + 1).trim() || src
}

/**
 * Where this row goes when it is clicked.
 *
 * Built from the `anchor` FIELD, never from the chunk id. The id carries a `~N`
 * suffix for the continuation parts of a split section — a namespace that exists
 * so two chunks of one heading can have distinct ids — and `~N` is not in the
 * document. Every part of a section shares the one anchor that is, which is the
 * same rule a cited source row follows.
 */
function hrefOf(chunk, page) {
  // An imported page is offered as the original it was imported from, on exactly
  // the same terms as a citation: the copy has no route of its own to link to.
  const base = page?.origin || chunk.path
  return chunk.anchor ? `${base}#${chunk.anchor}` : base
}

/**
 * @param {object[]} chunks  ranked, from `retrieval.search()`
 * @param {{index: object}} opts
 * @returns {{id: string, path: string, anchor: string, href: string,
 *   title: string, breadcrumb: string, origin: string|null,
 *   snippet: string, truncated: boolean}[]}
 */
export function resultRows(chunks, { index }: { index?: any } = {}) {
  const pages = index?.manifest?.pages || []
  return (chunks || []).map((c) => {
    const page = pages.find((p) => p.path === c.path) || null
    // STRIPPED BEFORE THE WINDOW, not after. A chunk is markdown, and 220
    // characters are a budget: spent on `**`, `##` and `](/guide/config#tokens)`
    // they buy the reader nothing, and a cut that lands inside a link leaves the
    // half of it that is punctuation. Cleaning first also means `markQuery` marks
    // a word the author emphasised the same as one they did not.
    const { text, truncated } = excerptWindow(toPlainText(body(c.text)), { max: SNIPPET_CHARS })
    return {
      id: c.id,
      path: c.path,
      anchor: c.anchor || '',
      href: hrefOf(c, page),
      // The chunk's own heading, which is what the link lands on — not the page
      // title, which is `breadcrumb` below. A row that named the page would make
      // eight sections of one page eight identical rows.
      title: c.title || page?.title || c.path,
      // Where it sits, for a reader deciding between two similarly-named
      // headings. `tail` is the sidebar group the page belongs to; the page title
      // is what a reader recognises, so both are offered and the renderer picks.
      breadcrumb: [page?.tail, page?.title].filter(Boolean).join(' · '),
      origin: page?.origin || null,
      snippet: text,
      truncated,
    }
  })
}
