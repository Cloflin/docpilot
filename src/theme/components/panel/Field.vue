<template>
  <div class="docpilot__field">
    <span v-if="inBar" class="docpilot__field-glyph" aria-hidden="true"><Icon name="sparkle" /></span>
    <!-- Named, not left to the placeholder fallback some readers skip, and
         named with the words on screen: a voice-control reader says what
         they see, and the bar's button below 960px is labelled with them. -->
    <textarea
      v-model="input"
      rows="1"
      maxlength="1000"
      :placeholder="placeholder"
      :aria-label="placeholder"
      aria-describedby="dp-quote dp-hint dp-counter dp-budget dp-footnote"
      @input="onFieldInput"
      @keydown="onKeydown"
    />
    <!-- With the field: its description has to exist wherever the field
         does, and in the bar that is also when the window is shut. -->
    <span id="dp-hint" class="docpilot__sr">{{ T('composer.hint', { scope: scopeLabel }) }}</span>
    <button
      v-if="inBar && s.turns.length && !s.open"
      type="button"
      class="docpilot__icon-btn docpilot__expand"
      :aria-label="[T('composer.expand'), s.unread && T('trigger.unread')].filter(Boolean).join(' ')"
      aria-controls="dp-panel"
      aria-expanded="false"
      @click="openPanel"
    >
      <Icon name="chevronDown" />
      <span v-if="s.unread" class="docpilot__dot" aria-hidden="true" />
    </button>
    <kbd v-if="inBar && !barWide && !coarse" class="docpilot__key" aria-hidden="true">{{ hotkey }}</kbd>
    <button
      type="button"
      class="docpilot__send"
      :class="{ 'is-ready': canSend || s.busy }"
      :aria-disabled="String(!canSend && !s.busy)"
      :aria-label="T(s.busy ? 'composer.stop' : 'composer.send')"
      @click="send"
    >
      <Icon :name="s.busy ? 'square' : 'arrowUp'" :filled="s.busy" />
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * THE FIELD, ONE COMPONENT — ui-specs/015.
 *
 * It has two homes and is only ever in one of them: the window's composer, as
 * it always was, or the bar at the bottom of the page under `panel: 'bar'`.
 * One component placed in either keeps it ONE piece of markup, so the
 * `aria-describedby` list, the IME guard, the draft and the send button cannot
 * drift into two versions of the same control. Its text, `input`, is the
 * panel's: the field is re-created whenever it moves, and the question is not.
 *
 * `inBar` adds the three things only the bar carries: the panel's glyph, the
 * button that brings back a conversation the reader put away, and the hotkey
 * hint a search box shows at rest.
 */
import { computed, nextTick } from 'vue'
import * as session from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Icon from './Icon.vue'

defineProps<{ inBar: boolean }>()

const s = session.state
const {
  T,
  input,
  quote,
  placeholder,
  fieldEl,
  fit,
  submitText,
  dismissDock,
  editingId,
  startTurnEdit,
  fieldInBar,
  barWide,
  coarse,
  hotkey,
} = usePanel()
const scopeLabel = session.scopeLabel
const openPanel = () => session.open()

// Not while degraded: the drawer and the popup never draw the field then, but
// the bar is on the page regardless, and a question it sent would reach a panel
// that has already said it cannot answer. ui-specs/015.
const canSend = computed(() => input.value.trim().length > 0 && !s.degraded)

/**
 * The composer's own input handler: the measurement, and — in the bar — the
 * window rising at the first character. ui-specs/015.
 *
 * On typing rather than on focus: focus is also a reader tabbing past the bar
 * on the way to the footer, and a window that rose over the article for that
 * would be the panel taking the page back unasked. The value is read off the
 * EVENT: Vue's `v-model` listener on the same element runs after this one, so
 * `input` still holds the text from before the keystroke.
 */
function onFieldInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  fit(el)
  dismissDock()
  if (fieldInBar.value && !s.open && el.value.trim()) session.open()
}

function send() {
  if (s.busy) return session.stop()
  if (!canSend.value) return
  // A question sent from the bar is a question the reader wants to watch being
  // answered, whether or not they had let the window rise yet.
  if (fieldInBar.value && !s.open) session.open()
  submitText(input.value, quote.value)
  input.value = ''
  quote.value = ''
  nextTick(() => {
    // The composer specifically. `textarea` alone is the first one in the panel,
    // which is an open question editor or feedback comment whenever one exists —
    // so the wrong field collapsed and the emptied composer stayed tall.
    const ta = fieldEl()
    if (ta) ta.style.height = 'auto'
  })
}

/**
 * Enter sends, Shift+Enter breaks the line — and neither of those is true while
 * an IME is open. ui-specs/012.
 *
 * In Japanese, Chinese and Korean, Enter is ALSO how a candidate is committed,
 * several times per sentence. Without the first line every one of those commits
 * sent a half-typed question and spent a request against a daily allowance the
 * whole site shares. That is a defect rather than a preference, so it has no
 * switch: nobody configures a keyboard to eat their own sentence.
 *
 * BOTH reads are needed. `isComposing` is a property of the native event, and
 * whether Vue's wrapper forwards it is not something this component should have
 * to know — an undefined on one path and the real flag on the other cost
 * nothing to check together.
 *
 * The guard is FIRST, before the branch as well as before the send, because a
 * reader mid-composition is not asking to edit their previous question either.
 *
 * While a turn is running Enter does nothing at all — ui-specs/014. The field is
 * no longer `readonly` on `busy`, because the composer is a place to write, not
 * the thing that enforces one turn at a time; that invariant is untouched and
 * still lives where it always did, in `session.submit`, which returns
 * immediately when `state.busy` is set, with Stop the only gesture that ends a
 * turn. Enter is left inert rather than routed into `send()`, which opens with
 * `session.stop()`: a reader who thinks of the next question mid-answer has not
 * asked for the answer they are waiting for to be thrown away. `preventDefault`
 * runs ahead of the guard, so the dead key leaves no newline in the draft.
 */
function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.nativeEvent?.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (s.busy) return
    send()
    return
  }
  if (e.key === 'ArrowUp') editLastQuestion(e)
}

/**
 * `↑` in an EMPTY composer opens the last question's editor — ui-specs/009.
 *
 * ChatGPT's own behaviour, and readline's before it, so this is a port rather
 * than an invention: a reader arrives already expecting the key to do this.
 *
 * **The empty condition is not a nicety.** Without it the key stops moving the
 * caret inside a multi-line draft, which is the behaviour it is borrowing from —
 * and a shortcut that eats a navigation key is worse than an absent one.
 *
 * Withheld while a turn is running, because `startTurnEdit` refuses on `busy`
 * anyway and a control that visibly does nothing is the thing 008 argued
 * against; and while an editor is already open, because "at most one editor"
 * is the invariant `editingId` exists to make structural.
 */
function editLastQuestion(e) {
  if (!s.config.composer.editLastOnArrowUp) return
  if (input.value.length || s.busy || editingId.value) return
  const last = s.turns[s.turns.length - 1]
  if (!last) return
  e.preventDefault()
  startTurnEdit(last)
}
</script>
