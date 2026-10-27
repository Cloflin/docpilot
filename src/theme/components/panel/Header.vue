<template>
  <header class="docpilot__header" :class="{ 'is-scrolled': scrolled }">
    <!-- the trigger's own glyph: the control pressed and the panel it
         produced carry one mark. aria-hidden, so the heading is still
         named "DocPilot" for aria-labelledby on the mobile dialog. -->
    <h2 id="dp-title" class="docpilot__title"><Icon name="sparkle" />{{ T('panel.title') }}</h2>
    <div class="docpilot__header-actions">
      <!-- past → new → close. Managing conversations is a panel-level
           action, which is why it sits beside New chat rather than in the
           footnote row with the scope and prompt toggles. -->
      <button
        v-if="hasHistory"
        id="dp-history-btn"
        type="button"
        class="docpilot__icon-btn"
        :aria-label="T('history.open')"
        :aria-expanded="String(s.dockPanel === 'history')"
        aria-controls="dp-history"
        @click="toggleDock('history')"
      >
        <Icon name="history" />
      </button>
      <!--
        The conversation as Markdown — ui-specs/009,
        `history.exportThread`. Under the same condition as New chat, and
        beside it: both act on the thread as a whole, which is what makes
        them panel-level rather than turn-level controls.

        Four 32px controls plus their gaps against the title at
        `--dp-width: 360px` is tight, and the TITLE is what gives: at that
        width the panel is named by the thread under it.
      -->
      <button
        v-if="s.turns.length && s.config.history.exportThread"
        type="button"
        class="docpilot__icon-btn"
        :aria-label="T('panel.copyThread')"
        @click="copyThread"
      >
        <Icon :name="threadCopied ? 'check' : 'copy'" />
      </button>
      <button
        v-if="s.turns.length"
        type="button"
        class="docpilot__icon-btn"
        :aria-label="T('panel.newChat')"
        @click="newChat"
      >
        <Icon name="compose" />
      </button>
      <button type="button" class="docpilot__icon-btn" :aria-label="T('panel.close')" @click="close">
        <Icon name="x" />
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
/** The panel's title, and the four controls that act on the panel as a whole. */
import { computed, ref } from 'vue'
import * as session from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Icon from './Icon.vue'

const s = session.state
const { T, scrolled, atBottom, input, quote, closeAsk, toggleDock, withSources } = usePanel()

const close = () => session.close()
// `scrolled` is written by a scroll EVENT, and replacing the thread's contents
// does not reliably produce one — a shorter document clamps `scrollTop` without
// always notifying. So every path that swaps the conversation says so directly,
// or the header keeps a divider describing a scroll position that no longer
// exists. `atBottom` is the same value read from the same scroller, so it is
// reset in the same three places and for the same reason — here, and in
// History.vue's `openConversation` and `clearAll`.
const newChat = () => {
  session.newChat()
  input.value = ''
  quote.value = ''
  closeAsk()
  scrolled.value = false
  atBottom.value = true
}

const hasHistory = computed(
  () => s.config.history.enabled && (s.history.length > 0 || s.turns.length > 0),
)

/**
 * The whole conversation as Markdown — ui-specs/009, `history.exportThread`.
 *
 * Per-turn copy already existed; what a support engineer pastes into a ticket is
 * the THREAD, and reassembling one from four separate copies is the work this
 * removes.
 *
 * Through `withSources`, so the export honours `citations.inCopy` exactly as a
 * single answer does — two copy paths that disagree about provenance would be
 * two answers to one question.
 *
 * The quote rides as a blockquote above its question, which is where it sits on
 * screen and what Markdown already has for it.
 */
const threadCopied = ref(false)

async function copyThread() {
  const text = s.turns
    .map((turn) => {
      const quoted = turn.quote ? `> ${turn.quote.replace(/\n/g, '\n> ')}\n\n` : ''
      return `## ${turn.question}\n\n${quoted}${withSources(turn)}`
    })
    .join('\n\n---\n\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return /* clipboard denied — the thread is still selectable */
  }
  threadCopied.value = true
  setTimeout(() => (threadCopied.value = false), 2000)
  session.say(T('announce.threadCopied'))
}
</script>
