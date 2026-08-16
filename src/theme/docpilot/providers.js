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
    const h = { 'content-type': 'application/json' }
    if (apiKey) h.authorization = `Bearer ${apiKey}`
    return h
  },

  body({ model, messages, temperature, streaming, tools, schemaBody, enableThink, numCtx }) {
    const body = { model, messages, stream: streaming, options: { temperature } }
    // Ollama's server default context is 4096 tokens. A primed turn is already
    // ~1.8k (system + tool schemas + five excerpts) and every extra search adds
    // ~1k more, all of it re-sent — so past the second tool call llama.cpp shifts
    // the window and drops the SYSTEM BLOCK off the front. The symptom is an
    // unexplained refusal that reads as a model-quality problem. Pinning num_ctx
    // is therefore a correctness fix, not a tuning knob; unset, the body is
    // byte-identical to what it always was.
    if (numCtx) body.options.num_ctx = numCtx
    // Reasoning on an intermediate step is pure latency: the model is choosing a
    // tool, not composing an answer. Measured, leaving it on across four steps
    // put p50 at 215s.
    if (enableThink !== undefined) body.think = enableThink
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
      if (json.error) throw new Error(String(json.error))
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
}

// ── openai and every service that copied it ──────────────────────────────────

const openai = {
  id: 'openai',
  chatUrl: (baseURL) => `${baseURL}/v1/chat/completions`,

  headers(apiKey) {
    const h = { 'content-type': 'application/json' }
    if (apiKey) h.authorization = `Bearer ${apiKey}`
    return h
  },

  body({ model, messages, temperature, streaming, tools, schemaBody }) {
    const body = {
      model,
      // A `tool` role here requires a `tool_call_id`, and the harness rebuilds
      // the message list from scratch on every step rather than replaying the
      // assistant turns those ids belong to. Observations are therefore carried
      // as user messages — same text, same position, no invented ids.
      messages: messages.map((m) => (m.role === 'tool' ? { ...m, role: 'user' } : m)),
      stream: streaming,
      temperature,
    }
    if (schemaBody) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: schemaBody },
      }
    } else if (tools) {
      body.tools = tools
    } else {
      body.response_format = { type: 'json_object' }
    }
    return body
  },

  parse(json) {
    const msg = json.choices?.[0]?.message || {}
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
    }
  },

  async readStream(res, onDelta) {
    let content = ''
    let thinking = ''
    let usage = null
    const calls = []

    await readLines(res, (raw) => {
      const json = sseData(raw)
      if (!json) return
      if (json.error) throw new Error(String(json.error.message || json.error))
      // Present only when the caller asked for it; absent is not an error.
      if (json.usage) usage = usageOf(json.usage.prompt_tokens, json.usage.completion_tokens)
      const d = json.choices?.[0]?.delta || {}
      if (d.reasoning_content) {
        thinking += d.reasoning_content
        onDelta({ thinking: d.reasoning_content })
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

  body({ model, messages, temperature, streaming, tools, schemaBody, enableThink, maxTokens }) {
    // `system` is a top-level parameter here, not a message role.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

    const body = {
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

    if (enableThink) {
      body.thinking = { type: 'enabled', budget_tokens: 1024 }
      // Extended thinking pins temperature to 1; sending anything else is an error.
    } else if (typeof temperature === 'number') {
      body.temperature = temperature
    }
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
    return { content, thinking, toolCall, usage: usageOf(json.usage?.input_tokens, json.usage?.output_tokens) }
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
      if (json.type === 'error') throw new Error(String(json.error?.message || 'stream error'))

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
    }
  },

  probeBody: (model, tools) => ({
    model,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Call list_pages with prefix "/".' }],
    tools: anthropicTools(tools),
    temperature: 0,
  }),
  probeHasToolCall: (json) => (json.content || []).some((b) => b.type === 'tool_use'),

  // Anthropic has no embeddings endpoint at all; `embed.provider` is configured
  // separately for exactly this reason.
  embedUrl: null,
}

const REGISTRY = { ollama, openai, anthropic }

export function providerFor(id) {
  return REGISTRY[id] || ollama
}

export const PROVIDER_IDS = Object.keys(REGISTRY)
export { EMPTY as emptyReply }
