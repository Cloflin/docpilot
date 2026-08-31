/**
 * Following a scroller that is being written to — the thread, and the reasoning
 * box inside it.
 *
 * Both have the same job and the same failure: text arrives token by token at
 * the foot of a box, the box must stay at its foot WHILE THE READER IS THERE,
 * and it must stand still the moment the reader scrolls up to re-read
 * something. One machine, two instances, so the 40px slack and the predicate
 * behind it exist once instead of three times.
 *
 * THE PIN IS READ FROM THE SCROLL EVENT, and that is a reversal worth stating.
 * It used to be read from INTENT — a `wheel`, a `touchmove` — on the reasoning
 * that smooth scrolling makes a `scroll` event indistinguishable from a reader.
 * Two things were wrong with it. A `wheel` handler measures BEFORE the browser
 * has applied the scroll, so the position it reads is the position the reader
 * is leaving: at the foot of a streaming answer that is "still at the bottom",
 * every time, and the next token yanked them back down. And intent is only
 * three of its modalities — a scrollbar drag, PageUp, a screen reader's own
 * scrolling and touch momentum all moved the box without ever saying so.
 *
 * The event is safe here because the premise it was rejected on does not hold:
 * `.docpilot__thread` and `.docpilot__thoughts` both scroll with
 * `scroll-behavior: auto` — no animation frames to misread — and every write
 * this module makes targets the very bottom. So a write's own `scroll` event
 * can only re-affirm the pin, never drop it, and everything else that moves the
 * box is the reader, whatever they moved it with.
 */

/** Is the scroller within `slack` of its foot? The one predicate. */
export const atBottom = (el, slack = 40) => el.scrollHeight - el.scrollTop - el.clientHeight < slack

/**
 * One scroller's follow state.
 *
 * `read` belongs on that scroller's own passive `scroll` listener; `follow`
 * belongs in the frame that runs after its content grew. Both take the element
 * rather than holding it: the reasoning box is `v-if`'d away every time the
 * reader collapses a turn, and a follower holding a detached node would write
 * to a box nobody can see.
 */
export function createFollower(slack = 40) {
  let pinned = true
  return {
    get pinned() {
      return pinned
    },
    /** "Chase it again" — the jump pill, and a turn that has just begun. */
    repin() {
      pinned = true
    },
    read(el) {
      if (el) pinned = atBottom(el, slack)
    },
    follow(el) {
      if (el && pinned) el.scrollTop = el.scrollHeight
    },
  }
}
