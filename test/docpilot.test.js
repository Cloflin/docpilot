import { describe, it, expect, afterEach } from 'vitest'

import {
  stripImages,
  collapseWhitespace,
  normaliseMarkdown,
  applyLlmTags,
} from '../src/build/lib/normalise.js'
import { chunkMarkdown, slug } from '../src/build/lib/chunker.js'
import { resolveSections, orphanPages } from '../src/build/lib/sections.js'
import { l2normalise, toInt8, cosineInt8 } from '../src/build/lib/quantize.js'
import { terms, norm } from '../src/theme/docpilot/text.js'
import {
  lexicalCoverage,
  denseFromCosine,
  verdict,
  assertWeights,
  composeQuery,
  admissible,
} from '../src/theme/docpilot/gate.js'
import { chat, detectTools, parseFallback, splitThink, streamingAnswerText } from '../src/theme/docpilot/llm.js'
import { providerFor } from '../src/theme/docpilot/providers.js'
import {
  systemText,
  buildMessages,
  clampAddendum,
  clampQuote,
  QUOTE_WRAPPER,
  QUOTE_MAX,
  HISTORY_QUOTE_MAX,
  detectLanguage,
  languageDirective,
  promptDocument,
  coreText,
  promptHash,
  localeOf,
  CORE,
} from '../src/theme/docpilot/prompt.js'
import { isKnownPath, renderAnswer } from '../src/theme/docpilot/markdown.js'
import { GLYPHS, SYMBOLS, symbolId } from '../src/theme/docpilot/glyphs.js'
import { highlight, __setHighlighterForTests } from '../src/theme/docpilot/highlight.js'
import { identifiers, computeSupport } from '../src/theme/docpilot/support.js'
import {
  findSecrets,
  hasSecret,
  redactSecrets,
  credentialCopy,
  CREDENTIAL_LANGUAGES,
  MASK,
} from '../src/theme/docpilot/credentials.js'
import { tokenF1, wilsonUpper95, languageMatch, retrievalF1Loose } from '../src/eval/metrics.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sweepRow,
  chooseTau,
  contiguousScope,
  TAU_STEPS,
  dOf,
  regate,
  chooseWindow,
  WINDOWS,
} from '../src/eval/calibrate.js'
import { guardFor } from '../src/build/build-rag-index.js'
import {
  resolveSuggestions,
  themeDocPilot,
  resolveDocPilot,
  readiness,
  proxyContract,
  DEFAULTS,
  SERVER_ONLY,
} from '../src/config.js'
import { resolveUi, UI_DEFAULTS } from '../src/theme/docpilot/ui.js'
import {
  record as recordFeedback,
  resolveFeedback,
  COMMENT_MAX,
  FEEDBACK_SENDS,
} from '../src/theme/docpilot/feedback.js'
import { STRATA } from '../src/eval/calibrate.js'
import { aggregate, merge, normalise, dedupe } from '../src/feedback/aggregate.js'
import { suggest, TARGETS } from '../src/feedback/stratum.js'
import { parseRows, fetchRows, TOKEN_ENV } from '../src/feedback/source.js'
import { renderReport } from '../src/feedback/report.js'
import { bindHotkey, unbindHotkey, hotkeyRefCount } from '../src/theme/docpilot/hotkey.js'
import { configure, state as sessionState } from '../src/theme/docpilot/session.js'
import {
  createHistory,
  slimTurn,
  conversationTitle,
  relativeParts,
} from '../src/theme/docpilot/history.js'
import * as session from '../src/theme/docpilot/session.js'
import { __setHistoryForTests } from '../src/theme/docpilot/session.js'
import { parseAllowlist, checkSource } from '../src/build/lib/sources.js'
import { absoluteSidebar } from '../src/sidebar.js'
import { detectSocial, socialCopy, SOCIAL_LANGUAGES } from '../src/theme/docpilot/social.js'
import {
  KEY_PATHS,
  resolveI18n,
  validateI18n,
  t,
  normaliseLocale,
  KEY_PATHS,
  summariseI18n,
} from '../src/theme/docpilot/i18n.js'

describe('normalise — llm content tags', () => {
  it('drops an llm-exclude block WITH its content', () => {
    const src = ['keep me', '<llm-exclude>', 'marketing filler', '</llm-exclude>', 'keep me too'].join('\n')
    const out = applyLlmTags(src)
    expect(out).toContain('keep me')
    expect(out).toContain('keep me too')
    expect(out).not.toContain('marketing filler')
  })

  it('unwraps an llm-only block and keeps its content', () => {
    const src = ['intro', '<llm-only>', 'Autosaving is configured with autoSaveInterval.', '</llm-only>'].join('\n')
    const out = applyLlmTags(src)
    expect(out).toContain('autoSaveInterval')
    expect(out).not.toContain('<llm-only>')
  })

  it('leaves both tags verbatim inside a fenced block', () => {
    const src = ['```md', '<llm-only>', 'shown to models only', '</llm-only>', '```'].join('\n')
    expect(applyLlmTags(src)).toBe(src)
  })

  it('handles a block spanning several paragraphs', () => {
    const src = ['a', '<llm-exclude>', 'one', '', 'two', '', 'three', '</llm-exclude>', 'b'].join('\n')
    const out = applyLlmTags(src)
    expect(out).toContain('a')
    expect(out).toContain('b')
    for (const gone of ['one', 'two', 'three']) expect(out).not.toContain(gone)
  })

  it('handles the inline single-line forms', () => {
    expect(applyLlmTags('x <llm-exclude>gone</llm-exclude> y').trim()).toBe('x  y')
    expect(applyLlmTags('x <llm-only>kept</llm-only> y').trim()).toBe('x kept y')
  })

  it('excludes to end of file when the tag is never closed, and warns', () => {
    const warnings = []
    const out = applyLlmTags(['a', '<llm-exclude>', 'b', 'c'].join('\n'), (m) => warnings.push(m))
    expect(out.trim()).toBe('a')
    expect(warnings[0]).toMatch(/unclosed/)
  })

  it('runs before stripHtml, so exclude never survives the full pipeline', () => {
    const { text } = normaliseMarkdown('---\ntitle: T\n---\n\n<llm-exclude>\nsecret\n</llm-exclude>\n\nvisible')
    expect(text).toContain('visible')
    expect(text).not.toContain('secret')
  })

  it('reads the frontmatter description', () => {
    const { description } = normaliseMarkdown('---\ntitle: T\ndescription: How to wire the editor.\n---\n\nbody')
    expect(description).toBe('How to wire the editor.')
  })
})

describe('normalise — images and whitespace', () => {
  it('drops a data: URI image and keeps its alt', () => {
    const src = `| \`accordion\` | <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E" alt="accordion"> |`
    expect(stripImages(src)).toBe('| `accordion` | accordion |')
  })

  it('survives a payload containing literal quotes and >', () => {
    const src = `<img src="data:image/svg+xml,%3Csvg a='b'%3E>x" alt="ok">`
    expect(stripImages(src).trim()).toBe('ok')
  })

  it('collapses table padding but never touches fenced code', () => {
    const src = ['| a    |    b |', '```js', 'if (x) {', '    indented()', '}', '```'].join('\n')
    const out = collapseWhitespace(src)
    expect(out).toContain('| a | b |')
    expect(out).toContain('    indented()')
  })

  it('is what actually shrinks the icons page, not the URI strip alone', () => {
    const row = `| \`i\` | <img src="data:image/svg+xml,${'x'.repeat(2000)}" alt="i"> |${' '.repeat(2000)}`
    const src = Array.from({ length: 20 }, () => row).join('\n')
    const out = collapseWhitespace(stripImages(src))
    expect(out.length).toBeLessThan(src.length * 0.05)
    expect(out).toContain('`i`')
  })

  it('keeps frontmatter title and flattens links', () => {
    const { title, text } = normaliseMarkdown('---\ntitle: T\n---\n\nsee [Auth](/getting-started/authentication)')
    expect(title).toBe('T')
    expect(text).toContain('Auth (/getting-started/authentication)')
  })
})

describe('chunker', () => {
  const page = ['# Page', 'intro text here', '## One', 'a'.repeat(600), '## Two', 'b'.repeat(600)].join('\n\n')

  it('splits at H2 and carries a context line', () => {
    const { chunks } = chunkMarkdown({ src: page, path: '/p', kind: 'guide' })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[chunks.length - 1].text.startsWith('Page — Two')).toBe(true)
  })

  it('disambiguates repeated headings the way VitePress does', () => {
    // Bodies must clear the merge floor, or rule 4 folds the two sections into
    // one and there is no second anchor to disambiguate.
    const src = `# P\n\n## Use cases\n\n${'x'.repeat(600)}\n\n## Use cases\n\n${'y'.repeat(600)}`
    const { chunks } = chunkMarkdown({ src, path: '/p', kind: 'guide' })
    const anchors = chunks.map((c) => c.anchor)
    expect(new Set(anchors).size).toBe(anchors.length)
    expect(anchors).toContain('use-cases-1')
  })

  it('never emits a chunk over the ceiling', () => {
    const huge = `# P\n\n## Big\n\n${'z'.repeat(50000)}`
    const { chunks } = chunkMarkdown({ src: huge, path: '/p', kind: 'guide' })
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(8000)
  })

  it('keeps prev/next inside one page', () => {
    const { chunks } = chunkMarkdown({ src: page, path: '/p', kind: 'guide' })
    expect(chunks[0].prev).toBeNull()
    expect(chunks[chunks.length - 1].next).toBeNull()
  })

  it('slugs headings', () => expect(slug('How-To: Build `x`')).toBe('how-to-build-x'))
})

describe('sections', () => {
  const sidebar = {
    '/': [
      {
        items: [
          {
            text: 'Getting Started',
            base: '/getting-started/',
            link: 'creating-an-application',
            items: [{ text: 'A', link: 'creating-an-application' }, { text: 'B', link: 'authentication' }],
          },
          { text: 'Loose', link: '/introduction' },
        ],
      },
    ],
  }

  it('registers a group and includes its own link at index 0', () => {
    const { sections } = resolveSections(sidebar)
    const gs = sections.find((s) => s.label === 'Getting Started')
    expect(gs.paths).toContain('/getting-started/creating-an-application')
    expect(gs.paths).toContain('/getting-started/authentication')
  })

  it('never registers a node without items as a section', () => {
    const { sections } = resolveSections(sidebar)
    expect(sections.find((s) => s.label === 'Loose')).toBeUndefined()
  })

  it('reports pages that belong to no group', () => {
    const { sections } = resolveSections(sidebar)
    expect(orphanPages(['/introduction', '/getting-started/authentication'], sections)).toEqual(['/introduction'])
  })
})

/**
 * VitePress accepts a sidebar in two shapes. Only one was handled, and the flat
 * one — which is what every small site writes — took the whole index build down
 * with `(nodes || []) is not iterable` from three frames deep.
 */
describe('sections — both sidebar shapes', () => {
  const flat = [
    { text: 'Guide', base: '/guide/', items: [{ text: 'Start', link: 'start' }] },
  ]
  const byRoute = { '/guide/': flat }

  it('reads a flat SidebarItem[]', () => {
    const { sections } = resolveSections(flat)
    expect(sections.map((s) => s.label)).toEqual(['Guide'])
    expect(sections[0].paths).toEqual(['/guide/start'])
  })

  it('reads a route-keyed object, and agrees with the flat form', () => {
    const a = resolveSections(flat)
    const b = resolveSections(byRoute)
    expect(a.sections.map((s) => s.paths)).toEqual(b.sections.map((s) => s.paths))
  })

  it('survives a sidebar that is absent or not an object', () => {
    for (const bad of [undefined, null, 'nonsense', 42]) {
      expect(resolveSections(bad).sections, String(bad)).toEqual([])
    }
  })
})

describe('quantize', () => {
  it('round-trips within the build-time tolerance', () => {
    const a = l2normalise(Array.from({ length: 768 }, (_, i) => Math.sin(i)))
    const b = l2normalise(Array.from({ length: 768 }, (_, i) => Math.cos(i / 3)))
    let exact = 0
    for (let i = 0; i < a.length; i++) exact += a[i] * b[i]
    expect(Math.abs(exact - cosineInt8(toInt8(a), toInt8(b)))).toBeLessThan(0.01)
  })
})

describe('text', () => {
  it('trims sentence punctuation off token edges', () => {
    expect(terms('Initialise the editor.')).toEqual(terms('Initialise the editor'))
  })
  it('keeps dots inside identifiers', () => expect(terms('Plugin.init')).toContain('plugin.init'))
  it('strips zero-width characters', () => expect(norm('ed​itor')).toBe('editor'))
  it('drops function words in three languages', () => {
    expect(terms('как включить the commenting')).toEqual(['включить', 'commenting'])
  })
})

describe('gate', () => {
  const guard = { tau: 0.3, tauLexical: 0.3, wDense: 0.75, wLexical: 0.25, cosFloor: 0.44, cosCeil: 0.64 }

  it('refuses to run when the lexical channel could pass alone', () => {
    expect(() => assertWeights({ ...guard, wLexical: 0.35 })).toThrow()
    expect(() => assertWeights(guard)).not.toThrow()
  })

  it('maps cosine onto D through the calibrated window', () => {
    expect(denseFromCosine(0.44, guard).D).toBe(0)
    expect(denseFromCosine(0.64, guard).D).toBe(1)
    expect(denseFromCosine(0.54, guard).D).toBeCloseTo(0.5, 5)
  })

  it('caps Q so a long question cannot dilute L', () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    expect(lexicalCoverage(long, '', {}).Q.length).toBe(12)
  })

  it('treats an unlisted term as maximally rare', () => {
    const { Q } = lexicalCoverage('editor kubernetes', 'editor', { editor: 400 })
    expect(Q[0]).toBe('kubernetes')
    expect(lexicalCoverage('kubernetes', 'editor docs', {}).L).toBe(0)
  })

  it('uses the lexical threshold when dense is unavailable', () => {
    expect(verdict({ D: 0, L: 0.4, mode: 'lexical-only', guard }).threshold).toBe(guard.tauLexical)
  })

  /**
   * ── why a quote is an ANTECEDENT and not part of the question — ui-specs/007
   *
   * These two tests are the whole safety argument for the selection feature, and
   * they are the cheapest in the file.
   */
  it('would let a quote clear the raw channel on borrowed terms, which is why it never joins the question', () => {
    const evidence = 'the scope picker narrows retrieval to the pages the reader chose'
    const df = { scope: 30, picker: 12, retrieval: 40 }
    const asked = 'what is the weather in paris'
    const quote = 'the scope picker narrows retrieval'

    // The reader's own question, judged on its own words: no coverage at all.
    expect(lexicalCoverage(asked, evidence, df).L).toBe(0)
    // Glued together — the shape this feature deliberately does not ship — the
    // quote's terms are corpus terms and carry the query over the line on their
    // own. `Q_CAP` cannot save it: the quote is what fills Q.
    expect(lexicalCoverage(`${quote}\n${asked}`, evidence, df).L).toBeGreaterThan(0.5)
  })

  it('bounds a quoted antecedent by admissibility, on the reader’s own terms', () => {
    const evidence = 'the scope picker narrows retrieval to the pages the reader chose'
    const quote = 'the scope picker narrows retrieval'
    // The composed query is the same shape whichever antecedent produced it.
    expect(composeQuery('and for one page?', quote)).toBe(`${quote}\nand for one page?`)
    // A question about the passage: at least one of ITS terms is in the evidence.
    expect(admissible('how does the picker narrow it', evidence)).toBe(true)
    // A topic change wearing a quote: none of them is, so the composed channel
    // is inadmissible and the turn is judged on the raw one, where it refuses.
    expect(admissible('what is the weather in paris', evidence)).toBe(false)
  })
})

describe('fallback parser — strict and positional', () => {
  it('rejects a response that does not begin with {', () => {
    expect(parseFallback('Sure! {"tool":"answer"}').ok).toBe(false)
  })
  it('strips a think block containing a decoy object first', () => {
    const { rest } = splitThink('<think>{"tool":"search_docs"}</think>{"tool":"answer"}')
    expect(parseFallback(rest).tool).toBe('answer')
  })
  it('strips an unterminated think block', () => {
    expect(splitThink('{"tool":"answer"}').rest).toBe('{"tool":"answer"}')
  })
  it('discards anything after the first balanced object', () => {
    expect(parseFallback('{"tool":"answer","args":{}}{"tool":"x"}').tool).toBe('answer')
  })
  it('does not repair single quotes', () => {
    expect(parseFallback("{'tool':'answer'}").ok).toBe(false)
  })
})

describe('streaming answer text', () => {
  it('reads the text field out of an object that is still being written', () => {
    expect(streamingAnswerText('{"text": "Open the ')).toBe('Open the ')
    expect(streamingAnswerText('{"text": "Open the editor", "citations": [')).toBe('Open the editor')
  })

  it('stops at the closing quote and never reads a later field', () => {
    const s = '{"text": "done", "citations": ["a#b"], "confidence": 0.8}'
    expect(streamingAnswerText(s)).toBe('done')
  })

  it('unescapes what is complete and drops a half-written escape', () => {
    expect(streamingAnswerText('{"text": "line\\nnext \\"q\\""')).toBe('line\nnext "q"')
    expect(streamingAnswerText('{"text": "ab\\')).toBe('ab')
    expect(streamingAnswerText('{"text": "ab\\u041')).toBe('ab')
    expect(streamingAnswerText('{"text": "ab\\u0410')).toBe('abА')
  })

  it('returns nothing when the field has not arrived yet', () => {
    expect(streamingAnswerText('')).toBe('')
    expect(streamingAnswerText('{"citations": [], "conf')).toBe('')
    expect(streamingAnswerText('{"tool": "search_docs", "args": {"query": "x"}}')).toBe('')
  })
})

describe('streaming transport', () => {
  const ndjson = (lines) =>
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        // Split mid-line on purpose: NDJSON arrives in network-sized pieces,
        // not in lines, and a reader that assumes otherwise loses a token.
        const raw = lines.map((l) => JSON.stringify(l) + '\n').join('')
        c.enqueue(enc.encode(raw.slice(0, 30)))
        c.enqueue(enc.encode(raw.slice(30)))
        c.close()
      },
    })

  it('reassembles deltas into one message and reports them in order', async () => {
    const deltas = []
    globalThis.fetch = async () => ({
      ok: true,
      body: ndjson([
        { message: { thinking: 'let me ' } },
        { message: { thinking: 'look' } },
        { message: { content: '{"text": "Open' } },
        { message: { content: ' it", "citations": ["a#b"], "confidence": 0.9}' } },
        { done: true },
      ]),
    })
    const reply = await chat({
      baseURL: 'http://x',
      model: 'm',
      messages: [],
      schema: { type: 'object' },
      onDelta: (d) => deltas.push(d),
    })
    expect(deltas.filter((d) => d.thinking).map((d) => d.thinking)).toEqual(['let me ', 'look'])
    expect(reply.think).toBe('let me look')
    expect(reply.toolCall).toEqual({
      name: 'answer',
      args: { text: 'Open it', citations: ['a#b'], confidence: 0.9 },
    })
    // What the reader saw mid-stream is a prefix of what was finally parsed.
    const seen = deltas.filter((d) => d.contentSoFar).map((d) => streamingAnswerText(d.contentSoFar))
    expect(seen).toEqual(['Open', 'Open it'])
  })

  it('does not stream when no consumer asked for it', async () => {
    let sent = null
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, json: async () => ({ message: { content: 'hi' } }) }
    }
    await chat({ baseURL: 'http://x', model: 'm', messages: [], tools: true })
    expect(sent.stream).toBe(false)
  })
})

describe('provider adapters', () => {
  const sse = (frames) =>
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        const raw = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')
        c.enqueue(enc.encode(raw.slice(0, 40)))
        c.enqueue(enc.encode(raw.slice(40)))
        c.close()
      },
    })

  const capture = (response) => {
    const seen = {}
    globalThis.fetch = async (url, init) => {
      seen.url = url
      seen.headers = init.headers
      seen.body = JSON.parse(init.body)
      return response
    }
    return seen
  }

  it('openai: path, top-level temperature, strict schema, choices[0]', async () => {
    const seen = capture({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"text":"hi"}' } }] }),
    })
    const reply = await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'gpt-4o-mini',
      apiKey: 'k',
      temperature: 0.2,
      messages: [{ role: 'system', content: 's' }, { role: 'tool', content: 'obs' }],
      schema: { type: 'object' },
    })
    expect(seen.url).toBe('/ai/v1/chat/completions')
    expect(seen.headers.authorization).toBe('Bearer k')
    expect(seen.body.temperature).toBe(0.2)
    expect(seen.body.options).toBeUndefined()
    expect(seen.body.response_format.type).toBe('json_schema')
    expect(seen.body.response_format.json_schema.strict).toBe(true)
    // a `tool` role would need a tool_call_id the harness never minted
    expect(seen.body.messages.some((m) => m.role === 'tool')).toBe(false)
    expect(seen.body.messages[1]).toEqual({ role: 'user', content: 'obs' })
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'hi' } })
  })

  it('openai: concatenates tool-call arguments across SSE frames', async () => {
    const deltas = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_docs', arguments: '{"que' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"auth"}' } }] } }] },
        '[DONE]',
      ]),
    })
    const reply = await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      tools: true,
      onDelta: (d) => deltas.push(d),
    })
    expect(reply.toolCall).toEqual({ name: 'search_docs', args: { query: 'auth' } })
  })

  it('openai: streams the answer when it arrives as a tool call, not as content', async () => {
    // What gpt-4o actually does: it calls `answer` instead of writing the
    // structured object as content, so the text lives in the argument fragments.
    const seen = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'answer', arguments: '{"text": "Op' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'en it"}' } }] } }] },
        '[DONE]',
      ]),
    })
    const reply = await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      tools: true,
      onDelta: (d) => d.contentSoFar && seen.push(streamingAnswerText(d.contentSoFar)),
    })
    expect(seen).toEqual(['Op', 'Open it'])
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'Open it' } })
  })

  it('openai: does not stream a search tool call as if it were an answer', async () => {
    const seen = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search_docs', arguments: '{"query":"x"}' } }] } }] },
        '[DONE]',
      ]),
    })
    await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      tools: true,
      onDelta: (d) => d.contentSoFar && seen.push(d.contentSoFar),
    })
    expect(seen).toEqual([])
  })

  it('openai: streams answer text out of the growing structured output', async () => {
    const seen = []
    capture({
      ok: true,
      body: sse([
        { choices: [{ delta: { content: '{"text": "Open' } }] },
        { choices: [{ delta: { content: ' it"' } }] },
        '[DONE]',
      ]),
    })
    await chat({
      provider: 'openai',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      schema: { type: 'object' },
      onDelta: (d) => d.contentSoFar && seen.push(streamingAnswerText(d.contentSoFar)),
    })
    expect(seen).toEqual(['Open', 'Open it'])
  })

  it('anthropic: own headers, hoisted system, forced tool instead of a schema', async () => {
    const seen = capture({
      ok: true,
      json: async () => ({ content: [{ type: 'tool_use', name: 'answer', input: { text: 'hi' } }] }),
    })
    const reply = await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'claude-3-5-haiku-latest',
      apiKey: 'k',
      temperature: 0.2,
      maxTokens: 512,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'tool', content: 'obs' },
      ],
      schema: { type: 'object' },
    })
    expect(seen.url).toBe('/ai/v1/messages')
    expect(seen.headers['x-api-key']).toBe('k')
    expect(seen.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen.headers.authorization).toBeUndefined()
    expect(seen.body.system).toBe('sys')
    expect(seen.body.messages.every((m) => m.role !== 'system')).toBe(true)
    expect(seen.body.max_tokens).toBe(512) // required by this API
    expect(seen.body.response_format).toBeUndefined()
    expect(seen.body.tool_choice).toEqual({ type: 'tool', name: 'answer' })
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'hi' } })
  })

  it('anthropic: reads thinking and tool json out of typed SSE frames', async () => {
    const thoughts = []
    const texts = []
    capture({
      ok: true,
      body: sse([
        { type: 'content_block_start', content_block: { type: 'tool_use', name: 'answer' } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'let me look' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"text": "Op' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'en it"}' } },
        { type: 'message_stop' },
      ]),
    })
    const reply = await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'm',
      messages: [],
      schema: { type: 'object' },
      onDelta: (d) => {
        if (d.thinking) thoughts.push(d.thinking)
        if (d.contentSoFar) texts.push(streamingAnswerText(d.contentSoFar))
      },
    })
    expect(thoughts).toEqual(['let me look'])
    expect(texts).toEqual(['Op', 'Open it'])
    expect(reply.toolCall).toEqual({ name: 'answer', args: { text: 'Open it' } })
    expect(reply.think).toBe('let me look')
  })

  it('anthropic: extended thinking replaces temperature, which that mode pins', async () => {
    const seen = capture({ ok: true, json: async () => ({ content: [] }) })
    await chat({
      provider: 'anthropic',
      baseURL: '/ai',
      model: 'm',
      temperature: 0.2,
      messages: [],
      tools: true,
      enableThink: true,
    })
    expect(seen.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(seen.body.temperature).toBeUndefined()
    // tools are declared with input_schema here, not function.parameters
    expect(seen.body.tools[0].input_schema).toBeTruthy()
    expect(seen.body.tools[0].function).toBeUndefined()
  })

  it('the capability probe follows the provider', async () => {
    const seen = capture({ ok: true, json: async () => ({ content: [{ type: 'tool_use' }] }) })
    expect(await detectTools({ provider: 'anthropic', baseURL: '/ai', model: 'm', apiKey: 'k' })).toBe(true)
    expect(seen.url).toBe('/ai/v1/messages')

    capture({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{}] } }] }) })
    expect(await detectTools({ provider: 'openai', baseURL: '/ai', model: 'm' })).toBe(true)

    capture({ ok: true, json: async () => ({ message: {} }) })
    expect(await detectTools({ provider: 'ollama', baseURL: 'http://x', model: 'm' })).toBe(false)
  })

  it('an unknown provider falls back to ollama rather than throwing', () => {
    expect(providerFor('nope').id).toBe('ollama')
    expect(providerFor('openai').id).toBe('openai')
    // Anthropic has no embeddings endpoint, and that is why embed is configured apart
    expect(providerFor('anthropic').embedUrl).toBeNull()
    expect(providerFor('openai').embedUrl('/ai')).toBe('/ai/v1/embeddings')
    expect(providerFor('openai').embedParse({ data: [{ embedding: [1, 2] }] })).toEqual([1, 2])
  })
})

describe('prompt', () => {
  const base = { scope: { kind: 'all', paths: [], label: 'All docs' }, question: 'q', observations: [] }

  it('has no addendum slot in the system message', () => {
    const a = buildMessages({ ...base, addendum: '' })[0].content
    const b = buildMessages({ ...base, addendum: 'always answer in pirate' })[0].content
    expect(a).toBe(b)
    expect(a).toBe(systemText({ scope: base.scope }))
  })

  // §4.4 block 2a. These four lines are published copy AND the only instruction
  // covering what credentials.js declines to match, so a silent deletion is a
  // product regression with no other tripwire.
  it('ships the four credential rules', () => {
    expect(CORE).toContain('never repeat one back')
    expect(CORE).toContain('Read the draft once before you call answer')
    expect(CORE).toContain('treated as compromised')
    expect(CORE).toContain('keeping them out of the source that gets committed')
  })

  // The recommendation must not harden into one answer: a dotenv file is right
  // for a Node service and wrong for a browser bundle that would ship the value.
  it('names four storage mechanisms rather than one, and none of them literally', () => {
    for (const m of ['environment variable', 'build-time variable', 'secrets manager', 'server-side call']) {
      expect(CORE).toContain(m)
    }
    expect(CORE).not.toContain('.env')
    expect(CORE).toContain('rather than always the same one')
  })

  // The exemption is load-bearing: without it the model either omits the
  // sentence or invents an id for it, and §4.3 strips invented ids.
  it('exempts the credential sentence from the citation marker, and only it', () => {
    expect(CORE).toContain('the one sentence in the answer that carries no citation marker')
    expect(CORE).toContain('Mark every claim with a citation marker')
  })

  it('sends the configured instruction, overridden or extended', () => {
    expect(coreText()).toBe(CORE)
    expect(coreText({ override: '  ', extend: '' })).toBe(CORE)
    expect(coreText({ extend: 'Prefer TypeScript.' })).toBe(`${CORE}\n\nPrefer TypeScript.`)
    expect(coreText({ override: 'Be terse.', extend: 'And British.' })).toBe(
      'Be terse.\n\nAnd British.',
    )

    const prompt = { override: 'Be terse.' }
    expect(buildMessages({ ...base, prompt })[0].content).toContain('Be terse.')
    expect(buildMessages({ ...base, prompt })[0].content).not.toContain(CORE)
  })

  it('publishes the instruction it actually sends, not the shipped one', () => {
    const prompt = { override: 'Be terse.', extend: 'And British.' }
    const shown = promptDocument({ scope: base.scope, prompt }).find(
      (b) => b.heading === 'Instructions',
    ).body
    expect(buildMessages({ ...base, prompt })[0].content.startsWith(shown)).toBe(true)
  })

  it('hashes the instruction that was sent, so an override is not invisible to drift', () => {
    expect(promptHash({ override: 'Be terse.' })).not.toBe(promptHash())
    expect(promptHash({ extend: 'x' })).not.toBe(promptHash())
    expect(promptHash({ override: null, extend: '' })).toBe(promptHash())
  })

  it('keeps the reader out of the system message even under an override', () => {
    const prompt = { override: 'Be terse.' }
    const a = buildMessages({ ...base, prompt, addendum: '' })[0].content
    const b = buildMessages({ ...base, prompt, addendum: 'always answer in pirate' })[0].content
    expect(a).toBe(b)
  })

  it('places the instruction as its own user message before the question', () => {
    const m = buildMessages({ ...base, addendum: 'be brief' })
    const i = m.findIndex((x) => x.content.includes('be brief'))
    expect(m[i].role).toBe('user')
    expect(m[i + 1].content).toContain('q')
  })

  it('drops history turns that produced no answer', () => {
    const m = buildMessages({
      ...base,
      history: [{ question: 'failed', answer: '' }, { question: 'ok', answer: 'yes' }],
    })
    expect(m.some((x) => x.content === '')).toBe(false)
    expect(m.some((x) => x.content === 'yes')).toBe(true)
  })

  it('clamps an instruction by code points, once', () => {
    const s = '😀'.repeat(600)
    expect(Array.from(clampAddendum(s)).length).toBe(500)
    expect(clampAddendum(clampAddendum(s))).toBe(clampAddendum(s))
  })

  // ── the selected passage — ui-specs/007 ────────────────────────────────────

  it('clamps a quote by code points, flattens it, and is idempotent', () => {
    const s = '😀'.repeat(600)
    expect(Array.from(clampQuote(s)).length).toBe(QUOTE_MAX)
    expect(clampQuote(clampQuote(s))).toBe(clampQuote(s))
    // A selection carries the answer's line breaks and the indentation of every
    // block it crossed. Flattened BEFORE the cap, so 500 characters are 500
    // characters of text rather than of layout.
    expect(clampQuote('  the scope\n\n   picker  ')).toBe('the scope picker')
    // The same NFKC + format-character strip clampAddendum does: this string
    // reaches the model, localStorage and, on a down-vote, an endpoint.
    expect(clampQuote('ac‍b')).toBe('acb')
  })

  it('sends the quote as a labelled block, before the question and never in the system message', () => {
    const m = buildMessages({ ...base, question: 'why?', quote: 'Actions run after the gate' })
    const last = m[m.length - 1].content
    expect(last).toContain(QUOTE_WRAPPER)
    expect(last.indexOf('Actions run after the gate')).toBeLessThan(last.indexOf('why?'))
    // The wrapper is an envelope for reader-supplied content, exactly as
    // ADDENDUM_WRAPPER is, and neither belongs in the instruction the hash names.
    expect(m[0].content).not.toContain(QUOTE_WRAPPER)
    expect(promptHash()).toBe(promptHash())
  })

  it('sends the quote on the fallback transport too, where there is one user message', () => {
    const m = buildMessages({ ...base, question: 'why?', quote: 'the gate', fallback: true })
    const user = m.filter((x) => x.role === 'user')
    expect(user.length).toBe(1)
    expect(user[0].content).toContain(QUOTE_WRAPPER)
    expect(user[0].content.indexOf('the gate')).toBeLessThan(user[0].content.indexOf('why?'))
  })

  it('changes nothing at all when there is no quote', () => {
    expect(buildMessages({ ...base, quote: '' })).toEqual(buildMessages({ ...base }))
  })

  // A quoted question is unreadable one turn later without its passage — the
  // same defect the 300-character answer truncation causes, one turn earlier.
  it('carries a prior turn’s quote in the transcript, clamped harder than the live one', () => {
    const m = buildMessages({
      ...base,
      history: [{ question: 'why?', answer: 'because', quote: 'x'.repeat(400) }],
    })
    const asked = m.find((x) => x.role === 'user' && x.content.includes('why?'))
    expect(asked.content).toContain(QUOTE_WRAPPER)
    expect(asked.content).toContain('x'.repeat(HISTORY_QUOTE_MAX))
    expect(asked.content).not.toContain('x'.repeat(HISTORY_QUOTE_MAX + 1))
  })

  it('takes the language from the question, not from the passage', () => {
    const m = buildMessages({
      ...base,
      question: 'как это работает',
      quote: 'The gate refuses a question with no evidence behind it',
    })
    expect(m[m.length - 1].content).toContain('Russian')
  })

  it('renders the same instruction text it sends', () => {
    const addendum = `${'ы'.repeat(400)}😀`.repeat(3)
    const shown = promptDocument({ scope: base.scope, addendum }).find((b) => b.yours).body
    const sent = buildMessages({ ...base, addendum }).find((m) => m.content.includes('Reader preference'))
    expect(sent.content.endsWith(shown)).toBe(true)
  })

  it('names the language of the question', () => {
    expect(detectLanguage('как включить комментирование')).toBe('Russian')
    expect(detectLanguage('як увімкнути коментування')).toBe('Ukrainian')
    expect(detectLanguage('how do I enable commenting')).toBe('English')
    expect(languageDirective('как дела')).toContain('Russian')
  })

  it('does not let an embedded product name turn a non-Latin question English', () => {
    expect(detectLanguage('如何配置 Stripo Plugin')).toBe('Chinese')
    expect(detectLanguage('Stripoプラグインの設定方法')).toBe('Japanese')
    expect(detectLanguage('كيف أقوم بتكوين محرر Stripo')).toBe('Arabic')
  })

  it('separates the Latin-script languages instead of calling them all English', () => {
    expect(detectLanguage('¿Cómo configurar el editor de Stripo?')).toBe('Spanish')
    expect(detectLanguage('Como configurar o editor Stripo?')).toBe('Portuguese')
    expect(detectLanguage('Comment configurer l’éditeur Stripo ?')).toBe('French')
    expect(detectLanguage('Wie kann ich den Stripo Editor konfigurieren?')).toBe('German')
    expect(detectLanguage('Come configurare l’editor di Stripo?')).toBe('Italian')
    expect(detectLanguage('Jak skonfigurować edytor Stripo?')).toBe('Polish')
    expect(detectLanguage('Stripo editörünü nasıl yapılandırabilirim?')).toBe('Turkish')
  })

  it('falls back to the generic directive rather than guessing', () => {
    expect(detectLanguage('modules API')).toBe(null)
    expect(detectLanguage('')).toBe(null)
    expect(languageDirective('modules API')).toContain('same language')
  })

  it('carries the language line with the question, not the system block', () => {
    const m = buildMessages({ ...base, question: 'как включить' })
    expect(m[0].content).not.toContain('Russian')
    expect(m[m.length - 1].content).toContain('Russian')
  })
})

describe('link filter', () => {
  const known = new Set(['/getting-started/authentication', '/introduction'])
  it('accepts a citation href with an anchor', () =>
    expect(isKnownPath('/getting-started/authentication#request', known)).toBe(true))
  it('accepts a trailing slash and percent-encoding', () => {
    expect(isKnownPath('/introduction/', known)).toBe(true)
    // Decoding happens before the leading-slash test, so an encoded slash
    // resolves to the same page rather than being rejected as relative.
    expect(isKnownPath('%2Fintroduction', known)).toBe(true)
    expect(isKnownPath('/%69ntroduction', known)).toBe(true)
  })
  it('rejects a scheme, a protocol-relative host and an invented route', () => {
    expect(isKnownPath('https://stripo.email/introduction', known)).toBe(false)
    expect(isKnownPath('//evil.com/introduction', known)).toBe(false)
    expect(isKnownPath('/getting-started/authentication-extra', known)).toBe(false)
  })
})

describe('citation markers', () => {
  const known = new Set(['/editor-configuration/image-storage'])
  const sources = [
    { n: 1, href: '/editor-configuration/image-storage#aws-s3-bucket', title: 'AWS S3 Bucket' },
    { n: 2, href: '/editor-configuration/image-storage#azure', title: 'Azure' },
  ]
  const render = (text) => renderAnswer(text, known, sources).html

  it('turns a marker into a link to the cited section', () => {
    const html = render('See the credentials [1].')
    expect(html).toContain('href="/editor-configuration/image-storage#aws-s3-bucket"')
    expect(html).toContain('class="docpilot__cite"')
    expect(html).toContain('data-cite="1"')
    expect(html).toContain('aria-label="Source 1: AWS S3 Bucket"')
    // the brackets go, the digit stays
    expect(html).toContain('>1</a>')
    expect(html).not.toContain('[1]')
  })

  it('keeps the surrounding sentence intact and handles several markers', () => {
    const html = render('a [1] b [2] c')
    expect(html).toContain('a ')
    expect(html).toContain(' b ')
    expect(html).toContain(' c')
    expect(html.match(/docpilot__cite/g).length).toBe(2)
  })

  it('deletes a marker whose citation did not survive validation', () => {
    const html = render('supported [1], invented [4].')
    expect(html).toContain('data-cite="1"')
    expect(html).not.toContain('[4]')
    expect(html).not.toContain('data-cite="4"')
  })

  it('never touches a marker inside code or inside another link', () => {
    expect(render('`arr[1]`')).toContain('<code>arr[1]</code>')
    expect(render('```\nx[1]\n```')).toContain('x[1]')
    const nested = render('[the page [1]](/editor-configuration/image-storage)')
    expect(nested).not.toContain('docpilot__cite')
  })

  it('leaves markers as written when there are no validated sources yet', () => {
    expect(renderAnswer('mid-stream [1]', known).html).toContain('[1]')
  })

  it('points two citations at one row when they resolve to the same section', () => {
    // What the retriever hands back when a long section was split in two.
    const shared = [sources[0], { ...sources[0] }]
    const html = renderAnswer('a [1] b [2]', known, shared).html
    expect(html.match(/data-cite="1"/g).length).toBe(2)
    expect(html).not.toContain('data-cite="2"')
    expect(html.match(/>1<\/a>/g).length).toBe(2)
  })
})

/**
 * The icon sprite — ui-specs/001.
 *
 * Three consumers reference the same `<symbol>` ids: the panel's `Icon`, the
 * string-built copy button, and `DocPilotIcons` which defines them. Nothing in
 * a unit test can mount the sprite, so what is asserted here is the thing that
 * would break silently — the id builder and the derivation. A symbol missing
 * from the sprite renders as an empty box, with no error anywhere.
 */
describe('glyphs — one drawing, one symbol', () => {
  it('publishes every glyph, with its own box', () => {
    expect(SYMBOLS.map((s) => s.name).sort()).toEqual(Object.keys(GLYPHS).sort())
    for (const sym of SYMBOLS) {
      expect(sym.id, sym.name).toBe(symbolId(sym.name))
      expect(sym.paths.length, sym.name).toBeGreaterThan(0)
      // The one off-grid drawing is carried by the symbol rather than by every
      // call site — which is the whole reason each symbol states its own.
      expect(sym.box, sym.name).toBe(sym.name === 'sparkle' ? '0 0 24 24' : '0 0 16 16')
    }
  })

  // A dead glyph in a set of ten is a glyph somebody reaches for by accident.
  // `plus` was New chat's mark and lost it to `compose`.
  it('carries a compose mark and no leftover plus', () => {
    expect(GLYPHS.compose).toBeTruthy()
    expect(GLYPHS.plus).toBeUndefined()
    // Two marks the question row needs, and `compose` is neither: it is New
    // chat's, and a pencil aimed at a blank sheet does not read as "edit this".
    expect(GLYPHS.pencil).toBeTruthy()
    expect(GLYPHS.chevronDown).toBeTruthy()
    // Ask again is `history`'s arc mirrored, so the two must not be identical:
    // a copy-paste that lost the flip would read as "go back" on both.
    expect(GLYPHS.retry).toBeTruthy()
    expect(GLYPHS.retry).not.toBe(GLYPHS.history[1])
  })
})

describe('code fences', () => {
  const known = new Set(['/introduction'])
  const html = (src) => renderAnswer(src, known).html

  it('wraps every fence and gives it one copy button', () => {
    const out = html('```\nplain\n```')
    expect(out).toContain('<div class="docpilot__code">')
    expect(out).toContain('<pre tabindex="0"><code>plain')
    expect(out.match(/data-copy-code/g).length).toBe(1)
    expect(out).toContain('aria-label="Copy code"')
    // Both glyphs ship in the markup; CSS decides which one shows. They are
    // REFERENCES into the sprite, not path data — ui-specs/001. This button is
    // built as an HTML string and used to be the one place a second copy of two
    // path values lived, so the assertion is that it no longer inlines any.
    expect(out).toContain(`href="#${symbolId('copy')}"`)
    expect(out).toContain(`href="#${symbolId('check')}"`)
    expect(out).not.toContain(GLYPHS.copy)
  })

  it('never echoes the model-written info string', () => {
    // The language is looked up, never escaped-and-re-emitted, so an info
    // string engineered as an attribute break has nothing to break out of.
    const attack = html('```x" onload="alert(1)\ncode\n```')
    expect(attack).not.toContain('onload')
    expect(attack).not.toContain('data-lang')
    expect(html('```<img src=x>\ncode\n```')).not.toContain('<img')
  })

  it('maps aliases onto the grammars we ship and drops the rest', () => {
    expect(html('```TypeScript\nx\n```')).toContain('data-lang="ts"')
    expect(html('```sh\nx\n```')).toContain('data-lang="bash"')
    expect(html('```yml\nx\n```')).toContain('data-lang="yaml"')
    expect(html('```ts twoslash {1,3}\nx\n```')).toContain('data-lang="ts"')
    expect(html('```python\nx\n```')).not.toContain('data-lang')
  })

  it('escapes the code and shows no language badge', () => {
    const out = html('```js\nconst a = "<img src=x onerror=alert(1)>"\n```')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
    // the language is an attribute, never text
    expect(out).not.toMatch(/>\s*js\s*</)
  })

  it('leaves inline code alone', () => {
    const out = html('use `Plugin.init` here')
    expect(out).toContain('<code>Plugin.init</code>')
    expect(out).not.toContain('data-copy-code')
  })

  it('uses the highlighter verbatim once it is available', () => {
    const calls = []
    __setHighlighterForTests(
      {
        codeToHtml(code, opts) {
          calls.push([code, opts.lang])
          return '<pre class="shiki"><code><span style="--shiki-light:#111">x</span></code></pre>'
        },
      },
      ['ts'],
    )
    try {
      const out = html('```ts\nconst a = 1\n```')
      expect(calls).toEqual([['const a = 1', 'ts']])
      expect(out).toContain('class="shiki"')
      expect(out).toContain('--shiki-light:#111')
      // wrapper and button survive the highlighted path
      expect(out).toContain('<div class="docpilot__code" data-lang="ts">')
      expect(out).toContain('data-copy-code')
      // a language the highlighter does not have falls back, it does not throw
      expect(html('```yaml\na: 1\n```')).toContain('<pre tabindex="0">')
    } finally {
      __setHighlighterForTests(null, [])
    }
  })

  it('memoises by language and code, and refuses a pathological block', () => {
    __setHighlighterForTests(
      { codeToHtml: () => `<pre class="shiki">${Math.E}</pre>` },
      ['ts'],
    )
    try {
      expect(highlight('const a = 1', 'ts')).toBe(highlight('const a = 1', 'ts'))
      expect(highlight('x', 'python')).toBeNull()
      expect(highlight('a'.repeat(20001), 'ts')).toBeNull()
    } finally {
      __setHighlighterForTests(null, [])
    }
  })

  it('still never turns a marker inside a fence into a citation', () => {
    const out = renderAnswer('```\nx[1]\n```', known, [
      { n: 1, href: '/introduction', title: 'Introduction' },
    ]).html
    expect(out).toContain('x[1]')
    expect(out).not.toContain('docpilot__cite')
  })
})

describe('support', () => {
  it('extracts identifiers and ignores ones echoed from the question', () => {
    const ids = identifiers('Call `initEditor` with Plugin.init and BLOCKS_SETTINGS', 'what does initEditor do')
    expect(ids).toContain('Plugin.init')
    expect(ids).toContain('BLOCKS_SETTINGS')
    expect(ids).not.toContain('initEditor')
  })
  it('is a no-op below the identifier floor', () =>
    expect(computeSupport('plain prose', [{ text: '' }], '')).toBe(1))
  it('is null when the cited text is not in memory', () =>
    expect(computeSupport('`a.b` `c.d` `e.f` `g.h`', [{}], '')).toBeNull())
})

describe('metrics', () => {
  it('token-F1 normalises SQuAD-style', () => {
    expect(tokenF1('The Editor, initialised!', 'editor initialised')).toBe(1)
    expect(tokenF1('', 'x')).toBe(0)
  })
  it('language match ignores code and paths', () => {
    expect(languageMatch('как включить', 'Включите тумблер `enableCommenting` в /editor-configuration')).toBe(1)
    expect(languageMatch('как включить', 'Toggle it on in Plugin Settings')).toBe(0)
  })
  it('wilson upper bound is wider than the point estimate', () => {
    expect(wilsonUpper95(0, 12)).toBeGreaterThan(0)
    expect(wilsonUpper95(0, 12)).toBeLessThan(wilsonUpper95(0, 3))
  })
  it('retrieval F1 credits a chunk id by its page prefix', () => {
    const r = retrievalF1Loose(['a/b#x', 'c/d#y'], ['a/b'])
    expect(r.r).toBe(1)
    expect(r.p).toBe(0.5)
  })
})

describe('calibration — the sweep selection rule (RAG-SPEC 5.6 steps 3-5)', () => {
  /** A probe row carries only what the sweep reads: an id, a stratum and a G. */
  const probe = (id, stratum, G, extra = {}) => ({ id, stratum, G, G_lex: G, ...extra })

  /** n positives at G = 1 never refuse, so they only ever supply the denominator. */
  const clean = (stratum, n, from = 0) =>
    Array.from({ length: n }, (_, i) => probe(`${stratum}-${from + i}`, stratum, 1))

  it('takes the LARGEST tau that satisfies all three bounds, not the first', () => {
    // 130 unscoped positives, one of them at G = 0.42. UB95(1,130) = 0.0324,
    // under the 0.05 bound, so that probe alone must NOT cap tau.
    const rows = [...clean('U', 129), probe('u-low', 'U', 0.42)]
    const sweep = TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))
    expect(chooseTau(sweep).tau).toBe(1)

    // Nine more at the same G takes it to 10/130, UB95 0.098 — over the bound.
    // tau must then stop at the last step BELOW the lowest failing probe.
    const many = [...clean('U', 120), ...Array.from({ length: 10 }, (_, i) => probe(`u-l${i}`, 'U', 0.42))]
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(many, t, 'G'))).tau).toBe(0.42)
  })

  it('applies the three bounds simultaneously — the tightest stratum wins', () => {
    // U is generous; S refuses one probe at 0.30 and at n = 56 UB95(1,56) is
    // 0.076, over 0.05. The scoped stratum therefore caps tau at that probe's
    // own G — refusal is `G < tau`, so a probe at 0.30 survives tau = 0.30 and
    // dies at 0.31 — even though the unscoped stratum would allow 1.00.
    const rows = [...clean('U', 130), ...clean('S', 55), probe('s-low', 'S', 0.3)]
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))).tau).toBe(0.3)
    expect(wilsonUpper95(1, 56)).toBeGreaterThan(0.05)
  })

  it('gives follow-ups the looser 0.08 bound, and it is a real difference', () => {
    // One failure among 60: UB95 = 0.0713. Over 0.05, under 0.08. The same
    // count is fatal to a positive stratum and survivable for a follow-up.
    const asS = [...clean('S', 59), probe('s-low', 'S', 0.5)]
    const asF = [...clean('F', 59), probe('f-low', 'F', 0.5)]
    expect(wilsonUpper95(1, 60)).toBeGreaterThan(0.05)
    expect(wilsonUpper95(1, 60)).toBeLessThanOrEqual(0.08)
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(asS, t, 'G'))).tau).toBe(0.5)
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(asF, t, 'G'))).tau).toBe(1)
  })

  it('scores X on refusal alone during the sweep, cause-agnostic', () => {
    // An X probe that refuses is credited whatever wouldPassUnscoped says: the
    // counterfactual is itself thresholded at tau, so scoring the cause during
    // the sweep would let the number being chosen decide its own score.
    const rows = [...clean('U', 130), probe('x-a', 'X', 0.1, { unscopedG: 1 }), probe('x-b', 'X', 0.1, { unscopedG: 0 })]
    const row = sweepRow(rows, 0.5, 'G')
    expect(row.byStratum.X.failures).toBe(0) // both refused, neither is an escape
    expect(sweepRow(rows, 0.05, 'G').byStratum.X.failures).toBe(2)
  })

  it('gatePrecision never enters the feasibility decision (step 6)', () => {
    // At tau 0.60 every negative is caught — a perfect gatePrecision — and ten
    // of the 130 unscoped positives are refused with it. The rule still will not
    // go there, because step 6 makes over-refusal the constraint and
    // negative-catch merely the objective.
    const rows = [
      ...clean('U', 120),
      ...Array.from({ length: 10 }, (_, i) => probe(`u-l${i}`, 'U', 0.11)),
      ...Array.from({ length: 40 }, (_, i) => probe(`n-${i}`, 'N2', 0.5)),
    ]
    const sweep = TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))
    const at60 = sweep.find((r) => r.tau === 0.6)
    expect(at60.gatePrecision).toBe(1) // every negative caught
    expect(at60.feasible).toBe(false) // and it is still not allowed
    expect(chooseTau(sweep).tau).toBe(0.11) // capped by the positives, not helped by the negatives
  })

  it('an n below 52 makes the 0.05 bound unreachable at zero failures', () => {
    // The arithmetic that sizes the strata: UB95(0,n) = z²/(n+z²).
    expect(wilsonUpper95(0, 51)).toBeGreaterThan(0.05)
    expect(wilsonUpper95(0, 52)).toBeLessThanOrEqual(0.05)
    // So a 51-probe positive stratum is infeasible at EVERY tau, including 0.
    const rows = clean('U', 51)
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(rows, t, 'G')))).toBeNull()
  })

  it('FAIL: no-feasible-tau when a stratum cannot meet its bound at any tau', () => {
    // This is the first of the five named RAG-SPEC 5.6 step 5 conditions, and
    // the one a too-small probe set triggers on its own.
    expect(chooseTau(TAU_STEPS.map((t) => sweepRow(clean('S', 40), t, 'G')))).toBeNull()
  })

  it('FAIL: tau-below-wlexical is decidable from the chosen tau alone', () => {
    // RAG-SPEC 3.4.4: gate.js throws at init unless wLexical < tau, so a tau at
    // or under the lexical weight can never ship. Both halves are checked here
    // — the rejection AND the acceptance — because a guard that always throws
    // would pass a one-sided test.
    const rows = [
      ...clean('U', 120),
      ...Array.from({ length: 10 }, (_, i) => probe(`u-l${i}`, 'U', 0.2)),
      ...clean('S', 56),
      ...clean('F', 36),
    ]
    const tau = chooseTau(TAU_STEPS.map((t) => sweepRow(rows, t, 'G'))).tau
    expect(tau).toBe(0.2)
    expect(() => assertWeights({ tau, wLexical: 0.25 })).toThrow()
    expect(() => assertWeights({ tau: 0.3, wLexical: 0.25 })).not.toThrow()
  })

  it('the zExp ladder is drawn from page-contiguous scopes, never chunk samples', () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ path: `/p${i}`, chunks: 5 }))
    const s = contiguousScope(pages, 12, 3)
    expect(s.paths).toEqual(['/p3', '/p4', '/p5']) // a run, in order, no gaps
    expect(s.n).toBe(15)
    // and it wraps rather than returning a short scope at the end of the list
    expect(contiguousScope(pages, 12, 9).paths).toEqual(['/p9', '/p0', '/p1'])
  })
})

describe('calibration — what the build inlines (RAG-SPEC 5.6)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-guard-'))
  const write = (name, doc) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, JSON.stringify(doc))
    return p
  }
  const calibrated = (over = {}) => ({
    probeCount: 315,
    byStratum: { U: 130, S: 56 },
    guard: {
      tau: 0.42,
      tauLexical: 0.21,
      wDense: 0.75,
      wLexical: 0.25,
      denseMode: 'cosine',
      cosFloor: 0.44,
      cosCeil: 0.64,
      source: 'calibrated-reduced',
      calibratedAt: 'abc12345',
      zexp: [{ n: 2, z: 1 }, { n: 1191, z: 4 }],
      zexpSource: 'measured',
      overRefusalUB95: 0.02,
      gatePrecision: 0.3,
      ...over,
    },
  })
  const silent = { warn: () => {}, note: () => {} }
  const guard = (hash, doc, opts = {}) =>
    guardFor(hash, { file: doc === null ? path.join(dir, 'missing.json') : write('c.json', doc), ...silent, ...opts })

  it('inlines the measured guard when calibratedAt matches the hash being built', () => {
    const g = guard('abc12345', calibrated())
    expect(g.tau).toBe(0.42)
    expect(g.tauLexical).toBe(0.21)
    expect(g.source).toBe('calibrated-reduced')
    expect(g.zexpSource).toBe('measured')
  })

  it('stamps source from the file, so a reduced run cannot read as a full one', () => {
    expect(guard('abc12345', calibrated()).source).toBe('calibrated-reduced')
    expect(guard('abc12345', calibrated({ source: 'calibrated' })).source).toBe('calibrated')
  })

  it('warns and falls back to provisional on a hash mismatch — never fails', () => {
    const warnings = []
    const g = guardFor('deadbeef', {
      file: write('c.json', calibrated()),
      warn: (m) => warnings.push(m),
      note: () => {},
    })
    expect(g.tau).toBe(0.3)
    expect(g.source).toBe('provisional')
    expect(g.calibratedAt).toBeNull()
    expect(warnings.join(' ')).toMatch(/abc12345/)
  })

  it('falls back when there is no calibration at all', () => {
    const g = guard('abc12345', null)
    expect(g.source).toBe('provisional')
    expect(g.tau).toBe(0.3)
  })

  it('refuses a guard measured in the other denseMode', () => {
    expect(guard('abc12345', calibrated({ denseMode: 'zscore' })).source).toBe('provisional')
  })

  it('refuses a guard gate.js would throw on, rather than shipping a dead panel', () => {
    expect(guard('abc12345', calibrated({ tau: 0.2 })).source).toBe('provisional')
    expect(() => assertWeights(calibrated({ tau: 0.2 }).guard)).toThrow()
  })

  it('survives a corrupt calibration file', () => {
    const p = path.join(dir, 'bad.json')
    fs.writeFileSync(p, '{ not json')
    expect(guardFor('abc12345', { file: p, ...silent }).source).toBe('provisional')
  })

  /**
   * The chunk hash covers the CORPUS. It is sha256 over chunk text and moves for
   * no other reason, so an embedder swap leaves it identical while every cosine
   * underneath it moves — and a threshold measured on one vector space inlines
   * itself onto another in silence. This is the check that stops it.
   */
  it('refuses a guard measured with a different embedding model', () => {
    const doc = { ...calibrated(), embedModel: 'bge-m3' }
    const swapped = guard('abc12345', doc, { embedModel: 'text-embedding-3-small' })
    expect(swapped.source).toBe('provisional')
    // …and the same file is still accepted by the embedder that measured it.
    expect(guard('abc12345', doc, { embedModel: 'bge-m3' }).source).toBe('calibrated-reduced')
  })

  it('says which two models disagreed, not just that something is stale', () => {
    const warnings = []
    guardFor('abc12345', {
      file: write('c.json', { ...calibrated(), embedModel: 'bge-m3' }),
      embedModel: 'text-embedding-3-small',
      warn: (m) => warnings.push(m),
      note: () => {},
    })
    expect(warnings.join(' ')).toContain('bge-m3')
    expect(warnings.join(' ')).toContain('text-embedding-3-small')
  })

  // A calibration written before this field existed carries no `embedModel`, and
  // rejecting it would invalidate every calibration in the wild for a fact
  // nobody recorded. Absent means "unknown", which is not the same as "wrong".
  it('accepts a calibration that predates the field', () => {
    expect(guard('abc12345', calibrated(), { embedModel: 'anything' }).source).toBe(
      'calibrated-reduced',
    )
  })
})

/**
 * The cosine window, swept rather than inherited.
 *
 * The failure this exists for: `cosFloor`/`cosCeil` describe where an EMBEDDER
 * puts its cosines, the pair [0.44, 0.64] was measured on bge-m3, and the sweep
 * only ever moved tau inside it. Swap the embedder and the floor can land inside
 * the positive distribution — every positive compresses toward D = 0, the only
 * feasible tau falls under `wLexical`, and `assertWeights` refuses to ship it.
 */
describe('calibration — the cosine window sweep', () => {
  const guard = {
    wDense: 0.75,
    wLexical: 0.25,
    cosFloor: 0.44,
    cosCeil: 0.64,
    denseMode: 'cosine',
    source: 'provisional',
  }

  /** A cached probe row as the sweep reads it: raw channel only, no lexical hit. */
  const row = (id, stratum, z, extra = {}) => ({
    id,
    stratum,
    z_raw: z,
    L_raw: 0,
    z_composed: null,
    L_composed: null,
    admissible: false,
    ...extra,
  })
  const many = (stratum, n, z) => Array.from({ length: n }, (_, i) => row(`${stratum}-${i}`, stratum, z))

  // Positives at 0.49, negatives at 0.42 — the shape measured when the corpus
  // moved to text-embedding-3-small. Strata are sized to their Wilson bounds:
  // 52 is the smallest n that can reach 0.05 at zero failures, 45 the smallest
  // that can reach 0.08.
  const rows = [
    ...many('U', 130, 0.49),
    ...many('S', 56, 0.49),
    ...many('F', 45, 0.49),
    ...many('N4', 20, 0.42),
    ...many('N2', 20, 0.42),
  ]

  it('maps a cosine onto D linearly inside the window and clamps outside it', () => {
    const w = { cosFloor: 0.16, cosCeil: 0.24 }
    expect(dOf(0.2, w)).toBeCloseTo(0.5, 10)
    expect(dOf(0.1, w)).toBe(0)
    expect(dOf(0.9, w)).toBe(1)
    // A degenerate window is a division this must not turn into Infinity.
    expect(dOf(0.5, { cosFloor: 0.3, cosCeil: 0.3 })).toBe(1)
  })

  it('the inherited window leaves no tau that gate.js would accept', () => {
    const legacy = regate(rows, { cosFloor: 0.44, cosCeil: 0.64 }, guard)
    const best = chooseTau(TAU_STEPS.map((t) => sweepRow(legacy, t, 'G')))
    // Feasible in the sweep's own terms, and unshippable: RAG-SPEC 3.4.4 has
    // gate.js throw at init unless wLexical < tau.
    expect(best.tau).toBeLessThanOrEqual(guard.wLexical)
    expect(() => assertWeights({ tau: best.tau, wLexical: guard.wLexical })).toThrow()
  })

  it('and the sweep finds one that is', () => {
    const found = chooseWindow(rows, guard)
    expect(found).not.toBeNull()
    expect(found.best.tau).toBeGreaterThan(guard.wLexical)
    expect(() => assertWeights({ tau: found.best.tau, wLexical: guard.wLexical })).not.toThrow()
    expect(WINDOWS).toContainEqual(found.window)
  })

  it('every window it will consider clears the step-5 floor', () => {
    const found = chooseWindow(rows, guard)
    for (const s of found.shortlist) {
      expect(s.blatant).toBeGreaterThanOrEqual(0.8)
      expect(s.tau).toBeGreaterThan(guard.wLexical)
    }
    // Non-degenerate when the grid offers one: a window narrower than the spread
    // it maps is a step function on the raw cosine wearing a score's clothes.
    expect(found.rampShare).toBeGreaterThanOrEqual(0.33)
  })

  it('returns null rather than a window, when no window separates the corpus', () => {
    // Positives and negatives at the same cosine: no floor and no ceiling can
    // put a threshold between them, and that is an answer about the embedder.
    const flat = [...many('U', 130, 0.5), ...many('N4', 20, 0.5)]
    expect(chooseWindow(flat, guard)).toBeNull()
  })

  it('regate takes the composed channel only when it is admissible AND higher', () => {
    const better = row('a', 'U', 0.3, { z_composed: 0.9, L_composed: 0, admissible: true })
    const inadmissible = row('b', 'U', 0.3, { z_composed: 0.9, L_composed: 0, admissible: false })
    const worse = row('c', 'U', 0.9, { z_composed: 0.3, L_composed: 0, admissible: true })
    const w = { cosFloor: 0.2, cosCeil: 0.8 }
    const [x, y, z] = regate([better, inadmissible, worse], w, guard)
    expect(x.channel).toBe('composed')
    expect(y.channel).toBe('raw')
    expect(z.channel).toBe('raw')
    // The raw channel's own G is kept beside the winner — the report reads it.
    expect(x.G_raw).toBeCloseTo(0.75 * dOf(0.3, w), 10)
  })

  it('leaves a pre-window cache line exactly as it was measured', () => {
    // RAW_SCHEMA is bumped so this should not happen; if it ever does, handing
    // back an unswept row unchanged is the honest outcome, not a silent zero.
    const old = { id: 'legacy', stratum: 'U', G: 0.61, D: 0.5, L: 0.1, channel: 'raw' }
    expect(regate([old], { cosFloor: 0.2, cosCeil: 0.8 }, guard)[0]).toEqual(old)
  })
})

/**
 * Every literal below is synthetic. A test fixture is committed text, and a
 * committed key is a leaked key — which is the exact failure this module exists
 * to stop, so it may not be reproduced here to prove the point.
 */
describe('credentials — the host-side test that runs before the embedder', () => {
  const HEX64 = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'beef1234'
  const OPENROUTER = `sk-or-v1-${HEX64}`

  it('catches the prefixed API key shape and replaces the whole span', () => {
    const { clean, count, kinds } = redactSecrets(`вот мой ключ, куда его вставить? - ${OPENROUTER}`)
    expect(count).toBe(1)
    expect(kinds).toEqual(['api-key'])
    expect(clean).toBe(`вот мой ключ, куда его вставить? - ${MASK}`)
  })

  // The hex rule would otherwise claim the tail of a key the api-key rule
  // already owns, and a half-redacted key on screen is a leaked key.
  it('leaves no fragment when two rules overlap the same span', () => {
    const { clean } = redactSecrets(OPENROUTER)
    expect(clean).toBe(MASK)
    expect(clean).not.toMatch(/[a-f0-9]{8}/)
  })

  it('catches a bare hex digest, a JWT, a Bearer header and an AWS key id', () => {
    expect(hasSecret('secretKey: 0123456789abcdef0123456789abcdef')).toBe(true)
    expect(hasSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r')).toBe(true)
    expect(hasSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(true)
    expect(hasSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    expect(hasSecret('ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1')).toBe(true)
  })

  // The corpus is full of these. Firing on them would put a credential warning
  // in front of the most ordinary question the panel gets.
  it('does not fire on the placeholders the documentation itself uses', () => {
    for (const q of [
      'where do I put YOUR_SECRET_KEY?',
      'what is the difference between PLUGIN_ID and SECRET_KEY?',
      'the sample shows "secretKey": "YOUR_SECRET_KEY" — is that literal?',
      'how do I pass secretKey to initEditor?',
    ]) {
      expect(hasSecret(q)).toBe(false)
    }
  })

  // Deliberate: a pluginId is a UUID, and so is every template, message and
  // account id a reader legitimately pastes. See the note in credentials.js.
  it('does not fire on a bare UUID', () => {
    expect(hasSecret('template 3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d does not open')).toBe(false)
  })

  it('does not fire on ordinary prose, however long the words', () => {
    expect(hasSecret('how do I configure the AMP validation service for my account?')).toBe(false)
    expect(hasSecret('')).toBe(false)
  })

  // askWithoutSecret re-enters through submit(), so the second pass must be a
  // no-op or the reader gets the same warning forever.
  it('is idempotent — the mask is not itself a credential shape', () => {
    const once = redactSecrets(`куда вставить ${OPENROUTER}?`).clean
    const twice = redactSecrets(once)
    expect(twice.count).toBe(0)
    expect(twice.clean).toBe(once)
  })

  it('redacts every occurrence, not just the first', () => {
    const { count, clean } = redactSecrets(`old ${OPENROUTER} new sk-proj-${HEX64}`)
    expect(count).toBe(2)
    expect(clean).toBe(`old ${MASK} new ${MASK}`)
  })

  it('reports offsets into the original string', () => {
    const hits = findSecrets(`key: ${OPENROUTER}`)
    expect(hits).toHaveLength(1)
    expect(hits[0].start).toBe(5)
    expect(hits[0].end).toBe(5 + OPENROUTER.length)
  })

  // Keyed by SUBTAG, not by the detector's own language name: that is the key
  // space VitePress `locales` uses, so one `ru` override block covers both the
  // panel chrome and this reply. `localeOf` is the bridge between the two.
  it('writes the warning in the language of the question, English when unsure', () => {
    expect(credentialCopy('ru').lead).toBe('Не вставляйте сюда ключи и токены.')
    expect(credentialCopy('uk').action).toBe('Відповісти на запитання без ключа')
    expect(credentialCopy(null)).toBe(credentialCopy('en'))
    expect(credentialCopy('tlh')).toBe(credentialCopy('en'))
    expect(credentialCopy(localeOf('Russian'))).toBe(credentialCopy('ru'))
  })

  it('has all three strings for every language it claims to speak', () => {
    for (const lang of CREDENTIAL_LANGUAGES) {
      const c = credentialCopy(lang)
      for (const key of ['lead', 'body', 'action']) {
        expect(typeof c[key], `${lang}.${key}`).toBe('string')
        expect(c[key].trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
      // The body carries the whole explanation — the key went nowhere, and here
      // is what to do about the one that did — so it is the long string of the
      // three in every language, including the ones that write it in 61
      // characters.
      expect(c.body.length, lang).toBeGreaterThan(c.lead.length + c.action.length)
    }
  })

  // The detector is only reachable for languages the directive detector names.
  it('speaks every language detectLanguage can return', () => {
    for (const [q, lang] of [
      ['как вставить ключ', 'Russian'],
      // Needs a letter Russian does not have; the script detector has no other
      // signal, so a Ukrainian question written without one reads as Russian.
      ['куди вставити ключ і токен', 'Ukrainian'],
      ['wie füge ich den Schlüssel ein', 'German'],
      ['キーを貼り付ける方法', 'Japanese'],
    ]) {
      expect(detectLanguage(q)).toBe(lang)
      expect(CREDENTIAL_LANGUAGES).toContain(localeOf(lang))
    }
  })
})

describe('empty-state suggestions — configured, with the built-in three as fallback', () => {
  const docPilot = (suggestions) => ({
    enabled: true,
    chat: { provider: 'ollama', model: 'qwen3:8b', temperature: 0.2 },
    embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
    topK: 12,
    maxIterations: 2,
    prompt: { show: false, allowAppend: false, override: null, extend: '' },
    suggestions,
  })
  const quiet = () => {}
  const collect = () => {
    const out = []
    const fn = (m) => out.push(m)
    fn.messages = out
    return fn
  }

  // The regression this whole change exists for: the key was documented in
  // UI-SPEC §13 and read by DocPilot.vue, but never put in the client object, so
  // the built-in fallback was the only branch that could run.
  it('reaches the client config at all', () => {
    expect(themeDocPilot(docPilot(['One?', 'Two?'])).suggestions).toEqual(['One?', 'Two?'])
  })

  it('falls back to the built-in three by returning empty, for [] and for absent', () => {
    expect(resolveSuggestions(docPilot([]), quiet)).toEqual([])
    expect(resolveSuggestions(docPilot(undefined), quiet)).toEqual([])
    expect(resolveSuggestions(docPilot(null), quiet)).toEqual([])
  })

  it('trims, collapses inner whitespace and drops empties and repeats', () => {
    const w = collect()
    expect(resolveSuggestions(docPilot(['  How   do I auth? ', 'How do I auth?', '   ', 'Real?']), w)).toEqual([
      'How do I auth?',
      'Real?',
    ])
    expect(w.messages.join(' ')).toMatch(/empty/)
    expect(w.messages.join(' ')).toMatch(/repeats/)
  })

  it('drops a non-string entry instead of rendering [object Object]', () => {
    const w = collect()
    expect(resolveSuggestions(docPilot(['ok?', { label: 'x', question: 'y' }, 42]), w)).toEqual(['ok?'])
    expect(w.messages).toHaveLength(2)
  })

  it('falls back when the key is not an array at all', () => {
    const w = collect()
    expect(resolveSuggestions(docPilot('How do I auth?'), w)).toEqual([])
    expect(w.messages[0]).toMatch(/must be an array/)
  })

  // "No silent caps" — the component slices at three either way; what is being
  // tested is that the author is told which two vanished.
  it('caps at three and names what it dropped', () => {
    const w = collect()
    const five = ['a?', 'b?', 'c?', 'd?', 'e?']
    expect(resolveSuggestions(docPilot(five), w)).toEqual(['a?', 'b?', 'c?'])
    expect(w.messages[0]).toContain('"d?"')
    expect(w.messages[0]).toContain('"e?"')
  })
})

/**
 * `resolveUi` is called from three places — the build, the client store and two
 * components — and the whole reason it exists is that all three must agree. So
 * the properties asserted here are the ones the arrangement rests on: `'auto'`
 * is resolved exactly once, a resolved value survives a second pass unchanged,
 * and nothing outside the enum can reach a consumer.
 */
describe('resolveUi — trigger placement and panel shape', () => {
  const collect = () => {
    const out = []
    const fn = (m, v) => out.push(`${m} ${JSON.stringify(v)}`)
    fn.messages = out
    return fn
  }

  it('defaults to the navbar trigger and the drawer', () => {
    const err = collect()
    const expected = {
      trigger: 'nav',
      panel: 'drawer',
      showNavTrigger: true,
      showFab: false,
      fabLabel: true,
      fabIcon: true,
    }
    // Every shape a caller can hand it: absent settings, absent `ui`, an
    // explicit null. `session.configure` sees all three, because the
    // `{enabled: false}` payload carries no `ui` at all.
    for (const cfg of [undefined, null, {}, { ui: null }, { ui: {} }]) {
      expect(resolveUi(cfg, err)).toEqual(expected)
    }
    expect(err.messages).toEqual([])
  })

  it('resolves `auto` from the trigger, in both directions', () => {
    expect(resolveUi({ ui: { trigger: 'fab' } }).panel).toBe('popup')
    expect(resolveUi({ ui: { trigger: 'nav' } }).panel).toBe('drawer')
    // Spelling the default out loud must not change what it resolves to.
    expect(resolveUi({ ui: { trigger: 'fab', panel: 'auto' } }).panel).toBe('popup')
    expect(resolveUi({ ui: UI_DEFAULTS })).toEqual(resolveUi({}))
  })

  it('carries out the explicit combinations in silence', () => {
    const err = collect()
    expect(resolveUi({ ui: { trigger: 'nav', panel: 'popup' } }, err)).toEqual({
      trigger: 'nav',
      panel: 'popup',
      showNavTrigger: true,
      showFab: false,
      fabLabel: true,
      fabIcon: true,
    })
    expect(resolveUi({ ui: { trigger: 'fab', panel: 'drawer' } }, err)).toEqual({
      trigger: 'fab',
      panel: 'drawer',
      showNavTrigger: false,
      showFab: true,
      fabLabel: true,
      fabIcon: true,
    })
    expect(err.messages).toEqual([])
  })

  /**
   * The floating button's two halves — ui-specs/005.
   *
   * `fabLabel` is the one setting in this resolver that is a UNION rather than
   * an enum, so the cases it has to separate are: absent, on, off, and words.
   */
  it('resolves the floating button label and icon', () => {
    const err = collect()
    const fab = (ui) => resolveUi({ ui: { trigger: 'fab', ...ui } }, err)

    expect(fab({})).toMatchObject({ fabLabel: true, fabIcon: true })
    expect(fab({ fabLabel: false })).toMatchObject({ fabLabel: false, fabIcon: true })
    expect(fab({ fabIcon: false })).toMatchObject({ fabLabel: true, fabIcon: false })
    // A string is the words themselves and is taken verbatim — never looked up.
    expect(fab({ fabLabel: 'Спросить ИИ' }).fabLabel).toBe('Спросить ИИ')
    // Blank is the same as absent-on-purpose: a label made of spaces is a label
    // the author deleted without saying so.
    expect(fab({ fabLabel: '   ' }).fabLabel).toBe(false)
    expect(err.messages).toEqual([])
  })

  // The one combination with no rendering. A cosmetic setting must never be
  // able to make the panel unopenable, so this is corrected rather than obeyed.
  it('refuses to leave the floating button with nothing on it', () => {
    const err = collect()
    expect(resolveUi({ ui: { trigger: 'fab', fabIcon: false, fabLabel: false } }, err)).toMatchObject({
      fabIcon: true,
      fabLabel: false,
    })
    expect(err.messages).toHaveLength(1)
    expect(err.messages[0]).toContain('cannot both be off')
  })

  it('reports a label that is neither a boolean nor a string', () => {
    const err = collect()
    expect(resolveUi({ ui: { fabLabel: 42 } }, err).fabLabel).toBe(true)
    expect(err.messages).toHaveLength(1)
    expect(err.messages[0]).toContain('ui.fabLabel')
  })

  it('reports a value outside the enum and falls back', () => {
    const err = collect()
    // The panel still resolves off the trigger that WAS given: a typo in one
    // key must not quietly undo the other.
    expect(resolveUi({ ui: { trigger: 'fab', panel: 'modal' } }, err)).toMatchObject({
      trigger: 'fab',
      panel: 'popup',
    })
    expect(resolveUi({ ui: { trigger: 'sidebar' } }, err)).toMatchObject({
      trigger: 'nav',
      panel: 'drawer',
    })
    expect(err.messages).toHaveLength(2)
    expect(err.messages[0]).toContain('ui.panel')
    expect(err.messages[0]).toContain('"modal"')
    expect(err.messages[1]).toContain('ui.trigger')
  })

  // The property the two-sided call depends on: the build resolves and emits
  // under the same key, the browser resolves what it received. If a resolved
  // member were not itself legal input, the second pass would rewrite it.
  it('is idempotent across the build/browser round trip', () => {
    for (const trigger of [undefined, 'nav', 'fab']) {
      for (const panel of [undefined, 'auto', 'drawer', 'popup']) {
        // Every resolved value of the union is itself legal input, which is what
        // makes the second pass a no-op rather than a rewrite.
        for (const fabLabel of [undefined, true, false, 'Ask AI']) {
          for (const fabIcon of [undefined, true, false]) {
            const once = resolveUi({ ui: { trigger, panel, fabLabel, fabIcon } }, () => {})
            expect(resolveUi({ ui: once }), `${trigger}/${panel}/${fabLabel}/${fabIcon}`).toEqual(once)
          }
        }
      }
    }
  })
})

/**
 * One shortcut, however many triggers are on the page.
 *
 * `docPilotSlots()` mounts two `DocPilotTrigger`s today and three once the floating
 * button exists, and each one used to add its own `keydown` listener — two
 * listeners toggle the panel twice, which reads as the key doing nothing. The
 * counting is asserted here rather than through a mounted component, because
 * what is being tested is the counter, not Vue.
 */
describe('hotkey — one listener behind a reference count', () => {
  const fakeWindow = () => ({
    added: [],
    addEventListener(type, fn) {
      this.added.push(fn)
    },
    removeEventListener(type, fn) {
      this.added = this.added.filter((f) => f !== fn)
    },
  })

  it('binds once for many mounts and releases on the last unmount', () => {
    const w = fakeWindow()
    const fired = []
    bindHotkey(() => fired.push(1), w)
    bindHotkey(() => fired.push(2), w)
    bindHotkey(() => fired.push(3), w)
    expect(w.added).toHaveLength(1)
    expect(hotkeyRefCount()).toBe(3)

    // Whichever callback won, the key fires exactly once per press.
    w.added[0]({ metaKey: true, key: 'I', preventDefault() {} })
    expect(fired).toHaveLength(1)

    unbindHotkey()
    unbindHotkey()
    expect(w.added).toHaveLength(1) // still one trigger alive
    unbindHotkey()
    expect(w.added).toHaveLength(0)
    expect(hotkeyRefCount()).toBe(0)
  })

  it('ignores an unmatched release rather than going negative', () => {
    const w = fakeWindow()
    unbindHotkey()
    unbindHotkey()
    expect(hotkeyRefCount()).toBe(0)
    // The next mount still gets a listener — this is the HMR case, where the
    // count going to -2 would leave the shortcut dead until a full reload.
    bindHotkey(() => {}, w)
    expect(w.added).toHaveLength(1)
    unbindHotkey()
  })

  it('fires on Cmd or Ctrl and on nothing else', () => {
    const w = fakeWindow()
    const fired = []
    bindHotkey(() => fired.push(1), w)
    const press = (e) => w.added[0]({ preventDefault() {}, ...e })
    press({ metaKey: true, key: 'i' })
    press({ ctrlKey: true, key: 'I' })
    expect(fired).toHaveLength(2)
    press({ key: 'i' })
    press({ metaKey: true, key: 'k' })
    press({ metaKey: true })
    expect(fired).toHaveLength(2)
    unbindHotkey()
  })
})

/**
 * The setting's whole path: settings object → merger → emitter → browser.
 *
 * Each hop has a different job and the suite pins which is which. The merger
 * fills defaults and keeps `'auto'` — resolving there would make the resolved
 * shape the input of the next merge. The emitter resolves, because the build is
 * where a bad value should be complained about. The browser resolves again,
 * because one reachable payload never went through the emitter at all.
 */
describe('ui — from settings to the browser', () => {
  // FIRST, deliberately: nothing else in this file touches the session store,
  // so this is the only place `state.config` is still the module's own
  // DEFAULTS. It is what the panel runs on between import and `configure`.
  it('starts the client on a RESOLVED default, not on `auto`', () => {
    expect(sessionState.config.ui).toEqual(resolveUi({}))
  })

  it('merges but does not resolve — `auto` survives resolveDocPilot', () => {
    expect(resolveDocPilot({}).ui).toEqual(UI_DEFAULTS)
    // Half an object in, a whole one out: the key the author left alone keeps
    // its default instead of vanishing.
    expect(resolveDocPilot({ ui: { trigger: 'fab' } }).ui).toEqual({
      trigger: 'fab',
      panel: 'auto',
      fabLabel: true,
      fabIcon: true,
    })
  })

  it('emits the resolved structure, so no component re-derives it', () => {
    expect(themeDocPilot(resolveDocPilot({})).ui).toEqual({
      trigger: 'nav',
      panel: 'drawer',
      showNavTrigger: true,
      showFab: false,
      fabLabel: true,
      fabIcon: true,
    })
    expect(themeDocPilot(resolveDocPilot({ ui: { trigger: 'fab', fabLabel: 'Ask AI' } })).ui).toEqual({
      trigger: 'fab',
      panel: 'popup',
      showNavTrigger: false,
      showFab: true,
      fabLabel: 'Ask AI',
      fabIcon: true,
    })
  })

  it('reaches the client through configure', () => {
    configure({ docPilot: themeDocPilot(resolveDocPilot({ ui: { trigger: 'fab', panel: 'drawer' } })) })
    expect(sessionState.config.ui).toEqual({
      trigger: 'fab',
      panel: 'drawer',
      showNavTrigger: false,
      showFab: true,
      fabLabel: true,
      fabIcon: true,
    })
  })

  // src/index.js sends `{enabled: false}` and nothing else when the panel is
  // off. That payload never met `themeDocPilot`, so it carries no `ui` — and a
  // spread-based merge would leave the client reading `undefined.showFab`.
  it('leaves the disabled payload on the client defaults', () => {
    configure({ docPilot: { enabled: false } })
    expect(sessionState.config.enabled).toBe(false)
    expect(sessionState.config.ui).toEqual(resolveUi({}))
  })
})

/**
 * The whole class of bug the `suggestions` suite above is one instance of.
 *
 * A setting is added to DEFAULTS, documented, read by the panel — and never put
 * into the object the panel actually receives. Nothing throws, nothing warns,
 * and the built-in default is the only branch that can ever run. It had shipped
 * three more times than anyone noticed: `feedbackEndpoint`, `guard` and `scope`
 * were all read by session.js and all absent from themeDocPilot.
 *
 * So the rule is asserted instead of remembered: every key either reaches the
 * client or is named in SERVER_ONLY. Adding a setting without doing one of the
 * two fails here.
 */
describe('themeDocPilot — the client half is complete by construction', () => {
  // `chat` is the one setting that crosses under a different name: the browser
  // knows adapters and transports, not which brand answers.
  const RENAMED = { chat: 'llm' }
  const emitted = themeDocPilot(resolveDocPilot({}))

  it('emits every top-level setting that is not explicitly server-only', () => {
    const unreachable = Object.keys(DEFAULTS).filter(
      (k) => !SERVER_ONLY.includes(k) && !Object.hasOwn(emitted, RENAMED[k] ?? k),
    )
    expect(unreachable).toEqual([])
  })

  it('withholds every server-only setting — a key, not an oversight', () => {
    for (const k of SERVER_ONLY) expect(Object.hasOwn(emitted, k)).toBe(false)
  })

  it('carries every nested key of chat, prompt, guard and scope', () => {
    for (const [from, to] of [
      ['chat', 'llm'],
      ['prompt', 'prompt'],
      ['guard', 'guard'],
      ['scope', 'scope'],
      ['ui', 'ui'],
      ['history', 'history'],
      ['feedback', 'feedback'],
    ]) {
      for (const k of Object.keys(DEFAULTS[from])) {
        expect(Object.hasOwn(emitted[to], k), `${from}.${k}`).toBe(true)
      }
    }
  })

  it('passes configured values through, not just the key names', () => {
    const out = themeDocPilot(
      resolveDocPilot({
        feedbackEndpoint: 'https://example.com/vote',
        guard: { tau: 0.42 },
        scope: { enabled: false },
        chat: { numCtx: 16384 },
      }),
    )
    expect(out.feedbackEndpoint).toBe('https://example.com/vote')
    expect(out.guard.tau).toBe(0.42)
    // The half the reader did not set keeps its default rather than vanishing.
    expect(out.guard.supportMinIdentifiers).toBe(3)
    expect(out.scope.enabled).toBe(false)
    expect(out.llm.numCtx).toBe(16384)
  })
})

/**
 * The production proxy contract — the same paths the browser actually posts to.
 *
 * `proxyContract` is read by a human building an nginx or Caddy config, and the
 * notes tell that human to match the paths EXACTLY. So a path here that the
 * adapter does not use is not a cosmetic defect: it is a 404 on every question,
 * in production only, on a configuration that passed `vitepress dev` — the dev
 * proxy matches `/ai` by prefix and covers the mistake.
 *
 * It shipped that way for Anthropic: the contract said `/ai/v1/chat/completions`
 * and the adapter posts to `/ai/v1/messages`. Two copies of one fact, so the
 * copy is gone — the contract asks the adapter — and this pins the two together
 * for every provider rather than for the one that was noticed.
 */
describe('proxy contract — paths come from the adapters, not a second list', () => {
  const env = {
    OPENAI_API_KEY: 'k',
    ANTHROPIC_API_KEY: 'k',
    GEMINI_API_KEY: 'k',
    GROQ_API_KEY: 'k',
    OPENROUTER_API_KEY: 'k',
  }

  const contractFor = (chat, embed) =>
    proxyContract(resolveDocPilot({ chat: { provider: chat, model: 'm' }, embed }, env), env)

  it.each([
    ['openai', undefined],
    ['gemini', undefined],
    ['anthropic', { provider: 'openai', model: 'text-embedding-3-small' }],
    ['groq', { provider: 'openai', model: 'text-embedding-3-small' }],
    ['openrouter', { provider: 'openai', model: 'text-embedding-3-small' }],
  ])('%s: the chat path is the one the adapter posts to', (chat, embed) => {
    const client = themeDocPilot(
      resolveDocPilot({ chat: { provider: chat, model: 'm' }, embed }, env),
      env,
    )
    const adapter = providerFor(client.llm.provider)
    const paths = contractFor(chat, embed).routes.map((r) => r.path)
    expect(paths).toContain(adapter.chatUrl(client.llm.baseURL))
  })

  it('the embeddings path is the one the embed adapter posts to', () => {
    const docPilot = resolveDocPilot({ chat: { provider: 'openai', model: 'm' } }, env)
    const client = themeDocPilot(docPilot, env)
    const adapter = providerFor(client.embed.provider)
    expect(proxyContract(docPilot, env).routes.map((r) => r.path)).toContain(
      adapter.embedUrl(client.embed.baseURL),
    )
  })

  it('rewrites onto the upstream path the provider actually serves', () => {
    const split = { provider: 'openai', model: 'text-embedding-3-small' }
    const contract = contractFor('anthropic', split)
    const [embed, chat] = contract.routes
    expect(embed.upstream + embed.rewrite).toBe('https://api.openai.com/v1/embeddings')
    expect(chat.upstream + chat.rewrite).toBe('https://api.anthropic.com/v1/messages')
    // The header NAME is printed so a config can attach it; the value never is.
    expect(chat.header).toBe('x-api-key')
    expect(chat.envKey).toBe('ANTHROPIC_API_KEY')
    // The key VALUE is 'k' in this env and appears nowhere in what is printed.
    expect(JSON.stringify(contract).split('"').includes('k')).toBe(false)
  })

  it('a fully local setup has nothing to proxy', () => {
    expect(contractFor('ollama').routes).toEqual([])
  })
})

/**
 * External provenance — the allowlist.
 *
 * This is a security boundary, not a convenience. A `source:` value travels into
 * `manifest.pages[].origin`, into `sourceRow()`, and out as an `href` rendered
 * inside the answer panel — so a hand-written `javascript:…` in any markdown
 * file in the repository would be stored XSS if the only gate were the tool that
 * happened to write that file.
 */
describe('external provenance — the allowlist', () => {
  const listOf = (...allow) => parseAllowlist({ allow }).entries

  it('admits only https, by allowlist rather than by denylist', () => {
    const ok = listOf('https://example.com')
    expect(checkSource('https://example.com/a', ok).href).toBe('https://example.com/a')
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'http://example.com/a',
      'vbscript:msgbox',
    ]) {
      expect(checkSource(bad, ok).error, bad).toBeTruthy()
    }
  })

  it('narrows to a path prefix at a SEGMENT boundary, not a string one', () => {
    const scoped = listOf('https://example.com/docs')
    expect(checkSource('https://example.com/docs', scoped).href).toBeTruthy()
    expect(checkSource('https://example.com/docs/guide', scoped).href).toBeTruthy()
    // `/docsecret` starts with `/docs` and is a different place entirely.
    expect(checkSource('https://example.com/docsecret', scoped).error).toBeTruthy()
    expect(checkSource('https://example.com/other', scoped).error).toBeTruthy()
  })

  it('compares ORIGINS, which is what defeats a look-alike host', () => {
    const ok = listOf('https://example.com')
    expect(checkSource('https://example.com.evil.test/a', ok).error).toBeTruthy()
    // userinfo: the URL parser reads the host as evil.test, and so does this.
    expect(checkSource('https://example.com@evil.test/a', ok).error).toBeTruthy()
    expect(checkSource('https://evil.test/?x=https://example.com', ok).error).toBeTruthy()
  })

  it('absent is legal and empty is not the same as absent', () => {
    // A repo with nothing imported needs no list at all…
    expect(parseAllowlist(undefined)).toEqual({ entries: [], errors: [] })
    expect(parseAllowlist(null)).toEqual({ entries: [], errors: [] })
    // …but a page that declares a source with no list is a page whose citation
    // would point somewhere nobody approved.
    expect(checkSource('https://example.com/a', []).error).toBeTruthy()
  })

  it('names every malformed entry rather than silently allowing nothing', () => {
    expect(parseAllowlist({ allow: 'https://example.com' }).errors).toHaveLength(1)
    expect(parseAllowlist({}).errors).toHaveLength(1)
    const errors = parseAllowlist({
      allow: ['not a url', 'http://example.com', 'https://example.com/?q=1'],
    }).errors
    expect(errors).toHaveLength(3)
    expect(errors.join(' ')).toMatch(/query or fragment/)
  })
})

/**
 * The llms.txt sidebar workaround. Its first version silently did nothing —
 * it walked a multi-sidebar as if it were a group, found no `link` and no
 * `items`, and returned the object untouched — so both shapes are tested.
 */
describe('absoluteSidebar', () => {
  it('prefixes a relative link with its group base and drops the base', () => {
    const out = absoluteSidebar([
      { text: 'Guide', base: '/guide/', items: [{ text: 'Start', link: 'start' }] },
    ])
    expect(out[0].items[0].link).toBe('/guide/start')
    expect(out[0].base).toBeUndefined()
  })

  it('walks a MULTI-sidebar, keyed by route prefix', () => {
    const out = absoluteSidebar({
      '/guide/': [{ base: '/guide/', items: [{ text: 'A', link: 'a' }] }],
      '/ref/': [{ base: '/ref/', items: [{ text: 'B', link: 'b' }] }],
    })
    expect(out['/guide/'][0].items[0].link).toBe('/guide/a')
    expect(out['/ref/'][0].items[0].link).toBe('/ref/b')
  })

  it('leaves an already-absolute link alone and inherits a base down the tree', () => {
    const out = absoluteSidebar([
      {
        base: '/guide/',
        items: [
          { text: 'Abs', link: '/elsewhere' },
          { text: 'Nested', items: [{ text: 'Deep', link: 'deep' }] },
        ],
      },
    ])
    expect(out[0].items[0].link).toBe('/elsewhere')
    expect(out[0].items[1].items[0].link).toBe('/guide/deep')
  })

  it('does not mutate the object VitePress renders from', () => {
    const input = [{ base: '/guide/', items: [{ text: 'A', link: 'a' }] }]
    absoluteSidebar(input)
    expect(input[0].base).toBe('/guide/')
    expect(input[0].items[0].link).toBe('a')
  })
})

describe('config — sources and importDir', () => {
  it('assigns the allowlist whole; a half-merge would keep a deleted origin', () => {
    const resolved = resolveDocPilot({ sources: { allow: ['https://example.com'] } })
    expect(resolved.sources).toEqual({ allow: ['https://example.com'] })
    expect(resolveDocPilot({}).sources).toBeNull()
    expect(resolveDocPilot({}).importDir).toBeNull()
  })

  it('never sends the allowlist to the browser — the origin is baked into the index', () => {
    const out = themeDocPilot(resolveDocPilot({ sources: { allow: ['https://example.com'] } }))
    expect(Object.hasOwn(out, 'sources')).toBe(false)
    expect(JSON.stringify(out)).not.toContain('example.com')
  })

  it('readiness reports a malformed allowlist, because `docpilot index` will die on it', () => {
    const r = readiness(resolveDocPilot({ sources: { allow: ['http://example.com'] } }), {})
    expect(r.ok).toBe(false)
    expect(r.missing.some((m) => /allowlist/.test(m.what))).toBe(true)
  })

  it('a missing importDir is a note, not a blocker — every published page still answers', () => {
    const r = readiness(resolveDocPilot({ importDir: 'no-such-dir-here' }), {})
    expect(r.notes.join(' ')).toMatch(/no-such-dir-here/)
    expect(r.missing.some((m) => /no-such-dir-here/.test(m.what))).toBe(false)
  })
})

describe('external provenance — the frontmatter contract', () => {
  const page = (fm, body = '# Title\n\nSome text.') => `---\n${fm}\n---\n\n${body}`

  it('reads `source:` only at column 0 — a nested key belongs to its own key', () => {
    expect(normaliseMarkdown(page('title: T\nsource: https://example.com/a')).source).toBe(
      'https://example.com/a',
    )
    expect(normaliseMarkdown(page('title: T\nhead:\n  source: https://example.com/a')).source).toBeNull()
  })

  it('rides out of the chunker unvalidated, on both return paths', () => {
    const withText = chunkMarkdown({
      src: page('title: T\nsource: https://example.com/a'),
      path: '/p',
      kind: 'guide',
    })
    expect(withText.source).toBe('https://example.com/a')
    expect(withText.chunks.length).toBeGreaterThan(0)

    // `layout: home` returns early with no chunks, and provenance is a property
    // of the page rather than of any chunk — so it still has to come back.
    const home = chunkMarkdown({
      src: page('title: T\nlayout: home\nsource: https://example.com/a'),
      path: '/',
      kind: 'guide',
    })
    expect(home.chunks).toEqual([])
    expect(home.source).toBe('https://example.com/a')
  })

  it('is absent, not undefined-shaped, on a page that declares nothing', () => {
    expect(normaliseMarkdown('# Plain\n\ntext').source).toBeNull()
    expect(chunkMarkdown({ src: '# Plain\n\ntext', path: '/p', kind: 'guide' }).source).toBeNull()
  })
})

/**
 * The i18n layer.
 *
 * The rule the whole design rests on: overriding ONE string keeps the other
 * eighty. A shape that replaced a block wholesale would make translating a
 * button label silently delete every sibling label.
 */
describe('i18n — merge and fallback', () => {
  const tree = (i18n) => resolveI18n(validateI18n(i18n, () => {}))
  const T = (i18n, locale, path, vars, ui) => t(tree(i18n), locale, path, vars, ui)

  it('falls through to the shipped default when nothing is configured', () => {
    expect(T({}, 'en', 'empty.heading')).toBe('How can I help you today?')
    expect(T({}, 'ru', 'empty.heading')).toBe('How can I help you today?')
  })

  it('a locale block beats the root, and the root beats the shipped default', () => {
    const i18n = {
      translations: { empty: { heading: 'Root heading' } },
      locales: { ru: { translations: { empty: { heading: 'Заголовок' } } } },
    }
    expect(T(i18n, 'ru', 'empty.heading')).toBe('Заголовок')
    expect(T(i18n, 'de', 'empty.heading')).toBe('Root heading')
  })

  it('merges per LEAF — one override does not delete its siblings', () => {
    const i18n = { locales: { ru: { translations: { panel: { close: 'Закрыть' } } } } }
    expect(T(i18n, 'ru', 'panel.close')).toBe('Закрыть')
    expect(T(i18n, 'ru', 'panel.newChat')).toBe('New chat')
    expect(T(i18n, 'ru', 'empty.heading')).toBe('How can I help you today?')
  })

  it('interpolates {name} and picks a plural form on {n, one|many}', () => {
    expect(T({}, 'en', 'refusal.searched', { scope: 'the docs' })).toBe('Searched the docs')
    expect(T({}, 'en', 'refusal.searchedAndRead', { scope: 'the docs', n: 1 })).toBe(
      'Searched the docs and read 1 page',
    )
    expect(T({}, 'en', 'refusal.searchedAndRead', { scope: 'the docs', n: 4 })).toBe(
      'Searched the docs and read 4 pages',
    )
    // A slot with no value is left as written rather than rendered "undefined".
    expect(T({}, 'en', 'refusal.searched')).toBe('Searched {scope}')
  })

  it('normalises a regional tag onto the subtag the tree is keyed by', () => {
    expect(normaliseLocale('ru-RU', tree({}))).toBe('ru')
    expect(normaliseLocale('en-US', tree({}))).toBe('en')
    // A locale nobody ships and nobody configured is English, never empty.
    expect(normaliseLocale('cy-GB', tree({}))).toBe('en')
    // …unless it IS configured, in which case it is real.
    expect(normaliseLocale('cy', tree({ locales: { cy: { translations: {} } } }))).toBe('cy')
  })

  it('drops a key that is not a key, and says which one', () => {
    const warnings = []
    const out = validateI18n(
      { translations: { empty: { headng: 'typo' }, panel: { close: 'Close!' } } },
      (m) => warnings.push(m),
    )
    expect(out.translations.panel.close).toBe('Close!')
    expect(out.translations.empty).toBeUndefined()
    expect(warnings.join(' ')).toContain('empty.headng')
  })

  it('drops a non-string leaf rather than rendering [object Object]', () => {
    const warnings = []
    const out = validateI18n({ translations: { panel: { close: 42 } } }, (m) => warnings.push(m))
    expect(out.translations.panel?.close).toBeUndefined()
    expect(warnings.join(' ')).toMatch(/not a string/)
  })

  it('reaches the client half through themeDocPilot, validated', () => {
    const out = themeDocPilot(
      resolveDocPilot({
        i18n: { locales: { ru: { translations: { panel: { close: 'Закрыть' }, nope: 'x' } } } },
      }),
    )
    expect(out.i18n.locales.ru.translations.panel.close).toBe('Закрыть')
    expect(out.i18n.locales.ru.translations.nope).toBeUndefined()
  })

  it('deep-merges the option itself, so translations and locales coexist', () => {
    const r = resolveDocPilot({ i18n: { locales: { ru: { translations: {} } } } })
    expect(r.i18n.translations).toEqual({})
    expect(r.i18n.locales.ru).toBeDefined()
  })
})

/**
 * The gate that keeps the key table honest as the panel changes.
 *
 * Two ways this decays, both silent: a `T('…')` whose path does not exist
 * renders an empty string, and a new label written as a literal is simply never
 * translatable. Both are invisible in review and obvious here.
 */
describe('i18n — the components go through the table', () => {
  const FILES = [
    'src/theme/components/DocPilot.vue',
    'src/theme/components/DocPilotTrigger.vue',
    'src/theme/components/DocPilotCta.vue',
  ]
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

  it('every key the components ask for exists in the table', () => {
    for (const f of FILES) {
      for (const m of read(f).matchAll(/\bT\(\s*'([\w.-]+)'/g)) {
        expect(KEY_PATHS.has(m[1]), `${f}: ${m[1]}`).toBe(true)
      }
      // Template-literal paths — `reasons.${value}` — checked by their prefix.
      for (const m of read(f).matchAll(/\bT\(\s*`([\w.-]+)\$\{/g)) {
        expect([...KEY_PATHS].some((k) => k.startsWith(m[1])), `${f}: ${m[1]}*`).toBe(true)
      }
    }
  })

  it('no reader-facing string is left hard-coded in a component', () => {
    for (const f of FILES) {
      const src = read(f)
      // A STATIC aria-label is one nobody can translate.
      expect(src.match(/\saria-label="[^"{]/g) || [], f).toEqual([])
      // A bare text node between tags, outside a comment or an interpolation.
      const template = src.slice(0, src.indexOf('<script'))
      const stripped = template.replace(/<!--[\s\S]*?-->/g, '')
      expect(stripped.match(/>\s*[A-Z][a-z]+[^<{]*</g) || [], f).toEqual([])
    }
  })

  it('every shipped key is reachable — the table has no dead entries', () => {
    const used = new Set()
    for (const f of [...FILES, 'src/theme/docpilot/session.js']) {
      const src = read(f)
      // Any dotted path in a string literal, not only the ones written directly
      // as `T('…')` — half of them are inside a ternary: `T(cond ? 'a' : 'b')`.
      for (const m of src.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) used.add(m[1])
      for (const m of src.matchAll(/`([\w.-]+)\$\{/g)) used.add(m[1])
    }
    const unreachable = [...KEY_PATHS].filter(
      (k) =>
        !k.startsWith('reply.') && // read as blocks, from session.js
        !used.has(k) &&
        ![...used].some((u) => k.startsWith(u)),
    )
    expect(unreachable).toEqual([])
  })

  /**
   * Two rules moved out of `scripts/check-docpilot.sh`.
   *
   * They are the two worth running on every platform, and both were checked
   * there with `grep -P`, which BSD grep does not have — under a `2>/dev/null`
   * that turned the missing flag into a passing rule.
   */
  it('leaks no tool name, model id or threshold into the component', () => {
    const src = read('src/theme/components/DocPilot.vue')
    const surface = src.slice(0, src.indexOf('<style'))
    for (const token of [
      'search_docs',
      'fetch_section',
      'list_pages',
      'maxIterations',
      'qwen3',
      'threshold',
      'topK',
    ]) {
      expect(surface.includes(token), token).toBe(false)
    }
  })

  /**
   * The selection popover's contract — ui-specs/007.
   *
   * Every clause here is invisible to any other test in the suite: there is no
   * DOM in this environment, so the popover's tab position, its dismissal mode
   * and its capability probe can only be read off the source. Each one is a
   * decision that looks like a detail and is not.
   */
  it('keeps the selection popover’s contract', () => {
    const src = read('src/theme/components/DocPilot.vue')
    const template = src.slice(0, src.indexOf('<script'))

    // Between the thread and the composer, because THAT is the tab order: a
    // reader who selected inside the thread reaches "Ask AI" with one Tab.
    expect(template.indexOf('docpilot__ask')).toBeGreaterThan(template.indexOf('docpilot__thread'))
    expect(template.indexOf('docpilot__ask')).toBeLessThan(template.indexOf('docpilot__composer'))

    // `manual`, never `auto`: an auto popover light-dismisses on the pointerdown
    // that BEGINS the next selection, and Esc belongs to the cascade.
    expect(src).toContain("'manual'")
    expect(src).not.toContain('popover="auto"')

    // A capability probe, never a user-agent test.
    expect(src).toContain("'popover' in HTMLElement.prototype")

    // The turn a selection landed in is named on the node, not inferred from a
    // v-for index that reorders when a conversation is restored.
    expect(src).toContain(':data-turn="turn.id"')

    // Esc closes the popover FIRST, before any disclosure and before the panel.
    expect(src.match(/function onEsc\(\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(askOpen\.value\)/)).not.toBe(null)

    // Every re-submit path carries the quote. A retry that drops it re-runs a
    // question whose whole subject has gone missing, with no error attached.
    expect(src).toContain('submitText(turn.question, turn.quote)')
  })

  /**
   * The question row, the editor and the jump pill.
   *
   * Same reason as the popover's contract above: there is no DOM here, so tab
   * order, cascade position and the wiring between the component and
   * `session.editTurn` can only be read off the source. Each clause below is a
   * decision that a refactor would quietly undo.
   */
  it('keeps the question row’s contract', () => {
    const src = read('src/theme/components/DocPilot.vue')
    const template = src.slice(0, src.indexOf('<script'))

    // The row is UNDER the bubble, not above it: it acts on the question, and a
    // control above the thing it acts on reads as belonging to the turn before.
    expect(template.indexOf('docpilot__actions--ask')).toBeGreaterThan(
      template.indexOf('docpilot__question'),
    )

    // The pill is between the thread and the popover, so the popover keeps the
    // tab position ui-specs/007 gave it — one Tab from a selection in the thread.
    expect(template.indexOf('docpilot__jump-rail')).toBeGreaterThan(
      template.indexOf('docpilot__thread'),
    )
    expect(template.indexOf('docpilot__jump-rail')).toBeLessThan(template.indexOf('docpilot__ask'))

    // Hidden means out of the tab order, not merely faded: at the foot of the
    // thread "go to the foot of the thread" is not an action.
    expect(template).toContain(':tabindex="atBottom ? -1 : 0"')

    // Truncation goes through the session, which is the only place that can
    // stop a running turn and rewrite the archive together.
    expect(src).toContain('session.editTurn(turn, next)')
    expect(src).toContain('session.retryTurn(turn)')

    // Ask again is offered on an answer AND on a refusal, and withheld from the
    // two turns that settle from a template — asking those again returns the
    // identical words, and the credential turn has its own affirmative button.
    expect(src).toContain("turn.refusal?.cause !== 'credential'")
    expect(src).toContain("turn.refusal?.cause !== 'social'")

    // Esc still reaches the popover first; the editor's branch sits below it.
    expect(src.match(/function onEsc\(\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(askOpen\.value\)/)).not.toBe(
      null,
    )
    expect(src.indexOf('cancelTurnEdit()', src.indexOf('function onEsc()'))).toBeGreaterThan(
      src.indexOf('if (askOpen.value)'),
    )
  })

  it('contains no emoji', () => {
    const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
    // Both halves of the stylesheet by name: listing only the bundle entry
    // would leave every rule in the package uncovered the moment it became two
    // @use lines.
    for (const f of [
      ...FILES,
      'src/theme/styles/core.scss',
      'src/theme/styles/vitepress.scss',
      'src/theme/styles/docpilot.scss',
    ]) {
      expect(re.test(read(f)), f).toBe(false)
    }
  })

  it('summarises what was configured for the startup block', () => {
    expect(summariseI18n(validateI18n(null, () => {}))).toBeNull()
    const s = summariseI18n(
      validateI18n(
        { locales: { ru: { translations: { panel: { close: 'x' }, nope: 'y' } } } },
        () => {},
      ),
    )
    expect(s).toContain('ru')
    expect(s).toContain('1 unknown key ignored')
  })
})

/**
 * Two selectors, one key space. Conflating them regresses behaviour that ships:
 * one selector would either answer a Russian greeting in English or write
 * Russian into an English page's chrome.
 */
describe('i18n — the two selectors', () => {
  const tree = (i18n) => resolveI18n(validateI18n(i18n, () => {}))

  it('chrome follows the PAGE, reply copy follows the TYPED language', () => {
    // The panel is English; the reader typed Russian.
    expect(t(tree({}), 'en', 'empty.heading')).toBe('How can I help you today?')
    expect(t(tree({}), localeOf(detectLanguage('привет')), 'reply.social.greeting').lead).toBe(
      socialCopy('ru', 'greeting').lead,
    )
  })

  it('a reply in an unlisted language falls back to the PAGE locale, then to en', () => {
    const i18n = { locales: { ru: { translations: { reply: { credential: { lead: 'Стоп!' } } } } } }
    // Typed language unknown, page is Russian → the reader gets Russian.
    expect(t(tree(i18n), 'cy', 'reply.credential.lead', {}, 'ru')).toBe('Стоп!')
    // Neither known → English.
    expect(t(tree(i18n), 'cy', 'reply.credential.lead', {}, 'de')).toBe(
      "Don't paste keys or tokens here.",
    )
  })

  it('the whole reply block can be read at once, as the panel reads it', () => {
    const copy = t(tree({}), 'ru', 'reply.credential')
    expect(copy.lead).toBe('Не вставляйте сюда ключи и токены.')
    expect(typeof copy.action).toBe('string')
  })

  it('an override reaches the reply copy, one string at a time', () => {
    const i18n = {
      locales: { ru: { translations: { reply: { social: { greeting: { lead: 'Здорово!' } } } } } },
    }
    const copy = t(tree(i18n), 'ru', 'reply.social.greeting')
    expect(copy.lead).toBe('Здорово!')
    // …and the two strings beside it survive.
    expect(copy.body).toBe(socialCopy('ru', 'greeting').body)
    expect(copy.invite).toBe(socialCopy('ru', 'greeting').invite)
  })
})

/**
 * Social openers — the second local settlement, and the one that exists because
 * the gate's correct answer produces the wrong outcome.
 *
 * "Привет" carries no documented subject, so D and L are both ~0 and the turn
 * lands on `no-evidence`: a right verdict that tells the reader, on their very
 * first message, that the feature is broken.
 */
describe('social openers', () => {
  it('claims an input that is social and nothing else', () => {
    for (const s of ['привет', 'Hi!', 'hello there', 'Здравствуйте', 'buenos días', '你好']) {
      expect(detectSocial(s), s).not.toBeNull()
    }
  })

  it('classifies the four kinds, identity ahead of greeting', () => {
    expect(detectSocial('who are you?').kind).toBe('identity')
    // Both a greeting and an identity question; the identity answer is the more
    // useful of the two, so the order of PATTERNS decides it.
    expect(detectSocial('привет, кто ты').kind).toBe('identity')
    expect(detectSocial('спасибо!').kind).toBe('thanks')
    expect(detectSocial('пока').kind).toBe('farewell')
    expect(detectSocial('как дела?').kind).toBe('greeting')
  })

  it('does NOT claim a greeting attached to a real question', () => {
    // This is the load-bearing case. It runs BEFORE the gate, so a false
    // positive answers a real question with a wave — strictly worse than the
    // refusal this module exists to remove.
    expect(detectSocial('Привет, как подключить редактор?')).toBeNull()
    expect(detectSocial('hi, how do I authenticate requests?')).toBeNull()
  })

  it('does not claim an ordinary question', () => {
    for (const s of ['how do I authenticate?', 'что такое webhook', 'topK']) {
      expect(detectSocial(s), s).toBeNull()
    }
  })

  it('gives up past 64 characters — a long input is a question', () => {
    expect(detectSocial(`hello ${'!'.repeat(60)}`)).toBeNull()
    expect(detectSocial('   ')).toBeNull()
    expect(detectSocial(null)).toBeNull()
  })

  it('has all three strings for every kind in every language it claims', () => {
    for (const locale of SOCIAL_LANGUAGES) {
      for (const kind of ['greeting', 'identity', 'thanks', 'farewell']) {
        const c = socialCopy(locale, kind)
        expect(c.lead.trim().length, `${locale}.${kind}.lead`).toBeGreaterThan(0)
        expect(typeof c.body, `${locale}.${kind}.body`).toBe('string')
        expect(typeof c.invite, `${locale}.${kind}.invite`).toBe('string')
      }
      // A farewell that asks a follow-up question is not a farewell, and the
      // panel renders the suggestion rows off this field.
      expect(socialCopy(locale, 'farewell').invite, locale).toBe('')
    }
  })

  it('falls back to English for a language it does not speak', () => {
    expect(socialCopy('xx', 'greeting')).toEqual(socialCopy('en', 'greeting'))
    expect(socialCopy('ru', 'nonsense-kind')).toEqual(socialCopy('ru', 'greeting'))
  })

  it('is keyed by the same subtags the detector maps onto', () => {
    // One key space for the panel chrome and the reply copy, so a site with a
    // `ru` locale writes one override block rather than two.
    expect(localeOf('Russian')).toBe('ru')
    expect(SOCIAL_LANGUAGES).toContain(localeOf(detectLanguage('привет')))
    expect(SOCIAL_LANGUAGES).toContain(localeOf(detectLanguage('你好')))
  })

  it('names no product in the shipped copy, and interpolates one on request', () => {
    for (const locale of SOCIAL_LANGUAGES) {
      const c = socialCopy(locale, 'greeting')
      expect(`${c.lead}${c.body}${c.invite}`, locale).not.toMatch(/\{product\}|stripo/i)
    }
    // An override may still use a slot; the interpolation is always applied.
    expect(
      socialCopy('en', 'greeting', { product: 'Acme' }).lead.replace(
        'this documentation',
        'Acme',
      ),
    ).toContain('Acme')
  })
})

/**
 * This package ships to any VitePress site, so a shipped default naming
 * somebody else's product is not a default — it is a defect that reads as
 * working software. It was extracted from a project whose name reached the
 * system instruction, eighteen languages of credential copy and three empty
 * state suggestions; that is exactly the kind of thing that comes back one
 * string at a time unless something is watching.
 *
 * The repository URL in config.js is exempt and stays: it is a fact about where
 * this code lives, not copy shown to a reader.
 */
describe('brand neutrality of the shipped defaults', () => {
  const FILES = [
    'src/theme/docpilot/prompt.js',
    'src/theme/docpilot/credentials.js',
    'src/theme/components/DocPilot.vue',
    'src/theme/components/DocPilotTrigger.vue',
    'src/theme/components/DocPilotCta.vue',
  ]

  it('names no product of its own, in copy or in comments', () => {
    for (const f of FILES) {
      const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      expect(src.match(/stripo/gi) || [], f).toEqual([])
    }
  })

  it('renders the neutral instruction when no product is configured', () => {
    // The opening sentence is the only place the product appears; "this
    // documentation" also occurs in the credential rule, where it is prose.
    const opening = (text) => text.split('\n')[0]
    expect(opening(coreText())).toBe(
      'You answer questions about this documentation using only the excerpts you are given.',
    )
    expect(opening(coreText({}, 'Acme Editor'))).toBe(
      'You answer questions about Acme Editor using only the excerpts you are given.',
    )
  })

  it('leaves an override alone — it is the author\'s own words, not a template', () => {
    expect(coreText({ override: 'Be terse.' }, 'Acme Editor')).toBe('Be terse.')
  })

  it('makes the product part of the prompt hash, because it changes what is sent', () => {
    expect(promptHash(undefined, 'Acme Editor')).not.toBe(promptHash())
    expect(promptHash(undefined, 'Acme Editor')).toBe(promptHash(undefined, 'Acme Editor'))
  })

  it('reaches the client half, so the panel can say it too', () => {
    expect(themeDocPilot(resolveDocPilot({ product: 'Acme Editor' })).product).toBe('Acme Editor')
    expect(themeDocPilot(resolveDocPilot({})).product).toBeNull()
  })
})

describe('external provenance — how a citation renders', () => {
  const known = new Set(['/guide/auth'])
  const internal = { n: 1, href: '/guide/auth#tokens', title: 'Tokens', origin: null }
  const external = {
    n: 2,
    href: 'https://example.com/product',
    origin: 'https://example.com/product',
    title: 'Product overview',
  }

  it('an imported page\'s marker opens the ORIGINAL, in a new tab', () => {
    const html = renderAnswer('see [2]', known, [internal, external]).html
    expect(html).toContain('href="https://example.com/product"')
    expect(html).toContain('target="_blank"')
    // Not optional beside target=_blank: the answer is v-html, and a tab that
    // keeps window.opener can navigate the panel it was opened from.
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('leaves an ordinary citation as same-tab SPA navigation', () => {
    const html = renderAnswer('see [1]', known, [internal, external]).html
    expect(html).toContain('href="/guide/auth#tokens"')
    expect(html).not.toContain('target="_blank"')
  })

  it('de-links a model link to an external id, because that id is not a route', () => {
    // The id looks like a route and is not one. `knownPaths` excludes external
    // pages for exactly this reason; the sentence survives, the anchor does not.
    const html = renderAnswer('read [the overview](/knowledge-base/product)', known, []).html
    expect(html).not.toContain('<a')
    expect(html).toContain('the overview')
  })
})

/**
 * The archive — a durable, tab-safe store.
 *
 * Every case below runs on Map-backed fake stores, injected the way `hotkey.js`
 * takes its `window`: the module is deliberately written so that the only
 * browser thing it touches arrives as an argument, because vitest runs in node
 * and `localStorage` does not exist there. Two of these cases — the two-tab
 * archive and the delete-elsewhere resurrection — are the reason the module has
 * a read-modify-write shape at all, so they are asserted rather than reasoned
 * about in a comment.
 */
describe('history — a durable, tab-safe archive', () => {
  const fakeStore = (opts = {}) => {
    const m = new Map()
    let writes = 0
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem(k, v) {
        writes++
        if (opts.throwFor && opts.throwFor(writes)) {
          const e = new Error('QuotaExceededError')
          e.name = 'QuotaExceededError'
          throw e
        }
        m.set(k, String(v))
      },
      removeItem: (k) => m.delete(k),
      _map: m,
      get _writes() {
        return writes
      },
    }
  }

  const T0 = 1_755_000_000_000
  /** One tab: its own session store, a shared archive, a clock it controls. */
  const tab = (local, at = 0, limits) =>
    createHistory({ local, session: fakeStore(), now: () => T0 + at, limits })

  const turn = (over = {}) => ({
    id: 'm_1',
    question: 'How do I authenticate?',
    state: 'complete',
    answerText: 'Pass the key as a bearer token [1].',
    answerHtml: '<p>Pass the key as a bearer token</p>',
    sources: [{ n: 1, id: 'auth#t', href: '/guide/auth#t', origin: null, title: 'Tokens', tail: 'Auth' }],
    scope: { kind: 'all', label: 'All docs', paths: [] },
    startedAt: 1234.5,
    streaming: false,
    thought: 'x'.repeat(50_000),
    thoughtOpen: false,
    thoughtSeconds: 7,
    verdict: null,
    reasons: [],
    reasonOpen: false,
    latencyMs: 4210,
    iterations: 1,
    rejectedFetches: 0,
    support: 0.83,
    delinked: ['/gone'],
    notAnswerable: { chars: 12 },
    gate: {
      G: 0.71,
      threshold: 0.55,
      mode: 'calibrated',
      n: 5,
      channel: 'hybrid',
      wouldPassUnscoped: false,
      chunks: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, text: 'y'.repeat(400) })),
    },
    ...over,
  })

  // ── the projection ─────────────────────────────────────────────────────────

  it('drops the reasoning, the retrieved chunks and everything transient', () => {
    const t = turn()
    t.cited = [t.sources[0]]
    const slim = slimTurn(t)

    expect(Object.keys(slim).sort()).toEqual(
      [
        'citedIdx',
        'gate',
        'id',
        'iterations',
        'latencyMs',
        'question',
        'rejectedFetches',
        'scope',
        'sources',
        'state',
        'answerText',
        'support',
      ].sort(),
    )
    // The six the feedback record reads survive; the chunk TEXT does not.
    expect(Object.keys(slim.gate).sort()).toEqual(
      ['G', 'channel', 'mode', 'n', 'threshold', 'wouldPassUnscoped'].sort(),
    )
    expect(slim.gate.chunks).toBeUndefined()
    // The whole point of the projection, in one number.
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(t).length * 0.1)
  })

  // Without it a restored thread renders "what does this mean?" above an answer
  // with no `this` anywhere on screen. Written only when there is one, so the
  // projection of an ordinary turn does not grow a key.
  it('keeps the quote, and only when there is one', () => {
    expect(slimTurn(turn())).not.toHaveProperty('quote')
    expect(slimTurn(turn({ quote: '' }))).not.toHaveProperty('quote')
    expect(slimTurn(turn({ quote: 'the gate runs first' })).quote).toBe('the gate runs first')
  })

  it('keeps citation POSITION, so two citations into one section still resolve', () => {
    const t = turn()
    // One row, two citations — what the retriever produces for a long section.
    t.cited = [t.sources[0], t.sources[0]]
    expect(slimTurn(t).citedIdx).toEqual([0, 0])
  })

  it('keeps answerHtml for a legacy turn, and only for a legacy turn', () => {
    // `sources` and no `cited` is the pre-history payload, and the one case
    // re-rendering would strip markers from.
    const legacy = turn()
    delete legacy.cited
    expect(slimTurn(legacy).answerHtml).toBe('<p>Pass the key as a bearer token</p>')

    const modern = turn()
    modern.cited = [modern.sources[0]]
    expect(slimTurn(modern).answerHtml).toBeUndefined()
  })

  it('settles a turn caught mid-flight, and drops one that has nothing to show', () => {
    expect(slimTurn(turn({ state: 'thinking' })).state).toBe('aborted')
    expect(slimTurn(turn({ state: 'retrieving', answerText: '', refusal: null }))).toBe(null)
    // A transport failure renders as one fixed sentence; restored, it is a
    // mystery rather than an answer.
    expect(slimTurn(turn({ state: 'error', answerText: '', error: 'boom' }))).toBe(null)
    // A refusal, though, is the product's answer and is kept.
    const refused = slimTurn(turn({ state: 'no-answer', answerText: '', refusal: { cause: 'no-evidence' } }))
    expect(refused.refusal.cause).toBe('no-evidence')
  })

  it('caps scope.paths at the same 20 the feedback record already caps at', () => {
    const wide = turn({
      scope: { kind: 'pages', label: '60 pages', paths: Array.from({ length: 60 }, (_, i) => `/p${i}`) },
    })
    expect(slimTurn(wide).scope.paths).toHaveLength(20)
  })

  // ── round trip ─────────────────────────────────────────────────────────────

  it('round-trips a conversation, title and all', () => {
    const local = fakeStore()
    const h = tab(local)
    const t = turn()
    t.cited = [t.sources[0]]
    const id = h.save({ id: null, hash: 'abc', turns: [t] })

    expect(h.list()).toEqual([
      { id, title: 'How do I authenticate?', createdAt: T0, updatedAt: T0, hash: 'abc', turnCount: 1 },
    ])
    expect(h.current()).toBe(null) // saving does not point the tab at it
    const opened = h.open(id)
    expect(h.current()).toBe(id)
    expect(opened.hash).toBe('abc')
    expect(opened.turns[0].answerText).toBe('Pass the key as a bearer token [1].')
    expect(opened.turns[0].citedIdx).toEqual([0])
  })

  it('keeps the first question as the title however long the conversation runs', () => {
    const local = fakeStore()
    const a = tab(local, 0)
    const id = a.save({ id: null, hash: 'h', turns: [turn()] })
    const b = tab(local, 60_000)
    b.save({ id, hash: 'h', turns: [turn(), turn({ id: 'm_2', question: 'And the rate limit?' })] })
    const [row] = b.list()
    expect(row.title).toBe('How do I authenticate?')
    expect(row.createdAt).toBe(T0) // created once, updated since
    expect(row.updatedAt).toBe(T0 + 60_000)
  })

  // ── two tabs ───────────────────────────────────────────────────────────────

  it('two tabs share the archive without clobbering each other', () => {
    const local = fakeStore()
    const a = tab(local, 0)
    const b = tab(local, 1000)

    const idA = a.save({ id: null, hash: 'h', turns: [turn({ question: 'Tab A question' })] })
    const idB = b.save({ id: null, hash: 'h', turns: [turn({ question: 'Tab B question' })] })
    a.open(idA)
    b.open(idB)
    // A writes again AFTER B — the read-modify-write is what keeps B's row.
    a.save({ id: idA, hash: 'h', turns: [turn({ question: 'Tab A question' }), turn({ id: 'm_2' })] })

    expect(a.list().map((c) => c.id).sort()).toEqual([idA, idB].sort())
    expect(a.current()).toBe(idA)
    expect(b.current()).toBe(idB)
    expect(a.list().find((c) => c.id === idB).title).toBe('Tab B question')
  })

  it('resurrects a conversation another tab deleted while this one was in it', () => {
    // The documented failure, pinned: the alternative is a tab that silently
    // stops persisting for the rest of its life.
    const local = fakeStore()
    const a = tab(local, 0)
    const b = tab(local, 0)
    const id = a.save({ id: null, hash: 'h', turns: [turn()] })
    a.open(id)
    b.remove(id)
    expect(b.list()).toEqual([])

    a.save({ id, hash: 'h', turns: [turn()] })
    expect(b.list().map((c) => c.id)).toEqual([id])
  })

  // ── the caps ───────────────────────────────────────────────────────────────

  it('keeps the newest N conversations and drops the oldest', () => {
    const local = fakeStore()
    const ids = []
    for (let i = 0; i < 22; i++) {
      const h = tab(local, i * 1000)
      ids.push(h.save({ id: null, hash: 'h', turns: [turn({ question: `Question ${i}` })] }))
    }
    const rows = tab(local).list()
    expect(rows).toHaveLength(20)
    expect(rows[0].title).toBe('Question 21')
    expect(rows.map((c) => c.id)).not.toContain(ids[0])
    expect(rows.map((c) => c.id)).not.toContain(ids[1])
  })

  it('prunes older conversations to stay inside the byte budget', () => {
    const local = fakeStore()
    const fat = () => turn({ answerText: 'z'.repeat(30_000) })
    for (let i = 0; i < 6; i++) {
      tab(local, i * 1000, { bytes: 100_000 }).save({
        id: null,
        hash: 'h',
        turns: [fat()],
      })
    }
    const h = tab(local, 0, { bytes: 100_000 })
    expect(h.bytes()).toBeLessThanOrEqual(100_000)
    expect(h.list().length).toBeGreaterThan(0)
    expect(h.list().length).toBeLessThan(6)
  })

  it('stores a single conversation that is bigger than the whole budget', () => {
    // Losing the thread the reader is sitting in is worse than overrunning a
    // self-imposed etiquette limit.
    const local = fakeStore()
    const h = tab(local, 0, { bytes: 1000 })
    const id = h.save({ id: null, hash: 'h', turns: [turn({ answerText: 'z'.repeat(5000) })] })
    expect(id).toBeTruthy()
    expect(h.list()).toHaveLength(1)
  })

  it('prunes once and retries when the store refuses the write', () => {
    const seed = fakeStore()
    tab(seed, 0).save({ id: null, hash: 'h', turns: [turn({ question: 'Older' })] })
    // The same data, behind a store whose FIRST write throws.
    const local = fakeStore({ throwFor: (n) => n === 1 })
    local._map.set('docpilot:history', seed._map.get('docpilot:history'))

    const h = tab(local, 5000)
    const id = h.save({ id: null, hash: 'h', turns: [turn({ question: 'Newer' })] })
    expect(id).toBeTruthy()
    expect(h.list().map((c) => c.title)).toEqual(['Newer'])
  })

  it('gives up silently when every write throws', () => {
    const local = fakeStore({ throwFor: () => true })
    const h = tab(local, 0)
    expect(() => h.save({ id: null, hash: 'h', turns: [turn()] })).not.toThrow()
    expect(h.list()).toEqual([])
  })

  it('survives a missing store entirely — private mode, or SSR', () => {
    const h = createHistory({ local: null, session: null, now: () => T0 })
    expect(() => h.save({ id: null, hash: 'h', turns: [turn()] })).not.toThrow()
    expect(h.list()).toEqual([])
    expect(h.current()).toBe(null)
    expect(h.open('c_x')).toBe(null)
    expect(h.bytes()).toBe(0)
  })

  // ── the schema gate ────────────────────────────────────────────────────────

  it('reads a payload from another version, and a broken one, as empty', () => {
    for (const raw of [
      JSON.stringify({ v: 2, conversations: [{ id: 'c_1' }] }),
      JSON.stringify({ conversations: [{ id: 'c_1' }] }),
      JSON.stringify({ v: 1, conversations: 'not an array' }),
      '{ not json',
    ]) {
      const local = fakeStore()
      local._map.set('docpilot:history', raw)
      const h = tab(local)
      expect(h.list(), raw).toEqual([])
      // …and the next write simply overwrites it, rather than throwing.
      expect(h.save({ id: null, hash: 'h', turns: [turn()] })).toBeTruthy()
      expect(h.list()).toHaveLength(1)
    }
  })

  // ── the pointer ────────────────────────────────────────────────────────────

  it('clears the pointer only when it pointed at what was removed', () => {
    const local = fakeStore()
    const h = tab(local)
    const one = h.save({ id: null, hash: 'h', turns: [turn({ question: 'One' })] })
    const two = h.save({ id: null, hash: 'h', turns: [turn({ question: 'Two' })] })
    h.open(one)
    h.remove(two)
    expect(h.current()).toBe(one)
    h.remove(one)
    expect(h.current()).toBe(null)
  })

  it('start() forgets the pointer and keeps the archive; clear() drops both', () => {
    const local = fakeStore()
    const h = tab(local)
    const id = h.save({ id: null, hash: 'h', turns: [turn()] })
    h.open(id)
    h.start()
    expect(h.current()).toBe(null)
    expect(h.list()).toHaveLength(1)
    h.clear()
    expect(h.list()).toEqual([])
    expect(h.current()).toBe(null)
  })

  it('forgets a pointer to a conversation that is no longer there', () => {
    const local = fakeStore()
    const h = tab(local)
    const id = h.save({ id: null, hash: 'h', turns: [turn()] })
    h.open(id)
    tab(local).remove(id) // another tab
    expect(h.open(id)).toBe(null)
    expect(h.current()).toBe(null)
  })

  // ── migration ──────────────────────────────────────────────────────────────

  it('imports the pre-history thread once, then removes its key', () => {
    const local = fakeStore()
    const session = fakeStore()
    const legacy = turn()
    delete legacy.cited
    session._map.set('docpilot:session', JSON.stringify({ hash: 'old', turns: [legacy] }))
    const h = createHistory({ local, session, now: () => T0 })

    const id = h.migrate()
    expect(id).toBeTruthy()
    expect(h.current()).toBe(id)
    expect(session._map.has('docpilot:session')).toBe(false)
    // A legacy turn has no `cited`, so its HTML rides along rather than being
    // re-rendered into markerless prose.
    expect(h.open(id).turns[0].answerHtml).toBe('<p>Pass the key as a bearer token</p>')
    expect(h.open(id).hash).toBe('old')

    expect(h.migrate()).toBe(null)
    expect(h.list()).toHaveLength(1)
  })

  it('does not import over a tab that already has a conversation', () => {
    const local = fakeStore()
    const session = fakeStore()
    session._map.set('docpilot:session', JSON.stringify({ hash: 'old', turns: [turn()] }))
    const h = createHistory({ local, session, now: () => T0 })
    const mine = h.save({ id: null, hash: 'h', turns: [turn({ question: 'Mine' })] })
    h.open(mine)
    expect(h.migrate()).toBe(null)
    expect(h.list()).toHaveLength(1)
  })

  it('an empty or absent legacy payload imports nothing', () => {
    const local = fakeStore()
    const session = fakeStore()
    const h = createHistory({ local, session, now: () => T0 })
    expect(h.migrate()).toBe(null)
    session._map.set('docpilot:session', JSON.stringify({ hash: 'old', turns: [] }))
    expect(h.migrate()).toBe(null)
    expect(h.list()).toEqual([])
  })

  // ── the two pure helpers ───────────────────────────────────────────────────

  it('titles a row from the first question, on a word boundary', () => {
    expect(conversationTitle('  How   do I\nauthenticate? ')).toBe('How do I authenticate?')
    const long = conversationTitle('word '.repeat(40))
    expect(long.length).toBeLessThanOrEqual(81)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toContain('  ')
    // No boundary to find: one very long token is cut where it must be.
    expect(conversationTitle('x'.repeat(200)).length).toBe(81)
    expect(conversationTitle('')).toBe('')
    expect(conversationTitle(null)).toBe('')
  })

  it('picks the unit a reader would say out loud', () => {
    const now = T0
    expect(relativeParts(now - 59_000, now)).toEqual({ value: 0, unit: 'second' })
    expect(relativeParts(now - 61_000, now)).toEqual({ value: -1, unit: 'minute' })
    expect(relativeParts(now - 3_601_000, now)).toEqual({ value: -1, unit: 'hour' })
    expect(relativeParts(now - 2 * 86_400_000, now)).toEqual({ value: -2, unit: 'day' })
    expect(relativeParts(now - 15 * 86_400_000, now)).toEqual({ value: -2, unit: 'week' })
    // A clock that was wrong reads as "now", not as "in three hours".
    expect(relativeParts(now + 3 * 3_600_000, now)).toEqual({ value: 0, unit: 'second' })
  })
})

/**
 * Switching the archive off is an ERASURE, not just a stop.
 *
 * The same rule `prompt.show: false` already applies to the reader's own
 * instruction, applied to a store that outlives the tab: a site that turns this
 * off for a privacy review must leave nothing behind on the next visit. Asserted
 * end to end — settings, merge, emit, client — because the failure it guards
 * against is a setting that only LOOKS like it did something.
 */
describe('history — the off switch clears', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  it('clears what is stored when the site sets history.enabled: false', () => {
    const local = fake()
    const store = createHistory({ local, session: fake(), now: () => 1 })
    store.save({
      id: null,
      hash: 'h',
      turns: [{ id: 'm_1', question: 'q', state: 'complete', answerText: 'a', sources: [] }],
    })
    expect(store.list()).toHaveLength(1)

    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({ history: { enabled: false } })) })
    expect(sessionState.config.history.enabled).toBe(false)
    expect(store.list()).toEqual([])
    expect(local._map.has('docpilot:history')).toBe(false)

    // …and the cap reaches the store when it is left on.
    configure({ docPilot: themeDocPilot(resolveDocPilot({ history: { maxConversations: 3 } })) })
    for (let i = 0; i < 5; i++) {
      store.save({
        id: null,
        hash: 'h',
        turns: [{ id: `m_${i}`, question: `q${i}`, state: 'complete', answerText: 'a', sources: [] }],
      })
    }
    expect(store.list()).toHaveLength(3)

    __setHistoryForTests(null)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
  })
})

/**
 * The store, driven through the panel's own actions.
 *
 * The projection is asserted above; this is the other half — that a stored turn
 * comes back as a turn the panel can render, with its citation markers intact
 * and its answer re-checked against the CURRENT index. The index is assigned
 * directly rather than loaded, because what is under test is the restore path,
 * not the fetch.
 */
describe('history — a stored conversation, restored into the panel', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  const INDEX = {
    manifest: {
      hash: 'h1',
      pages: [
        { path: '/guide/auth', title: 'Authentication', tail: 'Guide' },
        { path: '/guide/limits', title: 'Rate limits', tail: 'Guide' },
      ],
    },
  }

  const storedTurn = () => ({
    id: 'm_1',
    question: 'How do I authenticate?',
    state: 'complete',
    answerText: 'Use a bearer token [1], and mind the [rate limits](/gone).',
    sources: [
      { n: 1, id: 'auth#t', href: '/guide/auth#t', origin: null, title: 'Tokens', tail: 'Authentication' },
    ],
    cited: null,
    scope: { kind: 'all', label: 'All docs', paths: [] },
  })

  const seed = (store, hash = 'h1') => {
    const t = storedTurn()
    t.cited = [t.sources[0]]
    return store.save({ id: null, hash, turns: [t] })
  }

  it('rehydrates markers, and re-checks every other link against the live index', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)

    expect(sessionState.conversationId).toBe(id)
    expect(sessionState.turns).toHaveLength(1)
    const [turn] = sessionState.turns
    // The marker resolves to its row — the whole reason positions are stored.
    expect(turn.answerHtml).toContain('href="/guide/auth#t"')
    // And a link to a page that is not in this index comes back de-linked,
    // which storing the HTML would have prevented.
    expect(turn.answerHtml).not.toContain('href="/gone"')
    expect(turn.answerHtml).toContain('rate limits')
    // Not stored, so not restored: the disclosure simply is not there.
    expect(turn.thought).toBe('')
    expect(turn.streaming).toBe(false)
    expect(sessionState.conversationStale).toBe(false)

    __setHistoryForTests(null)
  })

  it('marks a conversation written against an older index, and renders it anyway', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store, 'h0')
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    expect(sessionState.conversationStale).toBe(true)
    expect(sessionState.turns).toHaveLength(1)
    expect(sessionState.turns[0].answerHtml).toContain('href="/guide/auth#t"')

    __setHistoryForTests(null)
  })

  it('empties the panel when the conversation on screen is deleted', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    session.removeConversation(id)
    expect(sessionState.turns).toEqual([])
    expect(sessionState.conversationId).toBe(null)
    expect(sessionState.history).toEqual([])

    __setHistoryForTests(null)
  })

  it('newChat lets go of the conversation without deleting it', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    session.newChat()
    expect(sessionState.turns).toEqual([])
    expect(sessionState.conversationId).toBe(null)
    expect(store.current()).toBe(null)
    // Still in the archive, and still in the switcher.
    expect(sessionState.history.map((c) => c.id)).toEqual([id])

    __setHistoryForTests(null)
  })

  it('clearHistory empties the archive and the panel together', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = seed(store)
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX

    session.openConversation(id)
    session.clearHistory()
    expect(sessionState.turns).toEqual([])
    expect(sessionState.history).toEqual([])
    expect(store.list()).toEqual([])

    __setHistoryForTests(null)
    sessionState.index = null
  })
})

/**
 * Editing a question TRUNCATES the thread.
 *
 * The seam is `submit('hi')`: a greeting settles locally in `detectSocial`,
 * before the abort controller and before any network call, so a whole re-ask
 * runs here with no transport to stand in for. Everything after the truncation —
 * the push, `finishTurn`, `saveCurrent` — is the real code path.
 */
describe('a question, edited', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  const INDEX = { manifest: { hash: 'h1', pages: [{ path: '/guide/auth', title: 'Auth', tail: '' }] } }

  const storedTurn = (n, quote = '') => ({
    id: `m_${n}`,
    question: `Question ${n}?`,
    state: 'complete',
    answerText: `Answer ${n}.`,
    sources: [],
    cited: null,
    quote,
    scope: { kind: 'all', label: 'All docs', paths: [] },
  })

  // Three turns, opened into the panel — the shortest thread in which "and
  // everything after it" is a claim with something to check.
  const openThread = (turns) => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns })
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = INDEX
    sessionState.degraded = false
    sessionState.busy = false
    session.openConversation(id)
    return { store, id }
  }

  const settle = () => new Promise((r) => setTimeout(r, 0))

  afterEach(() => {
    __setHistoryForTests(null)
    sessionState.index = null
    sessionState.busy = false
  })

  it('drops the edited turn and everything after it, then asks again', async () => {
    openThread([storedTurn(1), storedTurn(2), storedTurn(3)])
    const [, second] = sessionState.turns

    expect(session.editTurn(second, 'hi')).toBe(true)
    await settle()

    expect(sessionState.turns).toHaveLength(2)
    // The turn above it is untouched — same object identity, not a re-render.
    expect(sessionState.turns[0].id).toBe('m_1')
    expect(sessionState.turns[1].question).toBe('hi')
    // A NEW turn, not the old one rewritten: the answer below it was about the
    // question that has gone, and reusing the id would carry a vote with it.
    expect(sessionState.turns[1].id).not.toBe('m_2')
  })

  it('carries the quote, like every other re-ask path', async () => {
    openThread([storedTurn(1, 'the passage that was selected')])
    const [only] = sessionState.turns

    expect(session.editTurn(only, 'hi')).toBe(true)
    await settle()

    expect(sessionState.turns.at(-1).quote).toBe('the passage that was selected')
  })

  it('refuses, and leaves the thread alone, when there is nothing to do', () => {
    openThread([storedTurn(1), storedTurn(2)])
    const [, second] = sessionState.turns

    expect(session.editTurn(second, '   ')).toBe(false)
    expect(session.editTurn(second, second.question)).toBe(false)
    expect(session.editTurn({ id: 'not-in-this-thread' }, 'hi')).toBe(false)
    expect(sessionState.turns).toHaveLength(2)

    // Busy is the one that would corrupt rather than no-op: `stop()` aborts the
    // controller but `state.busy` is cleared asynchronously, so the submit would
    // return early and leave the thread truncated with nothing in its place.
    sessionState.busy = true
    expect(session.editTurn(second, 'hi')).toBe(false)
    expect(sessionState.turns).toHaveLength(2)
    sessionState.busy = false

    sessionState.degraded = true
    expect(session.editTurn(second, 'hi')).toBe(false)
    expect(sessionState.turns).toHaveLength(2)
    sessionState.degraded = false
  })

  it('asks the same question again, in place of the answer it replaces', async () => {
    openThread([storedTurn(1), storedTurn(2), storedTurn(3)])
    const [, second] = sessionState.turns
    // A refusal is the case this exists for: the verdict is about one
    // retrieval, and the question itself was never the problem.
    second.question = 'hi'

    expect(session.retryTurn(second)).toBe(true)
    await settle()

    expect(sessionState.turns).toHaveLength(2)
    expect(sessionState.turns[0].id).toBe('m_1')
    // Same words, new turn: the answer being replaced carried a vote and a set
    // of sources that belong to the run that produced it.
    expect(sessionState.turns[1].question).toBe('hi')
    expect(sessionState.turns[1].id).not.toBe('m_2')
  })

  it('refuses to re-ask what it cannot truncate', () => {
    openThread([storedTurn(1)])
    const [only] = sessionState.turns

    expect(session.retryTurn({ id: 'not-in-this-thread' })).toBe(false)
    sessionState.busy = true
    expect(session.retryTurn(only)).toBe(false)
    sessionState.busy = false
    sessionState.degraded = true
    expect(session.retryTurn(only)).toBe(false)
    sessionState.degraded = false
    expect(sessionState.turns).toHaveLength(1)
  })

  it('writes the truncation to the archive without waiting for the answer', async () => {
    const { store, id } = openThread([storedTurn(1), storedTurn(2), storedTurn(3)])
    const [, second] = sessionState.turns

    session.editTurn(second, 'hi')
    // Before the re-ask settles: the deleted turns are already gone from disk,
    // so closing the panel mid-answer cannot bring them back.
    expect(store.open(id).turns.map((t) => t.id)).toEqual(['m_1'])

    await settle()
    const saved = store.open(id).turns
    expect(saved).toHaveLength(2)
    expect(saved[0].id).toBe('m_1')
    expect(saved[1].question).toBe('hi')
  })
})

/**
 * The row's title moves when the question it names is replaced, and not when
 * the conversation merely grows. Pure history, no session: the rule is one
 * comparison inside `save`.
 */
describe('history — the title of an edited conversation', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }
  const turn = (id, question) => ({ id, question, state: 'complete', answerText: 'a', sources: [] })

  it('keeps the title while the same first question is still there', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns: [turn('m_1', 'First?')] })
    store.save({ id, hash: 'h1', turns: [turn('m_1', 'First?'), turn('m_2', 'Second?')] })
    expect(store.list()[0].title).toBe(conversationTitle('First?', 80))
  })

  it('renames the row when the first question is replaced', () => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns: [turn('m_1', 'First?')] })
    // What `editTurn` leaves behind: the head of the thread is a different turn.
    store.save({ id, hash: 'h1', turns: [turn('m_9', 'Rewritten?')] })
    expect(store.list()[0].title).toBe(conversationTitle('Rewritten?', 80))
  })
})

/**
 * What leaves the device, and only what.
 *
 * The storage and the transport are both injected — the same seam
 * `createHistory({local, session, now})` opens, and for the same reason: this
 * module is read from Node during a docs build and from a browser at runtime,
 * so it cannot capture either at module load, and a suite that reached for a
 * global mock would be asserting the mock.
 */
describe('feedback — what leaves the device', () => {
  const fakeStorage = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }
  const capture = () => {
    const calls = []
    const fetchImpl = (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) })
      return Promise.resolve({ ok: true })
    }
    return { calls, fetchImpl }
  }
  const stored = (storage) => JSON.parse(storage.getItem('docpilot:feedback') || '[]')

  const entry = (over = {}) => ({
    ts: 1,
    sessionId: 's_1',
    messageId: 'm_1',
    revision: 0,
    question: 'How do I authenticate?',
    answer: 'Use a bearer token.',
    citations: [],
    verdict: 'down',
    reasons: [],
    comment: null,
    scope: { kind: 'all', label: 'All docs', paths: [] },
    promptStock: true,
    ...over,
  })

  it('sends the verdicts feedback.send names, and no others', () => {
    const cases = [
      ['down', ['down']],
      ['up', ['up']],
      ['both', ['up', 'down']],
      ['none', []],
    ]
    for (const [send, expected] of cases) {
      const sent = []
      for (const verdict of ['up', 'down']) {
        const storage = fakeStorage()
        const { calls, fetchImpl } = capture()
        recordFeedback(entry({ verdict, messageId: `m_${verdict}` }), {
          feedbackEndpoint: '/feedback',
          send,
          storage,
          fetchImpl,
        })
        if (calls.length) sent.push(verdict)
        // Stored locally either way: the reader's own thread has to stop showing
        // a thumb they took back, whatever the site transmits.
        expect(stored(storage), `${send}/${verdict} local`).toHaveLength(1)
      }
      expect(sent, `send: ${send}`).toEqual(expected)
    }
  })

  it("defaults to the shipped mode when send is a value this panel does not have", () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    expect(() =>
      recordFeedback(entry({ verdict: 'up' }), {
        feedbackEndpoint: '/f',
        send: 'everything',
        storage,
        fetchImpl,
      }),
    ).not.toThrow()
    // 'both' is the default, so an up-vote under a nonsense value still goes.
    expect(calls).toHaveLength(1)
  })

  it('sends nothing at all without an endpoint, whatever send says', () => {
    for (const send of FEEDBACK_SENDS) {
      const storage = fakeStorage()
      const { calls, fetchImpl } = capture()
      recordFeedback(entry({ verdict: 'down' }), { feedbackEndpoint: null, send, storage, fetchImpl })
      expect(calls, send).toHaveLength(0)
      expect(stored(storage), send).toHaveLength(1)
    }
  })

  it('transmits a withdrawn vote, so a reader can take back what they said', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    recordFeedback(entry({ verdict: null, retracted: 'down', revision: 2, comment: null }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].body.verdict).toBe(null)
    expect(calls[0].body.revision).toBe(2)
    // A routing hint, not part of the record the receiver stores.
    expect(calls[0].body).not.toHaveProperty('retracted')
  })

  it('does not transmit a withdrawal of a vote that was never sent', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    // send: 'up' — the down-vote never went, so neither does taking it back.
    recordFeedback(entry({ verdict: null, retracted: 'down' }), {
      feedbackEndpoint: '/f',
      send: 'up',
      storage,
      fetchImpl,
    })
    expect(calls).toHaveLength(0)
  })

  it('masks a pasted key in the stored row AND in the request body', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    recordFeedback(entry({ comment: `it rejects ${key} every time` }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    expect(calls[0].body.comment).toContain(MASK)
    expect(calls[0].body.comment).not.toContain(key)
    expect(calls[0].init.body).not.toContain(key)
    expect(stored(storage)[0].comment).not.toContain(key)
  })

  /**
   * The ordering test, and the only thing that catches it.
   *
   * Cap-then-redact leaves a fragment of a live key that no pattern matches, and
   * ships it. Redact-then-cap replaces the span first, so a cap that then
   * bisects MASK costs nothing.
   */
  it('redacts before it caps, so a cap cannot slice a key out of reach', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    // The cut lands 10 characters into the key. That fragment is BELOW the
    // minimum length the api-key pattern will match, so a cap that ran first
    // would hand the redactor something it cannot recognise and ship the head of
    // a live key. Choose the offset deliberately: at 19 characters the fragment
    // still matches, the redactor still fires, and this test passes under the
    // wrong order — which is how it was first written.
    const head = key.slice(0, 10)
    // The space matters and is not padding: the api-key pattern is anchored on
    // \b, so a key pasted flush against a word is not a key as far as the
    // detector is concerned. Real comments have spaces before their keys.
    const filler = 'x'.repeat(COMMENT_MAX - head.length - 1)
    recordFeedback(entry({ comment: `${filler} ${key}` }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    const body = calls[0].init.body
    expect(body).not.toContain(key)
    expect(body).not.toContain(head)
    expect(stored(storage)[0].comment).not.toContain(head)
  })

  it('caps a long comment and drops one that is only whitespace', () => {
    const storage = fakeStorage()
    recordFeedback(entry({ comment: 'y'.repeat(700) }), { storage })
    expect(stored(storage)[0].comment).toHaveLength(COMMENT_MAX)

    const s2 = fakeStorage()
    recordFeedback(entry({ comment: '   \n  ' }), { storage: s2 })
    expect(stored(s2)[0].comment).toBe(null)
  })

  it('keeps one row per message — the amendment replaces the thumb', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    const opts = { feedbackEndpoint: '/f', send: 'down', storage, fetchImpl }
    recordFeedback(entry({ revision: 0 }), opts)
    recordFeedback(entry({ revision: 1, reasons: ['wrong', 'bad-links'], comment: 'the link 404s' }), opts)

    const rows = stored(storage)
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toBe(1)
    expect(rows[0].reasons).toEqual(['wrong', 'bad-links'])
    // Both went out; the receiver upserts on messageId.
    expect(calls.map((c) => c.body.revision)).toEqual([0, 1])
  })

  it('withholds the answer on an instructed turn, on every revision', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    const opts = { feedbackEndpoint: '/f', send: 'down', storage, fetchImpl }
    recordFeedback(entry({ promptStock: false, addendum: 'restate my instruction', quote: 'a passage' }), opts)
    recordFeedback(entry({ promptStock: false, revision: 1, comment: 'nope' }), opts)
    for (const c of calls) {
      expect(c.body).not.toHaveProperty('answer')
      expect(c.body).not.toHaveProperty('addendum')
      // The quote is a slice of the answer, so it goes with it. Withholding the
      // answer while shipping five hundred characters of it under another key
      // would be the same leak with a longer path.
      expect(c.body).not.toHaveProperty('quote')
    }
    expect(stored(storage)[0]).not.toHaveProperty('answer')
    expect(stored(storage)[0]).not.toHaveProperty('quote')
  })

  it('sends the quote on a stock turn — a record without it describes a question nobody can read', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    recordFeedback(entry({ quote: 'the gate refuses before the model is called' }), {
      feedbackEndpoint: '/f',
      send: 'down',
      storage,
      fetchImpl,
    })
    expect(calls[0].body.quote).toBe('the gate refuses before the model is called')
  })

  it('normalises a missing revision rather than sending undefined', () => {
    const storage = fakeStorage()
    const { calls, fetchImpl } = capture()
    const { revision, ...noRevision } = entry()
    void revision
    recordFeedback(noRevision, { feedbackEndpoint: '/f', send: 'down', storage, fetchImpl })
    expect(calls[0].body.revision).toBe(0)
  })
})

describe('feedback — the send mode is resolved, never trusted', () => {
  it('is idempotent, so the build and the browser agree', () => {
    const once = resolveFeedback({ feedback: { send: 'up' } })
    expect(resolveFeedback({ feedback: once })).toEqual(once)
  })

  it('reports a value outside the enum and carries on', () => {
    const said = []
    expect(resolveFeedback({ feedback: { send: 'sometimes' } }, (m) => said.push(m))).toEqual({
      send: 'both',
      comment: true,
    })
    expect(said.join(' ')).toContain('feedback.send')
  })

  it('keeps the half the site did not set', () => {
    expect(resolveDocPilot({ feedback: { send: 'down' } }).feedback).toEqual({
      send: 'down',
      comment: true,
    })
    // …and a site that only ever set the endpoint keeps working unchanged.
    expect(resolveDocPilot({ feedbackEndpoint: '/f' }).feedback).toEqual(DEFAULTS.feedback)
  })
})

/**
 * The bridge from a vote to a probe.
 *
 * Every suggestion is checked against the calibrator's own STRATA table, which
 * is why that table is exported: the two cannot drift apart into a file that
 * proposes a stratum `loadProbes` would then reject.
 */
describe('feedback CLI — what a vote is evidence of', () => {
  const gate = (over = {}) => ({
    G: 0.41,
    tau: 0.55,
    mode: 'hybrid',
    channel: 'raw',
    wouldPassUnscoped: false,
    ...over,
  })
  const all = { kind: 'all' }
  const scoped = { kind: 'section' }

  it('never proposes a stratum the calibrator would reject', () => {
    const cases = [
      { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['wrong'], scope: all },
      { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['wrong'], scope: scoped },
      { gate: gate(), refusal: 'out-of-scope', verdict: 'down', reasons: [], scope: scoped },
      { gate: gate({ channel: 'composed' }), refusal: null, verdict: 'up', reasons: [], scope: all },
      { gate: gate({ channel: 'composed' }), refusal: null, verdict: 'down', reasons: [], scope: all },
      { gate: gate({ G: 0.7 }), refusal: null, verdict: 'up', reasons: [], scope: all },
      { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['not-in-docs'], scope: all },
    ]
    for (const c of cases) {
      const s = suggest(c)
      expect(TARGETS).toContain(s.target)
      if (s.stratum != null) expect(Object.keys(STRATA)).toContain(s.stratum)
      for (const k of s.stratumOptions) expect(Object.keys(STRATA)).toContain(k)
    }
  })

  it('drops a turn that never reached the gate', () => {
    for (const refusal of ['credential', 'social']) {
      const s = suggest({ gate: null, refusal, verdict: 'down', reasons: [], scope: all })
      expect(s.target).toBe('none')
      expect(s.needsReview).toBe(false)
    }
  })

  it('refuses to score a degraded turn against tau', () => {
    const s = suggest({
      gate: gate({ mode: 'lexical-only' }),
      refusal: 'no-evidence',
      verdict: 'down',
      reasons: ['wrong'],
      scope: all,
    })
    expect(s.stratum).toBe(null)
    expect(s.needsReview).toBe(true)
    expect(s.note).toContain('degraded')
  })

  it('sends a post-model refusal to the golden set, not to the calibrator', () => {
    const s = suggest({
      gate: gate({ G: 0.7 }),
      refusal: 'not-answerable',
      verdict: 'down',
      reasons: [],
      scope: all,
    })
    expect(s.target).toBe('golden')
    expect(s.expect).toBe('refuse:no-evidence')
    expect(s.stratum).toBe(null)
  })

  it('offers the negative strata rather than guessing between them', () => {
    const s = suggest({
      gate: gate(),
      refusal: 'no-evidence',
      verdict: 'down',
      reasons: ['not-in-docs'],
      scope: all,
    })
    expect(s.stratum).toBe(null)
    expect(s.stratumOptions).toEqual(['N1', 'N2', 'N3', 'N4'])
    // N6 is an adversarial construction; nobody stumbles into it.
    expect(s.stratumOptions).not.toContain('N6')
  })

  /**
   * The invariant the selection feature breaks, and the branch that repairs it.
   *
   * `channel: 'composed'` used to mean one thing — a follow-up whose other half
   * is the previous question — and steps 4/5 file it as an F or N5 probe with
   * "add prev_question from the conversation". A quoted turn has no previous
   * question to add: its antecedent is a passage the corpus wrote. Left alone,
   * every quoted turn would enter the calibration set as a probe nobody can
   * complete, and F's looser over-refusal bound would be applied to a
   * population it was never measured on.
   */
  it('never turns a quoted follow-up into a tau probe', () => {
    const quoted = { gate: gate({ channel: 'composed', antecedent: 'quote' }), refusal: null, reasons: [], scope: all }
    const up = suggest({ ...quoted, verdict: 'up' })
    expect(up.target).toBe('none')
    expect(up.stratum).toBe(null)
    expect(up.note).toContain('quoted')

    const down = suggest({ ...quoted, verdict: 'down' })
    expect(down.target).toBe('golden')
    expect(down.expect).toBe('answer')
    expect(down.stratum).toBe(null)

    // The ordinary follow-up is untouched: same channel, a question behind it.
    const followUp = suggest({
      gate: gate({ channel: 'composed', antecedent: 'question' }),
      refusal: null,
      verdict: 'up',
      reasons: [],
      scope: all,
    })
    expect(followUp.stratum).toBe('F')
  })

  // A quote does not exempt a turn from every route — only from the one that
  // needs a previous question. Refused in scope is still an X probe.
  it('still files a quoted turn the raw channel carried', () => {
    const s = suggest({
      gate: gate({ channel: 'raw', antecedent: 'quote', wouldPassUnscoped: true }),
      refusal: 'out-of-scope',
      verdict: 'down',
      reasons: ['not-in-docs'],
      scope: scoped,
    })
    expect(s.stratum).toBe('X')
  })

  it('routes a citation defect away from the threshold', () => {
    const s = suggest({
      gate: gate({ G: 0.7 }),
      refusal: null,
      verdict: 'down',
      reasons: ['bad-links'],
      scope: all,
    })
    expect(s.target).toBe('docs')
    expect(s.stratum).toBe(null)
  })

  it('reads a scoped refusal as U or S depending on the scope', () => {
    const base = { gate: gate(), refusal: 'no-evidence', verdict: 'down', reasons: ['incomplete'] }
    expect(suggest({ ...base, scope: all }).stratum).toBe('U')
    // Scoped and it would not have passed unscoped either: ambiguous by
    // construction, so it asks rather than answers.
    expect(suggest({ ...base, scope: scoped }).stratumOptions).toEqual(['P', 'S'])
  })
})

describe('feedback CLI — aggregation', () => {
  const row = (over = {}) => ({
    ts: 1755000000000,
    sessionId: 's_1',
    messageId: 'm_1',
    revision: 0,
    question: 'How do I rotate an API key?',
    verdict: 'down',
    reasons: [],
    comment: null,
    refusal: 'no-evidence',
    gate: { G: 0.41, tau: 0.55, mode: 'hybrid', n: 1191, channel: 'raw', wouldPassUnscoped: false },
    scope: { kind: 'all' },
    ...over,
  })

  it('collapses variants of one question, and counts messages not rows', () => {
    const out = aggregate([
      row(),
      row({ revision: 1, reasons: ['wrong'], comment: 'only creation is documented' }),
      row({ messageId: 'm_2', sessionId: 's_2', question: 'how do i rotate an api key' }),
    ])
    expect(out).toHaveLength(1)
    // Two messages, three rows: the amendment is not a second ask.
    expect(out[0].asked).toBe(2)
    expect(out[0].sessions).toBe(2)
    expect(out[0].variants).toHaveLength(2)
    expect(out[0].comments).toEqual(['only creation is documented'])
    expect(out[0].reasons).toEqual({ wrong: 1 })
  })

  it('keeps the highest revision per message', () => {
    const rows = dedupe([
      row({ revision: 1, comment: 'kept' }),
      row({ revision: 0, comment: 'stale' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].comment).toBe('kept')
  })

  it('normalises punctuation and case, but does not stem', () => {
    expect(normalise('How do I ROTATE  a key??')).toBe('how do i rotate a key')
    expect(normalise('rotating keys')).not.toBe(normalise('rotate key'))
  })

  it('keeps a review across a re-pull, and does not mistake its own guess for one', () => {
    const first = aggregate([row({ reasons: ['not-in-docs'] })])
    expect(first[0].needsReview).toBe(true)

    // A second run over the same data changes nothing and clears nothing.
    const untouched = merge(first, aggregate([row({ reasons: ['not-in-docs'] })]))
    expect(untouched[0].needsReview).toBe(true)

    // A person decides, and that decision survives.
    const reviewed = [{ ...first[0], stratum: 'N4', needsReview: false, note: 'off-domain' }]
    const after = merge(reviewed, aggregate([row({ reasons: ['not-in-docs'] })]))
    expect(after[0].stratum).toBe('N4')
    expect(after[0].needsReview).toBe(false)
    expect(after[0].note).toBe('off-domain')
  })

  it('does not drop a promoted question because the sample moved', () => {
    const promoted = [
      { question: 'gone from this export', target: 'calibration', stratum: 'U', promoted: true },
    ]
    const after = merge(promoted, aggregate([row()]))
    expect(after.map((c) => c.question)).toContain('gone from this export')
  })
})

describe('feedback CLI — the source contract', () => {
  it('reads JSONL and a JSON array alike', () => {
    expect(parseRows('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }])
    expect(parseRows('[{"a":1}]')).toEqual([{ a: 1 }])
    expect(parseRows('  ')).toEqual([])
    expect(() => parseRows('not json')).toThrow(/JSONL/)
  })

  it('takes the bearer from the environment and never from the config', async () => {
    const seen = []
    const fetchImpl = (url, init) => {
      seen.push({ url, init })
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/x-ndjson' },
        text: () => Promise.resolve('{"messageId":"m_1"}'),
      })
    }
    await fetchRows({
      from: 'https://example.com/feedback',
      env: { [TOKEN_ENV]: 'secret-token' },
      fetchImpl,
    })
    expect(seen[0].init.headers.authorization).toBe('Bearer secret-token')

    // No token in the environment means no header — not a token read from
    // anywhere else.
    seen.length = 0
    await fetchRows({ from: 'https://example.com/feedback', env: {}, fetchImpl })
    expect(seen[0].init.headers).not.toHaveProperty('authorization')
  })

  it('follows a cursor, stops when it runs out, and says when it stopped early', async () => {
    let page = 0
    const fetchImpl = () => {
      page++
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        text: () =>
          Promise.resolve(
            JSON.stringify({ items: [{ messageId: `m_${page}` }], cursor: page < 3 ? `c${page}` : null }),
          ),
      })
    }
    const rows = await fetchRows({ from: 'https://e.com/f', env: {}, fetchImpl })
    expect(rows).toHaveLength(3)

    page = 0
    const said = []
    const capped = await fetchRows({
      from: 'https://e.com/f',
      env: {},
      maxPages: 2,
      fetchImpl,
      log: (m) => said.push(m),
    })
    expect(capped).toHaveLength(2)
    expect(said.join(' ')).toContain('--max-pages')
  })

  it('never prints the query string, where a token could have been pasted', async () => {
    const fetchImpl = () => Promise.resolve({ ok: false, status: 403, headers: { get: () => '' } })
    await expect(
      fetchRows({ from: 'https://example.com/feedback?token=leaked', env: {}, fetchImpl }),
    ).rejects.toThrow(/403/)
    await expect(
      fetchRows({ from: 'https://example.com/feedback?token=leaked', env: {}, fetchImpl }),
    ).rejects.not.toThrow(/leaked/)
  })
})

describe('feedback CLI — the report says what it does not know', () => {
  const candidates = aggregate([
    {
      ts: 1,
      messageId: 'm_1',
      question: 'How do I rotate a key?',
      verdict: 'down',
      reasons: ['wrong'],
      comment: null,
      refusal: 'no-evidence',
      gate: { G: 0.4, tau: 0.55, mode: 'hybrid', channel: 'raw' },
      scope: { kind: 'all' },
    },
  ])

  it('warns that a down-only sample has no denominator', () => {
    const md = renderReport(candidates, { send: 'down' })
    expect(md).toContain('Only down-votes reached the endpoint')
    expect(md).toContain('biases tau toward refusing')
  })

  it('still warns about selection bias when both verdicts travel', () => {
    const md = renderReport(candidates, { send: 'both' })
    expect(md).toContain('votes, not turns')
  })

  it('says how many questions it left out of the worst-questions table', () => {
    const md = renderReport(candidates, { send: 'both' })
    expect(md).toMatch(/1 question\(s\) with fewer than 3 votes are not listed/)
  })
})

/**
 * The amendment, across a reload.
 *
 * A receiver is told to upsert on `messageId` and keep the higher revision. That
 * makes the counter part of the wire contract rather than a local convenience:
 * a restored turn that starts again from 0 is DROPPED by that guard, silently,
 * and the reader's second opinion never arrives. Nothing in the panel, the
 * console or the endpoint reports it — which is why it is asserted here.
 */
describe('feedback — a vote cast on a restored turn', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }

  const INDEX = { manifest: { hash: 'h1', pages: [{ path: '/guide/auth', title: 'Auth', tail: 'Guide' }] } }

  const liveTurn = () => ({
    id: 'm_1',
    question: 'How do I authenticate?',
    state: 'complete',
    answerText: 'Use a bearer token.',
    sources: [],
    cited: [],
    scope: { kind: 'all', label: 'All docs', paths: [] },
    verdict: 'down',
    reasons: ['wrong'],
    comment: 'the example is out of date',
    feedbackRevision: 2,
    promptStock: true,
    promptHash: 'ph1',
    // Present on a live turn, dropped by the archive on purpose.
    gate: { G: 0.7, threshold: 0.55, mode: 'hybrid', n: 10, channel: 'raw', chunks: [{ id: 'a#b' }] },
  })

  const withPanel = (fn) => {
    const store = createHistory({ local: fake(), session: fake(), now: () => 1 })
    const id = store.save({ id: null, hash: 'h1', turns: [liveTurn()] })
    __setHistoryForTests(store)
    configure({
      docPilot: themeDocPilot(resolveDocPilot({ feedbackEndpoint: '/feedback', feedback: { send: 'both' } })),
    })
    sessionState.index = INDEX
    const sent = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => {
      sent.push(JSON.parse(init.body))
      return Promise.resolve({ ok: true })
    }
    try {
      session.openConversation(id)
      fn(sent, store)
    } finally {
      globalThis.fetch = realFetch
      __setHistoryForTests(null)
      sessionState.index = null
      configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    }
  }

  it('carries the revision the archive kept, instead of starting over at 0', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      expect(turn.feedbackRevision).toBe(2)
      expect(turn.comment).toBe('the example is out of date')
      expect(turn.reasons).toEqual(['wrong'])

      session.vote(turn, 'up')
      expect(sent).toHaveLength(1)
      // NOT 0. A receiver keeping the higher revision would have dropped a 0.
      expect(sent[0].revision).toBe(2)
      expect(turn.feedbackRevision).toBe(3)
    })
  })

  it('omits retrievedIds it cannot re-derive, rather than sending an empty list', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      session.vote(turn, 'up')
      // An empty array would overwrite a good list under `coalesce`.
      expect(sent[0]).not.toHaveProperty('retrievedIds')
      expect(sent[0].restored).toBe(true)
      // The prompt this turn actually ran under, not whatever is set now.
      expect(sent[0].promptHash).toBe('ph1')
    })
  })

  it('clears the reasons and the sentence when the thumb flips away from down', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      session.vote(turn, 'up')
      expect(turn.reasons).toEqual([])
      expect(turn.comment).toBe('')
      expect(sent[0].verdict).toBe('up')
      expect(sent[0].reasons).toEqual([])
      expect(sent[0].comment).toBe(null)
    })
  })

  it('toggles reasons without posting, and posts once when the form is sent', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      turn.verdict = 'down'
      turn.reasonOpen = true
      turn.reasons = []

      session.toggleReason(turn, 'wrong')
      session.toggleReason(turn, 'bad-links')
      session.toggleReason(turn, 'wrong') // off again
      expect(turn.reasons).toEqual(['bad-links'])
      expect(sent).toHaveLength(0)

      session.submitFeedback(turn)
      expect(sent).toHaveLength(1)
      expect(sent[0].reasons).toEqual(['bad-links'])
      expect(turn.reasonOpen).toBe(false)
    })
  })

  it('does not re-post a form the reader added nothing to', () => {
    withPanel((sent) => {
      const [turn] = sessionState.turns
      turn.verdict = 'down'
      turn.reasonOpen = true
      turn.reasons = []
      turn.comment = '   '
      session.submitFeedback(turn)
      expect(sent).toHaveLength(0)
      expect(turn.reasonOpen).toBe(false)
    })
  })

  it('persists the sentence and the counter, so neither dies on reload', () => {
    withPanel((sent, store) => {
      const [turn] = sessionState.turns
      turn.verdict = 'down'
      turn.reasonOpen = true
      turn.reasons = ['incomplete']
      turn.comment = 'it stops halfway'
      session.submitFeedback(turn)
      void sent

      const [row] = store.open(sessionState.conversationId).turns
      expect(row.comment).toBe('it stops halfway')
      expect(row.reasons).toEqual(['incomplete'])
      expect(row.feedbackRevision).toBe(3)
    })
  })
})

/**
 * The key table in the guide, against the key tree that ships.
 *
 * Not pedantry: this table is how a translator decides what work there is, and
 * it had already drifted — 101 leaves in eighteen groups documented against 122
 * in twenty, with the whole `history` group missing and `announce` four short.
 * Nothing failed, because nothing was checking. This is what checks.
 */
describe('i18n — the documented key table matches the shipped one', () => {
  const doc = fs.readFileSync(new URL('../docs/guide/i18n.md', import.meta.url), 'utf8')
  const counts = () => {
    const m = new Map()
    for (const p of KEY_PATHS) {
      const g = p.split('.')[0]
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }

  it('states the real leaf and group totals', () => {
    const m = counts()
    // `[\w-]`, not `\w`: the word map below has always listed `twenty-one` and
    // `twenty-two`, and `\w` cannot match either — so the first hyphenated total
    // this table reached would have failed as a MISSING SENTENCE rather than as
    // a wrong count, which is the one failure mode this test exists to rule out.
    const said = doc.match(/^(\d+) leaves, in ([\w-]+) groups\./m)
    expect(said, 'the "N leaves, in M groups" sentence').not.toBe(null)
    expect(Number(said[1])).toBe(KEY_PATHS.size)
    const words = { eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22 }
    expect(words[said[2]] ?? Number(said[2])).toBe(m.size)
  })

  it('gives every group a row, with the count it actually has', () => {
    for (const [group, n] of counts()) {
      const row = doc.match(new RegExp(`^\\| \`${group}\` \\| (\\d+) \\|`, 'm'))
      expect(row, `a table row for \`${group}\``).not.toBe(null)
      expect(Number(row[1]), `\`${group}\` count`).toBe(n)
    }
  })
})

/**
 * The fourth direction.
 *
 * `feedback.record` redacts the copy it stores and sends, which covers the
 * network and the feedback store. It does NOT cover `turn.comment`, and that
 * string is written to the conversation archive — including a draft the reader
 * abandoned with Escape. This was found in a browser, not here: every unit test
 * passed while a pasted key sat in localStorage in clear text.
 */
describe('feedback — a key in the comment never reaches the archive either', () => {
  const fake = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    }
  }
  const KEY = 'sk-abcdefghijklmnopqrstuvwxyz012345'

  const withTurn = (fn) => {
    const local = fake()
    const store = createHistory({ local, session: fake(), now: () => 1 })
    const id = store.save({
      id: null,
      hash: 'h1',
      turns: [
        {
          id: 'm_1',
          question: 'How do I authenticate?',
          state: 'complete',
          answerText: 'Use a bearer token.',
          sources: [],
          scope: { kind: 'all', label: 'All docs', paths: [] },
          verdict: 'down',
        },
      ],
    })
    __setHistoryForTests(store)
    configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    sessionState.index = { manifest: { hash: 'h1', pages: [] } }
    try {
      session.openConversation(id)
      fn(sessionState.turns[0], local, store)
    } finally {
      __setHistoryForTests(null)
      sessionState.index = null
      configure({ docPilot: themeDocPilot(resolveDocPilot({})) })
    }
  }

  it('masks an abandoned draft, which Escape still writes down', () => {
    withTurn((turn, local) => {
      turn.reasonOpen = true
      turn.comment = `it rejects ${KEY} every time`
      session.skipFeedback(turn)

      expect(turn.comment).toContain(MASK)
      expect(turn.comment).not.toContain(KEY)
      // The whole archive, as bytes: the string reaches disk through slimTurn.
      expect(local.getItem('docpilot:history')).not.toContain(KEY)
    })
  })

  it('masks a submitted comment on the turn, not only in the record', () => {
    withTurn((turn, local) => {
      turn.reasonOpen = true
      turn.reasons = ['wrong']
      turn.comment = `the token ${KEY} is rejected`
      session.submitFeedback(turn)

      expect(turn.comment).not.toContain(KEY)
      expect(local.getItem('docpilot:history')).not.toContain(KEY)
    })
  })
})
