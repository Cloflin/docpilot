import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import { pickMain, prune } from '../src/build/lib/html-extract.js'
import { toMarkdown } from '../src/build/lib/html-to-md.js'

/**
 * Code blocks — engine-spec 043, HTML-02.
 *
 * One assertion per defect: a `<br>`-built sample that became one line, a
 * language written on a wrapper that was lost, and a highlighter's gutter, copy
 * button or language label that landed inside the fence.
 */
const md = (html) => {
  const { document } = parseHTML(`<!doctype html><html><body><main>${html}</main></body></html>`)
  const root = pickMain(document)
  prune(root)
  return toMarkdown(root).markdown
}

describe('html code blocks — lines and the info string', () => {
  it('turns each br inside a pre into a line', () => {
    expect(md('<pre><code>a<br>b<br>c</code></pre>')).toBe('```\na\nb\nc\n```')
  })

  it('takes the language from a wrapper and does not emit its label as a paragraph', () => {
    const out = md('<div class="language-json"><span class="lang">json</span><pre><code>{}</code></pre></div>')
    expect(out).toBe('```json\n{}\n```')
  })

  it('gives no info string for a highlight-source-js class', () => {
    expect(md('<pre><code class="highlight-source-js">x</code></pre>')).toBe('```\nx\n```')
  })

  it('reads data-lang on the pre', () => {
    expect(md('<pre data-lang="yaml"><code>k: v</code></pre>')).toBe('```yaml\nk: v\n```')
  })
})

describe('html code blocks — boundary edge', () => {
  it('drops exactly one newline right after the pre start tag', () => {
    expect(md('<pre>\n\nx</pre>')).toBe('```\n\nx\n```')
  })

  it('does not drop a newline after a code start tag', () => {
    expect(md('<pre><code>\nx</code></pre>')).toBe('```\n\nx\n```')
  })

  it('adds no blank line for a trailing br or a trailing newline run', () => {
    expect(md('<pre>x<br></pre>')).toBe('```\nx\n```')
    expect(md('<pre>x\n\n\n</pre>')).toBe('```\nx\n```')
  })

  it('keeps an interior blank line and keeps a one-line block one line', () => {
    expect(md('<pre>a\n\nb</pre>')).toBe('```\na\n\nb\n```')
    expect(md('<pre><code>just one</code></pre>')).toBe('```\njust one\n```')
  })
})

describe('html code blocks — precision edge', () => {
  it('prefers the code, then the pre, then the wrapper', () => {
    const out = md('<div class="language-go"><pre class="language-rust"><code class="language-js">x</code></pre></div>')
    expect(out).toBe('```js\nx\n```')
    const second = md('<div class="language-go"><pre class="language-rust"><code>x</code></pre></div>')
    expect(second).toBe('```rust\nx\n```')
  })

  it('takes the first language token inside one class attribute', () => {
    expect(md('<pre><code class="hljs language-bash language-sh">x</code></pre>')).toBe('```bash\nx\n```')
  })

  it('turns U+00A0 into a space and changes no other character', () => {
    expect(md('<pre><code>a&nbsp;b\tc  d</code></pre>')).toBe('```\na b\tc  d\n```')
  })
})
