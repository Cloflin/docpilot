<template>
  <div id="dp-history" class="docpilot__dock" tabindex="-1">
    <div class="docpilot__dock-acts">
      <!-- aria-hidden: the list below is already named -->
      <span class="docpilot__picker-label" aria-hidden="true">{{ T('history.label') }}</span>
      <button v-if="s.history.length" type="button" class="docpilot__text-btn" @click="clearAll">
        {{ T(confirmClear ? 'history.clearAllConfirm' : 'history.clearAll') }}
      </button>
      <button
        type="button"
        class="docpilot__icon-btn docpilot__picker-close"
        :aria-label="T('history.close')"
        @click="closeDock()"
      >
        <Icon name="x" />
      </button>
    </div>

    <p v-if="!s.history.length" class="docpilot__meta">{{ T('history.empty') }}</p>

    <!-- A list of things you activate, not a listbox: ARIA forbids an
         interactive descendant inside role="option", and every row here
         carries a delete control. -->
    <ol
      v-else
      class="docpilot__sources docpilot__history-list"
      role="list"
      :aria-label="T('history.list')"
    >
      <li v-for="c in s.history" :key="c.id" class="docpilot__source docpilot__history-row">
        <button
          type="button"
          class="docpilot__history-open"
          :aria-current="c.id === s.conversationId ? 'true' : undefined"
          @click="openConversation(c.id)"
        >
          <span class="docpilot__source-title">{{ c.title }}</span
          ><span class="docpilot__source-tail"> · {{ ago(c.updatedAt) }}</span>
        </button>
        <!-- A bin, not an `×` — ui-specs/006. Everywhere else in this
             panel `×` dismisses something; this is the one control with
             no undo behind it, and it had borrowed that mark. -->
        <button
          type="button"
          class="docpilot__icon-btn"
          :aria-label="T('history.delete', { title: c.title })"
          @click="removeConversation(c.id)"
        >
          <Icon name="trash" />
        </button>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
/** Past conversations, docked under the header — ui-specs/003. */
import * as session from '../../docpilot/session.js'
import { relativeParts } from '../../docpilot/history.js'
import { usePanel } from './context.js'
import Icon from './Icon.vue'

const s = session.state
const { T, uiLocale, scrolled, atBottom, input, quote, closeAsk, closeDock, confirmClear } = usePanel()

const openConversation = (id) => {
  session.openConversation(id)
  input.value = ''
  quote.value = ''
  closeAsk()
  scrolled.value = false
  atBottom.value = true
}
const removeConversation = session.removeConversation

// Two steps, the same idiom the copy button uses: a native confirm() would be
// the only blocking browser dialog in the package, and this is the reader's
// only undo for a store that outlives the tab.
function clearAll() {
  if (!confirmClear.value) {
    confirmClear.value = true
    return
  }
  confirmClear.value = false
  session.clearHistory()
  input.value = ''
  quote.value = ''
  closeAsk()
  scrolled.value = false
  atBottom.value = true
}

/**
 * "3 hours ago", in the page's locale.
 *
 * `Intl.RelativeTimeFormat` rather than a table entry: the panel's own
 * pluraliser is two-form by design and cannot express Russian or Polish, and
 * `numeric: 'auto'` gives "yesterday" for free. The arithmetic is in history.js,
 * where it is testable; only the formatting needs a locale.
 */
const ago = (then) => {
  const { value, unit } = relativeParts(then, Date.now())
  try {
    return new Intl.RelativeTimeFormat(uiLocale.value, { numeric: 'auto' }).format(value, unit)
  } catch {
    return new Date(then).toLocaleDateString(uiLocale.value)
  }
}
</script>
