import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  isAutoModel,
  freeChatModels,
  freeEmbedModels,
  fetchFreePool,
  FREE_CHAT,
  FREE_EMBED,
  FREE_ROUTER,
  CATALOGUE,
} from '../src/theme/docpilot/openrouter.js'
import { chat, detectTools, orderCandidates, resetPools } from '../src/theme/docpilot/llm.js'
import { createEmbedder, embeddingsOf } from '../src/build/build-rag-index.js'
import { openEmbedCache } from '../src/build/lib/embed-cache.js'
import { embedQuery } from '../src/theme/docpilot/embed.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { assembleIndex } from '../src/theme/docpilot/store.js'
import {
  resolveDocPilot,
  resolveEmbed,
  chatModels,
  embedModels,
  themeDocPilot,
  nodeChatTarget,
  nodeEmbedTarget,
  readiness,
  poolProviderOf,
  devProxy,
} from '../src/config.js'

/**
 * A shared free tier is a POOL, not a model — and the two halves of it are not
 * symmetric. Chat may rotate whenever it likes; embeddings may rotate exactly
 * once, at build time, because two embedders are two vector spaces.
 *
 * These are the rules that make that safe, pinned. Everything here runs against
 * a stubbed transport: the point is the policy, and a policy that needs a live
 * free tier to be tested is a policy nobody re-tests.
 */

const ENV = { OPENROUTER_API_KEY: 'sk-or-not-in-the-bundle' }

// Manifests written by the tests that need one on disk — `readiness` reads the
// index through the filesystem, and a stubbed `indexInfo` would test the stub.
const tmpDirs = []
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

// A response the openai adapter can parse, with the headers `chat()` reads.
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

describe('the free pool — what counts as free, and in what order', () => {
  it('reads the price, not the id suffix', () => {
    const ids = freeChatModels({
      data: [
        {
          id: 'a/paid',
          pricing: { prompt: '0.0000002' },
          architecture: { output_modalities: ['text'] },
          supported_parameters: ['tools', 'structured_outputs'],
        },
        {
          id: 'a/unsuffixed',
          pricing: { prompt: '0' },
          architecture: { output_modalities: ['text'] },
          supported_parameters: ['tools', 'structured_outputs'],
        },
      ],
    })
    expect(ids).toEqual(['a/unsuffixed'])
  })

  /**
   * The zero-price filter alone also catches Google's Lyria music models, which
   * are free per token because they bill per song. Posting a documentation
   * question to a music generator is a 400 with a confusing message, not a
   * fallback, so the modality is checked rather than assumed.
   */
  it('will not route a question to a model that does not emit text', () => {
    const ids = freeChatModels({
      data: [
        {
          id: 'g/lyria',
          pricing: { prompt: '0' },
          architecture: { output_modalities: ['audio'] },
          supported_parameters: ['tools', 'response_format'],
        },
      ],
    })
    expect(ids).toEqual([])
  })

  it('drops a free model that cannot call tools at all', () => {
    const ids = freeChatModels({
      data: [
        {
          id: 'n/safety:free',
          pricing: { prompt: '0' },
          architecture: { output_modalities: ['text'] },
          supported_parameters: [],
        },
      ],
    })
    expect(ids).toEqual([])
  })

  /**
   * The final step pins its shape with a strict `response_format: json_schema`,
   * so a model without `structured_outputs` fails the one call that matters.
   * Ordering by that first is worth more than ordering by context length.
   */
  it('puts the router first, then structured output, then response_format', () => {
    const model = (id, sp, ctx = 1000) => ({
      id,
      pricing: { prompt: '0' },
      context_length: ctx,
      architecture: { output_modalities: ['text'] },
      supported_parameters: ['tools', ...sp],
    })
    expect(
      freeChatModels({
        data: [
          model('z/tools-only', []),
          model('y/rf', ['response_format']),
          model('x/structured', ['structured_outputs']),
          model(FREE_ROUTER, ['structured_outputs'], 1),
        ],
      }),
    ).toEqual([FREE_ROUTER, 'x/structured', 'y/rf', 'z/tools-only'])
  })

  it('sorts by context length, then by id, so two builds agree', () => {
    const model = (id, ctx) => ({
      id,
      pricing: { prompt: '0' },
      context_length: ctx,
      architecture: { output_modalities: ['text'] },
      supported_parameters: ['tools', 'structured_outputs'],
    })
    expect(freeChatModels({ data: [model('b', 10), model('a', 10), model('c', 99)] })).toEqual([
      'c',
      'a',
      'b',
    ])
  })

  it('reads the embeddings catalogue by its own modality', () => {
    expect(
      freeEmbedModels({
        data: [
          {
            id: 'n/embed:free',
            pricing: { prompt: '0' },
            architecture: { output_modalities: ['embeddings'] },
          },
          {
            id: 'n/chat:free',
            pricing: { prompt: '0' },
            architecture: { output_modalities: ['text'] },
          },
        ],
      }),
    ).toEqual(['n/embed:free'])
  })

  it('treats a missing model as a request for the pool, and a named one as not', () => {
    for (const v of [null, undefined, '', '  ', 'auto', 'AUTO', 'free']) {
      expect(isAutoModel(v), String(v)).toBe(true)
    }
    for (const v of ['gpt-4o-mini', 'openrouter/free', 'qwen3:8b']) {
      expect(isAutoModel(v), v).toBe(false)
    }
  })
})

/**
 * A catalogue that cannot be reached is a reason to use last week's list, not a
 * reason to have no models — every one of these paths has to end with a usable
 * pool rather than with a throw.
 */
describe('fetching the live pool never leaves the caller empty-handed', () => {
  it('appends the baked list behind the live one', async () => {
    const ids = await fetchFreePool('chat', {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'brand/new:free',
              pricing: { prompt: '0' },
              architecture: { output_modalities: ['text'] },
              supported_parameters: ['tools', 'structured_outputs'],
            },
          ],
        }),
      }),
    })
    expect(ids[0]).toBe('brand/new:free')
    // Still reachable at the tail: an id that dropped off the first page of the
    // catalogue may well still be serving.
    expect(ids).toContain(FREE_CHAT[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('falls back to the baked list on a throw, a non-2xx, and an empty catalogue', async () => {
    const thrown = await fetchFreePool('chat', {
      fetchImpl: async () => {
        throw new Error('CSP')
      },
    })
    const refused = await fetchFreePool('chat', { fetchImpl: async () => ({ ok: false }) })
    const empty = await fetchFreePool('embed', {
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    })
    expect(thrown).toEqual(FREE_CHAT)
    expect(refused).toEqual(FREE_CHAT)
    expect(empty).toEqual(FREE_EMBED)
  })

  it('asks the catalogue the half is published at', async () => {
    const seen = []
    await fetchFreePool('embed', {
      fetchImpl: async (url) => {
        seen.push(url)
        return { ok: false }
      },
    })
    expect(seen).toEqual([CATALOGUE.embed])
  })
})

describe('candidate order', () => {
  it('de-duplicates, keeps the written order, and drops empty names', () => {
    expect(orderCandidates(['a', null, 'b', 'a', ''])).toEqual(['a', 'b'])
  })

  it('tries the model that answered last first', () => {
    expect(orderCandidates(['a', 'b', 'c'], { sticky: 'c' })).toEqual(['c', 'a', 'b'])
  })

  it('ignores a sticky choice that has left the pool', () => {
    expect(orderCandidates(['a', 'b'], { sticky: 'gone' })).toEqual(['a', 'b'])
  })

  /**
   * Cooling models go to the BACK rather than out. A pool where every member is
   * cooling is exactly the moment a reader is waiting, and answering "nothing
   * available" while ten of them would have answered is the failure this whole
   * feature exists to prevent.
   */
  it('sets a model that just refused aside without discarding it', () => {
    const cooldown = new Map([['a', 5000]])
    expect(orderCandidates(['a', 'b'], { cooldown, now: 1000 })).toEqual(['b', 'a'])
    expect(orderCandidates(['a', 'b'], { cooldown, now: 9000 })).toEqual(['a', 'b'])
  })

  it('keeps every model when the whole pool is cooling', () => {
    const cooldown = new Map([
      ['a', 5000],
      ['b', 5000],
    ])
    expect(orderCandidates(['a', 'b'], { cooldown, now: 1000 })).toEqual(['a', 'b'])
  })
})

describe('chat rotation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  const answer = '{"tool": "answer", "args": {"text": "ok"}}'

  it('moves to the next model when the first is rate limited, and says which answered', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      return model === 'a' ? failure(429, { 'retry-after': '30' }) : reply(answer)
    })
    const seen = []
    const out = await ask({ model: 'a', models: ['a', 'b'], onModel: (m) => seen.push(m) })
    // ONE request to 'a', not two: with 'b' in reserve, honouring a 30-second
    // `retry-after` would be thirty seconds of spinner beside an idle model.
    expect(asked).toEqual(['a', 'b'])
    expect(out.model).toBe('b')
    expect(seen).toEqual(['b'])
    expect(out.toolCall.name).toBe('answer')
  })

  it('remembers what answered and asks it first next time', async () => {
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      return model === 'a' ? failure(404) : reply(answer)
    })
    await ask({ models: ['a', 'b'] })
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return reply(answer)
    })
    await ask({ models: ['a', 'b'] })
    expect(asked).toEqual(['b'])
  })

  it.each([
    ['a retired id', 404],
    ['a model that has left the free tier', 402],
    ['a moderation refusal', 403],
    ['a schema the model will not take', 400],
    ['a broken upstream', 503],
  ])('rotates past %s', async (_what, status) => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      return model === 'a' ? failure(status) : reply(answer)
    })
    const out = await ask({ models: ['a', 'b'] })
    expect(out.model).toBe('b')
    expect(asked[asked.length - 1]).toBe('b')
  })

  /**
   * providers.js records a model doing exactly this: 1202 output tokens against
   * an empty `content`. Reported as an answer it becomes "I couldn't find this
   * in the docs" about a corpus that was never consulted.
   */
  it('treats a 200 carrying nothing as a model that did not answer', async () => {
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      return model === 'a' ? reply('') : reply(answer)
    })
    expect((await ask({ models: ['a', 'b'] })).model).toBe('b')
  })

  it('returns the last model’s empty reply rather than inventing a failure', async () => {
    vi.stubGlobal('fetch', async () => reply(''))
    const out = await ask({ models: ['a', 'b'] })
    expect(out.model).toBe('b')
    expect(out.toolCall).toBe(null)
  })

  /**
   * A rejected key rejects every model in the pool. Rotating turns one clear
   * message into N pointless requests and a final error naming whichever model
   * happened to be last.
   */
  it('does not rotate on a rejected key', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return failure(401)
    })
    await expect(ask({ models: ['a', 'b'] })).rejects.toThrow('chat 401')
    expect(asked).toEqual(['a'])
  })

  it('does not rotate once a delta is on screen', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: sse([
          { choices: [{ delta: { content: 'half an ' } }] },
          { error: { message: 'upstream died' } },
        ]),
      }
    })
    const painted = []
    await expect(
      ask({ models: ['a', 'b'], onDelta: (d) => painted.push(d.content) }),
    ).rejects.toThrow('upstream died')
    expect(asked).toEqual(['a'])
    expect(painted).toEqual(['half an '])
  })

  it('does not rotate when the reader pressed stop', async () => {
    const ctrl = new AbortController()
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      ctrl.abort()
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    })
    await expect(ask({ models: ['a', 'b'], signal: ctrl.signal })).rejects.toThrow()
    expect(asked).toEqual(['a'])
  })

  it('sends exactly what it always did when no pool is configured', async () => {
    const bodies = []
    vi.stubGlobal('fetch', async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return reply(answer)
    })
    const out = await ask({ model: 'only' })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].model).toBe('only')
    expect(out.model).toBe('only')
  })

  it('refuses to post a request with no model in it at all', async () => {
    vi.stubGlobal('fetch', async () => reply(answer))
    await expect(ask({})).rejects.toThrow('no model configured')
  })

  /**
   * The probe decides ONE thing for the whole session — native tools or the
   * fallback shape. A saturated head would otherwise demote every capable model
   * behind it to the fallback transport for the rest of the page's life.
   */
  it('lets the pool answer the capability probe, not just its head', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      if (model === 'a') return failure(429)
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { tool_calls: [{ function: { name: 'list_pages' } }] } }],
        }),
      }
    })
    expect(
      await detectTools({ provider: 'openai', baseURL: '/ai', models: ['a', 'b'] }),
    ).toBe(true)
    expect(asked).toEqual(['a', 'b'])
  })
})

describe('the configuration a free pool resolves from', () => {
  const cfg = (settings) => resolveDocPilot(settings, ENV)

  /**
   * The two objects `http-proxy` would hand `configure()`: a proxy that emits
   * `proxyReq`, and the outgoing request the handler edits. Recording rather
   * than asserting inside, so a test can say what was removed AND in what order.
   */
  const fakeProxyReq = () => ({
    removed: [],
    set: {},
    removeHeader(name) {
      this.removed.push(name)
    },
    setHeader(name, value) {
      this.set[name] = value
    },
  })
  const fakeProxy = (proxyReq) => ({
    on(event, fn) {
      if (event === 'proxyReq') fn(proxyReq)
    },
  })

  /**
   * `DEFAULTS.chat.model` is a statement about Ollama. Merged blindly, an author
   * who wrote `chat: {provider: 'openrouter'}` and nothing else had `qwen3:8b`
   * posted to OpenRouter — a 404 on every question, naming a model that appears
   * nowhere in their config file.
   */
  /**
   * A model name belongs to ONE service, and the shape of that rule changed
   * without the rule changing.
   *
   * It used to be enforced by having no answer: `qwen3:8b` was the single
   * shipped `chat.model`, so naming any other provider dropped it and left the
   * half unnamed, which `assertChat` then refused. Now every provider carries
   * its own `chatModel` in the table, so naming a provider names a model — and
   * what is still forbidden is exactly what was forbidden before: one
   * provider's name reaching another provider's endpoint.
   */
  it('gives each provider its own model and carries none across', () => {
    expect(cfg({ chat: { provider: 'openrouter' } }).chat.model).toBe(null) // the pool answers
    expect(cfg({ chat: { provider: 'openai' } }).chat.model).toBe('gpt-4o-mini')
    expect(cfg({ chat: { provider: 'anthropic' } }).chat.model).toBe('claude-sonnet-4-6')
    expect(cfg({ chat: { provider: 'ollama' } }).chat.model).toBe('qwen3:8b')
    // The author's own name outranks the table on every provider.
    expect(cfg({ chat: { provider: 'ollama', model: 'llama3' } }).chat.model).toBe('llama3')
    expect(cfg({ chat: { provider: 'openai', model: 'gpt-4.1' } }).chat.model).toBe('gpt-4.1')
  })

  /**
   * And with NOTHING named, the environment answers both questions at once.
   * `ENV` here carries `OPENROUTER_API_KEY` and nothing else, so the chain stops
   * on `openrouter` — whose model is the pool, hence null.
   */
  it('resolves provider and model together from the environment', () => {
    expect(cfg({}).chat.provider).toBe('openrouter')
    expect(cfg({}).chat.model).toBe(null)
    expect(cfg({}).chat.providerAuto).toBe(true)
    expect(cfg({ chat: { provider: 'ollama' } }).chat.providerAuto).toBe(false)
  })

  it('gives an unnamed OpenRouter both pools and no single name', () => {
    const c = cfg({ chat: { provider: 'openrouter' } })
    expect(chatModels(c)[0]).toBe(FREE_ROUTER)
    expect(embedModels(c)).toEqual(FREE_EMBED)
    // The embedder is named by the INDEX, not by the config — see the manifest.
    expect(resolveEmbed(c).model).toBe(null)
  })

  it('leaves every other provider unpooled', () => {
    expect(chatModels(cfg({ chat: { provider: 'openai', model: 'gpt-4o-mini' } }))).toBe(null)
    // Named, not left to `ENV` — the chain resolves an empty config to
    // `openrouter` here, which is the one provider that IS pooled.
    expect(chatModels(cfg({ chat: { provider: 'ollama' } }))).toBe(null)
    expect(embedModels(cfg({ chat: { provider: 'ollama' } }))).toBe(null)
  })

  it('lets an author pin their own order, beside a named primary', () => {
    const c = cfg({ chat: { provider: 'openrouter', model: 'paid/one', models: ['free/two'] } })
    expect(c.chat.model).toBe('paid/one')
    expect(chatModels(c)).toEqual(['free/two'])
    // `model` first, pool behind it — the transport's own ordering, not this
    // function's, but the pair has to survive the trip.
    expect(nodeChatTarget(c, ENV).model).toBe('paid/one')
    expect(nodeChatTarget(c, ENV).models).toEqual(['free/two'])
  })

  it('ships the chat pool to the browser and keeps the embed pool out of it', () => {
    const client = themeDocPilot(cfg({ chat: { provider: 'openrouter' } }), ENV)
    expect(client.llm.models).toEqual(FREE_CHAT)
    expect(client.llm.model).toBe(null)
    // Nothing about rotating an embedder reaches the page: the manifest names it.
    expect(client.embed.model).toBe(null)
    expect(client.embed.models).toBeUndefined()
    // And no key, as ever.
    expect(JSON.stringify(client)).not.toContain(ENV.OPENROUTER_API_KEY)
  })

  it('hands the indexer the pool to walk and the real host to walk it at', () => {
    const t = nodeEmbedTarget(cfg({ chat: { provider: 'openrouter' } }), ENV)
    expect(t.models).toEqual(FREE_EMBED)
    expect(t.model).toBe(null)
    expect(t.baseURL).toBe('https://openrouter.ai/api')
    expect(t.apiKey).toBe(ENV.OPENROUTER_API_KEY)
  })

  it('no longer stops the build for an OpenRouter that embeds', () => {
    const r = readiness(cfg({ chat: { provider: 'openrouter' } }), ENV)
    expect(r.missing.map((m) => m.what).join(' ')).not.toContain('embeddings endpoint')
  })

  /**
   * The chat-only providers are the ones people actually pick for the answering
   * half, and every one of them used to stop the build with a correct diagnosis
   * and no default. `embed: 'auto'` borrows the free pool instead — the same
   * pool, resolved the same way, named by the manifest rather than the config.
   */
  it("borrows the free embed pool when the chat provider cannot embed", () => {
    for (const id of ['anthropic', 'deepseek', 'groq', 'xai', 'cerebras']) {
      const c = cfg({ chat: { provider: id, model: 'whatever' } })
      const e = resolveEmbed(c)
      expect(e.provider, id).toBe('openrouter')
      expect(e.borrowed, id).toBe(id)
      // Unnamed, exactly as for an unnamed OpenRouter: the INDEX names it.
      expect(e.model, id).toBe(null)
      expect(embedModels(c), id).toEqual(FREE_EMBED)
      expect(nodeEmbedTarget(c, ENV).baseURL, id).toBe('https://openrouter.ai/api')
    }
  })

  it('no longer stops the build for a chat-only provider', () => {
    expect(() => themeDocPilot(cfg({ chat: { provider: 'anthropic', model: 'c' } }), ENV)).not.toThrow()
  })

  /**
   * The borrowed embedder is a THIRD PARTY the author did not name, and the
   * whole corpus goes through it at build time. A default that quiet is a
   * default worth printing.
   */
  it('says out loud that the corpus is embedded by a borrowed provider', () => {
    const r = readiness(cfg({ chat: { provider: 'anthropic', model: 'c' } }), {
      ...ENV,
      ANTHROPIC_API_KEY: 'sk-ant',
    })
    expect(r.notes.join(' ')).toMatch(/openrouter's free embedding pool/)
  })

  /**
   * The hole this feature opens, closed in the same change.
   *
   * "The config names nothing, so the index names the winner" is sound only
   * while the index was built by the SAME provider. Switching `chat.provider`
   * to one that cannot embed used to stop the build; now it silently moves the
   * embedder to OpenRouter, and an index built by Ollama still says `bge-m3` in
   * its manifest — which the browser would post to OpenRouter, once per
   * question, for a 404 and lexical-only retrieval that nothing reports.
   */
  it('catches an index built outside the pool it is now bound to', () => {
    const env = { ...ENV, ANTHROPIC_API_KEY: 'sk-ant' }
    const withIndex = (embedModel) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'docpilot-pool-'))
      writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ embedModel, chunkCount: 1, hash: 'h', dims: 2048 }),
      )
      tmpDirs.push(dir)
      return cfg({ chat: { provider: 'anthropic', model: 'c' }, indexDir: dir })
    }

    const stale = readiness(withIndex('bge-m3'), env)
    expect(stale.missing.map((m) => m.what).join(' ')).toMatch(
      /is not in openrouter's free embedding pool/,
    )

    // An index built BY the pool is the case this must not fire on.
    const fresh = readiness(withIndex(FREE_EMBED[1]), env)
    expect(fresh.missing).toEqual([])
    expect(fresh.ok).toBe(true)
  })

  /**
   * `resolveEmbed` takes no env on purpose: a resolver that changed its answer
   * with the environment would hand a CI box a different configuration than the
   * laptop that built the index. The missing key is reported, not routed around.
   */
  it('borrows deterministically and reports the missing key as a key', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant' }
    const c = cfg({ chat: { provider: 'anthropic', model: 'c' } })
    expect(resolveEmbed(c).provider).toBe('openrouter')
    expect(readiness(c, env).missing.map((m) => m.what)).toContain(
      'embed: "openrouter" needs a key and none is set',
    )
  })

  /** Two halves, two upstreams, two keys — and the specific route first. */
  it('proxies the borrowed embeddings apart from chat', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant', ...ENV }
    const routes = devProxy(cfg({ chat: { provider: 'anthropic', model: 'c' } }), env)
    expect(Object.keys(routes)).toEqual([
      '^/ai/v1/embeddings(?:\\?.*)?$',
      '^/ai/v1/messages(?:\\?.*)?$',
    ])
    expect(routes['^/ai/v1/embeddings(?:\\?.*)?$'].target).toBe('https://openrouter.ai/api')
    expect(routes['^/ai/v1/messages(?:\\?.*)?$'].target).toBe('https://api.anthropic.com')
  })

  /**
   * THE KEY IS A PATH, NOT A PREFIX — and the difference spends the owner's
   * money. Vite's matcher, copied here verbatim from
   * `vite/dist/node/chunks/node.js`, is the whole reason the key carries a `^`:
   * a plain string key is `url.startsWith(key)`, and this route attaches the
   * owner's API key on the way out.
   */
  it('keys each proxied path so nothing under it is proxied too', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant', ...ENV }
    const routes = devProxy(cfg({ chat: { provider: 'anthropic', model: 'c' } }), env)
    const matches = (url) =>
      Object.keys(routes).some(
        (context) =>
          (context[0] === '^' && new RegExp(context).test(url)) || url.startsWith(context),
      )

    expect(matches('/ai/v1/messages')).toBe(true)
    expect(matches('/ai/v1/embeddings')).toBe(true)
    // A provider that starts appending a query string must not silently stop
    // being proxied — that failure looks like "the panel 404s in dev".
    expect(matches('/ai/v1/messages?beta=1')).toBe(true)

    // `req.url` is raw: Node does not resolve `..`, so the anchored key is what
    // rejects this rather than any normalisation upstream of us.
    expect(matches('/ai/v1/messages/../../v1/models')).toBe(false)
    expect(matches('/ai/v1/messages/anything')).toBe(false)
    expect(matches('/ai/v1/messagesX')).toBe(false)
    expect(matches('/ai/v1/models')).toBe(false)
    expect(matches('/ai')).toBe(false)
  })

  /**
   * WHAT THE BROWSER SENT DOES NOT TRAVEL UPSTREAM. `proxyContract` tells the
   * owner to strip these three before forwarding; the dev proxy owes the same.
   * `vitepress dev --host` is the reachable case: anyone on the LAN could post
   * an `authorization:` of their choosing and have it delivered to
   * `api.anthropic.com` alongside the owner's key.
   */
  it('strips client credentials before attaching the owner key', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant', ...ENV }
    const routes = devProxy(cfg({ chat: { provider: 'anthropic', model: 'c' } }), env)
    const seen = fakeProxyReq()
    routes['^/ai/v1/messages(?:\\?.*)?$'].configure(fakeProxy(seen))

    expect(seen.removed).toEqual(['authorization', 'x-api-key', 'cookie'])
    expect(seen.set).toEqual({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' })
  })

  /**
   * And it strips them WITHOUT a key of its own. The route is built whether or
   * not the key resolved, and "we had nothing to add" is no reason to hand a
   * reader's SSO cookie to a third party.
   */
  it('strips them even when no owner key resolved', () => {
    const routes = devProxy(cfg({ chat: { provider: 'anthropic', model: 'c' } }), ENV)
    const seen = fakeProxyReq()
    routes['^/ai/v1/messages(?:\\?.*)?$'].configure(fakeProxy(seen))

    expect(seen.removed).toEqual(['authorization', 'x-api-key', 'cookie'])
    expect(seen.set).toEqual({})
  })

  /** Borrowing is for the UNNAMED case only. An explicit embedder is a sentence. */
  it('still stops the build for an explicitly named provider that cannot embed', () => {
    expect(() =>
      themeDocPilot(cfg({ chat: { provider: 'anthropic', model: 'c' }, embed: { provider: 'deepseek' } }), ENV),
    ).toThrow(/it can\n  answer, not retrieve/)
  })

  it('leaves a chat provider that embeds on its own model', () => {
    expect(resolveEmbed(cfg({ chat: { provider: 'openai', model: 'gpt-4o-mini' } })).model).toBe(
      'text-embedding-3-small',
    )
    // `cfg({})` resolves through the chain against `ENV`, which lands on
    // `openrouter` and its pool. Ollama is named to ask the question this test
    // is actually about: a chat provider that embeds keeps its own embedder.
    expect(resolveEmbed(cfg({ chat: { provider: 'ollama' } })).model).toBe('bge-m3')
    expect(resolveEmbed(cfg({ chat: { provider: 'ollama' } })).borrowed).toBeUndefined()
  })
})

/**
 * The build half of the pool, driven through an injected transport.
 *
 * What matters here is the RESTART: an embedder that dies partway through must
 * cost the whole pass, not be topped up by its replacement. Half an index in one
 * vector space and half in another scores every query against a coin flip, and
 * nothing downstream can see that it happened.
 */
describe('choosing an embedder at build time', () => {
  // A vector that says which model made it, and survives L2 normalisation
  // saying it — `[1,1,1,1]` and `[2,2,2,2]` normalise to the same thing, so the
  // signature has to be the AXIS rather than the magnitude.
  const vec = (axis) => Array.from({ length: 4 }, (_, i) => (i === axis ? 1 : 0))
  const ok = (texts, axis = 0) => ({ vectors: texts.map(() => vec(axis)) })
  const boom = (message) => {
    throw new Error(message)
  }

  it('takes the first free embedder that answers and says which', async () => {
    const asked = []
    const chosen = []
    const run = createEmbedder({
      model: null,
      pool: ['dead', 'alive', 'never'],
      batchSize: 2,
      batch: async (m, t) => {
        asked.push(m)
        return m === 'dead' ? { error: 'HTTP 503' } : ok(t)
      },
      fail: boom,
      onChoose: (m, dims, size) => chosen.push([m, dims, size]),
    })
    const out = await run.all(['a', 'b', 'c'])
    expect(out.model).toBe('alive')
    expect(out.vectors).toHaveLength(3)
    expect(chosen).toEqual([['alive', 4, 3]])
    expect(asked.slice(0, 2)).toEqual(['dead', 'alive'])
    // 'never' is never probed: the pool stops at the first that answers.
    expect(asked).not.toContain('never')
  })

  it('does not shop around when a model was named', async () => {
    const asked = []
    const run = createEmbedder({
      model: 'named',
      pool: ['other'],
      batch: async (m, t) => {
        asked.push(m)
        return ok(t)
      },
      fail: boom,
    })
    expect((await run.all(['a'])).model).toBe('named')
    expect(new Set(asked)).toEqual(new Set(['named']))
  })

  it('discards the vectors it had when the embedder dies mid-pass', async () => {
    const restarts = []
    let firstBatches = 0
    const run = createEmbedder({
      model: null,
      pool: ['flaky', 'steady'],
      batchSize: 1,
      batch: async (m, t) => {
        if (m !== 'flaky') return ok(t, 3)
        firstBatches++
        // one probe, one real batch, then it goes down
        return firstBatches > 2 ? { error: 'HTTP 429' } : ok(t, 0)
      },
      fail: boom,
      onRestart: (from, to, why) => restarts.push([from, to, why]),
    })
    const out = await run.all(['a', 'b', 'c'])
    expect(restarts).toEqual([['flaky', 'steady', 'HTTP 429']])
    expect(out.model).toBe('steady')
    expect(out.vectors).toHaveLength(3)
    // Every vector carries 'steady''s axis. The chunk 'flaky' had already
    // embedded — axis 0 — is nowhere in the output.
    for (const v of out.vectors) expect([...v]).toEqual([0, 0, 0, 1])
  })

  it('gives up only once every model in the pool has been tried', async () => {
    const run = createEmbedder({
      model: null,
      pool: ['a', 'b'],
      batch: async (m, t) => (t[0] === 'docpilot embedder probe' ? ok(t) : { error: 'HTTP 500' }),
      fail: boom,
    })
    await expect(run.all(['x'])).rejects.toThrow(/every model in the free pool has been tried/)
  })

  it('stops at an unreachable host rather than working through the pool', async () => {
    const asked = []
    const run = createEmbedder({
      model: null,
      pool: ['a', 'b'],
      batch: async (m) => {
        asked.push(m)
        return { fatal: 'embed endpoint unreachable' }
      },
      fail: boom,
    })
    await expect(run.all(['x'])).rejects.toThrow('embed endpoint unreachable')
    expect(asked).toEqual(['a'])
  })

  it('says so when there is neither a model nor a pool', async () => {
    const run = createEmbedder({ model: null, pool: [], batch: async () => ok(['x']), fail: boom })
    await expect(run.all(['x'])).rejects.toThrow(/has no free pool/)
  })
})

describe('a provider named without a model', () => {
  const cfg = (settings) => resolveDocPilot(settings, ENV)

  /**
   * `custom` is the one provider left where nothing can choose, and that is what
   * it is for: it names a HOST rather than a service, so there is no catalogue
   * to have a default in and no pool behind it. Every branded provider now
   * carries a `chatModel`, so this used to be spelled with `openai` and is not a
   * failure there any more.
   */
  it('stops the build where nothing can choose for you', () => {
    expect(() => themeDocPilot(cfg({ chat: { provider: 'custom' } }), ENV)).toThrow(
      /chat\.model is not set for "custom"/,
    )
  })

  it('does not, where the provider table can', () => {
    expect(() => themeDocPilot(cfg({ chat: { provider: 'openai' } }), ENV)).not.toThrow()
    expect(cfg({ chat: { provider: 'openai' } }).chat.model).toBe('gpt-4o-mini')
  })

  it('does not, where a pool can', () => {
    expect(() => themeDocPilot(cfg({ chat: { provider: 'openrouter' } }), ENV)).not.toThrow()
  })

  it('does not, where the author supplied their own pool', () => {
    expect(() =>
      themeDocPilot(cfg({ chat: { provider: 'openai', models: ['gpt-4o-mini'] } }), ENV),
    ).not.toThrow()
  })
})

describe('the last candidate is the one that waits', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  /**
   * Rotation is the cheap retry; the wait is the expensive one. So the wait is
   * spent only where it is the last thing left that can work.
   */
  it('spends the retry budget on the final model and on no other', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return failure(429, { 'retry-after': '0.001' })
    })
    await expect(ask({ models: ['a', 'b'] })).rejects.toThrow(/rate limited/)
    // a once, then b four times — MAX_ATTEMPTS on the last candidate.
    expect(asked).toEqual(['a', 'b', 'b', 'b', 'b'])
  })
})

/**
 * The failures the first pass of this feature could not see — each one found by
 * review, each one pinned here so it cannot come back quietly.
 */
describe('failures that arrive after the response has opened', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  const errorFrame = (frames) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: sse(frames),
  })

  /**
   * A shared free tier's commonest failure is not an HTTP status at all: the
   * response opens 200 and the rate limit arrives one frame later. Every browser
   * turn streams, so this is the normal path, and until the code travelled with
   * the message the pool could not see the one failure it exists to survive.
   */
  it('rotates on a 429 that arrives inside the stream', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      asked.push(model)
      return model === 'a'
        ? errorFrame([{ error: { code: 429, message: 'rate-limited upstream' } }])
        : errorFrame([
            { choices: [{ delta: { content: '{"tool":"answer","args":{"text":"ok"}}' } }] },
          ])
    })
    const painted = []
    const out = await ask({ models: ['a', 'b'], onDelta: (d) => painted.push(d.content) })
    expect(asked).toEqual(['a', 'b'])
    expect(out.model).toBe('b')
    // Nothing from the failed model reached the screen.
    expect(painted.join('')).toBe('{"tool":"answer","args":{"text":"ok"}}')
  })

  /**
   * The same error, one frame later. Now the guard that matters is `emitted`,
   * and this is the test that makes it bite: the status IS rotatable, so only
   * the painted delta can be what stops the rotation.
   */
  it('does not rotate once a rotatable failure arrives mid-answer', async () => {
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      return errorFrame([
        { choices: [{ delta: { content: 'half an ' } }] },
        { error: { code: 429, message: 'rate-limited upstream' } },
      ])
    })
    const painted = []
    await expect(
      ask({ models: ['a', 'b'], onDelta: (d) => painted.push(d.content) }),
    ).rejects.toThrow('rate-limited upstream')
    expect(asked).toEqual(['a'])
    expect(painted).toEqual(['half an '])
  })

  /** Same again for the reader's stop: a rotatable status, and still no second model. */
  it('does not rotate on a rotatable failure once the reader has stopped', async () => {
    const ctrl = new AbortController()
    const asked = []
    vi.stubGlobal('fetch', async (_url, init) => {
      asked.push(JSON.parse(init.body).model)
      ctrl.abort()
      return failure(429)
    })
    await expect(ask({ models: ['a', 'b'], signal: ctrl.signal })).rejects.toThrow(/429/)
    expect(asked).toEqual(['a'])
  })
})

describe('a named primary keeps its place', () => {
  it('leads even after an understudy has answered', () => {
    expect(
      orderCandidates(['paid', 'free'], { sticky: 'free', primary: 'paid' }),
    ).toEqual(['paid', 'free'])
  })

  it('yields while it is itself cooling, and takes the lead back afterwards', () => {
    const cooldown = new Map([['paid', 5000]])
    const opts = { sticky: 'free', primary: 'paid', cooldown }
    expect(orderCandidates(['paid', 'free'], { ...opts, now: 1000 })).toEqual(['free', 'paid'])
    expect(orderCandidates(['paid', 'free'], { ...opts, now: 9000 })).toEqual(['paid', 'free'])
  })

  it('sends the author back to their own model once its cooldown has passed', async () => {
    vi.stubGlobal('fetch', async (_url, init) => {
      const { model } = JSON.parse(init.body)
      return model === 'paid' ? failure(429) : reply('{"tool":"answer","args":{"text":"ok"}}')
    })
    const first = await ask({ model: 'paid', models: ['free'] })
    expect(first.model).toBe('free')

    // The cooldown expires; nothing else has to happen for the primary to be
    // asked again — no reload, no configuration change.
    vi.setSystemTime(new Date(Date.now() + 120000))
    vi.stubGlobal('fetch', async () => reply('{"tool":"answer","args":{"text":"ok"}}'))
    const second = await ask({ model: 'paid', models: ['free'] })
    expect(second.model).toBe('paid')
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetPools()
  })
})

describe('the capability probe has three answers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPools()
  })

  const noTools = {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
  }

  it('says false only when a model actually answered without calling a tool', async () => {
    vi.stubGlobal('fetch', async () => noTools)
    expect(await detectTools({ provider: 'openai', baseURL: '/ai', models: ['a', 'b'] })).toBe(false)
  })

  /**
   * The caller latches a `false` for the life of the page, so "everybody was
   * busy" must not be spelled the same way as "this model cannot call tools" —
   * one rate-limited second would otherwise cost the page every tool call it
   * would have made afterwards.
   */
  it('says null when the question never reached a model', async () => {
    vi.stubGlobal('fetch', async () => failure(429))
    expect(await detectTools({ provider: 'openai', baseURL: '/ai', models: ['a', 'b'] })).toBe(null)
  })

  it('says null when the reader stopped before an answer', async () => {
    const ctrl = new AbortController()
    vi.stubGlobal('fetch', async () => {
      ctrl.abort()
      throw new Error('aborted')
    })
    expect(
      await detectTools({ provider: 'openai', baseURL: '/ai', models: ['a', 'b'], signal: ctrl.signal }),
    ).toBe(null)
  })
})

describe('a batch response is read in request order', () => {
  it('sorts by the index the provider reported', () => {
    expect(
      embeddingsOf({ data: [{ index: 2, embedding: [3] }, { index: 0, embedding: [1] }, { index: 1, embedding: [2] }] }, false),
    ).toEqual([[1], [2], [3]])
  })

  it('leaves a bare array alone — Ollama reports no index', () => {
    expect(embeddingsOf({ embeddings: [[1], [2]] }, true)).toEqual([[1], [2]])
  })

  it('does not invent an order the provider did not give', () => {
    expect(embeddingsOf({ data: [{ embedding: [1] }, { embedding: [2] }] }, false)).toEqual([[1], [2]])
  })
})

describe('a rejected embedder is a tried embedder', () => {
  it('does not reach back for one that already refused the probe', async () => {
    const asked = []
    let live = false
    const run = createEmbedder({
      model: null,
      pool: ['refused', 'winner'],
      batchSize: 1,
      batch: async (m, t) => {
        asked.push(m)
        if (m === 'refused') return { error: 'HTTP 503' }
        // 'winner' probes fine, embeds one chunk, then dies.
        if (!live) {
          live = true
          return { vectors: t.map(() => [1, 0]) }
        }
        return asked.filter((x) => x === 'winner').length > 2
          ? { error: 'HTTP 429' }
          : { vectors: t.map(() => [1, 0]) }
      },
      fail: (m) => {
        throw new Error(m)
      },
    })
    await expect(run.all(['a', 'b', 'c'])).rejects.toThrow(
      /every model in the free pool has been tried/,
    )
    // 'refused' is never asked a second time.
    expect(asked.filter((m) => m === 'refused')).toEqual(['refused'])
  })
})

/**
 * The vectors already bought, and the one thing the cache may never do.
 *
 * It is a CACHE and never a second code path: a miss re-embeds, which is what
 * the build did before it existed. What it must never do is hand back a vector
 * from another space — the failure `calibrate.js`'s `sigOf` docstring is a
 * post-mortem of, where a cache keyed too loosely published one embedder's
 * thresholds as another's calibration.
 */
describe('the embedding cache', () => {
  const vec = (axis, dims = 4) => Array.from({ length: dims }, (_, i) => (i === axis ? 1 : 0))
  const boom = (message) => {
    throw new Error(message)
  }
  const dirs = []
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'docpilot-embed-cache-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const runner = (dir, { model = 'm', provider = 'openai', baseURL = '/ai', onBatch } = {}) =>
    createEmbedder({
      model,
      batch: async (m, texts) => {
        onBatch?.(m, texts)
        return { vectors: texts.map((t) => vec(t.length % 4)) }
      },
      fail: boom,
      batchSize: 2,
      cacheFor: (m) => openEmbedCache({ dir, model: m, provider, baseURL }),
    })

  it('buys each vector once, and the second build buys none', async () => {
    const dir = tmp()
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee']

    const cold = []
    const first = await runner(dir, { onBatch: (_m, t) => cold.push(...t) }).all(texts)
    expect(cold).toEqual(texts)

    const warm = []
    const second = await runner(dir, { onBatch: (_m, t) => warm.push(...t) }).all(texts)
    expect(warm).toEqual([])

    // Bit-identical, not merely close: the build promises byte-identical output
    // for identical input, and `toInt8` rounds — an f64 round trip would
    // disagree on the boundary and break that quietly.
    expect(first.vectors.length).toBe(texts.length)
    second.vectors.forEach((v, i) => expect([...v]).toEqual([...first.vectors[i]]))
  })

  it('survives a transport that has stopped answering, when nothing is missing', async () => {
    const dir = tmp()
    const texts = ['a', 'bb', 'ccc']
    await runner(dir).all(texts)

    const dead = createEmbedder({
      model: 'm',
      batch: async () => boom('the endpoint is gone'),
      fail: boom,
      cacheFor: (m) => openEmbedCache({ dir, model: m, provider: 'openai', baseURL: '/ai' }),
    })
    const out = await dead.all(texts)
    expect(out.vectors).toHaveLength(3)
  })

  it('embeds only what is new when the corpus grows', async () => {
    const dir = tmp()
    await runner(dir).all(['a', 'bb'])
    const asked = []
    await runner(dir, { onBatch: (_m, t) => asked.push(...t) }).all(['a', 'bb', 'ccc'])
    expect(asked).toEqual(['ccc'])
  })

  /**
   * The three key components, each on its own. A cache that ignored any one of
   * them would serve a vector from a different space under the same text.
   */
  it('is cold under a different model, provider or host', async () => {
    const dir = tmp()
    const texts = ['a', 'bb']
    await runner(dir).all(texts)

    for (const over of [{ model: 'other' }, { provider: 'together' }, { baseURL: 'https://elsewhere' }]) {
      const asked = []
      await runner(dir, { ...over, onBatch: (_m, t) => asked.push(...t) }).all(texts)
      expect(asked, JSON.stringify(over)).toEqual(texts)
    }
  })

  it('drops a blob that does not match its index rather than serving half of it', async () => {
    const dir = tmp()
    const texts = ['a', 'bb', 'ccc']
    await runner(dir).all(texts)

    const bin = readdirSync(dir).find((f) => f.endsWith('.bin'))
    writeFileSync(path.join(dir, bin), Buffer.from([1, 2, 3]))

    const warnings = []
    const asked = []
    const run = createEmbedder({
      model: 'm',
      batch: async (m, t) => {
        asked.push(...t)
        return { vectors: t.map((x) => vec(x.length % 4)) }
      },
      fail: boom,
      cacheFor: (m) =>
        openEmbedCache({
          dir,
          model: m,
          provider: 'openai',
          baseURL: '/ai',
          warn: (w) => warnings.push(w),
        }),
    })
    await run.all(texts)
    expect(asked).toEqual(texts)
    expect(warnings.join(' ')).toMatch(/not usable/)
  })

  it('discards the cache with the vectors when an embedder dies mid-pass', async () => {
    const dir = tmp()
    const texts = ['a', 'bb', 'ccc', 'dddd']
    let seen = 0
    const run = createEmbedder({
      model: null,
      pool: ['dies', 'lives'],
      batchSize: 2,
      batch: async (m, t) => {
        if (m === 'dies' && t.length > 1 && ++seen > 1) return { error: 'HTTP 503' }
        return { vectors: t.map(() => vec(m === 'dies' ? 0 : 1)) }
      },
      fail: boom,
      cacheFor: (m) => openEmbedCache({ dir, model: m, provider: 'openai', baseURL: '/ai' }),
    })
    const out = await run.all(texts)
    expect(out.model).toBe('lives')
    // One vector space, whole. A cache keyed on text alone would have topped the
    // survivor's pass up with the dead model's rows.
    for (const v of out.vectors) expect([...v]).toEqual([0, 1, 0, 0])
  })
})

describe('the query embedder waits rather than reporting an outage', () => {
  afterEach(() => vi.unstubAllGlobals())

  const vector = {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ data: [{ embedding: [3, 4] }] }),
  }

  it('retries a rate limit and returns the vector, scaled to the index domain', async () => {
    let n = 0
    vi.stubGlobal('fetch', async () => (++n === 1 ? failure(429, { 'retry-after': '0.001' }) : vector))
    const v = await embedQuery('q', { provider: 'openai', baseURL: '/ai', model: 'm' })
    expect(n).toBe(2)
    // [3,4] normalises to [0.6,0.8] and scales by 127.
    expect(v[0]).toBeCloseTo(76.2, 6)
    expect(v[1]).toBeCloseTo(101.6, 6)
  })

  it('gives up after three attempts, so the turn can fall back to lexical', async () => {
    let n = 0
    vi.stubGlobal('fetch', async () => {
      n++
      return failure(429, { 'retry-after': '0.001' })
    })
    await expect(embedQuery('q', { provider: 'openai', baseURL: '/ai', model: 'm' })).rejects.toThrow(
      'embed 429',
    )
    expect(n).toBe(3)
  })

  it('does not retry a refusal that a retry cannot fix', async () => {
    let n = 0
    vi.stubGlobal('fetch', async () => {
      n++
      return failure(404)
    })
    await expect(embedQuery('q', { provider: 'openai', baseURL: '/ai', model: 'm' })).rejects.toThrow(
      'embed 404',
    )
    expect(n).toBe(1)
  })

  /**
   * A pooled config names no embedder; the manifest does. If neither did, the
   * request would go out with `model: undefined` and come back 400 — a
   * confusing report of a configuration problem.
   */
  it('refuses to ask for an embedding with no model named', async () => {
    vi.stubGlobal('fetch', async () => vector)
    await expect(embedQuery('q', { provider: 'openai', baseURL: '/ai', model: null })).rejects.toThrow(
      /no embedding model/,
    )
  })
})

/**
 * The failure a free embedding pool makes ordinary: an index outliving the model
 * that built it. Both are 2048-dimensional today; a corpus indexed under an
 * older, narrower one is a query vector of the wrong width.
 */
describe('a query vector of the wrong width is a missing embedder, not a weak answer', () => {
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
  const axis = (i) => {
    const v = new Array(DIMS).fill(0)
    v[i] = 127
    return v
  }
  const rows = [
    { id: 'a#one', path: '/a', anchor: 'one', title: 'Alpha', breadcrumb: 'Docs', kind: 'guide', text: 'The alpha widget is configured with a manifest and a token.', prev: null, next: null, vec: axis(0) },
    { id: 'b#one', path: '/b', anchor: 'one', title: 'Beta', breadcrumb: 'Docs', kind: 'reference', text: 'The beta gizmo installs from the registry and needs no token.', prev: null, next: null, vec: axis(1) },
  ]
  const index = () => {
    const vectors = new Int8Array(rows.length * DIMS)
    rows.forEach((r, i) => vectors.set(r.vec, i * DIMS))
    const chunks = rows.map(({ vec, ...c }) => c)
    return assembleIndex({
      manifest: {
        version: 3,
        hash: 'zz',
        embedModel: 'test',
        dims: DIMS,
        chunkCount: chunks.length,
        vectors: 'vectors.zz.bin',
        pages: [...new Set(chunks.map((c) => c.path))].map((p) => ({ path: p, title: `Page ${p}`, tail: 'Docs' })),
        guard: GUARD,
      },
      shards: [chunks],
      vectorBuffer: vectors.buffer,
      dfDoc: { df: {} },
    })
  }
  const ALL = { kind: 'all', paths: [], label: 'All docs' }

  it('reports the mode it actually ran in, so the gate scores against the right threshold', () => {
    const r = createRetrieval({ index: index(), scope: ALL, guard: GUARD })
    const wide = new Float64Array(2048)
    wide[0] = 127
    const g = r.evaluate({ question: 'how is the alpha widget configured?', queryVec: wide })
    expect(g.mode).toBe('lexical-only')
    expect(g.D).toBe(0)
  })

  it('still reports hybrid when the width matches', () => {
    const r = createRetrieval({ index: index(), scope: ALL, guard: GUARD })
    const g = r.evaluate({
      question: 'how is the alpha widget configured?',
      queryVec: Float64Array.from(axis(0)),
    })
    expect(g.mode).toBe('hybrid')
  })
})

/**
 * Two spellings that used to survive resolution and become model names.
 *
 * `undefined` is the worse of the two, because it does not survive at all:
 * themeConfig is serialised with JSON.stringify on its way into the page, and
 * that DELETES an undefined key — after which session.js fills the hole from its
 * own defaults with Ollama's `bge-m3`, disagrees with the manifest on every
 * turn, and runs lexical-only for the life of the deployment with nothing
 * failing anywhere.
 */
describe('an unnamed model resolves to null, and null is what crosses the wire', () => {
  const cfg = (settings) => resolveDocPilot(settings, ENV)

  it('normalises the spellings the docs advertise', () => {
    for (const spelling of ['auto', 'free', 'AUTO', '  ']) {
      expect(cfg({ chat: { provider: 'openrouter', model: spelling } }).chat.model, spelling).toBe(null)
    }
    expect(cfg({ chat: { provider: 'openrouter', model: 'openai/gpt-oss-20b:free' } }).chat.model).toBe(
      'openai/gpt-oss-20b:free',
    )
  })

  it('does not post the spelling as a model id', () => {
    const client = themeDocPilot(cfg({ chat: { provider: 'openrouter', model: 'auto' } }), ENV)
    expect(client.llm.model).toBe(null)
    expect(client.llm.models).not.toContain('auto')
    expect(client.llm.models[0]).toBe(FREE_ROUTER)
  })

  it('normalises an explicitly written embed object, not just the auto shape', () => {
    const c = cfg({ chat: { provider: 'anthropic', model: 'claude' }, embed: { provider: 'openrouter' } })
    expect(resolveEmbed(c).model).toBe(null)
    expect(embedModels(c)).toEqual(FREE_EMBED)
  })

  it('survives the JSON round trip themeConfig makes on its way into the page', () => {
    const c = cfg({ chat: { provider: 'anthropic', model: 'claude' }, embed: { provider: 'openrouter' } })
    const client = JSON.parse(JSON.stringify(themeDocPilot(c, ENV)))
    // The key is still THERE. `undefined` would have been deleted here, and the
    // browser would have filled the hole with a model nobody named.
    expect('model' in client.embed).toBe(true)
    expect(client.embed.model).toBe(null)
  })
})

describe('the halves are asserted where they are used', () => {
  const cfg = (settings) => resolveDocPilot(settings, ENV)

  /**
   * `npx docpilot index` calls no chat model. Refusing to build an index over a
   * missing `chat.model` is a failure in the wrong place and costs a run that
   * had nothing to do with it — the build still refuses that configuration
   * where the panel is assembled.
   */
  it('builds an index for a configuration whose chat half is unusable', () => {
    const c = cfg({ chat: { provider: 'custom' }, embed: { provider: 'ollama', model: 'bge-m3' } })
    expect(() => nodeEmbedTarget(c, ENV)).not.toThrow()
    expect(() => themeDocPilot(c, ENV)).toThrow(/chat\.model is not set/)
  })

  /**
   * ASSERTING AND RESOLVING HAVE TO AGREE ABOUT WHAT A PROVIDER'S DEFAULT IS.
   *
   * `assertChat` read `chat.model` while `resolveChat` privately held the table
   * lookup that fills it, so an UNRESOLVED config for a provider with a default
   * was refused — and the same object, passed through `resolveDocPilot` first,
   * sailed through. Every door here is documented as taking a site's own
   * `docPilot` export, and `proxyContract` says so in its header, so the refusal
   * was about the caller and it arrived wearing a message about a missing model.
   *
   * The providers that are still refused are the ones the check exists for:
   * `custom` names a HOST, has no catalogue to have a default in, and no pool.
   */
  it('reads the provider’s own default before refusing an unresolved config', () => {
    const raw = (provider) => ({ enabled: true, chat: { provider }, embed: false, host: {}, i18n: {} })
    for (const provider of ['ollama', 'openai', 'anthropic', 'openrouter', 'llamacpp']) {
      expect(() => themeDocPilot(raw(provider), ENV), `${provider} unresolved`).not.toThrow()
    }
    expect(() => themeDocPilot(raw('custom'), ENV)).toThrow(/chat\.model is not set/)
    // And the resolved form of the same object agrees, in both directions.
    expect(() => themeDocPilot(cfg({ chat: { provider: 'custom' }, embed: false }), ENV)).toThrow(
      /chat\.model is not set/,
    )
  })
})

describe('doctor only asks a catalogue that exists', () => {
  it('names the provider behind a pooled half, and nobody behind an unpooled one', () => {
    const pooled = resolveDocPilot({ chat: { provider: 'openrouter' } }, ENV)
    const own = resolveDocPilot({ chat: { provider: 'openai', models: ['gpt-4o-mini'] } }, ENV)
    expect(poolProviderOf(pooled, 'chat')).toBe('openrouter')
    expect(poolProviderOf(pooled, 'embed')).toBe('openrouter')
    // An author's own list on a provider that publishes nothing: comparing it
    // against OpenRouter's catalogue would report every entry retired.
    expect(poolProviderOf(own, 'chat')).toBe(null)
  })

  /**
   * With the baked ids folded into the answer, "which of ours has been retired?"
   * is a question whose answer is always "none" — a check that cannot fail.
   */
  it('can tell the live catalogue from the shipped list', async () => {
    const live = await fetchFreePool('chat', {
      fallback: false,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'only/this:free',
              pricing: { prompt: '0' },
              architecture: { output_modalities: ['text'] },
              supported_parameters: ['tools', 'structured_outputs'],
            },
          ],
        }),
      }),
    })
    expect(live).toEqual(['only/this:free'])
    expect(FREE_CHAT.filter((m) => !live.includes(m)).length).toBe(FREE_CHAT.length)
  })

  it('reports an unreachable catalogue as unreachable rather than as agreement', async () => {
    expect(await fetchFreePool('chat', { fallback: false, fetchImpl: async () => ({ ok: false }) })).toBe(
      null,
    )
    expect(await fetchFreePool('chat', { fetchImpl: async () => ({ ok: false }) })).toEqual(FREE_CHAT)
  })
})
