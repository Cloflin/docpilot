import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import { extractHtml } from '../src/build/lib/extract-html.js'
import { unfoldPanels, TAB_PATTERNS } from '../src/build/lib/html-tabs.js'

/**
 * Furniture and panels — engine-spec 043, HTML-05, HTML-13.
 *
 * What a reader would open stays, with its label: tab panels and accordions.
 * What a reader scrolls past goes, and every removal is reported. The five
 * fixtures under test/fixtures/html-extract/ are invented pages (acme.test
 * hosts, no vendor) with a ground truth and a noise list each.
 */
const page = (body, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body><main><article>${body}</article></main></body></html>`

const extract = async (body, options = {}) => extractHtml(page(body), options)

const fixtureDir = (name) => path.resolve('test/fixtures/html-extract', name)
const read = (name, file) => fs.readFileSync(path.join(fixtureDir(name), file), 'utf8')
const lines = (text) => text.split('\n').filter((l) => l !== '')

/** The Markdown with its bold markers removed, so a lead line reads as its label. */
const plain = (markdown) => markdown.replace(/\*\*/g, '')

/** Every line of the ground truth is in the text, in the order the page states it. */
function expectTruthInOrder(markdown, truth) {
  const text = plain(markdown)
  let from = 0
  for (const line of truth) {
    const at = text.indexOf(line, from)
    expect(at, `missing or out of order: ${line}`).toBeGreaterThanOrEqual(0)
    from = at + line.length
  }
}

async function runFixture(name) {
  const result = await extractHtml(read(name, 'input.html'), { base: 'https://docs.acme.test/page' })
  expect(result.ok, result.reason).toBe(true)
  return result
}

describe('html furniture — panels', () => {
  const tablist = `
    <div role="tablist">
      <button role="tab" id="t1" aria-controls="p1">Bash</button>
      <button role="tab" id="t2" aria-controls="p2">PowerShell</button>
      <button role="tab" id="t3" aria-controls="p3">Docker</button>
    </div>
    <div role="tabpanel" id="p1"><pre><code>run one
and again</code></pre></div>
    <div role="tabpanel" id="p2" hidden><pre><code>run two
and again</code></pre></div>
    <div role="tabpanel" id="p3" hidden aria-hidden="true" style="display: none"><pre><code>run three
and again</code></pre></div>`

  it('keeps every panel of an ARIA tab group, hidden ones included, each led by its label', async () => {
    const { markdown } = await extract(`<p>Pick a method below.</p>${tablist}`)
    const at = ['**Bash**', 'run one', '**PowerShell**', 'run two', '**Docker**', 'run three'].map((s) =>
      markdown.indexOf(s),
    )
    expect(at.every((i) => i >= 0), markdown).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    // The tab strip is gone: each name is written once, as the lead line.
    for (const name of ['Bash', 'PowerShell', 'Docker']) {
      expect(markdown.split(name)).toHaveLength(2)
    }
  })

  it('pairs a panel with its tab by aria-labelledby when the tab has no aria-controls', async () => {
    const { markdown } = await extract(`
      <div role="tablist"><button role="tab" id="a">First</button><button role="tab" id="b">Second</button></div>
      <div role="tabpanel" aria-labelledby="a">Text of the first panel.</div>
      <div role="tabpanel" aria-labelledby="b" hidden>Text of the second panel.</div>`)
    expect(plain(markdown)).toContain('First\n\nText of the first panel.')
    expect(plain(markdown)).toContain('Second\n\nText of the second panel.')
  })

  it('leaves a group alone when a tab names no panel, and does not guess', async () => {
    const result = await extract(`
      <p>Intro to the install page.</p>
      <div role="tablist">
        <button role="tab" id="t1" aria-controls="p1">Bash</button>
        <button role="tab" id="t2" aria-controls="nowhere">Lost</button>
      </div>
      <div role="tabpanel" id="p1">Visible panel text.</div>
      <div role="tabpanel" id="p2" hidden>Hidden panel text.</div>`)
    expect(result.markdown).toContain('Visible panel text.')
    expect(result.markdown).not.toContain('Hidden panel text.')
    expect(result.markdown).not.toContain('**Bash**')
    expect(result.report.dropped.some((d) => d.reason === 'hidden' && d.text === 'Hidden panel text.')).toBe(true)
  })

  it('refuses to pair two tabs on one panel', () => {
    const { document } = parseHTML(
      page(`<div role="tablist"><button role="tab" aria-controls="p">One</button><button role="tab" aria-controls="p">Two</button></div><div id="p" role="tabpanel" hidden>Only panel</div>`),
    )
    expect(unfoldPanels(document.body)).toEqual({ tabs: 0, accordions: 0 })
    expect(document.getElementById('p').hasAttribute('hidden')).toBe(true)
  })

  it('writes the VitePress code group with the npm, yarn and pnpm labels', async () => {
    const { markdown } = await extract(`
      <div class="vp-code-group"><div class="tabs"><input type="radio" name="g" id="a" checked><label data-title="npm" for="a">npm</label><input type="radio" name="g" id="b"><label data-title="yarn" for="b">yarn</label><input type="radio" name="g" id="c"><label data-title="pnpm" for="c">pnpm</label></div><div class="blocks"><div class="language-sh vp-adaptive-theme active"><button class="copy"></button><span class="lang">sh</span><pre class="shiki"><code>npm i acme</code></pre></div><div class="language-sh vp-adaptive-theme"><button class="copy"></button><span class="lang">sh</span><pre class="shiki"><code>yarn add acme</code></pre></div><div class="language-sh vp-adaptive-theme"><button class="copy"></button><span class="lang">sh</span><pre class="shiki"><code>pnpm add acme</code></pre></div></div></div>`)
    expect(markdown).toBe(
      ['**npm**', '```sh\nnpm i acme\n```', '**yarn**', '```sh\nyarn add acme\n```', '**pnpm**', '```sh\npnpm add acme\n```'].join('\n\n'),
    )
  })

  it('leaves a generic tab container with unequal labels and panes as it was', async () => {
    const { document } = parseHTML(
      page(`<div class="tabs"><span class="tab-label">One</span><span class="tab-label">Two</span><div class="tab-pane">Only one pane</div></div>`),
    )
    expect(unfoldPanels(document.body)).toEqual({ tabs: 0, accordions: 0 })
    expect(document.querySelectorAll('strong')).toHaveLength(0)
  })

  it('pairs a generic tab container by position', async () => {
    const { markdown } = await extract(`
      <div class="tabset"><span class="tab-label">Linux</span><span data-tab-label="macOS"></span>
        <div class="tab-pane">Use the system package manager.</div>
        <div class="tab-pane" hidden>Use the Homebrew formula.</div></div>`)
    expect(plain(markdown)).toContain('Linux\n\nUse the system package manager.')
    expect(plain(markdown)).toContain('macOS\n\nUse the Homebrew formula.')
  })

  it('keeps a collapsed ARIA accordion region under its trigger label', async () => {
    const { markdown } = await extract(`
      <h3><button id="q" aria-expanded="false" aria-controls="a">Can I export my data?</button></h3>
      <div id="a" role="region" hidden><p>Yes, from the Settings page.</p></div>`)
    expect(markdown).toBe('**Can I export my data?**\n\nYes, from the Settings page.')
  })

  it('keeps a details accordion with its summary and its answer', async () => {
    const { markdown } = await extract(`<details><summary>Do you offer refunds?</summary><p>Within 14 days of the first payment.</p></details>`)
    expect(plain(markdown)).toContain('Do you offer refunds?')
    expect(markdown).toContain('Within 14 days of the first payment.')
  })

  it('counts what it unfolded', () => {
    const { document } = parseHTML(
      page(`${tablist}<button id="q" aria-expanded="false" aria-controls="r">Why?</button><div id="r" hidden>Because.</div>`),
    )
    expect(unfoldPanels(document.body)).toEqual({ tabs: 1, accordions: 1 })
  })

  it('still drops a hidden element that is not a panel', async () => {
    const result = await extract(`<p>Visible text of the page is here.</p><div id="x" hidden>Secret text nobody sees.</div>${tablist}`)
    expect(result.markdown).not.toContain('Secret text')
    expect(result.report.dropped.some((d) => d.reason === 'hidden' && d.text === 'Secret text nobody sees.')).toBe(true)
  })

  it('removes a panel with no text together with its label', async () => {
    const { markdown } = await extract(`
      <p>Some text before the tabs.</p>
      <div role="tablist"><button role="tab" aria-controls="a">Full</button><button role="tab" aria-controls="b">Empty</button></div>
      <div id="a" role="tabpanel">Text of the full panel.</div>
      <div id="b" role="tabpanel" hidden>   </div>`)
    expect(plain(markdown)).toContain('Full')
    expect(markdown).not.toContain('Empty')
  })

  it('writes a label in NFC with its whitespace collapsed, like prose', async () => {
    const { markdown } = await extract(`
      <div role="tablist"><button role="tab" aria-controls="a">  Café \n   menu </button></div>
      <div id="a" role="tabpanel" hidden>Text of the panel.</div>`)
    expect(markdown).toContain('**Café menu**')
    expect(markdown).not.toContain('é')
  })

  it('removes an inline display:none from a paired panel only', async () => {
    const { document } = parseHTML(
      page(`<div role="tablist"><button role="tab" aria-controls="a">One</button></div><div id="a" role="tabpanel" style="color: red; display:none !important">Text</div>`),
    )
    unfoldPanels(document.body)
    expect(document.getElementById('a').getAttribute('style').trim()).toBe('color: red')
  })

  it('names each TAB_PATTERNS entry and gives it a reason', () => {
    expect(TAB_PATTERNS.map((p) => p.name)).toContain('vitepress-code-group')
    for (const pattern of TAB_PATTERNS) {
      expect(pattern.reason.length, pattern.name).toBeGreaterThan(10)
    }
  })

  for (const name of ['tabs', 'accordion']) {
    describe(`the ${name} fixture`, () => {
      it('keeps every line of its ground truth, in order', async () => {
        const { markdown } = await runFixture(name)
        expectTruthInOrder(markdown, lines(read(name, 'truth.txt')))
      })

      it('holds none of its noise', async () => {
        const { markdown } = await runFixture(name)
        for (const noise of lines(read(name, 'noise.txt'))) expect(markdown).not.toContain(noise)
      })
    })
  }
})
