/**
 * Prompt caching on the wire.
 *
 * WHAT THIS SUITE PREVENTS. A cache hint that goes to a host that rejects it, so
 * a reader's question pays for the lesson, and a hint that quietly changes what
 * the model reads. The rule for each service is in `prompt-cache.ts`; here every
 * case is a request body built by calling `body()` directly, with no network.
 *
 * NO PROMPT TEXT MOVES. Every case compares the text that goes out with the text
 * that went in.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { providerFor } from '../src/theme/docpilot/providers.js'
import { chat, resetCaps, resetPools } from '../src/theme/docpilot/llm.js'

const SYSTEM = 'You answer from the documentation excerpts only.'
const MESSAGES = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: 'What is the gate?' },
]
const CALL = { model: 'm', messages: MESSAGES, temperature: 0.2, streaming: true, maxTokens: 2048 }
const TOOLS = [
  { type: 'function', function: { name: 'search_docs', description: 'Search.', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
  { type: 'function', function: { name: 'fetch_section', description: 'Fetch.', parameters: { type: 'object', properties: { id: { type: 'string' } } } } },
]
const SCHEMA = { type: 'object', properties: { text: { type: 'string' } } }
const EPHEMERAL = { type: 'ephemeral' }

const anthropicBody = (over = {}) => providerFor('anthropic').body({ ...CALL, ...over })

/** A Response whose body streams the given server-sent events. */
const sse = (events) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
        controller.close()
      },
    }),
  )

describe('anthropic — the system block and the last tool carry the marker', () => {
  it('sends the system text as one block with cache_control, unchanged', () => {
    const body = anthropicBody()
    expect(body.system).toEqual([{ type: 'text', text: SYSTEM, cache_control: EPHEMERAL }])
    expect(body.messages).toEqual([{ role: 'user', content: 'What is the gate?' }])
  })

  it('joins several system messages into the one block, as it always joined them', () => {
    const body = anthropicBody({
      messages: [{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'q' }],
    })
    expect(body.system).toEqual([{ type: 'text', text: 'A\n\nB', cache_control: EPHEMERAL }])
  })

  it('sends no system field at all when there is no system text', () => {
    expect('system' in anthropicBody({ messages: [{ role: 'user', content: 'q' }] })).toBe(false)
  })

  it('marks only the LAST tool of a tool list', () => {
    const { tools } = anthropicBody({ tools: TOOLS })
    expect(tools.map((t) => t.name)).toEqual(['search_docs', 'fetch_section'])
    expect(tools[0]).not.toHaveProperty('cache_control')
    expect(tools[1].cache_control).toEqual(EPHEMERAL)
  })

  it('marks the forced answer tool when the final call pins a shape', () => {
    const body = anthropicBody({ schemaBody: SCHEMA })
    expect(body.tools).toEqual([
      { name: 'answer', description: 'Deliver the final answer.', input_schema: SCHEMA, cache_control: EPHEMERAL },
    ])
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'answer' })
  })

  it('sends no tools and no marker on a request that has none', () => {
    expect('tools' in anthropicBody()).toBe(false)
  })

  it('marks a copy: the harness list is shared and must not be changed', () => {
    const before = JSON.stringify(TOOLS)
    anthropicBody({ tools: TOOLS })
    anthropicBody({ tools: TOOLS })
    expect(JSON.stringify(TOOLS)).toBe(before)
    // Two requests from the same list are the same request.
    expect(anthropicBody({ tools: TOOLS })).toEqual(anthropicBody({ tools: TOOLS }))
  })

  it('keeps extraBody below the adapter: it cannot replace system or tools', () => {
    const body = anthropicBody({
      tools: TOOLS,
      extraBody: { system: 'from the config', tools: [], metadata: { user_id: 'u' } },
    })
    expect(body.system[0].text).toBe(SYSTEM)
    expect(body.tools).toHaveLength(2)
    expect(body.metadata).toEqual({ user_id: 'u' })
  })
})

describe('anthropic — the prompt total counts what was written and what was read', () => {
  const adapter = providerFor('anthropic')

  it('adds cache_creation and cache_read to input_tokens, and keeps cachedTokens as the reads', () => {
    const { usage } = adapter.parse({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 2000, output_tokens: 40 },
    })
    expect(usage).toEqual({ promptTokens: 2312, outputTokens: 40, cachedTokens: 2000 })
  })

  it('is the old number when the response reports no cache fields', () => {
    const { usage } = adapter.parse({ content: [], usage: { input_tokens: 500, output_tokens: 9 } })
    expect(usage).toEqual({ promptTokens: 500, outputTokens: 9, cachedTokens: null })
  })

  it('reports a first request that only wrote the cache', () => {
    const { usage } = adapter.parse({
      content: [],
      usage: { input_tokens: 8, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0, output_tokens: 3 },
    })
    expect(usage).toEqual({ promptTokens: 1508, outputTokens: 3, cachedTokens: 0 })
  })

  it('does the same from the stream: message_start carries the prompt, message_delta the output', async () => {
    const res = sse([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 } },
      },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
    ])
    const out = await adapter.readStream(res, () => {})
    expect(out.content).toBe('hi')
    expect(out.usage).toEqual({ promptTokens: 2110, outputTokens: 5, cachedTokens: 2000 })
  })

  it('keeps a stream with no cache fields at the old numbers', async () => {
    const res = sse([
      { type: 'message_start', message: { usage: { input_tokens: 77 } } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ])
    const out = await adapter.readStream(res, () => {})
    expect(out.usage).toEqual({ promptTokens: 77, outputTokens: 2, cachedTokens: null })
  })
})

// ── openai ──────────────────────────────────────────────────────────────────

const openaiBody = (over = {}) => providerFor('openai').body({ ...CALL, baseURL: 'https://api.openai.com', ...over })
const KEY = /^dp-[0-9a-f]{14}$/

describe('openai — prompt_cache_key, on api.openai.com only', () => {
  it('sends a key made of the system text and the tool schemas', () => {
    const key = openaiBody({ tools: TOOLS }).prompt_cache_key
    expect(key).toMatch(KEY)
    expect(openaiBody({ tools: TOOLS }).prompt_cache_key).toBe(key)
  })

  it('changes when the system text changes, and when the tools change', () => {
    const base = openaiBody({ tools: TOOLS }).prompt_cache_key
    const otherSystem = openaiBody({
      tools: TOOLS,
      messages: [{ role: 'system', content: `${SYSTEM} Be brief.` }, MESSAGES[1]],
    }).prompt_cache_key
    const otherTools = openaiBody({ tools: TOOLS.slice(0, 1) }).prompt_cache_key
    expect(new Set([base, otherSystem, otherTools]).size).toBe(3)
  })

  it('does not change with the question, the quote or the history', () => {
    const key = openaiBody({ tools: TOOLS }).prompt_cache_key
    const later = openaiBody({
      tools: TOOLS,
      messages: [
        MESSAGES[0],
        { role: 'user', content: 'An earlier question about my private deployment' },
        { role: 'assistant', content: 'An earlier answer' },
        { role: 'user', content: 'A different question, with a quote: "secret"' },
      ],
    }).prompt_cache_key
    expect(later).toBe(key)
  })

  it('carries none of the text it was made from', () => {
    const key = openaiBody({ tools: TOOLS }).prompt_cache_key
    for (const word of ['documentation', 'excerpts', 'search_docs', 'gate']) expect(key).not.toContain(word)
  })

  it('writes no key when there is no system text', () => {
    expect('prompt_cache_key' in openaiBody({ messages: [{ role: 'user', content: 'q' }] })).toBe(false)
  })

  it('leaves the prompt and the rest of the body as they were', () => {
    const { prompt_cache_key, ...rest } = openaiBody({ tools: TOOLS })
    expect(prompt_cache_key).toMatch(KEY)
    expect(rest).toEqual(providerFor('openai').body({ ...CALL, tools: TOOLS }))
  })

  it.each([
    ['OpenRouter', 'https://openrouter.ai/api'],
    ['Ollama', 'http://localhost:11434'],
    ['Groq', 'https://api.groq.com/openai'],
    ['Together', 'https://api.together.xyz'],
    ['a same-origin proxy', '/ai'],
    ['a lookalike host', 'https://api.openai.com.evil.test'],
    ['a path that only names it', 'https://proxy.example/api.openai.com'],
    ['an Azure gateway', 'https://x.openai.azure.com/openai'],
    ['not a URL', 'api.openai.com'],
    ['nothing', undefined],
  ])('sends nothing to %s', (_name, baseURL) => {
    expect('prompt_cache_key' in openaiBody({ tools: TOOLS, baseURL })).toBe(false)
  })

  it('reads the host the way a URL does: case and port do not matter', () => {
    expect(openaiBody({ baseURL: 'https://API.OpenAI.com:443/v1' }).prompt_cache_key).toMatch(KEY)
  })

  it('wins over extraBody on api.openai.com, and leaves extraBody alone elsewhere', () => {
    const extraBody = { prompt_cache_key: 'mine', user: 'u' }
    const there = openaiBody({ extraBody })
    expect(there.prompt_cache_key).toMatch(KEY)
    expect(there.user).toBe('u')
    expect(openaiBody({ extraBody, baseURL: 'https://api.groq.com/openai' }).prompt_cache_key).toBe('mine')
  })
})

// ── openrouter + an Anthropic model ─────────────────────────────────────────

const OPENROUTER = 'https://openrouter.ai/api'
const viaOpenRouter = (model, over = {}) => openaiBody({ baseURL: OPENROUTER, model, ...over })

describe('openrouter with an anthropic/* model — the system message becomes a marked part', () => {
  it('sends the system text as one part with cache_control on the last part', () => {
    const body = viaOpenRouter('anthropic/claude-sonnet-4')
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: SYSTEM, cache_control: EPHEMERAL }],
    })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'What is the gate?' })
  })

  it('does not send the OpenAI key to OpenRouter, and changes nothing else', () => {
    const marked = viaOpenRouter('anthropic/claude-sonnet-4', { tools: TOOLS })
    expect(marked).not.toHaveProperty('prompt_cache_key')
    const { messages: sent, ...rest } = marked
    const { messages: plain, ...restPlain } = viaOpenRouter('openai/gpt-x', { tools: TOOLS })
    expect(rest).toEqual({ ...restPlain, model: 'anthropic/claude-sonnet-4' })
    expect(sent).toHaveLength(plain.length)
  })

  it('marks the last system message when there are several', () => {
    const body = viaOpenRouter('anthropic/claude-haiku', {
      messages: [{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'q' }],
    })
    expect(body.messages[0]).toEqual({ role: 'system', content: 'A' })
    expect(body.messages[1]).toEqual({ role: 'system', content: [{ type: 'text', text: 'B', cache_control: EPHEMERAL }] })
  })

  it('marks a copy: the harness message list is not changed', () => {
    const before = JSON.stringify(MESSAGES)
    viaOpenRouter('anthropic/claude-sonnet-4')
    expect(JSON.stringify(MESSAGES)).toBe(before)
  })

  it('leaves a request with no system message exactly as it was', () => {
    const messages = [{ role: 'user', content: 'q' }]
    expect(viaOpenRouter('anthropic/claude-sonnet-4', { messages }).messages).toEqual(messages)
  })

  it.each([
    ['an OpenAI model', 'openai/gpt-x'],
    ['a Meta model', 'meta-llama/llama-3.3-70b-instruct:free'],
    ['the free router', 'openrouter/free'],
    ['a model that only mentions it', 'someone/anthropic/x'],
    ['an empty model', ''],
  ])('sends the plain string for %s', (_name, model) => {
    expect(viaOpenRouter(model).messages[0]).toEqual({ role: 'system', content: SYSTEM })
  })

  it.each([
    ['api.openai.com', 'https://api.openai.com'],
    ['Groq', 'https://api.groq.com/openai'],
    ['a proxy', 'https://proxy.example/ai'],
    ['a lookalike', 'https://openrouter.ai.evil.test/api'],
    ['nothing', undefined],
  ])('sends the plain string to %s even for an anthropic/* model name', (_name, baseURL) => {
    expect(openaiBody({ baseURL, model: 'anthropic/claude-sonnet-4' }).messages[0]).toEqual({ role: 'system', content: SYSTEM })
  })

  it('keeps the observation fix: a tool message still travels as a user message', () => {
    const body = viaOpenRouter('anthropic/claude-sonnet-4', {
      messages: [...MESSAGES, { role: 'tool', content: 'excerpt' }],
    })
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'excerpt' })
  })
})

// ── through chat(): the base URL has to reach the adapter ───────────────────

/** What chat() posts to `baseURL`, with `fetch` replaced. */
async function posted(options) {
  const seen = []
  vi.stubGlobal('fetch', async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: '{"text":"x"}' }, finish_reason: 'stop' }],
        content: [{ type: 'text', text: '{"text":"x"}' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
      }),
    }
  })
  resetCaps()
  resetPools()
  await chat({ apiKey: 'k', temperature: 0, messages: MESSAGES, tools: true, ...options })
  return seen[0]
}

describe('chat() hands the adapter the base URL it is about to post to', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('api.openai.com gets the key', async () => {
    const r = await posted({ provider: 'openai', baseURL: 'https://api.openai.com', model: 'gpt-x' })
    expect(r.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(r.body.prompt_cache_key).toMatch(KEY)
    expect(r.body.messages[0]).toEqual({ role: 'system', content: SYSTEM })
  })

  it('another OpenAI-shaped host does not', async () => {
    const r = await posted({ provider: 'openai', baseURL: 'https://api.groq.com/openai', model: 'm' })
    expect(r.body).not.toHaveProperty('prompt_cache_key')
  })

  it('OpenRouter with an anthropic/* model gets the marked system part, and with another model the string', async () => {
    const a = await posted({ provider: 'openai', baseURL: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4' })
    expect(a.body.messages[0].content).toEqual([{ type: 'text', text: SYSTEM, cache_control: EPHEMERAL }])
    expect(a.body).not.toHaveProperty('prompt_cache_key')
    const b = await posted({ provider: 'openai', baseURL: 'https://openrouter.ai/api', model: 'openai/gpt-x' })
    expect(b.body.messages[0].content).toBe(SYSTEM)
  })

  it('anthropic is marked whatever the host is', async () => {
    const r = await posted({ provider: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-x' })
    expect(r.url).toBe('https://api.anthropic.com/v1/messages')
    expect(r.body.system).toEqual([{ type: 'text', text: SYSTEM, cache_control: EPHEMERAL }])
    expect(r.body.tools.at(-1).cache_control).toEqual(EPHEMERAL)
  })
})

describe('no other adapter gets a cache field it did not have', () => {
  const NONE = /cache_control|prompt_cache_key/
  it.each(['ollama', 'openai', 'llamacpp'])('%s, with no base URL to judge by', (id) => {
    const body = providerFor(id).body({ ...CALL, tools: TOOLS })
    expect(JSON.stringify(body)).not.toMatch(NONE)
    expect(JSON.stringify(providerFor(id).body({ ...CALL, schemaBody: SCHEMA }))).not.toMatch(NONE)
  })

  it('ollama gets none even when the host is OpenAI\'s', () => {
    expect(JSON.stringify(providerFor('ollama').body({ ...CALL, tools: TOOLS, baseURL: 'https://api.openai.com' }))).not.toMatch(NONE)
  })
})
