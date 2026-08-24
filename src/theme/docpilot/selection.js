/**
 * The selection watcher behind "Ask AI" — ui-specs/007's mechanism, extracted by
 * ui-specs/009 so it can run in two places.
 *
 * 007 shipped this inside the panel, watching for a selection inside a settled
 * answer. 009 points a second instance at the HOST'S OWN ARTICLE, because the
 * gesture a documentation reader actually has is *select the paragraph that
 * confused you* — and that gesture used to lead nowhere.
 *
 * WHAT IS SHARED IS THE MECHANISM, not the markup. The markup is ten lines and
 * the two mounts want different ancestors for it; the part worth having in one
 * place is everything below, which is a list of platform failures somebody had
 * to find:
 *
 *   · `selectionchange` is the primary and the pointer events only suppress it.
 *     It is the one event that fires for EVERY way a selection is made — a drag,
 *     Shift+Arrow, a double-click, and the native touch handles, which produce
 *     no `pointerup` at all.
 *   · the release is read on `pointerup`, on `pointercancel` (a touch the
 *     platform took over) AND on the window losing focus (a drag that ended over
 *     the devtools), in the CAPTURE phase where nothing downstream can stop it.
 *     A release this never hears leaves `dragging` stuck true and the feature
 *     silently dead for the rest of the page's life.
 *   · the quote is captured WHEN THE POPOVER OPENS, not when the button is
 *     pressed: focusing a control collapses the document selection in some
 *     engines before a click handler runs, so reading it at press time would
 *     produce an empty quote on exactly the platforms where the button is the
 *     only way in. Holding the string is also what makes the button reachable by
 *     Tab, since a keyboard reader has to leave the selection to get to it.
 *
 * NO DOM OF ITS OWN. The caller supplies the element and renders the popover;
 * this owns when it is open, what it holds and where it goes.
 */

import { ref } from 'vue'

/**
 * @param {object}   o
 * @param {() => HTMLElement|null} o.el        the popover element, once rendered
 * @param {() => boolean}          o.enabled   the `quote.*` switch for this mount
 * @param {(range: Range) => HTMLElement|null} o.containerOf
 *        the element BOTH ends of the selection must be inside, or null. Both
 *        mounts prove containment the same way — `closest` from the common
 *        ancestor — because a selection that starts in one region and ends in
 *        the next has their PARENT as its ancestor, and a parent is not a match.
 * @param {(el: HTMLElement) => boolean} [o.eligible]  a second, caller-owned test
 * @param {() => DOMRect|null}     o.boxOf     the rect the popover is clamped to
 * @param {(text: string) => string} o.clamp   the length cap on a passage
 * @param {() => boolean}          o.coarse    is this a touchscreen?
 * @param {(frag: DocumentFragment) => void} [o.strip]  furniture to drop from the text
 */
export function createSelectionAsk(o) {
  const open = ref(false)
  const style = ref(null)
  const below = ref(false)

  /**
   * Does this engine have the popover API?
   *
   * A REF, and returned, because the caller's template needs it too: the
   * attribute is `popover="manual"` where the platform has one and absent where
   * it does not, and the absence IS the fallback — a plain fixed box, which an
   * ancestor's overflow does not clip either. Two independent copies of one
   * platform check is how the markup and the behaviour come to disagree.
   */
  const canPopover = ref(false)

  let quote = ''
  let range = null
  let timer = null
  let dragging = false
  let placing = false

  /** The passage, as the reader sees it. */
  function textOf(r) {
    const frag = r.cloneContents()
    o.strip?.(frag)
    return frag.textContent || ''
  }

  function evaluate() {
    if (!o.enabled()) return close()
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return close()
    const r = sel.getRangeAt(0)
    const container = o.containerOf(r)
    if (!container) return close()
    if (o.eligible && !o.eligible(container)) return close()

    const text = o.clamp(textOf(r))
    if (!text) return close()

    quote = text
    range = r.cloneRange()
    open.value = true
    return true
  }

  /**
   * Call after the caller has flushed the popover into the DOM.
   *
   * Split from `evaluate` because the two mounts reach their `nextTick`
   * differently and a factory has no business owning a component's flush.
   */
  function present() {
    if (!open.value) return
    if (canPopover.value) {
      try {
        o.el()?.showPopover()
      } catch {
        /* already open — the reader extended a selection that was already ours */
      }
    }
    place()
  }

  function place() {
    const el = o.el()
    const box = o.boxOf()
    if (!el || !range || !box) return
    let rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) rect = range.getClientRects()[0] || rect
    // Scrolled out of the box entirely. Following it off the edge would leave a
    // button floating over something it is not pointing at.
    if (rect.bottom < box.top || rect.top > box.bottom) return close()

    const w = el.offsetWidth
    const h = el.offsetHeight
    const gap = 8
    // Below the selection on a coarse pointer: iOS draws its own Copy / Look Up
    // callout ABOVE a selection, and two bubbles fighting over the same forty
    // pixels is one the reader cannot press.
    const isBelow = o.coarse() || rect.top - h - gap < box.top + 4
    const top = isBelow ? rect.bottom + gap : rect.top - h - gap
    const left = rect.left + rect.width / 2 - w / 2
    below.value = isBelow
    style.value = {
      top: `${Math.round(Math.min(Math.max(top, box.top + 4), box.bottom - h - 4))}px`,
      left: `${Math.round(Math.min(Math.max(left, box.left + 8), box.right - w - 8))}px`,
    }
  }

  // Coalesced into one rAF, because the scroll listener that calls it is passive
  // and deliberately cheap — this must not be the thing that makes it expensive.
  function reposition() {
    if (!open.value || placing) return
    placing = true
    requestAnimationFrame(() => {
      placing = false
      place()
    })
  }

  function close() {
    clearTimeout(timer)
    if (!open.value) return false
    if (canPopover.value) {
      try {
        o.el()?.hidePopover()
      } catch {
        /* already closed */
      }
    }
    open.value = false
    style.value = null
    range = null
    quote = ''
    return false
  }

  /** The held passage, and the close that always follows taking it. */
  function take() {
    const text = quote
    close()
    return text
  }

  // ── the listeners ──────────────────────────────────────────────────────────

  function onSelectionChange(after) {
    clearTimeout(timer)
    const sel = document.getSelection()
    // Collapsing is immediate; opening waits. A reader who clicks to dismiss must
    // not watch the button sit there for a fifth of a second first.
    if (!sel || sel.isCollapsed) return close()
    if (dragging) return
    timer = setTimeout(() => after(evaluate()), 180)
  }

  function onPointerDown(e) {
    dragging = e.pointerType === 'mouse' || e.pointerType === 'pen'
    // The press that opens the button must never be the press that closes it.
    if (!o.el()?.contains(e.target)) close()
  }

  function onPointerUp(after) {
    dragging = false
    clearTimeout(timer)
    timer = setTimeout(() => after(evaluate()), 0)
  }

  function onPointerLost() {
    dragging = false
  }

  /** Both mounts bind the same five, on the same terms. Returns the unbinder. */
  function bind(after) {
    canPopover.value = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype
    const sel = () => onSelectionChange(after)
    const up = () => onPointerUp(after)
    document.addEventListener('selectionchange', sel)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', onPointerLost, true)
    window.addEventListener('blur', onPointerLost)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('selectionchange', sel)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', onPointerLost, true)
      window.removeEventListener('blur', onPointerLost)
      window.removeEventListener('resize', reposition)
      clearTimeout(timer)
    }
  }

  return {
    open,
    style,
    below,
    canPopover,
    bind,
    present,
    reposition,
    close,
    take,
    /** Test seam — a node run has neither a selection nor the popover API. */
    __evaluate: evaluate,
  }
}
