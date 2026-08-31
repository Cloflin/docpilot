/**
 * Provider adapters — RAG-SPEC 4.1.
 *
 * The harness knows one shape: send messages, maybe with tools or a schema, get
 * back `{ content, thinking, toolCall }`. Everything that differs between
 * services — the path, the auth header, where `system` lives, how a JSON shape
 * is forced, how a stream is framed — is confined to this file.
 *
 * Three adapters cover the field:
 *   ollama    — /api/chat, NDJSON stream. The original path, byte-for-byte.
 *   openai    — /v1/chat/completions, SSE. Also OpenRouter, Groq, DeepSeek,
 *               Together, vLLM and anything else that copied that API: they
 *               differ by baseURL, model and key, not by shape.
 *   anthropic — /v1/messages, typed SSE, system hoisted out of the messages,
 *               tools declared with `input_schema`, and no `response_format` at
 *               all — a forced tool call is how a JSON shape is pinned there.
 */

/** Line reader shared by every stream format below. */
async function readLines(res, line) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      line(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  line(buf)
}

/** `data: {…}` → the parsed object; null for comments, blanks and [DONE]. */
function sseData(raw) {
  const t = raw.trim()
  if (!t.startsWith('data:')) return null
  const payload = t.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

/**
 * A stream that opened 200 and then failed — and the status it failed with.
 *
 * This matters to ROTATION, not to reporting. The transport decides whether to
 * try the next model in a pool by reading `e.status`, and an error that arrives
 * INSIDE the stream used to reach it as a bare `Error`: status undefined, not
 * rotatable, pool abandoned on its first member. That is the shape a shared free
 * tier fails in most often — HTTP 200, then `{"error":{"code":429,…}}` one frame
 * later — so the one failure the pool exists to survive was the one it could not
 * see. The code travels with the message now.
 */
export function streamError(err, fallback = 'stream error') {
  const message = String(err?.message || err || fallback)
  const e: Error & { status?: number } = new Error(message)
  const code = Number(err?.code ?? err?.status)
  if (Number.isFinite(code)) e.status = code
  return e
}

/** Arguments arrive as an object from Ollama and as a JSON string everywhere else. */
function normaliseArgs(args) {
  if (typeof args !== 'string') return args || {}
  try {
    return JSON.parse(args) || {}
  } catch {
    return {}
  }
}

const EMPTY = () => ({ content: '', thinking: '', toolCall: null })

/**
 * Every provider reports what it charged for; none of them was being read.
 * A turn's token cost is the number the token-economy work is optimising, and an
 * estimate derived from character counts cannot be it — the tokenizer is the
 * only authority on how many tokens a prompt of excerpts actually became.
 */
function usageOf(promptTokens, outputTokens) {
  if (promptTokens == null && outputTokens == null) return null
  return { promptTokens: promptTokens || 0, outputTokens: outputTokens || 0 }
}

// ── ollama ───────────────────────────────────────────────────────────────────

const ollama = {
  id: 'ollama',
  chatUrl: (baseURL) => `${baseURL}/api/chat`,

  headers(apiKey) {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) h.authorization = `Bearer ${apiKey}`
    return h
  },

  /**
   * WHAT THIS ADAPTER CAN SPELL, and what each knob is called on the wire.
   *
   * Declared as data beside the function that does it, for the reason 11d
   * executes the docs fence: a claim and an implementation that can disagree
   * eventually will. `doctor` prints these names — the one fact about a knob
   * that is available nowhere else — and a test asserts that a body built with
   * each knob differs from one built without it at exactly the field named here.
   *
   * The values are wire NAMES rather than booleans, and `false` means the shape
   * has nowhere to put it.
   */
  supports: {
    reasoning: 'think',
    verbosity: false,
    temperature: 'options.temperature',
    topP: 'options.top_p',
    seed: 'options.seed',
    maxTokens: 'options.num_predict',
    numCtx: 'options.num_ctx',
    extraBody: true,
  },

  body({ model, messages, temperature, streaming, tools, schemaBody, enableThink, numCtx, maxTokens, tuning, extraBody }) {
    // `extraBody` reaches this adapter too, which it did not for as long as this
    // function existed — only the openai adapter destructured it, so `chat.extraBody`
    // was a documented setting that an Ollama site could write and never send.
    //
    // Spread UNDERNEATH rather than over, on the rule the openai adapter states:
    // nothing configuration supplies may overwrite a field this adapter owns. And
    // `options` is merged a level deeper rather than replaced, because a top-level
    // spread of `{options: {top_k: 40}}` would take `temperature` and `num_ctx`
    // out of the body with it — the sampling block is the only nested object here
    // and it is the one an author is most likely to reach for.
    const extra = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : null
    const body = {
      ...extra,
      model,
      messages,
      stream: streaming,
      options: { ...(extra?.options), temperature },
    }
    // Ollama's server default context is 4096 tokens. A primed turn is already
    // ~1.8k (system + tool schemas + five excerpts) and every extra search adds
    // ~1k more, all of it re-sent — so past the second tool call llama.cpp shifts
    // the window and drops the SYSTEM BLOCK off the front. The symptom is an
    // unexplained refusal that reads as a model-quality problem. Pinning num_ctx
    // is therefore a correctness fix, not a tuning knob; unset, the body is
    // byte-identical to what it always was.
    if (numCtx) body.options.num_ctx = numCtx
    /**
     * `maxTokens` reaches Ollama at last, under the name this API gives it.
     *
     * It was resolved, documented and threaded the whole way down to this
     * function, and then dropped — the destructure above simply never named it —
     * so `chat.maxTokens` was a setting an Ollama site could write and watch do
     * nothing, while the same value on every other adapter capped the reply.
     */
    if (maxTokens) body.options.num_predict = maxTokens
    if (tuning?.topP != null) body.options.top_p = tuning.topP
    if (tuning?.seed != null) body.options.seed = tuning.seed
    /**
     * `think` is the only field in this file that is BOTH a switch and a dial:
     * `false` turns reasoning off and a word sets its depth, in one key. So the
     * author's level and the harness's positional decision meet here rather than
     * in two separate fields.
     *
     * The harness still decides WHEN. Reasoning on an intermediate step is pure
     * latency — the model is choosing a tool, not composing an answer, and
     * measured, leaving it on across four steps put p50 at 215s — so a level
     * only ever deepens a step that was already going to think.
     */
    if (tuning?.off) body.think = false
    else if (tuning?.effort && enableThink) body.think = tuning.effort
    else if (enableThink !== undefined) body.think = enableThink
    if (schemaBody) body.format = schemaBody
    else if (tools) body.tools = tools
    else body.format = 'json'
    return body
  },

  parse(json) {
    const msg = json.message || {}
    const call = msg.tool_calls?.[0]
    return {
      content: msg.content || '',
      thinking: msg.thinking || '',
      toolCall: call?.function
        ? { name: call.function.name, args: normaliseArgs(call.function.arguments) }
        : null,
      usage: usageOf(json.prompt_eval_count, json.eval_count),
      // Null rather than `done_reason`, and that is a decision. A continuation
      // request is a prefill — the truncated text goes back as the last
      // assistant message and the model carries on from it — and that shape is
      // only reliable on the OpenAI-compatible services this feature was
      // measured against. Reporting a reason nobody acts on would be a
      // capability the transport does not have.
      finishReason: null,
    }
  },

  async readStream(res, onDelta) {
    let content = ''
    let thinking = ''
    let toolCalls = null
    let done = null
    await readLines(res, (raw) => {
      const t = raw.trim()
      if (!t) return
      let json
      try {
        json = JSON.parse(t)
      } catch {
        // A partial line is impossible here — the loop only hands over complete
        // ones — so this is a server that is not speaking NDJSON. Skip it.
        return
      }
      if (json.error) throw streamError(json.error)
      // The counts ride on the final frame only.
      if (json.done) done = json
      const m = json.message || {}
      if (m.thinking) {
        thinking += m.thinking
        onDelta({ thinking: m.thinking })
      }
      if (m.content) {
        content += m.content
        onDelta({ content: m.content, contentSoFar: content })
      }
      if (m.tool_calls?.length) toolCalls = m.tool_calls
    })
    return ollama.parse({
      message: { content, thinking, tool_calls: toolCalls },
      prompt_eval_count: done?.prompt_eval_count,
      eval_count: done?.eval_count,
    })
  },

  showUrl: (baseURL) => `${baseURL}/api/show`,
  showBody: (model) => ({ model }),
  /**
   * The runtime source of truth for what a model can do. RAG-SPEC 4.6's table is
   * a record of a measurement, not a configuration: this Ollama build ships
   * phi4:14b with `completion` alone, and sending `think` to a model without the
   * thinking capability is an error, not a no-op.
   */
  parseCapabilities: (json) => ({
    tools: (json.capabilities || []).includes('tools'),
    thinking: (json.capabilities || []).includes('thinking'),
    contextLength: Object.entries(json.model_info || {}).find(([k]) =>
      k.endsWith('context_length'),
    )?.[1],
  }),

  probeBody: (model, tools) => ({
    model,
    stream: false,
    messages: [{ role: 'user', content: 'Call list_pages with prefix "/".' }],
    tools,
    options: { temperature: 0 },
  }),
  probeHasToolCall: (json) => (json.message?.tool_calls?.length || 0) > 0,

  embedUrl: (baseURL) => `${baseURL}/api/embed`,
  embedBody: (model, input) => ({ model, input }),
  embedParse: (json) => json.embeddings?.[0] || json.embedding,

  /**
   * What this server will actually answer to — asked by `docpilot doctor
   * --models` and by nothing else.
   *
   * It lives here for the same reason `chatUrl` does: the path and the payload
   * shape are facts about an API, and config.js knows brands rather than APIs.
   * Ollama is the odd one, listing PULLED models at `/api/tags` rather than a
   * catalogue at `/v1/models` — which is the honest answer for a local server,
   * where "available" means "downloaded".
   */
  modelsUrl: (baseURL) => `${baseURL}/api/tags`,
  modelsParse: (json) => (json.models || []).map((m) => m.name || m.model).filter(Boolean),
}

// ── openai and every service that copied it ──────────────────────────────────

/**
 * WHICH TOKEN-CEILING FIELD THIS ENDPOINT TAKES FOR THIS MODEL.
 *
 * `max_tokens` is deprecated on `/v1/chat/completions` and REJECTED outright by
 * OpenAI's reasoning families — o-series and the whole gpt-5 line answer
 *
 *   400 Unsupported parameter: 'max_tokens' is not supported with this model.
 *       Use 'max_completion_tokens' instead.
 *
 * which the panel renders as "I couldn't find this in the docs", because a
 * question that never reached a model looks exactly like a question the corpus
 * could not answer. `chat: {provider: 'openai', model: 'gpt-5-mini'}` was
 * therefore a configuration that could not answer anything.
 *
 * DECIDED HERE, FROM THE MODEL STRING, AT REQUEST TIME, for two reasons. It is
 * not a brand fact — every service that copied this endpoint inherits the same
 * rule for the same ids, OpenRouter and Azure included — and it is not resolvable
 * at config time either, because a pool moves the model between requests. The
 * `(^|\/)` anchor is for exactly that: OpenRouter names the same model
 * `openai/gpt-5-mini`.
 *
 * A brand where the rule does not hold overrides it with `caps.maxTokensField`.
 * `gpt-4o` is deliberately NOT matched — it still takes `max_tokens`.
 */
const NEEDS_MAX_COMPLETION = /(^|\/)(o[1-9](\b|-)|gpt-5|codex-mini)/i

/** The ceiling field for this request: the brand's override, or the model's rule. */
function maxTokensFieldFor(model, tuning) {
  const named = tuning?.maxTokensField
  if (named && named !== 'auto') return named
  return NEEDS_MAX_COMPLETION.test(String(model || '')) ? 'max_completion_tokens' : 'max_tokens'
}

/**
 * The neutral knobs, in the OpenAI-shaped spelling — the whole translation for
 * this adapter and the two brands whose surface differs from it.
 *
 * `tuning` arrives already clamped: the effort is a word the configured service
 * publishes, and anything that service cannot take has been removed by
 * `resolveTuning` in config.js. So there is nothing to decide here except WHERE
 * each value goes, which is what an adapter is for. `style` is a body shape and
 * never a brand — that is what lets this file stay brand-blind.
 */
function applyTuning(body, tuning) {
  if (!tuning) return body
  if (tuning.verbosity) body.verbosity = tuning.verbosity
  if (tuning.topP != null) body.top_p = tuning.topP
  if (tuning.seed != null) body.seed = tuning.seed

  if (tuning.style === 'unified') {
    // OpenRouter's own normalisation across every upstream it routes to, which
    // is why it is a style rather than the flat field its endpoint also takes.
    // `exclude` is "think, but do not send it to me" — cheaper output on a panel
    // that is not showing the trace, and a different request from not thinking.
    if (tuning.off) body.reasoning = { enabled: false }
    else if (tuning.budgetTokens != null) body.reasoning = { max_tokens: tuning.budgetTokens }
    else if (tuning.effort) body.reasoning = { effort: tuning.effort }
    if (body.reasoning && tuning.hide) body.reasoning.exclude = true
  } else if (tuning.style === 'effort') {
    // `none` is this vocabulary's word for off, on every service in the table
    // that can be switched off at all. Where one cannot, `resolveTuning` has
    // already collapsed the request to `style: 'none'` and nothing arrives here.
    if (tuning.off) body.reasoning_effort = 'none'
    else if (tuning.effort) body.reasoning_effort = tuning.effort
    // llama.cpp's own budget field. No other OpenAI-shaped service has one, and
    // the brands that do not are refused this knob at build time.
    if (tuning.budgetTokens != null) body.reasoning_budget = tuning.budgetTokens
    if (tuning.hide && tuning.visibleStyle === 'reasoning_format') body.reasoning_format = 'hidden'
  }
  return body
}

const openai = {
  id: 'openai',
  chatUrl: (baseURL) => `${baseURL}/v1/chat/completions`,

  headers(apiKey) {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) h.authorization = `Bearer ${apiKey}`
    return h
  },

  supports: {
    reasoning: 'reasoning_effort',
    verbosity: 'verbosity',
    temperature: 'temperature',
    topP: 'top_p',
    seed: 'seed',
    maxTokens: 'max_tokens',
    numCtx: false,
    extraBody: true,
  },

  body({ model, messages, temperature, streaming, tools, schemaBody, maxTokens, tuning, extraBody, continuing }) {
    const body = {
      // The brand-specific fragment, and it goes FIRST so that nothing
      // configuration supplies can overwrite a field this adapter owns — a
      // stray `stream: false` in an author's `extraBody` would otherwise turn
      // off streaming for every reader on the site. What lives here is the one
      // thing config.js knows and this file must not: which brand is behind an
      // OpenAI-shaped endpoint. OpenRouter's `provider.require_parameters` is
      // the case it exists for, and it is a correctness fix — without it the
      // request is routed to upstreams that silently drop `response_format`,
      // which is the measured cause of six of ten pool members answering the
      // strict final call in prose.
      ...(extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : null),
      model,
      // A `tool` role here requires a `tool_call_id`, and the harness rebuilds
      // the message list from scratch on every step rather than replaying the
      // assistant turns those ids belong to. Observations are therefore carried
      // as user messages — same text, same position, no invented ids.
      messages: messages.map((m) => (m.role === 'tool' ? { ...m, role: 'user' } : m)),
      stream: streaming,
      temperature,
    }
    // Usage rides on a final frame that is only sent when it is asked for, and
    // nothing was asking — so token accounting was blank in exactly the mode the
    // panel runs in, since streaming is on whenever there is an onDelta.
    if (streaming) body.stream_options = { include_usage: true }
    // `chat.maxTokens` was documented, resolved, carried all the way down to
    // this function — and then dropped, because only the anthropic adapter ever
    // destructured it. Every OpenAI-compatible provider therefore ran on its own
    // default ceiling whatever the site configured, which is also why an answer
    // truncated at that ceiling looked like a model failure rather than a
    // setting nobody was honouring.
    if (maxTokens) body[maxTokensFieldFor(model, tuning)] = maxTokens
    applyTuning(body, tuning)
    // A CONTINUATION finishes a reply the provider cut off: the partial text is
    // the last assistant message and the model is being asked to carry on from
    // mid-sentence. Forcing a response shape is exactly what breaks that — under
    // a strict `json_schema` (or even a bare `json_object`) the completion must
    // be a whole valid object on its own, so the model re-emits the answer from
    // the top and runs into the same ceiling at the same place. Tools stay:
    // a continuation that decides to call one is still a legal next step.
    if (schemaBody && !continuing) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: schemaBody },
      }
    } else if (tools) {
      body.tools = tools
    } else if (!continuing) {
      body.response_format = { type: 'json_object' }
    }
    return body
  },

  parse(json) {
    const choice = json.choices?.[0] || {}
    const msg = choice.message || {}
    const call = msg.tool_calls?.[0]
    return {
      content: msg.content || '',
      // Not an OpenAI field. Servers that copied the API and do expose
      // reasoning put it here; OpenAI itself does not, which is why the panel's
      // reasoning box stays shut there. OpenRouter normalises it to `reasoning`
      // rather than `reasoning_content`, and reasoning models routed through it
      // — openai/gpt-oss-20b is one — otherwise look like they answered with
      // silence: 1202 output tokens against an empty `content`.
      thinking: msg.reasoning_content || msg.reasoning || '',
      toolCall: call?.function
        ? { name: call.function.name, args: normaliseArgs(call.function.arguments) }
        : null,
      usage: usageOf(json.usage?.prompt_tokens, json.usage?.completion_tokens),
      // `'length'` is the difference between a model that answered badly and one
      // that was cut off mid-word, and the two used to be indistinguishable
      // here: a truncated `{"text": "…` fails JSON.parse, lands as a parse
      // error, and the turn ends on "I couldn't find this in the docs" about an
      // answer that was most of the way written.
      finishReason: choice.finish_reason ?? null,
    }
  },

  async readStream(res, onDelta) {
    let content = ''
    let thinking = ''
    let usage = null
    let finishReason = null
    const calls = []

    await readLines(res, (raw) => {
      const json = sseData(raw)
      if (!json) return
      if (json.error) throw streamError(json.error)
      // Present only when the caller asked for it; absent is not an error.
      if (json.usage) usage = usageOf(json.usage.prompt_tokens, json.usage.completion_tokens)
      const choice = json.choices?.[0]
      // The last non-null one wins. It rides on the same `choices[0]` as the
      // deltas and is null on every content frame, arriving for real only on the
      // terminal frame — and the usage frame that follows carries `choices: []`,
      // so reading it unconditionally would erase the reason a frame after
      // learning it.
      if (choice?.finish_reason) finishReason = choice.finish_reason
      const d = choice?.delta || {}
      // Same two spellings `parse` already accounts for: OpenRouter normalises
      // the field to `reasoning`, and reading only `reasoning_content` here lost
      // every delta from the models routed through it.
      const reasoning = d.reasoning_content || d.reasoning
      if (reasoning) {
        thinking += reasoning
        onDelta({ thinking: reasoning })
      }
      if (d.content) {
        content += d.content
        onDelta({ content: d.content, contentSoFar: content })
      }
      // Tool ARGUMENTS arrive as fragments keyed by index and have to be
      // concatenated; Ollama sends the whole object in one frame instead.
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0
        if (!calls[i]) calls[i] = { function: { name: '', arguments: '' } }
        if (tc.function?.name) calls[i].function.name += tc.function.name
        if (!tc.function?.arguments) continue
        calls[i].function.arguments += tc.function.arguments
        // A capable model answers by CALLING `answer` rather than by writing
        // the structured object as content, so the answer text streams inside
        // these fragments. Without forwarding them the reader watches a spinner
        // and then gets the whole answer at once — measured, that is exactly
        // what happened on gpt-4o.
        if (calls[i].function.name === 'answer') {
          onDelta({ content: tc.function.arguments, contentSoFar: calls[i].function.arguments })
        }
      }
    })

    const call = calls.filter(Boolean)[0]
    return {
      content,
      thinking,
      toolCall: call ? { name: call.function.name, args: normaliseArgs(call.function.arguments) } : null,
      usage,
      finishReason,
    }
  },

  probeBody: (model, tools) => ({
    model,
    stream: false,
    messages: [{ role: 'user', content: 'Call list_pages with prefix "/".' }],
    tools,
    temperature: 0,
  }),
  probeHasToolCall: (json) => (json.choices?.[0]?.message?.tool_calls?.length || 0) > 0,

  embedUrl: (baseURL) => `${baseURL}/v1/embeddings`,
  embedBody: (model, input) => ({ model, input }),
  embedParse: (json) => json.data?.[0]?.embedding,

  /** `{data: [{id}]}` — the shape every service that copied this API kept. */
  modelsUrl: (baseURL) => `${baseURL}/v1/models`,
  modelsParse: (json) => (json.data || []).map((m) => m.id).filter(Boolean),
}

// ── anthropic ────────────────────────────────────────────────────────────────

/** Tool schemas, translated: `function.parameters` becomes `input_schema`. */
function anthropicTools(tools) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

/**
 * Which THINKING SHAPE this model takes — the older `{type: 'enabled'}` with a
 * token budget, or adaptive thinking steered by `output_config.effort`.
 *
 * The cut is at Opus 4.6, which is the one release that accepts both: anything
 * before it rejects `adaptive`, anything after it rejects `enabled`. So a
 * package that picks one shape and posts it everywhere is wrong for half the
 * catalogue, in opposite directions.
 *
 * The version is read out of the id rather than matched as a list, because the
 * list grows every few weeks and a stale one fails closed on exactly the newest
 * models. Both id styles are covered — `claude-sonnet-4-6` and the older
 * `claude-3-5-sonnet-20241022` — by taking the first `<major>[-<minor>]` group.
 * An id with no version in it is treated as CURRENT: new models keep arriving
 * and old ones do not, so that is the direction to be wrong in.
 */
function legacyThinking(model) {
  const m = String(model || '').match(/(?:^|-)(\d+)(?:-(\d+))?(?=-|$)/)
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2] || 0)
  return major < 4 || (major === 4 && minor < 6)
}

/**
 * An effort level as a TOKEN BUDGET, for the older thinking shape.
 *
 * The ratios are OpenRouter's published ones, reused rather than invented
 * because they are what a service that translates between these two vocabularies
 * for a living already settled on, and a second set of numbers would be this
 * package guessing at the same problem in private.
 *
 * The API's own floor is 1024 tokens and the budget must stay strictly under
 * `max_tokens`. Where those two cannot both hold — a ceiling of 1024 or less —
 * there is no legal budget, and the honest answer is to send no thinking at all
 * rather than a number the request will be rejected for.
 */
const BUDGET_RATIO = { minimal: 0.1, low: 0.2, medium: 0.5, high: 0.8, xhigh: 0.95, max: 0.95 }

function legacyBudget(tuning, ceiling) {
  if (ceiling <= 1024) return null
  const asked = tuning?.budgetTokens ?? (tuning?.effort ? Math.round(ceiling * BUDGET_RATIO[tuning.effort]) : null)
  if (!asked) return null
  return Math.max(1024, Math.min(asked, ceiling - 1))
}

const anthropic = {
  id: 'anthropic',
  chatUrl: (baseURL) => `${baseURL}/v1/messages`,

  headers(apiKey) {
    const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
    if (apiKey) {
      h['x-api-key'] = apiKey
      // Only meaningful when the browser talks to Anthropic directly. Behind the
      // production proxy the key is attached server-side and this never fires.
      h['anthropic-dangerous-direct-browser-access'] = 'true'
    }
    return h
  },

  supports: {
    reasoning: 'thinking',
    verbosity: false,
    // Not a mistake and not an omission — see the note at the end of `body`.
    temperature: false,
    topP: false,
    seed: false,
    maxTokens: 'max_tokens',
    numCtx: false,
    extraBody: true,
  },

  body({ model, messages, streaming, tools, schemaBody, enableThink, maxTokens, tuning, extraBody }) {
    // `system` is a top-level parameter here, not a message role.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

    // `extraBody` reaches this adapter too, which it did not before: only the
    // openai adapter destructured it, so an Anthropic site could write
    // `chat.extraBody` and watch it go nowhere. Spread FIRST, on the rule that
    // adapter says out loud — nothing configuration supplies may overwrite a
    // field this adapter owns, and here that matters more than anywhere, because
    // `max_tokens` is required and `tool_choice` is what pins the answer's shape.
    const extra = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : null
    const body = {
      ...extra,
      model,
      max_tokens: maxTokens || 2048, // required by this API, unlike the others
      messages: rest,
      stream: streaming,
    }
    if (system) body.system = system

    if (schemaBody) {
      // There is no `response_format`. Forcing the tool is how a shape is
      // pinned — and it lands in the same `toolCall` the harness already
      // handles, so the answer path is unchanged.
      body.tools = [{ name: 'answer', description: 'Deliver the final answer.', input_schema: schemaBody }]
      body.tool_choice = { type: 'tool', name: 'answer' }
    } else if (tools) {
      body.tools = anthropicTools(tools)
    }

    /**
     * TWO SHAPES, AND THE MODEL DECIDES WHICH.
     *
     * `{type: 'enabled', budget_tokens: N}` is the older form. Models after
     * Opus 4.6 reject it outright — *"Use thinking.type.adaptive and
     * output_config.effort"* — and models at 4.5 and earlier reject `adaptive`
     * with the mirror-image error. So this is not a preference; it is a fact
     * about the model string, decided at the moment the body is built, exactly
     * like the ceiling field on the openai adapter.
     *
     * A FORCED TOOL CALL NO LONGER RULES THINKING OUT, and that is a real
     * behaviour change. The old comment here was correct about the old form —
     * manual extended thinking accepts only `tool_choice: auto` or `none`, so
     * the final answer step, which pins its shape with `tool_choice: {type:
     * 'tool'}` above, was rejected outright. Adaptive thinking supports forced
     * tool use. The guard therefore applies to the legacy shape ALONE, and an
     * Anthropic deployment on a current model can now think about its answer
     * instead of only about which search to run.
     */
    if (tuning?.off) {
      // Nothing to send. Omitting the field is how this API spells "no".
    } else if (legacyThinking(model)) {
      // The older shape measures thinking in TOKENS and has no level, so an
      // effort has to become a number before it can be sent. A model this old
      // rejects `adaptive`, so there is no shape to fall back to: either a legal
      // budget exists or the field is omitted.
      const budget = legacyBudget(tuning, maxTokens || 2048)
      if (enableThink && !schemaBody && budget) body.thinking = { type: 'enabled', budget_tokens: budget }
    } else if (enableThink) {
      body.thinking = { type: 'adaptive' }
      // Depth is steered beside the switch rather than inside it on this shape.
      if (tuning?.effort) body.output_config = { effort: tuning.effort }
    }
    // `temperature` is not sent at all, and the reason is finer than "removed".
    // Sampling parameters here are DEPRECATED AND VERSION-GATED: models after
    // Opus 4.6 accept `temperature` at 1.0 and `top_p` at >= 0.99 for backwards
    // compatibility and reject every other value with a 400, while `top_k` is
    // rejected at any value at all. Since the only reason this package sets a
    // temperature is to pin it BELOW the default, "accepted at 1.0" and
    // "unsupported" are the same sentence here. `seed` was never a parameter of
    // this API. The three stay in the shared call signature because Ollama and
    // the OpenAI-shaped services do honour them.
    return body
  },

  parse(json) {
    let content = ''
    let thinking = ''
    let toolCall = null
    for (const block of json.content || []) {
      if (block.type === 'text') content += block.text || ''
      else if (block.type === 'thinking') thinking += block.thinking || ''
      else if (block.type === 'tool_use' && !toolCall) {
        toolCall = { name: block.name, args: block.input || {} }
      }
    }
    // `stop_reason: 'max_tokens'` is the equivalent signal and is deliberately
    // not mapped — see ollama.parse for why the continuation path is confined to
    // the OpenAI-shaped services.
    return {
      content,
      thinking,
      toolCall,
      usage: usageOf(json.usage?.input_tokens, json.usage?.output_tokens),
      finishReason: null,
    }
  },

  async readStream(res, onDelta) {
    let content = ''
    let thinking = ''
    let toolName = null
    let toolJson = ''
    let promptTokens = null
    let outputTokens = null

    await readLines(res, (raw) => {
      const json = sseData(raw)
      if (!json) return
      if (json.type === 'error') throw streamError(json.error)

      // Input tokens arrive with message_start, output tokens with message_delta.
      if (json.type === 'message_start') promptTokens = json.message?.usage?.input_tokens ?? null
      if (json.type === 'message_delta' && json.usage) outputTokens = json.usage.output_tokens ?? null

      if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
        toolName = json.content_block.name
        toolJson = ''
        return
      }
      if (json.type !== 'content_block_delta') return

      const d = json.delta || {}
      if (d.type === 'thinking_delta' && d.thinking) {
        thinking += d.thinking
        onDelta({ thinking: d.thinking })
      } else if (d.type === 'text_delta' && d.text) {
        content += d.text
        onDelta({ content: d.text, contentSoFar: content })
      } else if (d.type === 'input_json_delta' && d.partial_json) {
        // The forced `answer` tool streams its arguments as a growing JSON
        // string, which is exactly what the panel scans for the answer text —
        // so live rendering works here the same way it does on Ollama.
        toolJson += d.partial_json
        onDelta({ content: d.partial_json, contentSoFar: toolJson })
      }
    })

    return {
      content,
      thinking,
      toolCall: toolName ? { name: toolName, args: normaliseArgs(toolJson) } : null,
      usage: usageOf(promptTokens, outputTokens),
      finishReason: null,
    }
  },

  // No `temperature` here either. The probe decides whether the model can call
  // tools at all, so a 400 on a rejected sampling parameter reads as "cannot",
  // and a fully capable model gets demoted to the fallback path for good.
  probeBody: (model, tools) => ({
    model,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Call list_pages with prefix "/".' }],
    tools: anthropicTools(tools),
  }),
  probeHasToolCall: (json) => (json.content || []).some((b) => b.type === 'tool_use'),

  // Anthropic has no embeddings endpoint at all; `embed.provider` is configured
  // separately for exactly this reason.
  embedUrl: null,

  // Same path and the same `{data: [{id}]}` as the OpenAI shape, reached with
  // this adapter's own headers — `x-api-key` plus the version, which `headers`
  // already builds.
  modelsUrl: (baseURL) => `${baseURL}/v1/models`,
  modelsParse: (json) => (json.data || []).map((m) => m.id).filter(Boolean),
}

// ── llama.cpp's own server ───────────────────────────────────────────────────

/**
 * `llama-server` speaks the OpenAI-compatible API and is very nearly the openai
 * adapter — which is how it was served until now, as the `openai` adapter under
 * a different baseURL.
 *
 * It gets its own entry because the differences are real and they are about the
 * SHAPE of the API rather than about a brand, which is the line this file is
 * drawn on. It publishes `/props`, naming the weights it was actually started
 * with — a question `/v1/models` cannot answer, because that endpoint replies
 * with whatever alias it was launched under. And it controls reasoning through
 * `chat_template_kwargs`, a field that belongs to llama.cpp's template layer and
 * that OpenAI has never had; putting it on the shared adapter would offer it to
 * `api.openai.com` as well.
 *
 * Everything else is inherited verbatim, so a llama.cpp deployment posts exactly
 * the body it always did.
 */
const llamacpp = {
  ...openai,
  id: 'llamacpp',

  supports: {
    ...openai.supports,
    // The two fields that earned this adapter its own entry. `reasoning_budget`
    // is a token count no other OpenAI-shaped service in the table accepts, and
    // `reasoning_format` is how the trace is kept out of `content`.
    budget: 'reasoning_budget',
    hideReasoning: 'reasoning_format',
    loadedModel: 'GET /props',
  },

  /**
   * WHAT THIS SERVER ACTUALLY LOADED — a question `/v1/models` cannot answer.
   *
   * That endpoint replies with the alias llama-server was launched under; the
   * README says so and points here for the real thing. Which is why `doctor`
   * used to report the placeholder `'local'` as a model this service does not
   * serve: it was asking the wrong endpoint a question it cannot answer.
   *
   * Every field degrades to null rather than throwing — the `parseCapabilities`
   * contract. This response shape has moved between llama.cpp releases and will
   * again, and a preflight that reports nothing is a preflight; one that throws
   * is a broken build over somebody's laptop.
   */
  propsUrl: (baseURL) => `${baseURL}/props`,
  parseProps: (json) => ({
    loaded: json?.model_path || null,
    // Nested rather than top-level, which is easy to get wrong from memory.
    contextLength: json?.default_generation_settings?.n_ctx ?? null,
  }),
}

const REGISTRY = { ollama, openai, anthropic, llamacpp }

export function providerFor(id) {
  return REGISTRY[id] || ollama
}

export const PROVIDER_IDS = Object.keys(REGISTRY)
export { EMPTY as emptyReply }
