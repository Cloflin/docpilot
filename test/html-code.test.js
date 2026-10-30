import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import { pickMain, prune } from '../src/build/lib/html-extract.js'
import { toMarkdown } from '../src/build/lib/html-to-md.js'
import { fenceLanguage, LANG_ANCESTOR_DEPTH } from '../src/build/lib/html-code.js'
import { extractHtml } from '../src/build/lib/extract-html.js'

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

  it('does not take a locale class on a content wrapper for the language', () => {
    // `md()` wraps its HTML in a <main>; each case below makes the class the page's own.
    const page = (attrs, inner) => {
      const { document } = parseHTML(`<!doctype html><html><body><main${attrs}>${inner}</main></body></html>`)
      const root = pickMain(document)
      prune(root)
      return toMarkdown(root).markdown
    }
    expect(page(' class="content language-en"', '<pre>echo hi</pre>')).toBe('```\necho hi\n```')
    expect(page(' class="content language-en"', '<p>Intro text of the page.</p><pre>echo hi</pre>')).toBe(
      'Intro text of the page.\n\n```\necho hi\n```',
    )
    expect(md('<div class="content language-en"><pre>echo hi</pre><p>' + 'Prose. '.repeat(20) + '</p></div>')).toContain(
      '```\necho hi\n```',
    )
  })

  it('still takes a two-letter language class from a wrapper that holds only the sample', () => {
    expect(md('<div class="language-js"><pre>let a</pre></div>')).toBe('```js\nlet a\n```')
    expect(md('<div class="language-js"><div class="highlight"><pre>let a</pre></div></div>')).toBe('```js\nlet a\n```')
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

  it('reads data-language, and a class on the LANG_ANCESTOR_DEPTH-th ancestor but not one level further', () => {
    expect(md('<pre data-language="Python"><code>x</code></pre>')).toBe('```python\nx\n```')
    // `levels` wrappers between the page and the pre; the outermost carries the class.
    const nested = (levels) => {
      const open = Array.from({ length: levels }, (_, i) => `<div${i === 0 ? ' class="language-go"' : ''}>`).join('')
      const html = `${open}<pre>x</pre>${'</div>'.repeat(levels)}`
      const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
      return fenceLanguage(document.querySelector('pre'))
    }
    expect(nested(LANG_ANCESTOR_DEPTH)).toBe('go')
    expect(nested(LANG_ANCESTOR_DEPTH + 1)).toBe('')
  })

  it('turns U+00A0 into a space and changes no other character', () => {
    expect(md('<pre><code>a&nbsp;b\tc  d</code></pre>')).toBe('```\na b\tc  d\n```')
  })
})

describe('html code blocks — gutters and chrome', () => {
  it('drops the line-number column of a highlight.js table', () => {
    const html =
      '<pre><code class="hljs language-bash"><table class="hljs-ln"><tr>' +
      '<td class="hljs-ln-line hljs-ln-numbers"><div class="hljs-ln-n" data-line-number="1"></div></td>' +
      '<td class="hljs-ln-line hljs-ln-code">npm i</td></tr><tr>' +
      '<td class="hljs-ln-line hljs-ln-numbers"><div class="hljs-ln-n" data-line-number="2"></div></td>' +
      '<td class="hljs-ln-line hljs-ln-code">npm test</td></tr></table></code></pre>'
    expect(md(html)).toBe('```bash\nnpm i\nnpm test\n```')
  })

  it('reads a Hugo lntable as one fence with the code cell only', () => {
    const html =
      '<div class="highlight"><div class="chroma"><table class="lntable"><tr>' +
      '<td class="lntd"><pre class="chroma"><code><span class="lnt">1\n</span><span class="lnt">2\n</span></code></pre></td>' +
      '<td class="lntd"><pre class="chroma"><code class="language-go">package main\nfunc main() {}\n</code></pre></td>' +
      '</tr></table></div></div>'
    expect(md(html)).toBe('```go\npackage main\nfunc main() {}\n```')
  })

  it('skips a line-number span inside a pre', () => {
    expect(md('<pre><code><span class="line-number">1</span>x</code></pre>')).toBe('```\nx\n```')
  })

  it('does not take a data table with a numeric first column for code', () => {
    const out = md('<table><tr><th>Code</th><th>Meaning</th></tr><tr><td>200</td><td><code>OK</code></td></tr></table>')
    expect(out).toContain('| 200 | `OK` |')
    expect(out).not.toContain('```')
  })

  it('keeps every column of a data table whose cells hold a number and a pre', () => {
    const out = md(
      '<table><tr><th>Code</th><th>Name</th><th>Example</th></tr>' +
        '<tr><td>404</td><td>Not found</td><td><pre>GET /x</pre></td></tr>' +
        '<tr><td>500</td><td>Server error</td><td><pre>GET /y</pre></td></tr></table>',
    )
    for (const text of ['404', 'Not found', 'GET /x', '500', 'Server error', 'GET /y']) expect(out).toContain(text)
  })

  it('keeps every column of a headerless row of a digit, a name and a pre', () => {
    const out = md('<table><tr><td>404</td><td>Not found</td><td><pre>GET /x</pre></td></tr></table>')
    for (const text of ['404', 'Not found', 'GET /x']) expect(out).toContain(text)
  })

  it('still reads a two-cell digits-and-pre row as a gutter beside code', () => {
    const out = md('<table><tr><td>1</td><td><pre>npm i</pre></td></tr><tr><td>2</td><td><pre>npm test</pre></td></tr></table>')
    expect(out).toBe('```\nnpm i\nnpm test\n```')
  })

  it('reads a multi-line digits cell next to one pre as a gutter when the numbers count lines', () => {
    const out = md('<table><tr><td>1\n2\n3</td><td><pre>a\nb\nc</pre></td></tr></table>')
    expect(out).toBe('```\na\nb\nc\n```')
  })

  it('keeps both columns of a headerless two-cell table of status numbers and pre cells', () => {
    const out = md('<table><tr><td>404</td><td><pre>GET /x</pre></td></tr><tr><td>500</td><td><pre>GET /y</pre></td></tr></table>')
    for (const text of ['404', 'GET /x', '500', 'GET /y']) expect(out).toContain(text)
  })

  it('keeps a lone number beside a pre as data, with or without a header row', () => {
    const bare = md('<table><tr><td>404</td><td><pre>GET /x</pre></td></tr></table>')
    expect(bare).toContain('404')
    expect(bare).toContain('GET /x')
    const headed = md('<table><tr><th>Code</th><th>Example</th></tr><tr><td>404</td><td><pre>GET /x</pre></td></tr></table>')
    expect(headed).toContain('404')
    expect(headed).toContain('GET /x')
  })

  it('reads numbers that skip a line as data, not as a gutter', () => {
    const out = md('<table><tr><td>1</td><td><pre>a</pre></td></tr><tr><td>3</td><td><pre>b</pre></td></tr></table>')
    expect(out).toContain('3')
    expect(out).not.toMatch(/^```/)
  })

  it('does not match a gutter hint inside a longer class token', () => {
    expect(md('<pre><code><span class="client">x</span></code></pre>')).toBe('```\nx\n```')
  })
})

describe('html code blocks — block-level code', () => {
  it('reads a p holding one code with br lines as a two-line fence', () => {
    expect(md('<p><code>GET /a<br>Host: acme.test</code></p>')).toBe('```\nGET /a\nHost: acme.test\n```')
  })

  it('leaves a code span with a br inside a sentence as prose', () => {
    const out = md('<p>Run <code>a<br>b</code> now</p>')
    expect(out).toBe('Run `a b` now')
  })
})

describe('html code blocks — the OpenAPI-in-article fixture', () => {
  const dir = path.resolve('test/fixtures/html-extract/openapi-article')
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8')
  const lines = (text) => text.split('\n').filter((l) => l !== '')

  const truth = lines(read('truth.txt'))
  const between = (from, to) => truth.slice(truth.indexOf(from) + 1, truth.indexOf(to))
  const requestLines = between('Request', 'Body')
  const bodyLines = between('Body', 'The same call from a shell:')
  const curlLines = between('The same call from a shell:', 'Parameters')

  const fences = (markdown) => [...markdown.matchAll(/^(`{3,})([^\n]*)\n([\s\S]*?)\n\1$/gm)].map((m) => ({ lang: m[2], text: m[3] }))
  const extract = async () => (await extractHtml(read('input.html'), { base: 'https://help.acme.test/articles/send-a-message' })).markdown

  it('keeps every code line of the ground truth inside a fence', async () => {
    const found = fences(await extract())
    const inside = found.map((f) => f.text).join('\n')
    for (const line of [...requestLines, ...bodyLines, ...curlLines]) expect(inside.split('\n')).toContain(line)
  })

  it('writes the request block as one three-line fence', async () => {
    const found = fences(await extract())
    const request = found.find((f) => f.text.startsWith('POST /v1/messages'))
    expect(request.text.split('\n')).toEqual(requestLines)
    expect(request.lang).toBe('')
  })

  it('opens the JSON body and the shell sample with their languages', async () => {
    const found = fences(await extract())
    expect(found.find((f) => f.text.startsWith('{')).lang).toBe('json')
    expect(found.find((f) => f.text.startsWith('curl')).lang).toBe('bash')
    expect(found).toHaveLength(3)
  })

  it('holds no noise string inside a fence', async () => {
    const inside = fences(await extract()).map((f) => f.text).join('\n')
    for (const noise of lines(read('noise.txt'))) expect(inside).not.toContain(noise)
  })
})
