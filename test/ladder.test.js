import { describe, it, expect, afterEach, vi } from 'vitest'

import { chat, orderMembers, resetPools } from '../src/theme/docpilot/llm.js'

/**
 * THE ANSWER LADDER, at the transport.
 *
 * `chat.chain` resolves WHICH SERVICES may answer and in what order; this file
 * pins what the browser does with that set. The rules are not the pool's rules
 * with a different noun in them, and the differences are the whole point:
 *
 *   · a member rotates on failures a MODEL never rotates on — 401, a network
 *     failure with no status, and the day's allowance — because each of those
 *     is a statement about one host, one key or one account, and the next
 *     member is a different one of all three;
 *   · only the LAST member's daily 429 leaves the call, so session.js still
 *     settles the turn as `rate-limited` rather than as a transport error;
 *   · nothing rotates once a word is on the screen, across services exactly as
 *     within a pool;
 *   · there is no sticky member, deliberately: the configured order is the
 *     deployment's statement about which account to spend first, and one blip
 *     must not be able to promote a free tier above it.
 *
 * Everything runs against a stubbed transport keyed by the member's address.
 * A single-member call is the shipped configuration and must be byte-identical
 * to what free-pool.test.js already pins — several assertions here exist only
 * to say so.
 */

const answer = '{"tool": "answer", "args": {"text": "ok"}}'

const reply = (content) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content } }], usage: {} }),
})

const failure = (status, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
})

/** A daily 429 — the body `classifyLimit` reads, not merely the status. */
const spentDay = () => ({
  ok: false,
  status: 429,
  headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() + 7200_000) }),
  json: async () => ({ error: { message: 'Rate limit exceeded: free-models-per-day' } }),
})

const sse = (frames) =>
  new ReadableStream({
    start(c) {
      const enc = new TextEncoder()
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
      c.close()
    },
  })

/** Three services, each at its own address — which is how the stub tells them apart. */
const CHAIN = [
  { provider: 'openai', baseURL: '/ai/openai', model: 'paid-1' },
  { provider: 'openai', baseURL: '/ai/groq', model: 'paid-2' },
  { provider: 'openai', baseURL: '/ai/openrouter', model: null, models: ['free-1', 'free-2'], freePool: true },
]

const ask = (extra = {}) =>
  chat({
    provider: 'openai',
    baseURL: '/ai/openai',
    model: 'paid-1',
    messages: [{ role: 'user', content: 'q' }],
    tools: false,
    ...extra,
  })

/** Records `<address> <model>` per request so order across members is legible. */
function transport(handler) {
  const asked = []
  vi.stubGlobal('fetch', async (url, init) => {
    const model = JSON.parse(init.body).model
    const base = String(url).replace(/\/v1\/chat\/completions$/, '')
    asked.push(`${base} ${model}`)
    return handler(base, model)
  })
  return asked
}

describe('the answer ladder — walking a set of services', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  it('asks the next service when the first is rate limited, and says which answered', async () => {
    const asked = transport((base) => (base === '/ai/openai' ? failure(429, { 'retry-after': '30' }) : reply(answer)))
    const seen = []
    const out = await ask({ chain: CHAIN, onMember: (m, i) => seen.push([m.provider, m.baseURL, i]) })
    // ONE request to the first service, not four: with another key in reserve,
    // honouring a 30-second `retry-after` is thirty seconds of spinner beside a
    // service that is answering.
    expect(asked).toEqual(['/ai/openai paid-1', '/ai/groq paid-2'])
    expect(out.model).toBe('paid-2')
    expect(seen).toEqual([['openai', '/ai/groq', 1]])
  })

  /**
   * The one failure a POOL must not rotate on, and a set must. A rejected key
   * rejects every model behind it — and nothing at all behind the next key.
   */
  it('rotates past a 401 between services, having refused to inside one', async () => {
    const asked = transport((base) => (base === '/ai/openai' ? failure(401) : reply(answer)))
    const out = await ask({ chain: CHAIN })
    expect(out.model).toBe('paid-2')
    expect(asked).toEqual(['/ai/openai paid-1', '/ai/groq paid-2'])

    // The same status inside one service is one request and one error, exactly
    // as free-pool.test.js pins it.
    resetPools()
    const inPool = transport(() => failure(401))
    await expect(ask({ models: ['a', 'b'] })).rejects.toThrow(/401/)
    expect(inPool).toEqual(['/ai/openai paid-1'])
  })

  /** A dropped socket is one host down. The next member is a different host. */
  it('rotates past a network failure that carries no status', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (url, init) => {
      const base = String(url).replace(/\/v1\/chat\/completions$/, '')
      asked.push(`${base} ${JSON.parse(init.body).model}`)
      if (base === '/ai/openai') throw new TypeError('Failed to fetch')
      return reply(answer)
    })
    const out = await ask({ chain: CHAIN })
    expect(out.model).toBe('paid-2')
    expect(asked).toEqual(['/ai/openai paid-1', '/ai/groq paid-2'])
  })

  /**
   * THE DAY'S ALLOWANCE BELONGS TO ONE ACCOUNT — the failure this whole ladder
   * exists for. A free tier that has answered its fifty questions has nothing
   * more to say today; a second key in the environment does.
   */
  it('rotates past a spent daily limit, and lets the last one through untouched', async () => {
    const asked = transport((base) => (base === '/ai/openai' ? spentDay() : reply(answer)))
    const out = await ask({ chain: CHAIN })
    expect(out.model).toBe('paid-2')
    expect(asked).toEqual(['/ai/openai paid-1', '/ai/groq paid-2'])

    // Every member spent: the error that escapes is still the daily one, with
    // its reset, because session.js settles `rate-limited` off exactly this.
    resetPools()
    vi.unstubAllGlobals()
    transport(() => spentDay())
    const e = await ask({ chain: CHAIN }).catch((err) => err)
    expect(e.status).toBe(429)
    expect(e.rateLimit.daily).toBe(true)
    expect(e.rateLimit.resetAt).toBeGreaterThan(Date.now())
  })

  /**
   * A candidate that painted a word owns the answer. Rotating past it would make
   * the reader watch a half-written paragraph vanish and a different one grow in
   * its place — as true across services as within one pool.
   */
  it('does not change service once a delta has reached the screen', async () => {
    const asked = transport((base) =>
      base === '/ai/openai'
        ? {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: sse([{ choices: [{ delta: { content: 'half a sen' } }] }]),
          }
        : reply(answer),
    )
    // The first service streams a fragment and then ends without a tool call,
    // which is a reply that did not answer — and is kept, because it is on the
    // screen.
    const out = await ask({ chain: CHAIN, onDelta: () => true })
    expect(asked).toEqual(['/ai/openai paid-1'])
    expect(out.text).toBe('half a sen')
  })

  it('never rotates after the reader stops, or when a step runs out of time', async () => {
    const controller = new AbortController()
    const asked = transport(() => {
      controller.abort()
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    })
    await expect(ask({ chain: CHAIN, signal: controller.signal })).rejects.toThrow(/abort/i)
    expect(asked).toEqual(['/ai/openai paid-1'])

    resetPools()
    vi.unstubAllGlobals()
    const timedOut = transport(() => {
      const e = new Error('timed out')
      e.name = 'TimeoutError'
      throw e
    })
    await expect(ask({ chain: CHAIN })).rejects.toThrow(/timed out/)
    expect(timedOut).toEqual(['/ai/openai paid-1'])
  })

  /**
   * A member whose own pool is exhausted still has somewhere to go. `!last`
   * rather than `rotating && !last` is what carries a single-model service over
   * the boundary.
   */
  it('leaves a service whose only model answered outside the requested shape', async () => {
    const asked = transport((base) => (base === '/ai/openai' ? reply('') : reply(answer)))
    const out = await ask({ chain: CHAIN })
    expect(out.model).toBe('paid-2')
    expect(asked).toEqual(['/ai/openai paid-1', '/ai/groq paid-2'])
  })

  /** The free pool is a member like any other: reached last, walked in full. */
  it('reaches the free pool behind every billed member, and rotates inside it', async () => {
    const asked = transport((base, model) =>
      base !== '/ai/openrouter' || model === 'free-1' ? failure(503) : reply(answer),
    )
    const seen = []
    const out = await ask({ chain: CHAIN, onMember: (m, i) => seen.push([m.freePool, i]) })
    expect(asked).toEqual([
      '/ai/openai paid-1',
      '/ai/groq paid-2',
      '/ai/openrouter free-1',
      '/ai/openrouter free-2',
    ])
    expect(out.model).toBe('free-2')
    expect(seen).toEqual([[true, 2]])
  })

  /**
   * THE CEILING IS THE TURN'S, not each service's. A rationed turn does not
   * become an unrationed one because the environment holds three keys.
   */
  it('counts requests across the whole set, not per service', async () => {
    const asked = transport(() => failure(503))
    await expect(ask({ chain: CHAIN, maxRequests: 1 })).rejects.toThrow(/503/)
    // The turn's one request, spent on the first service and its retries —
    // retries are outside the ceiling by decision, and the ceiling is what stops
    // the walk. The second and third services are never reached, which is the
    // property: three keys in the environment do not turn a rationed turn into
    // an unrationed one.
    expect(new Set(asked)).toEqual(new Set(['/ai/openai paid-1']))
    expect(asked).toHaveLength(4)
  })

  /**
   * Exactly one candidate per call waits out a rate limit: the last one the call
   * can reach. Another SERVICE counts as somewhere to go, so a member that is not
   * the last gets one attempt however many models it has.
   */
  it('spends the wait budget on the last reachable candidate only', async () => {
    const asked = transport(() => failure(429, { 'retry-after': '0' }))
    await expect(
      ask({
        chain: [
          { provider: 'openai', baseURL: '/ai/openai', model: 'a', models: ['a', 'b'] },
          { provider: 'openai', baseURL: '/ai/groq', model: 'c' },
        ],
      }),
    ).rejects.toThrow(/429/)
    // One each for 'a' and 'b' — the first service has a sibling behind it — and
    // the full retry budget for 'c', which is the last thing the call can reach.
    expect(asked).toEqual([
      '/ai/openai a',
      '/ai/openai b',
      '/ai/groq c',
      '/ai/groq c',
      '/ai/groq c',
      '/ai/groq c',
    ])
  })

  /**
   * A ONE-MEMBER CHAIN COLLAPSES TO THE SCALARS, deliberately: the two are the
   * same request, and the scalar path is the one every pinned deployment has
   * been running. So the shipped wait budget is unchanged — one attempt for the
   * candidate with a sibling in reserve, the full four for the last.
   */
  // Two full retry budgets back to back, each with its own exponential waits.
  it('leaves a single-member chain byte-identical to the configuration that shipped', { timeout: 20000 }, async () => {
    const asked = transport(() => failure(429, { 'retry-after': '0' }))
    await expect(
      ask({
        model: 'a',
        models: ['a', 'b'],
        chain: [{ provider: 'openai', baseURL: '/ai/openai', model: 'a', models: ['a', 'b'] }],
      }),
    ).rejects.toThrow(/429/)
    expect(asked).toEqual(['/ai/openai a', '/ai/openai b', '/ai/openai b', '/ai/openai b', '/ai/openai b'])
    // And identical with no `chain` at all — the same five requests.
    resetPools()
    vi.unstubAllGlobals()
    const scalar = transport(() => failure(429, { 'retry-after': '0' }))
    await expect(ask({ model: 'a', models: ['a', 'b'] })).rejects.toThrow(/429/)
    expect(scalar).toEqual(asked)
  })

  /** A service that just refused goes to the back of the NEXT call's order. */
  it('remembers which service refused, and asks it last next time', async () => {
    transport((base) => (base === '/ai/openai' ? failure(503) : reply(answer)))
    await ask({ chain: CHAIN })

    vi.unstubAllGlobals()
    const asked = transport(() => reply(answer))
    const out = await ask({ chain: CHAIN })
    // The cooling member is at the back rather than out: it is still in the set,
    // and a set where every member is cooling is exactly when a reader is
    // waiting.
    expect(asked).toEqual(['/ai/groq paid-2'])
    expect(out.model).toBe('paid-2')
  })
})

describe('orderMembers — the policy, without a socket', () => {
  afterEach(resetPools)

  const m = (baseURL) => ({ provider: 'openai', baseURL })
  const set = [m('/a'), m('/b'), m('/c')]

  it('keeps the configured order, which is the deployment’s own statement', () => {
    expect(orderMembers(set).map((t) => t.baseURL)).toEqual(['/a', '/b', '/c'])
    expect(orderMembers(set, { cooldown: new Map() }).map((t) => t.baseURL)).toEqual(['/a', '/b', '/c'])
  })

  it('moves a cooling member to the back rather than out of the set', () => {
    const now = 1_000_000
    const cooldown = new Map([['openai|/a', now + 5000]])
    expect(orderMembers(set, { cooldown, now }).map((t) => t.baseURL)).toEqual(['/b', '/c', '/a'])
  })

  it('keeps every member when all of them are cooling', () => {
    const now = 1_000_000
    const cooldown = new Map([
      ['openai|/a', now + 1],
      ['openai|/b', now + 1],
      ['openai|/c', now + 1],
    ])
    expect(orderMembers(set, { cooldown, now }).map((t) => t.baseURL)).toEqual(['/a', '/b', '/c'])
  })

  it('lets a cooldown expire without a reload', () => {
    const now = 1_000_000
    const cooldown = new Map([['openai|/a', now - 1]])
    expect(orderMembers(set, { cooldown, now }).map((t) => t.baseURL)).toEqual(['/a', '/b', '/c'])
  })

  /**
   * NO STICKY MEMBER, and its absence is the feature. A sticky one would let a
   * single blip on the billed account promote the free tier above it for the
   * life of the page — which inverts the order the ladder is for.
   */
  /**
   * TWO MEMBERS OF ONE SERVICE COOL SEPARATELY, which is what `chat.chain`'s
   * member names buy at this end.
   *
   * The map is keyed `provider|baseURL`, and config now hands two entries of one
   * provider two proxy paths — `/ai/gw-eu` and `/ai/gw-us`. Without that they
   * would share a key, and a blip on one gateway would take the other out of the
   * order with it: one cooldown, two accounts, and the second one demoted for a
   * failure it had nothing to do with.
   */
  it('cools two members of one service independently', () => {
    const now = 1_000_000
    const eu = {provider: 'openai', baseURL: '/ai/gw-eu'}
    const us = {provider: 'openai', baseURL: '/ai/gw-us'}
    const cooldown = new Map([['openai|/ai/gw-eu', now + 5000]])
    expect(orderMembers([eu, us], {cooldown, now}).map((t) => t.baseURL)).toEqual(['/ai/gw-us', '/ai/gw-eu'])
  })

  it('does not promote whichever service answered last', async () => {
    transport((base) => (base === '/ai/openai' ? failure(503) : reply(answer)))
    await ask({ chain: CHAIN })
    vi.unstubAllGlobals()

    // The cooldown, not a demotion: once it lapses the configured head leads
    // again, with no reload.
    resetPools()
    const asked = transport(() => reply(answer))
    await ask({ chain: CHAIN })
    expect(asked).toEqual(['/ai/openai paid-1'])
    vi.unstubAllGlobals()
  })
})
