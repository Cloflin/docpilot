import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  resolveDocPilot,
  noChat,
  themeDocPilot,
  readiness,
  proxyContract,
  nodeChatTarget,
  logDocPilot,
} from '../src/config.js'
import { assembleIndex, __setIndex } from '../src/theme/docpilot/store.js'
import { resultRows } from '../src/theme/docpilot/results.js'
import * as session from '../src/theme/docpilot/session.js'

/**
 * `chat: false` — a deployment with no model at all.
 *
 * The mode is the other half of `embed: false`, and this file is its sibling.
 * There the corpus could not be sent to an embedding service; here the READER's
 * question is never sent anywhere, because nothing writes prose about the
 * passages — the ranked passages are the answer, each one a verbatim excerpt
 * under a link into the docs.
 *
 * NOTHING HERE MOCKS A NETWORK, and that is the load-bearing assertion rather
 * than a convenience. A turn runs end to end below with no `fetch` stub, no
 * transport double and no key in the environment: if search-only ever grows a
 * path that reaches for a model, this file stops passing rather than starts
 * calling something. A suite that stubbed a transport could not tell the
 * difference.
 *
 * Paired with `embed: false` it is a deployment holding no provider credential
 * of any kind, which is checked against an EMPTY environment for exactly that
 * reason.
 */

const ENV = {}

describe('chat: false — the configuration', () => {
  it('recognises both spellings, and nothing else', () => {
    expect(noChat({ chat: false })).toBe(true)
    expect(noChat({ chat: 'none' })).toBe(true)
    expect(noChat({ chat: { provider: 'openai' } })).toBe(false)
    expect(noChat({ chat: 'auto' })).toBe(false)
    expect(noChat({})).toBe(false)
  })

  it('resolves the two spellings to the identical object', () => {
    const a = resolveDocPilot({ chat: false }, ENV).chat
    const b = resolveDocPilot({ chat: 'none' }, ENV).chat
    expect(a).toEqual(b)
    expect(a.searchOnly).toBe(true)
    expect(a.provider).toBe(null)
  })

  /**
   * The defect this guard exists for, pinned from the outside.
   *
   * `resolveChat` opens with `{...DEFAULTS.chat, ...chat}`, and spreading `false`
   * yields the defaults — so without a union guard AHEAD of the resolver,
   * `chat: false` resolved to the shipped provider, walked the environment for a
   * key, and handed the author back the exact configuration they wrote one word
   * to switch off. Same shape, same reason, as the `budget: false` guard.
   */
  it('does not spread to the shipped provider', () => {
    const off = resolveDocPilot({ chat: false }, { OPENAI_API_KEY: 'sk-test' }).chat
    expect(off.provider).toBe(null)
    expect(off.model).toBe(null)
    expect(off.providerAuto).toBe(false)
    // The control: the same environment, with the half left alone, DOES select.
    expect(resolveDocPilot({}, { OPENAI_API_KEY: 'sk-test' }).chat.provider).toBe('openai')
  })

  /**
   * Every key stated, because this object is JSON round-tripped into themeConfig
   * and `JSON.stringify` deletes an undefined one — after which session.js fills
   * the hole from its own defaults, which name a live Ollama.
   */
  it('states every key explicitly, so the round trip loses nothing', () => {
    const chat = resolveDocPilot({ chat: false }, ENV).chat
    const back = JSON.parse(JSON.stringify(chat))
    expect(Object.keys(back).sort()).toEqual(Object.keys(chat).sort())
    for (const [k, v] of Object.entries(chat)) expect(back[k], k).toEqual(v)
  })

  it('passes the provider assertions with no chat provider anywhere', () => {
    // `themeDocPilot` calls `assertProviders` first, so reaching a payload at all
    // is the assertion. Both halves off is the case with nothing to assert.
    expect(() => themeDocPilot(resolveDocPilot({ chat: false, embed: false }, ENV), ENV)).not.toThrow()
    // And with an embedder still named, the embed half is asserted as usual.
    expect(() =>
      themeDocPilot(
        resolveDocPilot({ chat: false, embed: { provider: 'openai', model: 'text-embedding-3-small' } }, ENV),
        ENV,
      ),
    ).not.toThrow()
  })

  it('emits searchOnly and a fully-nulled llm block to the browser', () => {
    const payload = themeDocPilot(resolveDocPilot({ chat: false, embed: false }, ENV), ENV)
    expect(payload.searchOnly).toBe(true)
    // NOT `llm: null` — session.js and its callers dereference `config.llm.*`,
    // and every model-call path is short-circuited long before the value is read.
    expect(payload.llm).toBeTruthy()
    expect(payload.llm.provider).toBe(null)
    expect(payload.llm.model).toBe(null)
    expect(payload.llm.chain).toEqual([])
    // `targetOf` reads an unrecognised provider as the local Ollama, which is
    // what this branch exists to avoid: a plausible-looking transport is worse
    // than none, because nothing downstream would stop session.js using it.
    expect(payload.llm.baseURL).toBe(null)
  })

  it('leaves an answering configuration untouched', () => {
    const payload = themeDocPilot(
      resolveDocPilot({ chat: { provider: 'openai', model: 'gpt-4o-mini' } }, ENV),
      ENV,
    )
    expect(payload.searchOnly).toBe(false)
    expect(payload.llm.model).toBe('gpt-4o-mini')
    expect(payload.llm.chain.length).toBeGreaterThan(0)
  })
})

describe('readiness — what search-only is owed, and what it is not', () => {
  it('demands no key at all when neither half calls a service', () => {
    const r = readiness(resolveDocPilot({ chat: false, embed: false }, ENV), ENV)
    // An EMPTY environment. The whole claim of the mode is that this deployment
    // has nothing to sign a request with, so anything in `missing` here is a
    // credential being demanded for a request that is never made.
    expect(r.missing.filter((m) => /needs a key/.test(m.what))).toEqual([])
  })

  it('still demands the embedding key when an embedder is named', () => {
    // The control, and the reason the case above is not simply "readiness went
    // quiet": switching the chat half off says nothing about the other one.
    const r = readiness(resolveDocPilot({ chat: false }, ENV), ENV)
    expect(r.missing.some((m) => /needs a key/.test(m.what))).toBe(true)
  })

  it('says the mode out loud, and says what it still sends', () => {
    const quiet = readiness(resolveDocPilot({ chat: false, embed: false }, ENV), ENV)
    expect(quiet.notes.some((n) => /no outbound request after the page loads/.test(n))).toBe(true)

    /**
     * The half that costs something. With `embed: 'auto'` the corpus is still
     * posted to an embedding service at BUILD time, and the existing `borrowed`
     * note cannot say so — it records which CHAT provider had no embeddings
     * endpoint, and here there is no chat provider to name. A deployment that
     * switched the model off to stop sending anything anywhere would otherwise
     * find this out from an audit rather than from the build.
     */
    const embedding = readiness(resolveDocPilot({ chat: false }, ENV), ENV)
    expect(embedding.notes.some((n) => /embedded at BUILD time/.test(n))).toBe(true)
  })

  it('asks for no chat route in the proxy contract', () => {
    const contract = proxyContract(resolveDocPilot({ chat: false, embed: false }, ENV), ENV)
    const all = [...contract.routes, ...contract.direct]
    expect(all).toEqual([])
    // With an embedder named there IS one route, and it is the embed one — the
    // control that keeps the case above from passing on an empty contract.
    const hybrid = proxyContract(
      resolveDocPilot({ chat: false, embed: { provider: 'openai', model: 'text-embedding-3-small' } }, ENV),
      ENV,
    )
    expect(hybrid.routes.map((r) => r.provider)).toEqual(['openai'])
  })

  /**
   * The CLI's half of "no plausible transport".
   *
   * `nodeChatTarget` falls through to the local Ollama for any provider it does
   * not recognise, so without its own exit a search-only config handed every
   * Node caller a working-looking address at localhost:11434. `doctor` reaches
   * for it, and so does `docpilot import`.
   */
  it('gives Node callers no chat target to reach for', () => {
    const t = nodeChatTarget(resolveDocPilot({ chat: false, embed: false }, ENV), ENV)
    expect(t.searchOnly).toBe(true)
    expect(t.baseURL).toBe(null)
    expect(t.provider).toBe(null)
    expect(t.model).toBe(null)
    expect(t.apiKey).toBe(null)
  })

  it('names the mode in the build log instead of describing a provider', () => {
    const lines = []
    const log = console.log
    console.log = (...a) => lines.push(a.join(' '))
    try {
      const d = resolveDocPilot({ chat: false, embed: false }, ENV)
      logDocPilot(d, ENV, readiness(d, ENV))
    } finally {
      console.log = log
    }
    const chat = lines.find((l) => /^\[docpilot\] chat/.test(l))
    expect(chat).toMatch(/search-only/)
    // `describe` would print a route and a key check for a half that has neither.
    expect(chat).not.toMatch(/11434/)
  })
})

/**
 * `resultRows` — a chunk as the reader sees it, rather than as the model does.
 */
describe('resultRows', () => {
  const index = {
    manifest: {
      pages: [
        { path: '/guide', title: 'Getting started', tail: 'Guide' },
        { path: '/imported', title: 'Upstream', tail: 'Guide', origin: 'https://example.com/up' },
      ],
    },
  }

  const chunk = (over = {}) => ({
    id: 'guide#auth',
    path: '/guide',
    anchor: 'auth',
    title: 'Authentication',
    text: 'Getting started — Authentication\nSet the token in your config file before the first run.',
    ...over,
  })

  it('links to the anchor, and never to the id', () => {
    // A continuation part's id carries `~N`, which is a namespace for telling two
    // chunks of one heading apart and is NOT in the document. Every part shares
    // the one anchor that is.
    const [row] = resultRows([chunk({ id: 'guide#auth~2' })], { index })
    expect(row.href).toBe('/guide#auth')
    expect(row.href).not.toContain('~')
  })

  it('drops the context line the row already says', () => {
    const [row] = resultRows([chunk()], { index })
    // Every chunk opens with `${breadcrumb} — ${heading}`, which is exactly what
    // the title and breadcrumb above the snippet print.
    expect(row.snippet).not.toContain('Getting started — Authentication')
    expect(row.snippet).toContain('Set the token')
    expect(row.title).toBe('Authentication')
    expect(row.breadcrumb).toBe('Guide · Getting started')
  })

  it('keeps a one-line chunk rather than emptying it', () => {
    const [row] = resultRows([chunk({ text: 'Just the one line.' })], { index })
    expect(row.snippet).toBe('Just the one line.')
  })

  it('offers an imported page as the original it came from', () => {
    const [row] = resultRows([chunk({ path: '/imported', anchor: 'x' })], { index })
    expect(row.href).toBe('https://example.com/up#x')
    expect(row.origin).toBe('https://example.com/up')
  })

  it('marks a snippet it had to cut', () => {
    const long = `Head — H\n${'word '.repeat(200)}`
    const [row] = resultRows([chunk({ text: long })], { index })
    expect(row.truncated).toBe(true)
    expect(row.snippet.length).toBeLessThan(300)
  })

  it('survives a page the corpus no longer has', () => {
    const [row] = resultRows([chunk({ path: '/gone' })], { index })
    expect(row.title).toBe('Authentication')
    expect(row.breadcrumb).toBe('')
    expect(row.href).toBe('/gone#auth')
  })
})

/**
 * A whole turn, with nothing stubbed but the index.
 */
describe('a search-only turn, end to end', () => {
  const ROWS = [
    {
      id: 'a#one',
      path: '/a',
      anchor: 'one',
      title: 'Alpha',
      breadcrumb: 'Docs',
      kind: 'guide',
      text: 'Docs — Alpha\nThe alpha widget is configured with a manifest and a token.',
      prev: null,
      next: null,
    },
    {
      id: 'b#one',
      path: '/b',
      anchor: 'one',
      title: 'Beta',
      breadcrumb: 'Docs',
      kind: 'reference',
      text: 'Docs — Beta\nThe beta gizmo installs from the registry and needs no token.',
      prev: null,
      next: null,
    },
    {
      id: 'c#one',
      path: '/c',
      anchor: 'one',
      title: 'Gamma',
      breadcrumb: 'Docs',
      kind: 'guide',
      text: 'Docs — Gamma\nGamma covers billing plans, invoices and refunds.',
      prev: null,
      next: null,
    },
  ]

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

  let fixtureCount = 0
  const install = () => {
    // A distinct hash per fixture: `miniSearchFor` memoises its instance on it.
    const hash = `search-only-${++fixtureCount}`
    const index = assembleIndex({
      manifest: {
        version: 3,
        hash,
        embedModel: null,
        dims: 0,
        vectors: null,
        chunkCount: ROWS.length,
        pages: [
          { path: '/a', title: 'Page /a', tail: 'Docs' },
          { path: '/b', title: 'Page /b', tail: 'Docs' },
          { path: '/c', title: 'Page /c', tail: 'Docs' },
        ],
        sections: [],
        guard: GUARD,
      },
      shards: [ROWS.map((r) => ({ ...r }))],
      vectorBuffer: null,
      dfDoc: { df: {} },
    })
    __setIndex(Promise.resolve(index))
    return index
  }

  beforeEach(() => {
    session.configure(
      { docPilot: themeDocPilot(resolveDocPilot({ chat: false, embed: false }, ENV), ENV) },
      '/a',
      'en',
    )
    session.state.turns = []
    session.state.index = null
    install()
  })

  afterEach(() => {
    __setIndex(null)
  })

  const lastTurn = () => session.state.turns[session.state.turns.length - 1]

  /**
   * A scope, applied the way the panel applies one.
   *
   * `state.scope` cannot simply be assigned before the first turn: `ensureIndex`
   * restores the reader's saved scope on the load it performs, and would
   * overwrite it. So the index is loaded first — by a throwaway turn, which is
   * also what a real reader does before narrowing — and `setScope` is the public
   * entry the picker itself calls.
   */
  const scopeTo = async (paths) => {
    await session.submit('warm the index')
    session.setScope(paths)
    session.state.turns = []
  }

  it('answers with passages, and calls nothing', async () => {
    await session.submit('alpha widget token')
    const turn = lastTurn()
    expect(turn.state).toBe('results')
    expect(turn.results.length).toBeGreaterThan(0)
    expect(turn.results[0].href).toBe('/a#one')
    expect(turn.results[0].snippet).toContain('alpha widget')
    // Nothing wrote prose, so nothing claims anything.
    expect(turn.answerText).toBe('')
    expect(turn.sources).toEqual([])
    expect(turn.noStrongMatches).toBe(false)
  })

  /**
   * THE GATE IS AN EMPTY-STATE SIGNAL HERE, NOT A SUPPRESSOR.
   *
   * The refusal contract exists because a model asked to answer from weak
   * evidence writes something plausible and wrong. That argument is about
   * generated text; every row here is a verbatim passage under a link the reader
   * can check in one click. So a failed gate changes the lead copy and hides
   * nothing.
   */
  it('still shows the rows when the gate does not pass, and says so', async () => {
    await session.submit('quarterly hiring headcount forecast')
    const turn = lastTurn()
    expect(turn.state).toBe('results')
    expect(turn.gate.pass).toBe(false)
    expect(turn.noStrongMatches).toBe(true)
  })

  /**
   * The widen affordance, which in this mode depends on the retriever's lexical
   * unscoped check: before it, `wouldPassUnscoped` was computed from dense
   * cosines that a vectorless index does not have, so a scoped search-only turn
   * could never offer to widen.
   */
  it('offers to widen when the answer is outside the scope', async () => {
    await scopeTo(['/b'])
    await session.submit('gamma billing invoices refunds')
    const turn = lastTurn()
    expect(turn.state).toBe('results')
    expect(turn.wouldWiden).toBe(true)

    // The control: a question nothing in the corpus answers gets no widen
    // button, because widening would not change anything.
    await session.submit('kubernetes helm chart rollout')
    expect(lastTurn().wouldWiden).toBe(false)
  })

  it('keeps every row inside the scope', async () => {
    await scopeTo(['/b'])
    await session.submit('gamma billing invoices refunds')
    // GATE 1 holds in this mode too: the rows a reader sees are the rows the
    // scope admits, whatever the corpus has elsewhere.
    for (const r of lastTurn().results) expect(r.path).toBe('/b')
  })

  it('settles a credential question before it retrieves, exactly as before', async () => {
    // The mode changes what an ANSWER is, not what the panel refuses to send.
    await session.submit('why does sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa fail?')
    const turn = lastTurn()
    expect(turn.state).toBe('no-answer')
    expect(turn.refusal.cause).toBe('credential')
    expect(turn.results).toEqual([])
  })
})
