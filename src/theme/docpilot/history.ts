/**
 * The reader's own conversations, kept on their device.
 *
 * TWO STORAGES, ON PURPOSE. The ARCHIVE lives in `localStorage` and is shared by
 * every tab of the site; WHICH conversation a tab is showing lives in that tab's
 * `sessionStorage`. A new tab therefore starts a new conversation instead of
 * adopting the one another tab is mid-way through, and two tabs are two threads
 * by construction — which is the whole reason a shared archive is safe to write.
 *
 * EVERY WRITE IS A READ-MODIFY-WRITE: the list is re-read from storage, this
 * tab's own entry is spliced out, the fresh one goes in front, the caps run, and
 * the result is written back. That leaves one bounded race — two tabs reading
 * before either writes, at the same turn boundary — whose only casualty is the
 * ARCHIVE copy of the losing tab's last turn. That tab's thread in memory is
 * untouched and its next write puts the conversation back. Deleting a
 * conversation another tab is actively using likewise resurrects it on that
 * tab's next write; of the two available failures, resurrecting a live thread
 * beats silently ending a tab's ability to persist anything ever again.
 *
 * THERE IS NO `storage` EVENT LISTENER. The only divergence a reader can observe
 * is a switcher showing a stale list, and that is fixed by re-reading the list
 * when the switcher OPENS — one getItem, no lifecycle. A listener would also
 * have to reconcile a streaming turn here against a delete over there, which is
 * a new state machine, and it would be a module-scope side effect that the
 * node-environment suite has no way to exercise.
 *
 * THERE IS NO TTL, deliberately. The count and byte caps below bound the archive
 * deterministically, and "it fell off the end of a twenty-slot list" is
 * something a reader can reason about where "it disappeared on its own" is not.
 * If a consumer ever needs one it belongs behind an explicit `history.ttlDays`,
 * never as a default.
 *
 * ONE ACCEPTED LOSS: `gate.chunks` is not persisted — it is the retrieved chunk
 * TEXT, kilobytes per turn — so a vote cast on a restored turn reports
 * `retrievedIds: []`. The other six gate fields the feedback record reads are
 * kept, so everything else in that record survives intact.
 *
 * No Vue, no markdown, no direct global access: rehydration into reactive turns
 * and `renderAnswer` stay in session.js. That is what keeps this module a plain
 * unit under vitest's default node environment.
 */

/**
 * One turn as it is written down — the trimmed record, not the live turn.
 *
 * Everything past the first five fields is written under a condition, so the
 * literal in `slimTurn` cannot name them and they are optional here. `SCHEMA`
 * above is what makes a change to this shape safe to ship: an archive written
 * by an older version is read through it or dropped.
 */
export interface StoredTurn {
  id: string
  question: string
  state: string
  answerText: string
  sources: Array<Record<string, unknown>>
  citedIdx?: number[]
  answerHtml?: string
  scope?: { kind?: string; paths?: string[]; label?: string }
  refusal?: unknown
  quote?: string
  credential?: unknown
  social?: unknown
  verdict?: unknown
  reasons?: string[]
  comment?: string
  feedbackRevision?: unknown
  promptStock?: boolean
  promptHash?: string
  tentative?: boolean
  latencyMs?: number
  iterations?: number
  rejectedFetches?: number
  support?: unknown
  gate?: unknown
  opener?: unknown
  notAnswerable?: unknown
}

export const HISTORY_KEY = 'docpilot:history'
export const POINTER_KEY = 'docpilot:conversation'
/** The pre-history per-tab thread, imported once and then removed. */
export const LEGACY_KEY = 'docpilot:session'

/**
 * The envelope's version. A payload that is not this one reads as an empty
 * archive rather than as data. It earns nothing for v1 itself; it exists so a
 * future reader has a versioned thing to migrate FROM, and so a reader served a
 * stale bundle cannot parse a newer payload as if it were this shape.
 */
export const SCHEMA = 1

/**
 * `bytes` is a code constant rather than a setting: localStorage is ~5MB per
 * ORIGIN and this panel is a guest on someone else's docs site, sharing that
 * budget with VitePress, the host theme and `docpilot:feedback`. A tenth of it is
 * a guest-sized share, and no site owner should have to reason about it.
 */
export const LIMITS = { conversations: 20, bytes: 512 * 1024, title: 80, scopePaths: 20 }

/** The seven gate fields `writeFeedback` reads. Everything else on the gate —
 *  the retrieved chunks above all — is diagnostics that cost kilobytes a turn. */
const GATE_KEYS = ['G', 'threshold', 'mode', 'n', 'channel', 'antecedent', 'wouldPassUnscoped']

/**
 * A turn worth restoring has settled. Anything else is coerced or dropped.
 *
 * `'rate-limited'` is on this list because leaving it off made the archive lie
 * about who ended the turn. A daily 429 raised from a loop step AFTER text was
 * painted settles the live turn as 'rate-limited'; that state was not here, so
 * the coercion below stored it as 'aborted' and it came back under
 * `T('turn.stopped')` — "Stopped." — telling the reader they pressed a button
 * they never pressed. The service refused; the reader did nothing.
 */
const TERMINAL = new Set(['complete', 'no-answer', 'aborted', 'error', 'rate-limited'])

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY

function newId() {
  return `c_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The projection that is persisted.
 *
 * Returns null for a turn that carries nothing a reader could read back: a turn
 * still running with no text yet, and a transport error, whose only rendering is
 * one fixed sentence that would restore as a mystery. Being able to return null
 * is what makes an out-of-band save — one taken while a turn is in flight, which
 * switching conversations does — safe rather than lossy.
 */
export function slimTurn(turn, limits = LIMITS) {
  if (!turn) return null
  const answerText = turn.answerText || ''
  const refusal = turn.refusal || null
  if (!answerText && !refusal) return null

  // A turn caught mid-flight settled the moment it was written down. It kept
  // what it had already streamed, which is exactly what `stop()` produces.
  const state = TERMINAL.has(turn.state) ? turn.state : 'aborted'

  /**
   * What a restored 'rate-limited' turn says, and what it deliberately cannot.
   *
   * `turn.rateLimit` — the ceiling and the instant the quota resets — is NOT
   * persisted. The panel renders that instant as a clock time in the reader's
   * locale, and a clock time that has already passed is worse than no line at
   * all; `resetLine` follows the same rule when a 429 carried no reset header,
   * dropping the sentence rather than filling it with a guess. Nothing here has
   * a clock to tell the two apart, and giving one to a pure projection to save a
   * line that expires within the day is the wrong trade.
   *
   * The durable half survives on the state: the day's limit, not the reader,
   * ended this answer. That is the half a thread reopened tomorrow can still
   * check. A rate-limited turn with no text at all never reaches here — it has
   * neither `answerText` nor `refusal`, so the guard above drops it, which is
   * what keeps "the limit is used up" out of an archive read a week later.
   */

  const sources = (turn.sources || []).map((s) => ({
    n: s.n,
    id: s.id,
    href: s.href,
    origin: s.origin || null,
    title: s.title,
    tail: s.tail,
  }))

  const out: StoredTurn = { id: turn.id, question: turn.question, state, answerText, sources }

  // POSITION IS THE MEANING. `cited[i]` is the row citation i+1 resolved to, and
  // two citations into one section share one row — so this is an index per
  // citation, never a filtered list. A row that somehow is not in `sources`
  // stores -1 and restores as null, which deletes that marker: the same thing
  // `linkMarkers` already does for a citation that did not survive validation.
  if (Array.isArray(turn.cited)) {
    out.citedIdx = turn.cited.map((row) => (turn.sources || []).indexOf(row))
  }

  /**
   * The escape hatch for a turn imported from the pre-history payload.
   *
   * `answerHtml` is otherwise recomputed on restore — `renderAnswer` is pure and
   * the index is loaded before any conversation is — which halves the payload.
   * But a legacy turn has `sources` and no `cited`, and re-rendering THAT one
   * strips its citation markers. session.js's `onReady` hook already refuses to
   * re-render exactly this case; keeping the HTML is the same rule, one step
   * earlier. Citation integrity outranks the bytes.
   */
  if (sources.length && !Array.isArray(turn.cited) && turn.answerHtml) {
    out.answerHtml = turn.answerHtml
  }

  if (turn.scope) {
    const paths = turn.scope.paths || []
    out.scope = {
      kind: turn.scope.kind,
      label: turn.scope.label,
      // `turn.scope` is read by one thing — `writeFeedback` — and it caps paths
      // at the same 20. Cutting here changes no behaviour at all.
      paths: paths.slice(0, limits.scopePaths),
    }
  }

  if (refusal) out.refusal = refusal
  // The passage this question was about. Without it a restored thread renders
  // "what does this mean?" above an answer with no `this` anywhere on screen.
  // Bounded at 500 characters by clampQuote before it ever reaches a turn, so it
  // cannot move the byte budget by more than one turn's worth.
  if (turn.quote) out.quote = turn.quote
  if (turn.credential) out.credential = turn.credential
  if (turn.social) out.social = turn.social
  // Provenance only — nothing routes on it after restore, same as `turn.gate`.
  // Without this a reopened thread cannot say whether an opener match fired,
  // which is the one thing that explains why a bare paraphrase like «С чего
  // начать?» got the evidence it did — engine-spec 018.
  if (turn.opener) out.opener = turn.opener
  if (turn.verdict) out.verdict = turn.verdict
  if (turn.reasons?.length) out.reasons = turn.reasons
  if (turn.comment) out.comment = turn.comment
  // NOT OPTIONAL, and the one field here whose absence fails silently. A vote
  // cast on a restored turn that started again from revision 0 is dropped by the
  // receiver's `where excluded.revision >= …` guard — the reader's second
  // opinion never arrives and nothing anywhere reports that it did not.
  if (turn.feedbackRevision) out.feedbackRevision = turn.feedbackRevision
  // The prompt this turn actually ran under. Without it a restored turn reports
  // whatever instruction the reader happens to have set now.
  if (turn.promptStock === false) out.promptStock = false
  if (turn.promptHash) out.promptHash = turn.promptHash
  if (turn.tentative) out.tentative = true
  // Why the post-model check withdrew or hedged this turn — untraceable text,
  // low confidence, or both. Written once at session.ts and, before this, read
  // nowhere: a reopened thread had no way to tell an uncited answer from a
  // hedged one apart from the sentence on screen, which is the same sentence
  // for both.
  if (turn.notAnswerable) out.notAnswerable = turn.notAnswerable
  if (typeof turn.latencyMs === 'number') out.latencyMs = turn.latencyMs
  if (typeof turn.iterations === 'number') out.iterations = turn.iterations
  if (typeof turn.rejectedFetches === 'number') out.rejectedFetches = turn.rejectedFetches
  if (turn.support != null) out.support = turn.support

  if (turn.gate) {
    const gate = {}
    for (const k of GATE_KEYS) if (turn.gate[k] !== undefined) gate[k] = turn.gate[k]
    out.gate = gate
  }

  return out
}

/**
 * The first question, as a row in the switcher.
 *
 * Safe to store verbatim because the question on a turn is already the REDACTED
 * one: `submit()` builds every turn from `redactSecrets`'s output, so a pasted
 * key never reaches a turn and so never reaches a title.
 */
export function conversationTitle(question, max = LIMITS.title) {
  const one = String(question || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (one.length <= max) return one
  const cut = one.slice(0, max)
  const space = cut.lastIndexOf(' ')
  // Cut on a word boundary, unless the boundary is so early that the row would
  // say almost nothing — a single very long token has no boundary to find.
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The two arguments `Intl.RelativeTimeFormat.format` takes.
 *
 * Split out from the formatting so the arithmetic is testable in node while the
 * one line that needs a locale stays in the component. A timestamp in the FUTURE
 * — a clock that was wrong, or a payload written by another machine — reads as
 * "now" rather than as "in 3 hours", which reads as a bug.
 */
export function relativeParts(then, now) {
  const diff = Number(then) - Number(now)
  const ms = diff > 0 ? 0 : diff
  const abs = Math.abs(ms)
  if (abs < MINUTE) return { value: 0, unit: 'second' }
  if (abs < HOUR) return { value: -Math.floor(abs / MINUTE), unit: 'minute' }
  if (abs < DAY) return { value: -Math.floor(abs / HOUR), unit: 'hour' }
  if (abs < WEEK) return { value: -Math.floor(abs / DAY), unit: 'day' }
  return { value: -Math.floor(abs / WEEK), unit: 'week' }
}

/**
 * @param {object} [o]
 * @param {Storage} [o.local]   the archive. Defaults to `globalThis.localStorage`.
 * @param {Storage} [o.session] this tab's pointer. Defaults to sessionStorage.
 * @param {Function} [o.now]    defaults to `Date.now`.
 * @param {object} [o.limits]   defaults to LIMITS.
 *
 * The stores are resolved PER CALL rather than captured at construction: the
 * browser instance below is created at module load, and this module is imported
 * during VitePress's SSR pass, where naming `localStorage` at all is a
 * ReferenceError.
 */
export function createHistory({
  local,
  session,
  now,
  limits,
}: {
  local?: Storage | null
  session?: Storage | null
  now?: () => number
  limits?: Record<string, number>
} = {}) {
  const caps = { ...LIMITS, ...(limits || {}) }
  const clock = now || Date.now

  const store = (given, name) => {
    if (given) return given
    try {
      return globalThis[name] || null
    } catch {
      return null
    }
  }
  const archiveStore = () => store(local, 'localStorage')
  const pointerStore = () => store(session, 'sessionStorage')

  const read = () => {
    try {
      const raw = archiveStore()?.getItem(HISTORY_KEY)
      if (!raw) return []
      const payload = JSON.parse(raw)
      if (payload?.v !== SCHEMA || !Array.isArray(payload.conversations)) return []
      return payload.conversations
    } catch {
      /* private mode, disabled storage, a payload from another version */
      return []
    }
  }

  const attempt = (rows) => {
    try {
      archiveStore()?.setItem(HISTORY_KEY, JSON.stringify({ v: SCHEMA, conversations: rows }))
      return true
    } catch {
      return false
    }
  }

  /** The oldest entry that is not the one being written, or -1. */
  const oldestOther = (rows, keepId) => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].id !== keepId) return i
    return -1
  }

  const dropOldest = (rows, keepId) => {
    const i = oldestOther(rows, keepId)
    if (i < 0) return false
    rows.splice(i, 1)
    return true
  }

  /**
   * Both caps, then the write, then the quota retry.
   *
   * The conversation being written is never the one pruned: overrunning a
   * self-imposed etiquette limit is a smaller failure than deleting the thread
   * the reader is sitting in, so a single conversation larger than the whole
   * budget is still stored.
   */
  const persist = (rows, keepId) => {
    while (rows.length > caps.conversations && dropOldest(rows, keepId));
    while (
      JSON.stringify({ v: SCHEMA, conversations: rows }).length > caps.bytes &&
      dropOldest(rows, keepId)
    );
    if (attempt(rows)) return
    // Quota, or a store that refuses writes at all. One prune, one retry, then
    // the same silence every other store in this package keeps: the thread in
    // memory is unaffected either way.
    if (dropOldest(rows, keepId)) attempt(rows)
  }

  const pointer = () => {
    try {
      return pointerStore()?.getItem(POINTER_KEY) || null
    } catch {
      return null
    }
  }

  const setPointer = (id) => {
    try {
      if (id) pointerStore()?.setItem(POINTER_KEY, id)
      else pointerStore()?.removeItem(POINTER_KEY)
    } catch {
      /* the tab simply forgets which conversation it was in */
    }
  }

  /**
   * Read-modify-write. Mints an id when there is none, keeps the title and
   * creation time of an entry that already exists, and returns the id — or null
   * when there was nothing worth saving. Never throws.
   *
   * Declared here rather than only on the object below because `migrate` calls
   * it, and a method reaching its sibling through `this` breaks the moment
   * anyone destructures the instance.
   */
  const save = ({ id, hash, turns }) => {
    const slim = (turns || []).map((t) => slimTurn(t, caps)).filter(Boolean)
    if (!slim.length) return null
    const rows = read()
    const previous = id ? rows.find((c) => c.id === id) : null
    const entry = {
      id: id || newId(),
      // The title is the FIRST question and does not move as the conversation
      // GROWS: a row that renames itself while the reader is still talking is a
      // row they cannot find again by memory.
      //
      // It does move when that first question is REPLACED. `editTurn` truncates
      // the thread and pushes a turn with a fresh id, so the identity to compare
      // is the id, not the text: a row still titled by a question the reader
      // deleted is the same "cannot find it again", from the other direction.
      title:
        previous?.turns?.[0]?.id === slim[0].id
          ? previous.title
          : conversationTitle(slim[0].question, caps.title),
      createdAt: previous?.createdAt || clock(),
      updatedAt: clock(),
      hash: hash || null,
      turns: slim,
    }
    const next = [entry, ...rows.filter((c) => c.id !== entry.id)]
    persist(next, entry.id)
    return entry.id
  }

  return {
    save,

    /**
     * The one cap a site can set, applied to later writes.
     *
     * A setter rather than a constructor argument because the browser instance
     * is built at module load and the setting only arrives with `configure()` —
     * and rebuilding the instance there would throw away whatever seam a test
     * had put in its place.
     */
    setLimits(next) {
      for (const [k, v] of Object.entries<number>(next || {})) if (v > 0) caps[k] = v
    },

    /** Newest first, without the turns: this feeds a list, not a thread. */
    list() {
      return read().map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        hash: c.hash,
        turnCount: c.turns?.length || 0,
      }))
    },

    current: pointer,

    /** Points this tab at `id` and hands back what is stored under it. */
    open(id) {
      const found = read().find((c) => c.id === id)
      if (!found) {
        if (pointer() === id) setPointer(null)
        return null
      }
      setPointer(id)
      return { id: found.id, hash: found.hash, turns: found.turns || [] }
    },

    remove(id) {
      const rows = read().filter((c) => c.id !== id)
      persist(rows, null)
      if (pointer() === id) setPointer(null)
    },

    /** The reader's Delete all, and what `history.enabled: false` runs. */
    clear() {
      try {
        archiveStore()?.removeItem(HISTORY_KEY)
      } catch {
        /* nothing to do */
      }
      setPointer(null)
    },

    /** A new conversation has no row until it has a turn — this only forgets. */
    start() {
      setPointer(null)
    },

    /**
     * The one-shot import of the pre-history per-tab thread.
     *
     * Runs per TAB, so a reader with three tabs open imports three
     * conversations. That is correct: they were three separate threads.
     */
    migrate() {
      if (pointer()) return null
      let payload = null
      try {
        const raw = pointerStore()?.getItem(LEGACY_KEY)
        if (!raw) return null
        payload = JSON.parse(raw)
      } catch {
        return null
      }
      const id = save({ id: null, hash: payload?.hash, turns: payload?.turns || [] })
      if (id) setPointer(id)
      try {
        pointerStore()?.removeItem(LEGACY_KEY)
      } catch {
        /* the import already happened; a stale key would only re-import once */
      }
      return id
    },

    /** What is stored right now, in UTF-16 code units. For tests and `__docPilot`. */
    bytes() {
      try {
        return archiveStore()?.getItem(HISTORY_KEY)?.length || 0
      } catch {
        return 0
      }
    },
  }
}

/** The browser's instance. The stores resolve lazily, so this line is SSR-safe. */
export const history = createHistory()
