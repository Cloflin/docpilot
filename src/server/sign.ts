/**
 * Signed history — engine-spec 033, closing security finding F11.
 *
 * WHAT WAS WRONG. The browser sends the conversation back with every turn, and
 * the server put each prior answer into the prompt as an `assistant` message.
 * Nothing said the answer was one this server wrote: anyone with `curl` could
 * send a "previous answer" in which the assistant had already agreed to ignore
 * its instructions, and the model reads its own supposed words as precedent.
 * Spec 028 recorded it as an accepted limit; the turn log then kept the forged
 * turn as training data under `--log-prompts`.
 *
 * THE FIX IS A MAC, NOT A STORE. A server that remembered every answer would
 * need a database and would stop being stateless; instead every settled answer
 * leaves with `sig` — HMAC-SHA256 over the conversation id, the question, the
 * answer and its citations — and the panel sends it back beside the turn. A
 * history entry whose signature verifies is the server's own words and is
 * trusted as before. One that does not — forged, edited, or signed by a
 * process that has since restarted with a different secret — is not dropped:
 * it is DEMOTED, and reaches the model as text the reader's browser quoted,
 * inside the reader's own message. A follow-up still has its antecedent; it no
 * longer has a precedent.
 *
 * The secret is `DOCPILOT_SERVER_SECRET`, or a random one per process. Replicas
 * behind one load balancer need the variable set, or each demotes the others'
 * answers — degraded follow-ups, never a broken turn.
 */

import crypto from 'node:crypto'

import { clampTo } from '../theme/docpilot/prompt.js'

/** The ceiling `input.ts` clamps a returned answer to; signed at the same length. */
export const SIGNED_ANSWER_MAX = 8000

const canonical = (s) => clampTo(String(s ?? ''), SIGNED_ANSWER_MAX).normalize('NFKC').replace(/\s+/g, ' ').trim()

export function signAnswer(secret: string, { conversationId, question, answer, citations }) {
  const body = JSON.stringify([
    String(conversationId || ''),
    canonical(question),
    canonical(answer),
    (citations || []).map(String),
  ])
  return crypto.createHmac('sha256', secret).update(body).digest('base64url')
}

export function verifyAnswer(secret: string, conversationId: string, entry) {
  if (!entry?.sig || typeof entry.sig !== 'string') return false
  const want = signAnswer(secret, { conversationId, question: entry.question, answer: entry.answer, citations: entry.citations })
  const a = Buffer.from(want)
  const b = Buffer.from(entry.sig)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** The process's secret: the operator's, or one nobody else can know. */
export const serverSecret = (env: Record<string, string | undefined>) =>
  env.DOCPILOT_SERVER_SECRET || crypto.randomBytes(32).toString('base64url')
