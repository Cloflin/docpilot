import { describe, it, expect, afterEach } from 'vitest'

import { createHarness } from './helpers/chat-harness.js'
import { OPENER } from './helpers/chat-fixture.js'
import { MASK } from '../src/theme/docpilot/credentials.js'
import { FREE_TIER_DAILY } from '../src/theme/docpilot/budget.js'
import { BUDGET_DEFAULTS } from '../src/theme/docpilot/switches.js'

/**
 * THE TURNS THE 2.1.1 CHAT SETTLES WITHOUT THE MODEL, OR REFUSES BEFORE IT — CORE-02.
 *
 * `test/chat-characterisation.test.js` pins the cold turn that does reach the
 * model. This file pins the other half: an opener answered from the build, a
 * question the gate refuses, a pasted key, a greeting, an exhausted day. Those are
 * the outcomes a turn-driver rewrite (Phase 6) or a state rewrite (Phase 7) is
 * most likely to change without any visible error — a turn that used to cost
 * nothing starts costing one request, and every screen still looks right.
 *
 * So every scenario asserts `wire()` explicitly, request by request. A turn that
 * cost zero model requests must keep costing zero; a refusal that cost one embed
 * must keep costing exactly one. A new request is a failing test, which is the
 * point of the file.
 *
 * Same rules as the cold-turn file. Every scenario goes through
 * `test/helpers/chat-harness.js` and nothing else (D-14): no test here imports the
 * session. Every scenario runs in both runtimes (D-16), `browser` and `server`,
 * and where 2.1.1 serves a thing differently in the two, the difference is named
 * where it is asserted. A trace file is reviewed behaviour and is never regenerated
 * to make a run green.
 */

let harness
const start = (options) => (harness = createHarness(options))

afterEach(async () => {
  await harness?.close()
  harness = null
})

const RUNTIMES = [['browser'], ['server']]

/**
 * The requests that ask a model to ANSWER. A non-streamed model request is the
 * tool-support probe: the browser sends one before its first answer, and the
 * server sends one at boot, before any reader has asked anything. It is not what
 * "no model request" is about, so it is counted apart.
 */
const answerRequests = (h) => h.wire().filter((w) => w.to === 'model' && w.body?.stream !== false)
const embedRequests = (h) => h.wire().filter((w) => w.to === 'embed')

/** The questions. The opener's own words share nothing with the corpus questions in the other file. */
const OFF_TOPIC = 'Where can I buy cheap flights to Paris?'
// "backups" for "snapshots": 2.1.1's lexical pass declines it at matchTau 0.9, the vector pass does not.
const PARAPHRASE_OF_OPENER = 'How are gamma backups scheduled?'
const LEXICAL_OF_OPENER = 'How is gamma snapshot scheduled?'

describe.each(RUNTIMES)('an opener, %s runtime', (runtime) => {
  // 2.1.1 difference, named once. The browser matches the opener itself and the
  // turn never leaves the page. The server runtime answers it inside the turn
  // endpoint: the panel's POST is the one request, and the server makes none to a
  // model. The boot probe in the server trace is the server's, not the turn's.
  it('an exact match settles from the baked answer, with no model request and no embedding', async () => {
    const h = start({ runtime })
    const turn = await h.ask(OPENER.q)
    expect(turn.state).toBe('complete')
    expect(turn.opener).toEqual({ matched: 'exact', baked: true })
    expect(turn.answerText).toBe(OPENER.answer)
    expect(turn.citations).toEqual(OPENER.cite)
    expect(turn.sources.map((s) => s.id)).toEqual(OPENER.cite)
    expect(answerRequests(h)).toEqual([])
    expect(embedRequests(h)).toEqual([])
    if (runtime === 'server') expect(h.wire().filter((w) => w.to === 'endpoint' && w.method === 'POST')).toHaveLength(1)
    else expect(h.wire()).toEqual([])
    await expect(h.trace()).toMatchFileSnapshot(`./traces/opener.${runtime}.trace`)
  })

  it('a lexical paraphrase matches it on the words alone, still with no embedding and no model request', async () => {
    const h = start({ runtime })
    const turn = await h.ask(LEXICAL_OF_OPENER)
    expect(turn.state).toBe('complete')
    expect(turn.opener).toEqual({ matched: 'lexical', baked: true })
    expect(turn.answerText).toBe(OPENER.answer)
    expect(turn.citations).toEqual(OPENER.cite)
    expect(answerRequests(h)).toEqual([])
    expect(embedRequests(h)).toEqual([])
  })

  it('a dense paraphrase matches it through the vectors: one embedding, no model request', async () => {
    // matchTau 0.9 takes the lexical pass out of the way for a question that
    // shares two of its three rare words; the stub vectors still put it next to
    // the opener. (`matchTau: false` is not used: see the session's second
    // resolveSuggestions pass, which reads the resolved `2` as out of range.)
    const h = start({ runtime, config: { suggestions: { questions: [OPENER], matchTau: 0.9 } } })
    const turn = await h.ask(PARAPHRASE_OF_OPENER)
    expect(turn.state).toBe('complete')
    expect(turn.opener).toEqual({ matched: 'dense', baked: true })
    expect(turn.answerText).toBe(OPENER.answer)
    expect(turn.citations).toEqual(OPENER.cite)
    expect(embedRequests(h)).toHaveLength(1)
    expect(answerRequests(h)).toEqual([])
  })

  it('a quoted passage is an antecedent: the same question then goes to the model', async () => {
    const h = start({ runtime })
    const turn = await h.ask(OPENER.q, { quote: 'the nightly snapshot' })
    expect(turn.state).toBe('complete')
    expect(turn.opener?.baked).not.toBe(true)
    expect(turn.answerText).not.toBe(OPENER.answer)
    expect(answerRequests(h)).toHaveLength(1)
  })
})

describe.each(RUNTIMES)('the gate, %s runtime', (runtime) => {
  it("with guard.mode 'calibrated', an off-topic question is refused after one embedding and before any model request", async () => {
    const h = start({ runtime, config: { guard: { mode: 'calibrated' } } })
    const turn = await h.ask(OFF_TOPIC)
    expect(turn.state).toBe('no-answer')
    expect(turn.refusal).toEqual({ cause: 'no-evidence' })
    expect(turn.answerText).toBe('')
    expect(turn.sources).toEqual([])
    // The embedding is how the gate scores the question, so it is spent; the model never is.
    expect(embedRequests(h)).toHaveLength(1)
    expect(answerRequests(h)).toEqual([])
    await expect(h.trace()).toMatchFileSnapshot(`./traces/refusal.${runtime}.trace`)
  })

  it("under the shipped default (guard.mode 'off') the same question is not refused and reaches the model", async () => {
    const h = start({ runtime })
    const turn = await h.ask(OFF_TOPIC)
    expect(turn.state).toBe('complete')
    expect(turn.refusal).toBeNull()
    expect(embedRequests(h)).toHaveLength(1)
    expect(answerRequests(h)).toHaveLength(1)
  })
})

/**
 * A pasted key and a greeting settle in the panel, before anything is sent
 * (session.ts: `redactSecrets`, then `detectSocial`, both ahead of the runtime
 * split). Same outcome in both runtimes, and in the server runtime not even the
 * turn endpoint is called.
 */
const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD'
const turnPosts = (h) => h.wire().filter((w) => w.to === 'endpoint' && w.method === 'POST')

describe.each(RUNTIMES)('a pasted key, %s runtime', (runtime) => {
  it('settles as the credential outcome with no retrieval and no model request', async () => {
    const h = start({ runtime })
    const turn = await h.ask(`my key is ${KEY} and the widget still fails`)
    expect(turn.state).toBe('no-answer')
    expect(turn.refusal).toEqual({ cause: 'credential' })
    expect(turn.answerText).toBe('')
    expect(turn.sources).toEqual([])
    expect(embedRequests(h)).toEqual([])
    expect(answerRequests(h)).toEqual([])
    expect(turnPosts(h)).toEqual([])
  })

  it('stores the question redacted, and no request or stored value carries the key (T-1-14)', async () => {
    const h = start({ runtime })
    const turn = await h.ask(`my key is ${KEY} and the widget still fails`)
    expect(turn.question).toBe(`my key is ${MASK} and the widget still fails`)
    const stored = Array.from({ length: h.storage.length }, (_, i) => h.storage.getItem(h.storage.key(i)))
    // The history archive is written for this turn, so the storage check is not vacuous.
    expect(stored.length).toBeGreaterThan(0)
    for (const text of [JSON.stringify(h.snapshot()), JSON.stringify(h.wire()), ...stored]) {
      expect(text).not.toContain(KEY)
    }
  })

  it('wins over a greeting that carries it: a thanks with a key in it is a key', async () => {
    const h = start({ runtime })
    const turn = await h.ask(`thanks! ${KEY}`)
    expect(turn.refusal).toEqual({ cause: 'credential' })
  })
})

describe.each(RUNTIMES)('a social message, %s runtime', (runtime) => {
  it('settles as the social outcome with no retrieval and no model request', async () => {
    const h = start({ runtime })
    const turn = await h.ask('thanks!')
    expect(turn.state).toBe('no-answer')
    expect(turn.refusal).toEqual({ cause: 'social' })
    expect(turn.answerText).toBe('')
    expect(turn.sources).toEqual([])
    expect(embedRequests(h)).toEqual([])
    expect(answerRequests(h)).toEqual([])
    expect(turnPosts(h)).toEqual([])
  })
})

/**
 * THE DAILY ALLOWANCE — browser runtime only; the server runtime has none.
 *
 * What 2.1.1 does, which is not what one might assume: the panel NEVER refuses a
 * question on its own count. A spent allowance changes the SHAPE of the turn (no
 * tool loop, no rotation) and the turn is still sent; the turn ends as
 * `rate-limited` only when the service itself answers with a daily 429.
 *
 * How the ledger is taught: by the stub's response headers, the way a real service
 * teaches it. It is a module singleton in `budget.ts`, the harness gives each test
 * a fresh storage but not a fresh ledger, and its clock is whichever `Date.now`
 * was installed when it was first built — so seeding `h.storage` is read in one
 * test and expired in the next. A statement from a response is relative to the
 * ledger's own clock and replaces whatever it held, whichever test left it. A first
 * turn teaches; the turn under test is the follow-up, and `wire()` is read from
 * the mark between them. These tests come last so that a "0 left" statement is
 * not in the ledger for the tests above.
 */
const encoder = new TextEncoder()
const TEACH = 'How is the alpha token passed in a header?'
const FOLLOW_UP = 'And what about the request limit?'

/** An ordinary answer whose headers say how many requests the day has left, with the day's reset 12 hours out. */
const statesRemaining = (remaining) => () =>
  new Response(
    new ReadableStream({
      start(c) {
        const args = JSON.stringify({ text: 'The documentation covers this [1].', citations: ['a#one'], confidence: 0.9 })
        const call = { index: 0, id: 'call_answer', type: 'function', function: { name: 'answer', arguments: args } }
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`))
        c.enqueue(encoder.encode('data: [DONE]\n\n'))
        c.close()
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-ratelimit-limit': String(FREE_TIER_DAILY),
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-reset': '43200',
      },
    },
  )

/** The 429 a service sends when the DAY is spent. A short retry-after, so nothing waits it out. */
const DAILY_429 = {
  status: 429,
  headers: { 'retry-after': '1' },
  body: { error: { message: 'Rate limit exceeded: free-models-per-day', metadata: { limit_source: 'daily' } } },
}

/** Start a browser harness, let one answer teach the ledger `remaining`, and return the mark to read `wire()` from. */
const taught = async (remaining, config = {}, { models } = {}) => {
  const h = start({ runtime: 'browser', config: { budget: { dailyLimit: FREE_TIER_DAILY }, ...config } })
  if (models) h.stub.models = models
  h.stub.answer(statesRemaining(remaining))
  expect((await h.ask(TEACH)).state).toBe('complete')
  h.stub.answer(null)
  return { h, mark: h.wire().length }
}
const streamedSince = (h, mark) => h.wire().slice(mark).filter((w) => w.to === 'model' && w.body?.stream !== false)
const toolCount = (w) => (w.body?.tools || []).length

const { oneShotBelow: ONE_SHOT_BELOW, rotateAbove: ROTATE_ABOVE } = BUDGET_DEFAULTS

describe('the daily allowance, browser runtime', () => {
  it('with plenty left the turn keeps its tool loop: the first request lists the tools', async () => {
    const { h, mark } = await taught(ONE_SHOT_BELOW + 25)
    const turn = await h.ask(FOLLOW_UP)
    expect(turn.state).toBe('complete')
    const sent = streamedSince(h, mark)
    expect(sent).toHaveLength(1)
    expect(toolCount(sent[0])).toBeGreaterThan(0)
  })

  it('below oneShotBelow the turn is one-shot: one request, no tools, still answered', async () => {
    const { h, mark } = await taught(ROTATE_ABOVE + 2)
    expect(ROTATE_ABOVE + 2).toBeLessThan(ONE_SHOT_BELOW)
    const turn = await h.ask(FOLLOW_UP)
    expect(turn.state).toBe('complete')
    const sent = streamedSince(h, mark)
    expect(sent).toHaveLength(1)
    expect(toolCount(sent[0])).toBe(0)
  })

  it('an exhausted allowance is not refused by the panel: the turn is sent, one-shot, and answered', async () => {
    const { h, mark } = await taught(0)
    const turn = await h.ask(FOLLOW_UP)
    expect(turn.state).toBe('complete')
    const sent = streamedSince(h, mark)
    expect(sent).toHaveLength(1)
    expect(toolCount(sent[0])).toBe(0)
  })

  it('an exhausted daily allowance the service confirms settles as rate-limited after one model request, and keeps the passages', async () => {
    const { h, mark } = await taught(0)
    h.stub.failFor('stub', DAILY_429, 5)
    const turn = await h.ask(FOLLOW_UP)
    expect(turn.state).toBe('rate-limited')
    // No retry and no rotation against a spent day: exactly the one request.
    expect(streamedSince(h, mark)).toHaveLength(1)
    // The retrieval was already paid for, so its rows are shown under the limit notice.
    expect(turn.results.length).toBeGreaterThan(0)
    expect(turn.answerText).toBe('')
  })

  // Rotation needs somewhere to rotate to: a two-model chain whose head fails once.
  // `mode: 'agentic'` keeps the one-shot rule out of the way, so what moves the
  // outcome is `rotateAbove` alone; `maxContinuations: 0` makes "rationed" mean one request.
  const CHAIN = {
    chat: { provider: 'custom', model: 'head', models: ['head', 'stub'], baseURL: 'http://stub.test' },
    budget: { dailyLimit: FREE_TIER_DAILY, mode: 'agentic', maxContinuations: 0 },
  }

  it('above rotateAbove a failing model rotates to the next one in the chain', async () => {
    const { h, mark } = await taught(ROTATE_ABOVE + 4, CHAIN, { models: ['head', 'stub'] })
    h.stub.failFor('head', { status: 500 }, 1)
    const turn = await h.ask(FOLLOW_UP)
    expect(turn.state).toBe('complete')
    expect(streamedSince(h, mark).map((w) => w.body.model)).toEqual(['head', 'stub'])
  })

  it('at or below rotateAbove it does not rotate: the second request goes back to the same model', async () => {
    const { h, mark } = await taught(ROTATE_ABOVE - 3, CHAIN, { models: ['head', 'stub'] })
    h.stub.failFor('head', { status: 500 }, 1)
    const turn = await h.ask(FOLLOW_UP)
    expect(turn.state).toBe('complete')
    expect(streamedSince(h, mark).map((w) => w.body.model)).toEqual(['head', 'head'])
  })
})

describe('the daily allowance, server runtime', () => {
  // The server is built with `budget: false` (one server key serves every reader), and
  // the panel never sees the model's response headers. So what the model reported
  // about the day changes nothing about the turn: the same follow-up sends the same
  // model request whether the day was said to be nearly spent or barely used.
  const followUpRequest = async (remaining) => {
    const h = start({ runtime: 'server', config: { budget: { dailyLimit: FREE_TIER_DAILY } } })
    h.stub.answer(statesRemaining(remaining))
    await h.ask(TEACH)
    h.stub.answer(null)
    const mark = h.wire().length
    const turn = await h.ask(FOLLOW_UP)
    const sent = streamedSince(h, mark)
    await h.close()
    harness = null
    return { turn, sent }
  }

  it('is not rationed: a nearly spent day and a barely used one send the same model request', async () => {
    const spent = await followUpRequest(1)
    const fresh = await followUpRequest(FREE_TIER_DAILY - 1)
    expect(spent.turn.state).toBe('complete')
    expect(fresh.turn.state).toBe('complete')
    expect(spent.sent).toHaveLength(1)
    expect(fresh.sent).toHaveLength(1)
    expect(spent.sent[0].body).toEqual(fresh.sent[0].body)
  })
})
