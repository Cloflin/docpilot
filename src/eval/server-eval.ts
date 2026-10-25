/**
 * `docpilot eval --runtime=server` — the golden set answered by the server turn.
 *
 * WHAT WAS WRONG. `eval` measured the BROWSER pipeline only, through its own
 * restatement of the turn order (`run.ts`), and the server install — engine-spec
 * 028 — had no measurement at all: its turns run `runServerTurn`, which is a
 * third copy of that order with its own differences (credential and social
 * checks, openers, tentative answers, the probe latch). A claim that the server
 * is faster or more accurate needs the server itself on the bench, not a model
 * of it. Engine-spec 029.
 *
 * TWO TRANSPORTS, ONE ROW SHAPE.
 *
 *   · in-process (default): `createDocPilotServer` over the project's own index
 *     and settings, driven through `handle(Request)` — the SSE bytes a panel
 *     would read, parsed by the panel's own `sseParser`. The turn RECORD is
 *     captured through the log sink, so the row carries what the server ranked,
 *     what it spent, and where the time went.
 *   · `--endpoint=<url>`: a server somewhere else, over real HTTP. Only what the
 *     wire carries can be scored — the answer, its citations, the latency a
 *     reader sees — so the retrieval columns are blank, and say so.
 *
 * A conversation is replayed the way the panel holds one: every prior question
 * of a record is asked first, through the same server, and its settled answer
 * goes back in `history` with its summary, citations and gate channel.
 *
 * THE OUTCOME RULE IS `run.ts`'s, so the two runtimes are comparable cell by
 * cell: an answer counts only with text, at least one citation and confidence
 * 0.4 or more. The server ships a lower-confidence answer as `tentative`; it is
 * scored as `refuse:not-answerable` here exactly as the browser half scores it.
 */

import { sseParser } from '../theme/docpilot/remote.js'
import {
  citationPrecision,
  citationRecall,
  contextPrecisionAtK,
  hallucinatedCitationRate,
  identifierRecall,
  languageMatch,
  langOf,
  mrr,
  ndcgAtK,
  pageOf,
  recallAtK,
  retrievalF1Loose,
  scopeContainment,
  tokenF1,
  underPath,
} from './metrics.js'
import { chainDepth, isFollowUp, priorQuestions } from './record.js'

export interface ServerEvalOptions {
  records: any[]
  /** The project's `docPilot` settings. `model` overrides `chat.model` when given. */
  settings: Record<string, any>
  env: Record<string, string | undefined>
  /** The index directory the in-process server reads. */
  indexDir: string
  /** A running server's turn endpoint. When set, nothing runs in-process. */
  endpoint?: string | null
  model?: string | null
  /** `server.turn` for this run — the arm of a policy A/B. */
  turn?: Record<string, unknown> | null
  onRow?: (row: any) => void
  now?: () => number
}

/**
 * The server turn policy an EVAL arm runs under, from the environment.
 *
 * Eval-only, like `DOCPILOT_HISTORY_CONDENSE`: an A/B of `server.turn` should
 * not need two config files, and the report records the arm it ran so two arms
 * never share a name. Null when nothing is set — the project's own policy.
 */
export function evalTurnPolicy(env: Record<string, string | undefined>) {
  const loop = env.DOCPILOT_SERVER_LOOP
  const think = env.DOCPILOT_SERVER_FINAL_THINK
  const g = env.DOCPILOT_SERVER_ADAPTIVE_G
  if (!loop && think == null && !g) return null
  const out: Record<string, unknown> = {}
  if (loop) out.loop = loop
  if (think != null && think !== '') out.finalThink = !/^(0|false|no|off)$/i.test(think)
  if (g) out.adaptiveG = Number(g)
  return out
}

/** One turn over the wire, as the panel reads it. */
async function ask(post, body, now) {
  const t0 = now()
  let settle = null
  let failure = null
  let firstText = null
  let firstThought = null
  let think = ''
  const on = (event, data) => {
    if (event === 'stream') {
      if (data?.text && firstText == null) firstText = now() - t0
      if (data?.thinking) {
        if (firstThought == null) firstThought = now() - t0
        think += data.thinking
      }
    } else if (event === 'settle') settle = data
    else if (event === 'error') failure = data
  }
  const res = await post(body)
  if (!res.ok || !res.body) {
    let detail = ''
    try {
      detail = (await res.json())?.error || ''
    } catch {
      /* not JSON */
    }
    return { settle: null, failure: { message: `HTTP ${res.status}${detail ? ` ${detail}` : ''}` }, ms: now() - t0, firstText, firstThought, think }
  }
  const feed = sseParser(on)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    feed(decoder.decode(value, { stream: true }))
  }
  feed(decoder.decode() + '\n\n')
  return { settle, failure, ms: now() - t0, firstText, firstThought, think: settle?.think || think }
}

/** `run.ts`'s outcome rule, applied to a settle payload. */
export function observedOf(settle, failure) {
  if (!settle) return failure ? 'error' : 'error'
  switch (settle.outcome) {
    case 'answer':
    case 'opener': {
      const ok = String(settle.text || '').trim() && (settle.citations || []).length && (settle.outcome === 'opener' || (settle.confidence ?? 1) >= 0.4)
      return ok ? 'answer' : 'refuse:not-answerable'
    }
    case 'refused':
      return `refuse:${settle.refusal?.cause || 'no-evidence'}`
    case 'not-answerable':
      return 'refuse:not-answerable'
    case 'social':
    case 'credential':
      return `refuse:${settle.outcome}`
    case 'results':
      return 'refuse:results'
    default:
      return 'error'
  }
}

export async function serverRows(o: ServerEvalOptions) {
  const now = o.now || Date.now
  const captured = new Map<string, any>()
  let post
  let close = async () => {}
  if (o.endpoint) {
    post = (body) =>
      fetch(o.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      })
  } else {
    const { createDocPilotServer } = await import('../server/index.js')
    const settings = o.model ? { ...o.settings, chat: { ...(o.settings.chat || {}), model: o.model } } : o.settings
    const dp = await createDocPilotServer({
      // The limiter protects a public port. An evaluation is one trusted
      // client asking hundreds of questions in a row; limited, it would score
      // its own 429s.
      settings: {
        ...settings,
        server: { ...(settings.server || {}), limits: false, ...(o.turn ? { turn: { ...(settings.server?.turn || {}), ...o.turn } } : {}) },
      },
      env: o.env,
      index: o.indexDir,
      log: {
        write: (r) => {
          captured.set(r.messageId, r)
        },
      },
    })
    const url = `http://eval.local${dp.endpoint}`
    post = (body) =>
      dp.handle(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
        }),
        { remoteAddress: '127.0.0.1' },
      )
    close = async () => {}
  }

  const rows = []
  let n = 0
  for (const rec of o.records) {
    n++
    const conversationId = `eval-${rec.id}-${n}`
    const scope = rec.scope || { kind: 'all', paths: [] }
    const history = []
    let primingError = null
    for (const [hop, question] of priorQuestions(rec).entries()) {
      const r = await ask(
        post,
        { messageId: `${conversationId}-p${hop}`, conversationId, question, scope: { paths: scope.paths || [] }, history: [...history] },
        now,
      ).catch((e) => ({ settle: null, failure: { message: String(e?.message || e) } }) as any)
      if (!r.settle && r.failure) {
        primingError = `priming turn ${hop + 1}: ${r.failure.message}`
        break
      }
      const s = r.settle
      if (s?.text?.trim()) {
        history.push({
          question,
          answer: s.text,
          summary: s.summary || null,
          citations: s.citations || [],
          gate: s.gate ? { channel: s.gate.channel ?? null, antecedent: s.gate.antecedent ?? null } : null,
        })
      }
    }

    const messageId = `${conversationId}-q`
    const row: Record<string, any> = {
      id: rec.id,
      question: rec.question,
      kind: rec.kind || null,
      expect: rec.expect,
      scoped: scope.kind !== 'all',
      followUp: isFollowUp(rec),
      depth: chainDepth(rec),
      lang: langOf(rec),
      runtime: 'server',
      gateEnforced: (o.settings.guard?.mode ?? 'off') !== 'off',
    }
    if (primingError) {
      Object.assign(row, { observed: 'error', error: primingError, latencyMs: 0 })
      rows.push(row)
      o.onRow?.(row)
      continue
    }

    let r
    try {
      r = await ask(post, { messageId, conversationId, question: rec.question, scope: { paths: scope.paths || [] }, history }, now)
    } catch (e) {
      Object.assign(row, { observed: 'error', error: String(e?.message || e), latencyMs: 0 })
      rows.push(row)
      o.onRow?.(row)
      continue
    }
    const s = r.settle
    const record = captured.get(messageId) || null
    captured.clear()

    // Gold against scope, the rule `probeRecords` applies (RAG-SPEC 5.1).
    const gold = rec.gold_chunks ?? []
    const goldInScope =
      scope.kind === 'all' || !scope.paths?.length ? gold : gold.filter((gc) => scope.paths.some((p) => underPath(`/${gc}`, p)))
    const scoredAsNegative = gold.length > 0 && goldInScope.length === 0
    const retrievedIds = record?.retrievedIds || []
    const rankedIds = record?.rankedIds || []
    const hasRanking = Boolean(record)

    Object.assign(row, {
      G: record?.gate?.G ?? null,
      D: record?.gate?.D ?? null,
      L: record?.gate?.L ?? null,
      channel: record?.gate?.channel ?? s?.gate?.channel ?? null,
      gatePass: record?.gate ? Boolean(record.gate.pass) : s?.gate ? Boolean(s.gate.pass) : true,
      retrievedIds,
      rankedIds,
      goldPages: [...new Set(goldInScope.map((g) => pageOf(g)))],
      scoredAsNegative,
      retrieval: hasRanking && goldInScope.length ? retrievalF1Loose(retrievedIds, goldInScope) : null,
      recall8: hasRanking && goldInScope.length ? recallAtK(rankedIds, goldInScope, 8) : null,
      recall1: hasRanking && goldInScope.length ? recallAtK(rankedIds, goldInScope, 1) : null,
      recall3: hasRanking && goldInScope.length ? recallAtK(rankedIds, goldInScope, 3) : null,
      recall5: hasRanking && goldInScope.length ? recallAtK(rankedIds, goldInScope, 5) : null,
      mrr: hasRanking && goldInScope.length ? mrr(rankedIds, goldInScope) : null,
      ndcg8: hasRanking && goldInScope.length ? ndcgAtK(rankedIds, goldInScope, 8) : null,
      contextPrecision5: hasRanking && goldInScope.length ? contextPrecisionAtK(rankedIds, goldInScope, 5) : null,
      scopeContainment: hasRanking ? scopeContainment(retrievedIds, scope) : null,
      observed: observedOf(s, r.failure),
      latencyMs: r.ms,
      ttftMs: r.firstText,
      firstThoughtMs: r.firstThought,
      timing: record?.timing ?? null,
      iterations: s?.iterations ?? record?.iterations ?? null,
      requests: record?.requests ?? null,
      rejectedFetches: s?.rejectedFetches ?? 0,
      support: s?.support ?? null,
      cost: record?.usage ?? null,
      outcome: s?.outcome ?? null,
      text: s?.text || '',
      think: r.think || '',
      citations: s?.citations || [],
      error: s ? null : r.failure?.message || 'no settle',
    })
    if (record) {
      row.hallucinated = hallucinatedCitationRate(row.citations, record.emitted || [])
      row.emittedContainment = scopeContainment(record.emitted || [], scope)
    }
    const wantRefusal = rec.expect.startsWith('refuse') || scoredAsNegative
    if (row.observed === 'answer' && !wantRefusal && rec.gold_answer) {
      row.answerF1 = tokenF1(row.text, rec.gold_answer)
      row.identifierRecall = identifierRecall(row.text, rec.identifiers)
      row.language = languageMatch(rec.question, row.text)
      row.citationPrecision = citationPrecision(row.citations, rec.gold_chunks ?? [])
      row.citationRecall = citationRecall(row.citations, rec.gold_chunks ?? [])
    }
    rows.push(row)
    o.onRow?.(row)
  }
  await close()
  return rows
}
