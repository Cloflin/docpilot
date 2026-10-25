/**
 * `@cloflin/docpilot/server` — the turn on the owner's server, engine-spec 028.
 *
 * ONE HANDLER, WEB-STANDARD. `handle(Request) → Response` runs unchanged on
 * Node 20+, Bun, Deno, Cloudflare Workers and every edge runtime that copied the
 * Fetch API; `node` adapts it to `node:http`, Express and Connect. Two routes,
 * both under `server.endpoint`:
 *
 *   GET  {endpoint}/manifest   the shell the panel draws its scope picker from
 *   POST {endpoint}            one turn, answered as `text/event-stream`
 *
 * NO CORS, on either route, and that is the same argument `lib/ai-proxy.js`
 * makes: this endpoint spends the owner's model allowance, and a CORS header on
 * it would let any page on the internet spend it. The panel is same-origin by
 * `assertRuntime`; anything else should be in front of this, not inside it.
 *
 * THE INDEX IS READ ONCE, at creation. A rebuilt index is a restart — the same
 * rule a reader's browser follows, where a new hash is a new page load.
 */

import fs from 'node:fs'
import path from 'node:path'

import { assembleIndex } from '../theme/docpilot/store.js'
import { resolveDocPilot, serverTurnConfig } from '../config.js'
import { createTurnLog, type TurnLogOptions } from './log.js'
import { parseTurnInput } from './input.js'
import { runServerTurn } from './turn.js'

export { runServerTurn, sourceChunk } from './turn.js'
export { parseTurnInput } from './input.js'
export { createTurnLog, prune } from './log.js'

export interface DocPilotServerOptions {
  /** The `docPilot` settings — the same object the site's config exports. */
  settings?: Record<string, any>
  /** Where keys and base URLs come from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** The index directory (`docpilot index` output) or an http(s) base URL. */
  index: string
  /** The turn log — engine-spec 028 §3. Null writes nothing. */
  log?: TurnLogOptions | null
  /**
   * Say no before any work: return a Response to refuse, or nothing to allow.
   * The hook for auth and rate limits, which this package does not ship.
   */
  authorize?: ((request: Request) => Response | null | undefined | Promise<Response | null | undefined>) | null
}

/** Read an index directory into the object `createRetrieval` takes. */
export function readIndexDir(dir) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
  const manifest = read('manifest.json')
  const shards = manifest.shards.map(read)
  let vectorBuffer = null
  if (manifest.vectors !== null) {
    const buf = fs.readFileSync(path.join(dir, manifest.vectors))
    vectorBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
  const dfDoc = read(manifest.df)
  let openersDoc = null
  if (manifest.openers) {
    try {
      openersDoc = read(manifest.openers)
    } catch {
      /* a missing bake costs the openers their shortcut, not the server its start */
    }
  }
  return assembleIndex({ manifest, shards, vectorBuffer, dfDoc, openersDoc })
}

async function fetchIndex(base) {
  const root = base.replace(/\/+$/, '')
  const json = async (name) => {
    const res = await fetch(`${root}/${name}`)
    if (!res.ok) throw new Error(`${root}/${name} → ${res.status}`)
    return res.json()
  }
  const manifest = await json('manifest.json')
  const shards = await Promise.all(manifest.shards.map(json))
  const vectorBuffer =
    manifest.vectors === null ? null : await (await fetch(`${root}/${manifest.vectors}`)).arrayBuffer()
  const dfDoc = await json(manifest.df)
  const openersDoc = manifest.openers ? await json(manifest.openers).catch(() => null) : null
  return assembleIndex({ manifest, shards, vectorBuffer, dfDoc, openersDoc })
}

/**
 * The manifest minus everything that is the server's business — engine-spec
 * 028 §2. Pages and sections are what the scope picker and the link checker
 * need, and they are the site's own navigation already. Thresholds, levers,
 * vocabulary and the names of the files that hold the corpus are not.
 */
export function shellManifest(manifest) {
  return {
    version: manifest.version,
    hash: manifest.hash,
    chunkCount: manifest.chunkCount,
    pages: manifest.pages,
    sections: manifest.sections,
    orphanPages: manifest.orphanPages || [],
  }
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  // nginx buffers proxied responses by default, which turns a stream into one
  // late blob. This header is the one switch that reaches it from upstream.
  'x-accel-buffering': 'no',
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export async function createDocPilotServer(options: DocPilotServerOptions) {
  const env = options.env ?? process.env
  const settings = resolveDocPilot({ ...(options.settings || {}), runtime: 'server' }, env)
  const endpoint = settings.server.endpoint.replace(/\/+$/, '')
  const config = serverTurnConfig(settings, env)
  const index = /^https?:\/\//.test(options.index) ? await fetchIndex(options.index) : readIndexDir(options.index)
  const shell = JSON.stringify(shellManifest(index.manifest))
  const log = createTurnLog(options.log)
  const tools = { fallback: false, known: false }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = url.pathname.replace(/\/+$/, '')
    if (route !== endpoint && route !== `${endpoint}/manifest`) return json(404, { error: 'not found' })

    if (options.authorize) {
      const refused = await options.authorize(request)
      if (refused) return refused
    }

    if (route === `${endpoint}/manifest`) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'GET only' })
      return new Response(request.method === 'HEAD' ? null : shell, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', etag: `"${index.manifest.hash}"` },
      })
    }

    if (request.method !== 'POST') return json(405, { error: 'POST only' })
    if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) {
      return json(415, { error: 'content-type must be application/json' })
    }
    let body
    try {
      const text = await request.text()
      if (text.length > 256 * 1024) return json(413, { error: 'body over 256 KB' })
      body = JSON.parse(text)
    } catch {
      return json(400, { error: 'body is not JSON' })
    }
    const parsed = parseTurnInput(body)
    if (!parsed.ok) return json(400, { error: parsed.error })

    const encoder = new TextEncoder()
    const abort = new AbortController()
    request.signal?.addEventListener?.('abort', () => abort.abort(), { once: true })
    let closed = false
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event, data) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch {
            closed = true
          }
        }
        // A comment line, so a proxy that closes idle connections sees bytes
        // while the embedder and the first model step are still thinking.
        const ping = setInterval(() => !closed && controller.enqueue(encoder.encode(': ping\n\n')), 15000)
        try {
          await runServerTurn(parsed.input, {
            index,
            config,
            signal: abort.signal,
            emit,
            record: log ? (r) => log.record(r) : null,
            keepMessages: Boolean(log?.prompts),
            tools,
          })
        } catch (e) {
          if (!abort.signal.aborted) emit('error', { message: 'no model answered', kind: e?.kind || null })
        } finally {
          clearInterval(ping)
          if (!closed) {
            closed = true
            controller.close()
          }
        }
      },
      cancel() {
        closed = true
        abort.abort()
      },
    })
    return new Response(stream, { headers: SSE_HEADERS })
  }

  /**
   * `node:http` / Express / Connect. Answers its two routes and calls `next`
   * (or 404s) for everything else, so it mounts in front of a static server.
   *
   * NOTHING HERE MAY THROW. Callers mount this as `(req, res) => dp.node(req,
   * res)` and drop the promise, so a rejection is an unhandled one and Node
   * stops the process — one `Host: x:99999`, one `TRACE`, or one upload cut off
   * mid-body took the whole site down. Every failure is answered here instead.
   */
  async function node(req, res, next?) {
    const fail = (status) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: status === 400 ? 'bad request' : 'internal error' }))
    }
    // The client's Host is kept as the URL base, so an `authorize` hook that
    // compares Origin with `request.url` keeps working; a Host that does not
    // parse is the client's mistake and gets a 400, not an exception.
    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      return fail(400)
    }
    const route = url.pathname.replace(/\/+$/, '')
    if (route !== endpoint && route !== `${endpoint}/manifest`) {
      if (next) return next()
      res.statusCode = 404
      return res.end()
    }
    // `new Request` throws on TRACE, CONNECT and TRACK, and neither route takes
    // anything but these three anyway.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: 'method not allowed' }))
    }
    try {
      await answer(req, res, url)
    } catch (e) {
      fail(e?.badRequest ? 400 : 500)
    }
  }

  async function answer(req, res, url) {
    const abort = new AbortController()
    res.on('close', () => !res.writableFinished && abort.abort())
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    let request
    try {
      request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          v == null ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]],
        ) as [string, string][],
        body: hasBody ? ((await readBody(req)) as BodyInit) : undefined,
        signal: abort.signal,
      })
    } catch (e) {
      // A body cut off mid-upload, or a header undici will not carry: the
      // client's request, not this server, is what is wrong.
      throw Object.assign(new Error('bad request', { cause: e }), { badRequest: true })
    }
    const response = await handle(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (!response.body) return res.end()
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } catch {
      /* the reader left; `close` above already aborted the turn */
    }
    res.end()
  }

  return { handle, node, endpoint, index, config, manifest: () => JSON.parse(shell) }
}

function readBody(req): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      // Twice the handler's own ceiling, so `handle` is the one that answers 413.
      if (size > 512 * 1024) req.destroy()
      else parts.push(c)
    })
    let ended = false
    req.on('end', () => {
      ended = true
      resolve(new Uint8Array(Buffer.concat(parts)))
    })
    req.on('error', reject)
    // `destroy()` above, or a client gone mid-upload, emits `close` without
    // `end`; unsettled, the promise would hold this request open forever.
    req.on('close', () => !ended && reject(new Error('request closed before its body ended')))
  })
}
