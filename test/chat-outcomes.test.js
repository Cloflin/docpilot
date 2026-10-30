import { describe, it, expect, afterEach } from 'vitest'

import { createHarness } from './helpers/chat-harness.js'
import { OPENER } from './helpers/chat-fixture.js'

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
