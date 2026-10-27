/**
 * Following the stream — the thread, and the reasoning box inside the newest
 * turn — and letting go the moment the reader moves either one themselves.
 * The pin itself is `follow.js`; this is where it is read and written.
 */
import { ref, watch, type Ref } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { atBottom as isAtBottom, createFollower } from '../../docpilot/follow.js'

export function useAutoscroll(panel: Ref<HTMLElement | null>, thread: Ref<HTMLElement | null>) {
  const s = session.state

  /**
   * Is the reader at the foot of the thread? — the predicate behind the jump pill.
   *
   * A SECOND signal, next to `threadFollow.pinned`, and the two are kept apart
   * because they are read at different MOMENTS rather than from different facts.
   * This one is "where is the reader now", written on every scroll and on every
   * path that swaps the conversation, and it drives a control. The pin is "was
   * the reader at the foot the last time the box moved", and it is consulted
   * inside the frame that writes — where a streaming answer has already grown the
   * scroller and this one is briefly, correctly, false. Folding them together
   * would flash the pill in for the one frame between "taller" and "scrolled to
   * the new bottom", which is the flash the write order below already avoids.
   */
  const atBottom = ref(true)
  // One per scroller that gets written to. See follow.js: the pin is read from
  // the scroll event, and both of these are handed their element per call because
  // the reasoning box is unmounted every time a reader collapses one.
  const threadFollow = createFollower()
  const thoughtFollow = createFollower()
  const syncAtBottom = () => {
    const el = thread.value
    // The same slack the follower pins on, so the pill cannot appear while the
    // autoscroll still considers itself pinned.
    if (el) atBottom.value = isAtBottom(el)
  }

  // Autoscroll: one coalesced rAF per frame, and it stops the moment the reader
  // moves the thread themselves — `onThreadScroll` in Panel.vue is where that is
  // heard.
  let queued = false
  watch(
    () => s.turns.map((t) => t.answerHtml + (t.thought || '').length + t.state).join('|'),
    () => {
      // A token per frame is common and a token per millisecond is not unheard
      // of; without this the frame is requested once per token and writes the
      // same number to the same property N times before the browser paints once.
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        // The pin is tested HERE, inside the frame, and not at the top of this
        // watcher: a reader who scrolls up in the gap between the token and the
        // frame it asked for would otherwise be dragged back down by a frame that
        // was queued while they were still at the foot. `follow` makes the test.
        threadFollow.follow(thread.value)
        // After the write, not before: a streaming answer grows the scroller on
        // every frame, and the pill would otherwise flash in for the one frame
        // between "taller" and "scrolled to the new bottom".
        syncAtBottom()
      })
    },
  )

  /**
   * The reasoning box is a fixed-height scroller, so live text has to be followed
   * the same way the thread is — and STOPPED the same way, which is what
   * `thoughtFollow` is for. A reader who scrolls up inside it is re-reading a
   * line the model has already moved past; dragging them back to the foot on the
   * next token makes the box unreadable while it is the only thing on screen.
   *
   * The box is found BY THE LAST TURN'S ID, not as the last `.docpilot__thoughts`
   * in the panel. Those were the same node only while the disclosure was the
   * stream's to control: now that a reader can collapse the live one and open an
   * older one, "the last box in the document" is somebody else's reasoning.
   */
  const thoughtBox = () => {
    const last = s.turns[s.turns.length - 1]
    return last ? panel.value?.querySelector(`#dp-thoughts-${last.id}`) : null
  }
  const onThoughtScroll = (turn: Turn, e: Event) => {
    // Only the live box follows anything, so only the live box can unfollow.
    if (turn === s.turns[s.turns.length - 1]) thoughtFollow.read(e.target)
  }
  let thoughtQueued = false
  watch(
    () => s.turns[s.turns.length - 1]?.thought,
    (now, before) => {
      // The box was emptied — a new turn, or a second model call inside this one,
      // which `onStream`'s `start` clears it for. Nothing the reader scrolled up
      // to read is in there any more, so the hold on it is released with the text.
      if (!now || (before && now.length < before.length)) thoughtFollow.repin()
      if (thoughtQueued) return
      thoughtQueued = true
      requestAnimationFrame(() => {
        thoughtQueued = false
        thoughtFollow.follow(thoughtBox())
      })
    },
  )

  /**
   * Back to the newest answer.
   *
   * The pin as well as the scroll write: pressing this says "chase it again",
   * and without that a reader who jumps down mid-answer would watch the stream
   * run off the bottom of the box they just came back to.
   *
   * Instantly, not smoothly. `.docpilot__thread` sets `scroll-behavior: auto`
   * because smooth fights the autoscroll write and never settles.
   */
  function jumpToLatest() {
    const el = thread.value
    if (!el) return
    threadFollow.repin()
    el.scrollTop = el.scrollHeight
    atBottom.value = true
    // The button is about to disappear from under the pointer, so focus goes to
    // the region it scrolled — which already has a tabindex and an accessible
    // name. A mouse press leaves no ring: `:focus-visible` does not match one.
    el.focus({ preventScroll: true })
  }

  return { atBottom, threadFollow, syncAtBottom, onThoughtScroll, jumpToLatest }
}
