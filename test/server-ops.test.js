/**
 * The server's operator half — engine-specs 031 and 033: what it measures, what
 * it refuses, what it remembers and when it gives up.
 *
 * Driven like `server.test.js`: this repository's committed index and a local
 * OpenAI-shaped stub that answers with the first chunk id it was shown, so a
 * turn walks the real pipeline end to end with no network.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:http'
import path from 'node:path'

import { createDocPilotServer, readCapped } from '../src/server/index.js'
import { createLimiter, clientKey, isLoopback } from '../src/server/limits.js'
import { createMetrics, quantile } from '../src/server/metrics.js'
import { createLru, answerKey } from '../src/server/cache.js'
import { resolveServerOptions } from '../src/server/options.js'
import { observedOf, serverRows } from '../src/eval/server-eval.js'
import { sseParser } from '../src/theme/docpilot/remote.js'

const INDEX = path.resolve('docs/public/rag')

async function events(response) {
  const out = []
  const feed = sseParser((event, data) => out.push({ event, data }))
  feed(await response.text())
  return out
}

const post = (body, headers = {}) =>
  new Request('http://docs.test/ai/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

/** An OpenAI-shaped stub; `delayMs` holds every answer back. */
function stubModel({ delayMs = 0 } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push(parsed)
      const seen = JSON.stringify(parsed.messages).match(/\\"id\\":\\"([^\\"]+)\\"/)
      const args = JSON.stringify({ text: 'Run npx docpilot index [1].', citations: seen ? [seen[1]] : [], confidence: 0.9 })
      const frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'answer', arguments: args } }] } }] }
      setTimeout(() => {
        if (res.destroyed) return
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
      }, delayMs)
    })
  })
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r)).then(() => `http://127.0.0.1:${server.address().port}`)
  return { calls, ready, close: () => server.close() }
}

const chatOf = (base) => ({ chat: { provider: 'custom', model: 'stub', baseURL: base }, embed: false, budget: false })

describe('resolveServerOptions', () => {
  it('ships limits, a deadline and the vector cache on, and the answer cache off', () => {
    const o = resolveServerOptions({}, {})
    expect(o.limits).toMatchObject({ perMinute: 10, perDay: 500 })
    expect(o.turnTimeoutMs).toBe(300000)
    expect(o.cache.embeddings).toBe(1000)
    expect(o.cache.answers).toBe(false)
    expect(o.metrics).toEqual({ token: null })
  })

  it('takes the metrics token from the environment and honours every off switch', () => {
    const o = resolveServerOptions({ limits: false, metrics: false, cache: { embeddings: false, answers: { ttlMs: 5 } } }, { DOCPILOT_METRICS_TOKEN: 't' })
    expect(o.limits).toBe(false)
    expect(o.metrics).toBe(false)
    expect(o.cache.embeddings).toBe(0)
    expect(o.cache.answers).toEqual({ ttlMs: 5, max: 500 })
    expect(resolveServerOptions({}, { DOCPILOT_METRICS_TOKEN: 't' }).metrics).toEqual({ token: 't' })
  })
})

describe('createLimiter', () => {
  it('lets a burst through, then answers 429 with the seconds to wait', () => {
    let t = 0
    const lim = createLimiter({ perMinute: 6, burst: 2 }, { now: () => t })
    const a = lim.admit('x')
    const b = lim.admit('x')
    a.release()
    b.release()
    const c = lim.admit('x')
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false])
    expect(c.status).toBe(429)
    expect(c.reason).toBe('rate')
    expect(c.retryAfterS).toBe(10)
    t += 10000
    expect(lim.admit('x').ok).toBe(true)
    expect(lim.admit('y').ok).toBe(true)
  })

  it('caps the turns running at once with a 503, and frees the slot on release', () => {
    const lim = createLimiter({ perMinute: 100, concurrent: 1 })
    const a = lim.admit('x')
    const b = lim.admit('y')
    expect(b.ok).toBe(false)
    expect(b.status).toBe(503)
    a.release()
    a.release()
    expect(lim.admit('y').ok).toBe(true)
  })

  it('counts a UTC day and resets at its end', () => {
    let t = Date.UTC(2026, 9, 25, 23, 59, 0)
    const lim = createLimiter({ perMinute: 1000, perDay: 1 }, { now: () => t })
    lim.admit('x').release()
    const second = lim.admit('x')
    expect(second.reason).toBe('day')
    expect(second.retryAfterS).toBe(60)
    t += 61000
    expect(lim.admit('x').ok).toBe(true)
  })

  it('names the client by socket unless a proxy hop is trusted', () => {
    const req = new Request('http://x/', { headers: { 'x-forwarded-for': 'forged, 10.0.0.9' } })
    expect(clientKey(req, { remoteAddress: '1.2.3.4' }, false)).toBe('1.2.3.4')
    expect(clientKey(req, { remoteAddress: '1.2.3.4' }, 1)).toBe('10.0.0.9')
    expect(clientKey(req, null, false)).toBe('anonymous')
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('172.17.0.1')).toBe(false)
  })
})

describe('createMetrics', () => {
  it('counts outcomes, takes exact percentiles and renders both formats', () => {
    let t = 1_000_000
    const m = createMetrics({ now: () => t })
    const end = m.begin()
    expect(m.snapshot().turns.inFlight).toBe(1)
    end()
    end()
    for (const ms of [100, 200, 300, 400]) {
      m.turn({ outcome: 'answer', requests: 2, usage: { promptTokens: 10, outputTokens: 5, cachedTokens: 4 }, timing: { totalMs: ms, firstTokenMs: ms / 2, embedMs: 10, modelMs: ms - 20, embedRequests: 1 } })
    }
    m.turn({ outcome: 'weird' })
    m.cacheHit('embed')
    m.limited('rate')
    const s = m.snapshot({ model: 'stub' })
    expect(s.kind).toBe('docpilot.metrics')
    expect(s.turns).toMatchObject({ total: 5, inFlight: 0 })
    expect(s.turns.byOutcome.answer).toBe(4)
    expect(s.turns.byOutcome.error).toBe(1)
    expect(s.latencyMs.p50).toBe(300)
    expect(s.ttftMs.count).toBe(4)
    expect(s.requests).toEqual({ chat: 8, embed: 4, rerank: 0 })
    expect(s.tokens.cached).toBe(16)
    expect(s.cache.embedHits).toBe(1)
    expect(s.limits.rateLimited).toBe(1)
    expect(s.perMinute).toHaveLength(30)
    expect(s.perMinute.at(-1)).toBe(5)
    const text = m.prometheus({ model: 'a"b', index: { hash: 'h' } })
    expect(text).toContain('docpilot_turns_total{outcome="answer"} 4')
    expect(text).toContain('docpilot_turn_duration_seconds_count 4')
    expect(text).toContain('docpilot_info{model="a\\"b",embed_model="",index_hash="h"} 1')
    expect(text).toMatch(/docpilot_turn_stage_seconds_bucket\{stage="embed",le="0.025"\} 4/)
  })

  it('quantile is nearest-rank, the rule eval uses', () => {
    expect(quantile([5, 1, 3], 0.5)).toBe(3)
    expect(quantile([], 0.5)).toBe(null)
  })
})

describe('createLru and answerKey', () => {
  it('evicts the least recently used and expires by TTL', () => {
    let t = 0
    const lru = createLru(2, { ttlMs: 100, now: () => t })
    lru.set('a', 1)
    lru.set('b', 2)
    lru.get('a')
    lru.set('c', 3)
    expect([lru.get('a'), lru.get('b'), lru.get('c')]).toEqual([1, undefined, 3])
    t = 200
    expect(lru.get('a')).toBe(undefined)
  })

  it('keys only a plain first turn, normalised', () => {
    const k = { indexHash: 'i', promptHash: 'p', model: 'm' }
    expect(answerKey({ question: 'How  do I index?' }, k)).toBe(answerKey({ question: 'how do i index' }, k))
    expect(answerKey({ question: 'q', history: [{}] }, k)).toBe(null)
    expect(answerKey({ question: 'q', quote: 'x' }, k)).toBe(null)
    expect(answerKey({ question: 'q', scope: { paths: ['/a'] } }, k)).toBe(null)
  })
})

describe('readCapped', () => {
  it('stops reading past the ceiling', async () => {
    const big = new Request('http://x/', { method: 'POST', body: 'x'.repeat(2048) })
    expect(await readCapped(big, 1024)).toBe(null)
    const small = new Request('http://x/', { method: 'POST', body: 'hello' })
    expect(await readCapped(small, 1024)).toBe('hello')
  })
})

describe('the server under its operator settings', () => {
  const stub = stubModel()
  afterAll(() => stub.close())

  it('times every stage, keeps the ranking, and serves metrics to loopback only', async () => {
    const base = await stub.ready
    const records = []
    const dp = await createDocPilotServer({ settings: chatOf(base), env: { CUSTOM_BASE_URL: base }, index: INDEX, log: { write: (r) => records.push(r) } })
    const evs = await events(await dp.handle(post({ question: 'How do I build the index?', messageId: 'op-1' })))
    expect(evs.find((e) => e.event === 'settle').data.outcome).toBe('answer')
    const rec = records.find((r) => r.messageId === 'op-1')
    expect(rec.timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(rec.timing.modelMs).toBeGreaterThanOrEqual(0)
    expect(rec.timing.retrieveMs).toBeGreaterThanOrEqual(0)
    expect(rec.timing.embedMs).toBe(null)
    expect(rec.timing.firstTokenMs).not.toBe(null)
    expect(rec.rankedIds.length).toBeGreaterThan(0)

    const far = await dp.handle(new Request('http://docs.test/ai/turn/metrics'), { remoteAddress: '203.0.113.7' })
    expect(far.status).toBe(403)
    const near = await dp.handle(new Request('http://docs.test/ai/turn/metrics?format=json'), { remoteAddress: '127.0.0.1' })
    const snap = await near.json()
    expect(snap.turns.byOutcome.answer).toBe(1)
    expect(snap.model).toBe('stub')
    const prom = await dp.handle(new Request('http://docs.test/ai/turn/metrics'), { remoteAddress: '::1' })
    expect(prom.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await prom.text()).toContain('docpilot_turns_total{outcome="answer"} 1')
  })

  it('wants the bearer token when one is set, from anywhere', async () => {
    const base = await stub.ready
    const dp = await createDocPilotServer({ settings: chatOf(base), env: { CUSTOM_BASE_URL: base, DOCPILOT_METRICS_TOKEN: 's3cret' }, index: INDEX })
    const bad = await dp.handle(new Request('http://docs.test/ai/turn/metrics', { headers: { authorization: 'Bearer nope!!' } }), { remoteAddress: '127.0.0.1' })
    expect(bad.status).toBe(401)
    const good = await dp.handle(new Request('http://docs.test/ai/turn/metrics', { headers: { authorization: 'Bearer s3cret' } }), { remoteAddress: '203.0.113.7' })
    expect(good.status).toBe(200)
  })

  it('answers 429 in the panel’s rate-limited shape once a client spends its burst', async () => {
    const base = await stub.ready
    const dp = await createDocPilotServer({
      settings: { ...chatOf(base), server: { limits: { perMinute: 1, burst: 1 } } },
      env: { CUSTOM_BASE_URL: base },
      index: INDEX,
    })
    const first = await dp.handle(post({ question: 'How do I build the index?' }), { remoteAddress: '198.51.100.1' })
    await first.text()
    const second = await dp.handle(post({ question: 'How do I build the index?' }), { remoteAddress: '198.51.100.1' })
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
    const body = await second.json()
    expect(body.rateLimit.resetAt).toBeGreaterThan(Date.now())
    const other = await dp.handle(post({ question: 'How do I build the index?' }), { remoteAddress: '198.51.100.2' })
    expect(other.status).toBe(200)
    await other.text()
  })

  it('refuses a body past 256 KB without reading the rest', async () => {
    const base = await stub.ready
    const dp = await createDocPilotServer({ settings: chatOf(base), env: { CUSTOM_BASE_URL: base }, index: INDEX })
    const res = await dp.handle(post({ question: 'x', pad: 'y'.repeat(300 * 1024) }))
    expect(res.status).toBe(413)
  })

  it('serves a repeated first question from the answer cache only when switched on', async () => {
    const base = await stub.ready
    const before = stub.calls.length
    const dp = await createDocPilotServer({
      settings: { ...chatOf(base), server: { cache: { answers: { ttlMs: 60000 } } } },
      env: { CUSTOM_BASE_URL: base },
      index: INDEX,
    })
    const a = (await events(await dp.handle(post({ question: 'What does the gate do?' })))).find((e) => e.event === 'settle').data
    const spent = stub.calls.length - before
    const b = (await events(await dp.handle(post({ question: 'what does the gate do' })))).find((e) => e.event === 'settle').data
    expect(stub.calls.length - before).toBe(spent)
    expect(b.cached).toBe(true)
    expect(b.text).toBe(a.text)
    const withHistory = (await events(await dp.handle(post({ question: 'What does the gate do?', history: [{ question: 'hi', answer: 'hello' }] })))).find((e) => e.event === 'settle').data
    expect(withHistory.cached).toBeUndefined()
  })
})

describe('the turn deadline', () => {
  const slow = stubModel({ delayMs: 3000 })
  afterAll(() => slow.close())

  it('ends a turn that runs past it with an error the reader can read', async () => {
    const base = await slow.ready
    const records = []
    const dp = await createDocPilotServer({
      settings: { ...chatOf(base), server: { turnTimeoutMs: 300 } },
      env: { CUSTOM_BASE_URL: base },
      index: INDEX,
      log: { write: (r) => records.push(r) },
    })
    const evs = await events(await dp.handle(post({ question: 'How do I build the index?', messageId: 'dl-1' })))
    const err = evs.find((e) => e.event === 'error')
    expect(err?.data.kind).toBe('timeout')
    expect(records.find((r) => r.messageId === 'dl-1')?.error).toBe('turn deadline exceeded')
  }, 10000)
})

describe('eval --runtime=server', () => {
  const stub = stubModel()
  afterAll(() => stub.close())

  it('maps a settle onto the browser half’s outcome rule', () => {
    expect(observedOf({ outcome: 'answer', text: 'x', citations: ['a'], confidence: 0.9 })).toBe('answer')
    expect(observedOf({ outcome: 'answer', text: 'x', citations: ['a'], confidence: 0.2 })).toBe('refuse:not-answerable')
    expect(observedOf({ outcome: 'answer', text: 'x', citations: [] })).toBe('refuse:not-answerable')
    expect(observedOf({ outcome: 'refused', refusal: { cause: 'out-of-scope' } })).toBe('refuse:out-of-scope')
    expect(observedOf({ outcome: 'social' })).toBe('refuse:social')
    expect(observedOf(null, { message: 'x' })).toBe('error')
  })

  it('scores a record through the in-process server, ranking and timings included', async () => {
    const base = await stub.ready
    const rows = await serverRows({
      records: [
        { id: 'r1', question: 'How do I build the index?', expect: 'answer', gold_chunks: ['guide/indexing#'], gold_answer: 'Run npx docpilot index.' },
        { id: 'r2', question: 'And then?', prev_questions: ['How do I build the index?'], expect: 'answer', gold_chunks: ['guide/indexing#'], gold_answer: 'x' },
      ],
      settings: chatOf(base),
      env: { CUSTOM_BASE_URL: base },
      indexDir: INDEX,
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].observed).toBe('answer')
    expect(rows[0].runtime).toBe('server')
    expect(rows[0].rankedIds.length).toBeGreaterThan(0)
    expect(typeof rows[0].ndcg8).toBe('number')
    expect(rows[0].ttftMs).not.toBe(null)
    expect(rows[0].timing.modelMs).toBeGreaterThanOrEqual(0)
    expect(rows[0].answerF1).toBeGreaterThan(0)
    expect(rows[1].depth).toBe(1)
  })
})

describe('the server turn policy', () => {
  const stub = stubModel()
  afterAll(() => stub.close())

  it('one-shot spends exactly the answer call and records the loop it took', async () => {
    const base = await stub.ready
    const records = []
    const before = stub.calls.length
    const dp = await createDocPilotServer({
      settings: { ...chatOf(base), server: { turn: { loop: 'one-shot', finalThink: false } } },
      env: { CUSTOM_BASE_URL: base },
      index: INDEX,
      log: { write: (r) => records.push(r) },
    })
    const evs = await events(await dp.handle(post({ question: 'How do I build the index?', messageId: 'pol-1' })))
    expect(evs.find((e) => e.event === 'settle').data.outcome).toBe('answer')
    const turnCalls = stub.calls.slice(before).filter((c) => !c.tools || c.tools.length === 0)
    expect(turnCalls.length).toBeGreaterThanOrEqual(1)
    const rec = records.find((r) => r.messageId === 'pol-1')
    expect(rec.timing.loop).toBe('one-shot')
    expect(rec.iterations).toBe(0)
  })

  it('without a policy the turn is the browser’s, call for call', async () => {
    const base = await stub.ready
    const records = []
    const dp = await createDocPilotServer({ settings: chatOf(base), env: { CUSTOM_BASE_URL: base }, index: INDEX, log: { write: (r) => records.push(r) } })
    await (await dp.handle(post({ question: 'How do I build the index?', messageId: 'pol-2' }))).text()
    expect(records.find((r) => r.messageId === 'pol-2').timing.loop).toBe(null)
  })
})
