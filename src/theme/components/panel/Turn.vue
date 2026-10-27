<template>
  <!-- `is-fresh` — a turn the reader asked while looking, ui-specs/015.
       Only that one rises in: a thread restored from history, or
       re-mounted by reopening the panel, was already read. -->
  <article class="docpilot__turn" :class="{ 'is-fresh': fresh.has(turn.id) }">
    <Question :turn="turn" />

    <!-- one live node of fixed geometry whose text is replaced in place -->
    <div
      v-if="s.busy && turn === s.turns[s.turns.length - 1]"
      class="docpilot__status"
      aria-hidden="true"
    >
      <span class="docpilot__status-dot" />
      <span class="docpilot__status-label">{{ statusLabel }}</span>
    </div>

    <!-- reasoning: above the answer, open while it is the only thing happening -->
    <template v-if="turn.thought">
      <button
        type="button"
        class="docpilot__thoughts-toggle"
        :aria-expanded="String(!!turn.thoughtOpen)"
        :aria-controls="`dp-thoughts-${turn.id}`"
        @click="toggleThought(turn)"
      >
        {{ thoughtLabel(turn) }}
      </button>
      <div
        v-if="turn.thoughtOpen"
        :id="`dp-thoughts-${turn.id}`"
        class="docpilot__thoughts"
        role="region"
        :aria-label="T('panel.reasoning')"
        @scroll.passive="onThoughtScroll(turn, $event)"
      >{{ turn.thought }}</div>
    </template>

    <div
      v-if="turn.answerHtml"
      class="docpilot__answer"
      :data-turn="turn.id"
      tabindex="-1"
      role="region"
      :aria-label="T('panel.answer')"
      :aria-busy="s.busy && turn === s.turns[s.turns.length - 1] ? 'true' : 'false'"
      v-html="turn.answerHtml"
      @click="onAnswerClick"
      @pointerover="onCiteEnter"
      @pointerout="linkedCite = null"
      @focusin="onCiteEnter"
      @focusout="linkedCite = null"
    />

    <p v-if="turn.state === 'aborted'" class="docpilot__meta">{{ T('turn.stopped') }}</p>

    <!-- Kept rather than withdrawn: cited, so checkable, but the model
         was not sure. The sources below are the point. -->
    <p v-if="turn.tentative && turn.state === 'complete'" class="docpilot__meta">
      {{ T('turn.tentative') }}
    </p>

    <!-- refusal: one state, four causes -->
    <Refusal v-if="turn.state === 'no-answer'" :turn="turn" />

    <!-- search-only: the passages, as the answer -->
    <Results v-if="turn.state === 'results'" :turn="turn" />

    <!-- the service failed, or the day's requests are spent -->
    <Failure v-if="turn.state === 'error' || turn.state === 'rate-limited'" :turn="turn" />

    <!-- what the answer offers the reader to do — ui-specs/018 -->
    <ToolActions v-if="turn.state === 'complete' && turn.actions?.length" :turn="turn" />

    <Sources v-if="turn.sources.length" :turn="turn" :linked="linkedCite" />

    <AnswerActions
      v-if="turn.state === 'complete' || turn.state === 'no-answer' || turn.state === 'aborted'"
      :turn="turn"
    />

    <!--
      Where to go next — ui-specs/009, `suggestions.followUps`, OFF.

      Under the NEWEST turn only. Three rows after every answer turns a
      thread into a feed, and the measurement behind the default is not a
      taste: ChatGPT ships these and its readers write custom
      instructions to suppress them.

      The rows are headings from the pages this turn cited, minus the
      headings it already used. Nothing is generated — the template does
      the grammar — so nothing can name a section the corpus does not
      have, which is the failure a generated opener has and this cannot.
    -->
    <div
      v-if="followUps(turn).length"
      class="docpilot__suggestions docpilot__suggestions--inline"
      role="group"
      :aria-label="T('empty.followUpsLabel')"
    >
      <button
        v-for="f in followUps(turn)"
        :key="f"
        type="button"
        class="docpilot__suggestion"
        @click="submitText(f)"
      >
        {{ f }}
      </button>
    </div>

    <Feedback v-if="turn.reasonOpen || turn.feedbackDone" :turn="turn" />
  </article>
</template>

<script setup lang="ts">
/**
 * One question and everything the panel said back to it. The states a turn
 * settles in each have a part of their own; what every state shares — the
 * question, the status line, the reasoning, the answer — is drawn here.
 */
import { ref, type PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Question from './Question.vue'
import Refusal from './Refusal.vue'
import Results from './Results.vue'
import Failure from './Failure.vue'
import ToolActions from './ToolActions.vue'
import Sources from './Sources.vue'
import AnswerActions from './AnswerActions.vue'
import Feedback from './Feedback.vue'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const s = session.state
const { T, fresh, statusLabel, thoughtLabel, onThoughtScroll, onAnswerClick, submitText } = usePanel()
// A press outranks the stream for the rest of the turn — session.js/autoThought.
const toggleThought = session.toggleThought

// Pointing at a marker lights the row it goes to. UI-SPEC 573: no timer, no
// coarse-pointer branch — a touch that lands on the marker navigates anyway.
// The turn's own, not the panel's: every answer numbers its sources from 1, so
// a number held by the panel lit that row under every answer in the thread.
const linkedCite = ref<number | null>(null)

function onCiteEnter(e: MouseEvent) {
  const cite = e.target.closest?.('.docpilot__cite')
  linkedCite.value = cite ? Number(cite.dataset.cite) : null
}

/**
 * Where to go next, from the corpus — ui-specs/009, `suggestions.followUps`.
 *
 * The headings on the pages this turn cited, minus the ones it cited. No model
 * call, in scope by construction, and **nothing invented**: the wording is a
 * template that is grammatical for any heading, which is exactly the difference
 * between this and the heading-derived openers 009 rejected for the default-on
 * case. A generated question can name a section the corpus does not have; this
 * cannot, because every string in it came out of the index.
 *
 * The newest turn only. Recomputed per call rather than memoised on the turn —
 * it is cheap, and a field on the turn is a field `slimTurn` would have to
 * decide about and the archive would have to carry.
 */
const FOLLOW_UPS_MAX = 3

function followUps(turn) {
  if (!s.config.suggestions.followUps || !s.index) return []
  if (turn !== s.turns[s.turns.length - 1] || turn.state !== 'complete') return []
  if (s.busy || !turn.sources?.length) return []

  const pages = new Set(turn.sources.map((src) => String(src.id).split('#')[0]))
  const used = new Set(turn.sources.map((src) => src.title))
  const out = []
  for (const chunk of s.index.chunks) {
    if (out.length >= FOLLOW_UPS_MAX) break
    if (!pages.has(chunk.path) || !chunk.title || used.has(chunk.title)) continue
    used.add(chunk.title)
    out.push(T('empty.followUp', { heading: chunk.title }))
  }
  return out
}
</script>
