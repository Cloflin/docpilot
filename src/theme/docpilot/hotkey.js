/**
 * Cmd/Ctrl+I, bound once no matter how many triggers are mounted.
 *
 * THE BUG THIS REPLACES. Every `DocPilotTrigger` used to add its own `keydown`
 * listener to `window` in `onMounted`, and `docPilotSlots()` mounts two of them —
 * the navbar button and the mobile nav-screen row. That only ever worked
 * because `VPNavScreen` is behind a `v-if` and the second instance is rarely
 * alive: with two listeners the key toggles the panel twice and it opens and
 * shuts in one frame. A third mount would make the failure permanent, and no
 * `v-if` in the template prevents it — a component that renders nothing still
 * runs `onMounted`.
 *
 * So the listener is a module-level singleton with a reference count. Bound on
 * the 0 → 1 transition, removed on 1 → 0, and clamped at zero so that a double
 * unmount — which is what HMR does on every save — cannot drive the count
 * negative and leave the next mount without a hotkey.
 *
 * The key is Cmd/Ctrl+I, explicitly NOT Cmd+K: VitePress search owns that, and
 * taking it would break the control readers already use. It is the pair
 * VitePress 2's own DocPilot button announces, which is why `aria-keyshortcuts`
 * in the trigger matches upstream verbatim.
 */

let count = 0
let listener = null
let host = null

/**
 * `target` is injectable so the counting can be tested without a DOM. `fire` is
 * read on the binding call only — every trigger passes the same `session.toggle`,
 * and a second callback arriving later would mean two different panels, which
 * this package does not have.
 */
export function bindHotkey(fire, target = typeof window === 'undefined' ? null : window) {
  if (!target) return
  count += 1
  if (count > 1) return
  host = target
  listener = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key?.toLowerCase() !== 'i') return
    e.preventDefault()
    fire()
  }
  host.addEventListener('keydown', listener)
}

export function unbindHotkey() {
  // Clamped, not decremented blindly: an unmatched unbind is a symptom of HMR,
  // not of a caller error, and the cost of getting it wrong is a dead shortcut.
  if (count === 0) return
  count -= 1
  if (count > 0) return
  host?.removeEventListener('keydown', listener)
  listener = null
  host = null
}

/** For the suite: the invariant is "one listener", and it has to be observable. */
export function hotkeyRefCount() {
  return count
}
