import { describe, it, expect, vi } from 'vitest'

import { prefetchEmbeddings, scaleToIndexDomain, BATCH } from '../src/eval/prefetch.js'

/**
 * ONE PURCHASE PER RUN — spec 011, decision 5.
 *
 * This logic was written inside `calibrate.ts`, closed over that file's three
 * `EMBED_*` constants, mutated a module-level map, and was covered by nothing:
 * the retry, the short-batch refusal and the `retry-after` ceiling had never
 * been asserted. `run.ts`, `tune.ts` and `bench emit` all embedded the same way
 * and all bought one text per request — 58 requests for this repository's golden
 * set against a tier that allows fifty a day.
 */

/** An ollama-shaped body: `{embeddings: [...]}`, which `embeddingsOf` reads. */
const ok = (n, dims = 4) => ({
  ok: true,
  headers: new Headers(),
  json: async () => ({ embeddings: Array.from({ length: n }, () => Array(dims).fill(1)) }),
})

const status = (code, headers = {}) => ({
  ok: false,
  status: code,
  headers: new Headers(headers),
  json: async () => ({}),
})

const TARGET = { provider: 'ollama', baseURL: 'http://x', apiKey: null, model: 'bge-m3' }

/** The backoff, recorded rather than waited out. */
const waits = []
const sleepImpl = async (ms) => void waits.push(ms)

const texts = (n) => Array.from({ length: n }, (_, i) => `q${i}`)

describe('prefetchEmbeddings', () => {
  it('buys in batches of 32, not one at a time', async () => {
    const sizes = []
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      sizes.push(body.input.length)
      return ok(body.input.length)
    })

    const { vectors, requests } = await prefetchEmbeddings(texts(70), TARGET, { fetchImpl })

    expect(sizes).toEqual([32, 32, 6])
    expect(requests).toBe(3)
    expect(vectors.size).toBe(70)
    expect(BATCH).toBe(32)
  })

  it('deduplicates, so a question and its composed form cost one vector each', async () => {
    const fetchImpl = vi.fn(async (_url, init) => ok(JSON.parse(init.body).input.length))
    const { vectors, requests } = await prefetchEmbeddings(['a', 'b', 'a', 'b', ''], TARGET, {
      fetchImpl,
    })
    expect(vectors.size).toBe(2)
    expect(requests).toBe(1)
  })

  /**
   * A short batch is a provider that silently dropped inputs. Guessing which
   * ones came back is how a probe gets somebody else's vector — so it stops,
   * and every text falls through to the caller's per-text path.
   */
  it('refuses a short batch rather than guessing which inputs came back', async () => {
    const fetchImpl = vi.fn(async () => ok(5))
    const { vectors } = await prefetchEmbeddings(texts(10), TARGET, { fetchImpl })
    expect(vectors.size).toBe(0)
  })

  it('refuses a batch with an empty vector in it', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: new Headers(),
      json: async () => ({ embeddings: [[1, 2], []] }),
    }))
    const { vectors } = await prefetchEmbeddings(['a', 'b'], TARGET, { fetchImpl })
    expect(vectors.size).toBe(0)
  })

  it('retries a 429 and counts every attempt the provider counted', async () => {
    waits.length = 0
    let n = 0
    const fetchImpl = vi.fn(async (_url, init) => {
      n++
      if (n === 1) return status(429, { 'retry-after': '3' })
      return ok(JSON.parse(init.body).input.length)
    })

    const { vectors, requests } = await prefetchEmbeddings(['a', 'b'], TARGET, {
      fetchImpl,
      sleepImpl,
    })
    // `retry-after` is honoured, in seconds.
    expect(waits).toEqual([3000])
    expect(vectors.size).toBe(2)
    // Two requests for one batch: a retried 429 is a request the provider
    // counted, and `embedRequests` in the calibration document must agree.
    expect(requests).toBe(2)
  })

  it('gives up after three attempts rather than hammering', async () => {
    waits.length = 0
    const fetchImpl = vi.fn(async () => status(503))
    const { vectors, requests } = await prefetchEmbeddings(['a'], TARGET, { fetchImpl, sleepImpl })
    expect(vectors.size).toBe(0)
    expect(requests).toBe(3)
    // Exponential where the provider named no delay, and only twice: the third
    // attempt is the last one, and there is nothing to wait for after it.
    expect(waits).toEqual([1000, 2000])
  })

  /** A provider asking for an hour must not hold the run for an hour. */
  it('caps the wait at twenty seconds however long it was asked for', async () => {
    waits.length = 0
    const fetchImpl = vi.fn(async () => status(429, { 'retry-after': '3600' }))
    await prefetchEmbeddings(['a'], TARGET, { fetchImpl, sleepImpl })
    expect(waits).toEqual([20000, 20000])
  })

  it('does not retry a status that a second identical request would earn again', async () => {
    const fetchImpl = vi.fn(async () => status(401))
    const { requests } = await prefetchEmbeddings(['a'], TARGET, { fetchImpl })
    expect(requests).toBe(1)
  })

  it('returns quietly when the endpoint is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    const { vectors, requests } = await prefetchEmbeddings(['a'], TARGET, { fetchImpl })
    expect(vectors.size).toBe(0)
    expect(requests).toBe(1)
  })

  it('buys nothing at all when there is no model, no base or no provider', async () => {
    const fetchImpl = vi.fn()
    for (const t of [
      { ...TARGET, model: null },
      { ...TARGET, baseURL: null },
      {},
      null,
    ]) {
      const { vectors, requests } = await prefetchEmbeddings(['a'], t, { fetchImpl })
      expect(vectors.size).toBe(0)
      expect(requests).toBe(0)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /**
   * `build-rag-index` applies `search_document: ` across the same asymmetry, so
   * a probe embedded without `search_query: ` is the right vector on the wrong
   * side — and nothing downstream can see it.
   */
  it('prefixes a nomic model the way a QUERY is prefixed', async () => {
    let sent
    const fetchImpl = vi.fn(async (_url, init) => {
      sent = JSON.parse(init.body).input
      return ok(1)
    })
    await prefetchEmbeddings(['how do I start?'], { ...TARGET, model: 'nomic-embed-text' }, { fetchImpl })
    expect(sent[0]).toBe('search_query: how do I start?')

    await prefetchEmbeddings(['how do I start?'], TARGET, { fetchImpl })
    expect(sent[0]).toBe('how do I start?')
  })

  it('reports progress against the deduplicated total', async () => {
    const ticks = []
    const fetchImpl = vi.fn(async (_url, init) => ok(JSON.parse(init.body).input.length))
    await prefetchEmbeddings(texts(40), TARGET, {
      fetchImpl,
      onTick: (done, total) => ticks.push([done, total]),
    })
    expect(ticks).toEqual([
      [32, 40],
      [40, 40],
    ])
  })
})

/**
 * The vectors have to be `embedQuery`'s to the bit, or the batched path and the
 * per-text path score the same question differently.
 */
describe('scaleToIndexDomain', () => {
  it('is the unit vector times 127, not the unit vector', () => {
    const out = scaleToIndexDomain([3, 4])
    expect(out[0]).toBeCloseTo((3 / 5) * 127, 10)
    expect(out[1]).toBeCloseTo((4 / 5) * 127, 10)
  })

  it('survives an all-zero vector rather than dividing by zero', () => {
    const out = scaleToIndexDomain([0, 0])
    expect([...out]).toEqual([0, 0])
  })
})
