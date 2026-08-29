import { describe, it, expect } from 'vitest'

import {
  CHAIN,
  DEFAULTS,
  PROVIDER_IDS,
  devProxy,
  proxyContract,
  resolveChain,
  resolveChatChain,
  resolveDocPilot,
  themeDocPilot,
  nodeChatTarget,
  readiness,
} from '../src/config.js'

/**
 * THE PROVIDER CHAIN — `chat.provider: 'auto'`, which is the whole of "install
 * the package, put a key in the environment, done".
 *
 * What is pinned here is a POLICY, and every one of these rules exists because
 * its opposite was the shipped behaviour: the environment could only ever
 * confirm a provider the author had already named, so a project with
 * `OPENAI_API_KEY` set and no `chat` block resolved to a local Ollama and spent
 * every question on a connection refused. The key was read, found, and ignored.
 *
 * Nothing here touches the network, and the absence is the point rather than a
 * convenience: a resolver that reached out to decide what a default means is a
 * build that fails offline and answers differently on two machines.
 */
describe('the provider chain', () => {
  const cfg = (settings, env) => resolveDocPilot(settings, env)

  /**
   * AN EMPTY ENVIRONMENT SELECTS NOTHING, and what it falls through to is the
   * one member whose remaining setup is a single free key.
   *
   * The local Ollama used to close the list and needed nothing to be selected
   * by, so it was where every unconfigured build landed — correct for a laptop
   * running one, a connection refused everywhere else, and indistinguishable
   * from inside a build that makes no network calls. OpenRouter's free tier
   * names no model on either half and needs no card, so the fall-through is one
   * legible instruction instead of a silent outage.
   */
  it('falls through to the free tier when the environment selects nothing', () => {
    const c = cfg({}, {})
    expect(c.chat.provider).toBe('openrouter')
    expect(c.chat.model).toBe(null) // the free pool answers
    expect(resolveChain({}).id).toBe('openrouter')
    expect(resolveChain({}).tried.some((t) => t.found), 'nothing selected').toBe(false)
  })

  /**
   * The local servers are selected by ADDRESS, and the same variable answers
   * "where". Ollama has no credential to be found by and no row in the provider
   * table, so this is hand-wired rather than falling out of `baseUrlEnv`.
   */
  it('selects a local Ollama by its base URL, and goes where it points', () => {
    const local = { OLLAMA_BASE_URL: 'http://localhost:11434' }
    expect(cfg({}, local).chat.provider).toBe('ollama')
    expect(cfg({}, local).chat.model).toBe('qwen3:8b')
    expect(cfg({}, local).chat.baseURL).toBe('http://localhost:11434')

    const remote = { OLLAMA_BASE_URL: 'http://gpu.internal:11434' }
    expect(cfg({}, remote).chat.baseURL).toBe('http://gpu.internal:11434')
    expect(nodeChatTarget(cfg({ embed: false }, remote), remote).baseURL).toBe('http://gpu.internal:11434')

    // It moves an EXPLICIT `provider: 'ollama'` too — a project that pinned the
    // local one still deserves to relocate it without editing code.
    expect(cfg({ chat: { provider: 'ollama' } }, remote).chat.baseURL).toBe('http://gpu.internal:11434')
    // And the author's own value outranks the variable, as everywhere else.
    expect(cfg({ chat: { provider: 'ollama', baseURL: 'http://pinned:1' } }, remote).chat.baseURL).toBe(
      'http://pinned:1',
    )
    // Unset, the standard port stands.
    expect(cfg({ chat: { provider: 'ollama' } }, {}).chat.baseURL).toBe('http://localhost:11434')
  })

  it('takes the provider a single key names, and its model with it', () => {
    const cases = [
      [{ OPENAI_API_KEY: 'k' }, 'openai', 'gpt-4o-mini'],
      [{ GEMINI_API_KEY: 'k' }, 'gemini', 'gemini-2.5-flash'],
      [{ MISTRAL_API_KEY: 'k' }, 'mistral', 'mistral-small-latest'],
      [{ ANTHROPIC_API_KEY: 'k' }, 'anthropic', 'claude-sonnet-4-6'],
      [{ GROQ_API_KEY: 'k' }, 'groq', 'llama-3.3-70b-versatile'],
      [{ DEEPSEEK_API_KEY: 'k' }, 'deepseek', 'deepseek-v4-flash'],
      // The pooled one names nothing on purpose: the free pool is the answer.
      [{ OPENROUTER_API_KEY: 'k' }, 'openrouter', null],
    ]
    for (const [env, provider, model] of cases) {
      const c = cfg({}, env)
      expect(c.chat.provider, JSON.stringify(env)).toBe(provider)
      expect(c.chat.model, JSON.stringify(env)).toBe(model)
    }
  })

  /**
   * ORDER, not presence. Two keys is the common case — a paid provider and a
   * free one kept around — and which of them answers has to be the list's
   * decision rather than the environment's iteration order.
   */
  it('takes the FIRST member the environment carries, not the last', () => {
    expect(cfg({}, { OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: 'b' }).chat.provider).toBe('openai')
    expect(cfg({}, { OPENROUTER_API_KEY: 'b', OPENAI_API_KEY: 'a' }).chat.provider).toBe('openai')
    expect(cfg({}, { GROQ_API_KEY: 'a', MISTRAL_API_KEY: 'b' }).chat.provider).toBe('mistral')
    expect(cfg({}, { CEREBRAS_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }).chat.provider).toBe('anthropic')
  })

  /**
   * The ordering ARGUMENT, asserted rather than left in a comment: one key has
   * to be able to cover both halves. A chat provider with no embeddings endpoint
   * sends `embed: 'auto'` to OpenRouter's free pool, which needs a second key
   * and posts the whole corpus to a third party at build time — a fine thing to
   * choose and a poor thing to be defaulted into.
   */
  it('puts every embedding-capable provider ahead of every chat-only one', () => {
    const chatOnly = ['anthropic', 'groq', 'deepseek', 'xai', 'cerebras']
    const embedding = ['openai', 'gemini', 'mistral', 'together', 'fireworks', 'nebius', 'openrouter']
    const lastEmbedding = Math.max(...embedding.map((id) => CHAIN.indexOf(id)))
    const firstChatOnly = Math.min(...chatOnly.map((id) => CHAIN.indexOf(id)))
    expect(lastEmbedding).toBeLessThan(firstChatOnly)
  })

  /** A local server has no credential, so its ADDRESS is what selects it. */
  it('selects llama.cpp by its base URL and nothing else', () => {
    const c = cfg({}, { LLAMACPP_BASE_URL: 'http://localhost:8080' })
    expect(c.chat.provider).toBe('llamacpp')
    expect(c.chat.model).toBe('local')
    // A key alone does not, because llama-server does not have one to check.
    expect(cfg({}, { LLAMACPP_API_KEY: 'k' }).chat.provider).toBe('openrouter')
  })

  it('lets that address move the upstream the proxy posts to', () => {
    const env = { LLAMACPP_BASE_URL: 'http://gpu.internal:9000' }
    expect(nodeChatTarget(cfg({ embed: false }, env), env).baseURL).toBe('http://gpu.internal:9000')
    const local = { CUSTOM_API_KEY: 'k' }
    expect(nodeChatTarget(cfg({ chat: { provider: 'custom', model: 'm' } }, local), local).baseURL).toBe(
      'http://localhost:8000',
    )
    const moved = { CUSTOM_API_KEY: 'k', CUSTOM_BASE_URL: 'https://gw.example.com' }
    expect(nodeChatTarget(cfg({ chat: { provider: 'custom', model: 'm' } }, moved), moved).baseURL).toBe(
      'https://gw.example.com',
    )
  })

  /**
   * THE AUTHOR ALWAYS WINS. A config file that names a provider is a sentence
   * somebody wrote, and an environment variable set for something else entirely
   * — a sibling service, a CI secret — must not rewrite it.
   */
  it('never overrides a provider the config names', () => {
    const env = { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }
    expect(cfg({ chat: { provider: 'ollama' } }, env).chat.provider).toBe('ollama')
    expect(cfg({ chat: { provider: 'ollama' } }, env).chat.model).toBe('qwen3:8b')
    // Including against the fall-through, which is the case with no key at all.
    expect(cfg({ chat: { provider: 'ollama' } }, {}).chat.provider).toBe('ollama')
    expect(cfg({ chat: { provider: 'openrouter' } }, env).chat.provider).toBe('openrouter')
    // And an explicit model beats the provider's own default.
    expect(cfg({ chat: { model: 'gpt-4.1' } }, env).chat.model).toBe('gpt-4.1')
  })

  /** `providerAuto` is what the startup block and `doctor` branch on. */
  it('records whether the environment chose', () => {
    expect(cfg({}, { OPENAI_API_KEY: 'k' }).chat.providerAuto).toBe(true)
    expect(cfg({ chat: { provider: 'auto' } }, { OPENAI_API_KEY: 'k' }).chat.providerAuto).toBe(true)
    expect(cfg({ chat: { provider: 'openai' } }, { OPENAI_API_KEY: 'k' }).chat.providerAuto).toBe(false)
  })

  /**
   * The resolved half the browser receives carries no trace of any of this: it
   * names an ADAPTER and a same-origin path, and never a brand, a key or how the
   * brand was picked.
   */
  it('leaks nothing about the environment into the client half', () => {
    const env = { OPENAI_API_KEY: 'sk-should-not-appear' }
    const emitted = themeDocPilot(cfg({}, env), env)
    expect(emitted.llm.provider).toBe('openai') // the ADAPTER id, which openai also is
    expect(emitted.llm.baseURL).toBe('/ai')
    expect(JSON.stringify(emitted)).not.toContain('sk-should-not-appear')
    expect(JSON.stringify(emitted)).not.toContain('providerAuto')
  })

  /**
   * Falling through to a local Ollama is a NOTE, not a failure: it is a
   * supported deployment and the shipped one. What it must not be is silent —
   * from inside this process a local Ollama that nobody is running and one that
   * answers are the same configuration.
   */
  it('says so when the chain fell through, and what finishes the install', () => {
    const r = readiness(cfg({}, {}), {})
    const note = r.notes.find((n) => n.includes("chat.provider is 'auto'"))
    expect(note, 'a note naming the fall-through').toBeTruthy()
    expect(note).toContain('openrouter')
    expect(note).toContain('OPENAI_API_KEY')
    expect(note).toContain('OLLAMA_BASE_URL')
    // Silent when a key WAS found, and silent when the provider was named.
    expect(readiness(cfg({}, { OPENAI_API_KEY: 'k' }), { OPENAI_API_KEY: 'k' }).notes.join(' ')).not.toContain(
      "chat.provider is 'auto'",
    )
    expect(readiness(cfg({ chat: { provider: 'ollama' } }, {}), {}).notes.join(' ')).not.toContain(
      "chat.provider is 'auto'",
    )
  })

  /**
   * ONE ENTRY PER PROVIDER. `embed: 'auto'` follows chat wherever chat can
   * embed, so the two halves are usually one service — and a missing key
   * produced the identical sentence twice with the identical fix under each,
   * which the fall-through then made the common case.
   */
  it('reports one missing key for a provider that covers both halves', () => {
    const missing = readiness(cfg({}, {}), {}).missing.filter((m) => m.what.includes('needs a key'))
    expect(missing.length).toBe(1)
    expect(missing[0].what).toContain('chat and embed')
    expect(missing[0].fix).toContain('OPENROUTER_API_KEY')

    // Two providers, two entries — a chat-only provider borrowing the embedder
    // is genuinely two keys, and collapsing that would hide one of them.
    const env = { ANTHROPIC_API_KEY: 'k' }
    const two = readiness(cfg({}, env), env).missing.filter((m) => m.what.includes('needs a key'))
    expect(two.length).toBe(1)
    expect(two[0].what).toContain('embed')
    expect(two[0].what).not.toContain('chat and')
  })

  /** A keyless local server has no key to be missing. */
  it('does not ask for a credential llama.cpp has no use for', () => {
    const env = { LLAMACPP_BASE_URL: 'http://localhost:8080' }
    const missing = readiness(cfg({ embed: false }, env), env).missing.map((m) => m.what)
    expect(missing.join(' ')).not.toContain('needs a key')
  })

  /**
   * THE INVENTORY. A provider added to the table and not to the chain is a
   * provider the environment can never select, which is the silent half of this
   * feature failing; one in the chain and not in the table would resolve to a
   * `hostedOf` of null and be read as a local Ollama.
   */
  it('lists every provider this build knows, exactly once', () => {
    expect([...CHAIN].sort()).toEqual([...PROVIDER_IDS].sort())
    expect(new Set(CHAIN).size).toBe(CHAIN.length)
    // The fall-through is not a list entry — it is where the walk lands when the
    // list matched nothing — but it does have to BE one of them.
    expect(CHAIN).toContain(resolveChain({}).id)
  })

  /**
   * Every member has to produce a CONFIGURATION, not just a name — which means
   * a model, from its own row or from a pool. `custom` is the sole exception and
   * is the reason `assertChat` still exists: it names a host rather than a
   * service, so only the author can say what is loaded on it.
   */
  it('gives every member but the escape hatch something to send', () => {
    const unusable = []
    for (const id of CHAIN) {
      const c = resolveDocPilot({ chat: { provider: id }, embed: false }, {})
      try {
        themeDocPilot(c, {})
      } catch {
        unusable.push(id)
      }
    }
    expect(unusable).toEqual(['custom'])
  })

  /** Deterministic, and the same answer twice for the same environment. */
  it('is a pure function of the environment', () => {
    const env = { GROQ_API_KEY: 'k' }
    expect(resolveChain(env)).toEqual(resolveChain(env))
    expect(resolveChain(env).tried.map((t) => t.id)).toEqual([...CHAIN])
    expect(resolveChain(env).tried.filter((t) => t.found).map((t) => t.id)).toEqual(['groq'])
  })
})

/**
 * `docpilot doctor --models` grew a second question when every provider got its
 * own default model: not only "are the free ids we shipped still served" but
 * "is the name in this table still a name that service knows". `gpt-4o-mini` is
 * a string in a package, not a promise from OpenAI, and it ages the same way a
 * free id does — into a 404 naming a model that appears nowhere in the reader's
 * config.
 *
 * The paths live on the ADAPTERS rather than here, on the same terms as
 * `chatUrl` and `embedUrl`: they are facts about an API shape, and config.js
 * knows brands rather than shapes.
 */
describe('asking a provider what it serves', () => {
  it('reads a model list out of each API shape', async () => {
    const { providerFor } = await import('../src/theme/docpilot/providers.js')

    const openai = providerFor('openai')
    expect(openai.modelsUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/models')
    expect(openai.modelsParse({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1' }] })).toEqual([
      'gpt-4o-mini',
      'gpt-4.1',
    ])

    const anthropic = providerFor('anthropic')
    expect(anthropic.modelsUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/models')
    expect(anthropic.modelsParse({ data: [{ id: 'claude-sonnet-4-6' }] })).toEqual(['claude-sonnet-4-6'])

    /**
     * Ollama lists what has been PULLED, not a catalogue — which is the honest
     * answer for a local server, where "available" means "downloaded", and the
     * reason this is not simply `/v1/models` everywhere.
     */
    const ollama = providerFor('ollama')
    expect(ollama.modelsUrl('http://localhost:11434')).toBe('http://localhost:11434/api/tags')
    expect(ollama.modelsParse({ models: [{ name: 'qwen3:8b' }, { model: 'bge-m3' }] })).toEqual([
      'qwen3:8b',
      'bge-m3',
    ])
  })

  /** A malformed or empty payload is "cannot check", never "retired". */
  it('reads nothing out of a payload it does not recognise', async () => {
    const { providerFor, PROVIDER_IDS } = await import('../src/theme/docpilot/providers.js')
    for (const id of PROVIDER_IDS) {
      const p = providerFor(id)
      expect(p.modelsParse({}), id).toEqual([])
      expect(p.modelsParse({ data: [{}, { id: null }] }), id).toEqual([])
    }
  })
})

/**
 * WHAT A LOCAL SERVER HAS ACTUALLY LOADED — `inspectChatTarget`.
 *
 * The half of `doctor --models` that used to get local providers wrong. It
 * compared the name in the table against a list and said "NOT in the list" — a
 * correct sentence for a hosted catalogue and a wrong one for llama.cpp, whose
 * `chatModel` is the placeholder `'local'` that the server ignores, and an
 * unhelpful one for Ollama, where the fix is `ollama pull` rather than editing
 * a config.
 *
 * NULL IS NOT NO. Every arm here can fail to reach a server, and the shape says
 * so: a server that is off, a server behind a key this machine lacks, and a
 * server that answered and does not have the model are three sentences, and only
 * the last is worth printing at anybody. Nothing this returns may fail a build.
 */
describe('asking a local server what it has loaded', () => {
  const load = async () => (await import('../src/build/lib/chat-preflight.js')).inspectChatTarget

  const serving = (models) => async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/api/tags') ? { models: models.map((m) => ({ name: m })) } : { data: [] }),
  })

  it('says a pulled model is served', async () => {
    const inspect = await load()
    const r = await inspect(
      { id: 'ollama', provider: 'ollama', baseURL: 'http://localhost:11434', model: 'qwen3:8b' },
      { fetchImpl: serving(['qwen3:8b', 'bge-m3']) },
    )
    expect(r.verdict).toBe('served')
    expect(r.serves).toEqual(['qwen3:8b', 'bge-m3'])
  })

  it('says a model that was never pulled is not served, and lists what is', async () => {
    const inspect = await load()
    const r = await inspect(
      { id: 'ollama', provider: 'ollama', baseURL: 'http://localhost:11434', model: 'llama3.1:8b' },
      { fetchImpl: serving(['qwen3:8b']) },
    )
    expect(r.verdict).toBe('not-served')
    expect(r.serves).toEqual(['qwen3:8b'])
  })

  /**
   * llama-server DOES answer `/v1/models` — with the alias it was launched
   * under — so asking whether it serves `'local'` gets a confident and useless
   * no. Only the brand fact knows the question does not apply.
   */
  it('does not judge a placeholder against a catalogue', async () => {
    const inspect = await load()
    const r = await inspect(
      {
        id: 'llamacpp',
        provider: 'llamacpp',
        baseURL: 'http://localhost:8080',
        model: 'local',
        modelPlaceholder: true,
      },
      { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-3.5-turbo' }] }) }) },
    )
    expect(r.verdict).toBe('placeholder')
  })

  /** A server that is off is not a broken configuration — and never a `missing`. */
  it('reports unknown rather than failing when nothing answers', async () => {
    const inspect = await load()
    const dead = async () => {
      throw new Error('ECONNREFUSED')
    }
    const r = await inspect(
      { id: 'ollama', provider: 'ollama', baseURL: 'http://localhost:11434', model: 'qwen3:8b' },
      { fetchImpl: dead },
    )
    expect(r).toEqual({ serves: null, loaded: null, contextLength: null, capabilities: null, verdict: 'unknown' })
  })

  it('asks nothing at all without a baseURL', async () => {
    const inspect = await load()
    let asked = 0
    const r = await inspect(
      { id: 'openai', provider: 'openai', baseURL: null, model: 'gpt-4o-mini' },
      {
        fetchImpl: async () => {
          asked++
          return { ok: true, json: async () => ({}) }
        },
      },
    )
    expect(asked).toBe(0)
    expect(r.verdict).toBe('unknown')
  })
})

/**
 * THE ROTATION SET — `chat.chain`, which is the provider-level form of the
 * argument `chat.models` already makes about models.
 *
 * The rules pinned here are the ones whose opposite would be expensive rather
 * than merely wrong. Two carry the whole feature: a chain never fires where a
 * provider was NAMED, because "a provider you name is never overridden" predates
 * this key and every pinned production deployment relies on it; and a
 * single-member chain emits byte-identically to the configuration that shipped
 * before the key existed, because the alternative is every hand-written reverse
 * proxy in the world breaking on a patch release.
 */
describe('the rotation set', () => {
  const cfg = (settings, env) => resolveDocPilot(settings, env)
  const ids = (settings, env = {}) => resolveChatChain(cfg(settings, env), env).map((m) => m.id)

  /**
   * THE MIGRATION GUARANTEE, and it is a test rather than a promise.
   *
   * `chatProxyBase` adds `/ai/<id>` only where a deployment has more than one
   * answering member. Everything that shipped before this key has exactly one —
   * the default `chain: false`, and every provider an author pinned — so the
   * paths, the rewrites and the upstreams must be the objects this package has
   * always emitted. A prefix that appeared unconditionally would 404 every
   * question on every deployed site, in production, on upgrade.
   */
  it('emits the paths it always did for a single member', () => {
    for (const provider of ['openrouter', 'openai', 'anthropic', 'gemini', 'groq']) {
      const c = cfg({ chat: { provider, model: provider === 'anthropic' ? 'claude-sonnet-4-6' : null } }, {})
      const paths = proxyContract(c, {}).routes.map((r) => r.path)
      expect(paths.every((p) => p.startsWith('/ai/v1/')), `${provider} — ${paths}`).toBe(true)
      expect(themeDocPilot(c, {}).llm.chain[0].baseURL, `${provider} baseURL`).toBe('/ai')
    }
  })

  /**
   * The rewrite is what turns this package's own prefix back into the upstream's
   * path, and it is the one place a chain prefix can be got wrong invisibly: an
   * optional `(\/[a-z0-9-]+)?` group matches `/v1` as readily as `/groq`, which
   * rewrote `/ai/v1/embeddings` to `/embeddings` and 404'd every single-provider
   * deployment. So the assertion is the whole URL, on both shapes.
   */
  it('rewrites to the upstream’s real path, prefixed or not', () => {
    const one = proxyContract(cfg({ chat: { provider: 'gemini' } }, {}), {})
    expect(one.routes.map((r) => r.upstream + r.rewrite)).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai/embeddings',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ])

    /**
     * The embed route is UNPREFIXED and still Gemini's, which is the invariant
     * worth pinning here rather than a detail of the fixture: `embed: 'auto'`
     * follows the HEAD, and adding an answering member — one that cannot embed
     * at all, in this case — must not move the vector space the index was built
     * in. Anthropic also proves the second half: an adapter with its own path
     * gets `/v1/messages` under the prefix, not `/v1/chat/completions`.
     */
    const many = proxyContract(cfg({ chat: { provider: 'gemini', chain: ['anthropic'] } }, {}), {})
    expect(many.routes.map((r) => r.path + ' → ' + r.upstream + r.rewrite)).toEqual([
      '/ai/v1/embeddings → https://generativelanguage.googleapis.com/v1beta/openai/embeddings',
      '/ai/gemini/v1/chat/completions → https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      '/ai/anthropic/v1/messages → https://api.anthropic.com/v1/messages',
    ])
    // Same route, byte for byte, as the single-member build above.
    expect(many.routes[0]).toEqual(one.routes[0])
  })

  /** One chat route per member, one embed route, and the embed one never moves. */
  it('emits one chat route per member and exactly one embed route', () => {
    const c = cfg({ chat: { provider: 'openrouter', chain: ['groq', 'cerebras'] } }, {})
    const { routes } = proxyContract(c, {})
    expect(routes.filter((r) => r.path.endsWith('/embeddings')).map((r) => r.path)).toEqual([
      '/ai/v1/embeddings',
    ])
    expect(routes.filter((r) => !r.path.endsWith('/embeddings')).map((r) => r.provider)).toEqual([
      'openrouter',
      'groq',
      'cerebras',
    ])
    // Still literal, still no wildcard — the contract's own first note.
    for (const r of routes) expect(r.path).not.toMatch(/[*:]/)
  })

  /**
   * `openrouter` and `groq` are BOTH the openai adapter, so both ask for
   * `/ai/v1/chat/completions`. That collision is what forces the prefix, and a
   * regression here is two members silently sharing one route — and, in llm.js,
   * one `POOLS` key, so a cooldown learned about one brand would be applied to
   * the other.
   */
  it('gives two brands on one adapter two addresses', () => {
    const c = cfg({ chat: { provider: 'openrouter', chain: ['groq'] } }, {})
    const chat = proxyContract(c, {}).routes.filter((r) => !r.path.endsWith('/embeddings'))
    expect(new Set(chat.map((r) => r.path)).size).toBe(2)
    expect(new Set(themeDocPilot(c, {}).llm.chain.map((m) => m.baseURL)).size).toBe(2)
  })

  /**
   * A LOCAL member is reported, never removed. Removing one would mean the
   * resolver judged an address reachable, which is a network question, and this
   * file answers none — CI and the laptop beside it must resolve the same config.
   */
  it('reports a member a deployed proxy cannot reach, and keeps it', () => {
    const env = { LLAMACPP_BASE_URL: 'http://localhost:8080' }
    const c = cfg({ chat: { provider: 'openrouter', chain: ['llamacpp', { provider: 'ollama' }] } }, env)
    const contract = proxyContract(c, env)
    expect(contract.routes.find((r) => r.provider === 'llamacpp').local).toBe(true)
    expect(contract.routes.find((r) => r.provider === 'openrouter').local).toBe(false)
    // Ollama has no PROVIDERS row and so no route at all — carried in `direct`
    // rather than dropped, or a three-member chain would print two routes with
    // nothing accounting for the third.
    expect(contract.direct).toEqual([{ provider: 'ollama', baseURL: 'http://localhost:11434' }])
    expect(contract.notes.some((n) => /LOCAL address/.test(n))).toBe(true)
    expect(contract.notes.some((n) => /ollama has no route at all/.test(n))).toBe(true)
    expect(ids({ chat: { provider: 'openrouter', chain: ['llamacpp', { provider: 'ollama' }] } }, env)).toEqual(
      ['openrouter', 'llamacpp', 'ollama'],
    )
  })

  /** devProxy mounts the same set, anchored, one key per member. */
  it('mounts one anchored dev route per member', () => {
    const env = { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'k' }
    const routes = devProxy(cfg({ chat: { provider: 'openrouter', chain: ['groq'] } }, env), env)
    expect(Object.keys(routes)).toEqual([
      '^/ai/v1/embeddings(?:\\?.*)?$',
      '^/ai/openrouter/v1/chat/completions(?:\\?.*)?$',
      '^/ai/groq/v1/chat/completions(?:\\?.*)?$',
    ])
    // The rewrite is BOUND to that member's base: Vite calls it with the path
    // alone, so an unbound one would hand the upstream a path with a brand still
    // on the front of it.
    const groq = routes['^/ai/groq/v1/chat/completions(?:\\?.*)?$']
    expect(groq.rewrite('/ai/groq/v1/chat/completions')).toBe('/v1/chat/completions')
  })

  /**
   * A PROVIDER YOU NAME IS NEVER OVERRIDDEN — the promise that predates this key.
   * `chain: 'auto'` beside a named provider is one member, whatever the
   * environment holds, because the alternative silently changes what every
   * pinned production site does.
   */
  it('does not rotate off a provider the author named', () => {
    const env = { OPENAI_API_KEY: 'k', GROQ_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }
    expect(ids({ chat: { provider: 'groq', chain: 'auto' } }, env)).toEqual(['groq'])
    expect(ids({ chat: { provider: 'groq' } }, env)).toEqual(['groq'])
    // `false` declines rotation without naming one.
    expect(ids({ chat: { chain: false } }, env)).toEqual(['openai'])
  })

  /**
   * The shipped default rotates. An environment with ONE key still resolves to
   * one member, which is the scalar configuration every deployment already had.
   */
  it('ships on, and one key still resolves exactly one member', () => {
    expect(DEFAULTS.chat.chain).toBe('auto')
    expect(ids({}, { OPENAI_API_KEY: 'k' })).toEqual(['openai'])
    expect(ids({}, { OPENAI_API_KEY: 'k', GROQ_API_KEY: 'k' })).toEqual(['openai', 'groq'])
  })

  /**
   * `'auto'` is every member the environment SELECTS, billed accounts first and
   * CHAIN's order preserved inside each tier.
   */
  it('walks every selected member, billed before free', () => {
    const env = { GROQ_API_KEY: 'k', OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }
    const got = ids({ chat: { chain: 'auto' } }, env)
    // OpenRouter sits at CHAIN position 7, ahead of groq — and sinks beneath it
    // here, because its allowance is a 50-a-day tier shared by every reader of
    // the site and groq's is the account's. See `ladderTier`.
    expect(got).toEqual(['openai', 'groq', 'openrouter'])
    // Inside a tier the order is CHAIN's own — embed-capable first — and not the
    // order the environment happened to list them in.
    expect(got.slice(0, 2)).toEqual(CHAIN.filter((id) => ['openai', 'groq'].includes(id)))
  })

  /** A server of your own answers last: it is the one nobody else can reach. */
  it('sinks a self-hosted member beneath every hosted one', () => {
    const env = { OPENROUTER_API_KEY: 'k', OLLAMA_BASE_URL: 'http://localhost:11434', GROQ_API_KEY: 'k' }
    expect(ids({ chat: { chain: 'auto' } }, env)).toEqual(['groq', 'openrouter', 'ollama'])
  })

  /**
   * A MODEL THE AUTHOR NAMED KEEPS ITS PROVIDER BILLED. Sinking OpenRouter here
   * would hand `anthropic/claude-sonnet-4` to groq, which is a 404 for a name
   * nobody typed there — so a named model flattens the tiers and the resolved
   * order is CHAIN's, exactly as it was before the sort existed.
   */
  it('does not sink a free-pool provider the author gave a model', () => {
    const env = { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'k' }
    expect(ids({ chat: { model: 'anthropic/claude-sonnet-4' } }, env)).toEqual(['openrouter', 'groq'])
    // The head is the one that receives it, and it is the one that was named for.
    const chain = resolveChatChain(cfg({ chat: { model: 'anthropic/claude-sonnet-4' } }, env), env)
    expect(chain[0]).toMatchObject({ id: 'openrouter', model: 'anthropic/claude-sonnet-4' })
    // An author's own ordered list says the same thing.
    expect(ids({ chat: { models: ['anthropic/claude-sonnet-4'] } }, env)).toEqual(['openrouter', 'groq'])
    // Nothing named: the free tier sinks.
    expect(ids({}, env)).toEqual(['groq', 'openrouter'])
  })

  /**
   * THE HEAD IS THE FIRST MEMBER, whichever rule chose it. `resolveChat` picks
   * the provider and `resolveChatChain` builds the set, and the two sort by the
   * same function — a head chosen by a different rule is a `chain[0]` that is not
   * the head, which is the property `themeDocPilot` builds the `llm` block on.
   */
  it('resolves the head to the first rung of the ladder', () => {
    const env = { OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }
    // OpenRouter is selected first by CHAIN and is the free tier, so anthropic
    // leads — and `chat.provider` agrees with `chain[0]`.
    const resolved = cfg({}, env)
    expect(resolved.chat.provider).toBe('anthropic')
    expect(ids({}, env)).toEqual(['anthropic', 'openrouter'])
    // Declining rotation restores the single-provider answer, which CHAIN alone
    // has always given.
    expect(cfg({ chat: { chain: false } }, env).chat.provider).toBe('openrouter')
  })

  /**
   * Nothing selected is a real outcome and resolves as it always did: the
   * fall-through, alone.
   */
  it('falls through to one member when the environment selects nothing', () => {
    expect(ids({ chat: { chain: 'auto' } }, {})).toEqual(['openrouter'])
  })

  /** An author's array is honoured verbatim, and a named provider leads it once. */
  it('lets a named provider lead an explicit set, deduped', () => {
    expect(ids({ chat: { provider: 'openai', chain: ['groq', 'openai'] } }, {})).toEqual(['openai', 'groq'])
    expect(ids({ chat: { chain: ['groq', 'cerebras'] } }, { OPENAI_API_KEY: 'k' })).toEqual(['groq', 'cerebras'])
  })

  /** An object entry carries what to send that member. */
  it('carries a member’s own model, pool and address', () => {
    const chain = resolveChatChain(
      cfg(
        {
          chat: {
            provider: 'openrouter',
            chain: [
              { provider: 'groq', model: 'a/b' },
              { provider: 'cerebras', models: ['x', 'y'] },
              { provider: 'ollama', baseURL: 'http://gpu.internal:11434' },
            ],
          },
        },
        {},
      ),
      {},
    )
    expect(chain.map((m) => [m.id, m.model, m.models?.length ?? 0])).toEqual([
      ['openrouter', null, 10],
      ['groq', 'a/b', 0],
      ['cerebras', 'llama-3.3-70b', 2],
      ['ollama', 'qwen3:8b', 0],
    ])
    expect(chain[3].baseURL).toBe('http://gpu.internal:11434')
  })

  /**
   * A MODEL NAME NEVER CROSSES PROVIDERS. `gpt-4o-mini` posted to Groq is a 404
   * for a model nobody typed, so `chat.model` and `chat.models` reach the head
   * and every later member falls to its own table default.
   */
  it('gives chat.model and chat.models to the head and to nobody else', () => {
    const chain = resolveChatChain(
      cfg({ chat: { provider: 'openai', model: 'gpt-4.1', models: ['gpt-4o'], chain: ['groq'] } }, {}),
      {},
    )
    expect(chain[0]).toMatchObject({ id: 'openai', model: 'gpt-4.1', models: ['gpt-4o'] })
    expect(chain[1]).toMatchObject({ id: 'groq', model: 'llama-3.3-70b-versatile', models: null })
  })

  /**
   * A member with nothing to send: refused when an AUTHOR wrote it, dropped with
   * a note when the ENVIRONMENT produced it. A stray `CUSTOM_BASE_URL` set for
   * something else must not be able to fail somebody's docs build.
   */
  it('refuses a written member with no model, and skips an environment’s', () => {
    expect(() => themeDocPilot(cfg({ chat: { provider: 'openrouter', chain: [{ provider: 'custom' }] } }, {}), {}))
      .toThrow(/chat\.chain names "custom"/)
    expect(() =>
      themeDocPilot(cfg({ chat: { provider: 'openrouter', chain: [{ provider: 'custom', model: 'a/b' }] } }, {}), {}),
    ).not.toThrow()

    const env = { OPENAI_API_KEY: 'k', CUSTOM_BASE_URL: 'http://localhost:8000' }
    expect(ids({ chat: { chain: 'auto' } }, env)).toEqual(['openai'])
    expect(readiness(cfg({ chat: { chain: 'auto' } }, env), env).notes.some((n) => /skipped custom/.test(n))).toBe(true)
  })

  /** A typo is reported as a typo, before anything asks what it can send. */
  it('names an id it does not know', () => {
    expect(() => themeDocPilot(cfg({ chat: { provider: 'openrouter', chain: ['grok'] } }, {}), {})).toThrow(
      /"grok" is not a provider/,
    )
  })

  /**
   * `chain[0]` IS the head the browser already receives — so every key that was
   * a scalar is still a scalar and nothing reading `config.llm.model` changes.
   */
  it('leads with the head the client half already carried', () => {
    for (const settings of [{}, { chat: { provider: 'openrouter' } }, { chat: { provider: 'groq' } }]) {
      const emitted = themeDocPilot(cfg(settings, {}), {}).llm
      expect(emitted.chain[0]).toMatchObject({
        provider: emitted.provider,
        baseURL: emitted.baseURL,
        model: emitted.model,
        models: emitted.models,
        extraBody: emitted.extraBody,
        rateLimited: emitted.rateLimited,
      })
      expect(emitted.chain[0].tuning).toEqual(emitted.tuning)
    }
  })

  /** Each member is clamped to its OWN vocabulary, not to the head's. */
  it('clamps every member to the knobs its own service accepts', () => {
    const chain = themeDocPilot(
      cfg({ chat: { provider: 'openrouter', topP: 0.9, chain: [{ provider: 'anthropic' }] } }, {}),
      {},
    ).llm.chain
    expect(chain[0].tuning.topP).toBe(0.9)
    // Anthropic's API rejects sampling parameters outright, so the member that
    // cannot spell it receives a record without it rather than a 400.
    expect(chain[1].tuning.topP).toBe(null)
  })

  /** No key crosses into the page, whatever the chain contains. */
  it('leaks no credential into the client half, however many members', () => {
    const env = { OPENAI_API_KEY: 'sk-nope', GROQ_API_KEY: 'gsk-nope', ANTHROPIC_API_KEY: 'ant-nope' }
    const emitted = themeDocPilot(cfg({ chat: { chain: 'auto' } }, env), env)
    expect(emitted.llm.chain.length).toBe(3)
    expect(JSON.stringify(emitted)).not.toContain('nope')
  })

  /** Pure: same environment in, same set out, and no network on any path. */
  it('is a pure function of the settings and the environment', () => {
    const env = { GROQ_API_KEY: 'k', OPENAI_API_KEY: 'k' }
    const once = resolveChatChain(cfg({ chat: { chain: 'auto' } }, env), env)
    const twice = resolveChatChain(cfg({ chat: { chain: 'auto' } }, env), env)
    expect(once).toEqual(twice)
    expect(resolveChatChain(cfg({ chat: { chain: 'auto' } }, {}), {})).not.toEqual(once)
  })

  /**
   * THE ONE THAT COSTS MONEY QUIETLY. Rationing is gated on an allowance it can
   * defend, and a chain that mixes a free tier with a metered account has more
   * than one — so the rules switch off, and the build is where that gets said.
   */
  it('says so when a mixed chain turns rationing off', () => {
    const env = {}
    const mixed = cfg({ chat: { provider: 'openrouter', chain: ['openai'] } }, env)
    expect(readiness(mixed, env).notes.some((n) => /per-day rationing is OFF/.test(n))).toBe(true)

    // A local server is neither free-tier-metered nor billed, so a chain of
    // openrouter plus an Ollama is not a mixed one and must not say it is.
    const local = cfg({ chat: { provider: 'openrouter', chain: [{ provider: 'ollama' }] } }, env)
    expect(readiness(local, env).notes.some((n) => /bills per token/.test(n))).toBe(false)

    // A ceiling the author stated is one allowance, so the rules have something
    // to defend again.
    const stated = cfg({ chat: { provider: 'openrouter', chain: ['openai'] }, budget: { dailyLimit: 1000 } }, env)
    expect(readiness(stated, env).notes.some((n) => /per-day rationing is OFF/.test(n))).toBe(false)
  })
})

/**
 * TWO OF ONE SERVICE, AT TWO ADDRESSES, WITH TWO KEYS.
 *
 * `chat.chain` was keyed by PROVIDER, so this was unsayable: a second
 * `{provider: 'custom'}` was deduped away without a word, its `baseURL` was read
 * by nobody — the emitted base is the proxy path and the proxy's upstream came
 * from `CUSTOM_BASE_URL` — and `keyOf` took the first name in the table and
 * stopped. Three silences, one shape: a configuration that resolves, builds,
 * deploys, and does something other than what it says.
 *
 * A member is identified by a SLUG now. Everything below turns on the two halves
 * of that: it defaults to the provider id, so nothing written before this exists
 * moves; and where an author names one, it is what the route, the pool key and
 * the credential are all keyed by.
 */
describe('a member of one’s own', () => {
  const cfg = (settings, env) => resolveDocPilot(settings, env)
  const TWO = {
    chat: {
      provider: 'openrouter',
      chain: [
        {name: 'gw-eu', provider: 'custom', baseURL: 'https://eu.gw.internal', apiKeyEnv: 'GW_EU_KEY', model: 'm1'},
        {name: 'gw-us', provider: 'custom', baseURL: 'https://us.gw.internal', apiKeyEnv: 'GW_US_KEY', model: 'm2'},
      ],
    },
    embed: false,
  }
  const ENV2 = {OPENROUTER_API_KEY: 'k', GW_EU_KEY: 'a', GW_US_KEY: 'b'}

  it('keeps both, at their own addresses and on their own keys', () => {
    const c = cfg(TWO, ENV2)
    expect(resolveChatChain(c, ENV2).map((m) => m.slug)).toEqual(['openrouter', 'gw-eu', 'gw-us'])
    const routes = proxyContract(c, ENV2).routes
    expect(routes.map((r) => `${r.path} → ${r.upstream}${r.rewrite} [${r.envKey}]`)).toEqual([
      '/ai/openrouter/v1/chat/completions → https://openrouter.ai/api/v1/chat/completions [OPENROUTER_API_KEY]',
      '/ai/gw-eu/v1/chat/completions → https://eu.gw.internal/v1/chat/completions [GW_EU_KEY]',
      '/ai/gw-us/v1/chat/completions → https://us.gw.internal/v1/chat/completions [GW_US_KEY]',
    ])
  })

  /**
   * THREE ADDRESSES IN THE PAGE, and that is the property `llm.js` depends on:
   * `POOLS` and the ladder's cooldown map are keyed `provider|baseURL`, so two
   * members sharing one base would share one cooldown — a blip on the European
   * gateway taking the American one out of the order with it.
   */
  it('gives each of them its own address in the client half', () => {
    const bases = themeDocPilot(cfg(TWO, ENV2), ENV2).llm.chain.map((m) => m.baseURL)
    expect(bases).toEqual(['/ai/openrouter', '/ai/gw-eu', '/ai/gw-us'])
    expect(new Set(bases).size).toBe(3)
  })

  /** The value never crosses; only the NAME of the variable holding it. */
  it('carries the key’s name into the contract and its value nowhere', () => {
    const emitted = themeDocPilot(cfg(TWO, ENV2), ENV2)
    expect(JSON.stringify(emitted)).not.toContain('"a"')
    expect(JSON.stringify(emitted)).not.toContain('GW_EU_KEY')
    expect(proxyContract(cfg(TWO, ENV2), ENV2).routes[1].envKey).toBe('GW_EU_KEY')
  })

  /**
   * A NAMED VARIABLE IS NOT SET, and the contract still names it. The point of
   * the printout is to say which variable the proxy has to read, and "you have
   * not exported it yet" is the deployment it is printed for.
   */
  it('names the variable the author chose even before it is set', () => {
    const env = {OPENROUTER_API_KEY: 'k'}
    expect(proxyContract(cfg(TWO, env), env).routes[1].envKey).toBe('GW_EU_KEY')
  })

  it('mounts one anchored dev route per member', () => {
    expect(Object.keys(devProxy(cfg(TWO, ENV2), ENV2))).toEqual([
      '^/ai/openrouter/v1/chat/completions(?:\\?.*)?$',
      '^/ai/gw-eu/v1/chat/completions(?:\\?.*)?$',
      '^/ai/gw-us/v1/chat/completions(?:\\?.*)?$',
    ])
  })

  /**
   * THE MIGRATION GUARANTEE, restated for the slug. A configuration that names
   * no member is a configuration whose slugs ARE its provider ids, so every path
   * this package has ever emitted is the path it still emits.
   */
  it('changes no path for a chain that names nobody', () => {
    for (const settings of [
      {chat: {provider: 'openai'}, embed: false},
      {chat: {provider: 'openrouter', chain: ['groq']}, embed: false},
      {chat: {provider: 'gemini', chain: ['anthropic']}, embed: false},
    ]) {
      const chain = resolveChatChain(cfg(settings, {}), {})
      expect(chain.map((m) => m.slug)).toEqual(chain.map((m) => m.id))
    }
    expect(proxyContract(cfg({chat: {provider: 'openai'}, embed: false}, {}), {}).routes.map((r) => r.path)).toEqual(
      ['/ai/v1/chat/completions'],
    )
  })

  /**
   * A REPEATED NAME IS REFUSED rather than deduped in silence — the fault this
   * whole shape exists to make sayable, so reaching for the old spelling has to
   * say what the new one is.
   */
  it('refuses two members under one name, and says how to name the second', () => {
    const twice = {chat: {provider: 'openrouter', chain: [{provider: 'custom', model: 'a'}, {provider: 'custom', model: 'b'}]}}
    expect(() => themeDocPilot(cfg(twice, {}), {})).toThrow(/chat\.chain names "custom" twice/)
    expect(() => themeDocPilot(cfg(twice, {}), {})).toThrow(/name: 'custom-eu'/)
    expect(() => themeDocPilot(cfg({chat: {chain: ['groq', 'groq']}}, {}), {})).toThrow(/twice/)
  })

  /** A name is rendered into a URL and matched by an anchored regexp. */
  it('refuses a name that cannot be a path', () => {
    for (const name of ['GW/EU', 'gw eu', '-lead', 'GW-EU']) {
      expect(() => themeDocPilot(cfg({chat: {provider: 'openrouter', chain: [{name, provider: 'custom', model: 'a'}]}}, {}), {}), name).toThrow(
        /cannot be a URL path/,
      )
    }
  })

  /**
   * `baseURL` NAMES A HOST YOU RUN — and it was read by nobody on the two ids
   * that most obviously mean one.
   *
   * `chat.baseURL` beside `custom` or `llamacpp` resolved, built, deployed and
   * posted to the table's constant, while the reference said in as many words
   * that "a value written here outranks all of them". The proxy's upstream came
   * from `upstreamOf`, which reads the table and one env var, and nothing
   * anywhere compared the two.
   */
  it('sends a self-hosted member where its own baseURL says, config over environment', () => {
    const up = (settings, env = {}) => proxyContract(cfg(settings, env), env).routes.map((r) => r.upstream)
    expect(up({chat: {provider: 'custom', model: 'm', baseURL: 'https://mine'}, embed: false}, {CUSTOM_API_KEY: 'k'})).toEqual(
      ['https://mine'],
    )
    expect(
      up({chat: {provider: 'custom', model: 'm', baseURL: 'https://mine'}, embed: false}, {CUSTOM_API_KEY: 'k', CUSTOM_BASE_URL: 'https://env'}),
    ).toEqual(['https://mine'])
    expect(up({chat: {provider: 'llamacpp', baseURL: 'https://gpu'}, embed: false})).toEqual(['https://gpu'])
    // A member's own address, which is the form a chain of several needs.
    expect(
      up({chat: {provider: 'openrouter', chain: [{provider: 'llamacpp', baseURL: 'http://gpu-a:8080'}]}, embed: false}),
    ).toEqual(['https://openrouter.ai/api', 'http://gpu-a:8080'])
    // And the Node-side callers agree with the proxy, which they did not before.
    expect(
      nodeChatTarget(cfg({chat: {provider: 'custom', model: 'm', baseURL: 'https://mine'}, embed: false}, {CUSTOM_API_KEY: 'k'}), {
        CUSTOM_API_KEY: 'k',
      }).baseURL,
    ).toBe('https://mine')
  })

  /**
   * AND IT IS REFUSED BESIDE A SERVICE THAT HAS AN ADDRESS OF ITS OWN.
   *
   * Now that the field is read, "what does it mean beside `openai`" has an
   * answer that is not "nothing". Rerouting a branded provider's traffic on the
   * strength of one line is a surprise nobody asked for; ignoring it is the
   * failure just fixed in the other direction. So it is the third state.
   */
  it('refuses an address beside a provider that is not a host you run', () => {
    expect(() => themeDocPilot(cfg({chat: {provider: 'openai', baseURL: 'https://nope'}, embed: false}, {}), {})).toThrow(
      /chat\.baseURL is set to "https:\/\/nope"/,
    )
    expect(() =>
      themeDocPilot(cfg({chat: {provider: 'openrouter', chain: [{provider: 'openai', baseURL: 'https://nope'}]}, embed: false}, {}), {}),
    ).toThrow(/chat\.chain member "openai" baseURL/)
    // The message names the id that does mean a host of your own.
    expect(() => themeDocPilot(cfg({chat: {provider: 'openai', baseURL: 'https://nope'}, embed: false}, {}), {})).toThrow(
      /provider: 'custom'/,
    )
  })

  /** A named provider still leads an explicit array and is not asked twice. */
  it('leaves the head dedup alone', () => {
    expect(
      resolveChatChain(cfg({chat: {provider: 'openai', chain: ['groq', 'openai']}}, {}), {}).map((m) => m.slug),
    ).toEqual(['openai', 'groq'])
  })
})

/**
 * `chat.preferLocal` — the opt-in half of the decision 0.3.2 made.
 *
 * 0.3.2 stopped an unnamed provider resolving to a local Ollama, and the reason
 * is in `resolveChain`'s own comment: from inside a build a laptop running one
 * and a CI box that has never heard of one are the same environment. That
 * argument is about GUESSING. It says nothing about an author who writes it
 * down, and this key is the difference.
 */
describe('preferring a server of your own', () => {
  const cfg = (settings, env) => resolveDocPilot(settings, env)
  const ids = (settings, env = {}) => resolveChatChain(cfg(settings, env), env).map((m) => m.id)
  const LOCAL = {OLLAMA_BASE_URL: 'http://localhost:11434'}

  it('ships off, so nothing resolves differently until it is written', () => {
    expect(DEFAULTS.chat.preferLocal).toBe(false)
    expect(cfg({}, {}).chat.provider).toBe('openrouter')
    expect(ids({}, {...LOCAL, OPENAI_API_KEY: 'k'})).toEqual(['openai', 'ollama'])
  })

  it('lifts a local server above every hosted one', () => {
    expect(ids({chat: {preferLocal: true}}, {...LOCAL, OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k'})).toEqual([
      'ollama',
      'openai',
      'openrouter',
    ])
  })

  it('falls through to a local Ollama instead of the free tier', () => {
    const c = cfg({chat: {preferLocal: true}}, {})
    expect(c.chat.provider).toBe('ollama')
    expect(c.chat.model).toBe('qwen3:8b')
    expect(c.chat.baseURL).toBe('http://localhost:11434')
    expect(ids({chat: {preferLocal: true}}, {})).toEqual(['ollama'])
  })

  /**
   * IT REORDERS AND NEVER SELECTS, which is what keeps the resolver a pure
   * function of the settings and the environment.
   */
  it('does not conjure a member the environment did not select', () => {
    expect(ids({chat: {preferLocal: true}}, {OPENAI_API_KEY: 'k'})).toEqual(['openai'])
  })

  /** A key that quietly did nothing is the failure this whole area is about. */
  it('says so when it moved nothing', () => {
    const env = {OPENAI_API_KEY: 'k'}
    const said = (settings, e) => readiness(cfg(settings, e), e).notes.some((n) => /preferLocal/.test(n))
    expect(said({chat: {preferLocal: true}}, env)).toBe(true)
    expect(said({chat: {preferLocal: true}}, LOCAL)).toBe(false)
    expect(said({chat: {preferLocal: true}}, {})).toBe(false)
    expect(said({}, env)).toBe(false)
  })

  /** An input to resolution, whose OUTPUT is the chain the browser receives. */
  it('does not cross into the page', () => {
    const emitted = themeDocPilot(cfg({chat: {preferLocal: true}, embed: false}, LOCAL), LOCAL)
    expect(JSON.stringify(emitted)).not.toContain('preferLocal')
  })
})
