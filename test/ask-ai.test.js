import { describe, it, expect } from 'vitest'

import {
  stripImages,
  collapseWhitespace,
  normaliseMarkdown,
  applyLlmTags,
} from '../src/build/lib/normalise.js'
import { chunkMarkdown, slug } from '../src/build/lib/chunker.js'
import { resolveSections, orphanPages } from '../src/build/lib/sections.js'
import { l2normalise, toInt8, cosineInt8 } from '../src/build/lib/quantize.js'
import { terms, norm } from '../src/theme/ask-ai/text.js'
import { lexicalCoverage, denseFromCosine, verdict, assertWeights } from '../src/theme/ask-ai/gate.js'
import { chat, detectTools, parseFallback, splitThink, streamingAnswerText } from '../src/theme/ask-ai/llm.js'
import { providerFor } from '../src/theme/ask-ai/providers.js'
import {
  systemText,
  buildMessages,
  clampAddendum,
  detectLanguage,
  languageDirective,
  promptDocument,
  coreText,
  promptHash,
  CORE,
} from '../src/theme/ask-ai/prompt.js'
import { isKnownPath, renderAnswer } from '../src/theme/ask-ai/markdown.js'
import { GLYPHS } from '../src/theme/ask-ai/glyphs.js'
import { highlight, __setHighlighterForTests } from '../src/theme/ask-ai/highlight.js'
import { identifiers, computeSupport } from '../src/theme/ask-ai/support.js'
import {
  findSecrets,
  hasSecret,
  redactSecrets,
  credentialCopy,
  CREDENTIAL_LANGUAGES,
  MASK,
} from '../src/theme/ask-ai/credentials.js'
import { tokenF1, wilsonUpper95, languageMatch, retrievalF1Loose } from '../src/eval/metrics.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepRow, chooseTau, contiguousScope, TAU_STEPS } from '../src/eval/calibrate.js'
import { guardFor } from '../src/build/build-rag-index.js'
import { resolveSuggestions, themeAskAI } from '../src/config.js'

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
    expect(html).toContain('class="ask-ai__cite"')
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
    expect(html.match(/ask-ai__cite/g).length).toBe(2)
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
    expect(nested).not.toContain('ask-ai__cite')
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

describe('code fences', () => {
  const known = new Set(['/introduction'])
  const html = (src) => renderAnswer(src, known).html

  it('wraps every fence and gives it one copy button', () => {
    const out = html('```\nplain\n```')
    expect(out).toContain('<div class="ask-ai__code">')
    expect(out).toContain('<pre tabindex="0"><code>plain')
    expect(out.match(/data-copy-code/g).length).toBe(1)
    expect(out).toContain('aria-label="Copy code"')
    // both glyphs ship in the markup; CSS decides which one shows
    expect(out).toContain(GLYPHS.copy)
    expect(out).toContain(GLYPHS.check)
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
      expect(out).toContain('<div class="ask-ai__code" data-lang="ts">')
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
    expect(out).not.toContain('ask-ai__cite')
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askai-guard-'))
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

  it('writes the warning in the language of the question, English when unsure', () => {
    expect(credentialCopy('Russian').lead).toBe('Не вставляйте сюда ключи и токены.')
    expect(credentialCopy('Ukrainian').action).toBe('Відповісти на запитання без ключа')
    expect(credentialCopy(null)).toBe(credentialCopy('English'))
    expect(credentialCopy('Klingon')).toBe(credentialCopy('English'))
  })

  it('has all three strings for every language it claims to speak', () => {
    for (const lang of CREDENTIAL_LANGUAGES) {
      const c = credentialCopy(lang)
      for (const key of ['lead', 'body', 'action']) {
        expect(typeof c[key], `${lang}.${key}`).toBe('string')
        expect(c[key].trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
      // Plugin details is a screen name in the Stripo account, not prose.
      expect(c.body, lang).toContain('Plugin details')
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
      expect(CREDENTIAL_LANGUAGES).toContain(lang)
    }
  })
})

describe('empty-state suggestions — configured, with the built-in three as fallback', () => {
  const askAI = (suggestions) => ({
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
  // UI-SPEC §13 and read by AskAi.vue, but never put in the client object, so
  // the built-in fallback was the only branch that could run.
  it('reaches the client config at all', () => {
    expect(themeAskAI(askAI(['One?', 'Two?'])).suggestions).toEqual(['One?', 'Two?'])
  })

  it('falls back to the built-in three by returning empty, for [] and for absent', () => {
    expect(resolveSuggestions(askAI([]), quiet)).toEqual([])
    expect(resolveSuggestions(askAI(undefined), quiet)).toEqual([])
    expect(resolveSuggestions(askAI(null), quiet)).toEqual([])
  })

  it('trims, collapses inner whitespace and drops empties and repeats', () => {
    const w = collect()
    expect(resolveSuggestions(askAI(['  How   do I auth? ', 'How do I auth?', '   ', 'Real?']), w)).toEqual([
      'How do I auth?',
      'Real?',
    ])
    expect(w.messages.join(' ')).toMatch(/empty/)
    expect(w.messages.join(' ')).toMatch(/repeats/)
  })

  it('drops a non-string entry instead of rendering [object Object]', () => {
    const w = collect()
    expect(resolveSuggestions(askAI(['ok?', { label: 'x', question: 'y' }, 42]), w)).toEqual(['ok?'])
    expect(w.messages).toHaveLength(2)
  })

  it('falls back when the key is not an array at all', () => {
    const w = collect()
    expect(resolveSuggestions(askAI('How do I auth?'), w)).toEqual([])
    expect(w.messages[0]).toMatch(/must be an array/)
  })

  // "No silent caps" — the component slices at three either way; what is being
  // tested is that the author is told which two vanished.
  it('caps at three and names what it dropped', () => {
    const w = collect()
    const five = ['a?', 'b?', 'c?', 'd?', 'e?']
    expect(resolveSuggestions(askAI(five), w)).toEqual(['a?', 'b?', 'c?'])
    expect(w.messages[0]).toContain('"d?"')
    expect(w.messages[0]).toContain('"e?"')
  })
})
