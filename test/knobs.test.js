/**
 * The knobs an author can turn, and whether they reach the wire.
 *
 * WHAT THIS SUITE PREVENTS. A setting that is documented, defaulted, resolved,
 * carried across four files — and then dropped in silence by the one function
 * that actually builds the request. Four of the copy points a `chat.*` key has
 * to survive drop what they do not recognise: `targetOf` destructures its
 * argument, `themeDocPilot` names the keys it emits one by one, `nodeChatTarget`
 * lists them, and every adapter's `body()` destructures only what it uses. A key
 * that clears the first three and fails the fourth is a documented setting whose
 * only reachable value is its default, and the author has no way to tell.
 *
 * This is not hypothetical. `chat.maxTokens` was documented, resolved and
 * threaded the whole way down for years while only the anthropic adapter read
 * it, so every OpenAI-compatible provider ran on its own ceiling whatever the
 * site configured — and an answer cut off at that ceiling looked like a model
 * failing rather than a setting nobody was honouring. `chat.extraBody` was the
 * same story on two adapters at once.
 *
 * NO NETWORK. Every request body here is built by calling `body()` directly.
 * That is the point: the question is what DocPilot would post, not what a
 * provider would do with it.
 */
import { describe, it, expect } from 'vitest'
import { providerFor, PROVIDER_IDS } from '../src/theme/docpilot/providers.js'
import { capsOf, nodeChatTarget, resolveDocPilot, resolveTuning, themeDocPilot, PROVIDER_IDS as BRANDS } from '../src/config.js'

const ENV = {}
const cfg = (chat = {}, rest = {}) => resolveDocPilot({ chat, embed: false, ...rest }, ENV)

/** The shape the harness hands every adapter on a default, non-final step. */
const CALL = {
  model: 'm',
  messages: [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'hi' },
  ],
  temperature: 0.2,
  streaming: true,
  maxTokens: 2048,
  numCtx: 8192,
  enableThink: true,
}

const bodyFor = (id, over = {}) => providerFor(id).body({ ...CALL, ...over })

describe('what every adapter does with chat.extraBody', () => {
  /**
   * It reached exactly one adapter of the three. An Ollama or Anthropic site
   * could write `chat.extraBody`, see it validated, see it resolved, see it
   * emitted into the page — and post a body without it.
   */
  it('carries an author’s own fields to every adapter', () => {
    for (const id of PROVIDER_IDS) {
      expect(bodyFor(id, { extraBody: { foo: 1 } }).foo, `${id} dropped extraBody`).toBe(1)
    }
  })

  /**
   * THE RULE THAT MAKES IT SAFE, stated by the openai adapter and now true of
   * all of them: a stray `stream: false` in an author's fragment would turn off
   * streaming for every reader on the site, and a stray `model` would send the
   * request to a model no pool ever chose.
   */
  it('never lets an author’s field overwrite one the adapter owns', () => {
    for (const id of PROVIDER_IDS) {
      const b = bodyFor(id, { extraBody: { stream: false, model: 'HIJACK', messages: [] } })
      expect(b.stream, `${id} let extraBody turn streaming off`).toBe(true)
      expect(b.model, `${id} let extraBody move the model`).toBe('m')
      expect(b.messages.length, `${id} let extraBody empty the conversation`).toBeGreaterThan(0)
    }
  })

  /**
   * Ollama's sampling block is the only nested object in any of these bodies,
   * and it is the one an author reaches for — `top_k` and `repeat_penalty` live
   * nowhere else. A top-level spread would have replaced it wholesale and taken
   * `temperature` and `num_ctx` out of the request with it, which is the
   * `num_ctx` correctness fix being silently undone by the escape hatch.
   */
  it('merges into Ollama’s options rather than replacing them', () => {
    const b = bodyFor('ollama', { extraBody: { options: { top_k: 40 } } })
    expect(b.options).toEqual({ top_k: 40, temperature: 0.2, num_ctx: 8192, num_predict: 2048 })
  })

  it('ignores a non-object where an object was meant', () => {
    for (const id of PROVIDER_IDS) {
      for (const junk of [null, 'nope', 42, ['a']]) {
        expect(() => bodyFor(id, { extraBody: junk }), `${id} threw on ${JSON.stringify(junk)}`).not.toThrow()
      }
    }
  })
})

describe('the shipped defaults post the body they always posted', () => {
  /**
   * The backward-compatibility gate. Every knob added here has to default to a
   * value that changes nothing, and "nothing" is a frozen literal rather than a
   * promise — these four objects were captured from the adapters before any of
   * this work began.
   *
   * EXACTLY ONE FIELD DIFFERS FROM THAT CAPTURE, and it is a fix rather than a
   * regression: `options.num_predict` below is `chat.maxTokens` reaching Ollama
   * for the first time. It was resolved, documented and threaded the whole way
   * down, and then dropped, because the destructure never named it — so an
   * answer cut off at Ollama's own default ceiling looked like a model failing
   * rather than a setting nobody was honouring.
   */
  it('ollama', () => {
    expect(bodyFor('ollama')).toEqual({
      model: 'm',
      messages: CALL.messages,
      stream: true,
      options: { temperature: 0.2, num_ctx: 8192, num_predict: 2048 },
      think: true,
      format: 'json',
    })
  })

  it('openai', () => {
    expect(bodyFor('openai')).toEqual({
      model: 'm',
      messages: CALL.messages,
      stream: true,
      temperature: 0.2,
      stream_options: { include_usage: true },
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    })
  })

  /** `system` hoisted out of the messages, and no `temperature` at all. */
  it('anthropic', () => {
    expect(bodyFor('anthropic')).toEqual({
      model: 'm',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      system: 'S',
      thinking: { type: 'adaptive' },
    })
  })

  /**
   * Byte-identical to the openai adapter it is spread from. The split bought
   * `/props` and a token budget field; it must not have changed the request a
   * llama.cpp deployment has been posting all along.
   */
  it('llamacpp posts exactly what the openai adapter posts', () => {
    expect(bodyFor('llamacpp')).toEqual(bodyFor('openai'))
  })
})

describe('the neutral vocabulary', () => {
  const reasoning = (value) => cfg({ provider: 'openai', reasoning: value }).chat.reasoning

  it('collapses five spellings into three shapes', () => {
    // 'auto' and an omitted key are the same sentence, and both mean "you decide".
    expect(reasoning(undefined)).toBe(null)
    expect(reasoning('auto')).toBe(null)
    expect(reasoning(false)).toBe(false)
    // Writing `true` is saying yes rather than naming a depth; the neutral
    // middle is the least surprising reading of yes.
    expect(reasoning(true)).toEqual({ effort: 'medium', budgetTokens: null, visible: true })
    expect(reasoning('high')).toEqual({ effort: 'high', budgetTokens: null, visible: true })
    expect(reasoning({ effort: 'low', budgetTokens: 2048, visible: false })).toEqual({
      effort: 'low',
      budgetTokens: 2048,
      visible: false,
    })
  })

  it('refuses a level it does not know, and names the ones it does', () => {
    expect(() => reasoning('deep')).toThrow(/minimal, low, medium, high, xhigh, max/)
    expect(() => reasoning({ effort: 'deep' })).toThrow(/not a level/)
    expect(() => reasoning(7)).toThrow(/takes a level, false, or an object/)
    expect(() => reasoning({ budgetTokens: -1 })).toThrow(/positive number/)
  })

  /**
   * THE ARITHMETIC THAT MAKES ONE VOCABULARY POSSIBLE. No two services publish
   * the same words — DeepSeek has three levels and no `medium` at all — so a
   * neutral level posted verbatim is invalid somewhere by construction, not by
   * bad luck. Ties go down: the author pays for what they asked for, not more.
   */
  it('clamps a level to the words the service actually publishes', () => {
    expect(resolveTuning(cfg({ provider: 'deepseek', reasoning: 'medium' })).effort).toBe('low')
    expect(resolveTuning(cfg({ provider: 'openai', reasoning: 'medium' })).effort).toBe('medium')
    // xAI has no `minimal`; the nearest word it does publish is `low`.
    expect(resolveTuning(cfg({ provider: 'xai', reasoning: 'minimal' })).effort).toBe('low')
    // Ollama has no `xhigh`; `max` is the neighbour above and `high` below.
    expect(resolveTuning(cfg({ provider: 'ollama', reasoning: 'xhigh' })).effort).toBe('high')
  })

  /** A service that cannot stop thinking is REPORTED, never refused. */
  it('collapses an unhonourable off into a request with nothing to send', () => {
    expect(resolveTuning(cfg({ provider: 'xai', reasoning: false })).style).toBe('none')
    expect(resolveTuning(cfg({ provider: 'openai', reasoning: false })).off).toBe(true)
  })
})

describe('every copy point carries it', () => {
  const KNOBS = ['reasoning', 'verbosity', 'topP', 'seed']

  it('reaches the browser through themeDocPilot, by name', () => {
    const llm = themeDocPilot(cfg({ provider: 'openai', reasoning: 'high', verbosity: 'low', topP: 0.9, seed: 7 })).llm
    for (const k of KNOBS) expect(Object.hasOwn(llm, k), `themeDocPilot dropped ${k}`).toBe(true)
    expect(llm.verbosity).toBe('low')
    expect(llm.topP).toBe(0.9)
    expect(llm.seed).toBe(7)
    expect(llm.tuning.effort).toBe('high')
  })

  /**
   * The record the transport reads names a body SHAPE and never a company. That
   * is what lets providers.js stay brand-blind — a branch on `style` is a branch
   * on a capability, and a branch on `provider === 'openrouter'` would be a
   * second place the provider table has to live.
   */
  it('emits a shape rather than a brand', () => {
    const t = themeDocPilot(cfg({ provider: 'openrouter', reasoning: 'high' })).llm.tuning
    expect(t.style).toBe('unified')
    expect(JSON.stringify(t)).not.toMatch(/openrouter/)
  })

  it('survives JSON, because that is how it reaches a page', () => {
    const llm = themeDocPilot(cfg({ provider: 'ollama', reasoning: 'high' })).llm
    // An `undefined` anywhere here would be DELETED by JSON.stringify and then
    // silently refilled from the client defaults — the failure written up on
    // resolveEmbed. Null is the only spelling of "nothing" that crosses.
    expect(JSON.parse(JSON.stringify(llm)).tuning).toEqual(llm.tuning)
    for (const k of KNOBS) expect(llm[k]).not.toBe(undefined)
  })
})

describe('a knob the provider cannot honour', () => {
  /**
   * Refused at build time and by name. The alternative is dropping it in
   * silence, which is strictly worse: the author believes it took.
   */
  it('stops the build for a knob the service is known to reject', () => {
    expect(() => themeDocPilot(cfg({ provider: 'anthropic', verbosity: 'low' }))).toThrow(/chat\.verbosity/)
    expect(() => themeDocPilot(cfg({ provider: 'anthropic', seed: 7 }))).toThrow(/chat\.seed/)
    expect(() => themeDocPilot(cfg({ provider: 'anthropic', topP: 0.9 }))).toThrow(/chat\.topP/)
    expect(() => themeDocPilot(cfg({ provider: 'openai', reasoning: { budgetTokens: 4096 } }))).toThrow(
      /budgetTokens/,
    )
  })

  it('names the escape hatch in the same breath', () => {
    expect(() => themeDocPilot(cfg({ provider: 'anthropic', verbosity: 'low' }))).toThrow(/chat\.extraBody/)
  })

  /**
   * TEMPERATURE, which the providers table printed a `—` for and nothing
   * refused.
   *
   * `docs/guide/providers.md` states the rule for that column outright: a `—`
   * means naming the knob there stops the build rather than being dropped in
   * silence. Anthropic's cell is `—` and its API rejects sampling parameters, so
   * the page, the adapter and a comment beside `resolveTuning` all described a
   * branch that did not exist.
   */
  it('stops the build for a temperature the service rejects', () => {
    expect(() => themeDocPilot(cfg({ provider: 'anthropic', temperature: 0.9 }))).toThrow(/chat\.temperature/)
    expect(() => themeDocPilot(cfg({ provider: 'openai', temperature: 0.9 }))).not.toThrow()
  })

  /**
   * THE SHIPPED VALUE IS NOT A REQUEST. Every other knob here defaults to null,
   * so `!= null` reads as "the author wrote it"; `temperature` ships as 0.2, and
   * an author who writes exactly that is asking for what they would have got
   * anyway. Refusing it would stop a build over a request that changes nothing.
   */
  it('lets the shipped temperature stand, because it asks for nothing', () => {
    expect(() => themeDocPilot(cfg({ provider: 'anthropic', temperature: 0.2 }))).not.toThrow()
  })

  /**
   * A HOST IS NOT A SERVICE. `custom` names somewhere weights are loaded, so
   * this package cannot know what the gateway accepts and refuses nothing —
   * `caps.unknown`, and `doctor` prints the caveat instead.
   */
  it('refuses nothing on a host it cannot know', () => {
    expect(() =>
      themeDocPilot(cfg({ provider: 'custom', model: 'm', temperature: 0.9, verbosity: 'low', seed: 7 })),
    ).not.toThrow()
  })

  /**
   * The two settings whose TYPE was documented and never checked. Both reached
   * the browser verbatim, so a typo was not a build failure — it was a field in
   * the bundle.
   */
  it('refuses a verbosity and a model list that are not what the reference says', () => {
    expect(() => themeDocPilot(cfg({ provider: 'openai', verbosity: 'enormous' }))).toThrow(
      /chat\.verbosity is "enormous"/,
    )
    expect(() => themeDocPilot(cfg({ provider: 'openai', models: [null, 42] }))).toThrow(/chat\.models holds/)
    expect(() => themeDocPilot(cfg({ provider: 'openai', models: ['a', 'b'] }))).not.toThrow()
  })

  /** Turning something off is always an honourable request. */
  it('never refuses reasoning: false, on any provider', () => {
    for (const provider of BRANDS) {
      if (provider === 'custom') continue // needs a model named, for its own reason
      expect(() => themeDocPilot(cfg({ provider, reasoning: false })), provider).not.toThrow()
    }
  })

  /**
   * A HOST rather than a service. This file cannot know what somebody else's
   * gateway accepts, and deciding that it does not is the mistake
   * `chatModel: null` on that row exists to avoid.
   */
  it('refuses nothing at all on a host it cannot know', () => {
    expect(() =>
      themeDocPilot(cfg({ provider: 'custom', model: 'x', verbosity: 'low', seed: 7, topP: 0.9 })),
    ).not.toThrow()
  })
})

describe('the matrix is not decoration', () => {
  /**
   * THE TEST THAT KEEPS THE DOCS, `doctor` AND THE ADAPTERS FROM DRIFTING.
   *
   * `supports` is a claim, printed by the CLI and transcribed into the providers
   * guide. This is what makes it an assertion instead: for every adapter and
   * every knob, a body built WITH the knob has to differ from one built without
   * it at exactly the field the record names — and where the record says the
   * shape has nowhere to put it, the two bodies have to be identical.
   */
  const at = (body, path) => path.split('.').reduce((o, k) => o?.[k], body)

  const cases = [
    ['topP', { topP: 0.9 }],
    ['seed', { seed: 7 }],
    ['verbosity', { verbosity: 'high' }],
  ]

  for (const id of PROVIDER_IDS) {
    for (const [knob, tuning] of cases) {
      it(`${id}: ${knob}`, () => {
        const field = providerFor(id).supports?.[knob]
        const without = bodyFor(id)
        const with_ = bodyFor(id, { tuning: { style: 'effort', ...tuning } })
        if (field) {
          expect(at(with_, field), `${id} claims ${knob} → ${field} and did not set it`).not.toBe(undefined)
          expect(at(without, field)).toBe(undefined)
        } else {
          expect(with_, `${id} claims no ${knob} and changed the body anyway`).toEqual(without)
        }
      })
    }
  }

  it('every adapter declares a record at all', () => {
    for (const id of PROVIDER_IDS) {
      expect(providerFor(id).supports, `${id} has no supports record`).toBeTruthy()
    }
  })

  /** And every brand the chain can reach declares what it does with them. */
  it('every brand declares its capabilities', () => {
    for (const id of BRANDS) expect(capsOf(id), `${id} has no caps`).toBeTruthy()
  })
})

describe('the harness decides when, the author decides how deep', () => {
  /**
   * The composition rule, pinned at the adapter because that is where the two
   * decisions meet. A level DEEPENS a step that was already going to think; it
   * never turns thinking on where the harness turned it off.
   *
   * The reason is measured and it is in the source: reasoning on an intermediate
   * step is pure latency — the model is choosing a tool, not composing an answer
   * — and leaving it on across four steps put p50 at 215 seconds.
   */
  it('a level does not re-enable thinking on a search step', () => {
    const tuning = { style: 'think', effort: 'high', off: false }
    expect(bodyFor('ollama', { tuning, enableThink: false }).think).toBe(false)
    expect(bodyFor('ollama', { tuning, enableThink: true }).think).toBe('high')
  })

  it('an author’s off is honoured even where the harness asked for thinking', () => {
    expect(bodyFor('ollama', { tuning: { style: 'think', off: true }, enableThink: true }).think).toBe(false)
  })
})

describe('the ceiling field that turns every request into a 400', () => {
  /**
   * `max_tokens` is deprecated on this endpoint and REJECTED outright by
   * OpenAI's reasoning families. `chat: {provider: 'openai', model: 'gpt-5-mini'}`
   * could therefore not answer anything, and the panel rendered the 400 as
   * "I couldn't find this in the docs" — a sentence about the corpus for a
   * question that never reached a model.
   */
  it('sends max_completion_tokens to the models that demand it', () => {
    for (const model of ['gpt-5-mini', 'o3', 'o4-mini', 'codex-mini', 'openai/gpt-5']) {
      const b = bodyFor('openai', { model })
      expect(b.max_completion_tokens, model).toBe(2048)
      expect(b.max_tokens, model).toBe(undefined)
    }
  })

  it('leaves every other model on the field it has always taken', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b:free']) {
      expect(bodyFor('openai', { model }).max_tokens, model).toBe(2048)
    }
  })

  it('lets a brand override the rule without a code change', () => {
    const b = bodyFor('openai', { model: 'gpt-5-mini', tuning: { maxTokensField: 'max_tokens' } })
    expect(b.max_tokens).toBe(2048)
  })
})
