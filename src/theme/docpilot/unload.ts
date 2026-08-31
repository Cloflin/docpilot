/**
 * The moment the page goes away, bound once — ui-specs/012.
 *
 * WHAT IT IS FOR. `saveCurrent()` writes the thread once per settled turn and
 * once per vote, never mid-stream, because a per-token write would serialise the
 * whole conversation on every frame. That economy is right and it stays; what it
 * left open is the case where the reader leaves BEFORE the turn settles. Every
 * token already streamed is thrown away, and the upstream request that produced
 * them has already been paid for.
 *
 * `pagehide`, NOT `beforeunload`. `beforeunload` exists to ask a question, and
 * the only question it can ask is a browser dialog — which this package has
 * ruled out elsewhere on its own terms. It is also the event engines penalise:
 * registering one disqualifies the page from the back/forward cache. `pagehide`
 * is the event for "write down what you have", and it fires on navigation and on
 * bfcache entry alike.
 *
 * AND `visibilitychange` BESIDE IT, because mobile Safari can discard a
 * backgrounded tab without ever firing `pagehide`. That pairing is what every
 * vendor guide has recommended since 2018, and it has a sharp edge: a tab
 * switch, an app switch and a screen lock all fire it. So `save` MUST be
 * idempotent for one turn — `session.saveIfRunning` is, and the flag it keys on
 * lives on the turn.
 *
 * REFERENCE COUNTED, exactly as `hotkey.js` is and for the same reason: HMR
 * unmounts twice, so a count that can go negative is a feature that stops
 * working after a save. Bound on 0 → 1, released on 1 → 0, clamped at zero.
 *
 * NO IMPORTS. The saver arrives as an argument, which is what lets the counting
 * be tested without a DOM and without the store.
 */

let count = 0
let onHide = null
let onVisibility = null
let host = null
let doc = null

/**
 * `target` and `document` are injectable so the suite can drive this with two
 * plain event targets. `save` is read on the binding call only — every mount
 * passes the same `session.saveIfRunning`, and a second callback arriving later
 * would mean two panels, which this package does not have.
 */
export function bindUnload(
  save,
  target = typeof window === 'undefined' ? null : window,
  document_ = typeof document === 'undefined' ? null : document,
) {
  if (!target) return
  count += 1
  if (count > 1) return
  host = target
  doc = document_
  onHide = () => save()
  // `hidden` only. The other transition is the tab coming BACK, and writing the
  // thread down on arrival would be a write with nothing new in it.
  onVisibility = () => {
    if (doc?.visibilityState === 'hidden') save()
  }
  host.addEventListener('pagehide', onHide)
  doc?.addEventListener?.('visibilitychange', onVisibility)
}

export function unbindUnload() {
  // Clamped, not decremented blindly — an unmatched unbind is a symptom of HMR
  // rather than of a caller error, and the cost of getting it wrong is a page
  // that silently stops keeping what it was writing.
  if (count === 0) return
  count -= 1
  if (count > 0) return
  host?.removeEventListener('pagehide', onHide)
  doc?.removeEventListener?.('visibilitychange', onVisibility)
  onHide = null
  onVisibility = null
  host = null
  doc = null
}

/** For the suite: the invariant is "one listener", and it has to be observable. */
export function unloadRefCount() {
  return count
}
