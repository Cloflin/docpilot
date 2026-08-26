/**
 * The Vercel deploy's `/ai` proxy — vercel.json, lib/ai-proxy.js and the two
 * handlers under api/ai/.
 *
 * Import paths are relative to test/. Nothing here touches the network: the one
 * function that would, `proxy()`, is exercised only along the paths that return
 * before its `fetch`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { proxyContract } from '../src/config.js'
import { classifyLimit, readLimitHeaders, DAILY_WINDOW_MS } from '../src/theme/docpilot/budget.js'
import {
  BODY_LIMIT,
  BURST,
  DAILY,
  KEY_ENV,
  UPSTREAM,
  clientIp,
  forwardHeaders,
  limitResponse,
  proxy,
  readBody,
  sameOrigin,
  sweep,
  take,
  upstreamHeaders,
} from '../lib/ai-proxy.js'

describe('vercel /ai proxy', () => {
  const root = new URL('../', import.meta.url)
  const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8')
  const vercel = JSON.parse(read('vercel.json'))

  /**
   * THE TEST THIS FILE EXISTS FOR.
   *
   * `proxyContract()` asks the ADAPTER for its paths rather than writing them
   * out, because a second copy drifts — the comment above it in src/config.js
   * records the copy that printed `/v1/chat/completions` for Anthropic, whose
   * adapter posts to `/v1/messages`, so an exact-match proxy built to the
   * contract 404s every question in production. vercel.json and the two handlers
   * ARE a second copy. This is what keeps them from drifting: the routes are
   * compared against what the contract returns for this site's own `docPilot`
   * export, not against what anybody remembers them to be.
   */
  describe('routes match proxyContract for this site', () => {
    let contract
    beforeAll(async () => {
      const { docPilot } = await import('../docs/.vitepress/config.mjs')
      contract = proxyContract(docPilot, { [KEY_ENV]: 'test-key' })
    })

    it('rewrites exactly the paths the contract names, and no others', () => {
      const sources = vercel.rewrites.map((r) => r.source).sort()
      const paths = contract.routes.map((r) => r.path).sort()
      expect(sources).toEqual(paths)
    })

    // Contract note 1. `/ai/(.*)` is precisely the prefix match it forbids: it
    // would proxy `/ai/v1/models`, `/ai/v1/generation` and anything else anyone
    // ever adds under that root, on this site's key.
    it('states every route literally, with no wildcard', () => {
      for (const r of vercel.rewrites) {
        expect(/[(*:]/.test(r.source), `${r.source} is not a literal path`).toBe(false)
      }
    })

    it('sends each path to a handler that posts the contract upstream path', () => {
      for (const route of contract.routes) {
        const rewrite = vercel.rewrites.find((r) => r.source === route.path)
        const file = `${rewrite.destination.replace(/^\//, '')}.js`
        expect(fs.existsSync(new URL(file, root)), `${file} does not exist`).toBe(true)
        // The literal in the handler's source, not a value it computed.
        const literal = read(file).match(/proxy\(request,\s*'([^']+)'\)/)?.[1]
        expect(literal, `${file} does not pass a literal upstream path`).toBe(route.rewrite)
      }
    })

    it('posts to the upstream and key the contract names', () => {
      for (const route of contract.routes) {
        expect(UPSTREAM).toBe(route.upstream)
        expect(KEY_ENV).toBe(route.envKey)
        // The contract names the header; the proxy has to send that one.
        expect(Object.keys(upstreamHeaders(new Request('https://d/', { headers: {} }), 'k'))).toContain(route.header)
      }
    })
  })

  const post = (init = {}) =>
    new Request('https://docpilot-nine.vercel.app/api/ai/chat', { method: 'POST', ...init })

  describe('the gates before the fetch', () => {
    it('answers anything but POST with 405 and names the method it takes', async () => {
      const res = await proxy(new Request('https://docpilot-nine.vercel.app/api/ai/chat'), '/v1/chat/completions', {
        [KEY_ENV]: 'k',
      })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    })

    it('refuses a foreign origin with 403', async () => {
      const res = await proxy(post({ headers: { origin: 'https://evil.example' } }), '/v1/chat/completions', {
        [KEY_ENV]: 'k',
      })
      expect(res.status).toBe(403)
    })

    it('names the missing variable rather than reporting an outage', async () => {
      const res = await proxy(post({ headers: { origin: 'https://docpilot-nine.vercel.app' } }), '/v1/chat/completions', {})
      expect(res.status).toBe(503)
      expect((await res.json()).error.message).toContain(KEY_ENV)
    })

    it('accepts this deployment’s own origin, and a request that sent none', () => {
      expect(sameOrigin(post({ headers: { origin: 'https://docpilot-nine.vercel.app' } }))).toBe(true)
      // A browser that omits Origin on a same-origin POST must not 403 every
      // question; the cross-origin case is stopped by the absence of any
      // access-control-allow-* header on the way out.
      expect(sameOrigin(post())).toBe(true)
      expect(sameOrigin(post({ headers: { origin: 'https://evil.example' } }))).toBe(false)
      // A preview deployment is on its own generated hostname and there is no
      // allowlist to extend: the origin is compared to this request's own host.
      expect(
        sameOrigin(
          new Request('https://docpilot-git-x-y.vercel.app/api/ai/chat', {
            method: 'POST',
            headers: { origin: 'https://docpilot-git-x-y.vercel.app' },
          }),
        ),
      ).toBe(true)
    })
  })

  describe('the body ceiling', () => {
    it('accepts a body the size of a real turn', async () => {
      const body = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(40 * 1024) }] })
      const got = await readBody(post({ body }))
      expect(got.tooLarge).toBe(false)
      expect(got.body.byteLength).toBe(Buffer.byteLength(body))
    })

    it('refuses one over the cap', async () => {
      const got = await readBody(post({ body: 'x'.repeat(BODY_LIMIT + 1) }))
      expect(got.tooLarge).toBe(true)
    })

    /**
     * The cap is on BYTES READ, not on what the client claimed. `content-length`
     * is the client's number, so a ceiling that trusts it is a ceiling the
     * client sets.
     */
    it('is measured, not declared', async () => {
      const request = post({ body: 'x'.repeat(BODY_LIMIT + 1) })
      // Rebuild with a lying content-length; undici recomputes its own, so the
      // header is overwritten on a Request it constructs — assert through a
      // hand-rolled stand-in instead.
      const stub = {
        headers: new Headers({ 'content-length': '10' }),
        body: request.body,
      }
      expect((await readBody(stub)).tooLarge).toBe(true)
    })

    it('rejects an honest oversized declaration without reading it', async () => {
      let pulled = false
      const stub = {
        headers: new Headers({ 'content-length': String(BODY_LIMIT + 1) }),
        get body() {
          pulled = true
          return null
        },
      }
      expect((await readBody(stub)).tooLarge).toBe(true)
      expect(pulled).toBe(false)
    })
  })

  describe('the limiter', () => {
    it('spends a fixed window and reports what is left', () => {
      const buckets = new Map()
      const t = 1_000_000
      const first = take(buckets, '1.2.3.4', 3, 60_000, t)
      expect(first).toEqual({ ok: true, limit: 3, remaining: 2, resetAt: t + 60_000 })
      expect(take(buckets, '1.2.3.4', 3, 60_000, t + 1).remaining).toBe(1)
      expect(take(buckets, '1.2.3.4', 3, 60_000, t + 2).remaining).toBe(0)
      const refused = take(buckets, '1.2.3.4', 3, 60_000, t + 3)
      expect(refused.ok).toBe(false)
      // The window is fixed: hammering does not push the reset out.
      expect(refused.resetAt).toBe(t + 60_000)
    })

    it('counts each address separately and reopens the window', () => {
      const buckets = new Map()
      const t = 1_000_000
      take(buckets, 'a', 1, 60_000, t)
      expect(take(buckets, 'b', 1, 60_000, t).ok).toBe(true)
      expect(take(buckets, 'a', 1, 60_000, t + 1).ok).toBe(false)
      expect(take(buckets, 'a', 1, 60_000, t + 60_000).ok).toBe(true)
    })

    it('drops closed windows so a warm instance does not grow forever', () => {
      const buckets = new Map()
      take(buckets, 'a', 1, 60_000, 0)
      take(buckets, 'b', 1, 600_000, 0)
      expect(sweep(buckets, 120_000)).toBe(1)
      expect(buckets.has('b')).toBe(true)
    })

    it('counts against the client, not the edge node in front of it', () => {
      expect(clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 10.0.0.2' }))).toBe('9.9.9.9')
      expect(
        clientIp(new Headers({ 'x-vercel-forwarded-for': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' })),
      ).toBe('9.9.9.9')
      expect(clientIp(new Headers({}))).toBe('unknown')
    })

    // A turn is 1 embedding request plus 2-3 model calls, and the free tier is
    // 50 requests a day for the whole site: the burst window has to clear one
    // question comfortably, and the day has to be a fraction of the account's.
    it('leaves room for a question and keeps one address off the whole day', () => {
      expect(BURST.limit).toBeGreaterThan(4)
      expect(DAILY.limit).toBeLessThan(50)
    })
  })

  /**
   * The 429 body, fed to the code that reads it in production.
   *
   * `classifyLimit()` decides burst-or-day for the whole panel, and `rotatable()`
   * in llm.js stops walking the model pool ONLY on `daily`. A proxy whose 429 is
   * classified wrongly either wastes the pool on a limit no model can escape, or
   * writes a burst limiter's `remaining: 0` into the ledger the panel displays.
   */
  describe('the 429 it writes', () => {
    const evidence = async (res, now) => {
      const limits = readLimitHeaders(res.headers, now)
      return { payload: await res.json(), remaining: limits?.remaining, resetAt: limits?.resetAt }
    }

    it('classifies the daily bucket as daily', async () => {
      const now = 1_700_000_000_000
      const res = limitResponse('daily', { ok: false, limit: DAILY.limit, remaining: 0, resetAt: now + DAILY.windowMs }, now)
      expect(res.status).toBe(429)
      expect(classifyLimit(await evidence(res, now), now)).toBe('daily')
    })

    it('classifies the burst bucket as burst', async () => {
      const now = 1_700_000_000_000
      const res = limitResponse('burst', { ok: false, limit: BURST.limit, remaining: 0, resetAt: now + BURST.windowMs }, now)
      expect(classifyLimit(await evidence(res, now), now)).toBe('burst')
      expect(BURST.windowMs).toBeLessThan(DAILY_WINDOW_MS)
    })

    /**
     * The wording guard. Rule 2 of `classifyLimit` matches
     * /per-day|per day|free-models-per-day|daily/i against the message, so a
     * burst refusal that said "day" anywhere in its sentence would be read as a
     * spent day and stop the pool. Stripped of its headers, the burst body must
     * still not say daily.
     */
    it('does not let the burst wording read as a day', async () => {
      const now = 1_700_000_000_000
      const res = limitResponse('burst', { ok: false, limit: BURST.limit, remaining: 0, resetAt: now + BURST.windowMs }, now)
      expect(classifyLimit({ payload: await res.json() }, now)).toBe('unknown')
    })

    it('publishes the three headers the budget line reads, plus retry-after', async () => {
      const now = 1_700_000_000_000
      const res = limitResponse('burst', { ok: false, limit: 10, remaining: 0, resetAt: now + 30_000 }, now)
      expect(readLimitHeaders(res.headers, now)).toEqual({ limit: 10, remaining: 0, resetAt: now + 30_000 })
      expect(res.headers.get('retry-after')).toBe('30')
    })
  })

  describe('what comes back from upstream', () => {
    it('copies the budget headers and nothing that carries state', () => {
      const out = forwardHeaders(
        new Headers({
          'content-type': 'text/event-stream',
          'x-ratelimit-limit': '50',
          'x-ratelimit-remaining': '43',
          'x-ratelimit-reset': '1700000000000',
          'retry-after': '2',
          'set-cookie': 'session=1',
          'access-control-allow-origin': '*',
          'x-request-id': 'abc',
        }),
      )
      expect(out.get('content-type')).toBe('text/event-stream')
      expect(readLimitHeaders(out, 1_699_999_000_000)).toEqual({
        limit: 50,
        remaining: 43,
        resetAt: 1_700_000_000_000,
      })
      expect(out.get('retry-after')).toBe('2')
      expect(out.get('cache-control')).toBe('no-store')
      expect(out.get('set-cookie')).toBe(null)
      expect(out.get('access-control-allow-origin')).toBe(null)
      expect(out.get('x-request-id')).toBe(null)
    })

    it('sends no client credential upstream', () => {
      const sent = upstreamHeaders(
        post({
          headers: {
            authorization: 'Bearer sk-stolen',
            'x-api-key': 'sk-stolen',
            cookie: 'session=1',
            accept: 'text/event-stream',
          },
        }),
        'sk-real',
      )
      expect(sent.authorization).toBe('Bearer sk-real')
      expect(sent['x-api-key']).toBe(undefined)
      expect(sent.cookie).toBe(undefined)
      expect(sent.accept).toBe('text/event-stream')
    })
  })

  describe('the static half of the deploy', () => {
    it('builds through the script that runs doctor', () => {
      expect(vercel.buildCommand).toContain('scripts/vercel-build.sh')
      const script = read('scripts/vercel-build.sh')
      expect(script).toContain('node bin/docpilot.js doctor')
      // No index step: the index is committed, so the deploy spends none of the
      // day's requests and needs no key.
      expect(script).not.toMatch(/docpilot\.js index/)
    })

    it('installs devDependencies, which the build genuinely needs', () => {
      expect(vercel.installCommand).toBe('npm ci --include=dev')
      expect(vercel.outputDirectory).toBe('docs/.vitepress/dist')
    })

    /**
     * manifest.json is the only unhashed file in the index and it names all the
     * others, so caching it sends a returning reader after shards the last
     * deploy deleted — every one 404s and the panel degrades to "AI answers are
     * off here".
     */
    it('caches every index file but the manifest', () => {
      const rule = (source) => vercel.headers.find((h) => h.source === source)
      expect(rule('/rag/manifest.json').headers[0].value).toBe('no-cache')
      for (const source of ['/rag/chunks-(.*).json', '/rag/df.(.*).json', '/rag/vectors.(.*).bin']) {
        expect(rule(source).headers[0].value).toContain('immutable')
      }
      // No rule may cover the manifest by accident.
      for (const h of vercel.headers) {
        if (h.source === '/rag/manifest.json') continue
        expect(new RegExp(`^${h.source}$`).test('/rag/manifest.json'), `${h.source} also matches the manifest`).toBe(
          false,
        )
      }
    })
  })
})
