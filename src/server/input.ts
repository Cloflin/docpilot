/**
 * The request body of a server turn, checked — engine-spec 028 §2.
 *
 * The panel sends well-formed bodies; this is for every other client, which is
 * anyone with `curl`. Each field is clamped to what the panel itself could have
 * sent, so a request cannot buy a longer prompt than a reader can: the question
 * and quote by the panel's own ceilings, the history by count and per field,
 * the addendum by `APPEND_MAX`.
 *
 * Returns `{ok, input}` or `{ok: false, error}`, where `error` names the field —
 * the operator reading a 400 is the only person who will ever see it.
 */

import { APPEND_MAX, QUOTE_MAX, clampTo } from '../theme/docpilot/prompt.js'

export const QUESTION_MAX = 2000
export const HISTORY_MAX = 12
/** One prior answer as sent back. Longer than any answer the harness keeps whole. */
const ANSWER_MAX = 8000
const ID_MAX = 128
const PATHS_MAX = 200

const str = (v, max) => (typeof v === 'string' ? clampTo(v, max) : '')
const id = (v) => (typeof v === 'string' && v.length <= ID_MAX && /^[\w.:-]+$/.test(v) ? v : null)
const ids = (v, max = 32) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 300).slice(0, max) : []

export function parseTurnInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' }
  const question = str(body.question, QUESTION_MAX).trim()
  if (!question) return { ok: false, error: 'question: a non-empty string is required' }
  if (body.history != null && !Array.isArray(body.history)) return { ok: false, error: 'history: must be an array' }
  const history = (body.history || []).slice(-HISTORY_MAX).map((t) => ({
    question: str(t?.question, QUESTION_MAX),
    answer: str(t?.answer, ANSWER_MAX),
    summary: str(t?.summary, 600) || null,
    quote: str(t?.quote, QUOTE_MAX),
    citations: ids(t?.citations),
    // The server's MAC over this answer — engine-spec 033. Opaque here; the
    // turn verifies it and demotes the entry when it does not.
    sig: typeof t?.sig === 'string' && t.sig.length <= 128 ? t.sig : null,
    gate: {
      channel: t?.gate?.channel === 'composed' ? 'composed' : t?.gate?.channel === 'raw' ? 'raw' : null,
      antecedent: t?.gate?.antecedent === 'question' || t?.gate?.antecedent === 'quote' ? t.gate.antecedent : null,
    },
  }))
  return {
    ok: true,
    input: {
      messageId: id(body.messageId) || `srv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      conversationId: id(body.conversationId) || 'anonymous',
      question,
      quote: str(body.quote, QUOTE_MAX),
      scope: { paths: ids(body.scope?.paths, PATHS_MAX) },
      history,
      addendum: str(body.addendum, APPEND_MAX),
      lang: typeof body.lang === 'string' && body.lang.length <= 16 ? body.lang : null,
    },
  }
}
