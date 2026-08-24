/**
 * What is left of the day's requests — the free tier's real currency.
 *
 * OpenRouter's free tier caps at 50 REQUESTS a day, not at tokens: the free
 * models offer 128k-512k of context, so context was never what ran out. A turn
 * spends three or four of those requests — the capability probe, up to
 * `maxIterations` loop calls, one forced final call — which is roughly fourteen
 * questions before the panel starts answering "The AI service didn't respond."
 * That sentence is true about the transport and useless to the reader: it names
 * neither what happened nor when it stops happening.
 *
 * This module is the ledger behind the sentence that replaces it, and behind the
 * decisions the harness makes once the day is nearly spent. It is pure apart
 * from one storage seam and it NEVER THROWS — a budget that cannot be read has
 * to leave the panel working, not take it down with it. The same discipline
 * `resolveFeedback` and the history archive keep, for the same reason: a browser
 * with storage disabled is a reader, not a bug report.
 *
 * NO IMPORTS, and none may be added. Three readers share this file — the config
 * resolver in Node, `session.js` in the browser, and `llm.js` on the transport
 * path, which reads the headers of a response it is about to throw away — so it
 * cannot carry a dependency on any of them.
 */

/**
 * OpenRouter's free-tier ceiling, and the only number in this file that comes
 * from a service rather than from a measurement. It is exported rather than
 * assumed: `createBudget` takes the ceiling as an argument, because a site that
 * points DocPilot at some other rate-limited endpoint has a different one, and
 * a self-hosted Ollama has none at all.
 */
export const FREE_TIER_DAILY = 50

/** One key, beside `docpilot:feedback`, `docpilot:history` and the rest. */
const KEY = 'docpilot:budget'

const DAY_MS = 86400000

/**
 * The furthest out a derived reset may sit: a day, plus two hours of slack for a
 * client clock that disagrees with the service's.
 */
const MAX_RESET_MS = DAY_MS + 7200000

/**
 * Below this many answers left, a continuation is the wrong thing to spend one
 * on. Continuing a truncated answer costs a whole request; with two left, a
 * reader is better served by two more questions than by one tidier paragraph.
 */
const CONTINUATION_FLOOR = 2

/**
 * How far out a reset has to be before the window it closes can be believed to
 * be a DAY.
 *
 * nginx, Kong, Tyk, AWS API Gateway and the IETF `RateLimit-*` draft all publish
 * `limit`/`remaining`/`reset` under these names for PER-MINUTE windows, so the
 * three headers say nothing on their own about which unit was counted. Ten
 * minutes is comfortably past every burst window any of them ships with and
 * comfortably short of a day, which is the only distinction that has to hold.
 *
 * Exported because llm.js asks the identical question of a 429's headers, and
 * two files agreeing about what a day looks like by each writing 600000 down is
 * two files that will one day disagree.
 */
export const DAILY_WINDOW_MS = 600000

/** Sentences a service uses for the day. `daily` alone is too broad to be third. */
const DAILY_TEXT = /per-day|per day|free-models-per-day|daily/i

/**
 * WHAT KIND OF LIMIT A RESPONSE JUST STATED — asked once, read by everyone.
 *
 * There used to be two of these, one per file, and they disagreed. llm.js asked
 * `limit_source`, then the message, then the headers, and stopped the retries on
 * a spent day; this file asked the reset alone and dropped anything whose window
 * looked short. One response, both readings, opposite conclusions: a 429 saying
 * `limit_source: 'daily'`, `free-models-per-day`, `remaining: 0` and
 * `retry-after: 120` ended the turn as rate-limited AND left the ledger claiming
 * five answers in hand, so the panel printed "out of free answers until …"
 * beside "5 of 50 left today" and the next question planned a full agentic walk
 * into a spent day. The same drop was deterministic for any daily 429 arriving
 * within ten minutes of its own reset.
 *
 * FOUR RULES, IN ORDER OF HOW MUCH EACH IS WORTH TRUSTING, and the window
 * heuristic is the LAST of them rather than the only one:
 *
 *   1. `error.metadata.limit_source` — where OpenRouter names it outright.
 *   2. the message text — every other service, and OpenRouter itself on the day
 *      it renames a metadata key.
 *   3. the arithmetic: nothing left, and what is left comes back tomorrow.
 *   4. only then the window: a stated reset (or `retry-after`, which is the same
 *      sentence in the form a 429 usually sends it) inside ten minutes is a
 *      burst limit, and a burst limiter's `remaining: 0` is a fact about the
 *      next second rather than about the day.
 *
 * 'unknown' is a real answer and not a failure: a response that states a count
 * and no window at all has not said which window it counted, and neither reader
 * may pretend otherwise — llm.js keeps retrying it as a burst, and this file
 * refuses to ration on it. A burst limiter publishing neither `x-ratelimit-reset`
 * nor `retry-after` is undetectable, and nothing here guesses at it.
 *
 * Pure, and given already-extracted evidence rather than a Response: this module
 * imports nothing and never will, and the transport is the only side that can
 * read a body.
 *
 * @param {{payload?: any, remaining?: number, resetAt?: number}} [evidence]
 *   `payload` is the parsed error body where there is one; `resetAt` is the
 *   instant the window closes, already resolved from `x-ratelimit-reset` or from
 *   `retry-after` by whichever caller had them.
 * @param {number} [now]
 * @returns {'daily'|'burst'|'unknown'}
 */
export function classifyLimit(evidence, now = Date.now()) {
  const e = evidence || {}
  const source = String(e.payload?.error?.metadata?.limit_source || '').toLowerCase()
  if (source.includes('daily')) return 'daily'
  const message = String(e.payload?.error?.message ?? e.payload?.message ?? '')
  if (DAILY_TEXT.test(message)) return 'daily'
  const resetAt = Number(e.resetAt)
  if (!Number.isFinite(resetAt)) return 'unknown'
  if (e.remaining === 0 && resetAt - now >= DAILY_WINDOW_MS) return 'daily'
  return resetAt - now < DAILY_WINDOW_MS ? 'burst' : 'unknown'
}

/** A header value as a Number, or undefined — `''`, null and `'none'` all mean absent. */
function numberOf(value) {
  if (value == null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * The reset header in whichever of its three forms arrived.
 *
 * OpenRouter sends epoch MILLISECONDS, the older convention this copied sends
 * epoch seconds, and a third group sends a delay in seconds. Read as one number
 * they are thirty years apart, so the magnitude decides: past 1e11 is already
 * milliseconds (1973 in seconds, which no service is claiming), past 1e9 is
 * seconds since the epoch (2001), and anything smaller is a delay — nobody
 * schedules a rate limit to lift in 1970.
 *
 * AND THEN CLAMPED, which is not tidying. `x-ratelimit-reset: 3600000` is a
 * plausible millisecond encoding of one hour and lands in the third band, so it
 * reads as a delay of 3.6 million seconds and puts the reset FORTY-ONE DAYS out.
 * `expired()` is the only thing that ever forgets a `remaining: 0` learned
 * beside it, and it is keyed on exactly that instant — so one misread header
 * switches the panel off for six weeks. A client clock running a day slow
 * produces the same shape out of perfectly correct headers. Nothing daily resets
 * further out than a day, so nothing true is lost by refusing to believe it did.
 */
function resetAtOf(value, now) {
  const n = numberOf(value)
  if (n === undefined) {
    // Anthropic-style RFC 3339 instants reach here; Date.parse returns NaN for
    // everything else, which is the same "say nothing" answer as a missing header.
    const t = Date.parse(String(value ?? ''))
    return Number.isFinite(t) ? Math.min(t, now + MAX_RESET_MS) : undefined
  }
  if (n <= 0) return undefined
  const at = n >= 1e11 ? n : n >= 1e9 ? n * 1000 : now + n * 1000
  return Math.min(at, now + MAX_RESET_MS)
}

/**
 * `{limit, remaining, resetAt}` out of a response's rate-limit headers.
 *
 * Every request already carries the answer: the service states the ceiling and
 * what is left of it on the response to the request that just spent one. Nothing
 * was reading them, so the panel could only discover the limit by hitting it —
 * and hitting it costs the reader a question and shows them a transport error.
 *
 * `headers` may be a `Headers` object or a plain object, because the transport
 * has one and tests hand over the other; the lookup is case-insensitive either
 * way. A PARTIAL set is legal and common — some deployments send only
 * `x-ratelimit-remaining` — so a missing field comes back undefined rather than
 * failing the whole read. `null` means the response said nothing about a limit
 * at all, which is not an error: a self-hosted Ollama has no budget to report.
 *
 * `now` is injected because the reset header's third form is a delay in seconds
 * rather than a date, and this module resolves it into an instant so that
 * nothing downstream has to know which form arrived.
 */
export function readLimitHeaders(headers, now = Date.now()) {
  if (!headers || typeof headers !== 'object') return null
  const limit = numberOf(rawHeader(headers, 'x-ratelimit-limit'))
  const remaining = numberOf(rawHeader(headers, 'x-ratelimit-remaining'))
  const resetAt = resetAtOf(rawHeader(headers, 'x-ratelimit-reset'), now)
  if (limit === undefined && remaining === undefined && resetAt === undefined) return null
  return { limit, remaining, resetAt }
}

/**
 * One header by name, from a `Headers` or from a plain object, case-insensitive
 * and never throwing — the transport hands over the first, tests and proxies the
 * second, and a headers object that throws when it is read must not be able to
 * take a reply down with it.
 */
function rawHeader(headers, name) {
  try {
    if (typeof headers.get === 'function') return headers.get(name)
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return headers[key]
    }
    return null
  } catch {
    return null
  }
}

/**
 * What kind of statement this response made, from the headers alone.
 *
 * `observe` is called for every completed response, a 429 included — which is
 * right, since a 429 is the one response that states what is left and when it
 * comes back. But the two 429s a free tier sends are nothing alike, and a BURST
 * limiter's `remaining: 0` is a fact about the next second. Written into a
 * ledger whose subject is the day, it becomes "0 of 20 free answers left today"
 * on the panel and, through `merge`, in every other tab — for a service that
 * will answer again before the reader has finished reading the sentence.
 *
 * `classifyLimit` decides, and the transport reads the same verdict for the same
 * response: `kind` is what llm.js passes down when it has already read the body,
 * and it outranks anything derivable here because the body is where a service
 * NAMES the window. Without it this side sees headers only, which is enough for
 * the burst/day distinction on every response that carries a reset and honestly
 * 'unknown' on the ones that do not.
 */
function statementKind(headers, read, now, kind) {
  if (kind === 'daily' || kind === 'burst' || kind === 'unknown') return kind
  return classifyLimit(
    { remaining: read?.remaining, resetAt: read?.resetAt ?? retryAfterAt(headers, now) },
    now,
  )
}

/**
 * Whether a statement's `remaining` may be read as a count of the DAY.
 *
 * A COUNT IS NOT A BUDGET, and this is the one place that decides which counts
 * are. Two things can make a header count daily, and only two:
 *
 *   · the response NAMED the day — `limit_source`, or a message saying so. That
 *     is a service telling us what it counted, and it outranks any arithmetic.
 *   · the service's own reset is at least ten minutes out. A per-minute window
 *     is exactly the one that puts a reset seconds away.
 *
 * Silence about the window makes a count undefendable; it does not make it
 * daily. That is not a reason to throw the number away — see `snapshot`, which
 * demotes it to the display and leaves the ledger the plan reads alone.
 *
 * @param {{remaining?: number, resetAt?: number, statedDaily?: boolean}|null} s
 * @param {number} now
 */
function defendable(s, now) {
  if (s?.remaining === undefined) return false
  if (s.statedDaily === true) return true
  return Number.isFinite(s.resetAt) && s.resetAt - now >= DAILY_WINDOW_MS
}

/** The instant `retry-after` names, in its delta-seconds form, or undefined. */
function retryAfterAt(headers, now) {
  const n = numberOf(rawHeader(headers, 'retry-after'))
  return n !== undefined && n > 0 ? now + n * 1000 : undefined
}

const fresh = () => ({
  limit: undefined,
  remaining: undefined,
  resetAt: undefined,
  // A count the service reported that nothing can defend — no window it stated,
  // no sentence naming the day — held back from the ledger a plan reads and kept
  // only for the panel. `looseSpent` is its own `headerSpent`: the mark the
  // local count stood at when it landed.
  looseRemaining: undefined,
  looseSpent: undefined,
  // What `spentLocal` read when the service last stated a `remaining`. It is
  // what makes the two halves of this ledger ONE: the count carries on rising
  // across a header observation, and the header's own number is read against the
  // mark rather than against zero, so a request never appears in both.
  headerSpent: 0,
  // WHEN the service last stated a `remaining`, by this client's clock. Two
  // tabs' ledgers are reconciled by value AND by age — see `adopt` — because a
  // pessimistic merge with no notion of age republishes a stale minimum forever.
  observedAt: undefined,
  // WHETHER THE RESPONSE THAT CARRIED IT NAMED THE DAY. `classifyLimit` says so
  // from the body a 429 sends, which is evidence no reset header can supply and
  // no arithmetic can reconstruct: a spent day answering `retry-after: 120` and
  // no reset states its count and hides its window, and without this field the
  // only defence left is the window. Travels with `remaining` everywhere the
  // statement travels — merged with it, expired with it.
  statedDaily: false,
  spentLocal: 0,
  windowEnds: undefined,
})

/**
 * The day's ledger: what the service last said, plus what we have spent since.
 *
 * ONE LEDGER, not two running beside each other. `spend()` counts and
 * `observe()` states, and they used to be independent: the count carried on
 * rising invisibly while a header number was on display, and when the header
 * window closed `snapshot()` revealed a total that had already been charged for
 * once through the header — scarcity that never happened, hours after the
 * requests it was counting. `headerSpent` is the fix and it is one field: the
 * header's number is read against the mark the count stood at when it landed, so
 * the two halves agree on every request instead of each claiming it.
 *
 * `limit` and `remaining` for the same reason always come from the SAME source.
 * Mixing them is what rendered "161 of 50 free answers left today" — a per-minute
 * `remaining` from a header beside a daily ceiling from the config.
 *
 * TWO CLOCKS, deliberately. `resetAt` belongs to the header numbers and may
 * describe a window of any length — plenty of OpenAI-shaped servers report a
 * per-MINUTE allowance under the same header names — while `windowEnds` belongs
 * to the local count and is a day. Sharing one field between them would let a
 * per-minute reset wipe the daily count sixty times an hour, and the count is
 * the only thing an endpoint that sends no headers ever has.
 *
 * HEADER DATA WINS WHERE IT CAN BE DEFENDED, which is nearly everywhere. The
 * local count exists to have something to say before the first response arrives
 * and for services that never say anything; a number the service itself reported
 * supersedes it the moment it lands. The exception is one response and it is
 * exactly the one that used to do the damage: a `remaining` with no window
 * anybody stated is a count of something unknown, and it is DEMOTED rather than
 * discarded — see `snapshot`. It still shows, where it is the lower number; it
 * no longer decides how a turn is spent.
 *
 * @param {object} [o]
 * @param {Storage|null} [o.storage] `null` runs memory-only; omitted uses
 *   localStorage where there is one, so this survives SSR untouched.
 * @param {() => number} [o.now] injectable clock — the same seam
 *   `createHistory({local, session, now})` opens for the archive.
 * @param {number|null} [o.dailyLimit] the local-count ceiling used until headers
 *   teach us otherwise.
 */
export function createBudget({ storage, now = Date.now, dailyLimit = null } = {}) {
  const ceiling = Number.isFinite(dailyLimit) && dailyLimit > 0 ? dailyLimit : null

  // Resolved per call rather than captured at module load: this file is imported
  // during the docs build, where `localStorage` does not exist and asking for it
  // once at the top would be the failure.
  const store = () =>
    storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage

  const clock = () => {
    const t = Number(now())
    return Number.isFinite(t) ? t : Date.now()
  }

  let state = merge(fresh(), stored())
  watch()

  /** Whatever the last tab to write left behind, already expired against now. */
  function stored() {
    try {
      const raw = store()?.getItem(KEY)
      const saved = raw ? JSON.parse(raw) : null
      if (!saved || typeof saved !== 'object') return null
      return expired(
        {
          limit: numberOf(saved.limit),
          remaining: numberOf(saved.remaining),
          resetAt: numberOf(saved.resetAt),
          headerSpent: numberOf(saved.headerSpent) || 0,
          observedAt: numberOf(saved.observedAt),
          // A ledger written before this field existed reads as "the response
          // did not say", which is what it did not say. The window is then the
          // only defence, exactly as it was for that build.
          statedDaily: saved.statedDaily === true,
          // THE DEMOTED COUNT COMES BACK TOO. `write()` serialises the whole
          // state, so the pair was already in storage; leaving it out here is
          // what made a reload forget the lower number the service actually
          // stated and fall back to the local count — the panel promising
          // twenty-eight answers that are gone, which is the exact failure the
          // `else` branch in `observe()` exists to prevent.
          looseRemaining: numberOf(saved.looseRemaining),
          looseSpent: numberOf(saved.looseSpent) || 0,
          spentLocal: numberOf(saved.spentLocal) || 0,
          windowEnds: numberOf(saved.windowEnds),
        },
        clock(),
      )
    } catch {
      return null
    }
  }

  /**
   * Two tabs' ledgers, reconciled — and TWO DOCS TABS IS THE ORDINARY CASE.
   *
   * The whole object used to be written from whatever this tab happened to hold,
   * which is fine for one tab and destroys the day's count with two: a morning
   * tab left idle still believes `remaining` 45, and its first `spend(1)` writes
   * that over the afternoon tab's 2, handing the reader forty-three answers the
   * service will refuse.
   *
   * THE PESSIMISTIC READING WINS WITHIN ONE AGE CLASS, because it is the only
   * one that cannot invent budget that is not there: the LOWER remaining, the
   * HIGHER count, the LATER window end. And `limit`, `remaining` and `resetAt`
   * travel as one — they are a single statement by the service, and picking a
   * lower remaining out of one statement while keeping the limit from another is
   * how a panel comes to describe a fraction neither of them reported.
   */
  function merge(mine, theirs) {
    if (!theirs) return mine
    const out = { ...mine }
    // A COUNT OF REQUESTS MADE, which cannot go down: the maximum wins here
    // whatever the ages are, because this is a tally two tabs each hold part of
    // rather than a statement about what is left.
    out.spentLocal = Math.max(mine.spentLocal || 0, theirs.spentLocal || 0)
    out.windowEnds = later(mine.windowEnds, theirs.windowEnds)
    if (adopt(mine, theirs, clock())) {
      out.limit = theirs.limit
      out.remaining = theirs.remaining
      out.resetAt = theirs.resetAt
      out.headerSpent = theirs.headerSpent
      out.observedAt = theirs.observedAt
      out.statedDaily = theirs.statedDaily === true
    }
    // THE DEMOTED COUNT IS RECONCILED SEPARATELY, and by value rather than by
    // age: it is the half of the ledger that has no `observedAt` — it was
    // demoted precisely because nothing dated or bounded it — so `adopt` has
    // nothing to decide with. What is left is the rule this module falls back on
    // for a statement it cannot date: the pessimistic reading wins, because it
    // is the only one that cannot invent budget that is not there.
    //
    // PROJECTED, not compared raw, and against the MERGED tally: `looseSpent` is
    // the mark its count stood at, so a "2 left" heard at 20 spent and a "5 left"
    // heard at 30 spent only compare once both are carried forward to the same
    // point. And the pair travels as one — a count from one tab against a mark
    // from the other describes a moment neither tab was ever in.
    const project = (s) =>
      s.looseRemaining === undefined
        ? undefined
        : Math.max(0, s.looseRemaining - Math.max(0, out.spentLocal - (s.looseSpent || 0)))
    const ours = project(mine)
    const theirsLoose = project(theirs)
    if (theirsLoose !== undefined && (ours === undefined || theirsLoose < ours)) {
      out.looseRemaining = theirs.looseRemaining
      out.looseSpent = theirs.looseSpent
    }
    return out
  }

  /**
   * Whose statement about the day survives the merge — and NEWEST WINS, not
   * lowest.
   *
   * Comparing only the VALUE of two statements has no notion of which is
   * current, so the tab holding the stale minimum republished it on its next
   * `spend()` and every other tab — and every tab opened afterwards — adopted
   * it. Reproduced over one store: A hears `remaining: 40`, B is still holding
   * an older 2 and spends, and A's next snapshot says 0 of 50. The panel then
   * prints "0 of 50 free answers left today" and plans one-shot for the rest of
   * the day in front of a service with forty in hand.
   *
   * The pessimistic rule survives for statements of the SAME age, which is where
   * it was always right: two tabs that heard from the service in the same
   * instant are two readings of one truth, and the lower cannot invent budget.
   * A statement whose age is unknown — a ledger written before this field
   * existed — is compared by value for the same reason.
   *
   * BUT DEFENSIBILITY OUTRANKS AGE, and that ordering is what keeps newest-wins
   * from being harmful. Newer is a better guide only between statements of the
   * same standing; a count with no stated window is not a statement about the
   * day at all, and letting the most recent of those supersede a daily one the
   * service actually made would hand the reader back a budget that had been
   * spent — a per-minute `remaining: 30` arriving after a daily `remaining: 2`,
   * across two tabs, and the panel plans a full agentic turn on the strength of
   * it. A statement that cannot be defended never supersedes one that can,
   * whatever its age. It is not discarded either: `snapshot` still shows it
   * where it is the lower number.
   */
  function adopt(mine, theirs, now) {
    if (theirs.remaining === undefined) return false
    if (mine.remaining === undefined) return true
    const oursStands = defendable(mine, now)
    const theirsStands = defendable(theirs, now)
    if (oursStands !== theirsStands) return theirsStands
    const ours = mine.observedAt
    const yours = theirs.observedAt
    if (Number.isFinite(ours) && Number.isFinite(yours) && ours !== yours) return yours > ours
    return theirs.remaining < mine.remaining
  }

  /** The later of two window ends, either of which may not exist. */
  function later(a, b) {
    return a === undefined ? b : b === undefined ? a : Math.max(a, b)
  }

  /**
   * Another tab's write, picked up here rather than discovered on the next
   * reload. The `storage` event fires only in the tabs that did NOT write, which
   * is exactly the set that needs telling, and it is free.
   *
   * Inside two try blocks and reachable only where a store exists: a listener is
   * bookkeeping, the answer is the product, and an SSR pass has no `globalThis`
   * with an event target on it at all.
   */
  function watch() {
    try {
      if (!store() || typeof globalThis.addEventListener !== 'function') return
      globalThis.addEventListener('storage', (e) => {
        try {
          if (e?.key && e.key !== KEY) return
          state = merge(expired(state, clock()), stored())
        } catch {
          /* a detached event, or storage refusing to be read — keep what we have */
        }
      })
    } catch {
      /* see above */
    }
  }

  /**
   * The WRITE half. Every mutation pairs it with `pull()` first; `reset()` is the
   * one caller that must not, because merging is exactly what it is undoing.
   */
  function write() {
    try {
      store()?.setItem(KEY, JSON.stringify(state))
    } catch {
      /* quota or private mode — the ledger simply lives for this page's life */
    }
  }

  /**
   * The READ half of read-modify-write, and it has to come FIRST.
   *
   * Merging after the change instead of before loses the change: `spend(1)`
   * against a stored count of 43 takes the higher of 1 and 43 and writes 43,
   * quietly giving the reader back the request they just spent. Pull, then
   * mutate, then write.
   */
  function pull() {
    const other = stored()
    if (other) state = merge(expired(state, clock()), other)
    return state
  }

  /**
   * A window that has already closed is thrown away rather than carried.
   *
   * This is the failure that would be hardest to see and worst to live with: a
   * snapshot saved at 23:59 saying "0 left" is still in storage the next
   * morning, and a panel that reads it switches itself off for a day that has a
   * full allowance in it. Stale is not merely inaccurate here, it is a feature
   * disabling itself.
   *
   * So the header numbers expire even when the service named no reset: they
   * fall back to the local day, which is the only window we have. A
   * `remaining: 0` with nothing beside it saying when would otherwise be
   * believed for the life of the browser profile.
   */
  function expired(s, t) {
    const headerEnds = s.resetAt ?? s.windowEnds
    if (headerEnds !== undefined && headerEnds <= t) {
      s.limit = undefined
      s.remaining = undefined
      s.resetAt = undefined
      // Both marks go with the statement they marked. Left behind, one would be
      // read against the next statement, which stood at a different count, and
      // the other would date a statement that is no longer there.
      s.headerSpent = 0
      s.observedAt = undefined
      // And so does the day the response named: it was a fact about THAT count,
      // and a later count arriving without one must not inherit it.
      s.statedDaily = false
    }
    if (s.windowEnds !== undefined && s.windowEnds <= t) {
      s.spentLocal = 0
      s.headerSpent = 0
      s.windowEnds = undefined
      // The demoted count is a fact about the local day it was heard in: it had
      // no window of its own, which is why it was demoted, so the local one is
      // the only window it can expire with.
      s.looseRemaining = undefined
      s.looseSpent = 0
    }
    return s
  }

  /**
   * The local window is a day ending at the next UTC midnight, because that is
   * when the tier this exists for refills. It opens on the first request rather
   * than at construction: a page nobody asked a question on must not consume a
   * day of the ledger just by being loaded.
   */
  function openWindow(t) {
    if (state.windowEnds === undefined) state.windowEnds = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS
  }

  /**
   * What the ledger has to say, in the two forms it has to say it in.
   *
   * A STATEMENT'S VALUE AND ITS DEFENSIBILITY ARE SEPARATE QUESTIONS, and
   * conflating them is how learning more used to switch the protection off.
   * `remaining: 3` with no reset beside it either REPLACED the local count and
   * made the whole snapshot a header snapshot — which `trustworthy` then refused
   * as undefendable, so the turn planned agentic and unbounded — or, if the
   * header had been believed, would have rationed a self-hosted deployment on a
   * number that was counting a minute. Measured: a free pool at ceiling 50 with
   * 47 counted locally, then one response stating `x-ratelimit-remaining: 3` and
   * no reset. The same number, twice: from the count it planned {one-shot,
   * maxRequests 2}, and from the service saying it, {agentic, Infinity} — with
   * "3 of 50 free answers left today" on the panel beside the unbounded plan.
   *
   * SO AN UNDEFENDABLE HEADER IS DEMOTED, NEVER DISCARDED. It keeps the display
   * where it is the lower number, because a service saying three is a reason for
   * caution whatever window it counted; and the ledger the PLAN reads stays the
   * one this module can defend — the local count against a ceiling somebody
   * stated. `defensibleRemaining` is that number and `remaining` is the panel's,
   * and they differ on exactly one kind of response.
   *
   * The pair `limit`/`remaining` still comes from ONE source, which is what
   * stopped "161 of 50 free answers left today": a demoted count is shown
   * against the local ceiling it was compared with, and the comparison is a
   * minimum, so it can never render as more than the ceiling.
   */
  function snapshot() {
    const t = clock()
    state = expired(state, t)
    // Not "the headers said something" but "what they said stands as a statement
    // about the day" — see `defendable`.
    const fromHeader = defendable(state, t)
    // The requests made since the service last stated a number — the ones it
    // has not had the chance to account for yet, and the only ones the header
    // number has to be reduced by.
    const since = Math.max(0, state.spentLocal - (state.headerSpent || 0))
    const stated = state.remaining === undefined ? undefined : Math.max(0, state.remaining - since)
    const local = ceiling === null ? undefined : Math.max(0, ceiling - state.spentLocal)
    // The demoted display: the lower of what we counted and what the service
    // said, and the service's own number when we counted nothing at all.
    // A demoted count, carried forward the way `stated` is: against the mark the
    // local count stood at when the service reported it.
    const loose =
      state.looseRemaining === undefined
        ? undefined
        : Math.max(0, state.looseRemaining - Math.max(0, state.spentLocal - (state.looseSpent || 0)))
    const lowest = (...ns) => {
      const real = ns.filter((n) => n !== undefined)
      return real.length ? Math.min(...real) : undefined
    }
    const shown =
      fromHeader || local === undefined
        ? lowest(stated, loose)
        : stated === undefined
          ? lowest(local, loose)
          : lowest(local, stated, loose)
    return {
      // NEVER the ceiling beside a header `remaining` this module is acting on:
      // one is a day and the other may be a minute, and the pair renders as a
      // fraction the service never reported. A header that stated no limit shows
      // no limit.
      limit: fromHeader ? state.limit : (ceiling ?? state.limit),
      remaining: shown,
      // THE COUNT A PLAN MAY BE BUILT ON, which is the same number as `remaining`
      // on every response but one: a header count with no window anybody stated.
      // `budgetPlan` reads this and the panel reads the other.
      defensibleRemaining: fromHeader ? stated : local,
      resetAt: state.resetAt ?? state.windowEnds,
      // WHERE THAT INSTANT CAME FROM, which is a different question from where
      // `remaining` came from and used to be unanswerable. The fallback above is
      // the LOCAL day — the only window there is when the headers named no
      // reset — and `trustworthy` was reading it as though the service had
      // stated it, validating this module's own substitution. Nothing daily is
      // being asserted by a window nobody reported.
      resetSource:
        state.resetAt !== undefined
          ? 'header'
          : state.windowEnds !== undefined
            ? 'local'
            : undefined,
      // WHAT `defensibleRemaining` IS, which is what a caller asking about the
      // source is deciding on: 'local' is a count we made against a ceiling
      // somebody stated, 'header' is a number the service stated about the day,
      // 'unknown' is the honest answer for every deployment that reports nothing
      // and has no ceiling set — and now also for a header count with no window,
      // where the number on display is real and there is still nothing here a
      // plan may be built on.
      source: fromHeader ? 'header' : local !== undefined ? 'local' : 'unknown',
      // Whether the response that carried this count NAMED the day. Reported
      // because `trustworthy` is exported and asks the same question of
      // snapshots this ledger never built, and a count defended by a sentence
      // rather than by a reset would otherwise lose that defence on the way out.
      statedDaily: fromHeader && state.statedDaily === true,
      spentLocal: state.spentLocal,
    }
  }

  return {
    snapshot,

    /**
     * Learn from a completed response. Anything the headers omit is left alone.
     *
     * `kind` is `classifyLimit`'s verdict on this response, passed down by the
     * transport because the transport is the side that read the BODY — and the
     * body is where a service names the window. Omitted (a caller with headers
     * and nothing else) the same function is asked here, from the headers alone.
     * What must never happen again is this file deciding the question a second
     * way: one response classified 'daily' by llm.js and 'about a minute' here
     * ended a turn as rate-limited while the ledger went on claiming five
     * answers in hand.
     *
     * @param {Headers|Record<string, any>} headers
     * @param {'daily'|'burst'|'unknown'} [kind]
     */
    observe(headers, kind) {
      const t = clock()
      state = expired(pull(), t)
      let read = readLimitHeaders(headers, t)
      const said = statementKind(headers, read, t, kind)

      // A DAILY 429 IS ITSELF THE COUNT. The service has just refused a request
      // on the grounds that the day is gone, and it is under no obligation to
      // restate that in `x-ratelimit-remaining` — OpenRouter's own spent-day
      // reply may carry nothing but `retry-after`. Read as "no numbers here"
      // the ledger learned nothing from the one response that knows the most,
      // and the panel printed "43 of 50 left today" beside its own "out of free
      // answers until …" while the next question planned a full agentic walk.
      if (said === 'daily' && read?.remaining === undefined) {
        read = {
          limit: read?.limit ?? state.limit,
          remaining: 0,
          resetAt: read?.resetAt ?? retryAfterAt(headers, t),
        }
      }
      if (!read) return snapshot()

      // A STATEMENT ABOUT A MINUTE IS NOT A STATEMENT ABOUT THE DAY, and this
      // ledger's whole subject is the day. Dropped whole rather than in part:
      // the three fields are one sentence by the service, and half of a burst
      // limiter's sentence is not a fact about anything.
      if (said === 'burst') return snapshot()

      if (read.limit !== undefined) state.limit = read.limit

      if (read.remaining !== undefined) {
        // CAN THIS STATEMENT DEFEND ITSELF? Asked of the statement alone, never
        // of the merged ledger. Asked of the merge, a reset-less count inherited
        // the window of the statement it was replacing and was defended by it,
        // so "defendable" stopped being a property of the thing being judged.
        const alone = {
          remaining: read.remaining,
          resetAt: read.resetAt,
          statedDaily: said === 'daily',
        }
        if (defendable(alone, t) || !defendable(state, t)) {
          state.remaining = read.remaining
          // The count carries on; where it stood is remembered instead. This is
          // what stops the request that produced these headers being charged
          // once by the service's own number and again by ours.
          state.headerSpent = state.spentLocal
          // And WHEN it was heard, which is what lets another tab's older number
          // lose the merge instead of overwriting this one. It dates `remaining`
          // specifically — that is the field `adopt` decides between.
          state.observedAt = t
          // AND WHETHER THE RESPONSE NAMED THE DAY. A spent day that answers
          // `retry-after: 120` and no reset states its count and hides its
          // window; without this the count would be undefendable for want of a
          // header the service was never obliged to send.
          state.statedDaily = alone.statedDaily
          // THE WINDOW TRAVELS WITH THE COUNT IT DESCRIBES, so a later statement
          // cannot be judged by an earlier statement's reset.
          state.resetAt = read.resetAt
          state.looseRemaining = undefined
          state.looseSpent = undefined
        } else {
          // AND WHEN IT CANNOT, IT DOES NOT GET TO OVERWRITE ONE THAT COULD.
          // Demoted to the display, where it still counts for something: a
          // number the service reported is worth showing when it is the lower
          // of the two, and worth nothing at all when a plan is being built on
          // it. Measured, this is a daily "2 left" followed by a reset-less
          // "30" — which used to hand back twenty-eight answers that were gone.
          state.looseRemaining = read.remaining
          state.looseSpent = state.spentLocal
        }
      } else if (read.resetAt !== undefined) {
        state.resetAt = read.resetAt
      }
      openWindow(t)
      write()
      return snapshot()
    },

    /** Count a request the service will not tell us about. */
    spend(n = 1) {
      const t = clock()
      const count = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 1
      // Nothing to charge is nothing to write.
      if (!count) return snapshot()
      state = expired(pull(), t)
      state.spentLocal += count
      openWindow(t)
      write()
      return snapshot()
    },

    /**
     * True only when the budget is KNOWN to be gone. An unknown budget is not
     * spent.
     *
     * NOTHING CALLS IT, and that is the right number of callers. Refusing a turn
     * off this count would refuse one the service would have answered — the
     * count is a local reading of an account-wide allowance, so it is wrong
     * whenever another browser profile, another tab that never wrote, or the
     * site's own CLI has been asking too. The service's 429 is the only refusal
     * that is never a guess, and the panel already has a good answer for it. This
     * is here for a caller who wants to say something BEFORE spending a request
     * rather than instead of spending one.
     */
    exhausted() {
      // KNOWN to be gone, so it reads the defensible count rather than the
      // display: a per-minute `remaining: 0` on the panel is a caution, not a
      // spent day, and this answers only the second question.
      const s = snapshot()
      return s.defensibleRemaining !== undefined && s.defensibleRemaining <= 0
    },

    /**
     * Test and console seam. The only write that does NOT merge: merging would
     * hand the ledger straight back from storage, which is the opposite of what
     * the one caller of this wants.
     */
    reset() {
      state = fresh()
      write()
      return snapshot()
    },
  }
}

/** A setting that must be a number, or the value that makes the rule never fire. */
function threshold(value, inert) {
  return Number.isFinite(value) ? value : inert
}

/**
 * Whether a `remaining` count is one this package may ration against.
 *
 * A count is not a budget. `x-ratelimit-limit`, `-remaining` and `-reset` are
 * what nginx, Kong, Tyk, AWS API Gateway and the IETF `RateLimit-*` draft all
 * emit for PER-MINUTE windows, so a self-hosted vLLM behind a 20-a-minute
 * gateway answers with `remaining: 14` all day — and the panel, reading that as
 * fourteen answers left, dropped it to one request per turn permanently, on a
 * deployment with no daily ceiling of any kind. The count was real; the UNIT was
 * a minute, and nothing checked.
 *
 * TWO THINGS HAVE TO HOLD, and they are two different questions:
 *
 *   · that a daily allowance EXISTS to be rationed — the site declared a ceiling
 *     with `budget.dailyLimit`, or the answering half runs on the provider's own
 *     free pool (`freePool`, from config.js, which is a fact about the target and
 *     deliberately not a setting an author can assert)
 *   · that the NUMBER describes it. A header count is believed when the SERVICE
 *     named the day or its OWN reset is at least ten minutes out; a per-minute
 *     window is exactly the one that puts a reset seconds away. A count we made
 *     ourselves against a stated ceiling needs no such check — we know what we
 *     were counting.
 *
 * Anything else stays agentic. The contract's "an unknown budget stays agentic"
 * rule was right and simply did not cover known-and-in-the-wrong-unit.
 *
 * THE SECOND QUESTION IS `snapshot`'S NOW, and this reads its answer instead of
 * asking again. `source: 'header'` means the count came from the service AND
 * stands as a statement about the day: an undefendable one is demoted there, to
 * the display, and what arrives here is the local count with `source: 'local'`.
 * The window test below is therefore about snapshots built by HAND — the eval
 * runner's, the tests', anything that predates the split — and it is kept
 * because the alternative is trusting a `source` field any caller can write.
 */
export function trustworthy(snapshot, settings, now = Date.now()) {
  const s = settings || {}
  const declared = Number.isFinite(s.dailyLimit) && s.dailyLimit > 0
  if (!declared && s.freePool !== true) return false
  // Nothing counted and nothing stated is nothing to ration against, whatever
  // number a demoted header left on the display.
  if (snapshot?.source === 'unknown') return false
  if (snapshot?.source !== 'header') return true
  // ONLY A RESET THE HEADERS ACTUALLY SENT, or a response that named the day.
  // `snapshot` falls back to the local day's end when the service named none,
  // and this test used to pass on the strength of that substitution — a window
  // this module invented, validating a count it knows nothing about.
  // Concretely: `budget: {dailyLimit: 500}` in front of a gateway publishing
  // `x-ratelimit-remaining: 14` and no reset gave `{mode: 'one-shot',
  // maxRequests: 2}` permanently, all day, on a deployment whose fourteen were
  // fourteen a MINUTE. Silence about the window makes a header count
  // untrustworthy; it does not make it daily.
  return defendable(
    {
      remaining: snapshot?.remaining,
      statedDaily: snapshot?.statedDaily === true,
      resetAt: snapshot?.resetSource === 'header' ? Number(snapshot?.resetAt) : undefined,
    },
    now,
  )
}

/**
 * How to spend a turn, given what is left of the day.
 *
 * Pure, and separated from the ledger on purpose: the policy is the part worth
 * arguing about, and an argument about it should not need a browser, a clock or
 * a rate-limited endpoint to settle.
 *
 * AN UNKNOWN BUDGET CHANGES NOTHING, and neither does one this module cannot
 * defend — see `trustworthy`. Every rule below is gated on a remaining count
 * that is both reported and daily, because the alternative — inferring scarcity
 * from silence, or from somebody else's per-minute allowance — degrades every
 * self-hosted and every paid deployment on the strength of a header that was
 * never about a day. Scarcity has to be observed, never assumed.
 *
 * A missing threshold is treated the same way: `settings` is normally the
 * resolved `budget` block plus `freePool`, and the resolver in switches.js owns
 * the numbers. Absent one, the rule it governs does not fire, which is exactly
 * today's behaviour rather than an invented policy.
 *
 * ONE NUMBER COMES OUT OF IT, not three switches. `maxRequests` is the turn's
 * whole allowance and it is the only thing the transport is told, because the
 * three orthogonal flags this replaced could each be true while the turn still
 * spent twenty requests: "one-shot" bounded the ITERATIONS, and one forced call
 * that rotates a ten-member pool with a continuation each is twenty requests
 * against the fifteen the rationing was triggered by. A ceiling on requests is
 * the only form of this rule that cannot be worked around by the mechanisms
 * underneath it.
 *
 * @param {Record<string, any>|null} [snapshot] from `createBudget().snapshot()`
 * @param {Record<string, any>|null} [settings] the resolved `budget` block, plus
 *   `freePool` — a fact about the target rather than a setting, see `trustworthy`
 * @param {number} [now]
 * @returns {{mode: 'agentic'|'one-shot', maxRequests: number, continuations: number}}
 */
export function budgetPlan(snapshot, settings, now = Date.now()) {
  const s = settings || {}
  const trusted = trustworthy(snapshot, s, now)
  // THE LEDGER, NOT THE DISPLAY. They are the same number on every snapshot but
  // one — a header count with no window anybody stated, which `snapshot` shows
  // where it is lower and refuses to plan on. A snapshot built by hand carries
  // only `remaining`, and for those the two were never different.
  const count =
    snapshot && typeof snapshot === 'object' && 'defensibleRemaining' in snapshot
      ? snapshot.defensibleRemaining
      : snapshot?.remaining
  const remaining = trusted && Number.isFinite(count) ? count : null
  const known = remaining !== null

  // One request per turn: the forced final call already carries the priming
  // retrieval, the strict schema and the citable set, so the answer it produces
  // is a real answer rather than a degraded one — it simply cannot go looking
  // for more evidence first.
  const mode =
    s.mode === 'one-shot' ||
    (s.mode === 'auto' && known && remaining <= threshold(s.oneShotBelow, -1))
      ? 'one-shot'
      : 'agentic'

  const continuations =
    known && remaining <= CONTINUATION_FLOOR ? 0 : Math.max(0, threshold(s.maxContinuations, 0))

  // Rotation is a SECOND request spent on the hope that another model does
  // better, and on a thin budget that hope costs more than it returns.
  //
  // What declining it buys is the REQUEST, not a worse answer to this question:
  // an uncited reply is withheld by the guardrail whatever it cost, so the prose
  // that gets kept here ends the turn on the same refusal it would have ended on
  // anyway. Six answers left is six more questions, or three if every turn is
  // allowed to ask twice — and three questions is the worse day. `rotateAbove`
  // says where that starts, and it says it by LOWERING the allowance to one call
  // plus whatever it takes to finish it, which is also what one-shot means:
  // one-shot is the same decision made about the whole turn rather than about
  // the pool.
  const rationed = mode === 'one-shot' || (known && remaining <= threshold(s.rotateAbove, -1))

  return {
    mode,
    // Infinity, not a number: an unrationed turn spends what the loop and the
    // pool need, exactly as it did before any of this existed.
    maxRequests: rationed ? 1 + continuations : Infinity,
    continuations,
  }
}
