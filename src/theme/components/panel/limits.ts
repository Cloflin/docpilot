/**
 * What the next question is limited to — what is left of the day's free
 * answers, and whether this site retrieves without an embedder. One muted line
 * under the composer's field, and the one-shot notice beside it.
 */
import { computed, ref, watch } from 'vue'
import * as session from '../../docpilot/session.js'
import { hasDailyAllowance } from '../../docpilot/budget.js'

const BUDGET_LOW_KEY = 'docpilot:budget-low'

export function useLimits(T) {
  const s = session.state

  /**
   * Whether this deployment HAS a daily allowance — the settings half of the
   * question, hoisted so the line below reads as the three conditions its docblock
   * names. `budget.js` owns the predicate; see `hasDailyAllowance`.
   */
  const hasAllowance = computed(() =>
    hasDailyAllowance({
      dailyLimit: s.config.budget.dailyLimit,
      freePool: s.config.llm.freePool,
    }),
  )

  /**
   * What is left of the day, in one muted line under the field.
   *
   * THREE conditions, and each one is a way of getting it wrong:
   *
   *   · the switch. `budget.showRemaining` defaults OFF — the count a browser can
   *     compute is not the count a shared key has — so this is a site saying it
   *     knows its own allowance and wants it stated. Off retires the low-budget
   *     note below with it, and the no-embedder note beside it.
   *   · a DAILY ALLOWANCE — `hasDailyAllowance`, called with the same two facts
   *     `session.js` seeds the ledger's ceiling from: a `budget.dailyLimit` the
   *     site declared, or `llm.freePool`, true only where the answers come off the
   *     provider's own free catalogue. Either one makes the ceiling a count of
   *     REQUESTS per day; with neither there is no such ceiling to report and a
   *     fabricated "50" would be worse than silence.
   *
   *     BOTH ARMS, and that is the fix. This tested `freePool` alone, so
   *     `budget: {dailyLimit: 500, showRemaining: true}` on a metered provider was
   *     rationed against 500 all day and never told the reader the count — the one
   *     deployment being rationed was the one unable to see it. Before that it read
   *     `llm.models`, a different question with a similar shape: config.js returns
   *     an author's own `chat.models` list for ANY provider, and a
   *     `{provider: 'openrouter', model: '…'}` free-pool config has no list at all.
   *     It is now literally the function `trustworthy` opens with, so the line and
   *     the rationing cannot disagree about who has an allowance — a claim that was
   *     made here once before and was not true.
   *   · a KNOWN snapshot. `s.budget` is null until something has been learned —
   *     a header, or a ceiling the project wrote down — and "? of ? left" is
   *     worse than no line. The finite checks repeat that here because a partial
   *     rate-limit read is normal: a `remaining` with no `limit` renders no
   *     fraction rather than the word `undefined`.
   */
  const budgetLine = computed(() => {
    const snap = s.budget
    if (!s.config.budget.showRemaining || !hasAllowance.value) return ''
    if (!snap || !Number.isFinite(snap.remaining) || !Number.isFinite(snap.limit)) return ''
    return T('error.budgetLeft', { n: snap.remaining, limit: snap.limit })
  })

  /**
   * The other thing that line can say: this deployment has no embedder.
   *
   * `config.embed.lexicalOnly` — the DECLARED mode, `embed: false` — and not
   * `state.retrieval`, which is the same word arrived at by a different route. That
   * one is only known after a question has been asked, and this line has to be
   * readable before the reader types one; an embedder that was configured and could
   * not be reached is the other case, and it already has `refusal.degraded`.
   *
   * Under `budget.showRemaining` rather than a switch of its own, because it is the
   * same sentence from the reader's side: what is this next question limited to.
   * A site that asked the panel not to discuss its own limits is not told about
   * this one either.
   */
  const embedNote = computed(() =>
    s.config.budget.showRemaining && s.config.embed.lexicalOnly ? T('error.noEmbedder') : '',
  )

  /** The two, joined — either alone, both, or nothing and no paragraph at all. */
  const statusLine = computed(() => [budgetLine.value, embedNote.value].filter(Boolean).join(' · '))

  // Whether the NEXT question will be answered in one model call. Read off the
  // session rather than re-derived here: the plan is a decision, taken in one
  // place, and a template that applied `oneShotBelow` itself would be a second
  // place for it to drift.
  const oneShot = computed(() => s.budgetMode === 'one-shot')

  /**
   * The one-shot notice, said once and then retired.
   *
   * `sessionStorage`, not the device store the first-run hint uses: this is a fact
   * about TODAY's budget, and a reader who comes back tomorrow to a full quota
   * must not meet a warning about yesterday's. Once per tab, because the drop in
   * length is only surprising the first time and a line that reappears over every
   * question for the rest of the day is nagging.
   *
   * `due` is what the flag is spent on, and it includes the budget line itself:
   * a notice nobody could have seen must not count as having been given. It also
   * keeps the note honest after it has been armed — the budget can refill
   * mid-session, and "Running low" beside "40 of 50 left" is simply false.
   */
  const budgetLowSaid = ref(false)
  const budgetLowDue = computed(() => oneShot.value && !!budgetLine.value)
  const showBudgetLow = computed(() => budgetLowSaid.value && budgetLowDue.value)

  /**
   * Armed from the panel's `onMounted`, never at setup: `sessionStorage` does not
   * exist during SSR, and the watcher must not fire before the read below has
   * decided whether this tab has already been told. A throw costs the notice a
   * repeat after a reload, which is the cheaper of the two failures.
   */
  function armBudgetLow() {
    let toldBudgetLow = false
    try {
      toldBudgetLow = sessionStorage.getItem(BUDGET_LOW_KEY) === '1'
    } catch {
      /* private mode — the notice may come back once, and that is all */
    }
    if (toldBudgetLow) return
    watch(
      budgetLowDue,
      (due) => {
        if (!due || budgetLowSaid.value) return
        budgetLowSaid.value = true
        // SAID as well as shown, and this is the half that was missing. The note
        // renders inside the composer's `aria-describedby`, and no screen reader
        // re-reads a description that changed under a textarea the reader is
        // already focused in — so the one reader who cannot see answers getting
        // shorter was the one reader never told they would. It goes through the
        // store's live region, the same one session.js announces every settled
        // turn through, so it queues behind "answer ready" instead of talking
        // over it. Once per session, on the same flag the visible note is
        // retired by: a mode change is news exactly once.
        session.say(T('error.budgetLow'))
        try {
          sessionStorage.setItem(BUDGET_LOW_KEY, '1')
        } catch {
          /* see above */
        }
      },
      { immediate: true },
    )
  }

  return { statusLine, showBudgetLow, armBudgetLow }
}
