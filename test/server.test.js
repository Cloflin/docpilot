/**
 * The server runtime — engine-spec 028.
 *
 * Driven against this repository's own committed index, so the pipeline under
 * test is the real one: the same manifest, shards and openers a deployment
 * reads. The model is a local OpenAI-shaped stub that cites the first chunk id
 * it was shown — enough to walk `runTurn` end to end without a network.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDocPilotServer, shellManifest } from '../src/server/index.js'
import { parseTurnInput } from '../src/server/input.js'
import { prune } from '../src/server/log.js'
import { sseParser } from '../src/theme/docpilot/remote.js'
import { resolveDocPilot, themeDocPilot } from '../src/config.js'

const INDEX = path.resolve('docs/public/rag')

async function events(response) {
  const out = []
  const feed = sseParser((event, data) => out.push({ event, data }))
  feed(await response.text())
  return out
}

const post = (body, endpoint = '/ai/turn') =>
  new Request(`http://docs.test${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('themeDocPilot under runtime: server', () => {
  it('ships no prompt, threshold, transport or budget to the page', () => {
    const out = themeDocPilot(
      resolveDocPilot({
        runtime: 'server',
        prompt: { extend: 'SECRET HOUSE STYLE' },
        guard: { tau: 0.42, mode: 'calibrated' },
        chat: { provider: 'openai' },
      }),
      { OPENAI_API_KEY: 'sk-test' },
    )
    expect(out.runtime).toBe('server')
    expect(out.server.endpoint).toBe('/ai/turn')
    expect(JSON.stringify(out)).not.toContain('SECRET HOUSE STYLE')
    expect(out.guard).toEqual({ mode: 'off' })
    expect(out.llm.provider).toBe(null)
    expect(out.llm.chain).toEqual([])
    expect(out.embed.provider).toBe(null)
  })

  it('leaves the browser runtime as it was, plus the two keys', () => {
    const out = themeDocPilot(resolveDocPilot({ prompt: { extend: 'x' } }))
    expect(out.runtime).toBe('browser')
    expect(out.prompt.extend).toBe('x')
  })

  it('refuses an unknown runtime and a cross-origin endpoint', () => {
    expect(() => themeDocPilot(resolveDocPilot({ runtime: 'edge' }))).toThrow(/runtime/)
    expect(() =>
      themeDocPilot(resolveDocPilot({ runtime: 'server', server: { endpoint: 'https://x.test/ai' } })),
    ).toThrow(/same-origin/)
  })
})

describe('parseTurnInput', () => {
  it('requires a question and clamps what it keeps', () => {
    expect(parseTurnInput({}).ok).toBe(false)
    expect(parseTurnInput({ question: 'q', history: 'x' }).ok).toBe(false)
    const { input } = parseTurnInput({
      question: 'q'.repeat(5000),
      history: Array.from({ length: 40 }, () => ({ question: 'a', gate: { channel: 'evil' } })),
      messageId: 'bad id with spaces',
    })
    expect(input.question.length).toBe(2000)
    expect(input.history).toHaveLength(12)
    expect(input.history[0].gate.channel).toBe(null)
    expect(input.messageId).toMatch(/^srv-/)
  })
})

describe('shellManifest', () => {
  it('keeps navigation and drops the server’s business', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(INDEX, 'manifest.json'), 'utf8'))
    const shell = shellManifest(manifest)
    expect(shell.pages.length).toBe(manifest.pages.length)
    for (const k of ['guard', 'tuning', 'vocabulary', 'shards', 'vectors', 'df', 'openers']) {
      expect(Object.hasOwn(shell, k), k).toBe(false)
    }
  })
})

describe('createDocPilotServer — search-only, no network', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-turns-'))
  let dp
  const ready = createDocPilotServer({
    settings: { chat: false, embed: false },
    env: {},
    index: INDEX,
    log: { dir: logDir },
  }).then((s) => (dp = s))

  it('serves the shell manifest and 404s everything else', async () => {
    await ready
    const res = await dp.handle(new Request('http://docs.test/ai/turn/manifest'))
    expect(res.status).toBe(200)
    expect((await res.json()).guard).toBeUndefined()
    expect((await dp.handle(new Request('http://docs.test/ai/v1/chat/completions'))).status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe(null)
  })

  it('answers a turn as a stream ending in one settle, and logs it', async () => {
    await ready
    const res = await dp.handle(post({ question: 'How do I build the index?', messageId: 'm-1', conversationId: 'c-1' }))
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const evs = await events(res)
    const settles = evs.filter((e) => e.event === 'settle')
    expect(settles).toHaveLength(1)
    expect(settles[0].data.outcome).toBe('results')
    expect(settles[0].data.results.length).toBeGreaterThan(0)
    const lines = fs
      .readdirSync(logDir)
      .flatMap((f) => fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n'))
      .map((l) => JSON.parse(l))
    const rec = lines.find((r) => r.messageId === 'm-1')
    expect(rec.kind).toBe('docpilot.turn')
    expect(rec.outcome).toBe('results')
    expect(rec.gate.G).not.toBe(undefined)
    expect(rec.retrievedIds.length).toBeGreaterThan(0)
    expect(rec).not.toHaveProperty('ip')
  })

  it('never logs a pasted key', async () => {
    await ready
    const evs = await events(
      await dp.handle(post({ question: 'my key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD', messageId: 'm-2' })),
    )
    expect(evs.find((e) => e.event === 'settle').data.outcome).toBe('credential')
    const all = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('')
    expect(all).not.toContain('sk-proj-')
  })

  it('names the bad field on a 400 and refuses a non-JSON content type', async () => {
    await ready
    const bad = await dp.handle(post({ question: '' }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/question/)
    const text = await dp.handle(
      new Request('http://docs.test/ai/turn', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
    )
    expect(text.status).toBe(415)
  })
})

describe('createDocPilotServer — a full turn against a stub model', () => {
  const calls = []
  const stub = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push(parsed)
      const seen = JSON.stringify(parsed.messages).match(/\\"id\\":\\"([^\\"]+)\\"/)
      const args = JSON.stringify({ text: 'Run npx docpilot index [1].', citations: seen ? [seen[1]] : [], confidence: 0.9 })
      const frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'answer', arguments: args } }] } }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
    })
  })
  const listening = new Promise((r) => stub.listen(0, '127.0.0.1', r))
  afterAll(() => stub.close())

  it('streams, settles with cited sources carrying their text, and keeps the prompt only when asked', async () => {
    await listening
    const base = `http://127.0.0.1:${stub.address().port}`
    const records = []
    const dp = await createDocPilotServer({
      settings: { chat: { provider: 'custom', model: 'stub', baseURL: base }, embed: false, budget: false },
      env: { CUSTOM_BASE_URL: base },
      index: INDEX,
      log: { write: (r) => records.push(r), prompts: true },
    })
    const evs = await events(await dp.handle(post({ question: 'How do I build the index?', messageId: 'm-3' })))
    const settle = evs.find((e) => e.event === 'settle')?.data
    expect(calls.length).toBeGreaterThan(0)
    expect(settle.outcome).toBe('answer')
    expect(settle.citations.length).toBe(1)
    expect(settle.sources[0].text.length).toBeGreaterThan(0)
    expect(settle.gate).not.toHaveProperty('G')
    expect(records[0].answer).toContain('docpilot index')
    expect(Array.isArray(records[0].messages)).toBe(true)
  })
})

describe('prune', () => {
  it('deletes only day files past the window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-prune-'))
    for (const d of ['2026-01-01', '2026-10-20', '2026-10-24']) fs.writeFileSync(path.join(dir, `turns-${d}.jsonl`), '')
    fs.writeFileSync(path.join(dir, 'notes.txt'), '')
    expect(prune(dir, 30, new Date('2026-10-24T12:00:00Z'))).toEqual(['turns-2026-01-01.jsonl'])
    expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'turns-2026-10-20.jsonl', 'turns-2026-10-24.jsonl'])
  })
})

describe('docpilot serve — the static half', () => {
  it('withholds every index directory and refuses to leave the root', async () => {
    const { indexDirsUnder, staticFile } = await import('../src/cli-serve.js')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-site-'))
    fs.mkdirSync(path.join(root, 'rag'))
    fs.writeFileSync(path.join(root, 'rag', 'manifest.json'), JSON.stringify({ shards: ['a.json'] }))
    fs.writeFileSync(path.join(root, 'index.html'), '<p>hi')
    fs.mkdirSync(path.join(root, 'guide'))
    fs.writeFileSync(path.join(root, 'guide', 'server.html'), '<p>x')
    expect(indexDirsUnder(root)).toEqual([path.resolve(root, 'rag')])
    expect(staticFile(root, '/guide/server')).toBe(path.join(path.resolve(root), 'guide', 'server.html'))
    expect(staticFile(root, '/')).toBe(path.join(path.resolve(root), 'index.html'))
    expect(staticFile(root, '/../../etc/passwd')).toBe(null)
  })

  /**
   * The refusal asks the filesystem, so no spelling of the path gets past it:
   * a case the disk folds (APFS, NTFS), a symlink, a dot-directory, any depth.
   */
  it('refuses an index file however the path is spelled', async () => {
    const { staticFile, inIndex } = await import('../src/cli-serve.js')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-site-'))
    const index = path.join(root, '.deep', 'a', 'b', 'c', 'rag')
    fs.mkdirSync(index, { recursive: true })
    fs.writeFileSync(path.join(index, 'manifest.json'), JSON.stringify({ shards: ['a.json'] }))
    fs.writeFileSync(path.join(index, 'a.json'), '[]')
    fs.writeFileSync(path.join(root, 'index.html'), '<p>hi')
    fs.symlinkSync(index, path.join(root, 'linked'))
    const served = (p) => {
      const file = staticFile(root, p)
      return Boolean(file) && !inIndex(root, file)
    }
    expect(served('/')).toBe(true)
    expect(served('/.deep/a/b/c/rag/manifest.json')).toBe(false)
    expect(served('/.deep/a/b/c/rag/a.json')).toBe(false)
    expect(served('/linked/a.json')).toBe(false)
    // Only a case-insensitive disk opens the wrong case at all; there it must
    // still be refused, and on Linux the path is simply not found.
    const folded = '/.DEEP/A/B/C/RAG/manifest.json'
    if (staticFile(root, folded)) expect(served(folded)).toBe(false)
    else expect(staticFile(root, folded)).toBe(null)
  })
})

/**
 * `node()` is mounted as `(req, res) => dp.node(req, res)` with the promise
 * dropped, so any throw is an unhandled rejection and the process stops. Each
 * of these used to be one.
 */
describe('createDocPilotServer — node() never throws', () => {
  let server
  let port
  const ready = createDocPilotServer({ settings: { chat: false, embed: false }, env: {}, index: INDEX }).then(
    (dp) =>
      new Promise((resolve) => {
        server = createServer((req, res) => {
          dp.node(req, res)
        }).listen(0, '127.0.0.1', () => {
          port = server.address().port
          resolve()
        })
      }),
  )
  afterAll(() => server?.close())

  /** One raw request, so the Host header and the method are exactly what is sent. */
  const raw = (text, { end = true } = {}) =>
    new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(text)
        if (!end) setTimeout(() => sock.destroy(), 50)
      })
      let got = ''
      sock.on('data', (c) => (got += c))
      sock.on('close', () => resolve(got))
      sock.on('error', () => {})
    })

  it('answers a Host that is not a URL with 400', async () => {
    await ready
    const got = await raw('GET /ai/turn/manifest HTTP/1.1\r\nHost: x:99999\r\nConnection: close\r\n\r\n')
    expect(got).toMatch(/^HTTP\/1\.1 400/)
  })

  it('answers TRACE with 405 rather than throwing in new Request', async () => {
    await ready
    const got = await raw('TRACE /ai/turn HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    expect(got).toMatch(/^HTTP\/1\.1 405/)
  })

  it('survives a body cut off mid-upload and keeps answering', async () => {
    await ready
    await raw(
      'POST /ai/turn HTTP/1.1\r\nHost: localhost\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{"q',
      { end: false },
    )
    const got = await raw('GET /ai/turn/manifest HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    expect(got).toMatch(/^HTTP\/1\.1 200/)
  })
})

/**
 * Two refusals Ollama spells in its own words, found running the server runtime
 * against local models (gemma3:4b, phi4:14b, llama3.2:3b) — both were failing
 * every turn in either runtime.
 */
describe('local models — what Ollama refuses, and the concession that answers it', () => {
  const realFetch = globalThis.fetch
  afterAll(() => (globalThis.fetch = realFetch))

  it('detectTools reads "does not support tools" as a model without tools, not as no answer', async () => {
    const { detectTools } = await import('../src/theme/docpilot/llm.js')
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'registry.ollama.ai/library/gemma3:4b does not support tools' }), { status: 400 })
    expect(await detectTools({ provider: 'ollama', baseURL: 'http://h', model: 'gemma3:4b' })).toBe(false)
    globalThis.fetch = async () => new Response('down', { status: 503 })
    expect(await detectTools({ provider: 'ollama', baseURL: 'http://h', model: 'x' })).toBe(null)
  })

  it('a model that refuses thinking is asked again with think: false', async () => {
    const { chat, resetCaps } = await import('../src/theme/docpilot/llm.js')
    resetCaps()
    const sent = []
    globalThis.fetch = async (_u, init) => {
      const body = JSON.parse(init.body)
      sent.push(body.think)
      if (body.think === true) return new Response(JSON.stringify({ error: '"llama3.2:3b" does not support thinking' }), { status: 400 })
      return new Response(JSON.stringify({ message: { content: '{"text":"hi"}' } }), { status: 200 })
    }
    const reply = await chat({
      provider: 'ollama',
      baseURL: 'http://h',
      model: 'llama3.2:3b',
      messages: [{ role: 'user', content: 'hi' }],
      schema: { type: 'object' },
      enableThink: true,
    })
    expect(sent).toEqual([true, false])
    expect(JSON.stringify(reply)).toContain('hi')
  })
})
