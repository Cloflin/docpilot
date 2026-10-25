/**
 * runServerTurn — what the server sends where (security report F5).
 *
 * A provider key is an account at ONE provider. The embed half must reach its
 * own host with its own key or with none — never with the chat half's.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:http'
import path from 'node:path'

import { readIndexDir } from '../src/server/index.js'
import { runServerTurn } from '../src/server/turn.js'

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
