/**
 * ── quoting a passage — ui-specs/007, extracted by 009 ──────────────────────
 *
 * Select inside a settled answer and one button appears above the selection.
 * Pressing it attaches the passage to the composer as a chip, where it stays
 * until it is sent or withdrawn.
 *
 * The MECHANISM lives in `selection.js`, because 009 points a second instance
 * of it at the host's own article and two copies of a list of platform failures
 * is two places for one of them to come back. What is here is what is specific
 * to the panel: which element a selection has to be inside, whether that turn
 * has settled, which box the button is clamped to, and what counts as furniture
 * in the text. The button itself is in `Panel.vue`, between the thread and the
 * composer; the chip is in `Composer.vue`.
 */
import { nextTick, ref, type Ref } from 'vue'
import * as session from '../../docpilot/session.js'
import { clampQuote } from '../../docpilot/prompt.js'
import { createSelectionAsk } from '../../docpilot/selection.js'

export function useQuoting({
  panel,
  thread,
  askEl,
  coarse,
  fieldEl,
  T,
}: {
  panel: Ref<HTMLElement | null>
  thread: Ref<HTMLElement | null>
  askEl: Ref<HTMLElement | null>
  coarse: Ref<boolean>
  fieldEl: () => HTMLTextAreaElement | null
  T: (path: string, vars?: Record<string, unknown>) => string
}) {
  const s = session.state
  const quote = ref('')

  /**
   * The answer node BOTH ends of the selection are inside, or null.
   *
   * `closest` from the common ancestor already proves containment of both ends: a
   * selection that starts in an answer and ends in the source list below it has
   * the TURN as its common ancestor, and a turn is not an answer node.
   */
  function answerOf(range) {
    const node = range.commonAncestorContainer
    const el = node.nodeType === 1 ? node : node.parentElement
    const answer = el?.closest?.('.docpilot__answer')
    return answer && panel.value?.contains(answer) ? answer : null
  }

  const ask = createSelectionAsk({
    el: () => askEl.value,
    enabled: () => s.config.quote.fromAnswer,
    containerOf: answerOf,
    /**
     * Not while anything is running. A quote is a reference to a settled answer,
     * and a passage taken out of a stream is a passage the next frame rewrites —
     * the node behind that range is replaced every 90ms while a turn is live.
     */
    eligible: (answer) => {
      const turn = s.turns.find((t) => t.id === answer.dataset.turn)
      return !s.busy && !!turn && (turn.state === 'complete' || turn.state === 'aborted')
    },
    /**
     * The THREAD's box, not the panel's: the panel includes the header and the
     * composer, and a button clamped to that would sit on top of the title while
     * pointing at a line scrolled up under it.
     */
    boxOf: () => thread.value?.getBoundingClientRect() || null,
    clamp: clampQuote,
    coarse: () => coarse.value,
    /**
     * `range.toString()` pulls a citation superscript's digit into the middle of a
     * sentence — "the scope picker1 lists" — because the marker is a real text
     * node inside the answer. Dropping the markers from a clone first is what
     * makes the quote read as the documentation it came from.
     */
    strip: (frag) => {
      for (const cite of frag.querySelectorAll?.('.docpilot__cite') || []) cite.remove()
    },
  })

  // The factory hands back whether a selection was accepted; presenting it is the
  // component's job, because only the component knows when its own template has
  // flushed the popover into the DOM.
  const onSelectionAccepted = (accepted) => {
    if (accepted) nextTick(() => ask.present())
  }

  function takeQuote() {
    const text = ask.take()
    if (!text) return
    quote.value = text
    session.say(T('announce.quoteAdded'))
    nextTick(() => fieldEl()?.focus())
  }

  function dropQuote() {
    quote.value = ''
    session.say(T('announce.quoteRemoved'))
    nextTick(() => fieldEl()?.focus())
  }

  return {
    quote,
    askOpen: ask.open,
    askStyle: ask.style,
    askBelow: ask.below,
    canPopover: ask.canPopover,
    closeAsk: ask.close,
    reposition: ask.reposition,
    // The selection watcher — five listeners, bound and unbound as one, in
    // `selection.js`. `pointerdown` runs in the CAPTURE phase there, so a press
    // on a control that stops propagation still dismisses the popover.
    bindAsk: () => ask.bind(onSelectionAccepted),
    takeQuote,
    dropQuote,
  }
}
