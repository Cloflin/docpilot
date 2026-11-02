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
import { describe, it, expect } from 'vitest'
import { providerFor } from '../src/theme/docpilot/providers.js'

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

describe('no other adapter gets a cache field it did not have', () => {
  const NONE = /cache_control|prompt_cache_key/
  it.each(['ollama', 'openai', 'llamacpp'])('%s', (id) => {
    const body = providerFor(id).body({ ...CALL, tools: TOOLS })
    expect(JSON.stringify(body)).not.toMatch(NONE)
    expect(JSON.stringify(providerFor(id).body({ ...CALL, schemaBody: SCHEMA }))).not.toMatch(NONE)
  })
})
