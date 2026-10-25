/**
 * Turn log + votes → training rows: SFT, KTO, DPO.
 *
 * PURE. The caller loads turns, votes, golden.jsonl and the index chunks.
 *
 * Formats (TRL dataset formats; SFT is also OpenAI chat fine-tuning):
 *
 *   sft  {"messages": [system, user, assistant]}
 *   kto  {"prompt": [system, user], "completion": [assistant], "label": bool}
 *   dpo  {"prompt": [system, user], "chosen": [assistant], "rejected": [assistant]}
 *
 * THE PROMPT IS WHAT THE MODEL SAW, when the log has it. A record written with
 * `log.prompts: true` carries the final model call in `messages`, and that is
 * used verbatim minus the final assistant message and minus the prior turns the
 * client sent back (`withoutClientHistory`). Otherwise the prompt is
 * rebuilt from the cited chunks — a reconstruction, which is why a record whose
 * chunks cannot be found is skipped and counted rather than trained on a guess.
 *
 * GOLDEN IS EXCLUDED, ALWAYS. A question that matches a golden one — the same
 * normalised text, or term Jaccard ≥ 0.8 — is dropped before anything else, or
 * `docpilot eval` measures memory instead of the model.
 */

import {redactSecrets} from '../theme/docpilot/credentials.js'
import {fnv1a32, normalise} from '../theme/docpilot/text.js'
import {goldenIndex, inGolden, scopeKey, stripThink, verdictOf, type Turn} from '../traffic/turns.js'

export const DEFAULT_SYSTEM =
  'You answer questions about the documentation using only the numbered context passages. ' +
  'Cite the passages you use. If the context does not contain the answer, say so instead of guessing.'

type Msg = {role: string; content: any; [k: string]: any}

export interface BuildOptions {
  golden?: any[]
  /** chunk id → chunk row; null when the index is unavailable. */
  chunks?: Map<string, any> | null
  system?: string | null
}

const clean = (s: any) => redactSecrets(String(s ?? '')).clean

function redactMessage(m: Msg): Msg {
  if (typeof m.content === 'string') return {...m, content: clean(m.content)}
  if (Array.isArray(m.content)) {
    return {
      ...m,
      content: m.content.map((p) => (p && typeof p.text === 'string' ? {...p, text: clean(p.text)} : p)),
    }
  }
  return {...m}
}

/** The answer a turn gave, without reasoning blocks, redacted; '' when none. */
export function completionOf(t: Turn): string {
  let a = t.answer
  if (a == null && Array.isArray(t.messages)) {
    const last = t.messages[t.messages.length - 1]
    if (last?.role === 'assistant' && typeof last.content === 'string') a = last.content
  }
  return clean(stripThink(a))
}

/**
 * The prompt for one turn, or the reason there is none.
 *
 * `messages` verbatim (minus a trailing assistant message) when logged; else a
 * system message and a user message holding the cited chunks as numbered
 * context blocks, then the question.
 */
/**
 * The logged prompt without the conversation the CLIENT sent back.
 *
 * A server turn is stateless: `history[].answer` and `.summary` arrive in the
 * request body, and `buildMessages` places them as assistant messages. Nothing
 * proves the server ever said them, so an anonymous POST can write "the model's"
 * words into a training row (security report F3/F20). Every assistant message
 * before the turn's own question is such a message. They are dropped, with the
 * user messages that framed them: the system message stays, then everything
 * after the last of them (the addendum, the question, the observations). A
 * follow-up row loses its transcript; it does not gain an author it never had.
 */
export function withoutClientHistory(msgs: Msg[]): {msgs: Msg[]; dropped: number} {
  const lastUser = msgs.map((m) => m?.role).lastIndexOf('user')
  const cut = msgs.slice(0, Math.max(lastUser, 0)).map((m) => m?.role).lastIndexOf('assistant')
  if (cut < 0) return {msgs, dropped: 0}
  const head = msgs[0]?.role === 'system' ? [msgs[0]] : []
  const kept = [...head, ...msgs.slice(cut + 1)]
  return {msgs: kept, dropped: msgs.length - kept.length}
}

export function promptFor(t: Turn, {chunks = null, system = null}: BuildOptions = {}): {prompt: Msg[] | null; skip: string | null; dropped?: number} {
  if (Array.isArray(t.messages) && t.messages.length) {
    let msgs = t.messages.map((m) => redactMessage(m as Msg))
    if (msgs[msgs.length - 1]?.role === 'assistant') msgs.pop()
    const stripped = withoutClientHistory(msgs)
    msgs = stripped.msgs
    if (system != null && msgs[0]?.role === 'system') msgs[0] = {...msgs[0], content: system}
    return msgs.length ? {prompt: msgs, skip: null, dropped: stripped.dropped} : {prompt: null, skip: 'empty messages'}
  }
  if (!chunks) return {prompt: null, skip: 'no index to rebuild the prompt from'}
  const ids = [...new Set(t.citations || [])]
  if (!ids.length) return {prompt: null, skip: 'no cited chunks to rebuild the prompt from'}
  const rows = ids.map((id) => chunks.get(id))
  if (rows.some((r) => !r || typeof r.text !== 'string')) return {prompt: null, skip: 'cited chunks missing from the index'}
  const blocks = rows.map((r, i) => `[${i + 1}] ${r.title || r.path || r.id}${r.breadcrumb ? ` (${r.breadcrumb})` : ''}\n${clean(r.text)}`)
  const quote = t.quote ? `\n\nThe reader quoted:\n> ${clean(t.quote)}` : ''
  return {
    prompt: [
      {role: 'system', content: system ?? DEFAULT_SYSTEM},
      {role: 'user', content: `Context:\n\n${blocks.join('\n\n')}${quote}\n\nQuestion: ${clean(t.question)}`},
    ],
    skip: null,
  }
}

export interface Item {
  record: Record<string, any>
  /** The key the holdout split hashes: conversationId, else messageId. */
  group: string
}

const groupOf = (t: Turn) => t.conversationId || t.messageId

function newCounts() {
  return {
    in: 0,
    notAnswer: 0,
    golden: 0,
    noVote: 0,
    notGoodEnough: 0,
    noPrompt: {} as Record<string, number>,
    noAnswer: 0,
    /** Kept turns whose client-sent transcript was removed from the prompt. */
    historyDropped: 0,
    duplicate: 0,
    out: 0,
  }
}
export type Counts = ReturnType<typeof newCounts>

/** Shared front of every builder: answered, not golden, prompt and completion built. */
function prepare(turns: Turn[], opts: BuildOptions, counts: Counts, keep: (t: Turn) => boolean) {
  const gi = goldenIndex(opts.golden || [])
  const out: Array<{t: Turn; prompt: Msg[]; completion: string}> = []
  for (const t of turns) {
    counts.in++
    if (t.outcome !== 'answer') {
      counts.notAnswer++
      continue
    }
    if (inGolden(t.question, gi)) {
      counts.golden++
      continue
    }
    if (!keep(t)) continue
    const {prompt, skip, dropped} = promptFor(t, opts)
    if (!prompt) {
      counts.noPrompt[skip] = (counts.noPrompt[skip] || 0) + 1
      continue
    }
    if (dropped) counts.historyDropped++
    const completion = completionOf(t)
    if (!completion) {
      counts.noAnswer++
      continue
    }
    out.push({t, prompt, completion})
  }
  return out
}

function uniq(items: Item[], key: (r: Record<string, any>) => string, counts: Counts): Item[] {
  const seen = new Set<string>()
  const out = []
  for (const it of items) {
    const k = key(it.record)
    if (seen.has(k)) {
      counts.duplicate++
      continue
    }
    seen.add(k)
    out.push(it)
  }
  counts.out = out.length
  return out
}

/** Unvoted turns good enough to imitate, for `--include-unvoted`. */
export const goodUnvoted = (t: Turn) =>
  verdictOf(t) == null &&
  t.outcome === 'answer' &&
  (t.citations || []).length >= 1 &&
  (typeof t.support !== 'number' || t.support >= 0.8) &&
  t.tentative !== true

export function buildSft(turns: Turn[], opts: BuildOptions & {includeUnvoted?: boolean} = {}) {
  const counts = newCounts()
  const ready = prepare(turns, opts, counts, (t) => {
    const v = verdictOf(t)
    if (v === 'up') return true
    if (v === 'down') {
      counts.noVote++
      return false
    }
    if (opts.includeUnvoted && goodUnvoted(t)) return true
    if (opts.includeUnvoted) counts.notGoodEnough++
    else counts.noVote++
    return false
  })
  const items = ready.map(({t, prompt, completion}) => ({
    record: {messages: [...prompt, {role: 'assistant', content: completion}]},
    group: groupOf(t),
  }))
  return {items: uniq(items, (r) => JSON.stringify(r.messages), counts), counts}
}

export function buildKto(turns: Turn[], opts: BuildOptions = {}) {
  const counts = newCounts()
  const ready = prepare(turns, opts, counts, (t) => {
    if (verdictOf(t)) return true
    counts.noVote++
    return false
  })
  const items = ready.map(({t, prompt, completion}) => ({
    record: {prompt, completion: [{role: 'assistant', content: completion}], label: verdictOf(t) === 'up'},
    group: groupOf(t),
  }))
  const kept = uniq(items, (r) => JSON.stringify([r.prompt, r.completion]), counts)
  const desirable = kept.filter((i) => i.record.label).length
  const undesirable = kept.length - desirable
  const minority = kept.length ? Math.min(desirable, undesirable) / kept.length : 0
  return {
    items: kept,
    counts,
    balance: {desirable, undesirable, minorityShare: Math.round(minority * 1000) / 1000},
    warning:
      kept.length && minority < 0.1
        ? `label balance ${desirable} true / ${undesirable} false — the smaller class is under 10%. ` +
          'KTO learns from the contrast between the two; collect more ' +
          (desirable < undesirable ? 'up' : 'down') +
          ' votes, or weight the classes (desirable_weight / undesirable_weight in TRL).'
        : null,
  }
}

export function buildDpo(turns: Turn[], opts: BuildOptions = {}) {
  const counts = newCounts()
  const ready = prepare(turns, opts, counts, (t) => {
    if (verdictOf(t)) return true
    counts.noVote++
    return false
  })
  const groups = new Map<string, {up: typeof ready; down: typeof ready}>()
  for (const r of ready) {
    const k = `${normalise(r.t.question)}\u0000${scopeKey(r.t)}`
    const g = groups.get(k) || {up: [], down: []}
    g[verdictOf(r.t) === 'up' ? 'up' : 'down'].push(r)
    groups.set(k, g)
  }
  const items: Item[] = []
  let unpaired = 0
  for (const g of groups.values()) {
    const byAt = (a, b) => a.t.at.localeCompare(b.t.at)
    g.up.sort(byAt)
    g.down.sort(byAt)
    const n = Math.min(g.up.length, g.down.length)
    unpaired += g.up.length + g.down.length - 2 * n
    for (let i = 0; i < n; i++) {
      const chosen = g.up[i]
      const rejected = g.down[i]
      if (chosen.completion === rejected.completion) {
        unpaired += 2
        continue
      }
      items.push({
        record: {
          prompt: chosen.prompt,
          chosen: [{role: 'assistant', content: chosen.completion}],
          rejected: [{role: 'assistant', content: rejected.completion}],
        },
        group: groupOf(chosen.t),
      })
    }
  }
  const kept = uniq(items, (r) => JSON.stringify([r.prompt, r.chosen, r.rejected]), counts)
  return {items: kept, counts, pairs: kept.length, unpaired}
}

/**
 * Deterministic holdout by conversation: every turn of one conversation lands
 * on the same side, so a follow-up cannot leak its first turn into training.
 */
export function inHoldout(group: string, ratio: number): boolean {
  if (!(ratio > 0)) return false
  // FNV-1a alone leaves ids that differ in their last characters ("conv-1",
  // "conv-2") close together in the high bits, and a threshold reads the high
  // bits. The murmur3 finaliser spreads them.
  let h = parseInt(fnv1a32(String(group)), 16)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 0x100000000 < ratio
}

export function splitHoldout(items: Item[], ratio = 0.1) {
  const train = []
  const holdout = []
  for (const it of items) (inHoldout(it.group, ratio) ? holdout : train).push(it.record)
  return {train, holdout}
}
