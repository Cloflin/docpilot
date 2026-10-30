import { describe, it, expect, afterEach, beforeAll } from 'vitest'

import { createHarness } from './helpers/chat-harness.js'

/**
 * THE MULTI-TURN AND FAILURE PATHS OF THE 2.1.1 CHAT SESSION — CORE-02, PITFALL 18.
 *
 * These are the paths a reactivity change breaks without a red test: a state
 * write that lands after a turn was aborted, an antecedent lost across a reload,
 * a scope that never reaches the next turn, a failure that settles on a different
 * state than it used to. Phase 7 rewrites exactly this state handling, so each
 * path is pinned end to end here, through the harness and nothing else (D-14: no
 * test in this file imports the session).
 *
 * Same rules as the cold-turn and outcome files. Every scenario runs in both
 * runtimes (D-16), `browser` and `server`, and where 2.1.1 serves a thing
 * differently in the two, the difference is named where it is asserted. Only the
 * follow-up and the rotation sequences are committed trace files (D-15); the rest
 * is explicit assertions that state what they protect. A trace file is reviewed
 * behaviour and is never regenerated (`vitest -u`) to make a run green.
 *
 * What a trace file here holds. The harness trace lists state writes and
 * requests; it does not name the model a request went to, and it does not say
 * which retrieval channel a follow-up ran on. Both are on the wire, so the file
 * snapshots `h.trace()` followed by a short digest this file derives from
 * `h.wire()`. Nothing in the digest is typed in by hand: it is read off the
 * requests the stub received.
 */

let harness
const start = (options) => (harness = createHarness(options))

afterEach(async () => {
  await harness?.close()
  harness = null
})

/**
 * The first browser turn of a process sends the tool-support probe, once; every
 * later one finds the answer in module state the harness cannot reset. A trace
 * that holds the probe line would then depend on which test ran first, so one
 * throwaway turn pays for it before any test below starts.
 */
beforeAll(async () => {
  const warm = createHarness({ runtime: 'browser' })
  await warm.ask(FIRST)
  await warm.close()
})

const RUNTIMES = [['browser'], ['server']]

const FIRST = 'How is the alpha token passed in a header?'
const FOLLOW_UP = 'and how do I limit it?'

/** The requests that ask a model to ANSWER; a non-streamed one is the tool probe. */
const answerRequests = (wire) => wire.filter((w) => w.to === 'model' && w.body?.stream !== false)
const embedRequests = (wire) => wire.filter((w) => w.to === 'embed')
const turnPosts = (wire) => wire.filter((w) => w.to === 'endpoint' && w.method === 'POST')

/** The `search_docs` result a request carries: the query retrieval ran on, the scope, the rows. */
const searchResult = (request) => {
  const message = request.body.messages.find((m) => m.role === 'user' && String(m.content).startsWith('{"tool":"search_docs"'))
  return message ? JSON.parse(message.content) : null
}

/** The prior turns a model request carries as history: the user message in front of each assistant message. */
const historyOf = (request) => {
  const messages = request.body.messages
  const out = []
  messages.forEach((m, i) => {
    if (m.role === 'assistant') out.push({ question: messages[i - 1].content, answer: m.content })
  })
  return out
}

/**
 * The follow-up as the embedder and the model received it, read off the wire:
 * the texts embedded, the query retrieval ran on and whether that is the
 * antecedent composed with the question, the history the model was handed.
 */
const followUpDigest = (h, antecedent, followUp) => {
  const sent = answerRequests(h.wire()).at(-1)
  const embedded = embedRequests(h.wire()).at(-1)
  const found = searchResult(sent)
  const channel = found?.query === `${antecedent}\n${followUp}` ? 'composed' : 'raw'
  const lines = [
    '-- the follow-up, as the embedder and the model received it',
    `embedded: ${JSON.stringify(embedded.body.input)}`,
    `retrieval channel: ${channel}`,
    `retrieved on: ${JSON.stringify(found?.query)}`,
    ...historyOf(sent).map((t, i) => `history sent [${i}]: ${JSON.stringify(t.question)} -> ${JSON.stringify(t.answer)}`),
  ]
  const post = turnPosts(h.wire()).at(-1)
  if (post) lines.push(`turn POST history: ${post.body.history.length} turn(s), scope ${JSON.stringify(post.body.scope.paths)}`)
  return `${lines.join('\n')}\n`
}

describe.each(RUNTIMES)('a follow-up question, %s runtime', (runtime) => {
  it('is retrieved on the composed channel against the question before it, and sends that turn as history; the sequence is the committed trace', async () => {
    const h = start({ runtime })
    const first = await h.ask(FIRST)
    expect(first.state).toBe('complete')
    const second = await h.ask(FOLLOW_UP)
    expect(second.state).toBe('complete')

    // The channel: both the raw question and the composed one are embedded, and the
    // composed one is what retrieval and the model's search result are built on.
    const embedded = embedRequests(h.wire()).at(-1)
    expect(embedded.body.input).toEqual([FOLLOW_UP, `${FIRST}\n${FOLLOW_UP}`])
    const sent = answerRequests(h.wire()).at(-1)
    expect(searchResult(sent).query).toBe(`${FIRST}\n${FOLLOW_UP}`)

    // The history: the first turn, question and answer, in front of the follow-up.
    expect(historyOf(sent)).toEqual([{ question: FIRST, answer: first.answerText }])
    if (runtime === 'server') {
      // 2.1.1 difference: the server never held the thread. The panel posts the
      // prior turns, each with the gate channel it ran on, and the server rebuilds
      // the model's messages from them.
      const post = turnPosts(h.wire()).at(-1)
      expect(post.body.history).toHaveLength(1)
      expect(post.body.history[0]).toMatchObject({ question: FIRST, answer: first.answerText, gate: { channel: 'raw', antecedent: null } })
    }

    await expect(`${h.trace()}${followUpDigest(h, FIRST, FOLLOW_UP)}`).toMatchFileSnapshot(`./traces/followup.${runtime}.trace`)
  })

  it('records that the follow-up ran composed, so the question after it composes against the right antecedent', async () => {
    const h = start({ runtime })
    await h.ask(FIRST)
    await h.ask(FOLLOW_UP)
    await h.ask('and what happens past that?')
    const sent = answerRequests(h.wire()).at(-1)
    expect(historyOf(sent).map((t) => t.question)).toEqual([FIRST, FOLLOW_UP])
    if (runtime === 'server') {
      // The only place the gate's own channel is visible from outside the session:
      // the history the panel posts back carries it, turn by turn.
      const post = turnPosts(h.wire()).at(-1)
      expect(post.body.history.map((t) => t.gate.channel)).toEqual(['raw', 'composed'])
      expect(post.body.history[1].gate.antecedent).toBe('question')
    }
  })
})

describe.each(RUNTIMES)('a conversation restored after a reload, %s runtime', (runtime) => {
  it('brings back its turns with their answers and sources', async () => {
    const h = start({ runtime })
    await h.ask(FIRST)
    await h.ask(FOLLOW_UP)
    const before = h.snapshot()
    expect(before.history).toHaveLength(1)
    expect(before.turns).toHaveLength(2)

    h.reload()
    expect(h.snapshot().turns).toEqual([])
    await h.restore(before.conversationId)

    const after = h.snapshot()
    expect(after.conversationId).toBe(before.conversationId)
    expect(after.turns).toHaveLength(2)
    after.turns.forEach((turn, i) => {
      expect(turn.question).toBe(before.turns[i].question)
      expect(turn.answerText).toBe(before.turns[i].answerText)
      expect(turn.sources).toEqual(before.turns[i].sources)
      expect(turn.citations).toEqual(before.turns[i].citations)
      expect(turn.state).toBe('complete')
    })
  })

  it('uses the restored question as the antecedent of the next follow-up', async () => {
    const h = start({ runtime })
    await h.ask(FIRST)
    const { conversationId } = h.snapshot()
    h.reload()
    await h.restore(conversationId)
    const mark = h.wire().length

    const turn = await h.ask(FOLLOW_UP)
    expect(turn.state).toBe('complete')
    // The same wire a follow-up in the live thread produces.
    const after = h.wire().slice(mark)
    expect(embedRequests(after).at(-1).body.input).toEqual([FOLLOW_UP, `${FIRST}\n${FOLLOW_UP}`])
    const sent = answerRequests(after).at(-1)
    expect(searchResult(sent).query).toBe(`${FIRST}\n${FOLLOW_UP}`)
    expect(historyOf(sent).map((t) => t.question)).toEqual([FIRST])
    if (runtime === 'server') expect(turnPosts(after).at(-1).body.history.map((t) => t.question)).toEqual([FIRST])
    // And the thread continues the restored conversation rather than opening another.
    expect(h.snapshot().conversationId).toBe(conversationId)
    expect(h.snapshot().turns).toHaveLength(2)
  })
})

describe.each(RUNTIMES)('a scope change mid-thread, %s runtime', (runtime) => {
  const pathsOf = (request) => [...new Set(searchResult(request).results.map((r) => r.path))].sort()

  it('narrows the next turn to the new paths and says so in what the model and the server receive', async () => {
    const h = start({ runtime })
    const first = await h.ask(FIRST)
    // Before the change the same corpus is searched whole: the contrast the narrowing is measured against.
    expect(pathsOf(answerRequests(h.wire()).at(-1))).toEqual(['/a', '/b', '/c'])
    expect(first.sources.map((s) => s.id)).toEqual(['a#one'])

    await h.setScope(['/b'])
    expect(h.snapshot().scope).toEqual({ kind: 'page', paths: ['/b'] })
    const second = await h.ask('How do I install the gizmo?')
    expect(second.state).toBe('complete')
    expect(pathsOf(answerRequests(h.wire()).at(-1))).toEqual(['/b'])
    expect(second.sources.length).toBeGreaterThan(0)
    for (const source of second.sources) expect(source.id).toMatch(/^b#/)
    if (runtime === 'server') {
      // The scope travels in the request as paths; the server rebuilds the real scope from them.
      expect(turnPosts(h.wire()).at(-1).body.scope).toEqual({ paths: ['/b'] })
      expect(turnPosts(h.wire())[0].body.scope).toEqual({ paths: [] })
    }
  })

  it('keeps the thread: the narrowed turn still carries the turn before it as history', async () => {
    const h = start({ runtime })
    const first = await h.ask(FIRST)
    await h.setScope(['/b'])
    await h.ask('How do I install the gizmo?')
    expect(historyOf(answerRequests(h.wire()).at(-1))).toEqual([{ question: FIRST, answer: first.answerText }])
    expect(h.snapshot().turns).toHaveLength(2)
  })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait for something a settled promise cannot tell us: that a request is in flight, that text has been painted. */
const until = async (condition, what) => {
  for (let i = 0; i < 400; i++) {
    if (condition()) return
    await sleep(5)
  }
  throw new Error(`never reached: ${what}`)
}

const models = (h) => answerRequests(h.wire()).map((w) => w.body.model)

const encoder = new TextEncoder()
/**
 * A reply that paints part of the answer and then hangs, the way a connection
 * does when the service goes quiet mid-sentence. `fail()` ends it the way an
 * aborted `fetch` ends its body: with an AbortError on the reader. `stub.stall()`
 * cannot stand in for this, because it hangs BEFORE any text.
 */
const hangsAfterPartialAnswer = () => {
  let controller
  const args = JSON.stringify({ text: 'Send the token in a header and', citations: ['a#one'], confidence: 0.9 })
  const frame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_answer', type: 'function', function: { name: 'answer', arguments: args.slice(0, -20) } }] } }] }
  return {
    reply: () =>
      new Response(
        new ReadableStream({
          start(c) {
            controller = c
            c.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    fail: () => controller.error(new DOMException('The operation was aborted.', 'AbortError')),
  }
}

describe.each(RUNTIMES)('stopping a turn mid-stream, %s runtime', (runtime) => {
  it('settles a turn whose answer had begun as aborted, keeps what was painted, and writes nothing to it afterwards', async () => {
    const h = start({ runtime })
    const hang = hangsAfterPartialAnswer()
    h.stub.answer(hang.reply)
    const asked = h.ask(FIRST)
    await until(() => h.snapshot().turns[0]?.answerText, 'some of the answer painted')
    expect(h.snapshot().busy).toBe(true)

    h.stop()
    hang.fail()
    const turn = await asked
    expect(turn.state).toBe('aborted')
    expect(turn.answerText).toBe('Send the token in a header and')
    expect(h.snapshot().busy).toBe(false)

    // The abort is the last word on the turn: waiting changes nothing, and neither does stopping again.
    const settled = h.trace()
    expect(settled).toMatch(/^turn\[0\]\.state: \w+ -> aborted$/m)
    await sleep(60)
    h.stop()
    await sleep(20)
    expect(h.trace()).toBe(settled)
    const afterAbort = settled.slice(settled.indexOf('-> aborted'))
    expect(afterAbort).not.toMatch(/turn\[0\]\.(answer|sources|citations|thought)/)
  })

  it('leaves the session able to take the next question', async () => {
    const h = start({ runtime })
    const hang = hangsAfterPartialAnswer()
    h.stub.answer(hang.reply)
    const asked = h.ask(FIRST)
    await until(() => h.snapshot().turns[0]?.answerText, 'some of the answer painted')
    h.stop()
    hang.fail()
    await asked

    h.stub.answer(null)
    const next = await h.ask(FOLLOW_UP)
    expect(next.state).toBe('complete')
    expect(h.snapshot().busy).toBe(false)
    expect(h.snapshot().turns.map((t) => t.state)).toEqual(['aborted', 'complete'])
  })

  // 2.1.1 settles a stop BEFORE any text as `no-answer` with the `not-answerable`
  // refusal, not as `aborted`: `aborted` needs an answer on screen to keep.
  it('settles a turn stopped before any text as no-answer, not as aborted', async () => {
    const h = start({ runtime })
    h.stub.stall()
    const asked = h.ask(FIRST)
    await until(() => answerRequests(h.wire()).length > 0 && h.snapshot().busy, 'the stalled request in flight')
    await sleep(20)
    expect(h.snapshot().turns[0].answerText).toBe('')

    h.stop()
    const turn = await asked
    expect(turn.state).toBe('no-answer')
    expect(turn.refusal).toEqual({ cause: 'not-answerable' })
    expect(h.snapshot().busy).toBe(false)

    const settled = h.trace()
    await sleep(60)
    expect(h.trace()).toBe(settled)
  })
})

describe.each(RUNTIMES)('a provider that errors, %s runtime', (runtime) => {
  // `retry-after` keeps the browser's backoff in milliseconds; without it the
  // panel waits out 0.5 s, 1 s, 2 s between attempts and the test times out.
  const FAILING = { status: 500, headers: { 'retry-after': '0.01' } }

  it('with retrieval rows settles as the search-only answer: the passages, flagged hybrid, no answer text', async () => {
    const h = start({ runtime })
    h.stub.failFor('stub', FAILING, 50)
    const turn = await h.ask(FIRST)
    expect(turn.state).toBe('results')
    expect(turn.hybrid).toBe(true)
    expect(turn.answerText).toBe('')
    expect(turn.results.length).toBeGreaterThan(0)
    expect(h.snapshot().busy).toBe(false)
    // What the failure cost. The browser walks its attempts twice over (two passes of four,
    // the pool being the retry); the server's single pass is four. A rewrite that retries
    // differently fails here and is read as the change it is.
    expect(models(h)).toHaveLength(runtime === 'browser' ? 8 : 4)
  })

  // 2.1.1 difference, named once. A question that retrieves NOTHING and then meets a failing model ends differently
  // in the two runtimes: the browser still owns a (empty) retrieval, so it takes the search-only settle with zero
  // rows; the server has nothing to show and the turn is the plain error. `lexical` mode and words the corpus
  // does not contain make the retrieval empty.
  it('with nothing retrieved: the browser settles search-only with no rows, the server settles as the plain error', async () => {
    const h = start({ runtime, mode: 'lexical' })
    h.stub.failFor('stub', { status: 404 }, 20)
    const turn = await h.ask('zzqx plugh xyzzy')
    expect(turn.answerText).toBe('')
    expect(turn.results).toEqual([])
    if (runtime === 'browser') {
      expect(turn.state).toBe('results')
      expect(turn.hybrid).toBe(true)
      expect(models(h)).toHaveLength(2)
    } else {
      expect(turn.state).toBe('error')
      expect(turn.hybrid).toBe(false)
      expect(models(h)).toHaveLength(1)
    }
    expect(h.snapshot().busy).toBe(false)
  })
})

describe.each(RUNTIMES)('a 429 and the next model, %s runtime', (runtime) => {
  // A two-model chain: `head` first, `stub` behind it. The stub serves both names.
  const CHAIN = { chat: { provider: 'custom', model: 'head', models: ['head', 'stub'], baseURL: 'http://stub.test' } }
  const primed = () => {
    const h = start({ runtime, config: CHAIN })
    h.stub.models = ['head', 'stub']
    return h
  }

  it('a 429 on the first model rotates to the next, and the turn still answers', async () => {
    const h = primed()
    // A long `retry-after`: if the panel waited it out instead of rotating, this test would time out.
    h.stub.failFor('head', { status: 429, headers: { 'retry-after': '30' } }, 1)
    const turn = await h.ask(FIRST)
    expect(turn.state).toBe('complete')
    expect(turn.answerText).toContain('[1]')
    expect(models(h)).toEqual(['head', 'stub'])
    expect(h.snapshot().busy).toBe(false)

    // No server rotation trace: rotation there happens inside the server's turn, and
    // the browser never sees the server's provider order. The browser's is the committed sequence.
    if (runtime === 'browser') {
      const order = ['-- the models the stub received, in order', ...models(h)]
      await expect(`${h.trace()}${order.join('\n')}\n`).toMatchFileSnapshot('./traces/rotation.browser.trace')
    }
  })

  // The model that failed is not asked again for the next question: it is cooling.
  it('keeps the next question on the model that answered', async () => {
    const h = primed()
    h.stub.failFor('head', { status: 429, headers: { 'retry-after': '30' } }, 1)
    await h.ask(FIRST)
    const mark = answerRequests(h.wire()).length
    const next = await h.ask(FOLLOW_UP)
    expect(next.state).toBe('complete')
    expect(models(h).slice(mark)).toEqual(['stub'])
  })

  it('every model returning 429 ends in the search-only answer, not in an error', async () => {
    const h = primed()
    const limited = { status: 429, headers: { 'retry-after': '0.01' } }
    h.stub.failFor('head', limited, 50)
    h.stub.failFor('stub', limited, 50)
    const turn = await h.ask(FIRST)
    // A minute's 429 is not the day's: `rate-limited` needs the service to say the DAY is spent
    // (chat-outcomes.test.js pins that). Here every model refuses and the passages are the answer.
    expect(turn.state).toBe('results')
    expect(turn.hybrid).toBe(true)
    expect(turn.results.length).toBeGreaterThan(0)
    expect(turn.answerText).toBe('')
    expect(h.snapshot().busy).toBe(false)
    // The requests it took, in order. 2.1.1 gives each model its turn and then spends the rest on the last.
    if (runtime === 'browser') {
      expect(models(h)).toEqual(['head', 'stub', 'stub', 'stub', 'stub', 'stub', 'head', 'head', 'head', 'head'])
    } else {
      expect(models(h)).toEqual(['head', 'stub', 'stub', 'stub', 'stub'])
    }
  })
})
