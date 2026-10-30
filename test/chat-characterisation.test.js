import { describe, it, expect, afterEach } from 'vitest'

import { createHarness } from './helpers/chat-harness.js'

/**
 * WHAT THE 2.1.1 CHAT SESSION DOES FOR ONE READER — CORE-02.
 *
 * Phases 6 and 7 move the turn driver and the chat state. This file is the net
 * under that move: it pins today's behaviour through `test/helpers/chat-harness.js`
 * and nothing else (D-14 — no test here imports the session), so a change in how
 * the chat is built can change the harness and must not change a line below.
 *
 * Two kinds of pin (D-15). The SUBMIT SEQUENCE is a committed trace file: the
 * ordered state writes of a cold turn and the requests the stub model and
 * embedder received. Citations, quote and history are explicit assertions that
 * state their intent.
 *
 * Every scenario runs in both runtimes (D-16): `browser`, where the panel
 * retrieves and calls the model itself, and `server`, where it posts to the real
 * `createDocPilotServer(...).handle(Request)`.
 *
 * A trace file is a record of reviewed behaviour. A diff in one is either an
 * intended change somebody can explain or a regression; it is never regenerated
 * to make a run green.
 */

const COLD_QUESTION = 'How is the alpha token passed in a header?'

let harness
const start = (options) => (harness = createHarness(options))

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe('a cold question, browser runtime', () => {
  it('settles with a cited answer, and the sequence of writes and requests is the committed trace', async () => {
    const h = start({ runtime: 'browser' })
    const turn = await h.ask(COLD_QUESTION)
    expect(turn.state).toBe('complete')
    expect(turn.answerText).toContain('[1]')
    expect(turn.sources.length).toBeGreaterThan(0)
    await expect(h.trace()).toMatchFileSnapshot('./traces/submit.browser.trace')
  })
})

describe('a cold question, server runtime', () => {
  it('settles with the same outcome through the real turn endpoint, and the sequence is the committed trace', async () => {
    const h = start({ runtime: 'server' })
    const turn = await h.ask(COLD_QUESTION)
    expect(turn.state).toBe('complete')
    expect(turn.answerText).toContain('[1]')
    expect(turn.sources.map((s) => s.id)).toEqual(['a#one'])
    await expect(h.trace()).toMatchFileSnapshot('./traces/submit.server.trace')
  })

  it('never puts a provider key in the request the browser sends', async () => {
    const h = start({ runtime: 'server' })
    await h.ask(COLD_QUESTION)
    const post = h.wire().find((w) => w.to === 'endpoint' && w.method === 'POST')
    expect(post).toBeTruthy()
    expect(JSON.stringify(post.body)).not.toMatch(/placeholder-key|apiKey|authorization/i)
  })
})

describe('the harness contract', () => {
  it('offers exactly the members the later phases build on', () => {
    const h = start({ runtime: 'browser' })
    expect(Object.keys(h).sort()).toEqual(
      ['ask', 'close', 'reload', 'reset', 'restore', 'setScope', 'snapshot', 'stop', 'storage', 'stub', 'trace', 'wire'].sort(),
    )
    expect(Object.keys(h.stub).filter((k) => !k.startsWith('_')).sort()).toEqual(['answer', 'failFor', 'models', 'stall'])
  })

  it('refuses any request it does not route, so no test can reach a live host', async () => {
    const h = start({ runtime: 'browser' })
    await expect(fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(
      /harness: unexpected fetch https:\/\/api\.openai\.com/,
    )
    await expect(h.close()).rejects.toThrow(/unexpected fetch/)
    harness = null
  })
})

const RUNTIMES = [['browser'], ['server']]

/** The text of every model request the stub received, to ask what reached the model. */
const modelText = (h) =>
  h
    .wire()
    .filter((w) => w.to === 'model')
    .map((w) => JSON.stringify(w.body.messages))
    .join('\n')

describe.each(RUNTIMES)('citations, %s runtime', (runtime) => {
  it('names the same chunks in the answer text and in the Sources list', async () => {
    const h = start({ runtime })
    h.stub.answer(() => ({
      text: 'Send the token in a header [1], and stay under the request limit [2].',
      citations: ['a#one', 'a#two'],
    }))
    const turn = await h.ask(COLD_QUESTION)
    expect(turn.state).toBe('complete')
    // The text is checked, not only the list: a Sources row under prose that links
    // nothing is the failure this pin exists for.
    const markers = [...turn.answerText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
    expect(markers).toEqual([1, 2])
    expect(turn.citations).toEqual(['a#one', 'a#two'])
    for (const n of markers) expect(turn.sources[n - 1]?.id).toBe(turn.citations[n - 1])
    expect(turn.sources.map((s) => s.id)).toEqual(['a#one', 'a#two'])
  })

  it('drops a citation the index does not hold rather than showing a Sources row for it', async () => {
    const h = start({ runtime })
    h.stub.answer(() => ({ text: 'Send the token in a header [1].', citations: ['a#one', 'zz#missing'] }))
    const turn = await h.ask(COLD_QUESTION)
    expect(turn.answerText).toContain('[1]')
    expect(turn.sources.map((s) => s.id)).toEqual(['a#one'])
  })
})

describe.each(RUNTIMES)('a quoted passage, %s runtime', (runtime) => {
  // Words the corpus does not contain, so a hit in the request can only be the quote.
  const PASSAGE = 'the token is rotated every ninety days'

  it('reaches the model request and stays on the turn', async () => {
    const h = start({ runtime })
    const turn = await h.ask(COLD_QUESTION, { quote: PASSAGE })
    expect(turn.state).toBe('complete')
    expect(turn.quote).toBe(PASSAGE)
    expect(modelText(h)).toContain(PASSAGE)
  })

  it('is not on a turn asked without one', async () => {
    const h = start({ runtime })
    const turn = await h.ask(COLD_QUESTION)
    expect(turn.quote).toBe('')
    expect(modelText(h)).not.toContain(PASSAGE)
  })
})

describe.each(RUNTIMES)('history, %s runtime', (runtime) => {
  it('lists a settled conversation, and brings its turns back after a reload', async () => {
    const h = start({ runtime })
    const turn = await h.ask(COLD_QUESTION)
    const before = h.snapshot()
    expect(before.history).toHaveLength(1)
    expect(before.history[0].id).toBe(before.conversationId)
    expect(before.history[0].title).toBe(COLD_QUESTION)
    expect(before.history[0].turnCount).toBe(1)

    h.reload()
    expect(h.snapshot().turns).toEqual([])
    await h.restore(before.conversationId)

    const after = h.snapshot()
    expect(after.conversationId).toBe(before.conversationId)
    expect(after.turns).toHaveLength(1)
    expect(after.turns[0].question).toBe(COLD_QUESTION)
    expect(after.turns[0].answerText).toBe(turn.answerText)
    expect(after.turns[0].sources).toEqual(turn.sources)
    expect(after.turns[0].citations).toEqual(turn.citations)
  })

  it('keeps nothing when history is switched off', async () => {
    const h = start({ runtime, config: { history: { enabled: false } } })
    await h.ask(COLD_QUESTION)
    expect(h.snapshot().history).toEqual([])
  })
})
