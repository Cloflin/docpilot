import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

import { assembleIndex } from '../src/theme/docpilot/store.js'
import { createRetrieval } from '../src/theme/docpilot/retriever.js'
import { runTurn } from '../src/theme/docpilot/harness.js'
import { BUDGET_DEFAULTS } from '../src/theme/docpilot/switches.js'
import { createHistory, slimTurn } from '../src/theme/docpilot/history.js'
import { resetCaps, resetPools, toolSchemas } from '../src/theme/docpilot/llm.js'
import { TOOLS_DOC, promptDocument, siteToolsDoc, systemText, toolsDocFor } from '../src/theme/docpilot/prompt.js'
import { renderAnswer } from '../src/theme/docpilot/markdown.js'
import {
  checkArgs,
  expandTemplate,
  normaliseTools,
  providerParameters,
  registerTool,
  runTool,
  toolProblems,
  unregisterTools,
  validActions,
} from '../src/theme/docpilot/tools.js'
import { resolveDocPilot, serverTurnConfig, themeDocPilot } from '../src/config.js'
import { sourceChunk } from '../src/server/turn.js'

/**
 * engine-spec 038 and ui-specs/018 — a site's own tools.
 *
 * The transport is stubbed throughout, as it is in free-tier.test.js: what is
 * asserted is what was SENT (the tool list, the schema, the system message) and
 * what was RUN, because those are the two things a site tool changes.
 */

const ENV = { OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }

const PLAN = {
  plan_limits: {
    description: 'Live limits of one plan: requests per day, seats and storage.',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', enum: ['free', 'pro'] } },
      required: ['plan'],
    },
  },
}

const SUPPORT = {
  contact_support: {
    title: 'Contact support',
    description: 'Send the question to the support team when the docs do not answer it.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', description: 'Where support replies' },
        message: { type: 'string', format: 'multiline', description: 'The problem' },
      },
      required: ['email', 'message'],
    },
    confirm: 'form',
    run: { fetch: '/api/support', method: 'POST' },
  },
}

const PRICING = {
  open_pricing: {
    description: 'Open the pricing page for one plan.',
    label: 'Open pricing',
    parameters: { type: 'object', properties: { plan: { type: 'string', enum: ['free', 'pro'] } }, required: ['plan'] },
    confirm: true,
    run: { href: '/pricing?plan={plan}' },
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
  unregisterTools()
  resetPools()
  resetCaps()
})

// ── the definition ───────────────────────────────────────────────────────────

describe('a site tool the build refuses — engine-spec 038 §6', () => {
  const refused = (tools, runtime = 'browser') => toolProblems(tools, { runtime })

  it('accepts null, the shipped value, and a valid set', () => {
    expect(refused(null)).toEqual([])
    expect(refused({ ...PLAN, ...SUPPORT, ...PRICING })).toEqual([])
  })

  it.each([
    ['a built-in name', { search_docs: { description: 'x' } }, /built-in/],
    ['a bad name', { '1st': { description: 'x' } }, /a tool name is/],
    ['no description', { a: {} }, /description is required/],
    ['a nested parameter', { a: { description: 'x', parameters: { type: 'object', properties: { o: { type: 'object' } } } } }, /nested/],
    ['a required key that is no property', { a: { description: 'x', parameters: { type: 'object', properties: {}, required: ['q'] } } }, /not a property/],
    ['an unknown confirm', { a: { description: 'x', confirm: 'yes' } }, /confirm must be/],
    ['two runners', { a: { description: 'x', confirm: true, run: { href: '/a', event: 'b' } } }, /exactly one/],
    ['a write without the reader', { a: { description: 'x', run: { fetch: '/a', method: 'POST' } } }, /without the reader/],
    ['a navigation as a function tool', { a: { description: 'x', run: { href: '/a' } } }, /cannot answer the model/],
    ['a placeholder that is no parameter', { a: { description: 'x', run: { fetch: '/a/{plan}' } } }, /\{plan\}, which is not a parameter/],
  ])('refuses %s', (_, tools, why) => {
    expect(refused(tools).join('\n')).toMatch(why)
  })

  it('refuses more than twelve tools', () => {
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`t${i}`, { description: 'x' }]))
    expect(refused(many).join('\n')).toMatch(/at most 12/)
  })

  it('refuses a function run on a static install and names registerTool, and keeps it on a server', () => {
    const fn = { a: { description: 'x', run: () => 1 } }
    expect(refused(fn).join('\n')).toMatch(/registerTool\('a', handler\)/)
    expect(refused(fn, 'server')).toEqual([])
  })

  it('refuses a relative fetch for a function tool on the server, where there is no page', () => {
    expect(refused({ a: { description: 'x', run: { fetch: '/api' } } }, 'server').join('\n')).toMatch(/absolute URL/)
    // An ACTION runs in the browser on a server install too, so relative is fine there.
    expect(refused({ a: { description: 'x', confirm: true, run: { fetch: '/api', method: 'POST' } } }, 'server')).toEqual([])
  })

  it('stops the build, naming the tool', () => {
    expect(() => themeDocPilot(resolveDocPilot({ chat: { provider: 'openai' }, tools: { a: {} } }), ENV)).toThrow(
      /\[docpilot\] tools\.a\.description is required/,
    )
  })
})

describe('what the page receives', () => {
  it('nothing, without tools — the key is null', () => {
    expect(themeDocPilot(resolveDocPilot({ chat: { provider: 'openai' } }), ENV).tools).toBe(null)
  })

  it('the definitions, normalised and ordered, with no function in them', () => {
    const client = themeDocPilot(resolveDocPilot({ chat: { provider: 'openai' }, tools: { ...PLAN, ...SUPPORT } }), ENV)
    expect(client.tools.map((t) => t.name)).toEqual(['plan_limits', 'contact_support'])
    expect(client.tools[0]).toMatchObject({ title: 'Plan limits', label: 'Plan limits', confirm: false, run: null })
    expect(client.tools[1]).toMatchObject({ title: 'Contact support', confirm: 'form', run: { fetch: '/api/support', method: 'POST' } })
    expect(JSON.parse(JSON.stringify(client.tools))).toEqual(client.tools)
  })

  it('on a server install, the actions only, and not what was written for the model', () => {
    const shell = themeDocPilot(
      resolveDocPilot({ runtime: 'server', chat: { provider: 'openai' }, tools: { ...PLAN, ...SUPPORT } }),
      ENV,
    )
    expect(shell.tools.map((t) => t.name)).toEqual(['contact_support'])
    expect(shell.tools[0].description).toBeUndefined()
  })

  it('the server half keeps a function run, which the browser half could never carry', () => {
    const run = async () => ({ ok: 1 })
    const settings = resolveDocPilot({ runtime: 'server', chat: { provider: 'openai' }, tools: { a: { description: 'x', run } } }, ENV)
    expect(serverTurnConfig(settings, ENV).tools[0].run).toBe(run)
  })
})

// ── the check ────────────────────────────────────────────────────────────────

describe('the check every argument passes', () => {
  const [plan] = normaliseTools(PLAN)
  const [support] = normaliseTools(SUPPORT)

  it('drops what the schema does not name, and reads null as absent', () => {
    expect(checkArgs(plan, { plan: 'pro', extra: 1 })).toEqual({ ok: true, value: { plan: 'pro' }, errors: {} })
    expect(checkArgs(plan, { plan: null }).errors).toEqual({ plan: 'required' })
  })

  it('enforces enum and format, which the provider schema only describes', () => {
    expect(checkArgs(plan, { plan: 'gold' }).ok).toBe(false)
    expect(checkArgs(support, { email: 'not-an-address', message: 'x' }).errors.email).toMatch(/email/)
  })

  it('converts only where nothing is lost', () => {
    const [n] = normaliseTools({ n: { description: 'x', parameters: { type: 'object', properties: { k: { type: 'integer', minimum: 1 } } } } })
    expect(checkArgs(n, { k: '3' }).value).toEqual({ k: 3 })
    expect(checkArgs(n, { k: '3.5' }).ok).toBe(false)
    expect(checkArgs(n, { k: 0 }).ok).toBe(false)
  })

  it('lets a form keep a missing required value for the reader to fill', () => {
    expect(checkArgs(support, { message: 'help' }, { partial: true })).toEqual({ ok: true, value: { message: 'help' }, errors: {} })
  })

  it('URL-encodes every argument into a template', () => {
    expect(expandTemplate('/api/{q}?x={q}', { q: 'a b/c' })).toBe('/api/a%20b%2Fc?x=a%20b%2Fc')
  })
})

// ── what the model is sent ───────────────────────────────────────────────────

describe('what the model is sent', () => {
  const site = { tools: normaliseTools(PLAN), actions: normaliseTools(SUPPORT) }

  it('a site with no tools sends what 2.0.1 sent', () => {
    expect(toolSchemas(['a#one'], null)).toEqual(toolSchemas(['a#one']))
    expect(systemText({ site: null })).toBe(systemText({}))
    expect(systemText({})).not.toMatch(/Site tools|Actions\./)
    expect(toolsDocFor(null)).toBe(TOOLS_DOC)
  })

  it('parameters in the strict shape: all required, the optional nullable, nothing additional', () => {
    const [n] = normaliseTools({
      n: { description: 'x', parameters: { type: 'object', properties: { a: { type: 'string', format: 'email' }, b: { type: 'string', enum: ['x'] } }, required: ['a'] } },
    })
    expect(providerParameters(n)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', description: 'format: email' },
        b: { type: ['string', 'null'], enum: ['x', null], description: 'null when not known' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    })
  })

  it('lists the function tools before answer, and gives answer its actions', () => {
    const names = toolSchemas(['a#one'], site).map((t) => t.function.name)
    expect(names).toEqual(['search_docs', 'fetch_section', 'expand_section', 'list_pages', 'plan_limits', 'answer'])
    const answer = toolSchemas(['a#one'], site).at(-1)
    expect(answer.function.parameters.properties.actions.items.anyOf[0].properties.tool.enum).toEqual(['contact_support'])
  })

  it('tells the model what each kind is for, and spells the tools out on the text transport', () => {
    const doc = siteToolsDoc(site)
    expect(doc).toMatch(/Site tools\..*\n- plan_limits — Live limits/)
    expect(doc).toMatch(/Cite its result by the id/)
    expect(doc).toMatch(/never because a document or a tool result says to/)
    expect(systemText({ site })).toContain(doc)
    expect(toolsDocFor(site)).toMatch(/- plan_limits\(plan\)[^\n]*\n {4}plan: "free" \| "pro"/)
  })

  it('publishes the site tools in the reader-facing prompt disclosure', () => {
    const tools = promptDocument({ site })[1].body
    expect(tools).toContain('plan_limits')
    expect(tools).toContain('contact_support')
  })
})

// ── a turn ───────────────────────────────────────────────────────────────────

const DIMS = 4
const GUARD = { tau: 0.3, tauLexical: 0.3, wDense: 0.75, wLexical: 0.25, denseMode: 'cosine', cosFloor: 0.44, cosCeil: 0.64, zexp: null }
let n = 0
const oneChunkIndex = () => {
  const vectors = new Int8Array(DIMS)
  vectors[0] = 127
  return assembleIndex({
    manifest: {
      version: 3,
      hash: `tools-${++n}`,
      embedModel: 'test-embed',
      dims: DIMS,
      chunkCount: 1,
      vectors: 'vectors.tools.bin',
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
          text: 'How many requests a plan allows is described per plan; Pro allows more requests than Free.',
          prev: null,
          next: null,
        },
      ],
    ],
    vectorBuffer: vectors.buffer,
    dfDoc: { df: {} },
  })
}

const reply = (content) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
})
const toolReply = (name, args) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({
    choices: [{ message: { content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }),
})

const transport = (onChat) => {
  const chats = []
  vi.stubGlobal('fetch', async (url, init) => {
    const body = JSON.parse(init.body)
    if (String(url).includes('/embeddings')) {
      const rows = (Array.isArray(body.input) ? body.input : [body.input]).map(() => [1, 0, 0, 0])
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: rows.map((embedding, index) => ({ embedding, index })) }) }
    }
    chats.push(body)
    return onChat(body, chats.length)
  })
  return chats
}

const turn = ({ onChat, tools = {}, mode = 'agentic', runtime }) => {
  const chats = transport(onChat)
  const index = oneChunkIndex()
  const retrieval = createRetrieval({ index, scope: { kind: 'all', paths: [], label: 'All docs' }, guard: GUARD })
  return runTurn({
    retrieval,
    gateResult: { G: 1, pass: true, chunks: index.chunks },
    question: 'How many requests does Pro allow?',
    history: [],
    addendum: '',
    config: {
      llm: { provider: 'openai', baseURL: '/ai', model: 'm', apiKey: 'k', tuning: { style: 'effort' } },
      maxIterations: 2,
      budget: { ...BUDGET_DEFAULTS, mode },
      tools: Array.isArray(tools) ? tools : normaliseTools(tools, { keepRun: true }),
      ...(runtime ? { runtime } : {}),
    },
    fallback: false,
    queryVec: null,
  }).then((r) => ({ ...r, chats }))
}

const answering = (citations, extra = {}) =>
  toolReply('answer', { text: 'Pro allows 5000 requests a day [1].', citations, confidence: 0.8, ...extra })

describe('a function call, end to end — engine-spec 038 §5', () => {
  it('is offered beside the built-ins, runs, and is cited as the site', async () => {
    const handler = vi.fn(async ({ plan }) => ({ plan, requestsPerDay: 5000 }))
    registerTool('plan_limits', handler)
    const r = await turn({
      tools: PLAN,
      onChat: (body, i) => (i === 1 ? toolReply('plan_limits', { plan: 'pro' }) : answering(['tool:plan_limits:1'])),
    })
    // Offered, and described in the system message.
    expect(r.chats[0].tools.map((t) => t.function.name)).toContain('plan_limits')
    expect(r.chats[0].messages[0].content).toMatch(/Site tools\./)
    // Run once, with the checked arguments and the turn's context.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toEqual({ plan: 'pro' })
    expect(handler.mock.calls[0][1].question).toBe('How many requests does Pro allow?')
    // Its result went back as an observation with a citable id.
    // The openai adapter carries an observation as a user message — llm.ts.
    const observation = r.chats[1].messages.find((m) => m.content.includes('tool:plan_limits:1'))
    expect(observation.content).toContain('5000')
    // And the answer is traceable to it.
    expect(r.citations).toEqual(['tool:plan_limits:1'])
    expect(r.sources[0]).toMatchObject({ kind: 'tool', tool: 'plan_limits', title: 'Plan limits' })
    expect(r.tools).toEqual([{ tool: 'plan_limits', ok: true, ms: expect.any(Number) }])
    // Citable, but not a page: kept out of `emitted`, which the eval and
    // `pagesRead` take for page sections, and handed out beside it.
    expect(r.emitted).not.toContain('tool:plan_limits:1')
    expect(r.toolIds).toEqual(['tool:plan_limits:1'])
  })

  it('checks the arguments before anything runs', async () => {
    const handler = vi.fn(async () => 1)
    registerTool('plan_limits', handler)
    const r = await turn({
      tools: PLAN,
      onChat: (body, i) => (i === 1 ? toolReply('plan_limits', { plan: 'gold' }) : answering(['a#one'])),
    })
    expect(handler).not.toHaveBeenCalled()
    expect(JSON.stringify(r.chats[1].messages)).toMatch(/invalid arguments — plan: not one of free, pro/)
  })

  it('reads a runner that failed as a result the model can recover from', async () => {
    registerTool('plan_limits', async () => {
      throw new Error('upstream down')
    })
    const r = await turn({
      tools: PLAN,
      onChat: (body, i) => (i === 1 ? toolReply('plan_limits', { plan: 'pro' }) : answering(['a#one'])),
    })
    expect(JSON.stringify(r.chats[1].messages)).toMatch(/the tool failed — upstream down/)
    expect(r.tools[0].ok).toBe(false)
    expect(r.text).toContain('5000')
  })

  it('serves a repeated call from the turn, and runs it once', async () => {
    const handler = vi.fn(async () => ({ requestsPerDay: 5000 }))
    registerTool('plan_limits', handler)
    await turn({
      tools: PLAN,
      onChat: (body, i) => (i < 3 ? toolReply('plan_limits', { plan: 'pro' }) : answering(['tool:plan_limits:1'])),
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not offer a function tool nothing here can run', async () => {
    const r = await turn({ tools: PLAN, onChat: () => answering(['a#one']) })
    expect(r.chats[0].tools.map((t) => t.function.name)).not.toContain('plan_limits')
  })

  it('runs a function run on the server half, where the config keeps one', async () => {
    const run = vi.fn(async () => ({ requestsPerDay: 5000 }))
    const r = await turn({
      tools: { plan_limits: { ...PLAN.plan_limits, run } },
      runtime: 'server',
      onChat: (body, i) => (i === 1 ? toolReply('plan_limits', { plan: 'pro' }) : answering(['tool:plan_limits:1'])),
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(sourceChunk(r.sources[0])).toMatchObject({ kind: 'tool', tool: 'plan_limits', title: 'Plan limits' })
  })
})

describe('the answer’s actions — engine-spec 038 §7', () => {
  it('are required in the strict final schema, and only where the site has an action', async () => {
    const plain = await turn({ mode: 'one-shot', onChat: () => reply(JSON.stringify({ text: 't [1]', citations: ['a#one'], confidence: 0.8 })) })
    expect(plain.chats[0].response_format.json_schema.schema.properties.actions).toBeUndefined()

    const offered = await turn({
      mode: 'one-shot',
      tools: SUPPORT,
      onChat: () =>
        reply(JSON.stringify({ text: 't [1]', citations: ['a#one'], confidence: 0.8, actions: [{ tool: 'contact_support', args: { message: 'help' } }] })),
    })
    const schema = offered.chats[0].response_format.json_schema.schema
    expect(schema.required).toContain('actions')
    expect(schema.properties.actions.items.anyOf).toHaveLength(1)
    // A one-shot turn has no search step, so a function tool would not be offered —
    // and the action rides the one call there is.
    expect(offered.actions).toEqual([{ tool: 'contact_support', args: { message: 'help' } }])
  })

  it('keeps only actions the site has, with arguments that pass, once each, three at most', () => {
    const actions = normaliseTools({ ...SUPPORT, ...PRICING })
    expect(
      validActions(
        [
          { tool: 'nope', args: {} },
          { tool: 'open_pricing', args: { plan: 'gold' } },
          { tool: 'open_pricing', args: { plan: 'pro' } },
          { tool: 'open_pricing', args: { plan: 'pro' } },
          { tool: 'contact_support', args: { email: 'bad' } },
          { tool: 'open_pricing', args: { plan: 'free' } },
          { tool: 'contact_support', args: { message: 'second' } },
        ],
        actions,
      ),
    ).toEqual([
      { tool: 'open_pricing', args: { plan: 'pro' } },
      // A form keeps what passed and leaves the rest to the reader.
      { tool: 'contact_support', args: {} },
      { tool: 'open_pricing', args: { plan: 'free' } },
    ])
  })
})

// ── the runners ──────────────────────────────────────────────────────────────

describe('what runs a tool — engine-spec 038 §3', () => {
  it('fetch: a GET with the arguments in the URL, a POST with them in the body', async () => {
    const calls = []
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, text: async () => '{"message":"Sent"}' }
    })
    const [get] = normaliseTools({ g: { description: 'x', parameters: { type: 'object', properties: { plan: { type: 'string' } } }, run: { fetch: '/api/{plan}' } } })
    const [post] = normaliseTools({ p: { description: 'x', confirm: true, run: { fetch: '/api/support', method: 'POST' } } })
    expect(await runTool(get, { plan: 'pro plan' })).toEqual({ message: 'Sent' })
    await runTool(post, { email: 'a@b.co' }, { question: 'q', page: '/a' })
    expect(calls[0].url).toBe('/api/pro%20plan')
    expect(calls[0].init.method).toBe('GET')
    expect(JSON.parse(calls[1].init.body)).toEqual({ tool: 'p', args: { email: 'a@b.co' }, context: { question: 'q', page: '/a' } })
  })

  it('fetch: a status that is not 2xx is a failure', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, text: async () => 'down' }))
    const [get] = normaliseTools({ g: { description: 'x', run: { fetch: '/api' } } })
    await expect(runTool(get, {})).rejects.toThrow('HTTP 503')
  })

  it('a registered handler wins over the config’s run', async () => {
    const [support] = normaliseTools(SUPPORT)
    registerTool('contact_support', async () => 'handled')
    expect(await runTool(support, {})).toBe('handled')
  })

  it('a runner that never answers fails at its timeout', async () => {
    registerTool('slow', () => new Promise(() => {}))
    const [slow] = normaliseTools({ slow: { description: 'x' } })
    await expect(runTool(slow, {}, { timeoutMs: 20 })).rejects.toBeTruthy()
  })
})

// ── the panel ────────────────────────────────────────────────────────────────

describe('the panel — ui-specs/018', () => {
  const fakeStorage = () => {
    const m = new Map()
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
  }

  const start = async (settings) => {
    vi.resetModules()
    const s = await import('../src/theme/docpilot/session.js')
    s.__setHistoryForTests(createHistory({ local: fakeStorage(), session: fakeStorage(), now: () => 1 }))
    s.configure({
      docPilot: themeDocPilot(
        resolveDocPilot({ chat: { provider: 'openai' }, guard: { mode: 'off' }, budget: { mode: 'agentic', probe: 'never' }, ...settings }),
        ENV,
      ),
    })
    s.state.index = oneChunkIndex()
    s.state.degraded = false
    s.state.busy = false
    return s
  }

  it('settles a cited tool result as a row with no link, and an action the reader runs', async () => {
    const s = await start({ tools: { ...PLAN, ...SUPPORT } })
    registerTool('plan_limits', async () => ({ requestsPerDay: 5000 }))
    transport((body, i) =>
      i === 1
        ? toolReply('plan_limits', { plan: 'pro' })
        : answering(['tool:plan_limits:1'], { actions: [{ tool: 'contact_support', args: { message: 'Pro limits' } }] }),
    )
    await s.submit('How many requests does Pro allow?')
    const t = s.state.turns.at(-1)
    expect(t.state).toBe('complete')
    expect(t.sources).toEqual([{ n: 1, id: 'tool:plan_limits:1', href: null, origin: null, title: 'Plan limits', tail: '', kind: 'tool' }])
    expect(t.answerHtml).toMatch(/<span class="docpilot__cite" data-cite="1"/)
    expect(t.actions).toHaveLength(1)
    expect(t.actions[0]).toMatchObject({ tool: 'contact_support', title: 'Contact support', confirm: 'form', state: 'idle', args: { message: 'Pro limits' } })

    // The reader's own value is checked like the model's was: nothing is sent.
    const a = t.actions[0]
    const posts = []
    vi.stubGlobal('fetch', async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => '{"message":"Ticket 42 opened."}' }
    })
    a.values = { email: 'nope', message: 'Pro limits' }
    await s.runAction(t, a)
    expect(a.errors.email).toMatch(/email/)
    expect(posts).toEqual([])

    a.values = { email: 'reader@example.com', message: 'Pro limits' }
    await s.runAction(t, a)
    expect(posts).toEqual([
      {
        url: '/api/support',
        body: {
          tool: 'contact_support',
          args: { email: 'reader@example.com', message: 'Pro limits' },
          context: { question: 'How many requests does Pro allow?', page: '' },
        },
      },
    ])
    expect(a.state).toBe('done')
    expect(a.message).toBe('Ticket 42 opened.')
  })

  it('does not offer an action nothing on the page can run', async () => {
    const s = await start({ tools: { d: { description: 'x', confirm: true } } })
    const chats = transport(() => answering(['a#one'], { actions: [{ tool: 'd', args: {} }] }))
    await s.submit('How many requests does Pro allow?')
    const t = s.state.turns.at(-1)
    expect(t.state).toBe('complete')
    expect(t.actions).toEqual([])
    expect(JSON.stringify(chats[0])).not.toContain('"d"')
  })

  it('takes a hand-written config’s settings map, and archives a tool row as a tool row', async () => {
    vi.resetModules()
    const s = await import('../src/theme/docpilot/session.js')
    s.__setHistoryForTests(createHistory({ local: fakeStorage(), session: fakeStorage(), now: () => 1 }))
    // Never through `themeDocPilot`: `tools` arrives as the map the settings
    // take, the shape a `mountDocPilot({config})` payload carries.
    s.configure({
      docPilot: {
        llm: { provider: 'openai', baseURL: '/ai', model: 'm', apiKey: 'k' },
        guard: { mode: 'off' },
        budget: { mode: 'agentic', probe: 'never' },
        tools: { ...PLAN, ...SUPPORT },
      },
    })
    expect(s.state.config.tools.map((t) => t.name)).toEqual(['plan_limits', 'contact_support'])
    s.state.index = oneChunkIndex()
    s.state.degraded = false
    s.state.busy = false
    registerTool('plan_limits', async () => ({ requestsPerDay: 5000 }))
    transport((body, i) =>
      i === 1
        ? toolReply('plan_limits', { plan: 'pro' })
        : answering(['tool:plan_limits:1'], { actions: [{ tool: 'contact_support', args: { message: 'Pro limits' } }] }),
    )
    await s.submit('How many requests does Pro allow?')
    const t = s.state.turns.at(-1)
    expect(t.state).toBe('complete')
    expect(t.actions).toHaveLength(1)
    expect(slimTurn(t).sources).toEqual([{ n: 1, id: 'tool:plan_limits:1', href: null, origin: null, title: 'Plan limits', tail: '', kind: 'tool' }])
  })

  it('renders a marker for a row with nowhere to go as a number, not a link', () => {
    const { html } = renderAnswer('Five thousand [1].', new Set(), [{ n: 1, href: null, origin: null, title: 'Plan limits' }])
    expect(html).toContain('<span class="docpilot__cite" data-cite="1" aria-label="Source 1: Plan limits">1</span>')
    expect(html).not.toContain('<a')
  })
})
