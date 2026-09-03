import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

import { chat, resetPools, resetCaps } from '../src/theme/docpilot/llm.js'
import { providerFor } from '../src/theme/docpilot/providers.js'
import { assembleIndex } from '../src/theme/docpilot/store.js'
import { createHistory } from '../src/theme/docpilot/history.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { runTurn } from '../src/theme/docpilot/harness.js'
import { BUDGET_DEFAULTS } from '../src/theme/docpilot/switches.js'
import { createBudget } from '../src/theme/docpilot/budget.js'
import { resolveDocPilot, themeDocPilot, nodeChatTarget } from '../src/config.js'

/**
 * The four transport changes the free tier needed, and the two places they
 * surface.
 *
 * Every one of them was measured against a live pool and none of them may need
 * one to be re-checked: a rule about a fifty-request day is a rule that gets
 * exactly one honest test run per day if the socket is real. So the transport is
 * stubbed throughout, and what is asserted is the REQUEST COUNT as much as the
 * answer — the whole feature is about how many of those a reader has left.
 */

const ENV = { OPENROUTER_API_KEY: 'sk-or-not-in-the-bundle' }

/** A reply the openai adapter can parse, with the headers `chat()` reads. */
const reply = (content, extra = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers(extra.headers || {}),
  json: async () => ({
    choices: [{ message: { content }, finish_reason: extra.finishReason ?? 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
})

/**
 * A 429, in whichever of its two kinds. `limit_source: 'daily'` is where
 * OpenRouter names the one the pool cannot rescue; `clone()` is there because
 * `fetchWithRetry` peeks at the body before deciding to wait and must leave the
 * response unread for `rateLimitOf`.
 */
const tooManyRequests = (source, headers = {}) => {
  const payload = {
    error: { message: 'rate limited', metadata: source ? { limit_source: source } : {} },
  }
  const make = () => ({
    ok: false,
    status: 429,
    headers: new Headers(headers),
    json: async () => payload,
    clone: () => make(),
  })
  return make()
}

/**
 * A REFUSAL WITH A BODY, which is the only kind this transport can now learn
 * from. Both shapes are copied from live OpenRouter responses captured against
 * the deployed site — the same status, two different faults:
 *
 *   `params`  the body named a parameter this endpoint does not publish. Every
 *             member of the pool would refuse the identical body, so the fix is
 *             a smaller body to the same model.
 *   `policy`  the ACCOUNT's guardrails removed every endpoint for this model.
 *             Nothing in the request can fix it; another model might still have
 *             an eligible endpoint.
 */
const refusal = (kind, status = 404) => {
  const payload =
    kind === 'params'
      ? {
          error: {
            message:
              'No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection',
            code: status,
            metadata: { failed_routing_step: 'Filter by Parameters' },
          },
        }
      : {
          error: {
            message:
              '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\nZDR violation (account settings): 1 endpoint excluded',
            code: status,
            metadata: { failed_routing_step: 'Filter by Guardrails' },
          },
        }
  const text = JSON.stringify(payload)
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    }),
    json: async () => payload,
    clone: () => ({ json: async () => payload }),
  }
}

const sse = (frames) =>
  new ReadableStream({
    start(c) {
      const enc = new TextEncoder()
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
      c.close()
    },
  })

const ask = (extra = {}) =>
  chat({
    provider: 'openai',
    baseURL: '/ai',
    messages: [{ role: 'user', content: 'q' }],
    tools: false,
    ...extra,
  })

const ANSWER = '{"tool": "answer", "args": {"text": "ok"}}'
const PROSE = 'Sure! To configure the widget, open the settings page and fill in the token.'

/**
 * A reply that CALLS a tool, which is what a loop step answers with — the shape
 * the harness's iteration budget is actually spent on. `reply()` above covers
 * the other two shapes a turn sees: the final call's JSON object and prose.
 */
const toolReply = (name, args, extra = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers(extra.headers || {}),
  json: async () => ({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
})

/** What the forced final call must produce: the strict schema, satisfied. */
const FINAL_ANSWER = JSON.stringify({
  text: 'The alpha widget takes a manifest [1].',
  citations: ['a#one'],
  confidence: 0.8,
})

/**
 * Six of ten members of the live free pool answered the strict final call in
 * PROSE. The transport accepted that as success, so the request was spent, the
 * answer was thrown away as `not-answerable`, and the model that did it became
 * `pool.sticky` — asked first for every later question on the page.
 */
describe('a reply in the wrong shape costs a model its turn', () => {
  beforeEach(() => resetPools())
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  it('rotates past a model that answered in prose', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      return model === 'a' ? reply(PROSE) : reply(ANSWER)
    })

    const out = await ask({ models: ['a', 'b'] })
    expect(asked).toEqual(['a', 'b'])
    expect(out.model).toBe('b')
    expect(out.parseError).toBeUndefined()
    expect(out.toolCall).toEqual({ name: 'answer', args: { text: 'ok' } })
  })

  it('rotates past prose under the strict schema too', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      return model === 'a' ? reply(PROSE) : reply('{"text": "ok", "citations": []}')
    })

    const out = await ask({ models: ['a', 'b'], schema: { type: 'object' } })
    expect(asked).toEqual(['a', 'b'])
    expect(out.toolCall.args).toEqual({ text: 'ok', citations: [] })
  })

  /**
   * A parse error on the LAST candidate is still returned as it is today. The
   * harness reads `parseError` and lands the turn on a refusal it can explain;
   * inventing a transport failure here would replace that with "the AI service
   * didn't respond", which is false about a service that answered.
   */
  it('returns the last candidate’s prose with its parse error', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return reply(PROSE)
    })

    const out = await ask({ models: ['a', 'b'] })
    expect(asked).toEqual(['a', 'b'])
    expect(out.model).toBe('b')
    expect(out.parseError).toBe('could not read the response')
    expect(out.text).toBe(PROSE)
  })

  /**
   * The whole rotation branch is gated on there being somewhere to rotate TO.
   * A single Ollama that answers in prose must post exactly one request and get
   * exactly the reply it always did — this fix may not cost an unpooled
   * deployment anything.
   */
  it('never rotates a single-model deployment', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return reply(PROSE)
    })

    const out = await ask({ model: 'only' })
    expect(asked).toEqual(['only'])
    expect(out.model).toBe('only')
    expect(out.parseError).toBe('could not read the response')
  })

  /**
   * `rotateOnParseError: false` is what a caller with one request left asks
   * for. What it buys is the REQUEST — the reply it keeps has no citations and
   * the panel withholds it either way — so the saving is the next question,
   * not this answer.
   */
  it('keeps the prose when the caller says not to spend a request on it', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return reply(PROSE)
    })

    const out = await ask({ models: ['a', 'b'], rotateOnParseError: false })
    expect(asked).toEqual(['a'])
    expect(out.model).toBe('a')
    expect(out.parseError).toBe('could not read the response')
  })

  /** An EMPTY reply still rotates, whatever `rotateOnParseError` says. */
  it('still rotates past a model that said nothing at all', async () => {
    vi.stubGlobal('fetch', async (_url, init) =>
      JSON.parse(init.body).model === 'a' ? reply('') : reply(ANSWER),
    )
    expect((await ask({ models: ['a', 'b'], rotateOnParseError: false })).model).toBe('b')
  })
})

/**
 * The two 429s are nothing alike, and treating them alike is the most expensive
 * mistake this file can make: measured on a pool of three, one spent day cost
 * six requests and up to forty seconds of `retry-after` before the reader was
 * told anything at all.
 */
describe('the day’s 429 is not the minute’s', () => {
  beforeEach(() => resetPools())
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  it('neither waits nor rotates when the DAY is what ran out', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return tooManyRequests('daily', {
        'retry-after': '20',
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Date.UTC(2026, 7, 21)),
      })
    })

    const err = await ask({ models: ['a', 'b', 'c'] }).then(
      () => null,
      (e) => e,
    )
    // ONE request. Every model in the pool shares one account's allowance, so
    // asking the other two spends two more answers to be told the same thing.
    expect(asked).toEqual(['a'])
    expect(err.status).toBe(429)
    expect(err.rateLimit).toMatchObject({
      daily: true,
      limit: 50,
      remaining: 0,
      resetAt: Date.UTC(2026, 7, 21),
    })
  })

  it('spends one request on a spent day even with nowhere to rotate', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return tooManyRequests('daily', { 'retry-after': '30' })
    })
    await expect(ask({ model: 'only' })).rejects.toThrow('chat 429')
    // Was four: three retries and two waits of twenty seconds, to learn what the
    // first response already said.
    expect(calls).toBe(1)
  })

  it('still rotates and still retries the minute’s limit', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      return model === 'a' ? tooManyRequests('minute', { 'retry-after': '1' }) : reply(ANSWER)
    })
    const out = await ask({ models: ['a', 'b'] })
    expect(asked).toEqual(['a', 'b'])
    expect(out.model).toBe('b')
  })

  /**
   * A proxy in front of the service answering in HTML has no `limit_source` and
   * no `clone()` worth reading. That must behave exactly as it did before the
   * daily gate existed — the burst path, which waits and retries.
   */
  it('treats an unreadable 429 body as the burst limit it used to be', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      if (calls > 1) return reply(ANSWER)
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0' }),
        json: async () => {
          throw new Error('not json')
        },
      }
    })
    const out = await ask({ model: 'only' })
    expect(calls).toBe(2)
    expect(out.toolCall.name).toBe('answer')
  })

  /** Every completed response, success or 429, reaches whoever keeps the ledger. */
  it('reports the headers of a 429 as readily as those of an answer', async () => {
    const seen = []
    vi.stubGlobal('fetch', async (_url, init) =>
      JSON.parse(init.body).model === 'a'
        ? tooManyRequests('minute', { 'x-ratelimit-remaining': '9' })
        : reply(ANSWER, { headers: { 'x-ratelimit-remaining': '8' } }),
    )
    await ask({ models: ['a', 'b'], onHeaders: (h) => seen.push(h.get('x-ratelimit-remaining')) })
    expect(seen).toEqual(['9', '8'])
  })

  /**
   * `limit_source` is observed live and appears in no public documentation of
   * OpenRouter's or of anybody else's, so a daily 429 from any other service —
   * or from OpenRouter on the day it renames a metadata key — used to be read as
   * the burst limit: four attempts, two waits of up to twenty seconds, then the
   * whole pool, against an allowance already at zero.
   */
  describe('and it is not the only way to say so', () => {
    const POOL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

    /**
     * Every member refuses but the last, which answers. A pool that walks to the
     * end therefore ANSWERS rather than waiting out three backoffs on the final
     * candidate — the assertion is about how many requests the day's 429 costs,
     * and a suite that slept four seconds to make it would be paying for the
     * wrong thing.
     */
    const spent = async (payload, headers) => {
      const asked = []
      const refuse = () => ({
        ok: false,
        status: 429,
        headers: new Headers(headers),
        json: async () => payload,
        clone: () => refuse(),
      })
      vi.stubGlobal('fetch', async (_url, init) => {
        const { model } = JSON.parse(init.body)
        asked.push(model)
        return model === POOL.at(-1) ? reply(ANSWER) : refuse()
      })
      const err = await ask({ models: POOL }).then(
        () => null,
        (e) => e,
      )
      return { requests: asked.length, daily: err?.rateLimit?.daily ?? false }
    }

    it('reads the sentence when the metadata is not there', async () => {
      expect(
        await spent({ error: { message: 'Rate limit exceeded: free-models-per-day' } }, {
          'retry-after': '20',
        }),
      ).toEqual({ requests: 1, daily: true })
    })

    /** Nothing left, and what is left comes back tomorrow. That is a day. */
    it('reads the headers when there is no sentence either', async () => {
      expect(
        await spent(
          { error: { message: 'Too many requests' } },
          {
            'retry-after': '20',
            'x-ratelimit-limit': '50',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Date.now() + 11 * 3600000),
          },
        ),
      ).toEqual({ requests: 1, daily: true })
    })

    /**
     * THE BURST REPORTS `remaining: 0` TOO, and it lifts in a second. Every
     * mechanism this file already has is the right answer to it, so the
     * ten-minute floor under the third rule is what keeps the other three
     * honest.
     */
    it('leaves the minute’s limit exactly as it was', async () => {
      expect(
        await spent(
          { error: { message: 'Too many requests' } },
          {
            'retry-after': '0',
            'x-ratelimit-limit': '20',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Date.now() + 45000),
          },
        ),
      ).toEqual({ requests: POOL.length, daily: false })
    })

    it('leaves a 429 that says nothing at all exactly as it was', async () => {
      expect(await spent({ error: { message: 'nope' } }, { 'retry-after': '0' })).toEqual({
        requests: POOL.length,
        daily: false,
      })
    })
  })
})

/**
 * What a TURN may spend, honoured at the one place requests are issued.
 *
 * Rotation, continuation and the iteration ceiling were three orthogonal flags,
 * so "one request per turn" bounded none of them: at the boundary the single
 * forced call could still walk a ten-member pool with a continuation each —
 * twenty requests spent by the turn that was rationed to one.
 */
describe('a ceiling on the turn’s requests', () => {
  const POOL = ['a', 'b', 'c', 'd']
  beforeEach(() => resetPools())
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  const proseFrom = () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return reply(PROSE)
    })
    return asked
  }

  it('stops walking the pool once the turn has spent its allowance', async () => {
    const asked = proseFrom()
    const out = await ask({ models: POOL, maxRequests: 2 })
    expect(asked).toEqual(['a', 'b'])
    // The best reply it has, not an invented failure: the harness reads
    // `parseError` and can explain the turn it ends.
    expect(out.model).toBe('b')
    expect(out.parseError).toBe('could not read the response')
  })

  it('spends one request when that is the whole allowance', async () => {
    const asked = proseFrom()
    expect((await ask({ models: POOL, maxRequests: 1 })).model).toBe('a')
    expect(asked).toEqual(['a'])
  })

  it('walks the whole pool when nothing said not to', async () => {
    const asked = proseFrom()
    await ask({ models: POOL })
    expect(asked).toEqual(POOL)
  })

  /** A continuation is a request like any other and comes out of the same number. */
  it('will not continue a truncated reply it cannot pay for', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return reply('{"text": "half an', { finishReason: 'length' })
    })
    await ask({ model: 'only', schema: { type: 'object' }, continuations: 2, maxRequests: 1 })
    expect(asked).toEqual(['only'])
  })

  /**
   * A transport failure is not a shape failure, and the rule is the same: the
   * next model is a request the turn does not have, so the error travels rather
   * than the pool being walked. A 404 — a model the catalogue has retired — is
   * rotatable and not retryable, so what is measured here is only the rotation.
   */
  it('does not rotate past a failure it cannot afford to replace', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
    })
    await expect(ask({ models: POOL, maxRequests: 1 })).rejects.toThrow('chat 404')
    expect(asked).toEqual(['a'])
  })

  /**
   * RETRIES ARE NOT ROTATIONS and the ceiling does not bound them. A burst 429
   * is refused rather than answered, so it costs no answer, and the alternative
   * to waiting it out is a failed turn the reader asks again anyway — measured
   * against the live pool, three of four failures were exactly that, with a
   * `retry-after: 1`. What the ceiling stops is spending the day's remaining
   * ANSWERS on a second opinion.
   *
   * So the deployment with nowhere to rotate still waits, on any allowance, and
   * answers with two requests against a ceiling of one. The LAST candidate of a
   * pool is the same case for the same reason — free-pool.test.js asserts it
   * there, where the pool's own rules live.
   */
  it('still waits out the minute’s limit where waiting is the only thing left', async () => {
    const asked = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      if (++calls > 1) return reply(ANSWER)
      return tooManyRequests('minute', { 'retry-after': '0' })
    })
    const out = await ask({ model: 'only', maxRequests: 1 })
    expect(out.toolCall.name).toBe('answer')
    expect(asked).toEqual(['only', 'only'])
  })

  /**
   * WAITING AND ROTATING ARE ALTERNATIVES, AND NO CEILING MAY FORBID BOTH.
   *
   * `reachable` decides one attempt (the pool is the retry) or four with waits.
   * Asking only whether another CANDIDATE exists is a bet that rotation is
   * available, and on a rationed turn the bet is false: at a ceiling of one the
   * first candidate got its single attempt, `affordable()` was then already
   * spent, and the turn died having neither waited nor rotated. Measured through
   * the harness, a burst 429 that lifted a second later cost a reader at six
   * answers left their whole question — two requests and `text: ""`, which the
   * panel prints as "I couldn't find this in the docs".
   *
   * So the question is whether the next candidate can be REACHED: one exists and
   * the request that would reach it is still affordable after this one. Exactly
   * one candidate per call gets the wait budget — the last the ceiling can
   * reach — and which one that is moves with the ceiling.
   */
  it('waits out the minute’s limit once rotation is no longer affordable', async () => {
    const asked = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return ++calls > 1 ? reply(ANSWER) : tooManyRequests('minute', { 'retry-after': '0.001' })
    })
    // One request in the allowance and three models behind it, none of them
    // reachable. This used to throw after ['a'].
    const out = await ask({ models: ['a', 'b', 'c'], maxRequests: 1 })
    expect(out.toolCall.name).toBe('answer')
    expect(asked).toEqual(['a', 'a'])
  })

  /**
   * AND THINNESS STILL BUYS NO EXTRA REQUESTS, which is the other way this line
   * has been wrong: `ceiling - spent > 1` once selected the four-attempt branch
   * for a NON-last candidate while the ceiling was thin, so a rationed turn
   * re-asked the model that had just refused and never reached the rest.
   *
   * Both properties hold at once and this is the measurement that says so —
   * every response a 429, so nothing can succeed and the whole retry policy is
   * visible. Thinner is cheaper at every step, and one candidate waits in each.
   */
  it('never spends more requests on a thin ceiling than on no ceiling at all', async () => {
    const walk = async (maxRequests) => {
      resetPools()
      const asked = []
      vi.stubGlobal('fetch', async (_url, init) => {
        asked.push(JSON.parse(init.body).model)
        return tooManyRequests('minute', { 'retry-after': '0.001' })
      })
      await expect(ask({ models: ['a', 'b', 'c'], maxRequests })).rejects.toThrow('429')
      return asked
    }
    expect(await walk(1)).toEqual(['a', 'a', 'a', 'a'])
    expect(await walk(2)).toEqual(['a', 'b', 'b', 'b', 'b'])
    expect(await walk(Infinity)).toEqual(['a', 'b', 'c', 'c', 'c', 'c'])
  })

  /**
   * THE FLOOR IS THE FORCED FINAL CALL'S GUARANTEE, and it is the reason the
   * clamp stays: harness.js reserves the last request for that call, so a
   * `maxRequests` of zero or less reaching here means the loop overdrew the turn
   * — through retries, which are outside the ceiling by decision. Ending on "I
   * couldn't find this in the docs" to save one request would be this feature
   * spending the reader's question to protect their quota.
   */
  it('still makes the one request the answer comes from when the turn is overdrawn', async () => {
    const asked = proseFrom()
    await ask({ models: POOL, maxRequests: 0 })
    expect(asked).toEqual(['a'])

    // A kept-but-wrong reply cools the model that gave it, so the pool would
    // otherwise lead with somebody else on the second call.
    resetPools()
    await ask({ models: POOL, maxRequests: -3 })
    expect(asked).toEqual(['a', 'a'])
  })

  /**
   * KEPT, NOT REWARDED — and `POOLS` is module scope, so this outlives the turn.
   * A model whose prose we could not afford to replace used to become sticky AND
   * have its cooldown cleared, which put it first on every later call, into the
   * next day when rotating past it was free again.
   */
  it('does not make the model it could not replace the pool’s favourite', async () => {
    const first = proseFrom()
    await ask({ models: POOL, maxRequests: 1 })
    expect(first).toEqual(['a'])

    vi.unstubAllGlobals()
    const second = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      second.push(model)
      return model === 'a' ? reply(PROSE) : reply(ANSWER)
    })
    // 'a' is cooling now, so the next turn leads with someone else — and the
    // answer arrives on the first request rather than the second.
    await ask({ models: POOL })
    expect(second[0]).not.toBe('a')
  })

  /**
   * The same reply on a comfortable budget: rotated past, and the model that
   * DID answer is the one the pool remembers.
   */
  it('still rewards the model that answered as asked', async () => {
    vi.stubGlobal('fetch', async (_url, init) =>
      JSON.parse(init.body).model === 'a' ? reply(PROSE) : reply(ANSWER),
    )
    expect((await ask({ models: POOL })).model).toBe('b')

    const second = []
    vi.stubGlobal('fetch', async (_url, init) => {
      second.push(JSON.parse(init.body).model)
      return reply(ANSWER)
    })
    await ask({ models: POOL })
    expect(second).toEqual(['b'])
  })

  /**
   * `emitted` means the reader SAW something, and only the consumer knows. The
   * final call streams a JSON object and the panel paints the value of one key
   * inside it, so a model answering in prose streams frames from first token to
   * last and puts nothing on the screen — which is exactly the reply worth
   * asking the next model for.
   */
  it('rotates when the consumer says it painted nothing', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: sse([{ choices: [{ delta: { content: model === 'a' ? PROSE : ANSWER } }] }]),
      }
    })
    // The shape harness.js's streamer has: truthy only when it painted.
    const out = await ask({ models: ['a', 'b'], onDelta: (d) => d.contentSoFar?.includes('"text"') })
    expect(asked).toEqual(['a', 'b'])
    expect(out.model).toBe('b')
  })
})

/**
 * `chat.maxTokens` was documented, resolved, carried all the way down to the
 * adapter — and then dropped, because only the anthropic adapter ever
 * destructured it.
 */
describe('the openai request body', () => {
  const openai = providerFor('openai')
  const body = (o = {}) =>
    openai.body({ model: 'm', messages: [{ role: 'user', content: 'q' }], streaming: false, ...o })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  it('sends the ceiling the site configured', () => {
    expect(body({ maxTokens: 2048 }).max_tokens).toBe(2048)
    // Absent is absent: a provider's own default is the right answer when
    // nothing was configured, and `max_tokens: undefined` is not that.
    expect('max_tokens' in body({})).toBe(false)
  })

  it('carries maxTokens the whole way from chat()', async () => {
    const bodies = []
    vi.stubGlobal('fetch', async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return reply(ANSWER)
    })
    await ask({ model: 'only', maxTokens: 1234 })
    expect(bodies[0].max_tokens).toBe(1234)
  })

  /**
   * The brand-specific fragment. It lives in config.js because that is where
   * brands are known, and it merges here because the client knows adapters, not
   * brands — OpenRouter's `provider.require_parameters` being the case it exists
   * for, and the measured cause of the prose replies above.
   */
  it('merges extraBody at the top level of the request', () => {
    const b = body({ extraBody: { provider: { require_parameters: true } } })
    expect(b.provider).toEqual({ require_parameters: true })
    expect(b.model).toBe('m')
  })

  /**
   * And it merges FIRST, so nothing configuration supplies can overwrite a field
   * the adapter owns. A stray `stream: false` in an author's `extraBody` would
   * otherwise turn off streaming for every reader on the site.
   */
  it('cannot overwrite a field the adapter owns', () => {
    const b = body({
      streaming: true,
      maxTokens: 100,
      schemaBody: { type: 'object' },
      extraBody: {
        model: 'somebody-elses-model',
        stream: false,
        messages: [],
        max_tokens: 1,
        response_format: { type: 'text' },
      },
    })
    expect(b.model).toBe('m')
    expect(b.stream).toBe(true)
    expect(b.messages).toHaveLength(1)
    expect(b.max_tokens).toBe(100)
    expect(b.response_format.type).toBe('json_schema')
  })

  it('ignores an extraBody that is not an object of fields', () => {
    for (const junk of [null, undefined, 'provider=x', 42, ['provider']]) {
      const b = body({ extraBody: junk })
      expect(b.model, String(junk)).toBe('m')
      expect(Object.keys(b)[0], String(junk)).toBe('model')
    }
  })

  it('forwards extraBody from chat() to the wire', async () => {
    const bodies = []
    vi.stubGlobal('fetch', async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return reply(ANSWER)
    })
    await ask({ model: 'only', extraBody: { provider: { require_parameters: true } } })
    expect(bodies[0].provider).toEqual({ require_parameters: true })
  })
})

/**
 * `require_parameters` is a defect fix — without it OpenRouter routes the strict
 * final call to upstreams that drop `response_format` — but it is not a neutral
 * one: it narrows routing, so it changes which model answers and can turn a
 * served request into "no provider available". A behaviour change an author
 * cannot decline is a decision taken on their behalf, so PRESENCE decides.
 */
describe('the body fragment an author can decline', () => {
  const llmOf = (settings) => themeDocPilot(resolveDocPilot(settings), ENV).llm
  const cliOf = (settings) => nodeChatTarget(resolveDocPilot(settings), ENV)

  it('posts the provider default where the author said nothing', () => {
    const shipped = { provider: { require_parameters: true } }
    expect(llmOf({ chat: { provider: 'openrouter' } }).extraBody).toEqual(shipped)
    // The CLI's annotation pass posts the same body as the panel, or the two
    // route differently and nobody would think to look.
    expect(cliOf({ chat: { provider: 'openrouter' } }).extraBody).toEqual(shipped)
    // Every other provider has no fragment at all, and null rather than
    // undefined: JSON.stringify deletes an undefined key on the way to the page.
    expect(llmOf({ chat: { provider: 'ollama', model: 'qwen3:8b' } }).extraBody).toBe(null)
  })

  it('takes an explicit null as the plain body, in both places', () => {
    const declined = { chat: { provider: 'openrouter', extraBody: null } }
    expect(llmOf(declined).extraBody).toBe(null)
    expect(cliOf(declined).extraBody).toBe(null)
    // And it survives the trip into a page, where the theme config is JSON.
    expect(JSON.parse(JSON.stringify(llmOf(declined))).extraBody).toBe(null)
  })

  it('replaces the provider fragment rather than merging with it', () => {
    // A merge would leave `require_parameters` in place with no way to spell its
    // removal, which is the whole point of the key.
    const own = { provider: { sort: 'throughput' } }
    const settings = { chat: { provider: 'openrouter', extraBody: own } }
    expect(llmOf(settings).extraBody).toEqual(own)
    expect(cliOf(settings).extraBody).toEqual(own)
  })

  /** A fragment meant for chat completions has no business at an embeddings endpoint. */
  it('never reaches the embed half', () => {
    expect(themeDocPilot(resolveDocPilot({ chat: { provider: 'openrouter' } }), ENV).embed)
      .not.toHaveProperty('extraBody')
  })
})

/**
 * `'length'` is the difference between a model that answered badly and one that
 * was cut off mid-word, and the two used to be indistinguishable: a truncated
 * `{"text": "…` fails JSON.parse, lands as a parse error, and the turn ends on
 * "I couldn't find this in the docs" about an answer that was most of the way
 * written.
 */
describe('why a reply stopped', () => {
  const openai = providerFor('openai')

  it('surfaces finish_reason from a whole response', () => {
    expect(
      openai.parse({ choices: [{ message: { content: 'half' }, finish_reason: 'length' }] })
        .finishReason,
    ).toBe('length')
    expect(openai.parse({ choices: [{ message: { content: 'all' } }] }).finishReason).toBe(null)
  })

  it('surfaces finish_reason from the stream', async () => {
    const res = {
      body: sse([
        { choices: [{ delta: { content: 'half' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
        // The usage frame arrives AFTER the terminal one and carries no choices.
        // Read unconditionally, it erased the reason a frame after learning it.
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ]),
    }
    const out = await openai.readStream(res, () => {})
    expect(out.finishReason).toBe('length')
    expect(out.content).toBe('half')
    expect(out.usage.outputTokens).toBe(2)
  })

  /**
   * The other two adapters report null on purpose: a continuation is a prefill,
   * and that shape is only reliable on the OpenAI-shaped services this was
   * measured against. Reporting a reason nobody may act on would be a capability
   * the transport does not have.
   */
  it('is null on the adapters that cannot be continued', () => {
    expect(providerFor('ollama').parse({ message: { content: 'x' }, done_reason: 'length' })
      .finishReason).toBe(null)
    expect(
      providerFor('anthropic').parse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' })
        .finishReason,
    ).toBe(null)
  })
})

/**
 * An answer the provider cut off, finished.
 *
 * THE SEAM MUST BE INVISIBLE: the fragments are concatenated before anything
 * reads them, so `JSON.parse` sees one document and never a half of one.
 */
describe('finishing a truncated answer', () => {
  beforeEach(() => resetPools())
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  const halves = ['{"text": "The widget is configured ', 'with a manifest and a token."}']

  it('continues, concatenates, and parses only the whole', async () => {
    const bodies = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      const n = bodies.length
      return reply(halves[n - 1], { finishReason: n === 1 ? 'length' : 'stop' })
    })

    const out = await ask({ model: 'only', schema: { type: 'object' }, continuations: 1 })

    expect(bodies).toHaveLength(2)
    // The schema parsed — which it cannot have done on either fragment alone.
    expect(out.parseError).toBeUndefined()
    expect(out.toolCall.args.text).toBe('The widget is configured with a manifest and a token.')
    // Both requests are charged to the turn, or a continuation's tokens vanish
    // from the accounting. `cachedTokens` stays null across the sum: neither leg
    // reported a cache, and summing two silences as 0 would claim a measured
    // miss on a transport that measures nothing.
    expect(out.usage).toEqual({ promptTokens: 20, outputTokens: 10, cachedTokens: null })
  })

  /**
   * The second request is a PREFILL and it must not carry the schema: under a
   * strict `json_schema` the completion has to be a whole valid object on its
   * own, so the model starts the answer again and truncates in the same place.
   */
  it('sends the partial back as the assistant’s own words, without the schema', async () => {
    const bodies = []
    vi.stubGlobal('fetch', async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return reply(halves[bodies.length - 1], { finishReason: bodies.length === 1 ? 'length' : 'stop' })
    })
    await ask({ model: 'only', schema: { type: 'object' }, continuations: 1 })

    expect(bodies[0].response_format.type).toBe('json_schema')
    expect(bodies[1].response_format).toBeUndefined()
    const last = bodies[1].messages.at(-1)
    expect(last).toEqual({ role: 'assistant', content: halves[0] })
    expect(bodies[0].messages).toHaveLength(1)
  })

  /**
   * Services that do not honour a prefill treat it as context and start the
   * reply again. A doubled paragraph is a worse answer than the truncated one it
   * was meant to rescue.
   */
  it('drops a fragment that repeats what it is continuing', async () => {
    const n = []
    vi.stubGlobal('fetch', async () => {
      n.push(1)
      return n.length === 1
        ? reply('The widget is configured with a manifest ', { finishReason: 'length' })
        : reply('The widget is configured with a manifest and a token.')
    })
    const out = await ask({ model: 'only', continuations: 1 })
    expect(out.text).toBe('The widget is configured with a manifest and a token.')
  })

  it('is bounded by what the caller allowed', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      if (calls > 12) throw new Error('runaway: continuations are not bounded')
      return reply(`fragment ${calls} `, { finishReason: 'length' })
    })

    calls = 0
    await ask({ model: 'only', continuations: 1 })
    expect(calls).toBe(2)

    calls = 0
    await ask({ model: 'only', continuations: 3 })
    expect(calls).toBe(4)
  })

  it('spends nothing extra when the budget allowed nothing', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return reply(halves[0], { finishReason: 'length' })
    })
    const out = await ask({ model: 'only', schema: { type: 'object' }, continuations: 0 })
    expect(calls).toBe(1)
    // And the truncated half is still reported honestly rather than as an answer.
    expect(out.parseError).toBe('could not read the response')
  })

  /**
   * A model that hit its ceiling on reasoning alone has written no answer text,
   * and prefilling nothing just asks the same question again.
   */
  it('does not continue a reply with nothing to continue from', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { content: '', reasoning: 'thinking…' }, finish_reason: 'length' }],
        }),
      }
    })
    await ask({ model: 'only', continuations: 2 })
    expect(calls).toBe(1)
  })

  /**
   * The panel re-renders the answer from `contentSoFar` on every frame, and a
   * second request's counter starts at zero. Un-rebased, the reader watches the
   * answer collapse to its own last paragraph mid-sentence.
   */
  it('renumbers a continuation’s deltas onto what came before', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body:
          calls === 1
            ? sse([
                { choices: [{ delta: { content: 'one ' } }] },
                { choices: [{ delta: {}, finish_reason: 'length' }] },
              ])
            : sse([{ choices: [{ delta: { content: 'two' } }] }]),
      }
    })

    const soFar = []
    await ask({
      model: 'only',
      continuations: 1,
      onDelta: (d) => d.contentSoFar != null && soFar.push(d.contentSoFar),
    })
    expect(soFar).toEqual(['one ', 'one two'])
  })
})

/**
 * The panel's end of it: what a page spends before the reader has asked
 * anything, and what it says when the day is gone.
 */
describe('a turn on a metered service', () => {
  const DIMS = 4
  const GUARD = {
    tau: 0.3,
    tauLexical: 0.3,
    wDense: 0.75,
    wLexical: 0.25,
    denseMode: 'cosine',
    cosFloor: 0.44,
    cosCeil: 0.64,
    zexp: null,
  }

  let n = 0
  const oneChunkIndex = () => {
    const vectors = new Int8Array(DIMS)
    vectors[0] = 127
    return assembleIndex({
      manifest: {
        version: 3,
        hash: `budget-${++n}`,
        embedModel: 'test-embed',
        dims: DIMS,
        chunkCount: 1,
        vectors: 'vectors.budget.bin',
        pages: [{ path: '/a', title: 'Alpha', tail: 'Docs' }],
        guard: GUARD,
      },
      shards: [
        [
          {
            id: 'a#one',
            path: '/a',
            anchor: 'one',
            title: 'Alpha',
            breadcrumb: 'Docs',
            kind: 'guide',
            text: 'The alpha widget is configured with a manifest and a token.',
            prev: null,
            next: null,
          },
        ],
      ],
      vectorBuffer: vectors.buffer,
      dfDoc: { df: {} },
    })
  }

  const fakeStorage = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    }
  }

  /** The probe posts one message and it is not a question anybody asked. */
  const isProbe = (body) => JSON.stringify(body.messages || []).includes('Call list_pages')

  /**
   * A whole fresh session module per test, and it has to be fresh.
   *
   * Three things in there are deliberately PER PAGE rather than per turn — the
   * ledger `ensureBudget` creates once, the latched answer to the capability
   * probe, and llm.js's record of which model in the pool last answered — and
   * every one of them is exactly what these tests are about. Sharing them
   * between tests would make each assertion depend on the ones before it, which
   * for a feature whose subject is a running total is the one arrangement
   * guaranteed to lie.
   */
  const start = async (settings = {}) => {
    vi.resetModules()
    const s = await import('../src/theme/docpilot/session.js')
    s.__setHistoryForTests(
      createHistory({ local: fakeStorage(), session: fakeStorage(), now: () => 1 }),
    )
    s.configure({
      docPilot: themeDocPilot(
        resolveDocPilot({ chat: { provider: 'openrouter' }, guard: { mode: 'off' }, ...settings }),
        ENV,
      ),
    })
    s.state.index = oneChunkIndex()
    s.state.degraded = false
    s.state.busy = false
    return s
  }

  /**
   * Records every chat body; embeddings answer with the index's own axis.
   *
   * ONE ROW PER INPUT, because `input` is a list whenever a turn has an
   * antecedent to compose against — the question and the composed query ride one
   * request (embed.js). A mock that answered with a fixed single row would hand
   * a follow-up two inputs and one vector, which `embedQuery` correctly refuses
   * as a short list, and every follow-up here would quietly retrieve
   * lexical-only instead of testing what it says it tests.
   */
  const transport = (onChat) => {
    const chats = []
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body)
      if (String(url).includes('/embeddings')) {
        const rows = (Array.isArray(body.input) ? body.input : [body.input]).map(() => [1, 0, 0, 0])
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: rows.map((embedding, index) => ({ embedding, index })) }),
        }
      }
      chats.push(body)
      return onChat(body, chats.length)
    })
    return chats
  }

  afterEach(() => vi.unstubAllGlobals())

  /**
   * `detectTools` is a full model call made before the reader has read a word,
   * and on a pool it asks up to three candidates. A reader who opens two pages
   * has spent two of their fifty answers finding out something the config
   * already implies: a pool is only ever configured for a hosted service whose
   * members are tool-capable by construction.
   */
  it('asks no capability probe when a pool is configured', async () => {
    const s = await start()
    expect(s.state.config.budget.probe).toBe('auto')
    expect(s.state.config.llm.models.length).toBeGreaterThan(1)

    const chats = transport(() => tooManyRequests('daily'))
    await s.submit('how is the alpha widget configured?')

    expect(chats.filter(isProbe)).toEqual([])
    // One request in the whole turn: the probe was skipped and the daily 429
    // was believed the first time it was said.
    expect(chats).toHaveLength(1)
  })

  it('keeps asking it where the question is genuinely open', async () => {
    const s = await start({ budget: { probe: 'always' } })

    const chats = transport((body) =>
      isProbe(body)
        ? {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              choices: [{ message: { tool_calls: [{ function: { name: 'list_pages' } }] } }],
            }),
          }
        : tooManyRequests('daily'),
    )
    await s.submit('how is the alpha widget configured?')

    expect(chats.filter(isProbe)).toHaveLength(1)
    expect(s.state.fallbackUnknown).toBe(false)
  })

  it('skips it outright when the project said never', async () => {
    const s = await start({
      budget: { probe: 'never' },
      chat: { provider: 'ollama', model: 'qwen3:8b' },
    })
    const chats = transport(() => tooManyRequests('daily'))
    await s.submit('how is the alpha widget configured?')
    expect(chats.filter(isProbe)).toEqual([])
  })

  /**
   * "The AI service didn't respond" is false here in the way that matters: the
   * service responded, promptly, and named the hour it will answer again. A
   * reader told that it failed retries learns nothing they can act on.
   */
  it('ends a spent day in its own state, not in an error', async () => {
    const s = await start()
    // Relative to now, not a written-down date: a fixed instant makes this test
    // a clock — it expires the moment the day it names arrives, and it is now
    // also close enough to a burst window to be dropped in the ten minutes
    // before that.
    const resetAt = Date.now() + 3_600_000
    transport(() =>
      tooManyRequests('daily', {
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetAt),
      }),
    )

    await s.submit('how is the alpha widget configured?')

    const turn = s.state.turns.at(-1)
    expect(turn.state).toBe('rate-limited')
    expect(turn.error).toBeUndefined()
    expect(turn.rateLimit).toEqual({ resetAt, limit: 50 })
    expect(s.state.busy).toBe(false)
    // And what the service said on its way past is kept: the panel can state
    // the day's remaining count on the very response that refused the turn.
    expect(s.state.budget).toMatchObject({ limit: 50, remaining: 0, source: 'header' })

    // SPOKEN, and both halves of it. A reader on a screen reader otherwise gets
    // the same silence for a spent quota as for a slow answer, and then a panel
    // that has simply stopped producing them. The reset time is the actionable
    // half and was rendered for sighted readers only.
    expect(s.state.announce).toContain('daily limit')
    expect(s.state.announce).toContain('Answers resume')
    expect(s.state.announce).toBe(
      `The free daily limit for this site's AI is used up. ${s.resetLine(turn)}`,
    )
  })

  /** A 429 that named no reset says one clean sentence rather than a guess. */
  it('announces the limit alone when the service named no hour', async () => {
    const s = await start()
    transport(() => tooManyRequests('daily'))
    await s.submit('how is the alpha widget configured?')

    expect(s.state.turns.at(-1).state).toBe('rate-limited')
    expect(s.resetLine(s.state.turns.at(-1))).toBe('')
    expect(s.state.announce).toBe("The free daily limit for this site's AI is used up.")
  })

  /**
   * The burst limit is the one the pool exists for, and it must keep behaving
   * as it always did: rotate, and let the turn settle on whatever the next model
   * says. It is emphatically NOT the day's terminal state — that sentence names
   * an hour, and this limit lifts in a second.
   */
  it('rotates past the minute’s limit rather than ending the day', async () => {
    const s = await start()
    const chats = transport((body, i) =>
      i === 1
        ? tooManyRequests('minute', { 'retry-after': '1' })
        : reply('{"tool": "answer", "args": {"text": "The alpha widget takes a manifest [1]."}}'),
    )

    await s.submit('how is the alpha widget configured?')

    expect(chats.length).toBeGreaterThan(1)
    const turn = s.state.turns.at(-1)
    expect(turn.state).not.toBe('rate-limited')
    expect(turn.rateLimit).toBeUndefined()
  })

  /**
   * The panel can state the budget before the first question, because the
   * ceiling for a provider config.js knows to be metered is a published number
   * rather than something to be discovered by hitting it.
   */
  it('has a budget to show before anybody has asked anything', async () => {
    const s = await start()
    expect(s.state.budget).toMatchObject({ limit: 50, remaining: 50, source: 'local' })
    expect(s.state.budgetMode).toBe('agentic')
  })

  /**
   * And nothing to show where there is nothing to count. An unknown budget is
   * not a budget: "? of ? answers left" is worse than no line at all, and every
   * plan built from one is the agentic turn that shipped.
   */
  it('shows nothing at all for a provider that meters nothing', async () => {
    const s = await start({ chat: { provider: 'ollama', model: 'qwen3:8b' } })
    expect(s.state.config.llm.rateLimited).toBe(false)
    expect(s.state.budget).toBe(null)
    expect(s.state.budgetMode).toBe('agentic')
  })

  /**
   * THE PAYING DEPLOYMENT, which is the one this must never touch.
   *
   * `rateLimited` sits on the PROVIDER and says the service publishes limits;
   * seeding a 50-a-day ceiling from it put a funded key — which has no daily cap
   * of any kind — on one request per turn after 35 questions per browser
   * profile, silently, and no line anywhere said why. `freePool` is the sentence
   * that was actually wanted: this deployment answers off the provider's own
   * free catalogue.
   */
  it('counts nothing for a funded key on a metered provider', async () => {
    const s = await start({ chat: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' } })
    expect(s.state.config.llm.rateLimited).toBe(true)
    expect(s.state.config.llm.freePool).toBe(false)
    expect(s.state.budget).toBe(null)
    expect(s.state.budgetMode).toBe('agentic')
  })

  /** An author's own list is theirs, and may be paid. The free POOL is not it. */
  it('counts nothing for a model list the author wrote themselves', async () => {
    const s = await start({ chat: { provider: 'openrouter', models: ['a:free', 'b:free'] } })
    expect(s.state.config.llm.freePool).toBe(false)
    expect(s.state.budget).toBe(null)
    // And `budget.dailyLimit` is how such a site opts in to a count.
    const declared = await start({
      chat: { provider: 'openrouter', models: ['a:free'] },
      budget: { dailyLimit: 50 },
    })
    expect(declared.state.budget).toMatchObject({ limit: 50, remaining: 50, source: 'local' })
  })

  /**
   * A ceiling the project wrote down wins over the provider table, so a site
   * pointing DocPilot at some other rate-limited endpoint counts against its
   * own number rather than OpenRouter's.
   */
  it('counts against the ceiling the project stated', async () => {
    const s = await start({
      chat: { provider: 'ollama', model: 'qwen3:8b' },
      budget: { dailyLimit: 8 },
    })
    expect(s.state.budget).toMatchObject({ limit: 8, remaining: 8, source: 'local' })
  })

  /**
   * THE ALLOWANCE BELONGS TO THE TURN, not to each call the turn makes.
   *
   * `budget: {mode: 'agentic'}` pins the loop on, so a rationed turn here still
   * runs the loop. Handing each call `plan.maxRequests` gave every one of them
   * its own copy of the whole allowance: the plan said two requests and the turn
   * spent four, because the final call still had a rotation in hand after two
   * steps had spent one each. Subtracting what the turn has already spent
   * narrowed that to three — a step, a step, and the answer — and the loop
   * stopping while the answer's request is still unspent is what makes it two.
   */
  it('spends the turn’s allowance once, not once per call', async () => {
    const s = await start({ budget: { mode: 'agentic' } })

    // One turn to learn the day from the service's own headers: six left, and a
    // reset far enough out to be a day rather than a minute.
    transport(() =>
      tooManyRequests('daily', {
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '6',
        'x-ratelimit-reset': String(Date.now() + 3_600_000),
      }),
    )
    await s.submit('how is the alpha widget configured?')
    expect(s.state.budget).toMatchObject({ remaining: 6, source: 'header' })

    // rotateAbove is 6, so the next turn is rationed to 1 + maxContinuations.
    const chats = transport(() => reply(PROSE))
    await s.submit('and what does the token do?')

    // One loop step and the forced final call — the two the plan allowed.
    expect(chats).toHaveLength(2)
    expect(chats.at(-1).response_format).toBeTruthy()
    // The same model throughout: there was never a request left to reach
    // another one with, which is what the rationing was for.
    expect(new Set(chats.map((c) => c.model)).size).toBe(1)
  })

  /**
   * THE OTHER HALF OF THE TURN SPENDS THE SAME FIFTY.
   *
   * OpenRouter serves chat and embeddings off one key, so a hybrid question
   * costs a query embedding out of the same daily allowance as the answer —
   * and nothing counted it, so the panel stated a number the service disagreed
   * with. It is charged only when both halves point at the same service:
   * `embed.provider` exists precisely so they need not, and an Ollama embedder
   * beside a hosted chat model draws on nobody's daily anything.
   */
  /**
   * ── ONE EMBEDDING REQUEST PER TURN, FOLLOW-UPS INCLUDED ────────────────────
   *
   * A follow-up scores two queries: the reader's question, and the question
   * glued to its antecedent — the composed channel that keeps "and for backend
   * calls?" from retrieving nothing (RAG-SPEC 3.4.5). Both need a vector, and
   * buying them separately made every follow-up cost TWO of a daily allowance
   * that counts requests rather than tokens. `docs/guide/free-tier.md` said one.
   *
   * They go out together now. This test counts REQUESTS and asserts the second
   * one carries both texts, because the cheap way to "fix" the count is to stop
   * composing — which would silently retire the channel this site's `tauLexical`
   * was calibrated with.
   */
  it('buys both of a follow-up’s vectors in one request', async () => {
    const inputs = []
    const s = await start({ embed: { provider: 'openrouter', model: 'test-embed' } })
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body)
      if (String(url).includes('/embeddings')) {
        inputs.push(body.input)
        const rows = (Array.isArray(body.input) ? body.input : [body.input]).map(() => [1, 0, 0, 0])
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: rows.map((embedding, index) => ({ embedding, index })) }),
        }
      }
      return reply(FINAL_ANSWER)
    })

    await s.submit('how is the alpha widget configured?')
    // A first turn has no antecedent, so it embeds one string — the request it
    // always was, to the byte.
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toBe('how is the alpha widget configured?')

    await s.submit('and what does the token do?')
    // ONE more request, carrying BOTH texts. Two requests here is the defect.
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toEqual([
      'and what does the token do?',
      'how is the alpha widget configured?\nand what does the token do?',
    ])
  })

  it('counts an embedding that shares the chat allowance, and only that one', async () => {
    /** Chat refuses for the day; the embedder answers on the index's own axis. */
    const bothHalves = (embedUrl) => {
      const seen = { chat: 0, embed: 0, embedUrl: '' }
      vi.stubGlobal('fetch', async (url) => {
        if (String(url).includes(embedUrl)) {
          seen.embed++
          seen.embedUrl = String(url)
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ data: [{ embedding: [1, 0, 0, 0] }], embeddings: [[1, 0, 0, 0]] }),
          }
        }
        seen.chat++
        return tooManyRequests('daily')
      })
      return seen
    }

    const shared = await start({ embed: { provider: 'openrouter', model: 'test-embed' } })
    const one = bothHalves('/v1/embeddings')
    await shared.submit('how is the alpha widget configured?')
    expect(one).toMatchObject({ chat: 1, embed: 1 })
    // Both requests, off one key — which is what this test is about, and what
    // `spentLocal` records. The count itself no longer decides the display: the
    // chat half answered with a DAILY 429, and a service refusing a request
    // because the day is gone has just stated the day is gone. Before that was
    // read, the panel showed "48 of 50 left today" beside its own "out of free
    // answers until …" and planned the next question as a full agentic walk.
    expect(shared.state.budget).toMatchObject({ spentLocal: 2, remaining: 0, source: 'header' })

    // A local embedder is a different allowance — a different host, even — and
    // charging it would shorten answers to pay for requests the metered account
    // never received.
    const split = await start({
      embed: { provider: 'ollama', model: 'test-embed', baseURL: 'http://localhost:11434' },
    })
    const two = bothHalves('/api/embed')
    await split.submit('how is the alpha widget configured?')
    expect(two).toMatchObject({ chat: 1, embed: 1 })
    // One request charged, not two — the subject of this half. The day is
    // stated here for the same reason it is above.
    expect(split.state.budget).toMatchObject({ spentLocal: 1, remaining: 0, source: 'header' })
  })

  /**
   * THE PLAN IS A CEILING, AND THE LOOP IS INSIDE IT.
   *
   * `plan.maxRequests` bounded what each chat() call could spend and nothing
   * bounded how many calls the loop made, so the turn's own arithmetic was the
   * one place the ceiling did not reach. Every number below was measured through
   * this stub rather than argued: the turn is handed a plan of two requests, and
   * what is asserted is how many the transport actually completed.
   *
   * `runTurn` directly, not `submit`: the harness returns the count `onHeaders`
   * kept, which is the number a free tier meters, and a budget stub states the
   * day in one place instead of it having to be taught through a first turn.
   */
  /** What a metered service has published, in the shape `budgetPlan` rations on. */
  const ledger = (remaining) => ({
    snapshot: () => ({
      limit: 50,
      remaining,
      // Far enough out to be a day rather than a minute, and stated by the
      // service rather than substituted — both halves of what makes a header
      // count one this package may ration against.
      resetAt: Date.now() + 3_600_000,
      resetSource: 'header',
      source: 'header',
      spentLocal: 50 - remaining,
    }),
    spend() {},
    observe() {},
  })

  /**
   * One turn against a stubbed transport, returning what it spent as well as
   * what it said. `budget` may be a REAL `createBudget` ledger where what the
   * turn taught it is part of the measurement.
   */
  const turn = ({ remaining = 6, onChat, settings = {}, llm = {}, budget, signal, ...cfg }) => {
    const chats = transport(onChat)
    const index = oneChunkIndex()
    const retrieval = createRetrieval({
      index,
      scope: { kind: 'all', paths: [], label: 'All docs' },
      guard: GUARD,
    })
    return runTurn({
      retrieval,
      gateResult: { G: 1, pass: true, chunks: index.chunks },
      question: 'how is the alpha widget configured?',
      history: [],
      addendum: '',
      config: {
        llm: {
          provider: 'openai',
          baseURL: '/ai',
          model: 'm',
          apiKey: 'k',
          freePool: true,
          ...llm,
        },
        maxIterations: 2,
        // The mode pinned, so the loop still runs: this is the case a ceiling
        // on requests exists for, and one-shot's zero iterations would hide it.
        budget: { ...BUDGET_DEFAULTS, mode: 'agentic', ...settings },
        ...cfg,
      },
      fallback: false,
      queryVec: null,
      signal,
      budget: budget ?? ledger(remaining),
    }).then((r) => ({ ...r, chats }))
  }

  /** A fresh query each step, so every step is charged rather than refunded. */
  const searching = () => {
    let q = 0
    return (body) =>
      body.response_format
        ? reply(FINAL_ANSWER)
        : toolReply('search_docs', { query: `alpha ${++q}` })
  }

  describe('and a plan the loop cannot overspend', () => {
    beforeEach(() => resetPools())

    /**
     * `rotateAbove` is 6, so six answers left plans `1 + maxContinuations` = 2
     * requests. It spent THREE — two loop steps, each affording one, and then
     * the forced final call, which chat() floors at one request however far the
     * turn is overdrawn. The reservation is the mechanism: the loop stops while
     * the answer's request is still unspent.
     */
    it('stops the loop with the answer’s request still unspent', async () => {
      const r = await turn({ onChat: searching() })
      expect(r.requests).toBe(2)
      // And the request that was reserved is the one the reader's answer came
      // out of — the final call, which the last body proves was made.
      expect(r.chats.at(-1).response_format).toBeTruthy()
      expect(r.text).toContain('manifest')
    })

    /**
     * THE REFUND PATH, where the overspend was worst. A model stuck on one query
     * is refunded its step MAX_FREE_STEPS times, so the loop lapped seven times
     * and the turn spent EIGHT requests against a plan of two — a reader's whole
     * remaining day, on one question, to protect them from spending it.
     */
    it('cannot buy a refunded step with the answer’s request', async () => {
      const r = await turn({
        onChat: (body) =>
          body.response_format ? reply(FINAL_ANSWER) : toolReply('search_docs', { query: 'alpha' }),
      })
      expect(r.requests).toBe(2)
      expect(r.text).toContain('manifest')
    })

    /**
     * AND THE RESERVATION IS A NUMBER THE LOOP IS HANDED, not only a moment it
     * stops at. A step that rotates is a step that spends: given the whole
     * remaining allowance, one loop call walking past a silent model spends the
     * request the answer was being kept for, and the final call then falls back
     * on chat()'s floor — three requests against a plan of two, with the loop
     * having stopped in the right place.
     */
    it('will not let a loop step rotate into the answer’s request', async () => {
      const r = await turn({
        llm: { model: null, models: ['a', 'b', 'c'] },
        onChat: (body) =>
          body.response_format
            ? reply(FINAL_ANSWER)
            : body.model === 'a'
              ? reply('')
              : toolReply('search_docs', { query: 'alpha' }),
      })
      expect(r.requests).toBe(2)
      expect(r.text).toContain('manifest')
    })

    /**
     * AN INFINITE CEILING STAYS INFINITE, which is nearly every turn. Fifty
     * answers left is nowhere near `rotateAbove`, so there is no allowance to
     * reserve from and the loop runs the iterations it was given.
     */
    it('leaves an unrationed turn its whole iteration budget', async () => {
      const r = await turn({ remaining: 50, onChat: searching() })
      expect(r.iterations).toBe(2)
      expect(r.requests).toBe(3)
    })

    /**
     * AND THE ANSWER'S CALL IS STILL MADE WHEN THE LOOP OVERDREW.
     *
     * Retries are outside the ceiling by decision — a burst 429 is a request the
     * service refused, and the alternative to waiting is a failed turn the
     * reader asks again anyway — so a loop step CAN spend the reservation. What
     * must not follow is the turn ending on "I could not find this in the docs"
     * to save a request.
     */
    it('makes the answer’s call even after the loop overdrew the plan', async () => {
      let calls = 0
      const r = await turn({
        onChat: (body) => {
          calls++
          if (body.response_format) return reply(FINAL_ANSWER)
          if (calls === 1) return tooManyRequests('minute', { 'retry-after': '0' })
          return toolReply('search_docs', { query: `alpha ${calls}` })
        },
      })
      // The 429, the retry that answered it, and the final call.
      expect(r.requests).toBe(3)
      expect(r.text).toContain('manifest')
    })
  })

  /**
   * ================================================================
   * THE REQUEST-COUNT MATRIX. IF YOU BROKE A ROW HERE, YOU CHANGED
   * WHAT A READER'S QUESTION COSTS OR WHETHER IT GETS ANSWERED.
   * ================================================================
   *
   * Three rounds of work moved these numbers without anybody noticing, each one
   * closing its own defects and opening new ones in the same code: a ceiling
   * that bounded a call and not a turn, a retry policy that inverted when the
   * budget was thin, a reservation the turn could die before reaching. The
   * numbers were never the argument — they were never written down.
   *
   * So every row below states, for one line of the decision table, the EXACT
   * number of requests the transport completed AND that an answer came back.
   * Both halves matter and neither is enough alone: an answer bought with a
   * reader's whole remaining day is a defect, and a request count of one on a
   * turn that returned nothing is the defect that reads as "I couldn't find this
   * in the docs".
   *
   * A row that fails is not a test to adjust. It is a statement that the cost of
   * a question changed, and the change has to be argued in the same terms:
   * what invariant now says the new number is right.
   *
   * The invariants, in the terms the rows use them:
   *   A  the ceiling bounds requests that buy a BETTER answer — more candidates,
   *      continuations — never the retry of a request the service refused, and
   *      at every ceiling waiting and rotating may not both be forbidden.
   *   B  the loop stops with the answer's request unspent, and no loop outcome —
   *      a throw included — may stop that request being made.
   *   D  one response, one classification, read by the transport and the ledger.
   */
  describe('the request-count matrix', () => {
    // The capability memory is module scope and outlives a turn by design, which
    // is exactly why each row has to start from nothing: a row that inherited
    // the previous row's concession would assert a request count bought by a
    // test above it.
    beforeEach(() => {
      resetPools()
      resetCaps()
    })

    /** A loop step that answers outright, which is what a strong model does. */
    const answers = () =>
      toolReply('answer', {
        text: 'The alpha widget takes a manifest [1].',
        citations: ['a#one'],
        confidence: 0.8,
      })

    /**
     * ── A PARAMETER REFUSAL COSTS ONE EXTRA REQUEST, NOT ONE PER MODEL ────────
     *
     * This row is the twelve-request turn, reduced to its cause. OpenRouter
     * answers `404 Filter by Parameters` when the body names a parameter the
     * endpoint does not publish, and `provider.require_parameters` is what makes
     * that a routing failure rather than a silently dropped field. The body is
     * identical for every pool member, so the rotation this used to trigger
     * bought the same refusal once per member — five of them, live, before a
     * sixth model answered.
     *
     * The fix is to ask the SAME model again with less in it. One extra request,
     * once, and the concession is remembered for the rest of the session.
     */
    it('a params refusal retries the same model smaller: 2 requests', async () => {
      const r = await turn({
        remaining: 50,
        settings: { mode: 'one-shot' },
        llm: { model: 'a', models: ['a', 'b', 'c'], tuning: { style: 'unified', off: true } },
        onChat: (body, i) => (i === 1 ? refusal('params') : reply(FINAL_ANSWER)),
      })
      expect(r.requests).toBe(2)
      expect(r.text).toContain('manifest')
      // The SAME model, not the next one — which is the whole point of the row.
      expect(r.chats.map((c) => c.model)).toEqual(['a', 'a'])
      // The refused request asked for reasoning; the retry does not. Both still
      // carry the strict schema, because that rung has not been reached.
      expect(r.chats[0].reasoning).toEqual({ enabled: false })
      expect(r.chats[1].reasoning).toBeUndefined()
      expect(r.chats[1].response_format?.type).toBe('json_schema')
    })

    /**
     * AND THE COMMONEST CASE NO LONGER HAPPENS AT ALL.
     *
     * `chat.reasoning: false` used to put `reasoning: {enabled: false}` on every
     * request including the search steps, because the openai adapter never read
     * the `enableThink` the harness has always passed it. Beside
     * `require_parameters` that field is a routing filter, so the deployed site
     * spent its FIRST request of every turn on a 404 from a model with no
     * reasoning surface. A loop step now asks for none, so there is nothing to
     * be refused for.
     */
    it('asks for no reasoning on a search step, whatever the author configured', async () => {
      const r = await turn({
        remaining: 50,
        llm: { model: 'a', models: ['a'], tuning: { style: 'unified', effort: 'high' } },
        onChat: searching(),
      })
      const [step] = r.chats
      expect(step.tools).toBeTruthy()
      expect(step.reasoning).toBeUndefined()
      // The one call whose output a reader reads still gets the author's depth.
      expect(r.chats.at(-1).reasoning).toEqual({ effort: 'high' })
    })

    /**
     * AND THE CONCESSION OUTLIVES THE TURN. `CAPS` is module scope on the same
     * reasoning as the pool's stickiness: an endpoint's published parameters are
     * a fact about the SERVICE, so a reader's second question must not pay a
     * second refusal to rediscover it.
     */
    it('remembers the concession, so the next turn pays nothing: 1 request', async () => {
      const llm = { model: 'a', models: ['a'], tuning: { style: 'unified', off: true } }
      await turn({
        remaining: 50,
        settings: { mode: 'one-shot' },
        llm,
        onChat: (body, i) => (i === 1 ? refusal('params') : reply(FINAL_ANSWER)),
      })
      const again = await turn({
        remaining: 50,
        settings: { mode: 'one-shot' },
        llm,
        onChat: () => reply(FINAL_ANSWER),
      })
      expect(again.requests).toBe(1)
      expect(again.text).toContain('manifest')
      // It opened already degraded, which is what "remembered" means.
      expect(again.chats[0].reasoning).toBeUndefined()
    })

    /**
     * THE STRICT SCHEMA IS THE SECOND RUNG, AND IT IS THE FINAL CALL'S.
     *
     * A model with no `structured_outputs` refuses the forced answer call and
     * only that call — the loop steps carry `tools` and go through. Dropping the
     * schema entirely would lose the shape that makes an answer citable, so it
     * is re-asked as a forced tool call instead: same object, a parameter the
     * endpoint publishes.
     */
    it('a schema refusal falls back to a forced tool call rather than rotating', async () => {
      const r = await turn({
        remaining: 50,
        llm: { model: 'a', models: ['a', 'b'] },
        onChat: (body) => {
          if (body.response_format?.type === 'json_schema') return refusal('params')
          if (body.tool_choice) {
            return toolReply('answer', {
              text: 'The alpha widget takes a manifest [1].',
              citations: ['a#one'],
              confidence: 0.8,
            })
          }
          return toolReply('search_docs', { query: 'alpha' })
        },
      })
      expect(r.text).toContain('manifest')
      // Every request went to the first model: nothing rotated.
      expect(new Set(r.chats.map((c) => c.model))).toEqual(new Set(['a']))
      // The degraded final call names the tool it wants and sends no
      // `response_format` at all — a `json_object` fallback would have put one
      // back and re-lost the endpoint.
      const finalCall = r.chats.at(-1)
      expect(finalCall.tool_choice).toEqual({ type: 'function', function: { name: 'answer' } })
      expect(finalCall.response_format).toBeUndefined()
      expect(finalCall.tools.map((t) => t.function.name)).toEqual(['answer'])
    })

    /**
     * A POLICY REFUSAL STILL ROTATES, and it must: the account's guardrails
     * removed this model's endpoints, and the next model may have one that
     * survives. What changes is that the service's own sentence travels with the
     * error, so a reader is told about a data-policy setting rather than told
     * the documentation has no answer.
     */
    it('rotates past a policy refusal and keeps its sentence: 2 requests', async () => {
      const r = await turn({
        remaining: 50,
        llm: { model: null, models: ['a', 'b'] },
        onChat: (body, i) => (i === 1 ? refusal('policy') : answers()),
      })
      expect(r.requests).toBe(2)
      expect(r.chats.map((c) => c.model)).toEqual(['a', 'b'])
      expect(r.text).toContain('manifest')
    })

    it('unrationed agentic, answered on lap one: 1 request', async () => {
      const r = await turn({ remaining: 50, onChat: () => answers() })
      expect(r.requests).toBe(1)
      expect(r.text).toContain('manifest')
    })

    it('unrationed agentic, both laps then the forced final call: 3 requests', async () => {
      const r = await turn({ remaining: 50, onChat: searching() })
      expect(r.requests).toBe(3)
      expect(r.iterations).toBe(2)
      expect(r.text).toContain('manifest')
    })

    it('one-shot, a clean answer: 1 request', async () => {
      const r = await turn({ settings: { mode: 'one-shot' }, onChat: () => reply(FINAL_ANSWER) })
      expect(r.requests).toBe(1)
      expect(r.text).toContain('manifest')
    })

    /**
     * Six of ten live pool members answered the strict final call in prose, and
     * prose carries no citations — so the rotation is what turns a spent request
     * into an answer. One-shot plans `1 + maxContinuations`, so there is exactly
     * one request behind the first candidate and the rotation fits inside it.
     */
    it('one-shot, prose then a rotation inside the plan: 2 requests', async () => {
      const r = await turn({
        settings: { mode: 'one-shot' },
        llm: { model: null, models: ['a', 'b'] },
        onChat: (body) => (body.model === 'a' ? reply(PROSE) : reply(FINAL_ANSWER)),
      })
      expect(r.requests).toBe(2)
      expect(r.text).toContain('manifest')
    })

    /**
     * And with no continuation to spend there is no second request, so the prose
     * is KEPT rather than re-asked: it costs its citations — the guardrail lands
     * it on `not-answerable` — and it costs no extra request.
     */
    it('one-shot at a ceiling of one, prose kept rather than replaced: 1 request', async () => {
      const r = await turn({
        settings: { mode: 'one-shot', maxContinuations: 0 },
        llm: { model: null, models: ['a', 'b'] },
        onChat: () => reply(PROSE),
      })
      expect(r.requests).toBe(1)
      expect(r.text).toContain('settings page')
    })

    it('rationed agentic at six answers left: 2 requests', async () => {
      const r = await turn({ onChat: searching() })
      expect(r.requests).toBe(2)
      expect(r.chats.at(-1).response_format).toBeTruthy()
      expect(r.text).toContain('manifest')
    })

    /** The refunded step is free of the ITERATION budget and never of the request one. */
    it('rationed agentic with MAX_FREE_STEPS refunding: 2 requests', async () => {
      const r = await turn({
        onChat: (body) =>
          body.response_format ? reply(FINAL_ANSWER) : toolReply('search_docs', { query: 'alpha' }),
      })
      expect(r.requests).toBe(2)
      expect(r.text).toContain('manifest')
    })

    /**
     * F1 — INVARIANT A. At a ceiling of one with a pool behind it, the first
     * candidate is not reachable-past, so waiting is the only thing left that
     * can work and it is permitted. This turn used to spend two requests and
     * return `text: ""`.
     */
    it('a burst 429 on the answer’s call, at a ceiling of one, with a pool: 3 requests', async () => {
      let calls = 0
      const r = await turn({
        llm: { model: null, models: ['a', 'b', 'c'] },
        onChat: (body) => {
          calls++
          if (!body.response_format) return toolReply('search_docs', { query: `alpha ${calls}` })
          return calls === 2 ? tooManyRequests('minute', { 'retry-after': '0.001' }) : reply(FINAL_ANSWER)
        },
      })
      expect(r.requests).toBe(3)
      expect(r.text).toContain('manifest')
    })

    /**
     * F2 — INVARIANT B. The same 429 one call earlier. When it lifts inside the
     * loop step the turn never notices; when it does not, the step FAILS and the
     * reserved request is still spent on the answer. That second case used to
     * reject the whole turn after one request, and the reader was shown "The AI
     * service didn't respond" for a service that answered a second later.
     */
    it('a burst 429 on a loop step that lifts, rationed: 3 requests', async () => {
      let calls = 0
      const r = await turn({
        llm: { model: null, models: ['a', 'b', 'c'] },
        onChat: (body) => {
          calls++
          if (calls === 1) return tooManyRequests('minute', { 'retry-after': '0.001' })
          return body.response_format ? reply(FINAL_ANSWER) : toolReply('search_docs', { query: 'alpha' })
        },
      })
      expect(r.requests).toBe(3)
      expect(r.text).toContain('manifest')
    })

    /**
     * THE TWO FAILURES THAT STILL END THE TURN, and they are the turn's real
     * answer rather than an accident on the way to one. A reader who pressed
     * stop asked for exactly one thing: no more requests.
     */
    it('the reader pressing stop makes no further request', async () => {
      const ctrl = new AbortController()
      let calls = 0
      const err = await turn({
        signal: ctrl.signal,
        onChat: () => {
          calls++
          ctrl.abort()
          const e = new Error('aborted')
          e.name = 'AbortError'
          throw e
        },
      }).then(
        () => null,
        (e) => e,
      )
      expect(err?.name).toBe('AbortError')
      expect(calls).toBe(1)
    })

    /**
     * AND A TURN THAT NEVER REACHED A MODEL IS NOT A TURN THAT SEARCHED THE
     * DOCS. Breaking to the final call must not launder a transport failure
     * into "I couldn't find this in the docs" — a claim about the corpus. The
     * reserved request is still spent finding out whether the failure was
     * something the answer's call could get past; when it was not, the turn ends
     * on the error the reader can act on, exactly as it did before.
     */
    it('reports a key the service rejected rather than refusing about the corpus', async () => {
      let calls = 0
      const err = await turn({
        onChat: () => {
          calls++
          return { ok: false, status: 401, headers: new Headers(), json: async () => ({}) }
        },
      }).then(
        () => null,
        (e) => e,
      )
      expect(String(err?.message)).toContain('chat 401')
      // The loop step, and the one request the answer was reserved from.
      expect(calls).toBe(2)
    })

    /**
     * The same rule for the turn whose loop never runs.
     *
     * `loopFailure` was collected in the loop only, so one-shot — where there is
     * no loop at all — went on laundering a rejected key into a claim about the
     * corpus. Measured: the identical 401 threw on an agentic turn and returned
     * an empty, citation-free answer on a one-shot one, which put the wrong
     * sentence in front of exactly the deployment `mode: 'auto'` sends to
     * one-shot for having nearly run out of free answers.
     */
    it('reports a rejected key on a one-shot turn too, where there is no loop to collect it', async () => {
      let calls = 0
      const err = await turn({
        settings: { mode: 'one-shot' },
        maxIterations: 0,
        onChat: () => {
          calls++
          return { ok: false, status: 401, headers: new Headers(), json: async () => ({}) }
        },
      }).then(
        () => null,
        (e) => e,
      )
      expect(String(err?.message)).toContain('chat 401')
      // One request: the answer's call is the only call a one-shot turn makes.
      expect(calls).toBe(1)
    })

    it('a burst 429 that exhausts a loop step, rationed: 5 requests, still answered', async () => {
      const r = await turn({
        onChat: (body) =>
          body.response_format
            ? reply(FINAL_ANSWER)
            : tooManyRequests('minute', { 'retry-after': '0.001' }),
      })
      // Four attempts on the step, and then the request the loop reserved.
      expect(r.requests).toBe(5)
      expect(r.text).toContain('manifest')
    })

    /**
     * F4 — INVARIANT D. The day's 429, by each of the four routes that can name
     * it, and the two readers of every one of them agreeing: the turn settles as
     * rate-limited AND the ledger records the day. The first row is the response
     * that had them disagreeing — `limit_source: 'daily'` with a two-minute
     * `retry-after` and no reset, read as the day here and as a minute there,
     * which put "out of free answers until …" beside "5 of 50 left today".
     *
     * It lands on a LOOP step (the ledger is unrationed, so the loop runs), so
     * the single request also states invariant B's exception: a spent day is the
     * one loop failure that must travel out of runTurn rather than break to the
     * final call, because the final call would spend a request to be told the
     * same thing and session.js has a settle for this that names the hour.
     */
    const dailyRoutes = {
      'the limit_source metadata': [
        { error: { message: 'rate limited', metadata: { limit_source: 'daily' } } },
        { 'retry-after': '120', 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0' },
      ],
      'the message text': [
        { error: { message: 'Rate limit exceeded: free-models-per-day' } },
        { 'retry-after': '20', 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0' },
      ],
      'the headers alone': [
        { error: { message: 'Too many requests' } },
        {
          'x-ratelimit-limit': '50',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Date.now() + 11 * 3600000),
        },
      ],
    }

    for (const [route, [payload, headers]] of Object.entries(dailyRoutes)) {
      it(`a daily 429 by ${route}: 1 request, and the ledger says so too`, async () => {
        const spent = createBudget({ storage: null, now: () => Date.now(), dailyLimit: 50 })
        const refuse = () => ({
          ok: false,
          status: 429,
          headers: new Headers(headers),
          json: async () => payload,
          clone: () => refuse(),
        })
        const err = await turn({ budget: spent, onChat: () => refuse() }).then(
          () => null,
          (e) => e,
        )
        // The turn's real answer, and session.js settles it as 'rate-limited'
        // rather than as a transport failure.
        expect(err?.rateLimit?.daily).toBe(true)
        // One request: every model shares one account's counter, and the reader
        // is told what the first response already said.
        expect(spent.snapshot().spentLocal).toBe(1)
        // The other reader of the same response, agreeing with the first.
        expect(spent.snapshot()).toMatchObject({ remaining: 0, defensibleRemaining: 0 })
        expect(spent.exhausted()).toBe(true)
      })
    }

    /**
     * The fourth route is the ten-minute floor under the third, and it is what
     * keeps the other three honest: a BURST limiter reports `remaining: 0` too,
     * and it reports a reset seconds away. Neither reader may treat that as the
     * day — the turn waits it out and answers, and the ledger keeps counting.
     */
    it('a burst 429 with remaining 0 is not the day, by either reader: 3 requests', async () => {
      const live = createBudget({ storage: null, now: () => Date.now(), dailyLimit: 50 })
      // Forty-four counted, so this turn is rationed exactly as the rows above:
      // one loop step and the request its answer is reserved from.
      live.spend(44)
      let calls = 0
      const r = await turn({
        budget: live,
        onChat: (body) => {
          calls++
          if (calls === 1) {
            const burst = () => ({
              ok: false,
              status: 429,
              headers: new Headers({
                'retry-after': '0.001',
                'x-ratelimit-limit': '20',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Date.now() + 45000),
              }),
              json: async () => ({ error: { message: 'Too many requests' } }),
              clone: () => burst(),
            })
            return burst()
          }
          return body.response_format ? reply(FINAL_ANSWER) : toolReply('search_docs', { query: 'alpha' })
        },
      })
      expect(r.requests).toBe(3)
      expect(r.text).toContain('manifest')
      // The minute's zero never entered the day's ledger and never reached the
      // panel: the count carried on through it, 44 + 3, and nothing — neither
      // the number on screen nor the one a plan is built on — declared the day
      // spent.
      expect(live.snapshot()).toMatchObject({
        remaining: 3,
        defensibleRemaining: 3,
        source: 'local',
      })
      expect(live.exhausted()).toBe(false)
    })

    /**
     * A continuation is a request like any other and comes out of the same
     * number: `maxContinuations` is 1, so a truncated answer is finished once
     * and a service that truncates every fragment is not chased past that.
     */
    it('a continuation on finishReason length, bounded at one: 2 requests', async () => {
      const halves = ['{"text": "The alpha widget takes a manifest [1].", "citations": ["a#one"], "confid', 'ence": 0.8}']
      let n = 0
      const finished = await turn({
        remaining: 50,
        maxIterations: 0,
        onChat: () => reply(halves[n++], { finishReason: n === 1 ? 'length' : 'stop' }),
      })
      expect(finished.requests).toBe(2)
      expect(finished.text).toContain('manifest')
      expect(finished.citations).toEqual(['a#one'])

      resetPools()
      const truncated = await turn({
        remaining: 50,
        maxIterations: 0,
        onChat: () => reply('{"text": "The alpha widget ', { finishReason: 'length' }),
      })
      // Still two: the second fragment was as truncated as the first, and the
      // plan buys one continuation rather than as many as it takes.
      expect(truncated.requests).toBe(2)
      expect(truncated.text).toContain('alpha widget')
    })
  })

  /**
   * THE REASONING SHOWN BELONGS TO THE MODEL THAT ANSWERED.
   *
   * Two halves of one rule, and each was useless without the other. The screen:
   * `onStream({start: true})` fires once per chat() CALL, not once per candidate,
   * so nothing cleared the reasoning box between two models inside one call. The
   * settle: the harness kept the last non-empty `think` of the TURN and
   * session.js wrote it `if (result.think)`, so a winner with no reasoning of
   * its own — the common case — inherited whichever model last had some, with a
   * thoughtSeconds count attached to it. Clearing the box alone made it worse
   * rather than better: the reader watched the reasoning empty at the rotation
   * and refill at the settle, ending on the same mis-attribution.
   */
  describe('the reasoning shown belongs to the model that answered', () => {
    beforeEach(() => resetPools())

    const streamed = (frames) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: sse(frames),
    })

    const think = (text) => ({ choices: [{ delta: { reasoning: text } }] })
    const says = (text) => ({ choices: [{ delta: { content: text } }] })
    const callsTool = (name, args) => ({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(args) } }] } },
      ],
    })

    it('clears the reasoning the model that lost the turn had written', async () => {
      transport((body) =>
        body.model === 'a'
          ? streamed([think('Let me think about '), think('the alpha widget.'), says(PROSE)])
          : streamed([says(FINAL_ANSWER)]),
      )

      // The two fields session.js keeps from these events, by its own rules:
      // reasoning is cleared by `start` and appended to by `thinking`, and the
      // answer is whatever `text` last said.
      const panel = { thought: '', answer: '' }
      const index = oneChunkIndex()
      const r = await runTurn({
        retrieval: createRetrieval({
          index,
          scope: { kind: 'all', paths: [], label: 'All docs' },
          guard: GUARD,
        }),
        gateResult: { G: 1, pass: true, chunks: index.chunks },
        question: 'how is the alpha widget configured?',
        history: [],
        addendum: '',
        config: {
          llm: {
            provider: 'openai',
            baseURL: '/ai',
            model: null,
            models: ['a', 'b'],
            apiKey: 'k',
          },
          // Straight to the forced final call, which is where the strict schema
          // makes prose a parse error and the rotation happen.
          maxIterations: 0,
        },
        fallback: false,
        queryVec: null,
        onStream: (e) => {
          if (e.start) panel.thought = ''
          if (e.thinking) panel.thought += e.thinking
          if (e.text) panel.answer = e.text
        },
      })

      expect(panel.answer).toContain('manifest')
      expect(r.text).toContain('manifest')
      // 'b' answered and 'b' did no reasoning, so there is no reasoning to show.
      // This used to read 'Let me think about the alpha widget.' — 'a''s, under
      // 'b''s answer.
      expect(panel.thought).toBe('')
      expect(r.think).toBe('')
    })

    /** The transport's half of it: the rotation point says whose it was. */
    it('names the candidate it abandoned, once per abandonment', async () => {
      const abandoned = []
      vi.stubGlobal('fetch', async (_url, init) =>
        JSON.parse(init.body).model === 'c' ? reply(ANSWER) : reply(PROSE),
      )
      const out = await ask({
        models: ['a', 'b', 'c'],
        onAbandon: (model) => abandoned.push(model),
      })
      expect(out.model).toBe('c')
      expect(abandoned).toEqual(['a', 'b'])
    })

    /**
     * THE SETTLE, which is where the accumulator put it back.
     *
     * A turn whose loop step was reasoned and whose ANSWER came from a call that
     * did no reasoning kept the loop step's, because `think` was a turn-level
     * variable that only ever moved forward. It is now the answering call's own
     * `think` or nothing, passed into `finish` by whichever call produced the
     * answer.
     */
    /** A reply with reasoning beside it, in the shape the openai adapter reads. */
    const reasoned = (reasoning, message) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: '', reasoning, ...message }, finish_reason: 'stop' }],
      }),
    })

    it('does not settle a loop step’s reasoning under the answer it did not write', async () => {
      let q = 0
      const r = await turn({
        remaining: 50,
        maxIterations: 1,
        onChat: (body) =>
          body.response_format
            ? reply(FINAL_ANSWER)
            : reasoned('The alpha widget is probably in the guide.', {
                tool_calls: [
                  {
                    function: {
                      name: 'search_docs',
                      arguments: JSON.stringify({ query: `alpha ${++q}` }),
                    },
                  },
                ],
              }),
      })
      expect(r.text).toContain('manifest')
      expect(r.think).toBe('')
    })

    /** And the answering call's OWN reasoning is what does survive. */
    it('settles the reasoning of the call that produced the answer', async () => {
      const r = await turn({
        remaining: 50,
        maxIterations: 0,
        onChat: () => reasoned('Checking the manifest section.', { content: FINAL_ANSWER }),
      })
      expect(r.text).toContain('manifest')
      expect(r.think).toBe('Checking the manifest section.')
    })

    /**
     * And the panel's copy of it, cleared at the settle rather than left as it
     * was painted. session.js wrote `turn.thought` only `if (result.think)`, so
     * the reasoning the streamer had already put on screen stayed there under an
     * answer written by a call that did none — with a `thoughtSeconds` count
     * beside it, which is a duration for reasoning nobody can read.
     */
    it('clears the panel’s reasoning box when the answer came with none', async () => {
      const s = await start()
      let q = 0
      transport((body) =>
        body.response_format
          ? streamed([says(FINAL_ANSWER)])
          : streamed([
              think('Let me look up '),
              think('the alpha widget.'),
              callsTool('search_docs', { query: `alpha ${++q}` }),
            ]),
      )
      await s.submit('how is the alpha widget configured?')

      const turn = s.state.turns.at(-1)
      expect(turn.answerText).toContain('manifest')
      // Painted while the loop step was reasoning, and gone once the turn had an
      // answer that was not that model's.
      expect(turn.thought).toBe('')
      expect(turn.thoughtSeconds).toBe(0)
    })
  })
})
