/**
 * `push` — the host's content moves aside instead of being covered.
 * ui-specs/009, `ui.layout`, and `overlay` stays the default.
 *
 * A CLASS ON THE ROOT, because the rule that acts on it names VitePress's own
 * selectors and therefore belongs in the adapter — where rule 2 allows exactly
 * that and nothing else. The component decides WHEN; the adapter decides what it
 * means on this host, and a consumer with a different theme overrides one rule
 * rather than patching a component.
 *
 * Not below the sheet breakpoint: there the panel is edge to edge and there is
 * no room to push anything into.
 */
import { onBeforeUnmount, watch, type ComputedRef, type Ref } from 'vue'
import * as session from '../../docpilot/session.js'
import { pushEdge } from '../../docpilot/ui.js'

const LAYOUT_CLASS = 'docpilot-push'

/**
 * WHICH EDGE, AND THE WAY BACK — ui-specs/015.
 *
 * `docpilot-push` keeps the meaning it shipped with: open, and pushing. Beside
 * it, for the same lifetime, the LOGICAL edge the page is pushed from — logical
 * because the adapters' rules are, and resolved here because `'left'` and
 * `'right'` only become an edge once the page's direction is known, which is in
 * the browser, now.
 *
 * `docpilot-push-closing` is the way back. A transition is read from the state
 * being ENTERED, so with the padding and its transition both keyed on the open
 * classes the page snapped home on the frame the drawer started to leave. The
 * adapters declare the transition on this class too, and it comes off once the
 * exit has had time to play — by a timer rather than the panel's `after-leave`,
 * because push can also end with the panel still open (a window narrowed under
 * 960px), where there is no leave to wait for.
 *
 * Never under the bar: it is centred, and there is no side to move the page away
 * from.
 */
const PUSH_EDGES = ['docpilot-push-start', 'docpilot-push-end']
const CLOSING_CLASS = 'docpilot-push-closing'

export function usePush(mobile: Ref<boolean>, panelKind: ComputedRef<string>) {
  const s = session.state
  let closingTimer: ReturnType<typeof setTimeout> | null = null

  watch(
    () => [s.open, s.config.ui.layout, mobile.value, panelKind.value, s.config.ui.side],
    ([open, layout, narrow, kind, side]) => {
      if (typeof document === 'undefined') return
      const html = document.documentElement
      const on = open && layout === 'push' && !narrow && kind !== 'bar'
      const was = html.classList.contains(LAYOUT_CLASS)
      html.classList.toggle(LAYOUT_CLASS, on)
      const edge = `docpilot-push-${pushEdge(side, getComputedStyle(html).direction === 'rtl')}`
      for (const name of PUSH_EDGES) html.classList.toggle(name, on && name === edge)
      clearTimeout(closingTimer)
      if (was && !on) {
        html.classList.add(CLOSING_CLASS)
        closingTimer = setTimeout(() => html.classList.remove(CLOSING_CLASS), 1000)
      } else if (on) html.classList.remove(CLOSING_CLASS)
    },
  )

  // The classes outlive the component otherwise: a route change that unmounts the
  // panel with the drawer open would leave the host's content permanently inset.
  onBeforeUnmount(() => {
    clearTimeout(closingTimer)
    document.documentElement.classList.remove(LAYOUT_CLASS, CLOSING_CLASS, ...PUSH_EDGES)
  })
}
