import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import { pickMain, prune } from '../src/build/lib/html-extract.js'
import { toMarkdown } from '../src/build/lib/html-to-md.js'
import { applyLlmTags } from '../src/build/lib/normalise.js'
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

describe('html structure — headings, details, lists, text', () => {
  it('writes a heading id in the custom-anchor form the chunker reads', () => {
    expect(md('<h2 id="rate-limits">Rate limits</h2>')).toBe('## Rate limits {#rate-limits}')
  })

  it('takes the id from a direct child anchor with no href', () => {
    // An h2 first, because a lone h3 is normalised up to `##`.
    expect(md('<h2>Top</h2><h3><a id="x"></a>Usage</h3>')).toBe('## Top\n\n### Usage {#x}')
    expect(md('<h2>Top</h2><h3><a name="y"></a>Usage</h3>')).toBe('## Top\n\n### Usage {#y}')
  })

  it('writes no id that the chunker rule could not accept', () => {
    expect(md('<h2 id="bad id">T</h2>')).toBe('## T')
    expect(md('<h2 id="1st">T</h2>')).toBe('## T')
    expect(md(`<h2 id="a${'b'.repeat(64)}">T</h2>`)).toBe('## T')
  })

  it('adds nothing for a permalink anchor inside a heading', () => {
    const out = md('<h2 id="a">Intro<a class="header-anchor" href="#a">&ZeroWidthSpace;</a></h2>')
    expect(out).toBe('## Intro {#a}')
    expect(out).not.toContain('\u200b')
    expect(md('<h2>Intro <a href="#intro">#</a></h2>')).toBe('## Intro')
  })

  it('keeps a link in a heading when its text has letters', () => {
    expect(md('<h2><a href="#top">Back to top</a></h2>')).toContain('Back to top')
  })

  it('keeps the content of details and writes its summary as a bold lead line', () => {
    const out = md('<details><summary>Can I export?</summary><p>Yes, as PDF.</p></details>')
    expect(out).toBe('**Can I export?**\n\nYes, as PDF.')
  })

  it('does not double the bold of a summary that is already strong', () => {
    expect(md('<details><summary><strong>Why?</strong></summary><p>Because.</p></details>')).toBe(
      '**Why?**\n\nBecause.',
    )
  })

  it('keeps three levels of nesting and the start of an ordered list', () => {
    const out = md('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>')
    expect(out).toBe('- a\n  - b\n    - c')
    expect(md('<ol start="3"><li>x</li><li>y</li></ol>')).toBe('3. x\n4. y')
  })

  it('keeps a definition list and the paragraphs of a blockquote', () => {
    expect(md('<dl><dt>Seat</dt><dd>One user</dd></dl>')).toBe('- **Seat** — One user')
    expect(md('<blockquote><p>One.</p><p>Two.</p></blockquote>')).toBe('> One.\n>\n> Two.')
  })

  it('keeps two adjacent lists as two blocks with one blank line between', () => {
    expect(md('<ul><li>a</li></ul><ul><li>b</li></ul>')).toBe('- a\n\n- b')
  })

  it('decodes entities', () => {
    expect(md('<p>caf&eacute; &#x1F600; &amp; more</p>')).toBe('café 😀 & more')
  })

  it('writes a decoded tag in prose as &lt;, so applyLlmTags drops nothing', () => {
    const out = md('<p>Use &lt;llm-exclude&gt; with care &amp; café&eacute;</p><p>After.</p>')
    expect(out).toContain('&lt;llm-exclude>')
    expect(out).toContain('&')
    expect(out).toContain('éé')
    expect(applyLlmTags(out)).toBe(out)
    expect(md('<p>a &lt;/b and &lt;!x and &lt;?y</p>')).toBe('a &lt;/b and &lt;!x and &lt;?y')
  })

  it('leaves a < that starts no tag, and the code inside a span, as written', () => {
    expect(md('<p>1 &lt; 2 and a&lt;3</p>')).toBe('1 < 2 and a<3')
    expect(md('<p>Use <code>&lt;llm-exclude&gt;</code> here</p>')).toBe('Use `<llm-exclude>` here')
    expect(md('<pre><code>&lt;div&gt;</code></pre>')).toBe('```\n<div>\n```')
  })

  it('drops script, style, template, svg and noscript text', () => {
    const html =
      '<p>Hi<script>x()</script><style>p{}</style><template>t</template><svg><text>s</text></svg><noscript>n</noscript></p>'
    expect(md(html)).toBe('Hi')
    // Not pruned first: the serialiser holds the rule on its own.
    const { document } = parseHTML(`<!doctype html><html><body><main>${html}</main></body></html>`)
    expect(toMarkdown(pickMain(document)).markdown).toBe('Hi')
  })
})
