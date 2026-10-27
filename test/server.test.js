/**
 * The server runtime — engine-spec 028.
 *
 * Driven against this repository's own committed index, so the pipeline under
 * test is the real one: the same manifest, shards and openers a deployment
 * reads. The model is a local OpenAI-shaped stub that cites the first chunk id
 * it was shown — enough to walk `runTurn` end to end without a network.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { createServer } from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDocPilotServer, shellManifest } from '../src/server/index.js'
import { parseTurnInput } from '../src/server/input.js'
import { prune } from '../src/server/log.js'
import { signAnswer, verifyAnswer } from '../src/server/sign.js'
import { sseParser } from '../src/theme/docpilot/remote.js'
import { createHistory } from '../src/theme/docpilot/history.js'
import * as session from '../src/theme/docpilot/session.js'
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

/**
 * THE PANEL'S SSE FRAMING. A separator is two line ends and each is `\n` or
 * `\r\n` on its own, so a hop that rewrites line ends can hand the panel either
 * mixed form. The server writes LF; the other three are what a proxy may send.
 * Fed whole, a character at a time, and split at every offset, because the
 * search resumes across chunks rather than rescanning.
 */
describe('sseParser', () => {
  const WANT = [
    { event: 'delta', data: { text: 'a' } },
    { event: 'message', data: { n: 2 } },
    { event: 'settle', data: { ok: true } },
  ]
  // The last event names itself LAST: a cut one character short leaves a `\r`
  // that `JSON.parse` forgives in `data` and an event name keeps.
  const stream = (eol, sep) =>
    `event: delta${eol}data: {"text":"a"}${sep}: keep-alive${sep}data: {"n":2}${sep}data: {"ok":true}${eol}event: settle${sep}`
  const parse = (chunks) => {
    const out = []
    const feed = sseParser((event, data) => out.push({ event, data }))
    for (const c of chunks) feed(c)
    return out
  }

  it.each([
    ['LF', '\n', '\n\n'],
    ['CRLF', '\r\n', '\r\n\r\n'],
    ['CRLF then LF', '\r\n', '\r\n\n'],
    ['LF then CRLF', '\n', '\n\r\n'],
  ])('reads %s separators, however the stream is chunked', (_, eol, sep) => {
    const s = stream(eol, sep)
    expect(parse([s])).toEqual(WANT)
    expect(parse([...s])).toEqual(WANT)
    for (let i = 1; i < s.length; i++) expect(parse([s.slice(0, i), s.slice(i)]), `split at ${i}`).toEqual(WANT)
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
  // After EACH test, not once after the describe: every case here assigns its
  // own `fetch`, and until the describe ended the global stayed whatever the
  // last assignment was — a case that reads `fetch` before it assigns one would
  // have run against another case's stub.
  const realFetch = globalThis.fetch
  afterEach(() => (globalThis.fetch = realFetch))

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

/**
 * THE PANEL'S HALF — `submitRemote`, driven through `session.submit`.
 *
 * Everything above is the server; this is what the panel makes of the stream it
 * writes. `fetch` answers the way `createDocPilotServer` does: a `: ping`
 * comment, one `event:`/`data:` frame per enqueue, the settle last — or the
 * limiter's 429, whose body is the panel's own rate-limited shape. Every case
 * ends on `busy`, because a turn that never lets go of it is a panel that takes
 * no further question until the tab is reloaded.
 */
describe('the panel’s half — a turn the server runs', () => {
  const SECRET = 'test-secret'
  const encoder = new TextEncoder()
  const frame = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const fake = () => {
    const m = new Map()
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
  }
  const CHUNK = { id: 'a#x', path: '/a', anchor: 'x', title: 'Tokens', breadcrumb: 'Docs', text: 'The alpha widget takes a token.' }
  const TEXT = 'Pass the token in a header [1].'

  // Each request as the server received it, and the server's verdict on every
  // prior answer it carried — `runServerTurn`'s own `trusted` line.
  let sent
  let reply

  /** A stream as the server writes it; `hold` keeps it open until the turn is aborted. */
  const stream = (init, events, { hold = false } = {}) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(': ping\n\n'))
          for (const [event, data] of events) c.enqueue(frame(event, data))
          if (!hold) return c.close()
          init.signal.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')), {
            once: true,
          })
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )

  /** The answer `runServerTurn` settles with, signed the way it signs one. */
  const answered = (body) => ({
    outcome: 'answer',
    text: TEXT,
    summary: null,
    citations: [CHUNK.id],
    sources: [CHUNK],
    actions: [],
    gate: { pass: true, mode: 'lexical-only', channel: 'raw' },
    think: '',
    sig: signAnswer(SECRET, { conversationId: body.conversationId, question: body.question, answer: TEXT, citations: [CHUNK.id] }),
  })

  beforeEach(() => {
    sent = []
    reply = (body, init) => stream(init, [['phase', { phase: 'searching' }], ['settle', answered(body)]])
    vi.stubGlobal('fetch', async (url, init) => {
      if (String(url).endsWith('/manifest')) {
        return new Response(JSON.stringify({ hash: 'h', pages: [{ path: '/a', title: 'Alpha' }], sections: [] }), { status: 200 })
      }
      const body = JSON.parse(init.body)
      sent.push({ body, trusted: body.history.map((t) => verifyAnswer(SECRET, body.conversationId, t)) })
      return reply(body, init)
    })
    session.__setHistoryForTests(createHistory({ local: fake(), session: fake() }))
    session.configure({ docPilot: themeDocPilot(resolveDocPilot({ runtime: 'server' })) }, '/a', 'en')
    Object.assign(session.state, { index: null, degraded: false, busy: false, turns: [], conversationId: null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    session.__setHistoryForTests(null)
    session.state.index = null
  })

  it('settles an answer with its sources, and lets go of the panel', async () => {
    await session.submit('how do I pass the token')
    const turn = session.state.turns.at(-1)
    expect(turn.state).toBe('complete')
    expect(turn.answerText).toBe(TEXT)
    expect(turn.sources.map((s) => s.href)).toEqual(['/a#x'])
    expect(turn.answerHtml).toContain('href="/a#x"')
    expect(turn.answerSig).toBe(answered(sent[0].body).sig)
    expect(session.state.busy).toBe(false)
  })

  /**
   * engine-spec 033: the MAC covers the conversation id. Turn 1 used to go out
   * under its own message id and turn 2 under the archive's, so the server
   * demoted the first answer of every conversation to a quote.
   */
  it('sends one conversation id from the first turn, so turn 1’s answer still verifies on turn 2', async () => {
    await session.submit('how do I pass the token')
    await session.submit('and where does it go')
    const [one, two] = sent
    expect(one.body.conversationId).toMatch(/^c_/)
    expect(two.body.conversationId).toBe(one.body.conversationId)
    expect(two.trusted).toEqual([true])
    // The archive keeps the id it was handed, so a reload sends it too.
    expect(session.state.conversationId).toBe(one.body.conversationId)
  })

  /**
   * engine-spec 033, after the thread is reopened. The MAC covers `citations` as
   * the server sent them; a restore derived them from the deduplicated source
   * rows instead, so an answer that cited one section twice came back with one
   * id and failed its MAC on every follow-up.
   */
  it('sends the citations it was signed with after the thread is reopened', async () => {
    const TWICE = 'Pass the token [1], in a header [2].'
    const cited = [CHUNK.id, CHUNK.id]
    reply = (body, init) =>
      stream(init, [
        [
          'settle',
          {
            ...answered(body),
            text: TWICE,
            citations: cited,
            sig: signAnswer(SECRET, { conversationId: body.conversationId, question: body.question, answer: TWICE, citations: cited }),
          },
        ],
      ])
    await session.submit('how do I pass the token')
    const id = session.state.conversationId
    // One row for the two citations — the dedupe that loses the second id.
    expect(session.state.turns[0].sources).toHaveLength(1)

    // A reload: an empty panel, and the thread back from the archive.
    session.state.turns = []
    session.openConversation(id)
    expect(session.state.turns[0].restored).toBe(true)

    reply = (body, init) => stream(init, [['settle', answered(body)]])
    await session.submit('and where does it go')
    expect(sent.at(-1).body.history[0].citations).toEqual(cited)
    expect(sent.at(-1).trusted).toEqual([true])
  })

  it('ends the turn on a settle it cannot read, rather than staying busy', async () => {
    reply = (body, init) => stream(init, [['settle', { ...answered(body), sources: [null] }]])
    await expect(session.submit('how do I pass the token')).resolves.toBeUndefined()
    expect(session.state.turns.at(-1).state).toBe('error')
    expect(session.state.busy).toBe(false)

    // And the panel takes the next question.
    reply = (body, init) => stream(init, [['settle', answered(body)]])
    await session.submit('and where does it go')
    expect(sent).toHaveLength(2)
    expect(session.state.turns.at(-1).state).toBe('complete')
  })

  it('keeps what was painted when the reader stops the stream', async () => {
    reply = (body, init) => stream(init, [['stream', { start: true }], ['stream', { text: 'Pass the token' }]], { hold: true })
    const done = session.submit('how do I pass the token')
    await vi.waitFor(() => expect(session.state.turns.at(-1)?.answerText).toBe('Pass the token'))
    session.stop()
    await done
    const turn = session.state.turns.at(-1)
    expect(turn.state).toBe('aborted')
    expect(turn.answerHtml).toContain('Pass the token')
    expect(session.state.busy).toBe(false)
  })

  it('lands the limiter’s 429 on the rate-limited state, with the time answers resume', async () => {
    const resetAt = Date.now() + 60_000
    reply = () =>
      new Response(JSON.stringify({ error: 'rate limited', rateLimit: { resetAt, limit: null } }), {
        status: 429,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    await session.submit('how do I pass the token')
    const turn = session.state.turns.at(-1)
    expect(turn.state).toBe('rate-limited')
    expect(turn.rateLimit.resetAt).toBe(resetAt)
    expect(session.resetLine(turn)).not.toBe('')
    expect(session.state.busy).toBe(false)
  })
})
