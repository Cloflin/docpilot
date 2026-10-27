/**
 * The polite region is a QUEUE, not a slot — ui-specs/009.
 *
 * It is still throttled, and for the reason it always was: pushing every token
 * through a live region is one uninterruptible blast that cannot be paused,
 * rewound or navigated, and `modern-web-guidance` adds the second half — a small
 * delay keeps an announcement from landing on top of the speech that focus
 * management has just produced.
 *
 * What changed is what happened to a message that arrived DURING the wait. It
 * was dropped: `clearTimeout` and then overwrite, so of "Quote added" followed
 * inside half a second by "Answer ready", only the second was ever spoken. The
 * reader who depends on this region is the only one who could have noticed.
 *
 * The region itself is in `Panel.vue`, outside the window's `v-if` — see the
 * comment there for why it has to be resident.
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import * as session from '../../docpilot/session.js'

const ANNOUNCE_MS = 500

export function useAnnouncer() {
  const s = session.state
  const announced = ref('')
  const announceQueue = []
  let announceTimer: ReturnType<typeof setTimeout> | null = null

  function drainAnnounce() {
    const next = announceQueue.shift()
    // A polite region speaks when its text CHANGES, so the same message twice in
    // a row would be silent the second time. A zero-width space makes it a
    // different string and reads identically.
    announced.value = next === announced.value ? `${next}​` : next
    announceTimer = announceQueue.length ? setTimeout(drainAnnounce, ANNOUNCE_MS) : null
  }

  // The pair, not the sentence: a watcher fires on a change, and the same sentence
  // said twice is only a change in `announceSeq` — `session.say` bumps it on every
  // call. The text stays in the pair so a bare write to `announce` still speaks.
  watch(
    () => [s.announce, s.announceSeq],
    ([msg]) => {
      if (!msg) return
      announceQueue.push(msg)
      if (!announceTimer) announceTimer = setTimeout(drainAnnounce, ANNOUNCE_MS)
    },
  )

  // The queue outlives one drain, so its timer has to be cancelled here as well:
  // a pending callback would write into a ref whose component has gone.
  onBeforeUnmount(() => {
    clearTimeout(announceTimer)
    announceQueue.length = 0
  })

  return announced
}
