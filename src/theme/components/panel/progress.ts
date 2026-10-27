/**
 * What a running turn says about itself — the reasoning line's count and the
 * status line's words — and the one-second clock both are read on.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import * as session from '../../docpilot/session.js'
import { waitingKey } from '../../docpilot/status.js'

export function useProgress(T) {
  const s = session.state

  // The reasoning line counts up while reasoning is what is happening, and stops
  // at its final value the moment the first answer token lands. One second is the
  // resolution the number is read at, so it is also the tick rate — a rAF loop
  // here would re-render the thread 60 times a second to move a digit once.
  const tick = ref(0)
  let tickTimer: ReturnType<typeof setInterval> | null = null
  watch(
    () => s.busy,
    (busy) => {
      clearInterval(tickTimer)
      if (busy) tickTimer = setInterval(() => (tick.value += 1), 1000)
    },
  )
  onBeforeUnmount(() => clearInterval(tickTimer))

  function thoughtLabel(turn) {
    if (!turn.streaming || turn.answerText) return T('turn.thoughtFor', { n: turn.thoughtSeconds })
    void tick.value
    return T('turn.thinkingFor', {
      n: Math.max(1, Math.round((performance.now() - turn.startedAt) / 1000)),
    })
  }

  const statusLabel = computed(() => {
    const p = s.status
    if (!p) return ''

    /**
     * A wait long enough to be worth naming outranks the phase — ui-specs/012.
     *
     * `tick` is READ, not used: it already advances once a second while a turn
     * runs (the reasoning counter needs it), and touching it here is what makes
     * this computed re-evaluate on that same beat instead of on a timer of its
     * own. `waitingKey` returns null while anything is painting, which is why the
     * phase below stays the normal answer.
     */
    void tick.value
    const turn = s.turns[s.turns.length - 1]
    const key = waitingKey({
      elapsedMs: turn ? performance.now() - turn.startedAt : 0,
      quiet: !!turn && !turn.answerText && !turn.thought,
      escalate: s.config.ui.waitingEscalation,
    })
    if (key) return T(key)

    if (p.phase === 'reading') {
      return p.label ? T('status.readingPage', { label: p.label }) : T('status.reading')
    }
    // A site function tool — engine-spec 038. Its title, from the config.
    if (p.phase === 'tool' && p.label) return T('status.tool', { label: p.label })
    const known = ['indexing', 'thinking', 'listing', 'writing']
    return T(`status.${known.includes(p.phase) ? p.phase : 'searching'}`)
  })

  return { thoughtLabel, statusLabel }
}
