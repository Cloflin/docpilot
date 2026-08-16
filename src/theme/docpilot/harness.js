/**
 * The agent loop — RAG-SPEC 4.2, 4.3.
 *
 * This module NEVER references the index. It receives the object returned by
 * createRetrieval() and closes its tool executors over it, so `fetch_section`'s
 * existence check is retrieval.fetch(id) rather than index.byId.get(id) and no
 * chunk the retriever did not admit can reach the model. `grep -n '\bindex\b'`
 * over this file returns nothing, and check-docpilot.sh enforces that.
 */

import { chat, streamingAnswerText } from './llm.js'
import { buildMessages, finalNote, OBS_NOTE } from './prompt.js'
import { computeSupport } from './support.js'

/**
 * Per-step ceiling. 30s is the right number for a hosted endpoint and far too
 * tight for a local 8B with reasoning enabled on a ~6 KB prompt, which is the
 * default configuration — measured on this machine a single step runs well past
 * it. Configurable, and generous by default, because a timeout that fires on the
 * normal path is not a safety net, it is a bug that looks like one.
 */
const DEFAULT_STEP_TIMEOUT_MS = 120000

/**
 * How much of a chunk a search result spells out, and how much `fetch_section`
 * returns. Sweepable so the quality-per-token curve can be measured rather than
 * argued: the 1200 default cuts 26.4% of chunks on this corpus, and an
 * identifier sitting past the cut is invisible to the answer even though
 * retrieval found the right section.
 */
const tune = (name, dflt) => {
  const raw = globalThis.process?.env?.[`DOCPILOT_${name}`]
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) ? n : dflt
}
const SEARCH_CHARS = tune('SEARCH_CHARS', 1200)
const FETCH_CHARS = tune('FETCH_CHARS', 4000)

/**
 * The shape the forced final call must produce, enforced server-side by every
 * provider: Ollama's `format`, OpenAI's strict `json_schema`, and — since that
 * API has no schema parameter at all — a forced `answer` tool on Anthropic.
 *
 * `additionalProperties: false` is not decoration: OpenAI rejects a strict
 * schema without it.
 */
/**
 * `citableIds` narrows `citations` to an enum of the ids this turn actually
 * emitted. The set is the same one `finish()` filters against, so what the
 * provider enforces and what the host accepts cannot drift — and the failure
 * that motivated it (a model citing `"1"`, the marker, instead of the id) is
 * now rejected at the provider rather than silently emptying the array here.
 */
const answerSchema = (citableIds) => ({
  type: 'object',
  properties: {
    text: { type: 'string' },
    citations: {
      type: 'array',
      items: citableIds.length ? { type: 'string', enum: citableIds } : { type: 'string' },
    },
    confidence: { type: 'number' },
  },
  required: ['text', 'citations', 'confidence'],
  additionalProperties: false,
})

function observation(tool, scopeLabel, results) {
  return { tool, note: OBS_NOTE, scope: scopeLabel, results }
}

function trim(text, max) {
  return String(text || '').slice(0, max)
}

/**
 * @param {object} retrieval  from createRetrieval()
 * @param {object} gateResult from retrieval.evaluate() — already computed by the caller
 */
export async function runTurn({
  retrieval,
  gateResult,
  question,
  quote = '',
  history,
  addendum,
  config,
  fallback,
  queryVec,
  onPhase,
  onStream,
  signal,
}) {
  const scopeLabel = retrieval.scope?.label || 'All docs'
  const emittedIds = new Set()
  const observations = []
  const trace = []
  let iterations = 0
  let rejectedFetches = 0
  let think = ''

  const debug = (kind, data) => trace.push({ kind, data })

  /**
   * Prompt accounting. Observations are re-sent on EVERY step — buildMessages
   * pushes each one as its own message — so the cost of a turn is the sum over
   * steps, not the size of the last prompt. Without this number a change to
   * maxIterations or to an excerpt trim can only be argued, never measured.
   */
  let promptChars = 0
  let promptCharsPeak = 0
  let steps = 0
  let promptTokens = 0
  let outputTokens = 0
  const measure = (messages) => {
    let n = 0
    for (const m of messages) n += String(m.content || '').length
    promptChars += n
    if (n > promptCharsPeak) promptCharsPeak = n
    steps++
    return messages
  }
  /** Tokens as the SERVER counted them; the character sums stay as a cheap proxy. */
  const charge = (reply) => {
    if (reply?.usage) {
      promptTokens += reply.usage.promptTokens || 0
      outputTokens += reply.usage.outputTokens || 0
    }
    return reply
  }
  const observationChars = () =>
    observations.reduce((a, o) => a + JSON.stringify(o).length, 0)

  /**
   * An excerpt is spelled out once per turn.
   *
   * buildMessages re-sends EVERY accumulated observation on EVERY step, so a
   * chunk that two searches both return is paid for on every remaining call —
   * the cost of a turn grows with the square of its steps, not with the evidence
   * in it. A repeat now carries its id, title and path, which is all the model
   * needs to cite it, and drops the body it has already read.
   *
   * Only NEW observations shrink; the ones already in the transcript are never
   * rewritten. That is deliberate: rewriting the head of the prompt would
   * invalidate the prefix on every provider that caches one, and trade a token
   * saving here for a much larger loss there. `fetch_section` remains the way
   * back to full text.
   */
  const spelled = new Set()
  const excerpt = (c, max) => {
    const head = { id: c.id, title: c.title, breadcrumb: c.breadcrumb, path: c.path }
    if (spelled.has(c.id)) return { ...head, repeated: 'shown in an earlier result' }
    spelled.add(c.id)
    return { ...head, text: trim(c.text, max) }
  }

  // A model that cannot think must not be sent `think` at all — Ollama rejects
  // the field rather than ignoring it, and phi4:14b is exactly that model.
  const thinkable = (value) => (config.llm.thinkSupported === false ? undefined : value)

  /**
   * One model call's deltas, translated for the reader.
   *
   * `text` is always the WHOLE answer so far rather than the increment: the
   * consumer re-renders markdown from it, and a consumer that had to concatenate
   * would drift the moment one frame is dropped. Reasoning is the increment,
   * because nothing re-parses it.
   */
  const streamer = onStream
    ? () => {
        onStream({ start: true })
        return (d) => {
          if (d.thinking) onStream({ thinking: d.thinking })
          if (d.contentSoFar) {
            const text = streamingAnswerText(d.contentSoFar)
            if (text) onStream({ text })
          }
        }
      }
    : () => null

  // Step 1 — priming. The retrieval already performed by the gate is supplied as
  // the first observation, and every id in it, POST-GATE-2 ONLY, enters the
  // citable set. Writing this set before the scope filter would leave a dropped
  // id citable.
  const primed = gateResult.chunks
  for (const c of primed) emittedIds.add(c.id)
  observations.push(
    observation(
      'search_docs',
      scopeLabel,
      primed.map((c) => excerpt(c, SEARCH_CHARS)),
    ),
  )

  const searchCache = new Map()

  async function execute(name, args) {
    if (name === 'search_docs') {
      const key = `${String(args.query || '').trim().toLowerCase()}|${args.kind || ''}`
      if (searchCache.has(key)) {
        // A cache hit cost no iteration and, as far as the reader is concerned,
        // did not happen: it is not reflected in the UI at all.
        debug('cached-search', key)
        return { observation: searchCache.get(key), free: true }
      }
      onPhase?.({ phase: 'searching' })
      const chunks = retrieval.search({ query: args.query || question, queryVec, k: args.k, kind: args.kind })
      for (const c of chunks) emittedIds.add(c.id)
      const obs = observation(
        'search_docs',
        scopeLabel,
        chunks.map((c) => excerpt(c, SEARCH_CHARS)),
      )
      searchCache.set(key, obs)
      if (!chunks.length) obs.note = 'No results in the selected pages.'
      return { observation: obs }
    }

    if (name === 'fetch_section') {
      const res = retrieval.fetch(String(args.id || ''))
      // unknown-id and out-of-scope produce the SAME string: the distinction is
      // information the model has no legitimate use for.
      if (!res.ok) {
        rejectedFetches++
        return { error: 'unknown id', charge: rejectedFetches === 1 }
      }
      if (!emittedIds.has(res.section.id)) {
        rejectedFetches++
        return { error: 'id not available', charge: rejectedFetches === 1 }
      }
      onPhase?.({ phase: 'reading', label: res.section.title })
      // A section fetched in full must not be re-sent, abbreviated, by a later
      // search: the model already has more of it than a search result carries.
      spelled.add(res.section.id)
      return {
        observation: observation('fetch_section', scopeLabel, [
          {
            id: res.section.id,
            title: res.section.title,
            path: res.section.path,
            text: trim(res.section.text, FETCH_CHARS),
          },
        ]),
      }
    }

    if (name === 'list_pages') {
      onPhase?.({ phase: 'listing' })
      return { observation: observation('list_pages', scopeLabel, retrieval.pages(args.prefix)) }
    }

    return { error: `unknown tool ${name}` }
  }

  const maxIterations = config.maxIterations ?? 4

  while (iterations < maxIterations) {
    iterations++
    onPhase?.({ phase: iterations === 1 ? 'searching' : 'thinking' })

    const messages = measure(
      buildMessages({
        scope: retrieval.scope,
        history,
        question,
        quote,
        observations,
        addendum,
        fallback,
        promptListLimit: config.scope?.promptListLimit ?? 12,
        prompt: config.prompt,
        product: config.product,
      }),
    )

    const timeout = AbortSignal.timeout(config.llm.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS)
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout

    const reply = charge(
      await chat({
        provider: config.llm.provider,
        baseURL: config.llm.baseURL,
        model: config.llm.model,
        apiKey: config.llm.apiKey,
        temperature: config.llm.temperature ?? 0.2,
        maxTokens: config.llm.maxTokens,
        numCtx: config.llm.numCtx,
        messages,
        tools: !fallback,
        citableIds: [...emittedIds],
        enableThink: thinkable(false),
        onDelta: streamer(),
        signal: merged,
      }),
    )

    if (reply.think) think = reply.think
    debug('reply', { tool: reply.toolCall?.name, parseError: reply.parseError })

    if (reply.toolCall?.name === 'answer') {
      onPhase?.({ phase: 'writing' })
      return finish(reply.toolCall.args)
    }

    if (reply.toolCall) {
      const res = await execute(reply.toolCall.name, reply.toolCall.args || {})
      if (res.error) {
        observations.push({ tool: reply.toolCall.name, tool_error: res.error })
        // Guessing is never free, but a known weak-model behaviour must not eat
        // the whole budget: only the first rejection in a turn costs a step.
        if (!res.charge) iterations--
      } else {
        observations.push(res.observation)
        if (res.free) iterations--
      }
      continue
    }

    // Free text with no tool call — one forced reminder, then treat it as an
    // answer with no citations, which lands on `not-answerable`.
    if (iterations >= maxIterations) break
    observations.push({ tool: 'system', tool_error: 'Call the answer tool.' })
  }

  // Step 3 — iterations exhausted. ONE final call with a reduced toolset and an
  // explicit "answer from what you already have". Without this the turn ends on
  // an empty answer whenever a model spends its budget on tool calls, which is
  // exactly what a weak model does, and the reader sees a refusal for a question
  // the host had already retrieved the evidence for.
  onPhase?.({ phase: 'writing' })
  try {
    const messages = measure(
      buildMessages({
        scope: retrieval.scope,
        history,
        question,
        quote,
        observations: [
          ...observations,
          { tool: 'system', note: finalNote(question) },
        ],
        addendum,
        fallback,
        promptListLimit: config.scope?.promptListLimit ?? 12,
        prompt: config.prompt,
        product: config.product,
      }),
    )
    const timeout = AbortSignal.timeout(config.llm.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS)
    const final = charge(
      await chat({
        provider: config.llm.provider,
        baseURL: config.llm.baseURL,
        model: config.llm.model,
        apiKey: config.llm.apiKey,
        temperature: config.llm.temperature ?? 0.2,
        maxTokens: config.llm.maxTokens,
        numCtx: config.llm.numCtx,
        messages,
        tools: false,
        answerOnly: true,
        schema: answerSchema([...emittedIds]),
        citableIds: [...emittedIds],
        enableThink: thinkable(config.llm.think ?? true),
        onDelta: streamer(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }),
    )
    if (final.think) think = final.think
    if (final.toolCall?.name === 'answer') return finish(final.toolCall.args)
    // A model that writes prose instead of calling the tool has still answered;
    // it simply has no citations, so validation lands it on `not-answerable`.
    if (final.text.trim()) return finish({ text: final.text, citations: [], confidence: 0.3 })
  } catch (e) {
    debug('final-call-failed', String(e.message || e))
  }

  return finish({ text: '', citations: [], confidence: 0 })

  function finish(args) {
    let citations = Array.isArray(args.citations) ? args.citations.map(String) : []
    let confidence = Number(args.confidence)
    if (!Number.isFinite(confidence)) confidence = 0.5
    const text = String(args.text || '')

    // Membership, never substring: searching serialised observation text would
    // let a chunk that documents this very format launder its own example id.
    const phantom = citations.filter((id) => !emittedIds.has(id))
    citations = citations.filter((id) => emittedIds.has(id))

    // With a reader instruction active, model-reported confidence is discarded:
    // it is the one enforcement input living inside the model's output.
    if (addendum) confidence = Math.min(gateResult.G, gateResult.GUnscoped ?? gateResult.G)

    if (citations.length === 0 && confidence >= 0.4) confidence = 0.3

    const sources = citations
      .map((id) => retrieval.fetch(id))
      .filter((r) => r.ok)
      .map((r) => r.section)

    const support = computeSupport(text, sources, question, config.guard?.supportMinIdentifiers ?? 3)

    return {
      text,
      citations,
      phantom,
      confidence,
      sources,
      iterations,
      rejectedFetches,
      think,
      support,
      trace,
      emitted: [...emittedIds],
      cost: {
        promptTokens,
        outputTokens,
        promptChars,
        promptCharsPeak,
        observationChars: observationChars(),
        answerChars: text.length,
        steps,
      },
    }
  }
}
