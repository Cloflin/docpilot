import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseHTML } from 'linkedom'

import { extractHtml } from '../src/build/lib/extract-html.js'
import {
  BREADCRUMB_TOKENS,
  BYLINE_TEXT,
  BYLINE_TOKENS,
  CONSENT_TOKENS,
  DROP_ROLES,
  FEEDBACK_TEXT,
  FEEDBACK_TOKENS,
  FURNITURE_MAX_CHILDREN,
  FURNITURE_TEXT_MAX,
  SHARE_TOKENS,
  TOC_TITLE_TEXT,
  TOC_TOKENS,
  UPDATED_TEXT,
  dropReason,
  pickMain,
  prune,
} from '../src/build/lib/html-extract.js'
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

describe('html furniture — noise', () => {
  const dom = (html) => parseHTML(`<!doctype html><html lang="en"><body>${html}</body></html>`).document
  const reasonOf = (html) => dropReason(dom(html).getElementById('x'))

  describe('the named lists', () => {
    it('every list is an array of lowercase tokens', () => {
      for (const list of [
        CONSENT_TOKENS,
        FEEDBACK_TOKENS,
        SHARE_TOKENS,
        TOC_TOKENS,
        BREADCRUMB_TOKENS,
        BYLINE_TOKENS,
      ]) {
        expect(list.length).toBeGreaterThan(0)
        for (const token of list) expect(token).toBe(token.toLowerCase())
      }
    })

    it('drops a feedback widget by its class token, and the reason names the list', () => {
      const reason = reasonOf('<div id="x" class="article-feedback">Was this article helpful? Yes No</div>')
      expect(reason).toContain('feedback widget')
      expect(reason).toContain('article-feedback')
    })

    it('drops a consent bar, a share bar, a TOC sidebar, a breadcrumb and a byline by token', () => {
      const cases = {
        'privacy-banner': 'consent banner',
        cmp: 'consent banner',
        sharing: 'share bar',
        'page-toc': 'table of contents',
        crumbs: 'breadcrumb',
        'article-author': 'byline',
        'avatar-name': 'byline',
        'was-this-helpful': 'feedback widget',
      }
      for (const [cls, why] of Object.entries(cases)) {
        expect(reasonOf(`<div id="x" class="${cls}">Some words in the widget</div>`), cls).toContain(why)
      }
      expect(reasonOf('<div id="x" class="side" itemscope itemtype="https://schema.org/BreadcrumbList">Home</div>')).toContain('breadcrumb')
    })

    it('matches whole tokens at a - or _ boundary, never a substring of a word', () => {
      for (const cls of ['stock-chart', 'autocomplete', 'authority', 'client', 'mcmp', 'feedbackless']) {
        expect(reasonOf(`<div id="x" class="${cls}">Words that are content of the page</div>`), cls).toBe(null)
      }
      for (const cls of ['toc', 'toc_list', 'the-toc', 'x_toc_y']) {
        expect(reasonOf(`<div id="x" class="${cls}">Words</div>`), cls).toContain('table of contents')
      }
    })

    it('reads the id and the aria-label like a class', () => {
      expect(reasonOf('<div id="x" aria-label="Table of contents">Words</div>')).toContain('table of contents')
      expect(reasonOf('<section id="x" aria-label="Share this page">Words</section>')).toBe(null)
      expect(reasonOf('<div id="x" aria-label="Feedback">Words</div>')).toContain('feedback widget')
    })

    it('drops role="alertdialog", which holds a consent prompt', () => {
      expect(DROP_ROLES).toContain('alertdialog')
      const reason = reasonOf('<div id="x" role="alertdialog">We store cookies on this device.</div>')
      expect(reason).toBe('role="alertdialog"')
    })

    it('keeps the editor-note class of the import test (no list matches it)', () => {
      expect(reasonOf('<div id="x" class="editor-note">A note for editors</div>')).toBe(null)
    })
  })

  describe('help-centre text rules', () => {
    it('drops a byline and a date line, and keeps a sentence that merely starts with Updated', () => {
      expect(reasonOf('<p id="x">Written by Dana Reyes</p>')).toBeTruthy()
      expect(reasonOf('<div id="x">Updated over a week ago</div>')).toBeTruthy()
      expect(reasonOf('<div id="x">Last updated 12/03/2026</div>')).toBeTruthy()
      expect(reasonOf('<p id="x">Updated pricing applies from May.</p>')).toBe(null)
      expect(reasonOf('<p id="x">Written by hand, the file is short.</p>')).toBeTruthy()
    })

    it('drops a table-of-contents title and a feedback question by text', () => {
      expect(reasonOf('<div id="x">Table of contents</div>')).toBeTruthy()
      expect(reasonOf('<div id="x">On this page</div>')).toBeTruthy()
      expect(reasonOf('<div id="x">Was this article helpful? Yes No</div>')).toBeTruthy()
      expect(reasonOf('<div id="x">Was this answer useful?</div>')).toBeTruthy()
    })

    it('gives each text rule its own reason', () => {
      const reasons = new Set([
        reasonOf('<p id="x">Written by Dana Reyes</p>'),
        reasonOf('<p id="x">Updated 3 days ago</p>'),
        reasonOf('<p id="x">Table of contents</p>'),
        reasonOf('<p id="x">Was this article helpful?</p>'),
      ])
      expect(reasons.size).toBe(4)
    })

    it('compares lowercased NFC text', () => {
      expect(reasonOf('<p id="x">WAS THIS ARTICLE HELPFUL?</p>')).toBeTruthy()
      expect(reasonOf('<p id="x">Written by Jose\u0301 Garci\u0301a</p>')).toBeTruthy()
      expect(UPDATED_TEXT.test('UPDATED 3 DAYS AGO')).toBe(true)
    })

    it('applies only to a short element without blocks inside', () => {
      // A byline is one short line. Prose that opens the same way is a paragraph.
      const long = `Written by ${'a'.repeat(FURNITURE_TEXT_MAX)}`
      expect(reasonOf(`<p id="x">${long}</p>`)).toBe(null)
      expect(reasonOf('<div id="x"><p>Written by Dana Reyes</p><p>Another paragraph of the guide.</p></div>')).toBe(null)
      expect(reasonOf('<div id="x">Written by Dana <ul><li>one</li></ul></div>')).toBe(null)
      const many = Array.from({ length: FURNITURE_MAX_CHILDREN + 1 }, () => '<b>x</b>').join('')
      expect(reasonOf(`<div id="x">Written by ${many}</div>`)).toBe(null)
    })

    it('anchors every rule, with a bound on every quantifier', () => {
      for (const rule of [BYLINE_TEXT, UPDATED_TEXT, TOC_TITLE_TEXT, FEEDBACK_TEXT]) {
        expect(rule.source.startsWith('^')).toBe(true)
        expect(rule.source.endsWith('$')).toBe(true)
        // No unbounded quantifier after the anchor: only {m,n} counts.
        expect(rule.source).not.toMatch(/[^\\][*+](?![?])|\)[*+]/)
      }
    })

    it('extracts a page whose paragraph is 100 KB and starts with "Written by" in under 500 ms', async () => {
      const body = `<p>Written by ${'word '.repeat(20_000)}end.</p><p>A second paragraph of ordinary guide text.</p>`
      const started = performance.now()
      const result = await extract(body)
      const took = performance.now() - started
      expect(result.ok).toBe(true)
      expect(result.markdown).toContain('Written by word word')
      expect(took).toBeLessThan(500)
    })

    it('stays fast on near-miss text at the length limit', () => {
      const near = [
        `Updated ${'1'.repeat(FURNITURE_TEXT_MAX - 10)}`,
        `Written by${' '.repeat(FURNITURE_TEXT_MAX - 12)}x`,
        `Was this article helpful${'x'.repeat(FURNITURE_TEXT_MAX - 30)}`,
      ]
      const html = Array.from({ length: 300 }, (_, i) => `<p>${near[i % 3]}</p>`).join('')
      const started = performance.now()
      prune(pickMain(dom(`<main>${html}</main>`)))
      expect(performance.now() - started).toBeLessThan(500)
    })
  })

  describe('the in-page table of contents', () => {
    it('drops a title and a list whose links are all fragments, and reports both', () => {
      const document = dom(`<main>
        <h2>Table of contents</h2>
        <ul><li><a href="#one">Section one</a></li><li><a href="#two">Section two</a></li></ul>
        <h2 id="one">Section one</h2><p>The first section holds the real documentation text.</p></main>`)
      const root = document.querySelector('main')
      const dropped = prune(root)
      expect(root.textContent).not.toContain('Table of contents')
      expect(root.textContent).not.toContain('Section two')
      expect(root.textContent).toContain('The first section')
      const toc = dropped.filter((d) => d.reason.startsWith('in-page table of contents'))
      expect(toc).toHaveLength(2)
      expect(toc.map((d) => d.reason).sort()).toEqual(['in-page table of contents', 'in-page table of contents (title)'])
      expect(toc.find((d) => d.reason.endsWith('(title)')).text).toBe('Table of contents')
      expect(toc.find((d) => !d.reason.endsWith('(title)')).text).toContain('Section two')
    })

    it('keeps a list of real links, and a list with one fragment link', () => {
      const document = dom(`<main>
        <h2>Contents</h2>
        <ul><li><a href="/guide/one">Guide one</a></li><li><a href="/guide/two">Guide two</a></li></ul>
        <ul><li><a href="#only">Only one link</a></li></ul>
        <ul><li><a href="#a">Jump</a> and then read a long explanation that is mostly prose and not a link at all.</li><li><a href="#b">Jump two</a> plus yet more prose, so the links are a small share of the text.</li></ul>
        <p>Closing paragraph of the page.</p></main>`)
      const root = document.querySelector('main')
      const dropped = prune(root)
      expect(root.textContent).toContain('Guide one')
      expect(root.textContent).toContain('Only one link')
      expect(root.textContent).toContain('mostly prose')
      expect(dropped.some((d) => d.reason.startsWith('in-page table of contents'))).toBe(false)
    })
  })

  describe('the figure rule', () => {
    it('keeps the code of a figure and its caption, and drops its image', async () => {
      const { markdown, report } = await extract(
        '<p>Run this in a shell.</p><figure><img src="shot.png" alt="Screenshot"><pre><code>acme login --token abc</code></pre><figcaption>Log in from the shell</figcaption></figure>',
      )
      expect(markdown).toContain('acme login --token abc')
      expect(markdown).toContain('Log in from the shell')
      expect(report.dropped.some((d) => d.reason === '<img>')).toBe(false)
    })

    it('keeps a figure that holds a table', async () => {
      const { markdown } = await extract('<p>The limits are below.</p><figure><table><tr><th>Plan</th><th>Seats</th></tr><tr><td>Free</td><td>1</td></tr></table><figcaption>Seat limits</figcaption></figure>')
      expect(markdown).toContain('Seat limits')
      expect(markdown).toContain('Free')
    })

    it('still drops a figure with only an image, and says so', async () => {
      const { markdown, report } = await extract('<p>Some text of the guide goes here.</p><figure><img src="a.png" alt=""><figcaption>A picture of the flow</figcaption></figure>')
      expect(markdown).not.toContain('A picture of the flow')
      expect(report.dropped).toContainEqual({ reason: '<figure> with no code or table', text: 'A picture of the flow' })
    })
  })

  describe('every removal is reported', () => {
    it('lists each furniture drop with a non-empty reason', async () => {
      const { report } = await extract(`
        <p>The real text of the article.</p>
        <div class="article-feedback">Was this article helpful? Yes No</div>
        <div class="share-bar">Share this page</div>
        <p>Written by Dana Reyes</p>
        <div role="alertdialog">We store cookies on this device.</div>`)
      expect(report.dropped.length).toBeGreaterThanOrEqual(4)
      for (const d of report.dropped) {
        expect(d.reason.length).toBeGreaterThan(0)
        expect(d.text.length).toBeGreaterThan(0)
      }
    })
  })

  for (const name of ['cookie-banner', 'help-article', 'marketing']) {
    describe(`the ${name} fixture`, () => {
      it('keeps every line of its ground truth, in order', async () => {
        const { markdown } = await runFixture(name)
        expectTruthInOrder(markdown, lines(read(name, 'truth.txt')))
      })

      it('holds none of its noise, and reports what it removed', async () => {
        const { markdown, report } = await runFixture(name)
        for (const noise of lines(read(name, 'noise.txt'))) expect(markdown).not.toContain(noise)
        expect(report.dropped.length).toBeGreaterThan(0)
        for (const d of report.dropped) expect(d.reason.length).toBeGreaterThan(0)
      })
    })
  }

  it('keeps the price table of the marketing fixture although it sits in a slider', async () => {
    const { markdown } = await runFixture('marketing')
    expect(markdown).toMatch(/\|\s*Startup\s*\|\s*\$100 per month\s*\|/)
  })

  it('names no vendor or product in the fixtures (owner rule)', () => {
    const forbidden = new RegExp(['s' + 'tripo', 'one' + 'trust', 'cookie' + 'bot', 'inter' + 'com'].join('|'), 'i')
    for (const name of ['tabs', 'accordion', 'cookie-banner', 'help-article', 'marketing']) {
      for (const file of ['input.html', 'truth.txt', 'noise.txt']) {
        expect(read(name, file), `${name}/${file}`).not.toMatch(forbidden)
      }
    }
  })
})
