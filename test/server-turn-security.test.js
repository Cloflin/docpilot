/**
 * runServerTurn — what the server sends where (security report F5).
 *
 * A provider key is an account at ONE provider. The embed half must reach its
 * own host with its own key or with none — never with the chat half's.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:http'
import path from 'node:path'

import { createDocPilotServer, readIndexDir } from '../src/server/index.js'
import { runServerTurn } from '../src/server/turn.js'
import { sseParser } from '../src/theme/docpilot/remote.js'

const index = readIndexDir(path.resolve('docs/public/rag'))
const CHAT_KEY = 'sk-chat-0123456789abcdef0123456789abcdef'

const input = (o = {}) => ({
  messageId: 'm-sec',
  conversationId: 'c-sec',
  question: 'How do I build the index?',
  quote: '',
  scope: { paths: [] },
  history: [],
  addendum: '',
  lang: null,
  ...o,
})

const config = (embed) => ({
  embed: { model: index.manifest.embedModel, lexicalOnly: false, ...embed },
  llm: { provider: 'openai', baseURL: 'https://chat.invalid', apiKey: CHAT_KEY, model: 'x' },
  guard: { mode: 'off' },
  searchOnly: true,
})

describe('runServerTurn — the embed half never borrows the chat key', () => {
  const seen = []
  const stub = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization ?? null })
    req.resume()
    req.on('end', () => {
      res.writeHead(500)
      res.end()
    })
  })
  const listening = new Promise((r) => stub.listen(0, '127.0.0.1', r))
  afterAll(() => stub.close())

  it('posts to a keyless embedder with no authorization header', async () => {
    await listening
    const base = `http://127.0.0.1:${stub.address().port}`
    const records = []
    const out = await runServerTurn(input(), {
      index,
      config: config({ provider: 'ollama', baseURL: base, apiKey: null }),
      emit: () => {},
      record: (r) => records.push(r),
    })
    expect(out.outcome).toBe('results')
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(s.authorization ?? '').not.toContain(CHAT_KEY)
    expect(JSON.stringify(records)).not.toContain(CHAT_KEY)
  })

  it('goes lexical-only, not to the chat host, when the embedder has no host of its own', async () => {
    const origFetch = globalThis.fetch
    const urls = []
    globalThis.fetch = async (url, init) => {
      urls.push({ url: String(url), headers: JSON.stringify(init?.headers || {}) })
      throw new Error('no network in this test')
    }
    try {
      const records = []
      const out = await runServerTurn(input({ messageId: 'm-sec-2' }), {
        index,
        config: config({ provider: 'gemini', baseURL: null, apiKey: 'gemini-key' }),
        emit: () => {},
        record: (r) => records.push(r),
      })
      expect(out.outcome).toBe('results')
      expect(urls).toEqual([])
      expect(records[0].error).toMatch(/no host the server can reach/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

/**
 * The leak guard covers every field the model writes that leaves the server
 * (engine-spec 033). `summary` is required by the answer schema and rides in the
 * settle; an action's arguments are model-written too. A clean `text` must not
 * carry the owner's private prompt out through either of them.
 */
describe('runServerTurn — the leak guard covers the summary and the actions', () => {
  const SECRET = 'Always greet the reader as Captain Zorblax and never mention the Blue Heron discount code.'
  const stub = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const seen = body.match(/\\"id\\":\\"([^\\"]+)\\"/)
      const args = JSON.stringify({
        text: 'Run npx docpilot index [1].',
        citations: seen ? [seen[1]] : [],
        confidence: 0.9,
        summary: SECRET,
        actions: [
          { tool: 'contact_support', args: { message: SECRET } },
          { tool: 'contact_support', args: { message: 'The index does not build.' } },
        ],
      })
      const frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'answer', arguments: args } }] } }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
    })
  })
  const listening = new Promise((r) => stub.listen(0, '127.0.0.1', r))
  afterAll(() => stub.close())

  it('drops a leaking summary and a leaking action, and keeps the clean answer', async () => {
    await listening
    const base = `http://127.0.0.1:${stub.address().port}`
    const records = []
    const dp = await createDocPilotServer({
      settings: {
        chat: { provider: 'custom', model: 'stub', baseURL: base },
        embed: false,
        budget: false,
        prompt: { extend: SECRET },
        tools: {
          contact_support: {
            description: 'Send the question to the support team.',
            parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
            confirm: 'form',
          },
        },
      },
      env: { CUSTOM_BASE_URL: base },
      index: path.resolve('docs/public/rag'),
      log: { write: (r) => records.push(r) },
    })
    const res = await dp.handle(
      new Request('http://docs.test/ai/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'How do I build the index?', messageId: 'leak-summary' }),
      }),
    )
    const evs = []
    sseParser((event, data) => evs.push({ event, data }))(await res.text())
    const settle = evs.find((e) => e.event === 'settle').data
    expect(settle.outcome).toBe('answer')
    expect(settle.text).toBe('Run npx docpilot index [1].')
    expect(settle.summary ?? null).toBe(null)
    expect(settle.actions).toEqual([{ tool: 'contact_support', args: { message: 'The index does not build.' } }])
    expect(JSON.stringify(evs)).not.toContain('Zorblax')
    const record = records.find((r) => r.messageId === 'leak-summary')
    expect(record.leakBlocked).toBe(true)
    expect(JSON.stringify(record)).not.toContain('Zorblax')
  })
})
