/**
 * THE SEAM BETWEEN THE CHAT CHARACTERISATION TESTS AND THE SESSION — CORE-02.
 *
 * `test/chat-characterisation.test.js` pins what the 2.1.1 session does for one
 * reader: the order of its state writes, the requests it makes, the answer it
 * settles on, the conversation it keeps. Phases 6 and 7 move the turn driver and
 * the chat state underneath that behaviour, and this file is how the tests keep
 * asking the same questions while the thing they ask moves.
 *
 * THE RULE (D-14): a test never imports `session.js`. Only this file does. When
 * the chat state is rebuilt, the internals of this file change — which module it
 * calls, which seam it installs the index through — and the scenarios, their
 * assertions and their committed traces do not. A trace diff that appears after
 * that change is therefore a behaviour change, and it is read as one.
 *
 * Two runtimes, one set of members (D-16):
 *   · `browser` — the panel retrieves and calls the model itself. `fetch` is
 *     routed to an in-process stub model and stub embedder.
 *   · `server`  — the panel posts to `/ai/turn`. The POST goes through the REAL
 *     `createDocPilotServer(...).handle(Request)`, not a hand-written SSE stub, and
 *     the server's own outbound model and embedding calls reach the same stubs.
 *
 * NOTHING HERE REACHES A NETWORK. The router throws on any URL it does not route,
 * the throw is also remembered, and `reset()` / `close()` re-throw it — so a
 * request the session swallows as a transport failure still fails the test that
 * caused it. The keys in the environment are placeholders.
 *
 * DETERMINISM. `session.ts` has no clock or id seam, so the harness installs one:
 * `Math.random` is a seeded generator, `Date.now` and `performance.now` advance a
 * fixed step per call, and both storages are in-memory fakes. Ids, conversation
 * ids and the like are shown as placeholders (`<conv:1>`), numbers that depend on
 * a clock (`latencyMs`, `thoughtSeconds`, `startedAt`) are left out.
 *
 * THE TRACE. `trace()` is the ordered list of state writes and requests since the
 * last `reset()`:
 *
 *     turn[0].state: (none) -> retrieving
 *     -> embed POST /v1/embeddings (inputs: 1)
 *     -> model POST /v1/chat/completions (messages: 3, tools: answer)
 *     turn[0].sources: + a#one
 *     turn[0].answer: 33 chars
 *
 * Per-token writes to the answer or the thought are coalesced into one line, on
 * purpose: how many writes a stream takes is batching, Phase 7 will change it,
 * and a trace that recorded it would fail for a reason nobody cares about.
 *
 * `stub.answer(fn)` — `fn({ body, n })` runs for each streamed model request and
 * returns `{ text, citations?, confidence? }` (the `answer` tool's arguments), a
 * `Response` (sent as is), or nothing (the default reply: it cites the first
 * chunk the request names). `stub.failFor(model, { status, headers, body }, times)`
 * fails the next `times` streamed requests for that model; the tool-support probe
 * is not counted. `stub.stall()` makes the next streamed reply send its opening
 * frame and then hang until the request is aborted. `stub.models` is the list of
 * model names the stub serves; any other name is a 404.
 *
 * `createHarness` returns at once (the server half boots in the background and
 * every member that needs it waits), so `await createHarness(...)` and a plain
 * call both work. `reset()` returns the harness to a clean start — session
 * state, both storages, the log, the stub's controls — and leaves it installed;
 * `close()` does that and then uninstalls every global it replaced, removes the
 * server's index directory, and throws if any request went unrouted.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { watch } from 'vue'

import { resolveDocPilot, themeDocPilot } from '../../src/config.js'
import { createDocPilotServer } from '../../src/server/index.js'
import { __setIndex } from '../../src/theme/docpilot/store.js'
import { resetPools } from '../../src/theme/docpilot/llm.js'
import { createHistory } from '../../src/theme/docpilot/history.js'
import * as session from '../../src/theme/docpilot/session.js'
import { assembleFixture, writeFixtureDir, stubVector, FIXTURE_ROWS, OPENER, EMBED_MODEL } from './chat-fixture.js'

const STUB_BASE = 'http://stub.test'
const DOCS_ORIGIN = 'http://docs.test'
const ENDPOINT = '/ai/turn'
// Placeholders, never a real key: T-1-07.
const ENV = { CUSTOM_API_KEY: 'placeholder-key' }

const WALL_START = Date.UTC(2026, 0, 15, 12, 0, 0)
const CLOCK_STEP_MS = 7
const SEED = 20260115

/** mulberry32 — a small seeded generator, enough to make `newId` repeatable. */
const seeded = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const fakeStorage = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

const encoder = new TextEncoder()
const sse = (frames) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(encoder.encode(`data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`))
        c.enqueue(encoder.encode('data: [DONE]\n\n'))
        c.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

const jsonResponse = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** The `answer` tool call, split over frames the way a streaming model sends it. */
const answerFrames = ({ text, citations = [], confidence = 0.9 }) => {
  const args = JSON.stringify({ text, citations, confidence })
  const cut = Math.ceil(args.length / 3)
  const parts = [args.slice(0, cut), args.slice(cut, cut * 2), args.slice(cut * 2)]
  return parts.map((part, i) => ({
    choices: [
      {
        delta: {
          tool_calls: [
            i === 0
              ? { index: 0, id: 'call_answer', type: 'function', function: { name: 'answer', arguments: part } }
              : { index: 0, function: { arguments: part } },
          ],
        },
      },
    ],
  }))
}

/** The first fixture chunk a request names — what a model reading the evidence would cite. */
const firstChunkNamed = (body) => {
  const text = JSON.stringify(body.messages || [])
  let best = null
  for (const r of FIXTURE_ROWS) {
    const at = text.indexOf(r.id)
    if (at >= 0 && (!best || at < best.at)) best = { id: r.id, at }
  }
  return best?.id ?? null
}

const defaultAnswer = (body) => {
  const id = firstChunkNamed(body)
  return { text: 'The documentation covers this [1].', citations: id ? [id] : [], confidence: 0.9 }
}

const VOLATILE_KEYS = new Set(['conversationId', 'messageId', 'sig'])
/** Volatile fields of a request body shown as placeholders, so a wire log is the same on any machine. */
const scrub = (value) => {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, VOLATILE_KEYS.has(k) && v ? `<${k}>` : scrub(v)]))
  }
  return value
}

const toolNames = (body) => (body.tools || []).map((t) => t.function?.name || t.name).filter(Boolean)

const idsOf = (rows) => (rows || []).map((r) => r.id || r.chunkId || r.path || '?')

/**
 * @param {{ runtime?: 'browser' | 'server', mode?: 'hybrid' | 'lexical', config?: object }} [options]
 *   `config` is merged into the `docPilot` object the harness resolves — the chat
 *   chain or models list, budget, guard, quote, history, suggestions — so a
 *   scenario never needs anything but this and `stub`.
 */
export function createHarness({ runtime = 'browser', mode = 'hybrid', config = {} } = {}) {
  const hybrid = mode === 'hybrid'
  const { state } = session

  // ── determinism: the seams session.ts does not have ────────────────────────
  let wall = WALL_START
  let mono = 1000
  const spies = [
    vi.spyOn(Math, 'random').mockImplementation(seeded(SEED)),
    vi.spyOn(Date, 'now').mockImplementation(() => (wall += CLOCK_STEP_MS)),
    vi.spyOn(performance, 'now').mockImplementation(() => (mono += CLOCK_STEP_MS)),
  ]
  const storage = fakeStorage()
  const tabStorage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', tabStorage)

  // ── placeholders for ids ───────────────────────────────────────────────────
  const aliases = new Map()
  const counts = {}
  const alias = (kind, real) => {
    if (!real) return null
    const key = `${kind}:${real}`
    if (!aliases.has(key)) aliases.set(key, `<${kind}:${(counts[kind] = (counts[kind] || 0) + 1)}>`)
    return aliases.get(key)
  }
  const realConversation = (given) => {
    for (const [key, shown] of aliases) if (key.startsWith('conv:') && (shown === given || key === `conv:${given}`)) return key.slice(5)
    return given
  }

  // ── the log ────────────────────────────────────────────────────────────────
  let lines = []
  let wireLog = []
  const unrouted = []

  // ── the stub model and embedder ────────────────────────────────────────────
  const stub = {
    models: ['stub'],
    _answer: null,
    _failures: [],
    _stall: false,
    answer(fn) {
      stub._answer = fn
    },
    failFor(model, { status = 500, headers = {}, body = undefined } = {}, times = 1) {
      stub._failures.push({ model, status, headers, body, left: times })
    },
    stall() {
      stub._stall = true
    },
  }
  let chatCount = 0

  const chat = async (body, init) => {
    const streamed = body.stream !== false
    if (!stub.models.includes(body.model)) {
      return jsonResponse(404, { error: { message: `model ${body.model} not found` } })
    }
    if (!streamed) {
      // The tool-support probe: one non-streamed call asking for a tool.
      return jsonResponse(200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_probe', type: 'function', function: { name: 'list_pages', arguments: '{"prefix":"/"}' } }],
            },
          },
        ],
      })
    }
    const n = ++chatCount
    const failure = stub._failures.find((f) => f.model === body.model && f.left > 0)
    if (failure) {
      failure.left--
      return jsonResponse(failure.status, failure.body ?? { error: { message: 'stub failure' } }, failure.headers)
    }
    if (stub._stall) {
      stub._stall = false
      const signal = init?.signal
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`))
            const fail = () => c.error(new DOMException('The operation was aborted.', 'AbortError'))
            if (signal?.aborted) fail()
            else signal?.addEventListener('abort', fail, { once: true })
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const custom = stub._answer?.({ body, n })
    if (custom instanceof Response) return custom
    return sse(answerFrames(custom || defaultAnswer(body)))
  }

  const embed = (body) => {
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    return jsonResponse(200, { data: inputs.map((t, index) => ({ index, embedding: Array.from(stubVector(t)) })) })
  }

  let dir = null
  let dp = null
  let ready = Promise.resolve()

  // ── the router: every fetch in the process ends here ───────────────────────
  const route = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input?.url || String(input)
    let url
    try {
      url = new URL(href, DOCS_ORIGIN)
    } catch {
      url = null
    }
    const method = (init.method || 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    const log = (to, text, entry) => {
      lines.push(`-> ${to} ${method} ${url.pathname}${text ? ` (${text})` : ''}`)
      wireLog.push({ to, method, path: url.pathname, body: body ? scrub(body) : null, ...entry })
    }

    // Where a model or embedding request lands. Browser-direct, the panel posts
    // to the site's same-origin `/ai` proxy (a hosted target is never named in
    // the page); under the server runtime, the server posts to the target it was
    // configured with. The stub plays the part of whatever is behind each.
    const upstream =
      url?.origin === STUB_BASE ? '' : runtime === 'browser' && url?.origin === DOCS_ORIGIN && url.pathname.startsWith('/ai/') ? '/ai' : null
    if (upstream !== null) {
      const rest = url.pathname.slice(upstream.length)
      if (rest === '/v1/chat/completions') {
        const probe = body.stream === false
        log('model', `${probe ? 'tool probe, ' : ''}messages: ${body.messages?.length ?? 0}, tools: ${toolNames(body).join(', ') || 'none'}`)
        return chat(body, init)
      }
      if (rest === '/v1/embeddings') {
        log('embed', `inputs: ${Array.isArray(body.input) ? body.input.length : 1}`)
        return embed(body)
      }
      if (rest === '/v1/models') return jsonResponse(200, { data: stub.models.map((id) => ({ id })) })
    }
    if (runtime === 'server' && url?.origin === DOCS_ORIGIN && (url.pathname === ENDPOINT || url.pathname.startsWith(`${ENDPOINT}/`))) {
      log('endpoint', '')
      await ready
      return dp.handle(new Request(url, { ...init, signal: init.signal ?? undefined }))
    }
    unrouted.push(href)
    throw new Error(`harness: unexpected fetch ${href}`)
  }
  vi.stubGlobal('fetch', route)

  // ── the server, for the server runtime ─────────────────────────────────────
  // AFTER the router is installed: the server probes the model during boot, and
  // a probe sent before the stub is in place would be a real request.
  if (runtime === 'server') {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-chat-'))
    writeFixtureDir(dir, { vectors: hybrid })
    ready = (async () => {
      dp = await createDocPilotServer({
        settings: {
          chat: { provider: 'custom', model: 'stub', baseURL: STUB_BASE },
          embed: hybrid ? { provider: 'custom', model: EMBED_MODEL, baseURL: STUB_BASE } : false,
          budget: false,
          suggestions: [OPENER],
          ...config,
        },
        env: { CUSTOM_BASE_URL: STUB_BASE, ...ENV },
        index: dir,
        log: null,
      })
      // The server probes the model for tool support at boot, without waiting
      // for a reader. Let that settle so it belongs to the harness's start and
      // never to the first question.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })()
  }


  // ── the index and the history ──────────────────────────────────────────────
  let index = null
  const install = () => {
    if (runtime === 'server') return
    index ??= assembleFixture({ vectors: hybrid })
    __setIndex(Promise.resolve(index))
  }
  let archive = null
  const newArchive = () => {
    archive = createHistory({ local: storage, session: tabStorage, now: () => Date.now() })
    session.__setHistoryForTests(archive)
  }

  const clientConfig = () => {
    const base = runtime === 'server' ? { runtime: 'server', server: { endpoint: ENDPOINT } } : {}
    const own =
      runtime === 'server'
        ? Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'chat' && k !== 'embed'))
        : config
    const target =
      runtime === 'server'
        ? {}
        : {
            chat: { provider: 'custom', model: 'stub', baseURL: STUB_BASE },
            embed: hybrid ? { provider: 'custom', model: EMBED_MODEL, baseURL: STUB_BASE } : false,
          }
    return { ...target, ...base, suggestions: [OPENER], ...own }
  }
  const configure = () => {
    const resolved = resolveDocPilot(clientConfig(), ENV)
    session.configure({ docPilot: themeDocPilot(resolved, ENV) }, '/a', 'en')
  }
  const clearState = () => {
    session.stop()
    Object.assign(state, { index: null, degraded: false, busy: false, turns: [], conversationId: null, status: null, ready: false })
    state.scope = { kind: 'all', paths: [], label: 'All docs' }
  }

  newArchive()
  install()
  configure()
  clearState()

  // ── the state-write trace ──────────────────────────────────────────────────
  /** [key, shown value, kind, default] for everything the trace follows. */
  const flat = () => {
    const out = []
    const add = (key, value, kind = 'value', dflt = '') => out.push([key, value, kind, dflt])
    add('busy', String(state.busy), 'value', 'false')
    add('status', state.status?.phase ?? 'none', 'value', 'none')
    add('degraded', String(state.degraded), 'value', 'false')
    add('conversation', alias('conv', state.conversationId) ?? 'none', 'value', 'none')
    add('history', `${state.history.length} conversation(s)`, 'value', '0 conversation(s)')
    state.turns.forEach((t, i) => {
      const k = `turn[${i}]`
      add(`${k}.state`, t.state, 'value', '')
      if (t.quote) add(`${k}.quote`, JSON.stringify(t.quote))
      if (t.opener) add(`${k}.opener`, `${t.opener.matched}${t.opener.baked ? ' baked' : ''}`)
      add(`${k}.sources`, idsOf(t.sources), 'list', [])
      add(`${k}.results`, idsOf(t.results), 'list', [])
      add(`${k}.citations`, [...(t.citationIds || [])], 'list', [])
      add(`${k}.thought`, `${t.thought?.length || 0} chars`, 'coalesce', '0 chars')
      add(`${k}.answer`, `${t.answerText?.length || 0} chars`, 'coalesce', '0 chars')
      add(`${k}.streaming`, String(!!t.streaming), 'value', 'false')
      if (t.refusal) add(`${k}.refusal`, t.refusal.cause)
      if (t.hybrid) add(`${k}.hybrid`, 'true')
    })
    return out
  }
  let previous = new Map()
  const record = () => {
    const next = new Map()
    for (const [key, shown, kind, dflt] of flat()) {
      next.set(key, { shown, kind })
      const before = previous.get(key)
      if (before?.shown === shown) continue
      if (kind === 'list') {
        const was = before?.shown || []
        for (const id of was) if (!shown.includes(id)) lines.push(`${key}: - ${id}`)
        for (const id of shown) if (!was.includes(id)) lines.push(`${key}: + ${id}`)
      } else if (kind === 'coalesce') {
        if (!before && shown === dflt) continue
        const last = lines.length - 1
        if (before && lines[last]?.startsWith(`${key}: `)) lines[last] = `${key}: ${shown}`
        else lines.push(`${key}: ${shown}`)
      } else {
        if (!before && shown === dflt) continue
        lines.push(`${key}: ${before ? before.shown : '(none)'} -> ${shown}`)
      }
    }
    previous = next
  }
  // A getter that reads only what `flat` reads: the callback fires on every
  // write to any of it, synchronously, and the diff above is the whole trace.
  const stopWatching = watch(() => JSON.stringify(flat()), record, { flush: 'sync' })

  // ── what a test is shown ───────────────────────────────────────────────────
  const normaliseTurn = (t) =>
    t && {
      id: alias('turn', t.id),
      state: t.state,
      question: t.question,
      quote: t.quote,
      answerText: t.answerText,
      sources: (t.sources || []).map((s) => ({ id: s.id, path: s.path, title: s.title })),
      citations: [...(t.citationIds || [])],
      results: idsOf(t.results),
      refusal: t.refusal ? { cause: t.refusal.cause } : null,
      opener: t.opener ? { matched: t.opener.matched, baked: !!t.opener.baked } : null,
      hybrid: !!t.hybrid,
      conversationId: alias('conv', state.conversationId),
    }

  const snapshot = () => ({
    busy: state.busy,
    degraded: state.degraded,
    conversationId: alias('conv', state.conversationId),
    scope: { kind: state.scope.kind, paths: [...state.scope.paths] },
    // A stored row's clock fields and index hash are left out: the first moves with
    // the fake clock, the second with how many fixtures this process has built.
    history: state.history.map(({ createdAt, updatedAt, hash, ...row }) => ({ ...row, id: alias('conv', row.id) })),
    turns: state.turns.map(normaliseTurn),
  })

  const throwIfUnrouted = () => {
    if (unrouted.length) {
      const seen = [...new Set(unrouted)]
      unrouted.length = 0
      throw new Error(`harness: unexpected fetch ${seen.join(', ')}`)
    }
  }

  const reset = () => {
    session.stop()
    clearState()
    storage.clear()
    tabStorage.clear()
    newArchive()
    resetPools()
    install()
    configure()
    lines = []
    wireLog = []
    previous = new Map()
    stub._answer = null
    stub._failures = []
    stub._stall = false
    stub.models = ['stub']
    chatCount = 0
    throwIfUnrouted()
  }

  const close = async () => {
    stopWatching()
    session.stop()
    clearState()
    __setIndex(null)
    resetPools()
    session.__setHistoryForTests(null)
    for (const s of spies) s.mockRestore()
    vi.unstubAllGlobals()
    await ready.catch(() => {})
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    throwIfUnrouted()
  }

  return {
    async ask(question, { quote = '' } = {}) {
      await ready
      await session.submit(question, { quote })
      return normaliseTurn(state.turns[state.turns.length - 1])
    },
    stop: () => session.stop(),
    snapshot,
    trace: () => (lines.length ? `${lines.join('\n')}\n` : ''),
    wire: () => wireLog.map((w) => ({ ...w })),
    /** A page reload: the session forgets everything it held in memory; the history storage stays. */
    reload() {
      session.stop()
      clearState()
      resetPools()
      install()
      configure()
    },
    async restore(conversationId) {
      await ready
      await session.ensureIndex()
      session.openConversation(realConversation(conversationId))
    },
    async setScope(paths) {
      await ready
      await session.ensureIndex()
      session.setScope(paths)
    },
    storage,
    stub,
    reset,
    close,
  }
}
