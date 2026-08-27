import { describe, it, expect, vi } from 'vitest'

import {
  discoverEmbedModels,
  embedCandidates,
  embedPoolOf,
  probeEmbedEndpoint,
} from '../src/build/lib/embed-discovery.js'
import { createEmbedder } from '../src/build/build-rag-index.js'

/**
 * Asking a provider which embedding models it serves, instead of trusting a
 * string this package wrote down months ago.
 *
 * The rule the whole file is about: **discovery proposes, the probe disposes.**
 * A candidate list is a guess — an OpenAI-compatible `/v1/models` is `{id}` and
 * nothing else, so an embedder can only be told from a chat model by its name —
 * and it is allowed to be a guess precisely because `createEmbedder` sends each
 * candidate a real embedding request before committing the corpus to it. The
 * last test here is the one that pins that arrangement; everything above it is
 * the shapes the guess has to survive.
 *
 * Nothing reaches the network: `fetchImpl` is injected at every call.
 */

/** A response, or a refusal, without a server. */
const ok = (body) => ({ ok: true, json: async () => body })
const status = (n) => ({ ok: false, status: n, json: async () => ({}) })

describe('reading a catalogue', () => {
  /**
   * The bare OpenAI shape: ids and nothing else. There is no capability field to
   * read, so the name is the only signal there is.
   */
  it('picks embedders out of a list that says nothing but the id', () => {
    const json = {
      data: [
        { id: 'gpt-4o-mini' },
        { id: 'text-embedding-3-small' },
        { id: 'gpt-4.1' },
        { id: 'text-embedding-3-large' },
      ],
    }
    expect(embedCandidates(json, json.data.map((m) => m.id))).toEqual([
      'text-embedding-3-large',
      'text-embedding-3-small',
    ])
  })

  /**
   * A DECLARED embedder beats a guessed one, and where every embedder declares
   * itself the name test never runs at all. OpenRouter publishes
   * `output_modalities`, which is an answer rather than a hint — and a model
   * whose name suggests nothing (`liquid/lfm-2.5-…`) is found only this way.
   */
  it('prefers what a catalogue declares over what a name suggests', () => {
    const json = {
      data: [
        { id: 'z-ai/glm-5.2:free', architecture: { output_modalities: ['text'] } },
        { id: 'liquid/lfm-2.5-350m', architecture: { output_modalities: ['embeddings'] } },
        // Named like an embedder and declared as text: the declaration wins and
        // this is NOT offered.
        { id: 'some/embed-sounding-chat', architecture: { output_modalities: ['text'] } },
      ],
    }
    expect(embedCandidates(json, json.data.map((m) => m.id))).toEqual(['liquid/lfm-2.5-350m'])
  })

  /**
   * Ollama's `/api/tags` carries no rows of the `data: [{id}]` shape at all, so
   * the parsed ids are the floor. A payload this function does not recognise has
   * to degrade to "the names I was given" rather than to nothing.
   */
  it('falls back to the ids when the payload has no rows to read', () => {
    const ids = ['qwen3:8b', 'bge-m3', 'nomic-embed-text']
    expect(embedCandidates({ models: [] }, ids)).toEqual(['bge-m3', 'nomic-embed-text'])
  })

  /** Deterministic to the last comparison, so two builds of one catalogue agree. */
  it('orders the same list the same way every time', () => {
    const rows = [{ id: 'b-embed' }, { id: 'a-embed' }, { id: 'c-embed' }]
    const forward = embedCandidates({ data: rows }, rows.map((m) => m.id))
    const backward = embedCandidates({ data: [...rows].reverse() }, rows.map((m) => m.id))
    expect(forward).toEqual(['a-embed', 'b-embed', 'c-embed'])
    expect(backward).toEqual(forward)
  })
})

/**
 * EVERY FAILURE IS AN EMPTY LIST, and the distinction it refuses to draw is the
 * whole contract: "could not ask" and "there are none" have to look identical to
 * the caller, because the caller already holds the configured name as the head
 * of its pool. A failed discovery therefore leaves the build exactly as it was
 * before this module existed — which is what makes adding it safe.
 */
describe('failing to read one', () => {
  const cases = [
    ['an unreachable host', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['a rejected key', () => Promise.resolve(status(401))],
    ['a missing endpoint', () => Promise.resolve(status(404))],
    ['a body that is not JSON', () => Promise.resolve({ ok: true, json: async () => { throw new Error('x') } })],
    ['a body of the wrong shape', () => Promise.resolve(ok({ result: 'surprise' }))],
    ['a catalogue with no embedders in it', () => Promise.resolve(ok({ data: [{ id: 'gpt-4o' }] }))],
  ]
  for (const [label, fetchImpl] of cases) {
    it(`answers with nothing for ${label}`, async () => {
      const got = await discoverEmbedModels({
        provider: 'openai',
        baseURL: 'https://api.example.com',
        apiKey: 'k',
        fetchImpl,
      })
      expect(got).toEqual([])
    })
  }

  /** No address is not a question worth asking — Gemini has no direct base. */
  it('makes no request at all without somewhere to send it', async () => {
    const fetchImpl = vi.fn()
    expect(await discoverEmbedModels({ provider: 'openai', baseURL: null, fetchImpl })).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /** Anthropic's adapter has no embed endpoint, but it does list its models. */
  it('asks each adapter at its own path, with its own headers', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push([url, Object.keys(init.headers)])
      return ok({ data: [{ id: 'text-embedding-3-small' }] })
    }
    await discoverEmbedModels({ provider: 'openai', baseURL: 'https://h', apiKey: 'k', fetchImpl })
    await discoverEmbedModels({ provider: 'anthropic', baseURL: 'https://h', apiKey: 'k', fetchImpl })
    await discoverEmbedModels({ provider: 'ollama', baseURL: 'http://h', fetchImpl })

    expect(seen[0][0]).toBe('https://h/v1/models')
    expect(seen[0][1]).toContain('authorization')
    expect(seen[1][0]).toBe('https://h/v1/models')
    expect(seen[1][1]).toContain('x-api-key')
    expect(seen[2][0]).toBe('http://h/api/tags')
  })
})

describe('building the pool', () => {
  /**
   * THE CONFIGURED NAME STAYS FIRST. It is the one candidate somebody chose
   * rather than found: what the docs name, what the last index was probably
   * built with. Discovery lines up behind it, so the ordinary build picks
   * exactly what it always picked.
   */
  it('keeps the configured name at the head and never repeats it', () => {
    expect(embedPoolOf('text-embedding-3-small', ['text-embedding-3-large', 'text-embedding-3-small'])).toEqual(
      ['text-embedding-3-small', 'text-embedding-3-large'],
    )
    expect(embedPoolOf(null, ['a', 'b'])).toEqual(['a', 'b'])
    expect(embedPoolOf('a', [])).toEqual(['a'])
    expect(embedPoolOf(null, [])).toEqual([])
  })
})

/**
 * THE ARRANGEMENT THE LOOSE NAME TEST DEPENDS ON.
 *
 * A chat model that slips through on its name costs one request and is skipped;
 * a stale configured name costs one request and is walked past. Neither is a
 * build failure, and neither can put the corpus in the wrong vector space —
 * `createEmbedder` commits only to a candidate that answered a real embedding
 * request. This is why the regex in embed-discovery.js is allowed to lean
 * towards admitting.
 */
describe('discovery proposes, the probe disposes', () => {
  const vector = (n) => Array.from({ length: n }, (_, i) => i / n)

  it('walks past a stale configured name to a candidate that answers', async () => {
    const asked = []
    const run = createEmbedder({
      model: null,
      pool: embedPoolOf('text-embedding-2-retired', ['text-embedding-3-small']),
      fail: (m) => {
        throw new Error(m)
      },
      batch: async (model, texts) => {
        asked.push(model)
        if (model === 'text-embedding-2-retired') return { error: 'HTTP 404' }
        return { vectors: texts.map(() => vector(8)) }
      },
    })
    const out = await run.all(['one', 'two'])
    expect(asked[0], 'the configured name is tried first').toBe('text-embedding-2-retired')
    expect(out.model).toBe('text-embedding-3-small')
    expect(out.vectors).toHaveLength(2)
  })

  it('skips a chat model that got in on its name', async () => {
    const run = createEmbedder({
      model: null,
      // `embed-sounding-chat` passes the name test and is not an embedder.
      pool: ['embed-sounding-chat', 'bge-m3'],
      fail: (m) => {
        throw new Error(m)
      },
      batch: async (model, texts) =>
        model === 'bge-m3'
          ? { vectors: texts.map(() => vector(8)) }
          : { error: 'the response carried no vectors' },
    })
    expect((await run.all(['one'])).model).toBe('bge-m3')
  })

  /**
   * And when every candidate refuses, the build gives up through the one exit
   * `createEmbedder` was built with — not through a half-embedded corpus.
   */
  it('gives up once, and says what it tried', async () => {
    const run = createEmbedder({
      model: null,
      pool: ['a-embed', 'b-embed'],
      fail: (m) => {
        throw new Error(m)
      },
      batch: async () => ({ error: 'HTTP 429' }),
    })
    await expect(run.all(['one'])).rejects.toThrow(/no embedder answered\. Tried 2:/)
  })
})

/**
 * THE CLAIM IN THE TABLE, CHECKED.
 *
 * `PROVIDERS` says anthropic, groq, deepseek, xAI and cerebras serve no
 * embeddings endpoint. That is a claim, and the same table once made the
 * opposite claim about OpenRouter for months after it stopped being true — so it
 * is asked rather than believed, in the one place where asking is free.
 *
 * What it must never do is ACT on the answer: the proxy that carries
 * `/ai/v1/embeddings` is written from `resolveEmbed()` at config time, so a
 * provider that moved itself would leave every reader's query vector posted to
 * the wrong upstream. `doctor` prints the line; the author writes it down.
 */
describe('probing an endpoint the table says is not there', () => {
  const target = { provider: 'openai', baseURL: 'https://api.example.com', apiKey: 'k' }

  const transport = ({ catalogue, embeds }) => async (url, init) => {
    if (!init?.method) return ok(catalogue)
    const model = JSON.parse(init.body).model
    return embeds.includes(model) ? ok({ data: [{ embedding: [0.1, 0.2] }] }) : status(400)
  }

  it('names the model that answered', async () => {
    const got = await probeEmbedEndpoint(target, {
      fetchImpl: transport({
        catalogue: { data: [{ id: 'gpt-4o' }, { id: 'nomic-embed-text-v1.5' }] },
        embeds: ['nomic-embed-text-v1.5'],
      }),
    })
    expect(got).toBe('nomic-embed-text-v1.5')
  })

  /** The expected case, and the one nobody needs told. Silence is the report. */
  it('answers null when the endpoint refuses', async () => {
    const got = await probeEmbedEndpoint(target, {
      fetchImpl: transport({
        catalogue: { data: [{ id: 'bge-small' }] },
        embeds: [],
      }),
    })
    expect(got).toBe(null)
  })

  it('answers null when the catalogue offers no candidate', async () => {
    const got = await probeEmbedEndpoint(target, {
      fetchImpl: transport({ catalogue: { data: [{ id: 'gpt-4o' }] }, embeds: ['gpt-4o'] }),
    })
    expect(got).toBe(null)
  })

  /**
   * BOUNDED. `doctor` runs in CI beside a readiness verdict, so this cannot turn
   * into a survey of somebody's catalogue — two candidates, and no more.
   */
  it('tries at most two candidates', async () => {
    const asked = []
    const fetchImpl = async (url, init) => {
      if (!init?.method) {
        return ok({ data: [{ id: 'a-embed' }, { id: 'b-embed' }, { id: 'c-embed' }] })
      }
      asked.push(JSON.parse(init.body).model)
      return status(400)
    }
    expect(await probeEmbedEndpoint(target, { fetchImpl })).toBe(null)
    expect(asked).toEqual(['a-embed', 'b-embed'])
  })

  /** Anthropic has no embeddings path at all — there is nowhere to knock. */
  it('makes no request for an adapter with no embeddings endpoint', async () => {
    const fetchImpl = vi.fn()
    expect(await probeEmbedEndpoint({ ...target, provider: 'anthropic' }, { fetchImpl })).toBe(null)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /** Never throws: a slow third party must not decide an exit code. */
  it('survives a transport that explodes', async () => {
    const fetchImpl = async (url, init) => {
      if (!init?.method) return ok({ data: [{ id: 'a-embed' }] })
      throw new Error('ECONNRESET')
    }
    expect(await probeEmbedEndpoint(target, { fetchImpl })).toBe(null)
  })
})
