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
