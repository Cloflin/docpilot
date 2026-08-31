import { describe, it, expect, vi } from 'vitest'
import { srcText } from './helpers/source.js'


import {
  FREE_TIER_DAILY,
  readLimitHeaders,
  createBudget,
  budgetPlan,
  trustworthy,
  classifyLimit,
  hasDailyAllowance,
} from '../src/theme/docpilot/budget.js'
import {
  resolveBudget,
  BUDGET_DEFAULTS,
  BUDGET_NEVER,
  MAX_CONTINUATIONS,
} from '../src/theme/docpilot/switches.js'
import { DEFAULTS, resolveDocPilot, themeDocPilot } from '../src/config.js'

/**
 * The day's requests: the ledger, the policy, and the settings behind both.
 *
 * Nothing here touches a socket or a clock it did not inject, and that is the
 * point rather than an economy. The whole feature exists because a free tier
 * runs out fifty requests into a day, so a suite that needed a live free tier to
 * check it would be a suite nobody could run twice — and the second run is
 * exactly where a budget bug lives.
 */

/** A Storage that a test can look inside, and that two ledgers can share. */
const fakeStorage = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  }
}

// Noon UTC, so the local day's boundary is a round number away in both
// directions and no test straddles it by accident.
const NOON = Date.UTC(2026, 7, 20, 12, 0, 0)
const MIDNIGHT = Date.UTC(2026, 7, 21, 0, 0, 0)

describe('reading what a response said about the limit', () => {
  it('reads a Headers object and a plain object the same way', () => {
    const expected = { limit: 50, remaining: 31, resetAt: NOON + 3600000 }

    expect(
      readLimitHeaders(
        new Headers({
          'x-ratelimit-limit': '50',
          'x-ratelimit-remaining': '31',
          'x-ratelimit-reset': String(NOON + 3600000),
        }),
        NOON,
      ),
    ).toEqual(expected)

    // The transport hands over a Headers; a test, a proxy that rebuilt the
    // response, and the eval runner all hand over a plain object — and the
    // casing of the keys is nobody's promise.
    expect(
      readLimitHeaders(
        {
          'X-RateLimit-Limit': '50',
          'X-RATELIMIT-REMAINING': '31',
          'x-ratelimit-reset': String(NOON + 3600000),
        },
        NOON,
      ),
    ).toEqual(expected)
  })

  /**
   * The reset header arrives in three forms thirty years apart when they are
   * read as one number, so the magnitude has to decide which one arrived.
   */
  it('resolves every form of the reset header into one instant', () => {
    const ms = readLimitHeaders({ 'x-ratelimit-reset': String(NOON + 1000) }, NOON)
    expect(ms.resetAt).toBe(NOON + 1000)

    const seconds = readLimitHeaders({ 'x-ratelimit-reset': String((NOON + 1000) / 1000) }, NOON)
    expect(seconds.resetAt).toBe(NOON + 1000)

    // A delay rather than a date: nobody schedules a rate limit to lift in 1970.
    const delay = readLimitHeaders({ 'x-ratelimit-reset': '60' }, NOON)
    expect(delay.resetAt).toBe(NOON + 60000)

    // Anthropic states an instant instead of a number.
    const instant = readLimitHeaders({ 'x-ratelimit-reset': '2026-08-20T13:00:00Z' }, NOON)
    expect(instant.resetAt).toBe(Date.UTC(2026, 7, 20, 13, 0, 0))
  })

  /**
   * `x-ratelimit-reset: 3600000` is a plausible millisecond encoding of one
   * hour, and read as the delay in seconds it is forty-one days. `expired()` is
   * the only recovery from a `remaining: 0` learned beside it, so unclamped that
   * header switches the panel off until October.
   */
  it('refuses to believe a reset further out than a day', () => {
    const CAP = NOON + 86400000 + 7200000
    expect(readLimitHeaders({ 'x-ratelimit-reset': '3600000' }, NOON).resetAt).toBe(CAP)
    // The same shape out of correct headers and a client clock running slow.
    expect(readLimitHeaders({ 'x-ratelimit-reset': '2027-01-01T00:00:00Z' }, NOON).resetAt).toBe(CAP)
    expect(
      readLimitHeaders({ 'x-ratelimit-reset': String(NOON + 3 * 86400000) }, NOON).resetAt,
    ).toBe(CAP)
    // A reset genuinely inside the day is untouched.
    expect(readLimitHeaders({ 'x-ratelimit-reset': '3600' }, NOON).resetAt).toBe(NOON + 3600000)
  })

  /**
   * A PARTIAL set is the common case, not the broken one — plenty of
   * deployments send `x-ratelimit-remaining` and nothing else — so a missing
   * field comes back undefined rather than failing the whole read.
   */
  it('keeps what a partial header set did say', () => {
    expect(readLimitHeaders({ 'x-ratelimit-remaining': '7' }, NOON)).toEqual({
      limit: undefined,
      remaining: 7,
      resetAt: undefined,
    })
    expect(readLimitHeaders(new Headers({ 'x-ratelimit-limit': '50' }), NOON)).toEqual({
      limit: 50,
      remaining: undefined,
      resetAt: undefined,
    })
  })

  /**
   * Null is not an error. A self-hosted Ollama has no budget to report, and the
   * difference between "nothing was said" and "zero left" is the difference
   * between a panel that works and a panel that has switched itself off.
   */
  it('says nothing when the response said nothing', () => {
    expect(readLimitHeaders(new Headers(), NOON)).toBe(null)
    expect(readLimitHeaders({ 'content-type': 'application/json' }, NOON)).toBe(null)
    expect(readLimitHeaders(null, NOON)).toBe(null)
    expect(readLimitHeaders(undefined, NOON)).toBe(null)
    // Values that are present and mean nothing are the same answer as absent.
    expect(readLimitHeaders({ 'x-ratelimit-remaining': '', 'x-ratelimit-limit': 'none' }, NOON)).toBe(
      null,
    )
  })

  it('survives a headers object that throws when it is read', () => {
    const hostile = {
      get() {
        throw new Error('detached')
      },
    }
    expect(readLimitHeaders(hostile, NOON)).toBe(null)
  })
})

/**
 * THE ONE PLACE THAT DECIDES WHAT KIND OF LIMIT A RESPONSE STATED.
 *
 * There used to be two, one per file, and on a real response they disagreed —
 * see 'records the day when the transport read one out of the body'. The rules
 * are ordered by how much each is worth trusting, and the window heuristic is
 * the LAST of them rather than the only one.
 */
describe('classifying a rate-limit statement', () => {
  const minute = NOON + 45000
  const tomorrow = NOON + 11 * 3600000

  it('believes the service when it names the window itself', () => {
    expect(
      classifyLimit(
        { payload: { error: { metadata: { limit_source: 'daily' } } }, remaining: 0, resetAt: minute },
        NOON,
      ),
    ).toBe('daily')
  })

  it('reads the sentence when the metadata is not there', () => {
    expect(
      classifyLimit(
        { payload: { error: { message: 'Rate limit exceeded: free-models-per-day' } }, resetAt: minute },
        NOON,
      ),
    ).toBe('daily')
  })

  it('reads the arithmetic when there is no sentence either', () => {
    expect(classifyLimit({ remaining: 0, resetAt: tomorrow }, NOON)).toBe('daily')
  })

  /** The floor under that third rule: a burst reports `remaining: 0` too. */
  it('calls a window inside ten minutes a burst', () => {
    expect(classifyLimit({ remaining: 0, resetAt: minute }, NOON)).toBe('burst')
    expect(classifyLimit({ remaining: 14, resetAt: minute }, NOON)).toBe('burst')
  })

  /**
   * A count with no window at all has not said which window it counted, and
   * neither reader may pretend otherwise. A burst limiter publishing neither a
   * reset nor a `retry-after` is undetectable, and nothing here guesses.
   */
  it('says so when the response stated no window', () => {
    expect(classifyLimit({ remaining: 14 }, NOON)).toBe('unknown')
    expect(classifyLimit({ payload: { error: { message: 'nope' } } }, NOON)).toBe('unknown')
    expect(classifyLimit(null, NOON)).toBe('unknown')
  })
})

describe('the ledger', () => {
  it('counts locally against a ceiling until a header says otherwise', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })

    // Nothing spent, nothing learned: the ceiling is all there is to say.
    expect(budget.snapshot()).toMatchObject({ limit: 50, remaining: 50, source: 'local' })

    budget.spend(3)
    expect(budget.snapshot()).toMatchObject({ remaining: 47, source: 'local', spentLocal: 3 })
  })

  it('reports an unknown budget as unknown rather than as a guess', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: null })
    const s = budget.snapshot()
    expect(s.remaining).toBeUndefined()
    expect(s.source).toBe('unknown')
    // And an unknown budget is never a spent one — see `budgetPlan`, which
    // leaves every rule switched off on the strength of exactly this.
    expect(budget.exhausted()).toBe(false)
  })

  /**
   * HEADER DATA WINS WHERE IT CAN BE DEFENDED. The local count exists to have
   * something to say before the first response arrives; a number the service
   * stated about the DAY supersedes it the moment it lands, and does not go back
   * to being a count afterwards.
   *
   * The reset is part of the statement rather than decoration: it is what makes
   * these numbers a day's rather than a minute's, and a count with no window
   * anybody stated is demoted instead — the test below this one.
   *
   * ONE LEDGER, which is what the last two assertions are about. The three
   * requests already counted are not charged a second time against the number
   * the service just stated — it accounts for them — and the request made AFTER
   * it is, because the service has not seen that one yet. The two halves used to
   * run in parallel, and the count only surfaced when the header window closed:
   * scarcity that had already been paid for once.
   */
  it('lets the service’s own number beat the count, permanently', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    budget.spend(3)

    budget.observe(
      new Headers({
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '31',
        'x-ratelimit-reset': String(NOON + 3600000),
      }),
    )
    expect(budget.snapshot()).toMatchObject({ limit: 50, remaining: 31, source: 'header' })

    // Not 50 - 4, and not 31 either: one request the service has not counted.
    budget.spend(1)
    expect(budget.snapshot()).toMatchObject({ remaining: 30, source: 'header', spentLocal: 4 })
  })

  /**
   * LEARNING SOMETHING WE CANNOT DEFEND MUST NOT DESTROY SOMETHING WE COULD.
   *
   * A header `remaining` with no window anybody stated used to replace the local
   * count outright and make the whole snapshot a header snapshot — which
   * `trustworthy` then refused, so the SAME number planned two opposite turns
   * depending on which half of the ledger it came out of. Measured at ceiling 50
   * with 47 counted: from the count, `{one-shot, maxRequests 2}`; from the
   * service saying "3", `{agentic, Infinity}`, with "3 of 50 answers left
   * today" printed beside the unbounded plan.
   *
   * Demoted, never discarded: the count still shows, because a service saying
   * three is a reason for caution whatever it was counting, and the ledger the
   * plan reads stays the one this module can defend.
   */
  it('demotes a header count with no window to the display', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    budget.spend(47)
    const s = budget.observe({ 'x-ratelimit-remaining': '3' })

    expect(s).toMatchObject({ remaining: 3, defensibleRemaining: 3, source: 'local' })
    // One plan, from either half of the ledger — which is the whole point.
    expect(budgetPlan(s, { ...BUDGET_DEFAULTS, freePool: true }, NOON)).toMatchObject({
      mode: 'one-shot',
      maxRequests: 2,
    })

    // And the demotion is a MINIMUM, not a replacement: a header count above
    // what we counted cannot hand back answers the count says are gone.
    const generous = budget.observe({ 'x-ratelimit-remaining': '40' })
    expect(generous).toMatchObject({ remaining: 3, defensibleRemaining: 3, source: 'local' })
  })

  /**
   * "161 of 50 answers left today" was a real render, out of a header
   * `remaining` beside a configured daily ceiling. The pair has to come from one
   * source or the fraction describes nothing that was ever reported.
   */
  it('never pairs a header count with the ceiling from the config', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    budget.observe({ 'x-ratelimit-remaining': '161', 'x-ratelimit-reset': String(NOON + 3600000) })
    const s = budget.snapshot()
    expect(s).toMatchObject({ remaining: 161, source: 'header' })
    expect(s.limit).toBeUndefined()

    // The same 161 without a window it cannot render as a fraction at all: it is
    // demoted to the display, where it is the higher number and loses.
    const counted = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    counted.observe({ 'x-ratelimit-remaining': '161' })
    expect(counted.snapshot()).toMatchObject({ limit: 50, remaining: 50, source: 'local' })
  })

  it('leaves alone whatever the headers omitted', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: null })
    budget.observe({ 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '12' })
    // A later response that states only the reset must not erase the count.
    budget.observe({ 'x-ratelimit-reset': String(NOON + 3600000) })
    expect(budget.snapshot()).toMatchObject({ limit: 50, remaining: 12, resetAt: NOON + 3600000 })
  })

  it('carries the count across a reload', () => {
    const storage = fakeStorage()
    createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY }).spend(4)

    const reloaded = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    expect(reloaded.snapshot()).toMatchObject({ remaining: 46, spentLocal: 4 })
    // ONE key, beside `docpilot:feedback` and `docpilot:history`.
    expect([...storage._map.keys()]).toEqual(['docpilot:budget'])
  })

  /**
   * AND CARRIES THE DEMOTED COUNT WITH IT. `write()` serialises the whole state,
   * so the pair was already in storage — it simply was not read back, and the
   * reload therefore forgot the lower number the service had actually stated and
   * went back to the defended one. That is the panel promising thirty-eight
   * answers that are gone, which is the failure the demotion exists to prevent.
   */
  it('carries a demoted count across a reload too', () => {
    const storage = fakeStorage()
    const first = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    // A statement the ledger can defend: a count with a window an hour out.
    first.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '40',
      'x-ratelimit-reset': String(NOON + 3600000),
    })
    // And then a LOWER count with no window at all. Nothing can defend it, so it
    // is demoted to the display — where it is the smaller of the two and is
    // therefore the number the reader is shown.
    expect(first.observe({ 'x-ratelimit-remaining': '2' })).toMatchObject({
      remaining: 2,
      defensibleRemaining: 40,
    })

    const reloaded = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    expect(reloaded.snapshot()).toMatchObject({ remaining: 2, defensibleRemaining: 40 })
    // And it still moves with the count: one more request off the demoted two.
    expect(reloaded.spend(1)).toMatchObject({ remaining: 1, defensibleRemaining: 39 })
  })

  /**
   * The failure that would be hardest to see and worst to live with: a snapshot
   * saved at 23:59 saying "0 left" is still in storage the next morning, and a
   * panel that believes it switches itself off for a day with a full allowance
   * in it.
   */
  it('throws away a window that has already closed', () => {
    const storage = fakeStorage()
    const yesterday = createBudget({ storage, now: () => NOON, dailyLimit: null })
    // An hour out, because a window seconds away is a BURST window and this
    // ledger no longer records those at all — see the describe below.
    yesterday.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(NOON + 3600000),
    })
    expect(yesterday.exhausted()).toBe(true)

    const after = createBudget({ storage, now: () => NOON + 3600001, dailyLimit: null })
    expect(after.snapshot().remaining).toBeUndefined()
    expect(after.snapshot().source).toBe('unknown')
    expect(after.exhausted()).toBe(false)
  })

  /**
   * The header numbers expire even when the service named no reset. A
   * `remaining: 0` with nothing beside it saying when would otherwise be
   * believed for the life of the browser profile.
   */
  it('expires a header count that never said when it lifts', () => {
    const storage = fakeStorage()
    createBudget({ storage, now: () => NOON, dailyLimit: null }).observe({
      'x-ratelimit-remaining': '0',
    })

    const tomorrow = createBudget({ storage, now: () => MIDNIGHT + 1, dailyLimit: null })
    expect(tomorrow.snapshot().remaining).toBeUndefined()
  })

  it('restarts the local count at the day it was counting', () => {
    const storage = fakeStorage()
    createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY }).spend(7)

    // Still the same day: the count stands.
    const later = createBudget({ storage, now: () => NOON + 3600000, dailyLimit: FREE_TIER_DAILY })
    expect(later.snapshot()).toMatchObject({ remaining: 43, spentLocal: 7 })

    const tomorrow = createBudget({ storage, now: () => MIDNIGHT + 1, dailyLimit: FREE_TIER_DAILY })
    expect(tomorrow.snapshot()).toMatchObject({ remaining: 50, spentLocal: 0 })
  })

  /**
   * The window opens on the first request rather than at construction: a page
   * nobody asked a question on must not consume a day of the ledger just by
   * being loaded.
   */
  it('does not open a day just because a page was loaded', () => {
    const storage = fakeStorage()
    createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY }).snapshot()
    expect(storage._map.size).toBe(0)
  })

  it('knows the difference between exhausted and unknown', () => {
    const spent = createBudget({ storage: null, now: () => NOON, dailyLimit: null })
    spent.observe({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOON + 3600000) })
    expect(spent.exhausted()).toBe(true)

    spent.reset()
    expect(spent.exhausted()).toBe(false)
    expect(spent.snapshot().source).toBe('unknown')
  })

  /**
   * A browser with storage disabled is a reader, not a bug report. The ledger is
   * bookkeeping and the answer is the product, so nothing here may take the
   * panel down with it.
   */
  it('never throws on a storage that refuses to work', () => {
    const hostile = {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
    }
    const budget = createBudget({ storage: hostile, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    expect(() => budget.spend(2)).not.toThrow()
    expect(budget.snapshot()).toMatchObject({ remaining: 48, spentLocal: 2 })
  })

  it('ignores a stored snapshot that is not one', () => {
    const storage = fakeStorage()
    storage.setItem('docpilot:budget', 'not json{')
    const budget = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    expect(budget.snapshot()).toMatchObject({ remaining: 50, spentLocal: 0 })
  })

  it('treats a nonsense spend as one request', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    budget.spend('two')
    expect(budget.snapshot().spentLocal).toBe(1)
    budget.spend(0)
    expect(budget.snapshot().spentLocal).toBe(1)
  })
})

/**
 * TWO DOCS TABS IS THE ORDINARY CASE. The ledger used to be read once at
 * construction and written whole on every mutation, so the tab that happened to
 * write last decided what the day had left — and a tab left open since the
 * morning decides it wrongly and generously.
 */
describe('the ledger with a second tab open', () => {
  const twoTabs = () => {
    const storage = fakeStorage()
    const open = () => createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    return [open(), open(), storage]
  }

  it('does not let an idle tab hand back the answers another tab spent', () => {
    const [morning, afternoon, storage] = twoTabs()
    // The afternoon tab does the work. The morning tab knows nothing about it.
    afternoon.spend(43)
    expect(afternoon.snapshot()).toMatchObject({ remaining: 7, spentLocal: 43 })

    // One request from the tab that has been sitting there since breakfast. It
    // used to write its own `spentLocal: 1` over the whole ledger.
    expect(morning.spend(1)).toMatchObject({ remaining: 6, spentLocal: 44 })
    expect(JSON.parse(storage.getItem('docpilot:budget')).spentLocal).toBe(44)
  })

  it('keeps the lower of two remaining counts, with its own limit beside it', () => {
    const [a, b] = twoTabs()
    // Both statements name a day — otherwise neither is one the ledger acts on,
    // and the pair being tested here never reaches the panel.
    const reset = String(NOON + 3600000)
    a.observe({ 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '30', 'x-ratelimit-reset': reset })
    b.observe({ 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': reset })

    // `a` writes next and finds `b`'s more pessimistic reading waiting. Both
    // tabs read the same injected clock, so the two statements are the same age
    // and the pessimistic rule is the only one that can decide between them.
    expect(a.spend(1)).toMatchObject({ limit: 200, remaining: 1, source: 'header' })
  })

  /**
   * AND THE SAME FOR THE DEMOTED HALF. It has no `observedAt` — it was demoted
   * because nothing dated or bounded it — so `adopt`'s newest-wins has nothing
   * to decide with, and what is left is the rule for a statement that cannot be
   * dated: the pessimistic reading wins, since it is the only one that cannot
   * invent budget that is not there.
   *
   * Neither statement here names a day, so neither reaches the ledger a plan
   * reads. Both reach the panel, and the panel used to be shown whichever tab
   * happened to write — which is 39 rather than 1 on the numbers below.
   */
  it('keeps the lower of two demoted counts as well', () => {
    const [a, b] = twoTabs()
    // One defended statement to demote against — without it a reset-less count
    // simply becomes the ledger, and the demoted half is never reached.
    a.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '40',
      'x-ratelimit-reset': String(NOON + 3600000),
    })
    a.observe({ 'x-ratelimit-remaining': '30' })
    b.observe({ 'x-ratelimit-remaining': '5' })
    expect(b.snapshot()).toMatchObject({ remaining: 5, defensibleRemaining: 40 })

    // `a` writes next and finds `b`'s five waiting. Its own thirty is not a
    // reason to hand back twenty-five answers the service has already said are
    // gone — and the mark travels with the count, so both are carried forward
    // against the same tally.
    expect(a.spend(1)).toMatchObject({ remaining: 4, defensibleRemaining: 39 })
  })

  /**
   * NEWEST WINS, NOT LOWEST — because `better` compared only the VALUE of two
   * statements and never which of them was current.
   *
   * The tab holding the stale minimum republished it on its next `spend()`, and
   * every other tab, and every NEW tab, adopted it. Reproduced over one store,
   * and the numbers below are what it measured: A hears 40, B (still holding an
   * older 2) spends, and A's next snapshot says 0 of 50 — so the panel prints
   * "0 of 50 answers left today" and plans one-shot for the rest of the day
   * in front of a service with forty in hand.
   *
   * The routine trigger is a burst 429, which is why the rule matters more than
   * the arithmetic: `meter` reports every completed response, so a burst
   * limiter's `remaining: 0` for its own window used to enter the ledger as a
   * statement about the day and then win every merge it was in.
   */
  it('does not let an older statement overwrite a newer one', () => {
    const storage = fakeStorage()
    let t = NOON
    const open = () => createBudget({ storage, now: () => t, dailyLimit: FREE_TIER_DAILY })
    const day = (remaining) => ({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(NOON + 3600000),
    })

    const b = open()
    b.observe(day(2))

    t = NOON + 60000
    const a = open()
    expect(a.snapshot()).toMatchObject({ remaining: 2, source: 'header' })
    a.observe(day(40))
    expect(a.snapshot()).toMatchObject({ remaining: 40, source: 'header' })

    // B's turn to write. Its own statement is a minute old and it must not be
    // put back over the one A has just heard.
    t = NOON + 120000
    expect(b.spend(1)).toMatchObject({ limit: 50, remaining: 39, source: 'header' })
    expect(a.spend(1)).toMatchObject({ remaining: 38, source: 'header' })

    // And a tab opened now reads the day the service actually described.
    expect(open().snapshot()).toMatchObject({ limit: 50, remaining: 38, source: 'header' })
  })

  /**
   * The other half of the same rule: `spentLocal` is a COUNT OF REQUESTS MADE
   * and cannot go down, so the maximum still wins there whatever the ages are.
   * It is not a statement about what is left; it is a tally, and two tabs each
   * hold part of it.
   */
  it('still takes the higher count when the newer statement is the emptier one', () => {
    const storage = fakeStorage()
    let t = NOON
    const open = () => createBudget({ storage, now: () => t, dailyLimit: FREE_TIER_DAILY })

    const a = open()
    a.spend(20)
    const b = open()
    t = NOON + 60000
    b.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '5',
      'x-ratelimit-reset': String(NOON + 3600000),
    })
    // The newer statement is the scarcer one and it is adopted for that reason
    // rather than in spite of it; the twenty already counted travel with it.
    expect(a.spend(1)).toMatchObject({ remaining: 4, spentLocal: 21, source: 'header' })
  })

  /**
   * DEFENSIBILITY OUTRANKS AGE, which is what keeps newest-wins from becoming
   * the next defect. Newer is a better guide only between statements of the same
   * standing: a count with no window anybody stated is not a statement about the
   * day at all, and letting the most recent of those supersede a daily one the
   * service actually made hands the reader back a budget that has been spent.
   *
   * The stored ledger below is what a tab behind a proxy that forwards
   * `x-ratelimit-remaining` and strips `x-ratelimit-reset` writes — or what any
   * build older than this field left behind. It is a minute later than the day's
   * statement and it must still lose.
   */
  it('never lets an undefendable statement supersede a defendable one', () => {
    const storage = fakeStorage()
    let t = NOON
    const here = createBudget({ storage, now: () => t, dailyLimit: FREE_TIER_DAILY })
    here.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '2',
      'x-ratelimit-reset': String(NOON + 3600000),
    })

    t = NOON + 60000
    storage.setItem(
      'docpilot:budget',
      JSON.stringify({
        limit: 20,
        remaining: 30,
        spentLocal: 0,
        observedAt: t,
        windowEnds: MIDNIGHT,
      }),
    )

    // Newest-wins alone made this `remaining: 29` out of a per-minute twenty.
    expect(here.spend(1)).toMatchObject({
      limit: 50,
      remaining: 1,
      defensibleRemaining: 1,
      source: 'header',
    })
  })

  /**
   * The event that says another tab wrote. Node has no `addEventListener` on
   * `globalThis`, so this stubs the one a browser supplies and fires it.
   */
  it('picks up another tab’s ledger without waiting for a reload', () => {
    const storage = fakeStorage()
    const handlers = []
    vi.stubGlobal('addEventListener', (type, fn) => {
      if (type === 'storage') handlers.push(fn)
    })
    const here = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    const elsewhere = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    const handler = handlers[0]
    expect(handler).toBeTypeOf('function')

    elsewhere.spend(40)
    expect(here.snapshot()).toMatchObject({ remaining: 50 })

    handler({ key: 'docpilot:budget' })
    expect(here.snapshot()).toMatchObject({ remaining: 10, spentLocal: 40 })

    // Somebody else's key is not our business, and neither is a hostile event.
    handler({ key: 'docpilot:history' })
    expect(() => handler(null)).not.toThrow()
    expect(here.snapshot()).toMatchObject({ remaining: 10 })
    vi.unstubAllGlobals()
  })

  /** `reset()` is the one write that must not merge the ledger straight back. */
  it('lets a reset actually reset', () => {
    const [a, b] = twoTabs()
    a.spend(9)
    expect(b.reset()).toMatchObject({ remaining: 50, spentLocal: 0 })
  })
})

/**
 * THE DAY'S LEDGER HOLDS STATEMENTS ABOUT THE DAY.
 *
 * `meter` reports the headers of every completed response, a 429 included —
 * which is right, because a 429 is the most informative response of the lot. But
 * a BURST limiter's `remaining: 0` is a fact about the next second, and written
 * into this ledger it becomes "0 of 20 answers left today", displayed to
 * the reader and merged into every other tab.
 */
describe('a statement about a minute never enters the day’s ledger', () => {
  const open = () =>
    createBudget({ storage: fakeStorage(), now: () => NOON, dailyLimit: FREE_TIER_DAILY })

  it('drops a count whose own reset says it is a burst window', () => {
    const budget = open()
    budget.spend(1)
    expect(
      budget.observe({
        'x-ratelimit-limit': '20',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(NOON + 30000),
      }),
    ).toMatchObject({ limit: 50, remaining: 49, source: 'local' })
  })

  /**
   * `retry-after` stands in for the reset when a 429 sent one and no reset, on
   * the same terms llm.js already reads it on: two readings of one response that
   * disagreed about which 429 it was would be worse than either.
   */
  it('drops one whose retry-after says the same thing', () => {
    const budget = open()
    budget.spend(1)
    expect(
      budget.observe({ 'x-ratelimit-remaining': '0', 'retry-after': '2' }),
    ).toMatchObject({ limit: 50, remaining: 49, source: 'local' })
  })

  it('keeps the day’s own statement, and a retry-after that names tomorrow', () => {
    const budget = open()
    expect(
      budget.observe({
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '6',
        'x-ratelimit-reset': String(NOON + 3600000),
      }),
    ).toMatchObject({ limit: 50, remaining: 6, source: 'header' })

    expect(
      open().observe({ 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'retry-after': '7200' }),
    ).toMatchObject({ limit: 50, remaining: 0, source: 'header' })
  })

  /**
   * A burst reset arriving on its own is the same statement with the count left
   * off, and it used to become the DAILY count's expiry clock: `expired` reads
   * `resetAt` first, so five seconds later the day's `remaining` was thrown away
   * and the panel fell back to guessing from a local tally.
   */
  it('does not let a burst reset become the day’s expiry clock', () => {
    const budget = open()
    budget.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '12',
      'x-ratelimit-reset': String(NOON + 3600000),
    })
    budget.observe({ 'x-ratelimit-reset': String(NOON + 5000) })
    expect(budget.snapshot()).toMatchObject({
      remaining: 12,
      source: 'header',
      resetAt: NOON + 3600000,
    })
  })

  /** And a burst 429 cannot reach the day's ledger through another tab either. */
  it('leaves the ledger a burst 429 arrived at exactly as it was', () => {
    const storage = fakeStorage()
    const one = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    const two = createBudget({ storage, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    one.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '9',
      'x-ratelimit-reset': String(NOON + 3600000),
    })
    two.observe({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOON + 1000) })
    expect(two.spend(1)).toMatchObject({ limit: 50, remaining: 8, source: 'header' })
  })

  /**
   * ONE RESPONSE, ONE CLASSIFICATION — and the transport is the side that read
   * the BODY, which is where a service names the window it counted.
   *
   * These headers are the ones that had the two files disagreeing: a spent day
   * that answers `retry-after: 120` and states no reset looks exactly like a
   * burst limit from the headers alone. llm.js read `limit_source: 'daily'` and
   * ended the turn as rate-limited; this file read the two-minute window and
   * dropped the zero, so the panel said "out of free answers until …" beside "5
   * of 50 left today" and the next question planned a full agentic walk into a
   * spent day.
   */
  it('records the day when the transport read one out of the body', () => {
    const budget = open()
    budget.spend(45)
    expect(
      budget.observe(
        { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'retry-after': '120' },
        'daily',
      ),
    ).toMatchObject({ remaining: 0, defensibleRemaining: 0, source: 'header', statedDaily: true })
    expect(budget.exhausted()).toBe(true)
  })

  /** The same headers with nobody to say otherwise are still a minute's. */
  it('reads those same headers as a minute when no verdict comes with them', () => {
    const budget = open()
    budget.spend(45)
    expect(
      budget.observe({ 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'retry-after': '120' }),
    ).toMatchObject({ remaining: 5, source: 'local' })
  })

  /** And a burst the transport named is dropped whatever the headers imply. */
  it('drops a burst the transport named, reset or no reset', () => {
    const budget = open()
    budget.spend(1)
    expect(
      budget.observe(
        {
          'x-ratelimit-limit': '50',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(NOON + 3600000),
        },
        'burst',
      ),
    ).toMatchObject({ limit: 50, remaining: 49, source: 'local' })
  })
})

/**
 * A count is not a budget. `x-ratelimit-limit`, `-remaining` and `-reset` are
 * what nginx, Kong, Tyk, AWS API Gateway and the IETF draft all emit for
 * PER-MINUTE windows, so before any of the rules below may fire something has to
 * establish that a DAY is what ran out.
 */
describe('a budget worth acting on', () => {
  const daily = {
    resetAt: NOON + 3600000,
    // The SERVICE's reset, not one this module put there — see `snapshot`, which
    // falls back to the local day and used to hand `trustworthy` its own
    // invention to validate.
    resetSource: 'header',
    source: 'header',
    remaining: 9,
  }

  it('believes a free pool and a ceiling the site declared', () => {
    expect(trustworthy(daily, { freePool: true }, NOON)).toBe(true)
    expect(trustworthy(daily, { dailyLimit: 200 }, NOON)).toBe(true)
  })

  it('believes nothing about a deployment that declared neither', () => {
    expect(trustworthy(daily, {}, NOON)).toBe(false)
    expect(trustworthy(daily, { freePool: false, dailyLimit: null }, NOON)).toBe(false)
    expect(trustworthy(daily, null, NOON)).toBe(false)
  })

  /**
   * The self-hosted vLLM behind a 20-a-minute gateway: `remaining: 14`, all day,
   * every day. Read as fourteen answers left it pinned the panel to one request
   * per turn permanently, on a deployment with no daily ceiling at all.
   */
  it('refuses a header whose window is a minute rather than a day', () => {
    const burst = { remaining: 14, source: 'header', resetSource: 'header', resetAt: NOON + 45000 }
    expect(trustworthy(burst, { freePool: true }, NOON)).toBe(false)
    // Ten minutes is the line, and it is the reset that has to clear it.
    expect(trustworthy({ ...burst, resetAt: NOON + 600000 }, { freePool: true }, NOON)).toBe(true)
    expect(trustworthy({ ...burst, resetAt: undefined }, { freePool: true }, NOON)).toBe(false)
  })

  /** A count we made ourselves needs no such check: we know what we counted. */
  it('does not interrogate a count of its own', () => {
    expect(trustworthy({ remaining: 9, source: 'local' }, { dailyLimit: 50 }, NOON)).toBe(true)
  })

  /**
   * A WINDOW THIS MODULE SUBSTITUTED IS NOT A WINDOW THE SERVICE STATED, and
   * `trustworthy` was validating its own invention.
   *
   * `snapshot()` reports `resetAt: state.resetAt ?? state.windowEnds` — the
   * local UTC-midnight window when the headers named no reset — and the
   * ten-minute test then passed on the strength of a day this file made up. The
   * concrete case: `budget: {dailyLimit: 500}` in front of a gateway publishing
   * `x-ratelimit-remaining: 14` and nothing else. Fourteen "answers left" that
   * are really fourteen a minute, one-shot for the rest of the day, and the
   * reason showing up nowhere.
   */
  it('refuses a header count whose window it substituted itself', () => {
    const budget = createBudget({ storage: fakeStorage(), now: () => NOON, dailyLimit: 500 })
    budget.spend(1)
    const s = budget.observe({ 'x-ratelimit-remaining': '14' })
    // DEMOTED, NOT DISCARDED. The count is still shown — it is the service's own
    // number and it is the lower one — but the ledger a plan is built on is the
    // 499 this module counted against a ceiling the site declared, so nothing is
    // rationed on the strength of fourteen a minute.
    expect(s).toMatchObject({
      remaining: 14,
      defensibleRemaining: 499,
      source: 'local',
      resetSource: 'local',
    })
    expect(budgetPlan(s, { ...BUDGET_DEFAULTS, dailyLimit: 500 }, NOON)).toEqual({
      mode: 'agentic',
      maxRequests: Infinity,
      continuations: 1,
    })

    // And the same count with the service's own daily reset beside it is exactly
    // the statement this feature exists for.
    const stated = budget.observe({
      'x-ratelimit-remaining': '14',
      'x-ratelimit-reset': String(NOON + 3600000),
    })
    expect(stated).toMatchObject({ remaining: 14, resetSource: 'header' })
    expect(trustworthy(stated, { dailyLimit: 500 }, NOON)).toBe(true)
    expect(budgetPlan(stated, { ...BUDGET_DEFAULTS, dailyLimit: 500 }, NOON)).toMatchObject({
      mode: 'one-shot',
      maxRequests: 2,
    })
  })
})

describe('what a turn may spend', () => {
  // `freePool` is the fact about the TARGET that config.js supplies: without it
  // no remaining count here is one this module will ration against.
  const settings = { ...BUDGET_DEFAULTS, freePool: true }
  const plan = (remaining, over = {}) =>
    budgetPlan(remaining === null ? null : { remaining }, { ...settings, ...over })

  it('runs the full turn while the day is comfortable', () => {
    expect(plan(50)).toEqual({ mode: 'agentic', maxRequests: Infinity, continuations: 1 })
    expect(plan(16)).toEqual({ mode: 'agentic', maxRequests: Infinity, continuations: 1 })
  })

  /**
   * ONE-SHOT COSTS ONE REQUEST, and until `maxRequests` existed it did not: the
   * mode set an iteration ceiling of zero, and the single forced call it fell
   * through to could still rotate a ten-member pool with a continuation each.
   */
  it('drops to one request per turn at the threshold, not past it', () => {
    expect(plan(15)).toMatchObject({ mode: 'one-shot', maxRequests: 2, continuations: 1 })
    expect(plan(7).mode).toBe('one-shot')
    expect(plan(16).mode).toBe('agentic')
  })

  /**
   * Rotation is a second request spent on the hope that another model does
   * better, and on a thin budget that hope is what buys no answer at all. It is
   * refused by lowering the turn's allowance rather than by a flag, because the
   * flag only ever reached one of the three places a rotation starts from.
   */
  it('stops rotating the pool once the day is nearly spent', () => {
    expect(plan(7, { mode: 'agentic' }).maxRequests).toBe(Infinity)
    expect(plan(6, { mode: 'agentic' }).maxRequests).toBe(2)
    expect(plan(1, { mode: 'agentic' }).maxRequests).toBe(1)
  })

  it('stops continuing a truncated answer at the last two requests', () => {
    expect(plan(3).continuations).toBe(1)
    expect(plan(2).continuations).toBe(0)
    expect(plan(0).continuations).toBe(0)
    // And the allowance follows it down: nothing to continue with, nothing to
    // spend on continuing.
    expect(plan(2).maxRequests).toBe(1)
  })

  /**
   * AN UNKNOWN BUDGET CHANGES NOTHING. Inferring scarcity from a missing header
   * would shorten the answers of every self-hosted and every paid deployment on
   * the strength of silence.
   */
  it('leaves a budget nobody reported entirely alone', () => {
    expect(plan(null)).toEqual({ mode: 'agentic', maxRequests: Infinity, continuations: 1 })
    expect(budgetPlan({ remaining: undefined, source: 'unknown' }, settings)).toEqual({
      mode: 'agentic',
      maxRequests: Infinity,
      continuations: 1,
    })
    expect(budgetPlan({}, settings).mode).toBe('agentic')
    expect(budgetPlan(undefined, settings).mode).toBe('agentic')
  })

  /**
   * And a budget it cannot defend is the same answer as no budget: this is the
   * paid deployment on a metered provider, which used to be rationed after 35
   * requests per browser profile for no reason anybody could see.
   */
  it('leaves a count it cannot defend entirely alone', () => {
    const paid = { ...BUDGET_DEFAULTS, freePool: false }
    expect(budgetPlan({ remaining: 1 }, paid)).toEqual({
      mode: 'agentic',
      maxRequests: Infinity,
      continuations: 1,
    })
  })

  it('obeys a mode the project stated, whatever the day looks like', () => {
    expect(budgetPlan({ remaining: 50 }, { ...settings, mode: 'one-shot' })).toMatchObject({
      mode: 'one-shot',
      maxRequests: 2,
    })
    // Stated by the project, so it holds even where nothing is known — this is
    // a decision rather than an inference, and `trustworthy` gates inferences.
    expect(budgetPlan(null, { ...settings, mode: 'one-shot' }).mode).toBe('one-shot')
    expect(budgetPlan(null, { freePool: false, mode: 'one-shot' }).mode).toBe('one-shot')
    // 'agentic' is the reverse: the mode is pinned, and the two rules that are
    // about cost rather than about shape still fire.
    const pinned = budgetPlan({ remaining: 1 }, { ...settings, mode: 'agentic' })
    expect(pinned).toEqual({ mode: 'agentic', maxRequests: 1, continuations: 0 })
  })

  it('reads the thresholds it is given rather than the ones it ships with', () => {
    expect(budgetPlan({ remaining: 30 }, { ...settings, oneShotBelow: 40 }).mode).toBe('one-shot')
    expect(
      budgetPlan({ remaining: 30 }, { ...settings, mode: 'agentic', rotateAbove: 40 }).maxRequests,
    ).toBe(2)
    expect(budgetPlan({ remaining: 30 }, { ...settings, maxContinuations: 3 }).continuations).toBe(3)
  })

  /**
   * A missing threshold does not fire the rule it governs — which is today's
   * behaviour rather than an invented policy. The eval runner builds its own
   * config and passes `{}` here.
   */
  it('does nothing at all on settings that state nothing', () => {
    expect(budgetPlan({ remaining: 1 }, {})).toEqual({
      mode: 'agentic',
      maxRequests: Infinity,
      continuations: 0,
    })
    expect(budgetPlan({ remaining: 1 }, null)).toEqual({
      mode: 'agentic',
      maxRequests: Infinity,
      continuations: 0,
    })
  })

  it('plans straight off a snapshot the ledger produced', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    const at = (s) => budgetPlan(s, settings, NOON)
    expect(at(budget.snapshot()).mode).toBe('agentic')

    budget.observe({ 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': String(NOON + 7200000) })
    expect(at(budget.snapshot())).toEqual({
      mode: 'one-shot',
      maxRequests: 2,
      continuations: 1,
    })

    budget.observe({ 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': String(NOON + 7200000) })
    expect(at(budget.snapshot())).toEqual({
      mode: 'one-shot',
      maxRequests: 1,
      continuations: 0,
    })
  })
})

describe('the budget settings', () => {
  it('ships the block ui-specs/009 describes', () => {
    expect(resolveBudget({})).toEqual({
      mode: 'auto',
      oneShotBelow: 15,
      rotateAbove: 6,
      maxContinuations: 1,
      showRemaining: false,
      probe: 'auto',
      dailyLimit: null,
    })
    // The three resolvers of one block must agree, or a build emits settings the
    // browser resolves differently — which is rule 11a's whole subject.
    expect(resolveBudget({})).toEqual(DEFAULTS.budget)
    expect(resolveBudget(undefined)).toEqual(DEFAULTS.budget)
  })

  /**
   * The union `resolveSuggestions` established: one word turns the whole block
   * off, and the resolved shape is still the finished object so nothing
   * downstream has to ask which form it was given.
   *
   * OFF INCLUDES THE THRESHOLDS. `budgetPlan` reads `rotateAbove` whatever
   * `mode` says, so a `false` block left holding 15 and 6 went on rationing the
   * one deployment that had explicitly switched it off — which is the same
   * defect as rationing a paid key, arriving by the opposite route. The second
   * half of this test is the one that would have caught it: the thinnest budget
   * the ledger can report, planned as the turn that shipped.
   */
  it('takes `false` as the feature off in one word', () => {
    const off = resolveBudget({ budget: false })
    expect(off).toEqual({
      ...BUDGET_DEFAULTS,
      mode: 'agentic',
      oneShotBelow: BUDGET_NEVER,
      rotateAbove: BUDGET_NEVER,
      showRemaining: false,
      probe: 'always',
    })

    const thin = { remaining: 1, source: 'header', resetAt: NOON + 7200000 }
    expect(budgetPlan(thin, { ...off, freePool: true }, NOON)).toMatchObject({
      mode: 'agentic',
      maxRequests: Infinity,
    })
  })

  /**
   * `-1` is a value an author may write, and the only one that retires a single
   * rule without turning the block off. Anything below it is still a typo.
   */
  it('takes -1 as the threshold that never fires', () => {
    const report = vi.fn()
    expect(resolveBudget({ budget: { rotateAbove: -1 } }, report)).toEqual({
      ...BUDGET_DEFAULTS,
      rotateAbove: BUDGET_NEVER,
    })
    expect(report).not.toHaveBeenCalled()

    const kept = resolveBudget({ budget: { oneShotBelow: -1 } }, report)
    expect(kept.oneShotBelow).toBe(BUDGET_NEVER)
    // One rule retired, the other still the shipped one.
    expect(kept.rotateAbove).toBe(6)
    expect(report).not.toHaveBeenCalled()

    expect(resolveBudget({ budget: { rotateAbove: -2 } }, report).rotateAbove).toBe(6)
    expect(report).toHaveBeenCalledOnce()
  })

  /**
   * A continuation is the one number here that SPENDS requests, so it is the one
   * with a ceiling: 99 against a fifty-a-day allowance is this block causing the
   * failure it exists to prevent.
   */
  it('clamps maxContinuations to what a truncation actually costs', () => {
    const report = vi.fn()
    expect(resolveBudget({ budget: { maxContinuations: 99 } }, report).maxContinuations).toBe(1)
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0][0]).toMatch(/budget\.maxContinuations.*0 to 3/)

    expect(resolveBudget({ budget: { maxContinuations: MAX_CONTINUATIONS } }).maxContinuations).toBe(3)
    expect(resolveBudget({ budget: { maxContinuations: 0 } }).maxContinuations).toBe(0)
  })

  /**
   * `0` meant "no ceiling" everywhere downstream — `createBudget` turns a falsy
   * one into null and `session.js` seeds the free-tier fallback with `??` — so
   * an author writing it to mean "allow none" got the opposite in silence.
   */
  it('refuses a daily allowance of none rather than reading it as no ceiling', () => {
    const report = vi.fn()
    expect(resolveBudget({ budget: { dailyLimit: 0 } }, report).dailyLimit).toBeNull()
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0][0]).toMatch(/budget\.dailyLimit/)

    expect(resolveBudget({ budget: { dailyLimit: 1 } }).dailyLimit).toBe(1)
    expect(resolveBudget({ budget: { dailyLimit: null } }).dailyLimit).toBeNull()
  })

  it('keeps what an author actually wrote', () => {
    expect(resolveBudget({ budget: { mode: 'one-shot', dailyLimit: 200, probe: 'never' } })).toEqual({
      ...BUDGET_DEFAULTS,
      mode: 'one-shot',
      dailyLimit: 200,
      probe: 'never',
    })
  })

  /**
   * A typo in one of these runs during somebody else's docs build, and a
   * cosmetic setting has no business failing one. Reported, replaced, carry on.
   */
  it('reports the whole block being the wrong type rather than throwing', () => {
    const report = vi.fn()
    expect(resolveBudget({ budget: 'off' }, report)).toEqual(BUDGET_DEFAULTS)
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0][0]).toMatch(/budget accepts false or an object/)

    const second = vi.fn()
    expect(resolveBudget({ budget: [1, 2] }, second)).toEqual(BUDGET_DEFAULTS)
    expect(second).toHaveBeenCalledOnce()
  })

  /**
   * AND THE VALIDATOR ABOVE HAS TO BE REACHABLE FROM THE MERGER.
   *
   * `typeof [] === 'object'`, so an array took `resolveDocPilot`'s merge arm and
   * `{...DEFAULTS.budget, ...[]}` handed back the shipped block in silence —
   * with the comment right above that line saying the arrangement exists to
   * prevent exactly that. The `Array.isArray` guard in `resolveBudget` was
   * unreachable from this path.
   */
  it('routes an array to the validator instead of merging it into the defaults', () => {
    expect(resolveDocPilot({ budget: [] }).budget).toEqual([])
    expect(resolveDocPilot({ budget: ['agentic'] }).budget).toEqual(['agentic'])

    const report = vi.fn()
    expect(resolveBudget(resolveDocPilot({ budget: [] }), report)).toEqual(BUDGET_DEFAULTS)
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0][0]).toMatch(/budget accepts false or an object/)

    // The whole way through, which is the trip an author's typo actually makes.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(themeDocPilot(resolveDocPilot({ budget: [] })).budget).toEqual(BUDGET_DEFAULTS)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('reports each bad leaf and uses the shipped value for it', () => {
    const report = vi.fn()
    const got = resolveBudget(
      {
        budget: {
          mode: 'cheap',
          oneShotBelow: '15',
          rotateAbove: -2,
          maxContinuations: 1.5,
          showRemaining: 'yes',
          probe: 'sometimes',
          dailyLimit: {},
        },
      },
      report,
    )
    expect(got).toEqual(BUDGET_DEFAULTS)
    expect(report).toHaveBeenCalledTimes(7)
    expect(report.mock.calls.map((c) => c[0]).join('\n')).toMatch(/budget\.oneShotBelow/)
  })

  /**
   * IDEMPOTENT, and this is the assertion that makes the whole arrangement safe:
   * the build resolves, emits the result under the same keys, and the browser
   * resolves that again. Every member of a resolved object is a legal input
   * value, so the second pass changes nothing.
   */
  it('resolves a resolved block to itself', () => {
    const inputs = [
      undefined,
      {},
      { budget: false },
      { budget: { mode: 'one-shot', showRemaining: false, dailyLimit: 25 } },
      { budget: { probe: 'never', maxContinuations: 0 } },
      { budget: 'off' },
      { budget: { mode: 'cheap', dailyLimit: -1 } },
    ]
    for (const input of inputs) {
      const once = resolveBudget(input, () => {})
      const twice = resolveBudget({ budget: once }, () => {})
      expect(twice, JSON.stringify(input)).toEqual(once)
    }
  })

  it('reaches the browser resolved, and resolves there unchanged', () => {
    const client = themeDocPilot(resolveDocPilot({ budget: { mode: 'one-shot' } }))
    expect(client.budget).toEqual({ ...BUDGET_DEFAULTS, mode: 'one-shot' })
    // The second pass session.configure runs. A no-op, by construction.
    expect(resolveBudget(client)).toEqual(client.budget)

    const off = themeDocPilot(resolveDocPilot({ budget: false }))
    expect(off.budget).toEqual({
      ...BUDGET_DEFAULTS,
      mode: 'agentic',
      oneShotBelow: BUDGET_NEVER,
      rotateAbove: BUDGET_NEVER,
      showRemaining: false,
      probe: 'always',
    })
    expect(resolveBudget(off)).toEqual(off.budget)
  })
})

/**
 * Round 5. Three lines that were correct and undefended — the suite passed
 * either way, which is exactly how the four rounds before this one each undid
 * something the round before had fixed.
 */
describe('a statement is judged by its own window, and a spent day counts itself', () => {
  const HOUR = 3_600_000

  /**
   * `defendable` has to be a property of the statement being judged. Guarded on
   * `resetAt`, a reset-less count kept the PREVIOUS statement's window and was
   * then defended by it: a daily "2 left" followed by a reset-less "30" read as
   * a header statement about the day, destroyed the count that could be
   * defended, and planned a full agentic walk into a day with two answers in it.
   */
  it('does not let a reset-less count inherit the window of the statement it replaced', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })

    const daily = budget.observe({
      'x-ratelimit-limit': '50',
      'x-ratelimit-remaining': '2',
      'x-ratelimit-reset': String(NOON + HOUR),
    })
    expect(daily).toMatchObject({ remaining: 2, defensibleRemaining: 2, source: 'header' })
    expect(budgetPlan(daily, { ...BUDGET_DEFAULTS, freePool: true }, NOON)).toMatchObject({
      mode: 'one-shot',
    })

    // The service now says 30 and says nothing about when that 30 runs out.
    // That is a count nobody can defend, whatever the last response happened to
    // carry, so it must not hand back the answers the defended count says are gone.
    const loose = budget.observe({ 'x-ratelimit-remaining': '30' })
    // The defended statement is still the ledger — that is the whole rule — so
    // the source has not changed. What must not have happened is the 30
    // becoming the number a plan is built on.
    expect(loose.defensibleRemaining).toBe(2)
    expect(loose.remaining).toBe(2)
    expect(budgetPlan(loose, { ...BUDGET_DEFAULTS, freePool: true }, NOON)).toMatchObject({
      mode: 'one-shot',
    })
  })

  /**
   * The 429 that refuses a request BECAUSE the day is gone is itself the count,
   * and OpenRouter is under no obligation to restate it in a header. Without
   * this the panel printed "out of free answers until …" beside "43 of 50 left
   * today" and planned the next question as a full agentic walk.
   */
  it('records a spent day the service refused to number', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    budget.spend(7)

    const s = budget.observe({ 'retry-after': '3600' }, 'daily')

    expect(s.remaining).toBe(0)
    expect(s.defensibleRemaining).toBe(0)
    expect(budget.exhausted()).toBe(true)
    expect(budgetPlan(s, { ...BUDGET_DEFAULTS, freePool: true }, NOON)).toMatchObject({
      mode: 'one-shot',
      maxRequests: 1,
    })
  })

  /** The burst control: a minute's refusal still says nothing about the day. */
  it('still learns nothing from a burst refusal that carries no count', () => {
    const budget = createBudget({ storage: null, now: () => NOON, dailyLimit: FREE_TIER_DAILY })
    budget.spend(7)

    const s = budget.observe({ 'retry-after': '30' }, 'burst')

    expect(s.remaining).toBe(FREE_TIER_DAILY - 7)
    expect(budget.exhausted()).toBe(false)
  })
})

/**
 * THE PREDICATE, AND THE BUG IT WAS EXTRACTED TO END.
 *
 * "Does this deployment have a daily allowance" has two arms and always has:
 * `session.js` seeds the ledger's ceiling from
 * `dailyLimit ?? (freePool ? FREE_TIER_DAILY : null)`, and `trustworthy` opened
 * with `declared || freePool`. The panel's budget line asked the same question
 * and tested `freePool` alone, so `budget: {dailyLimit: 500, showRemaining: true}`
 * on a metered provider was rationed against 500 for the whole day and never
 * shown the count — the one deployment being rationed was the one unable to see
 * it, which is the exact failure the `llm.models` version before it had.
 *
 * The fix is one exported function with two callers, so this suite owns the
 * predicate and the second half of the pair is pinned on the component's source
 * below: there is no mounted-panel harness here, and what matters about that
 * line is which facts gate it.
 */
describe('hasDailyAllowance — the two arms of a ceiling', () => {
  it('says yes to a declared limit, whatever the provider', () => {
    expect(hasDailyAllowance({ dailyLimit: 500, freePool: false })).toBe(true)
    expect(hasDailyAllowance({ dailyLimit: 1 })).toBe(true)
  })

  it('says yes to the free pool with nothing declared', () => {
    expect(hasDailyAllowance({ dailyLimit: null, freePool: true })).toBe(true)
    expect(hasDailyAllowance({ freePool: true })).toBe(true)
  })

  /**
   * A falsy ceiling is ABSENCE, not a ceiling of none — the same reading
   * `createBudget` gives it, and the reason `resolveBudget` reports and drops a
   * `dailyLimit` of `0` rather than obeying it.
   */
  it('reads a zero or negative ceiling as no ceiling', () => {
    expect(hasDailyAllowance({ dailyLimit: 0, freePool: false })).toBe(false)
    expect(hasDailyAllowance({ dailyLimit: -1, freePool: false })).toBe(false)
  })

  it('says no to a metered provider that declared nothing, and never throws', () => {
    expect(hasDailyAllowance({ dailyLimit: null, freePool: false })).toBe(false)
    for (const input of [undefined, null, {}, { dailyLimit: 'lots' }, { freePool: 'yes' }]) {
      expect(() => hasDailyAllowance(input)).not.toThrow()
      expect(hasDailyAllowance(input)).toBe(false)
    }
  })

  // `trustworthy` must be exactly what it was — the extraction moved the test,
  // it did not change it. Both arms, and the metered-and-silent case that is the
  // whole reason the first question exists.
  it('is the first question `trustworthy` asks, unchanged', () => {
    const snap = { source: 'local', remaining: 10 }
    expect(trustworthy(snap, { dailyLimit: 500, freePool: false })).toBe(true)
    expect(trustworthy(snap, { dailyLimit: null, freePool: true })).toBe(true)
    expect(trustworthy(snap, { dailyLimit: null, freePool: false })).toBe(false)
    expect(trustworthy(snap, { dailyLimit: 0, freePool: false })).toBe(false)
  })

  /**
   * The count the panel would print, end to end and without a browser: a metered
   * provider with a ceiling written down counts against it from the first
   * request, so both halves of the fraction are finite and the line has
   * something to say.
   */
  it('gives a declared ceiling a finite fraction to render', () => {
    const ledger = createBudget({ storage: null, dailyLimit: 500 })
    ledger.spend()
    ledger.spend()
    const snap = ledger.snapshot()
    expect(snap.limit).toBe(500)
    expect(snap.remaining).toBe(498)
    expect(Number.isFinite(snap.remaining) && Number.isFinite(snap.limit)).toBe(true)
    expect(snap.source).toBe('local')
  })

  /**
   * The component half, pinned on the source the way `embedNote` is in
   * no-embed.test.js. What matters is which facts gate the line — and that the
   * one-armed test that caused this is gone rather than merely joined.
   */
  it('gates the panel line on the predicate, not on the free pool alone', () => {
    const panel = srcText('src/theme/components/DocPilot.vue')
    expect(panel).toContain("import { hasDailyAllowance } from '../docpilot/budget.js'")
    expect(panel).toContain(
      "if (!s.config.budget.showRemaining || !hasAllowance.value) return ''",
    )
    // The old gate, in the form that shipped the bug. Its absence is the test.
    expect(panel).not.toContain('!s.config.llm.freePool) return')
  })

  /**
   * The copy follows the gate. "free" is a claim about the provider, and the
   * line renders on a paid key with a declared ceiling — so the word had to go
   * with the widening rather than after it.
   */
  it('has copy that is true on both arms', () => {
    const shipped = srcText('src/theme/docpilot/i18n.js')
    expect(shipped).toContain("budgetLeft: '{n} of {limit} answers left today',")
    expect(shipped).not.toContain('free answers left today')
  })
})
