/**
 * HTML tables → one GFM table, or a row list that loses nothing.
 *
 * Moved out of the serialiser because spans and nesting need a grid, and a grid
 * does not fit in the function that walks a DOM (engine-spec 043, F-06). The old
 * reader took every `tr` under the table, nested ones included, and read each
 * row's cells in turn: a `colspan` shifted every later cell one column left, a
 * `rowspan` left a hole in the rows below, and the rows of a table nested in a
 * cell were laid under the outer table's own header, answering a question from
 * the wrong row.
 *
 * This file reads nodes and builds no DOM. The GFM rules are the 2.x ones: the
 * first row is the header, a cell is pipe-escaped and whitespace-collapsed, a
 * short row is padded to the grid width.
 */

import { tooltips } from './html-extract.js'
import type { Block } from './ir.js'

/**
 * The most columns a cell may span, and the widest grid this file builds.
 *
 * HTML allows `colspan` up to 1000 and `rowspan` up to 65534. A documentation
 * table never spans 64 columns, and copying a cell into a grid that large is a
 * denial of service: `colspan="100000"` on a page we do not control would cost
 * memory and time that the page's author chose (engine-spec 043, T-02-16).
 */
export const MAX_TABLE_SPAN = 64

/** The row groups whose `tr` children belong to the table. */
const ROW_GROUPS = new Set(['thead', 'tbody', 'tfoot'])

/**
 * A cell that holds one of these is not a line of text, and a GFM cell cannot
 * hold it. The table is then written as a list of rows (engine-spec 043, F-06).
 */
const CELL_BLOCKS = 'p, ul, ol, pre, table, blockquote, dl, h1, h2, h3, h4, h5, h6, details'

/** Elements that end a run of text when a cell is flattened to one line. */
const FLOW = new Set([
  'article', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

const tagOf = (node) => String(node?.tagName || '').toLowerCase()

/**
 * The table's own rows, in document order: its `tr` children, and the `tr`
 * children of its direct `thead`, `tbody` and `tfoot`.
 *
 * Direct children only, never `querySelectorAll('tr')`. WHATWG parsers insert a
 * `tbody`, a table built from source may not have one, and both shapes occur;
 * descending would also take the rows of a table nested in a cell.
 */
function rowsOf(table) {
  const rows = []
  for (const child of [...(table.children || [])]) {
    const tag = tagOf(child)
    if (tag === 'tr') rows.push(child)
    else if (ROW_GROUPS.has(tag)) {
      for (const tr of [...(child.children || [])]) if (tagOf(tr) === 'tr') rows.push(tr)
    }
  }
  return rows
}

/** A row's own cells. */
const cellsOf = (tr) => [...(tr.children || [])].filter((c) => /^(td|th)$/.test(tagOf(c)))

/** `colspan` or `rowspan`, an integer in [1, MAX_TABLE_SPAN]; anything else is 1. */
function span(cell, name) {
  const n = Number.parseInt(cell.getAttribute?.(name) || '1', 10)
  return Number.isFinite(n) ? Math.min(MAX_TABLE_SPAN, Math.max(1, n)) : 1
}

/**
 * A cell with blocks in it, as one line: each block's text, in order, joined by
 * `; `. A list's items, a nested table's cells and two paragraphs all come out
 * as parts of the one value, so the text is kept and no nested row ever sits
 * among the outer table's rows.
 */
function flatten(cell, inline) {
  const parts = []
  let run = ''
  const flush = () => {
    const text = run.replace(/\s+/g, ' ').trim()
    if (text) parts.push(text)
    run = ''
  }
  const walk = (node) => {
    if (node.nodeType === 3) {
      run += inline(node)
      return
    }
    if (node.nodeType !== 1) return
    if (FLOW.has(tagOf(node))) {
      flush()
      for (const kid of [...(node.childNodes || [])]) walk(kid)
      flush()
    } else run += inline(node)
  }
  for (const kid of [...(cell.childNodes || [])]) walk(kid)
  flush()
  return parts.join('; ')
}

/**
 * The grid: one string per covered position, a spanned cell's text copied into
 * every position it covers.
 *
 * An occupancy matrix: a cell starts at the first column its row has not yet
 * been given by a `rowspan` from above. Spans are clamped, and a `rowspan` stops
 * at the last row. `overflow` is true when a row has more cells than the grid
 * is wide; the caller then writes the rows as they are, without a grid.
 */
function gridOf(rows, text) {
  const grid = rows.map(() => [])
  let overflow = false
  rows.forEach((tr, r) => {
    let c = 0
    for (const cell of cellsOf(tr)) {
      while (grid[r][c] !== undefined) c++
      if (c >= MAX_TABLE_SPAN) {
        overflow = true
        break
      }
      const value = text(cell)
      const cols = Math.min(span(cell, 'colspan'), MAX_TABLE_SPAN - c)
      const down = Math.min(span(cell, 'rowspan'), rows.length - r)
      for (let i = 0; i < down; i++) for (let j = 0; j < cols; j++) grid[r + i][c + j] = value
      c += cols
    }
  })
  return { grid, overflow }
}

/** The grid as written: a short row padded with empty cells. */
const padded = (row, width) => Array.from({ length: width }, (_, i) => row[i] ?? '')

/**
 * A table as a list: one bullet per body row, `**header**: value` pairs joined
 * by `; `. A column with no header text is named by its 1-based position, and
 * an empty value is left out (it carries no text to lose).
 */
function rowList(grid, width) {
  const head = padded(grid[0], width)
  const out = []
  for (const row of grid.slice(1)) {
    const pairs = []
    padded(row, width).forEach((value, i) => {
      if (value) pairs.push(`**${head[i] || i + 1}**: ${value}`)
    })
    if (pairs.length) out.push(`- ${pairs.join('; ')}`)
  }
  return out.join('\n')
}

/**
 * A data table as a block, or null when it is a layout table.
 *
 * Null means "walk it as a container", the 2.x rule: a one-column "table" is a
 * list, and marketing pages use tables for columns of unrelated blocks;
 * emitting those as tables gives chunks whose every line is a pipe, which
 * retrieves for nothing.
 *
 * @param table the `table` element
 * @param options `inline` serialises one node to inline Markdown
 */
export function tableBlock(table, { inline }: { inline: (node: any) => string }): Block | null {
  const rows = rowsOf(table).filter((tr) => cellsOf(tr).length)
  if (rows.length < 2) return null

  const blocky = rows.some((tr) => cellsOf(tr).some((c) => c.querySelector?.(CELL_BLOCKS)))
  const text = blocky
    ? (cell) => flatten(cell, inline)
    : (cell) => inline(cell).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

  const found = gridOf(rows, text)
  const overflow = found.overflow
  const grid = overflow ? rows.map((tr) => cellsOf(tr).map(text)) : found.grid
  const width = Math.max(...grid.map((r) => r.length))
  if (width < 2) return null

  const notes = tooltips(table)
  if (blocky || overflow) {
    const list = rowList(grid, width)
    // A tooltip is content (engine-spec 043); the list has no `notes` slot, so
    // its bullets follow the rows.
    const extra = notes.map((n) => `- **${n.term}** — ${n.definition}`)
    return { kind: 'list', text: [list, ...extra].filter(Boolean).join('\n') }
  }

  const [head, ...body] = grid.map((r) => padded(r, width))
  const markdown = [
    `| ${head.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
  return { kind: 'table', text: markdown, notes }
}
