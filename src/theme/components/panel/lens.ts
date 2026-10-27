/**
 * ── the lens — ui-specs/016 ──────────────────────────────────────────────────
 *
 * One hover fill per row, travelling from the item the pointer left to the one
 * it reached instead of fading out on one and in on the next. Five rows carry
 * one, each with the kind of item that takes it:
 *
 *   the header's buttons and both action rows   an icon button
 *   the scope picker's presets                  a ghost pill
 *   the suggestions                             a suggestion
 *   every list of sources, history included     a row
 *
 * The lens is the ROW's own `::before`, switched by `data-lens` and placed by
 * four `--docpilot-lens-*` properties on the row — no node of its own, so a list
 * of sources keeps nothing but its items. Both are written to the node, not to state:
 * the lens moves on every `pointerover`, and a reactive position would
 * re-render the panel for a paint no template reads. Vue owns no attribute or
 * style on these rows, so a render undoes nothing written here.
 *
 * ONE pair of listeners, on the panel. `pointerover` bubbles, so a row of forty
 * sources needs no listener of its own, and `pointerout` with its
 * `relatedTarget` is `pointerleave` for whichever row holds the lens.
 *
 * A pointer that ARRIVES from outside a row finds the lens already under it: a
 * fill that slid in from wherever it was last seen is motion with no cause on
 * screen. `data-lens-instant` switches the travel off for that move, and the
 * layout read commits the position before the travel is switched back on. Over
 * the gap between two items the lens stays; over anything else — the ghost pill
 * in a row of icon buttons, which has a shape and a wash of its own — it leaves.
 *
 * Touch is ignored. A tap has no hover to follow, and the press answers it.
 */
import { onBeforeUnmount, type Ref } from 'vue'

const LENS_ROWS = {
  'docpilot__header-actions': 'docpilot__icon-btn',
  'docpilot__actions': 'docpilot__icon-btn',
  'docpilot__picker-presets': 'docpilot__text-btn',
  'docpilot__suggestions': 'docpilot__suggestion',
  'docpilot__sources': 'docpilot__source',
}

function moveLens(row: HTMLElement, item: HTMLElement) {
  const arriving = !row.hasAttribute('data-lens')
  row.toggleAttribute('data-lens-instant', arriving)
  row.style.setProperty('--docpilot-lens-x', `${item.offsetLeft}px`)
  row.style.setProperty('--docpilot-lens-y', `${item.offsetTop}px`)
  row.style.setProperty('--docpilot-lens-w', `${item.offsetWidth}px`)
  row.style.setProperty('--docpilot-lens-h', `${item.offsetHeight}px`)
  row.setAttribute('data-lens', '')
  if (arriving) {
    void row.offsetWidth
    row.removeAttribute('data-lens-instant')
  }
}

export function useLens(panel: Ref<HTMLElement | null>) {
  // The item under the pointer, and the row it is an item OF — a button inside a
  // source row is part of that row, not an item of its own.
  function lensHit(from: Element | null) {
    for (let el = from; el && el !== panel.value; el = el.parentElement) {
      const row = el.parentElement
      if (!row) break
      for (const [rowClass, itemClass] of Object.entries(LENS_ROWS)) {
        if (row.classList.contains(rowClass) && el.classList.contains(itemClass)) {
          return { row, item: el as HTMLElement, itemClass }
        }
      }
    }
    return null
  }

  /**
   * Items come and go, and grow, under the pointer — New chat takes Copy and
   * itself out of the header, a thumb down brings the pill into the answer row, a
   * citation's passage opens inside its row. ONE observer, on the row that holds
   * the lens and only while it does: it re-measures whichever item is still
   * `:hover`, or lets the lens go.
   */
  let lensRow: HTMLElement | null = null
  let lensItem = ''
  let lensWatch: MutationObserver | null = null

  function dropLens() {
    lensRow?.removeAttribute('data-lens')
    lensWatch?.disconnect()
    lensRow = null
  }

  function aimLens(e: PointerEvent) {
    if (e.pointerType === 'touch') return
    const hit = lensHit(e.target as Element)
    if (!hit) {
      if (e.target !== lensRow) dropLens()
      return
    }
    if (hit.row !== lensRow) {
      dropLens()
      lensRow = hit.row
      lensItem = hit.itemClass
      lensWatch ??= new MutationObserver(() => {
        const item = lensRow?.querySelector<HTMLElement>(`:scope > .${lensItem}:hover`)
        if (lensRow && item) moveLens(lensRow, item)
        else dropLens()
      })
      lensWatch.observe(hit.row, { childList: true, subtree: true })
    }
    moveLens(hit.row, hit.item)
  }

  function leaveLens(e: PointerEvent) {
    if (lensRow && !lensRow.contains(e.relatedTarget as Node | null)) dropLens()
  }

  onBeforeUnmount(() => lensWatch?.disconnect())

  return { aimLens, leaveLens }
}
