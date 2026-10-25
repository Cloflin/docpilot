/**
 * One turn, on the owner's server — engine-spec 028.
 *
 * THE ORDER IS `session.submit`'s, AND IT IS A COPY. credential → social →
 * lexical opener → embed (both texts, one request) → dense opener → gate →
 * `runTurn`. The modules are the same modules — gate, openers, retriever,
 * harness — so every threshold, lever and prompt decision is shared; only the
 * sequence is restated, the third time after `session.ts` and `eval/run.ts`.
 * Spec 028 records that as the debt it is.
 *
 * WHAT IS DIFFERENT, and why each difference is here rather than in the panel:
 *
 *   · Nothing in the request is trusted. The panel redacts a pasted key before
 *     it sends anything; this redacts again, because a request does not have to
 *     come from the panel.
 *   · The scope is rebuilt from paths against THIS index's manifest. A label or
 *     a kind the browser sent would be a claim about a corpus it never held.
 *   · The budget is off. One key answers every reader; a per-reader allowance
 *     is the reverse proxy's job, where the reader is visible.
 *   · `sources` carry the cited chunks' text, because the browser holds no
 *     shards to look them up in.
 */

import { redactSecrets } from '../theme/docpilot/credentials.js'
import { detectSocial } from '../theme/docpilot/social.js'
import { matchOpener, matchOpenerDense } from '../theme/docpilot/openers.js'
import { embedQuery } from '../theme/docpilot/embed.js'
import { createRetrieval } from '../theme/docpilot/retriever.js'
import { chainAntecedent, composeQuery, enforces } from '../theme/docpilot/gate.js'
import { runTurn } from '../theme/docpilot/harness.js'
import { detectTools } from '../theme/docpilot/llm.js'
import { detectLanguage, localeOf, promptHash } from '../theme/docpilot/prompt.js'
import { resultRows } from '../theme/docpilot/results.js'
import { makeScope } from '../theme/docpilot/scope.js'
import { answerKey, vectorKey, type Lru } from './cache.js'
import { signAnswer, verifyAnswer } from './sign.js'
import type { LeakGuard } from './leak.js'

/** How many result rows a search-only or hybrid settle shows — session.js `RESULTS_K`. */
const RESULTS_K = 8

/**
 * How deep the ranked list the turn record keeps is — engine-spec 029.
 *
 * `eval --runtime=server` scores recall@k, MRR and nDCG off it, so it is the
 * ranking the SERVER produced (its vectors, its levers), not a second ranking
 * the evaluator recomputes beside it. Eight because the retriever clamps
 * `search` there, and `eval` reads recall@8 off the same depth in the browser.
 */
const RANKED_K = 8

/** The capability probe's own ceiling: one tiny request, so a minute is generous. */
const PROBE_TIMEOUT_MS = 60000

/**
 * Query vectors through the process's cache, missing texts in ONE request.
 *
 * A follow-up embeds two texts and usually one of them — the question the last
 * turn already asked, composed differently — is a hit; the miss is then the
 * only text sent, so the cache never costs a request it would not have saved.
 */
async function embedThrough(texts: string[], target, cache: Lru<any> | null, ctx, timing) {
  const out = new Array(texts.length)
  const missing: number[] = []
  texts.forEach((t, i) => {
    const hit = cache?.get(vectorKey(target.model, t))
    if (hit) {
      out[i] = hit
      ctx.metrics?.cacheHit('embed')
    } else {
      missing.push(i)
      if (cache) ctx.metrics?.cacheMiss('embed')
    }
  })
  if (!missing.length) return out
  const signal = ctx.embedTimeoutMs
    ? AbortSignal.any([target.signal, AbortSignal.timeout(ctx.embedTimeoutMs)].filter(Boolean))
    : target.signal
  const asked = missing.map((i) => texts[i])
  const got = asked.length === 1 ? [await embedQuery(asked[0], { ...target, signal })] : await embedQuery(asked, { ...target, signal })
  timing.embedRequests++
  missing.forEach((i, j) => {
    out[i] = got[j]
    cache?.set(vectorKey(target.model, texts[i]), got[j])
  })
  return out
}

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

/**
 * A chunk as the browser needs it to draw a source row and its passage — and
 * nothing the browser could use to rebuild the index: no vector, no tokens.
 */
export function sourceChunk(c) {
  if (!c) return null
  return {
    id: c.id,
    path: c.path,
    anchor: c.anchor || '',
    title: c.title || '',
    breadcrumb: c.breadcrumb || '',
    text: String(c.text || ''),
  }
}

/** `session.priorAntecedent`, over the history the request carried. */
export function antecedentOf(history) {
  const answered = history
    .filter((t) => t.answer && String(t.answer).trim())
    .map((t) => ({
      question: t.question,
      composed: t.gate?.channel === 'composed' && t.gate?.antecedent === 'question',
    }))
  if (answered.length) return chainAntecedent(answered).text
  return history.length ? history[history.length - 1].question : null
}

/** session.js `guard` — the manifest's measurement, the config's override. */
export function guardFor(index, config) {
  const m = index.manifest.guard || {}
  const c = config.guard || {}
  return {
    ...m,
    tau: c.tau ?? m.tau,
    tauLexical: c.tauLexical ?? m.tauLexical,
    source: c.tau != null || c.tauLexical != null ? 'config' : m.source,
  }
}

/** session.js `tuning` — the manifest's levers, `topK` on top. */
export function tuningFor(index, config) {
  const m = index.manifest.tuning || null
  const k = config.topK
  if (typeof k !== 'number' || !Number.isFinite(k)) return m
  return { ...m, GATE_K: Math.min(12, Math.max(1, Math.round(k))), source: 'config' }
}

/** The verdict the browser may see: which channel, not how close to the line. */
const slimGate = (g) =>
  g
    ? {
        pass: Boolean(g.pass),
        channel: g.channel ?? null,
        antecedent: g.antecedent ?? null,
        mode: g.mode ?? null,
        wouldPassUnscoped: Boolean(g.wouldPassUnscoped),
      }
    : null

/** The verdict the log keeps: everything a calibration would want back. */
const logGate = (g) =>
  g
    ? {
        pass: Boolean(g.pass),
        G: g.G ?? null,
        D: g.D ?? null,
        L: g.L ?? null,
        channel: g.channel ?? null,
        antecedent: g.antecedent ?? null,
        mode: g.mode ?? null,
        threshold: g.threshold ?? null,
      }
    : null

export interface ServerTurnInput {
  messageId: string
  conversationId: string
  question: string
  quote: string
  scope: { paths: string[] }
  history: any[]
  addendum: string
  lang: string | null
}

export interface ServerTurnContext {
  index: any
  config: any
  signal?: AbortSignal
  emit: (event: string, data: unknown) => void
  /** Called once with the finished turn record — `docpilot.turn/1`. */
  record?: (record: any) => void
  /** Keep the final prompt on the record — `log.prompts`. */
  keepMessages?: boolean
  /**
   * Whether the model calls tools natively, shared by every turn of one server
   * — session.js's `state.fallback`/`fallbackUnknown`, per process instead of
   * per tab. `known` latches only on a real answer: a probe that reached no
   * model measured nothing.
   */
  tools?: { fallback: boolean; known: boolean; pending?: Promise<boolean | null> | null }
  now?: () => number
  /** Query vectors kept across turns — `server.cache.embeddings`. */
  vectors?: Lru<any> | null
  /** The in-memory counters `GET {endpoint}/metrics` renders. */
  metrics?: { cacheHit(kind: string): void; cacheMiss(kind: string): void } | null
  /** One embedding request's ceiling, retries included. */
  embedTimeoutMs?: number
  /** Fired when the whole turn ran out of time, as opposed to the reader leaving. */
  deadline?: AbortSignal | null
  /** Whole first-turn answers — `server.cache.answers`, off by default. */
  answers?: Lru<any> | null
  /** `server.turn` — how the turn spends its model calls. Absent: the browser's turn. */
  policy?: { loop: 'agentic' | 'one-shot' | 'adaptive'; adaptiveG: number; finalThink: boolean | null } | null
  /**
   * The key answers are signed with — engine-spec 033. With one, a history
   * entry the server did not sign reaches the model as quoted text instead of
   * as its own earlier answer; without one (a caller driving this function
   * directly) history is trusted as it always was.
   */
  secret?: string | null
  /** The owner's private instructions as a detector — engine-spec 033. */
  leak?: LeakGuard | null
}

/**
 * Start the capability probe unless it is known or already on its way — the
 * one copy of the rule, shared by the turn and by the server's boot.
 *
 * Returns nothing: the promise lands on `tools.pending`, and the turn that
 * needs the answer awaits it there. A probe that reached no model resolves
 * `null` and latches nothing, so the next turn asks again.
 */
export function startToolProbe(
  config,
  tools: { fallback: boolean; known: boolean; pending?: Promise<boolean | null> | null },
  { signal = undefined as AbortSignal | undefined, now = Date.now, onTime = null as ((ms: number) => void) | null } = {},
) {
  const pooled = !!config.llm?.models?.length || config.llm?.freePool === true
  const probe = config.budget?.probe === 'always' || (config.budget?.probe === 'auto' && !pooled)
  if (!probe || tools.known || tools.pending || config.searchOnly || !config.llm?.provider) return
  const t0 = now()
  tools.pending = detectTools({
    provider: config.llm.provider,
    baseURL: config.llm.baseURL,
    model: config.llm.model,
    models: config.llm.models,
    apiKey: config.llm.apiKey,
    // Bounded on its own: the probe used to inherit no timeout at all, and a
    // hung provider then held the first turn of a process for as long as the
    // socket stayed open.
    signal: signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
    .catch(() => null)
    .finally(() => onTime?.(now() - t0))
}

/**
 * Run one turn. Emits `phase`/`model`/`member`/`stream` while it works and
 * exactly one `settle` or `error` at the end; returns the settle payload.
 */
export async function runServerTurn(input: ServerTurnInput, ctx: ServerTurnContext) {
  const { index, config, signal, emit } = ctx
  const now = ctx.now || Date.now
  const started = now()
  const manifest = index.manifest

  const { clean, count } = redactSecrets(input.question)
  const quote = redactSecrets(input.quote || '').clean
  const scope = input.scope?.paths?.length ? makeScope(input.scope.paths, manifest) : { ...ALL_SCOPE }
  const history = input.history || []
  const trusted = history.map((t) => (ctx.secret ? verifyAnswer(ctx.secret, input.conversationId, t) : true))
  const locale = localeOf(detectLanguage(clean))
  /** The MAC this turn's answer leaves with, so the next turn can trust it. */
  const sign = (text, citations) =>
    ctx.secret ? signAnswer(ctx.secret, { conversationId: input.conversationId, question: input.question, answer: text, citations }) : null

  const record: any = {
    kind: 'docpilot.turn',
    v: 1,
    at: new Date(started).toISOString(),
    messageId: input.messageId,
    conversationId: input.conversationId,
    question: clean,
    quote,
    lang: locale,
    scope: { kind: scope.kind, paths: scope.paths || [] },
    depth: history.length,
    // How many of the prior answers carried this server's signature. A
    // shortfall is a restarted server, a second replica without the shared
    // secret, or a forged turn — the log is where to tell them apart.
    historySigned: trusted.filter(Boolean).length,
    outcome: null,
    refusal: null,
    gate: null,
    retrievedIds: [],
    emitted: [],
    citations: [],
    answer: '',
    summary: null,
    confidence: null,
    support: null,
    tentative: false,
    iterations: 0,
    requests: 0,
    latencyMs: 0,
    usage: null,
    model: null,
    provider: null,
    embedModel: manifest.embedModel || null,
    indexHash: manifest.hash || null,
    promptHash: promptHash(config.prompt, config.product),
    rankedIds: [],
    /**
     * Where the time went — engine-spec 031. `null` is "this stage did not run
     * on this turn", which an opener or a refusal makes the common case; a zero
     * would read as "ran, and was free".
     */
    timing: {
      embedMs: null,
      embedRequests: 0,
      retrieveMs: null,
      probeMs: null,
      probeWaitMs: null,
      loop: null,
      modelMs: null,
      firstThoughtMs: null,
      firstTokenMs: null,
      totalMs: 0,
    },
    error: null,
  }
  const timing = record.timing

  const settle = (payload) => {
    record.outcome = payload.outcome
    record.refusal = payload.refusal?.cause ?? null
    record.latencyMs = now() - started
    timing.totalMs = record.latencyMs
    emit('settle', payload)
    ctx.record?.(record)
    return payload
  }

  // ── credential: the question is NOT logged, only that one arrived ─────────
  if (count) {
    record.question = ''
    return settle({ outcome: 'credential', refusal: { cause: 'credential' }, gate: null })
  }

  const social = detectSocial(clean, { hasQuote: !!quote })
  if (social) return settle({ outcome: 'social', social: { kind: social.kind }, refusal: { cause: 'social' }, gate: null })

  const openerArgs = { index, config, scope, quote, turns: history, locale, uiLocale: input.lang || locale }
  const opener = matchOpener(clean, openerArgs)
  const fromIds = (ids) => (ids || []).map((id) => index.byId.get(id)).filter(Boolean)

  if (opener?.answer) {
    record.citations = opener.answer.citations
    record.answer = opener.answer.text
    return settle({
      outcome: 'opener',
      opener: { matched: opener.matched, score: opener.score, baked: true },
      text: opener.answer.text,
      citations: opener.answer.citations,
      sources: fromIds(opener.answer.citations).map(sourceChunk),
      gate: slimGate(opener.entry.gate),
      sig: sign(opener.answer.text, opener.answer.citations),
    })
  }

  let mode = 'hybrid'
  let queryVec = null
  let composedVec
  const previous = antecedentOf(history)
  const antecedent = quote || previous
  const composedQuery = composeQuery(clean, antecedent)
  const embedModel = config.embed.model || manifest.embedModel || null
  // THE EMBED HALF'S OWN HOST AND OWN KEY, never the chat half's. A key is an
  // account at one provider: `keyOf` returns null for Ollama, a keyless custom
  // host, or an unset variable, and borrowing the chat key there posts it to a
  // host it was never issued for. The chat half stands in only when the config
  // names no embedder at all — then the chat host IS the embed host.
  const ownEmbed = Boolean(config.embed.provider || config.embed.baseURL)
  const target = {
    provider: config.embed.provider || config.llm.provider,
    baseURL: ownEmbed ? config.embed.baseURL : config.llm.baseURL,
    model: embedModel,
    apiKey: ownEmbed ? config.embed.apiKey ?? null : config.llm.apiKey,
    signal,
  }
  // Hoisted for the catch: a transport failure after retrieval still has the
  // ranked passages to show — session.js's hybrid settle, on the server.
  let rowsAfterFailure = null
  const mismatch = config.embed.model && manifest.embedModel && config.embed.model !== manifest.embedModel

  /**
   * THE CAPABILITY PROBE — session.js's, once per process, and no longer in line.
   *
   * Without it a model that cannot call tools (gemma3 on Ollama answers
   * `does not support tools` with a 400) fails every turn, where the panel
   * would have switched to the JSON fallback the parser recovers. `budget`
   * is off on a server, so `probe` resolves to `'always'` unless the author
   * pooled the chat half — the same rule, read the same way.
   *
   * STARTED HERE, AWAITED BEFORE THE MODEL — engine-spec 031. It used to run
   * after the gate, in series with everything, so the first turn of every
   * process paid one full model round trip before its own first one. Started
   * beside the embedding it costs the turn nothing it was not already waiting
   * for; `createDocPilotServer` starts the same promise at boot, so normally the
   * first reader finds it settled. A turn that ends early (an opener, a refusal)
   * still leaves the answer behind for the next one — the latch is per process.
   */
  const tools = ctx.tools || { fallback: false, known: false, pending: null }
  // Not the turn's signal: the answer is the PROCESS's, and a reader who leaves
  // must not cancel it for the reader behind them.
  startToolProbe(config, tools, { now, onTime: (ms) => (timing.probeMs = ms) })

  /**
   * THE ANSWER CACHE — engine-spec 031, off unless the owner switched it on.
   *
   * After the openers, so an author's own answer still wins, and before the
   * embedding, so a hit costs no request at all. Only a plain first turn is
   * cacheable — `answerKey` returns null for anything with history, a quote, an
   * addendum or a narrowed scope — and only an untentative answer is stored.
   */
  const cacheKey = ctx.answers
    ? answerKey({ ...input, question: clean, quote }, { indexHash: manifest.hash, promptHash: record.promptHash, model: config.llm.model })
    : null
  if (cacheKey) {
    const hit = ctx.answers.get(cacheKey)
    if (hit) {
      ctx.metrics?.cacheHit('answer')
      record.cached = true
      record.citations = hit.citations
      record.answer = redactSecrets(hit.text).clean
      record.summary = hit.summary ?? null
      record.confidence = hit.confidence ?? null
      record.model = config.llm.model || null
      return settle({ ...hit, cached: true, sig: sign(hit.text, hit.citations) })
    }
    ctx.metrics?.cacheMiss('answer')
  }

  try {
    if (config.embed.lexicalOnly || manifest.vectors === null) {
      mode = 'lexical-only'
    } else if (opener?.queryVec) {
      queryVec = opener.queryVec
    } else if (mismatch) {
      mode = 'lexical-only'
      record.error = `index built with ${manifest.embedModel}, config embeds with ${config.embed.model}`
    } else if (!target.baseURL) {
      // Gemini has no direct base a Node tool can reach (`nodeEmbedTarget`).
      // Falling back to the chat host would send this key there.
      mode = 'lexical-only'
      record.error = `embedder ${target.provider} has no host the server can reach`
    } else {
      const t0 = now()
      try {
        if (composedQuery) {
          ;[queryVec, composedVec] = await embedThrough([clean, composedQuery], target, ctx.vectors ?? null, ctx, timing)
        } else {
          ;[queryVec] = await embedThrough([clean], target, ctx.vectors ?? null, ctx, timing)
        }
      } catch (e) {
        if (signal?.aborted) throw e
        mode = 'lexical-only'
        record.error = `embedder unreachable: ${String(e?.message || e)}`
      } finally {
        timing.embedMs = now() - t0
      }
    }

    const guard = guardFor(index, config)
    const retrieval = createRetrieval({ index, scope, guard, tuning: tuningFor(index, config) })

    let openerHint = []
    if (!opener) {
      const dense = matchOpenerDense(queryVec, openerArgs)
      if (dense?.answer) {
        record.citations = dense.answer.citations
        record.answer = dense.answer.text
        return settle({
          outcome: 'opener',
          opener: { matched: dense.matched, score: dense.score, baked: true },
          text: dense.answer.text,
          citations: dense.answer.citations,
          sources: fromIds(dense.answer.citations).map(sourceChunk),
          gate: slimGate(dense.entry.gate),
          sig: sign(dense.answer.text, dense.answer.citations),
        })
      }
      if (dense) {
        const cited = dense.entry.answer?.citations
        const hint = Array.isArray(cited) && cited.length ? cited : dense.entry.ids
        openerHint = hint
          .map((id) => retrieval.fetch(String(id || '')))
          .filter((r) => r.ok)
          .map((r) => r.section)
      }
    }

    if (antecedent && mode === 'lexical-only') {
      composedVec = null
    } else if (antecedent && queryVec && composedVec === undefined) {
      const t0 = now()
      try {
        ;[composedVec] = await embedThrough([composedQuery], target, ctx.vectors ?? null, ctx, timing)
      } catch (e) {
        if (signal?.aborted) throw e
        composedVec = undefined
      } finally {
        timing.embedMs = (timing.embedMs || 0) + (now() - t0)
      }
    }

    const tRetrieve = now()
    const g = {
      ...retrieval.evaluate({ question: clean, previousQuestion: antecedent, queryVec, composedVec, mode }),
      antecedent: quote ? 'quote' : previous ? 'question' : null,
    }
    record.gate = logGate(g)
    record.retrievedIds = (g.chunks || []).map((c) => c.id)

    const composedWon = g.channel === 'composed'
    // The ranking the turn ran on, on the channel it won — what `eval
    // --runtime=server` reads recall@k, MRR and nDCG from.
    record.rankedIds = retrieval
      .search({ query: composedWon ? composedQuery : clean, queryVec: composedWon ? composedVec : queryVec, k: RANKED_K })
      .map((c) => c.id)
    timing.retrieveMs = now() - tRetrieve
    const rows = () =>
      resultRows(
        retrieval.search({
          query: composedWon ? composedQuery : clean,
          queryVec: composedWon ? composedVec : queryVec,
          k: RESULTS_K,
        }),
        { index },
      )
    rowsAfterFailure = rows
    const refusalBase = { scopeLabel: scope.label, scopeKind: scope.kind, closestAreOutside: false }

    if (config.searchOnly) {
      return settle({ outcome: 'results', results: rows(), gate: slimGate(g), noStrongMatches: !g.pass })
    }

    if (enforces(config.guard.mode, g.mode) && !g.pass) {
      const cause = g.wouldPassUnscoped ? 'out-of-scope' : 'no-evidence'
      return settle({
        outcome: 'refused',
        refusal: {
          ...refusalBase,
          cause,
          pagesRead: 0,
          degraded: mode === 'lexical-only' && !config.embed.lexicalOnly,
          closest: retrieval.closest({ query: clean, queryVec, outsideScope: cause === 'out-of-scope' }),
          closestAreOutside: cause === 'out-of-scope',
        },
        gate: slimGate(g),
      })
    }

    // The probe started beside the embedding; this is where its answer is needed.
    if (tools.pending) {
      const pending = tools.pending
      const tWait = now()
      const native = await pending
      // The boot probe's own time belongs to no turn; the part of it THIS turn
      // waited for is this turn's, and on a cold local model it is the load.
      timing.probeWaitMs = now() - tWait
      if (tools.pending === pending) tools.pending = null
      tools.fallback = native === false
      if (native !== null) tools.known = true
    }

    /**
     * THE SERVER'S TURN POLICY — engine-spec 031. One-shot skips the tool loop
     * (`maxIterations: 0` is how the harness already spells one-shot), adaptive
     * does so when the gate's evidence is strong, and `finalThink` reaches the
     * answer call. With no policy the turn is the browser's, call for call.
     */
    const policy = ctx.policy
    const oneShot =
      policy?.loop === 'one-shot' || (policy?.loop === 'adaptive' && Number.isFinite(g.G) && g.G >= policy.adaptiveG)
    timing.loop = policy ? (oneShot ? 'one-shot' : 'agentic') : null
    const turnConfig = {
      ...config,
      ...(oneShot ? { maxIterations: 0 } : {}),
      guard: { ...guard, mode: config.guard.mode, supportMinIdentifiers: config.guard.supportMinIdentifiers },
    }

    let lastMessages = null
    let leakedText = false
    let leakedThought = false
    let thoughtSoFar = ''
    const tModel = now()
    const result = await runTurn({
      retrieval,
      gateResult: { ...g, GUnscoped: g.unscopedG ?? g.G },
      question: clean,
      quote,
      history: history.map((t, i) => ({
        question: t.question,
        answer: t.answer,
        summary: t.summary || null,
        quote: t.quote || '',
        citations: t.citations || [],
        // `prompt.ts` quotes an untrusted answer inside the reader's message
        // rather than replaying it as the model's own turn.
        untrusted: !trusted[i],
      })),
      openerHint,
      addendum: input.addendum,
      config: turnConfig,
      fallback: tools.fallback,
      queryVec: composedWon && composedVec ? composedVec : queryVec,
      composedQuery: composedWon ? composedQuery : null,
      onPhase: (p) => emit('phase', p),
      onModel: (m) => {
        record.model = m
        emit('model', m)
      },
      onMember: (m, i) => {
        record.provider = m.provider
        emit('member', { provider: m.provider, index: i, freePool: Boolean(m.freePool) })
      },
      onStream: (ev) => {
        // THE OWNER'S TEXT DOES NOT STREAM OUT — engine-spec 033. Every frame is
        // checked before it leaves; the first one that carries a run of the
        // private instructions is withheld, and so is every frame after it, on
        // that channel. The settle below replaces the answer.
        if (ctx.leak && !ctx.leak.empty) {
          if (ev?.text != null && !leakedText && ctx.leak.hits(ev.text).length) leakedText = true
          if (ev?.thinking) {
            thoughtSoFar += ev.thinking
            if (!leakedThought && ctx.leak.hits(thoughtSoFar).length) leakedThought = true
          }
          if ((ev?.text != null && leakedText) || (ev?.thinking && leakedThought)) return
        }
        // First reasoning and first ANSWER token, measured where the reader's
        // screen gets them: the frame leaving for the panel.
        if (ev?.thinking && timing.firstThoughtMs == null) timing.firstThoughtMs = now() - started
        if (ev?.text && timing.firstTokenMs == null) timing.firstTokenMs = now() - started
        emit('stream', ev)
      },
      onMessages: ctx.keepMessages ? (m) => (lastMessages = m) : null,
      finalThink: policy?.finalThink ?? true,
      signal,
    })
    timing.modelMs = now() - tModel

    // The settle is checked too: a transport that did not stream (an in-loop
    // tool call on Ollama) produced no frames to withhold.
    if (ctx.leak && !ctx.leak.empty) {
      if (!leakedText && ctx.leak.hits(result.text).length) leakedText = true
      if (!leakedThought && ctx.leak.hits(result.think || '').length) leakedThought = true
    }
    if (leakedThought) result.think = ''
    if (leakedText) {
      record.leakBlocked = true
      result.text = ''
      result.citations = []
    }

    record.emitted = result.emitted
    record.citations = result.citations
    record.answer = redactSecrets(result.text).clean
    record.summary = result.summary
    record.confidence = result.confidence
    record.support = result.support ?? null
    record.iterations = result.iterations
    record.requests = result.requests
    record.usage = {
      promptTokens: result.cost.promptTokens,
      outputTokens: result.cost.outputTokens,
      cachedTokens: result.cost.cachedTokens,
    }
    record.model = record.model || config.llm.model || null
    record.provider = record.provider || config.llm.provider || null
    if (lastMessages) record.messages = lastMessages

    const base = {
      gate: slimGate(g),
      iterations: result.iterations,
      rejectedFetches: result.rejectedFetches,
      support: result.support,
      think: result.think || '',
    }
    const untraceable = !result.text.trim() || !result.citations.length
    const notAnswerable =
      untraceable || result.confidence < 0.4
        ? {
            chars: result.text.trim().length,
            citations: result.citations.length,
            phantom: result.phantom?.length || 0,
            confidence: result.confidence,
            emitted: result.emitted.length,
            iterations: result.iterations,
            kept: !untraceable,
          }
        : null

    if (untraceable) {
      return settle({
        ...base,
        outcome: 'not-answerable',
        notAnswerable,
        refusal: {
          ...refusalBase,
          cause: 'not-answerable',
          pagesRead: new Set(result.emitted.map((id) => id.split('#')[0])).size,
          emittedPaths: [...new Set(result.emitted.map((id) => id.split('#')[0]))],
          degraded: mode === 'lexical-only' && !config.embed.lexicalOnly,
          closest: retrieval.closest({ query: clean, queryVec }),
        },
      })
    }

    record.tentative = Boolean(notAnswerable)
    const answered = {
      ...base,
      outcome: 'answer',
      text: result.text,
      summary: result.summary,
      citations: result.citations,
      confidence: result.confidence,
      tentative: Boolean(notAnswerable),
      notAnswerable,
      sources: result.sources.map(sourceChunk),
      sig: sign(result.text, result.citations),
    }
    if (cacheKey && !notAnswerable) ctx.answers.set(cacheKey, answered)
    return settle(answered)
  } catch (e) {
    record.latencyMs = now() - started
    timing.totalMs = record.latencyMs
    // The deadline aborts the same signal the reader's departure does, so it is
    // told apart here: a reader who left needs no answer, a turn that ran out of
    // time owes the reader one sentence saying so.
    const timedOut = Boolean(ctx.deadline?.aborted)
    if (signal?.aborted && !timedOut) {
      record.outcome = 'aborted'
      ctx.record?.(record)
      throw e
    }
    const rateLimit = e?.rateLimit?.daily ? { resetAt: e.rateLimit.resetAt, limit: e.rateLimit.limit } : null
    record.outcome = rateLimit ? 'rate-limited' : 'error'
    record.error = timedOut ? 'turn deadline exceeded' : String(e?.message || e)
    ctx.record?.(record)
    // The reader learns that no model answered and when it will again, never
    // why: a transport message names hosts, and sometimes keys' owners.
    let results = null
    try {
      results = rowsAfterFailure ? rowsAfterFailure() : null
    } catch {
      /* the rows are a courtesy; the error is the contract */
    }
    const payload = { message: 'no model answered', kind: timedOut ? 'timeout' : e?.kind || null, rateLimit, results }
    emit('error', payload)
    return { outcome: record.outcome, error: payload }
  }
}
