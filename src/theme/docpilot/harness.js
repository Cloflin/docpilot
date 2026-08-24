/**
 * The agent loop — RAG-SPEC 4.2, 4.3.
 *
 * This module NEVER references the index. It receives the object returned by
 * createRetrieval() and closes its tool executors over it, so `fetch_section`'s
 * existence check is retrieval.fetch(id) rather than index.byId.get(id) and no
 * chunk the retriever did not admit can reach the model. `grep -n '\bindex\b'`
 * over this file returns nothing, and check-docpilot.sh enforces that.
 */

import { budgetPlan } from './budget.js'
import { excerptWindow, TRUNCATED_NOTE } from './excerpt.js'
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
 * How many steps the loop will refund before it stops refunding.
 *
 * Three things below cost nothing: a repeat rejection from `fetch_section`, a
 * search that hits the cache, and a call to a tool that does not exist. Each of
 * them is the right call in isolation — none of them advanced the turn, so none
 * should spend from a four-step budget. Together they were an unbounded loop:
 * a model stuck on one invented id, one repeated query, or one invented tool
 * name refunds every step it takes, and `while (iterations < maxIterations)`
 * never comes due. Every lap is a full `chat()` call, and the per-step timeout
 * bounds the call rather than the loop, so nothing but the reader pressing stop
 * ends it.
 *
 * Past this many refunds the steps start being charged, the budget drains, and
 * the turn is forced to the final answer call the way any other turn is.
 */
const MAX_FREE_STEPS = 5

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

/**
 * The excerpt body, and the note that says it was cut.
 *
 * The cut is head-anchored — see excerpt.js for the measurement that kept it
 * that way. What is new is the note: a chunk that was cut now says so, which is
 * what makes the instruction's `fetch_section` rule observable.
 */
function body(text, max) {
  const w = excerptWindow(text, { max })
  return w.truncated ? { text: w.text, truncated: TRUNCATED_NOTE } : { text: w.text }
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
  // Which model answered, when that was not decided in the config file. A
  // pooled provider picks per call, so the name the panel shows beside a turn —
  // and the name a vote is filed under — has to come from the call rather than
  // from the settings. Absent on every single-model setup.
  onModel,
  onStream,
  signal,
  // What is left of the day's requests, from createBudget(). Absent for the
  // eval runner and for any host that keeps no count, and absent means the same
  // thing an unknown budget means everywhere else: run the turn in full.
  budget = null,
}) {
  const scopeLabel = retrieval.scope?.label || 'All docs'
  const emittedIds = new Set()
  const observations = []
  const trace = []
  let iterations = 0
  let rejectedFetches = 0

  /**
   * The failure that ended the loop, kept only so it can be re-thrown if the
   * final call adds nothing.
   *
   * A loop step that throws no longer ends the turn — the reserved request is
   * for the reader's answer and a burst 429 on a search step must not cost it.
   * But an answer is not what a 401 or a dead endpoint produces either, and
   * returning the empty finish there would report a transport failure as "I
   * couldn't find this in the docs": a claim about the corpus for a turn that
   * never reached a model. So the turn ends the way it used to end whenever the
   * final call could not rescue it, and the way the reader can act on when it
   * could.
   */
  let loopFailure = null

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
   * REQUESTS, which is not `steps`.
   *
   * `steps` counts the chat() calls this module issued; a free tier meters the
   * requests those calls produced, and the two differ exactly where it matters —
   * one pooled call that rotates past two cooling members spends three of the
   * day's fifty. `onHeaders` fires for every response the transport hands back,
   * a 429 included, so this is the only vantage point that sees what was
   * actually charged rather than what was asked for.
   *
   * `spend` is called for every one of them even when the response carried
   * rate-limit headers: the local count is what a provider that publishes no
   * headers leaves us with, and createBudget lets header data win wherever both
   * exist.
   *
   * `kind` travels with the headers because the transport is the only side that
   * read the BODY, and the body is where a service names the window it counted.
   * Handed on unread — this module has no opinion about what a 429 was, and two
   * modules with opinions about one response is the defect this argument exists
   * to close.
   */
  let requests = 0
  const onHeaders = (headers, kind) => {
    requests++
    budget?.spend(1)
    budget?.observe(headers, kind)
  }

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
    return { ...head, ...body(c.text, max) }
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
   *
   * IT RETURNS WHETHER IT PAINTED AN ANSWER, and llm.js rotates on the strength
   * of that. Only the answer counts: `streamingAnswerText` reads the value of one
   * key out of a half-written JSON object, so a model replying in prose streams
   * frames from the first token to the last and puts NOTHING on the screen —
   * which is exactly the reply worth asking the next model for. Reasoning is a
   * progress indicator, and what the turn SETTLES with is the reasoning of the
   * model that produced the answer — `finish(args, think)`, never an
   * accumulator — so painting a candidate's reasoning strands nobody mid-answer
   * and leaves nothing of a loser's behind.
   */
  const streamer = onStream
    ? () => {
        onStream({ start: true })
        return (d) => {
          if (d.thinking) onStream({ thinking: d.thinking })
          if (!d.contentSoFar) return false
          const text = streamingAnswerText(d.contentSoFar)
          if (!text) return false
          onStream({ text })
          return true
        }
      }
    : () => null

  /**
   * A candidate the pool gave up on, and the start of the next one's call.
   *
   * `start` means "a model call is beginning" and the consumer clears the
   * reasoning box on it — but `streamer()` runs once per chat() CALL, and one
   * call may walk several candidates. So a model that streamed its reasoning and
   * then answered in prose, and was rotated past for exactly that, left its
   * thinking on screen beneath the WINNER's answer with a thoughtSeconds count.
   *
   * THIS CLEARS THE SCREEN; `finish(args, think)` DECIDES THE SETTLE. Clearing
   * alone was not enough and shipped as its own defect: the box emptied at the
   * rotation and then refilled at settle from a turn-level accumulator that
   * still held the abandoned candidate's reasoning, so the reader watched a
   * flicker end on the same mis-attribution. The two halves are one rule —
   * reasoning belongs to the model that answered — and each is useless without
   * the other.
   *
   * Only the rotation point knows it happened, so llm.js reports it and this is
   * where the event the consumer already understands gets sent.
   */
  const abandoned = onStream ? () => onStream({ start: true }) : null

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
            ...body(res.section.text, FETCH_CHARS),
          },
        ]),
      }
    }

    if (name === 'list_pages') {
      onPhase?.({ phase: 'listing' })
      return { observation: observation('list_pages', scopeLabel, retrieval.pages(args.prefix)) }
    }

    // Charged. A name that is not in the tool list is a guess, and an uncharged
    // guess is one the model can repeat forever.
    return { error: `unknown tool ${name}`, charge: true }
  }

  /**
   * What this turn may spend. budget.js decides; this module obeys.
   *
   * TWO NUMBERS, and they bound different things. `mode` becomes an ITERATION
   * ceiling: one-shot is zero, the loop below is then false on entry, and
   * control falls through to the forced final call, which already carries the
   * priming retrieval as its first observation, the strict schema and
   * `answerOnly` — a complete turn in one request, assembled from the parts that
   * were already there. `maxRequests` becomes the transport's ceiling, because
   * an iteration ceiling alone bounds nothing a reader pays for: one forced call
   * may rotate a ten-member pool with a continuation each, twenty requests spent
   * by the turn that was rationed to one.
   *
   * AND IT BOUNDS THE LOOP AS WELL, which the sentence above used to leave out
   * and the arithmetic used to show: a ceiling handed only to each call bounds
   * no turn, because the turn decides how many calls to make. See
   * `loopAllowance` — the loop stops while one request is still unspent, and the
   * reader's answer is what that one is for.
   *
   * `config.budget` is absent for the eval runner, which builds its own config
   * and has no reader to ration for. An empty settings object plans agentic,
   * which is also what every provider that publishes no rate-limit headers gets.
   *
   * `llm.freePool` travels beside the block because budget.js will not ration a
   * count it cannot defend, and whether the target is the provider's own free
   * pool is half of what defends one. It is a fact about the deployment rather
   * than a setting, which is why it is not in the block already — and why it is
   * merged here rather than resolved into the block, where a second pass of the
   * resolver would drop it and an author could assert a tier they are not on.
   * `session.js#planSettings` merges the identical pair for the line the panel
   * shows; the two are kept honest by saying so in both files, because the
   * harness is handed a config and never the store.
   */
  const plan = budgetPlan(budget ? budget.snapshot() : null, {
    ...(config.budget || {}),
    freePool: config.llm?.freePool === true,
  })

  const maxIterations = plan.mode === 'one-shot' ? 0 : (config.maxIterations ?? 4)

  /**
   * What is left of that allowance when a call is about to be issued.
   *
   * `plan.maxRequests` is the TURN's number and the loop below makes several
   * calls, so handing it to each of them unchanged gave every call its own copy
   * of the whole allowance. Measured: `budget: {mode: 'agentic'}` — the mode
   * pinned, so the loop still runs — at six answers left plans two requests and
   * spent four, because the final call still had a rotation in hand after two
   * loop steps had each spent one. That is the arithmetic `maxRequests` exists
   * to stop, one level up from where it was being stopped.
   *
   * `requests` is the count `onHeaders` keeps of what the transport actually
   * spent, so this is measured rather than assumed, and `Infinity` — the
   * unrationed turn, which is nearly every turn — stays Infinity.
   */
  const allowance = () => plan.maxRequests - requests

  /**
   * THE LAST REQUEST IS RESERVED FOR THE ANSWER, and the RESERVATION is the
   * mechanism here — not the clamp inside chat().
   *
   * Subtracting `requests` narrowed the overspend without ending it, because the
   * loop was never gated on the allowance at all and chat() floors every finite
   * ceiling at one request: each lap was therefore guaranteed one however far
   * the turn was already overdrawn. Measured at six answers left, which plans
   * two requests: a charged tool call per step spent THREE, and one repeated
   * query — which the free-step refunds keep lapping — spent EIGHT.
   *
   * So the loop gets the allowance LESS ONE, and stops while that one is still
   * unspent. What it buys is the forced final call: that call is the only one
   * whose output the reader reads, and it already carries the priming retrieval,
   * the strict schema and the citable set, so the request held back for it is
   * worth more than any further look for evidence. Ending a turn on "I couldn't
   * find this in the docs" to save a request would be this feature spending the
   * reader's question to protect their quota — which is why chat()'s floor of
   * one survives for that call, and why no loop call may lean on it.
   *
   * `Infinity - 1` is Infinity, so an unrationed turn still runs every iteration
   * it was given.
   */
  const loopAllowance = () => allowance() - 1

  let freeSteps = 0
  /** Give the step back, up to MAX_FREE_STEPS times per turn. */
  const refund = () => {
    if (freeSteps >= MAX_FREE_STEPS) return
    freeSteps++
    iterations--
  }

  while (iterations < maxIterations && loopAllowance() >= 1) {
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

    /**
     * A STEP THAT FAILS ENDS THE STEP, NOT THE TURN.
     *
     * The reservation above holds a request back for the forced final call
     * because that call is where the reader's answer comes from — and a
     * reservation the turn can die before reaching buys nothing. This `await`
     * sat outside any try, so one throw from a loop step exited runTurn with the
     * reserved request unspent and the answer never asked for. Measured at six
     * answers left with a pool of three: a burst 429 on the first loop step
     * rejected the whole turn after one request, and the reader was shown "The
     * AI service didn't respond" for a service that answered on the next
     * attempt. So the failure breaks to the final call instead.
     *
     * TWO FAILURES STILL END THE TURN HERE, and both are the turn's real answer
     * rather than an accident on the way to one:
     *
     *   · the reader pressed stop. Another request is the one thing they asked
     *     for us not to make, and session.js has its own settle for it.
     *   · the DAY's allowance is gone. Every candidate shares one account's
     *     counter, so the final call would spend a request to be told the same
     *     thing, and session.js settles this as 'rate-limited' — the state that
     *     names the hour answers resume. Swallowed into an empty answer it would
     *     read as "I couldn't find this in the docs", which is the one sentence
     *     this whole feature exists to stop printing.
     *
     * Everything else — a burst 429 the transport has already waited out, a
     * dropped socket, a step that ran out of time, a model that will not take
     * the tool schema — is a failure the final call may well get past, and it is
     * cheaper to find out than to lose the turn. `loopFailure` keeps it: if the
     * final call produces nothing either, it is thrown rather than laundered
     * into a refusal about the corpus.
     */
    let reply
    try {
      reply = charge(
        await chat({
          provider: config.llm.provider,
          baseURL: config.llm.baseURL,
          model: config.llm.model,
          models: config.llm.models,
          onModel,
          apiKey: config.llm.apiKey,
          temperature: config.llm.temperature ?? 0.2,
          maxTokens: config.llm.maxTokens,
          numCtx: config.llm.numCtx,
          // The brand's own body fragment, carried through as DATA — the adapter
          // merges it without reading it, which is what keeps this module and
          // providers.js brand-agnostic while OpenRouter still gets the
          // `require_parameters` that makes it honour a response format.
          extraBody: config.llm.extraBody,
          onHeaders,
          continuations: plan.continuations,
          // The turn's allowance, less what the turn has already spent AND less
          // the request reserved for the answer. A loop step that rotates is a
          // step that spends, and a ceiling applied only to the final call would
          // leave the cheap-looking half of the turn unbounded — while a loop step
          // handed the whole remainder can spend the answer's request on a second
          // opinion about which document to read next.
          maxRequests: loopAllowance(),
          messages,
          tools: !fallback,
          citableIds: [...emittedIds],
          enableThink: thinkable(false),
          onDelta: streamer(),
          onAbandon: abandoned,
          signal: merged,
        }),
      )
    } catch (e) {
      if (signal?.aborted || e?.rateLimit?.daily) throw e
      loopFailure = e
      debug('loop-call-failed', String(e?.message || e))
      break
    }

    debug('reply', { tool: reply.toolCall?.name, parseError: reply.parseError })

    if (reply.toolCall?.name === 'answer') {
      onPhase?.({ phase: 'writing' })
      return finish(reply.toolCall.args, reply.think)
    }

    if (reply.toolCall) {
      const res = await execute(reply.toolCall.name, reply.toolCall.args || {})
      if (res.error) {
        observations.push({ tool: reply.toolCall.name, tool_error: res.error })
        // Guessing is never free, but a known weak-model behaviour must not eat
        // the whole budget: only the first rejection in a turn costs a step.
        if (!res.charge) refund()
      } else {
        observations.push(res.observation)
        if (res.free) refund()
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
        models: config.llm.models,
        onModel,
        apiKey: config.llm.apiKey,
        temperature: config.llm.temperature ?? 0.2,
        maxTokens: config.llm.maxTokens,
        numCtx: config.llm.numCtx,
        extraBody: config.llm.extraBody,
        onHeaders,
        // The call that most needs a continuation is this one: it is the only
        // one whose output the reader reads, and a `finishReason: 'length'` here
        // is an answer cut mid-sentence rather than a step to redo.
        continuations: plan.continuations,
        // On a thin budget a prose reply is kept rather than re-asked. It costs
        // its citations — validation lands it on `not-answerable` — but a second
        // request buys a better answer only if there is a second request to
        // spend, and `allowance()` is what the loop above has left of the one
        // the plan gave the turn. The loop stops one short precisely so this is
        // at least 1; it can still arrive at zero or less, because retries are
        // outside the ceiling by decision, and chat()'s floor is what keeps this
        // call — the reader's answer — from being priced out of existence.
        maxRequests: allowance(),
        messages,
        tools: false,
        answerOnly: true,
        schema: answerSchema([...emittedIds]),
        citableIds: [...emittedIds],
        // `thinkable(true)`, not `thinkable(config.llm.think ?? true)`. That
        // read had no writer anywhere — not in `themeDocPilot`, not in a
        // hand-written themeConfig, not in the eval runner's own llm object —
        // so it always resolved to `true`. ui-specs/009's rule 11a is what
        // found it. `thinkSupported` is the switch that does exist, and it
        // answers the question that can actually be answered: whether the
        // MODEL has the capability, rather than whether somebody wanted it.
        enableThink: thinkable(true),
        onDelta: streamer(),
        onAbandon: abandoned,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }),
    )
    if (final.toolCall?.name === 'answer') return finish(final.toolCall.args, final.think)
    // A model that writes prose instead of calling the tool has still answered;
    // it simply has no citations, so validation lands it on `not-answerable`.
    if (final.text.trim()) {
      return finish({ text: final.text, citations: [], confidence: 0.3 }, final.think)
    }
  } catch (e) {
    /**
     * A DAILY limit is the one failure this catch must not absorb.
     *
     * Everything else it absorbs — a step that ran out of time, a dropped
     * socket, the per-minute 429 the transport has already retried — leaves the
     * turn able to end on an honest empty answer, which is why the catch is
     * here. A spent daily quota cannot: the service answered, and it said
     * exactly when it will answer again. Swallowed, that becomes "I couldn't
     * find this in the docs" — a claim about the corpus for a turn that never
     * reached a model, and the one wrong sentence this whole feature exists to
     * stop printing. It travels out to session.js, which reads the error's own
     * `rateLimit` field and settles the turn as 'rate-limited'.
     *
     * ONE-SHOT makes this the only call in the turn, so without it a free tier
     * running dry is indistinguishable from a corpus that says nothing.
     */
    if (e?.rateLimit?.daily) throw e
    // AND THE SAME RULE FOR THE CALL THAT FAILED ON ITS OWN. `loopFailure` held
    // this only for a turn whose LOOP threw, so one-shot — where the loop never
    // runs at all — laundered a rejected key or a dead endpoint into "I couldn't
    // find this in the docs". Measured: the identical 401 threw on an agentic
    // turn and returned an empty, citation-free answer on a one-shot one, which
    // put the wrong sentence in front of exactly the deployment `mode: 'auto'`
    // sends to one-shot for having nearly run out of free answers.
    if (!loopFailure) loopFailure = e
    debug('final-call-failed', String(e.message || e))
  }

  /**
   * Nothing to show, and a failure upstream that explains why.
   *
   * The empty finish is the honest end of a turn whose calls all SUCCEEDED and
   * whose model still wrote nothing — that case is unchanged, and the catch
   * above still absorbs a final call that failed on its own. What must not
   * change is the turn whose LOOP threw: before that throw was caught it left
   * runTurn by itself and session.js reported it, and swallowing it into an
   * empty answer would turn a bad key or a dead endpoint into "I couldn't find
   * this in the docs" — a claim about a corpus nothing ever looked in. So the
   * reserved request is still spent finding out whether the answer's call could
   * get past the failure; when it could not, the turn ends the way it used to.
   */
  if (loopFailure) throw loopFailure

  return finish({ text: '', citations: [], confidence: 0 }, '')

  /**
   * @param {Record<string, any>} args the answer, as the model stated it
   * @param {string} [think] THE REASONING OF THE MODEL THAT PRODUCED THIS ANSWER
   *   and of no other. It is a parameter rather than a turn-level accumulator
   *   because an accumulator is how the wrong model's reasoning got attached: a
   *   turn whose loop step was reasoned by `a` and whose answer came from `b`
   *   kept `a`'s, session.js wrote it to `turn.thought` and stamped it with a
   *   `thoughtSeconds` count, and the reader read one model's thinking above
   *   another's answer. chat() already returns just the winner's `think`; this
   *   is the level that was throwing that away.
   */
  function finish(args, think = '') {
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
      // Outside `cost`, beside it: everything in there is measured in tokens or
      // characters and sweepable against answer quality, and this is the number
      // a free tier actually meters. `cost.steps` stays the count of calls this
      // module made, so the two together say whether the transport rotated.
      requests,
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
