import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import { pickMain, prune } from '../src/build/lib/html-extract.js'
import { toMarkdown } from '../src/build/lib/html-to-md.js'
import { MAX_TABLE_SPAN } from '../src/build/lib/html-table.js'

/**
 * Structure — engine-spec 043, HTML-04 and HTML-09.
 *
 * One assertion per defect: a span that shifted a column, a nested table whose
 * rows joined the outer one, a heading that lost its id, a decoded tag that
 * could start an annotation.
 */
const md = (html) => {
  const { document } = parseHTML(`<!doctype html><html><body><main>${html}</main></body></html>`)
  const root = pickMain(document)
  prune(root)
  return toMarkdown(root).markdown
}

describe('html structure — tables', () => {
  it('copies a colspan cell into every position it covers', () => {
    const out = md(`<table>
      <tr><th>Plan</th><th>Price</th><th>Seats</th></tr>
      <tr><td>Free</td><td colspan="2">Contact us</td></tr>
    </table>`)
    expect(out).toBe(
      '| Plan | Price | Seats |\n| --- | --- | --- |\n| Free | Contact us | Contact us |',
    )
  })

  it('copies a rowspan cell into the same column of the next row', () => {
    const out = md(`<table>
      <tr><th>Plan</th><th>Seats</th></tr>
      <tr><td rowspan="2">Team</td><td>5</td></tr>
      <tr><td>10</td></tr>
    </table>`)
    expect(out).toBe('| Plan | Seats |\n| --- | --- |\n| Team | 5 |\n| Team | 10 |')
  })

  it('reads a table with tbody and one without as the same Markdown', () => {
    const rows = '<tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr>'
    expect(md(`<table><tbody>${rows}</tbody></table>`)).toBe(md(`<table>${rows}</table>`))
  })

  it('reads thead, tbody and tfoot rows in document order', () => {
    const out = md(`<table>
      <thead><tr><th>A</th><th>B</th></tr></thead>
      <tbody><tr><td>1</td><td>2</td></tr></tbody>
      <tfoot><tr><td>sum</td><td>3</td></tr></tfoot>
    </table>`)
    expect(out).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| sum | 3 |')
  })

  it('never lets the rows of a nested table join the outer table', () => {
    const out = md(`<table>
      <tr><th>Name</th><th>Detail</th></tr>
      <tr><td>Row</td><td><table><tr><td>in</td><td>x</td></tr></table></td></tr>
    </table>`)
    expect(out).toBe('- **Name**: Row; **Detail**: in; x')
    expect(out).not.toContain('|')
  })

  it('writes a cell that holds a list as one bullet per row, with every item', () => {
    const out = md(`<table>
      <tr><th>Plan</th><th>Features</th></tr>
      <tr><td>Pro</td><td><ul><li>a</li><li>b</li></ul></td></tr>
      <tr><td>Free</td><td>c</td></tr>
    </table>`)
    expect(out).toBe('- **Plan**: Pro; **Features**: a; b\n- **Plan**: Free; **Features**: c')
  })

  it('keeps the text of a paragraph and a code block inside a cell', () => {
    const out = md(`<table>
      <tr><th>Call</th><th>Use</th></tr>
      <tr><td><pre><code>GET /x</code></pre></td><td><p>First.</p><p>Second.</p></td></tr>
    </table>`)
    expect(out).toContain('`GET /x`')
    expect(out).toContain('First.; Second.')
  })

  it('names a column that has no header text by its 1-based position', () => {
    const out = md(`<table>
      <tr><th></th><th>Notes</th></tr>
      <tr><td>a</td><td><p>b</p></td></tr>
    </table>`)
    expect(out).toBe('- **1**: a; **Notes**: b')
  })

  it('clamps a huge colspan to MAX_TABLE_SPAN and finishes at once', () => {
    const started = Date.now()
    const out = md(`<table>
      <tr><th>A</th><th>B</th><th>C</th></tr>
      <tr><td colspan="100000">wide</td></tr>
      <tr><td rowspan="100000">tall</td><td>x</td><td>y</td></tr>
      <tr><td>p</td><td>q</td></tr>
    </table>`)
    expect(Date.now() - started).toBeLessThan(200)
    const widest = Math.max(...out.split('\n').map((l) => l.split(/(?<!\\)\|/).length - 2))
    expect(widest).toBeLessThanOrEqual(MAX_TABLE_SPAN)
    expect(out).toContain('wide')
  })

  it('writes a row with more cells than the grid is wide without losing one', () => {
    const cells = (tag, n) => Array.from({ length: n }, (_, i) => `<${tag}>c${i}</${tag}>`).join('')
    const out = md(`<table><tr>${cells('th', 70)}</tr><tr>${cells('td', 70)}</tr></table>`)
    expect(out).toContain('c69')
  })

  it('walks a one-row table and a one-column table as containers', () => {
    // Cells that hold blocks, because a cell of bare text is glued to its
    // neighbour by the container walk, as it was in 2.x.
    const cell = (t) => `<td><p>${t}</p></td>`
    expect(md(`<table><tr>${cell('A')}${cell('B')}</tr></table>`)).toBe('A\n\nB')
    expect(md(`<table><tr>${cell('A')}</tr><tr>${cell('B')}</tr></table>`)).toBe('A\n\nB')
  })

  it('writes an empty cell as an empty cell', () => {
    const out = md('<table><tr><th>A</th><th>B</th></tr><tr><td></td><td>2</td></tr></table>')
    expect(out).toBe('| A | B |\n| --- | --- |\n|  | 2 |')
  })

  it('keeps two adjacent tables as two blocks with one blank line between', () => {
    const t = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    const out = md(t + t.replace('1', '3').replace('2', '4'))
    expect(out).toBe(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| A | B |\n| --- | --- |\n| 3 | 4 |',
    )
  })
})
