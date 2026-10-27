import { describe, it, expect, afterEach, vi } from 'vitest'

import { idMarkers } from '../src/theme/docpilot/markers.js'
import { assembleIndex } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { runTurn } from '../src/theme/docpilot/harness.js'
import { BUDGET_DEFAULTS } from '../src/theme/docpilot/switches.js'
import { renderAnswer } from '../src/theme/docpilot/markdown.js'
import { inlineCitations, unlinkedAnswer } from '../src/eval/metrics.js'

/**
 * engine-spec 039 — a section id written where a citation marker goes.
 *
 * Measured on stripo-docs before the fix: the answer text read
 * `…your own server [editor-configuration/image-storage#connecting-your-own-server]`,
 * the Sources list under it was right, and the claim had no link. Three halves
 * are pinned here: the rewrite (`idMarkers`), the turn that applies it once for
 * every runtime (`finish()`), and the eval check that keeps it from coming back
 * unseen (`unlinkedAnswer`, the third hard gate).
 */

const KNOWN = new Set(['a#one', 'a#two', 'a#', 'b#one', 'b#one~2', 'install#', 'tool:plan_limits:1'])
const known = (id) => KNOWN.has(id)
/** `raw` is the citations array as the model sent it, phantoms and all. */
const mark = (text, raw = []) => idMarkers(text, raw, known)

describe('idMarkers — an id in brackets becomes its marker', () => {
  it('rewrites a cited id to its position', () => {
    const r = mark('Turn it off with the flag [a#two].', ['a#one', 'a#two'])
    expect(r.text).toBe('Turn it off with the flag [2].')
    expect(r.citations).toEqual(['a#one', 'a#two'])
    expect(r.rewritten).toBe(1)
  })

  it('appends a known id only the text cited, and never reorders', () => {
    const r = mark('Configured with a manifest [1]. Beta differs [b#one].', ['a#one'])
    expect(r.text).toBe('Configured with a manifest [1]. Beta differs [2].')
    expect(r.citations).toEqual(['a#one', 'b#one'])
  })

  it('splits several ids in one bracket, and two brackets side by side', () => {
    expect(mark('x [a#one, b#one]', ['a#one', 'b#one']).text).toBe('x [1][2]')
    expect(mark('x [a#one; b#one]', ['a#one', 'b#one']).text).toBe('x [1][2]')
    expect(mark('x [a#one][b#one]', ['a#one', 'b#one']).text).toBe('x [1][2]')
    // A digit beside an id is a marker already.
    expect(mark('x [1, b#one]', ['a#one']).text).toBe('x [1][2]')
    // One id twice is one marker, and so is a number beside the id it names.
    expect(mark('x [a#one, a#one]', ['a#one']).text).toBe('x [1]')
    expect(mark('claim [1][a#one]', ['a#one']).text).toBe('claim [1]')
  })

  it('deletes a phantom marker, with the space before it', () => {
    const r = mark('Invented [z#nope]. Real [a#one].', ['a#one', 'z#nope'])
    expect(r.text).toBe('Invented. Real [1].')
    expect(r.citations).toEqual(['a#one'])
  })

  it('deletes an id nobody handed out when it is shaped like one', () => {
    const r = mark('Your own server [editor-configuration/image-storage#connecting-own-server]. S3 [1].', ['a#one'])
    expect(r.text).toBe('Your own server. S3 [1].')
    // `C#` has no path; it is a word.
    expect(mark('Written in [C#].', ['a#one']).text).toBe('Written in [C#].')
  })

  it('leaves prose, unknown ids and array literals as written', () => {
    for (const t of ['see [the AWS section]', 'an unknown [x#y]', 'mixed [see a#one]', 'returns [1, 2, 9]', '- [ ] a task', '- [x] done']) {
      expect(mark(t, ['a#one', 'a#two']).text).toBe(t)
    }
  })

  it('never touches code', () => {
    const fenced = 'Use it [a#one].\n\n```js\nconst v = map[a#one]\n```\n\nThen [a#two].'
    expect(mark(fenced, ['a#one', 'a#two']).text).toBe('Use it [1].\n\n```js\nconst v = map[a#one]\n```\n\nThen [2].')
    expect(mark('Call `get[a#one]` first [a#one].', ['a#one']).text).toBe('Call `get[a#one]` first [1].')
    // A ~~~ fence closes only on ~~~, CommonMark's rule.
    const tilde = '~~~\n```\n[a#one]\n~~~\nafter [a#one]'
    expect(mark(tilde, ['a#one']).text).toBe('~~~\n```\n[a#one]\n~~~\nafter [1]')
    // "```npm i```" is an inline span, not a fence, so what follows is prose…
    const inline = '```npm i``` first [a#one].\n\n```js\nconst v = map[a#two]\n```\n\nThen [a#two].'
    expect(mark(inline, ['a#one', 'a#two']).text).toBe('```npm i``` first [1].\n\n```js\nconst v = map[a#two]\n```\n\nThen [2].')
    // …and a fence line with text after it does not close the block.
    expect(mark('```bash\nnpm i x\n``` [1]\nset arr[a#one]\n```', ['a#one']).text).toBe('```bash\nnpm i x\n``` [1]\nset arr[a#one]\n```')
    // A blank line written as CRLF still ends a code span's reach.
    expect(mark('Press the ` key.\r\n\r\nThen [a#one].', ['a#one']).text).toBe('Press the ` key.\r\n\r\nThen [1].')
  })

  it('reads the forms a model writes for the same section', () => {
    // `~2` is a continuation part of `#one` and opens the same href.
    expect(mark('x [a#one~2]', ['a#one']).text).toBe('x [1]')
    // …and the cited part answers before a known sibling is appended.
    expect(mark('x [b#one]', ['b#one~2'])).toEqual({ text: 'x [1]', citations: ['b#one~2'], rewritten: 1 })
    // The href form, leading slash and all.
    expect(mark('x [/a#one]', ['a#one']).text).toBe('x [1]')
    // A page's lead section has the empty anchor; the bare `#` gets dropped.
    expect(mark('x [a]', ['a#']).text).toBe('x [1]')
    // …and only when that section is cited, because `[a]` may be a word.
    expect(mark('x [a]', ['a#one']).text).toBe('x [a]')
    // A site tool's id — engine-spec 038.
    expect(mark('Pro allows 5000 [tool:plan_limits:1].', []).citations).toEqual(['tool:plan_limits:1'])
  })

  it('reads link text and alt text as links, not as markers', () => {
    // An exact id as link text is still the citation it names…
    expect(mark('[a#one](/a#one)', ['a#one']).text).toBe('[1](/a#one)')
    // …a page name is a link, even with that page's lead section cited…
    expect(mark('Follow the [install](/install) page [1].', ['install#']).text).toBe('Follow the [install](/install) page [1].')
    // …and alt text is never touched.
    expect(mark('![a#one](/img.png)', ['a#one']).text).toBe('![a#one](/img.png)')
  })

  it('commits nothing from a bracket that turns out to be prose', () => {
    const r = mark('Setting [b#one, see above]. Main [1].', ['a#one'])
    expect(r.text).toBe('Setting [b#one, see above]. Main [1].')
    expect(r.citations).toEqual(['a#one'])
  })
})

describe('idMarkers — a number is a position in the list the model sent', () => {
  it('renumbers past a dropped phantom', () => {
    // The model's [2] was a#one; with z#nope dropped, a#one is first.
    const r = mark('Invented [1]. Real [2].', ['z#nope', 'a#one'])
    expect(r.text).toBe('Invented. Real [1].')
    expect(r.citations).toEqual(['a#one'])
  })

  it('never lets an appended id revive a number that pointed at nothing', () => {
    // Before, [2] — a phantom's — was deleted at render; appending a#two at
    // position 2 would have linked an invented claim to a real section.
    const phantom = mark('Real [1]. Invented [2]. Off [a#two].', ['a#one', 'z#nope'])
    expect(phantom.text).toBe('Real [1]. Invented. Off [2].')
    expect(phantom.citations).toEqual(['a#one', 'a#two'])
    const stray = mark('Real [1]. Stray [3]. Extra [b#one].', ['a#one', 'a#two'])
    expect(stray.text).toBe('Real [1]. Stray. Extra [3].')
    expect(stray.citations).toEqual(['a#one', 'a#two', 'b#one'])
  })

  it('splits a list of numbers the renderer would not link', () => {
    expect(mark('Both [1, 2].', ['a#one', 'a#two']).text).toBe('Both [1][2].')
  })

  it('is the identity on an answer that did it right', () => {
    const text = 'Configure it [1]. Turn it off [2].\n\n```js\nx[0]\n```'
    expect(mark(text, ['a#one', 'a#two'])).toEqual({ text, citations: ['a#one', 'a#two'], rewritten: 0 })
  })
})

// ── the turn ─────────────────────────────────────────────────────────────────

const DIMS = 4
const GUARD = { tau: 0.3, tauLexical: 0.3, wDense: 0.75, wLexical: 0.25, denseMode: 'cosine', cosFloor: 0.44, cosCeil: 0.64, zexp: null }
let n = 0
const twoChunkIndex = () => {
  const chunks = [
    { id: 'a#one', path: '/a', anchor: 'one', title: 'Alpha', breadcrumb: 'Docs', kind: 'guide', text: 'The alpha widget is configured with a manifest.', prev: null, next: 'a#two' },
    { id: 'a#two', path: '/a', anchor: 'two', title: 'Alpha off', breadcrumb: 'Docs', kind: 'guide', text: 'Turning the alpha widget off is a single flag.', prev: 'a#one', next: null },
  ]
  const vectors = new Int8Array(DIMS * chunks.length)
  for (let i = 0; i < chunks.length; i++) vectors[i * DIMS] = 127
  return assembleIndex({
    manifest: {
      version: 3,
      hash: `markers-${++n}`,
      embedModel: 'test-embed',
      dims: DIMS,
      chunkCount: chunks.length,
      vectors: 'vectors.markers.bin',
      pages: [{ path: '/a', title: 'Alpha', tail: 'Docs' }],
      guard: GUARD,
    },
    shards: [chunks],
    vectorBuffer: vectors.buffer,
    dfDoc: { df: {} },
  })
}

const ok = (message) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
})
const answerCall = (args) => ok({ content: '', tool_calls: [{ function: { name: 'answer', arguments: JSON.stringify(args) } }] })

const turn = (onChat) => {
  vi.stubGlobal('fetch', async (_url, init) => onChat(JSON.parse(init.body)))
  const index = twoChunkIndex()
  const retrieval = createRetrieval({ index, scope: { kind: 'all', paths: [], label: 'All docs' }, guard: GUARD })
  return runTurn({
    retrieval,
    gateResult: { G: 1, pass: true, chunks: index.chunks },
    question: 'How do I configure the alpha widget and turn it off?',
    history: [],
    addendum: '',
    config: {
      llm: { provider: 'openai', baseURL: '/ai', model: 'm', apiKey: 'k', tuning: { style: 'effort' } },
      maxIterations: 2,
      budget: { ...BUDGET_DEFAULTS, mode: 'agentic' },
      tools: [],
    },
    fallback: false,
    queryVec: null,
  })
}

describe('runTurn — an id written where a marker goes', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('settles markers, the list and the sources the reader is shown', async () => {
    const r = await turn(() =>
      answerCall({
        text: 'Configure it with a manifest [a#one]. Turn it off with one flag [a#two].',
        citations: ['a#one'],
        confidence: 0.9,
        summary: 'manifest and flag',
      }),
    )
    expect(r.text).toBe('Configure it with a manifest [1]. Turn it off with one flag [2].')
    expect(r.citations).toEqual(['a#one', 'a#two'])
    expect(r.sources.map((s) => s.id)).toEqual(['a#one', 'a#two'])
    expect(r.phantom).toEqual([])

    // And the renderer links both, which is the whole point.
    const rows = r.sources.map((s, i) => ({ n: i + 1, href: `${s.path}#${s.anchor}`, title: s.title }))
    const { html } = renderAnswer(r.text, new Set(['/a']), rows)
    expect(html).toContain('href="/a#one" class="docpilot__cite"')
    expect(html).toContain('href="/a#two" class="docpilot__cite"')
    expect(html).not.toContain('a#one]')
  })

  // The prose path: a model that answers in text and never calls the tool.
  // Before 039 it had no citations and was withdrawn as untraceable; ids it
  // named in brackets are as traceable as the array, so it settles tentative.
  it('gives a prose reply that names known ids its citations', async () => {
    const r = await turn(() => ok({ content: 'Turn it off with one flag [a#two].' }))
    expect(r.text).toBe('Turn it off with one flag [1].')
    expect(r.citations).toEqual(['a#two'])
    expect(r.confidence).toBeLessThan(0.4)
  })

  it('keeps phantom what the model sent, and drops its marker', async () => {
    const r = await turn(() =>
      answerCall({ text: 'Made up [z#nope]. Real [a#one].', citations: ['z#nope', 'a#one'], confidence: 0.9, summary: 's' }),
    )
    expect(r.phantom).toEqual(['z#nope'])
    expect(r.citations).toEqual(['a#one'])
    expect(r.text).toBe('Made up. Real [1].')
  })
})

// ── the check ────────────────────────────────────────────────────────────────

describe('unlinkedAnswer — the third hard gate', () => {
  const cited = ['a#one', 'a#two']

  it('passes an answer whose text links a source', () => {
    expect(unlinkedAnswer('Use a manifest [1]. Then the flag [2].', cited)).toBe(false)
    expect(inlineCitations('Use a manifest [1]. Then the flag [2].', cited)).toEqual({ markers: 2, rawIds: 0, unreferenced: 0 })
    // Counted by the panel's renderer: an escaped marker still links.
    expect(unlinkedAnswer('Use a manifest \\[1\\].', cited)).toBe(false)
  })

  it('fails the defect itself: an id printed where a marker goes', () => {
    const text = 'Use your own server [editor-configuration/image-storage#connecting-your-own-server].'
    const ids = ['editor-configuration/image-storage#connecting-your-own-server']
    expect(unlinkedAnswer(text, ids)).toBe(true)
    // Even beside a working marker: the id is still on the reader's screen.
    expect(unlinkedAnswer(`Default storage [1]. ${text}`, ['x#y', ...ids])).toBe(true)
    // An id the turn emitted but the answer did not cite counts as well…
    expect(inlineCitations('See [a#two].', ['a#one'], ['a#one', 'a#two']).rawIds).toBe(1)
    // …and so does one shaped like a section id that nobody handed out.
    expect(unlinkedAnswer('S3 [1]. Own [guide/storage#own-server].', ['x#y'])).toBe(true)
  })

  it('fails an answer with sources and no marker that resolves', () => {
    expect(unlinkedAnswer('Use a manifest.', cited)).toBe(true)
    // Out of range links nothing; `linkMarkers` deletes it.
    expect(unlinkedAnswer('Use a manifest [3].', cited)).toBe(true)
    // `[1, 2]` is not a form the renderer links.
    expect(unlinkedAnswer('Use a manifest [1, 2].', cited)).toBe(true)
    // A marker inside code is code, and `[ 1 ]` is not a marker on screen.
    expect(unlinkedAnswer('Run `x[1]`.\n\n```js\narr[2]\n```', cited)).toBe(true)
    expect(unlinkedAnswer('Use a manifest [ 1 ].', cited)).toBe(true)
  })

  it('has nothing to say about a refusal or an answer with no sources', () => {
    expect(unlinkedAnswer('', cited)).toBe(false)
    expect(unlinkedAnswer('I could not find this.', [])).toBe(false)
  })

  it('counts citations the text never points at', () => {
    expect(inlineCitations('Only the first [1].', cited).unreferenced).toBe(1)
  })
})

describe('the gate reads positives — engine-spec 039', () => {
  const row = (over) => ({
    id: 'r', expect: 'answer', observed: 'answer', gatePass: true, recall8: 1, mrr: 1,
    answerF1: 0.5, identifierRecall: 1, citationRecall: 1, language: 1, depth: 0, unlinked: false, ...over,
  })

  it('fails a run on a positive shown without a link, and names it', async () => {
    const { summarise } = await import('../src/eval/run.js')
    const { hardGatesFailed } = await import('../src/eval/metrics.js')
    const s = summarise([row({ id: 'q-1' }), row({ id: 'q-2', unlinked: true })])
    expect(s.unlinked).toBe(0.5)
    expect(s.unlinkedIds).toEqual(['q-2'])
    expect(s.unlinkedShown).toBe(2)
    expect(hardGatesFailed({ hallucinated: 0, scopeContainment: 1, unlinked: s.unlinked })).toBe(true)
  })

  it('counts a negative and an authored opener beside it, and gates neither', async () => {
    const { summarise } = await import('../src/eval/run.js')
    const s = summarise([
      row({ id: 'q-1' }),
      row({ id: 'n-1', expect: 'refuse:no-evidence', observed: 'refuse:not-answerable', unlinked: true }),
      row({ id: 'q-2', unlinked: true, authored: true }),
    ])
    expect(s.unlinked).toBe(0)
    expect(s.unlinkedOther).toEqual(['n-1', 'q-2'])
  })

  it('stays null — a pass — on a run that showed no positive with sources', async () => {
    const { summarise } = await import('../src/eval/run.js')
    expect(summarise([row({ id: 'q-1', unlinked: null })]).unlinked).toBe(null)
  })
})

describe('an id before the settle — ui-specs/020', () => {
  const known = new Set(['/a'])

  it('keeps an id the model wrote off the screen while the answer streams', () => {
    const frame = 'Your own server [editor-configuration/image-storage#connecting-your-own-server]. S3 [a#one, b#one] too [1].'
    const { html } = renderAnswer(frame, known, [], { pending: true })
    expect(html).not.toContain('#connecting-your-own-server')
    expect(html).not.toContain('a#one')
    expect(html).toContain('Your own server.')
    // A number is left to the settle, exactly as before.
    expect(html).toContain('[1]')
  })

  it('leaves a word with a # in it, link text and code alone', () => {
    const frame = 'Written in [C#], see [a#one](/a#one), and `map[a#one]`.\n\n```js\nx[b#one]\n```'
    const { html } = renderAnswer(frame, known, [], { pending: true })
    expect(html).toContain('[C#]')
    expect(html).toContain('map[a#one]')
    expect(html).toContain('x[b#one]')
    expect(html).toContain('>a#one</a>')
  })

  it('changes nothing about a settled answer or a call that did not ask', () => {
    const text = 'Own server [a#one].'
    expect(renderAnswer(text, known).html).toContain('[a#one]')
    const rows = [{ n: 1, href: '/a#one', title: 'Alpha' }]
    expect(renderAnswer(text, known, rows, { pending: true }).html).toContain('[a#one]')
  })
})
