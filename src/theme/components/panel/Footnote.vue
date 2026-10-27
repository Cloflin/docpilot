<template>
  <p id="dp-footnote" class="docpilot__footnote">
    <button
      v-if="s.config.scope.enabled"
      id="dp-scope-btn"
      type="button"
      class="docpilot__scope"
      :aria-expanded="String(s.dockPanel === 'picker')"
      aria-controls="dp-picker"
      :aria-label="T('composer.scopeAria', { scope: scopeLabel })"
      @click="toggleDock('picker')"
    >{{ scopeLabel }}</button
    ><span v-if="s.turns.length"
      ><template v-if="s.config.scope.enabled"> · </template>{{ disclaimer }}</span
    ><span v-if="s.config.ui.credit"
      ><template v-if="creditSep"> · </template
      ><a
        class="docpilot__credit"
        :href="CREDIT_URL"
        :title="T('credit.title')"
        target="_blank"
        rel="noopener noreferrer"
        >{{ T('credit.label') }}</a
      ></span
    >
    <button
      v-if="s.config.prompt.show && (s.turns.length || s.instruction)"
      type="button"
      class="docpilot__prompt-toggle"
      :aria-expanded="String(s.dockPanel === 'prompt')"
      aria-controls="dp-prompt"
      @click="toggleDock('prompt')"
    >{{ promptToggleText }}</button>
  </p>
</template>

<script setup lang="ts">
/**
 * The row under the field: the scope the next question is asked of, what the
 * panel sends, who made it, and the prompt document's toggle. It is the field's
 * last description — `dp-footnote` in its `aria-describedby`.
 */
import { computed } from 'vue'
import * as session from '../../docpilot/session.js'
import { usePanel } from './context.js'

const s = session.state
const { T, toggleDock } = usePanel()
const scopeLabel = session.scopeLabel

// Three-way, because the sentence names what actually travels. "Not-helpful
// reports are sent" is false the moment a thumb up is transmitted too, and
// equally false when an endpoint is configured and `send: 'none'` switches it
// off — a disclaimer that overstates is worse than none.
const disclaimer = computed(() => {
  const { feedbackEndpoint, feedback } = s.config
  if (!feedbackEndpoint || feedback.send === 'none') return T('disclaimer.base')
  return T(feedback.send === 'down' ? 'disclaimer.withFeedback' : 'disclaimer.withRating')
})

/**
 * The footnote's one word of attribution — `ui.credit`, on by default.
 *
 * Hardcoded rather than configurable: this is the link to the project the panel
 * IS, and a site that wants a different destination wants a different sentence,
 * which is what `ui.credit: false` plus their own markup gives them. Held equal
 * to `homepage` in package.json by packaging.test.js, because those two have
 * disagreed before.
 */
const CREDIT_URL = 'https://docpilot-nine.vercel.app'

/**
 * WHETHER A SEPARATOR BELONGS IN FRONT OF IT — the credit is the first thing on
 * this line that renders unconditionally, and a `·` belongs to what precedes it.
 *
 * Both of the segments before it are optional: the scope button is gone under
 * `scope.enabled: false`, and the disclaimer only arrives with the first answer.
 * With neither, a leading dot is the whole footnote's first character. The
 * disclaimer carries the same test for the same reason, one segment earlier.
 */
const creditSep = computed(() => s.config.scope.enabled || s.turns.length > 0)

const promptToggleText = computed(() =>
  T(s.instruction ? 'promptDoc.toggleWithYours' : 'promptDoc.toggle'),
)
</script>
