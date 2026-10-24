import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * A looping storyboard for a demo: `steps` is a list of durations in ms, and
 * `step` walks 0 → steps.length - 1, then starts over.
 *
 * The loop runs only while the demo is on screen, so a page with a dozen of
 * them does not keep a dozen timers busy below the fold. `go(i)` jumps to a
 * step and holds there (`hold` stays true until `play()`), which is what the
 * clickable step lists use.
 */
export function useTimeline(steps, { loop = true } = {}) {
  const step = ref(0)
  const hold = ref(false)
  const root = ref(null)
  let timer = 0
  let visible = false
  let observer

  const clear = () => clearTimeout(timer)
  const schedule = () => {
    clear()
    if (!visible || hold.value) return
    timer = setTimeout(() => {
      const next = step.value + 1
      if (next >= steps.length) {
        if (!loop) return
        step.value = 0
      } else step.value = next
      schedule()
    }, steps[step.value])
  }

  const go = (i) => {
    hold.value = true
    step.value = i
    clear()
  }
  const play = () => {
    hold.value = false
    schedule()
  }
  const restart = () => {
    hold.value = false
    step.value = 0
    schedule()
  }

  onMounted(() => {
    if (typeof IntersectionObserver === 'undefined' || !root.value) {
      visible = true
      schedule()
      return
    }
    observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      visible ? schedule() : clear()
    })
    observer.observe(root.value)
  })
  onBeforeUnmount(() => {
    clear()
    observer?.disconnect()
  })

  return { step, hold, root, go, play, restart }
}
