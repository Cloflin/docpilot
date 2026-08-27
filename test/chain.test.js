import { describe, it, expect } from 'vitest'

import {
  CHAIN,
  PROVIDER_IDS,
  resolveChain,
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
      [{ DEEPSEEK_API_KEY: 'k' }, 'deepseek', 'deepseek-chat'],
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
