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

/** How many result rows a search-only or hybrid settle shows — session.js `RESULTS_K`. */
const RESULTS_K = 8

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
  tools?: { fallback: boolean; known: boolean }
  now?: () => number
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
  const locale = localeOf(detectLanguage(clean))

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
    error: null,
  }

  const settle = (payload) => {
    record.outcome = payload.outcome
    record.refusal = payload.refusal?.cause ?? null
    record.latencyMs = now() - started
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
      try {
        if (composedQuery) {
          ;[queryVec, composedVec] = await embedQuery([clean, composedQuery], target)
        } else {
          queryVec = await embedQuery(clean, target)
        }
      } catch (e) {
        if (signal?.aborted) throw e
        mode = 'lexical-only'
        record.error = `embedder unreachable: ${String(e?.message || e)}`
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
      try {
        composedVec = await embedQuery(composedQuery, target)
      } catch (e) {
        if (signal?.aborted) throw e
        composedVec = undefined
      }
    }

    const g = {
      ...retrieval.evaluate({ question: clean, previousQuestion: antecedent, queryVec, composedVec, mode }),
      antecedent: quote ? 'quote' : previous ? 'question' : null,
    }
    record.gate = logGate(g)
    record.retrievedIds = (g.chunks || []).map((c) => c.id)

    const composedWon = g.channel === 'composed'
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

    /**
     * THE CAPABILITY PROBE — session.js's, once per process.
     *
     * Without it a model that cannot call tools (gemma3 on Ollama answers
     * `does not support tools` with a 400) fails every turn, where the panel
     * would have switched to the JSON fallback the parser recovers. `budget`
     * is off on a server, so `probe` resolves to `'always'` unless the author
     * pooled the chat half — the same rule, read the same way.
     */
    const tools = ctx.tools || { fallback: false, known: false }
    const pooled = !!config.llm.models?.length || config.llm.freePool === true
    const probe = config.budget?.probe === 'always' || (config.budget?.probe === 'auto' && !pooled)
    if (probe && !tools.known) {
      const native = await detectTools({
        provider: config.llm.provider,
        baseURL: config.llm.baseURL,
        model: config.llm.model,
        models: config.llm.models,
        apiKey: config.llm.apiKey,
        signal,
      })
      tools.fallback = native === false
      if (native !== null) tools.known = true
    }

    let lastMessages = null
    const result = await runTurn({
      retrieval,
      gateResult: { ...g, GUnscoped: g.unscopedG ?? g.G },
      question: clean,
      quote,
      history: history.map((t) => ({
        question: t.question,
        answer: t.answer,
        summary: t.summary || null,
        quote: t.quote || '',
        citations: t.citations || [],
      })),
      openerHint,
      addendum: input.addendum,
      config: { ...config, guard: { ...guard, mode: config.guard.mode, supportMinIdentifiers: config.guard.supportMinIdentifiers } },
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
      onStream: (ev) => emit('stream', ev),
      onMessages: ctx.keepMessages ? (m) => (lastMessages = m) : null,
      signal,
    })

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
    return settle({
      ...base,
      outcome: 'answer',
      text: result.text,
      summary: result.summary,
      citations: result.citations,
      confidence: result.confidence,
      tentative: Boolean(notAnswerable),
      notAnswerable,
      sources: result.sources.map(sourceChunk),
    })
  } catch (e) {
    record.latencyMs = now() - started
    if (signal?.aborted) {
      record.outcome = 'aborted'
      ctx.record?.(record)
      throw e
    }
    const rateLimit = e?.rateLimit?.daily ? { resetAt: e.rateLimit.resetAt, limit: e.rateLimit.limit } : null
    record.outcome = rateLimit ? 'rate-limited' : 'error'
    record.error = String(e?.message || e)
    ctx.record?.(record)
    // The reader learns that no model answered and when it will again, never
    // why: a transport message names hosts, and sometimes keys' owners.
    let results = null
    try {
      results = rowsAfterFailure ? rowsAfterFailure() : null
    } catch {
      /* the rows are a courtesy; the error is the contract */
    }
    const payload = { message: 'no model answered', kind: e?.kind || null, rateLimit, results }
    emit('error', payload)
    return { outcome: record.outcome, error: payload }
  }
}
