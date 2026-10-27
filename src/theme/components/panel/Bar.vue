<template>
  <div
    class="docpilot__bar"
    @keydown.esc.stop.prevent="onBarEsc"
    @focusin="onBarFocus"
    @focusout="onBarFocus"
    @pointerenter="warm"
  >
    <Field v-if="fieldInBar" :in-bar="true" />
    <button
      v-else
      type="button"
      class="docpilot__bar-btn"
      :aria-expanded="String(s.open)"
      aria-controls="dp-panel"
      @click="openPanel"
    >
      <Icon name="sparkle" />
      <span class="docpilot__bar-label">{{ placeholder }}</span>
      <template v-if="s.unread && !s.open">
        <span class="docpilot__dot" aria-hidden="true" />
        <span class="docpilot__sr">{{ T('trigger.unread') }}</span>
      </template>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * The bar — ui-specs/015, `panel: 'bar'`.
 *
 * On a wide screen it is the composer's field, at the bottom centre of the
 * page: typing into it raises the window above, and sending asks. Below 960px
 * it is a button that opens the same full-screen sheet every other shape opens,
 * with the field inside — a fixed input on a phone sits under the keyboard's own
 * bar and fights the visual viewport, and the sheet already answers both.
 */
import * as session from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Field from './Field.vue'
import Icon from './Icon.vue'

const s = session.state
const { T, fieldInBar, barFocus, placeholder, onEsc } = usePanel()
const openPanel = () => session.open()

// Esc in the bar is Esc in the window while there is one — the same cascade,
// smallest thing first. With the window shut there is nothing to close, and the
// key does what it does in any search box: it lets go of the field.
function onBarEsc(e: KeyboardEvent) {
  if (s.open) return onEsc()
  ;(e.target as HTMLElement | null)?.blur?.()
}

/**
 * The bar WIDENS for its text field, and NARROWS only when focus leaves it.
 *
 * Measured, and it is a defect rather than a taste: a press on the reopen button
 * focused the bar on `pointerdown`, the bar began to widen, the button travelled
 * out from under the pointer with it, and `pointerup` landed somewhere else — so
 * no `click`, and a button that did nothing. The same happens in reverse when
 * focus moves from the field to a button and the bar narrows. So focus arriving
 * on a button changes nothing, and focus moving between the bar's own controls
 * changes nothing: every button holds still while it is being pressed. The field
 * loses nothing either — focus has already arrived by the time it starts to grow.
 */
function onBarFocus(e: FocusEvent) {
  if (e.type === 'focusin') {
    if ((e.target as Element | null)?.matches?.('textarea')) barFocus.value = true
    return
  }
  const bar = e.currentTarget as HTMLElement
  if (!(e.relatedTarget && bar.contains(e.relatedTarget as Node))) barFocus.value = false
}

// `ui.prefetch: 'hover'`, on the placement that is on the page — the trigger's
// rule, for the shape that has no trigger in the corner.
const warm = () => {
  if (s.config.ui.prefetch === 'hover') session.prefetchIndex()
}
</script>
