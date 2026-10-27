<template>
  <form v-if="turn.reasonOpen" class="docpilot__feedback" @submit.prevent="submitFeedback(turn)">
    <!-- aria-pressed toggles rather than checkboxes: a custom checkbox
         indicator wants a resting border, and rule 1 names every one
         of those in the stylesheet individually. The pressed pill
         carries the state instead — ui-specs/004 — and the thumbs
         directly above are the same pattern. -->
    <div class="docpilot__reasons" role="group" :aria-label="T('actions.reasonsGroup')">
      <button
        v-for="value in REASONS"
        :key="value"
        type="button"
        class="docpilot__text-btn"
        :aria-pressed="String(turn.reasons.includes(value))"
        @click="toggleReason(turn, value)"
      >
        {{ T(`reasons.${value}`) }}
      </button>
    </div>

    <template v-if="commentable">
      <label class="docpilot__sr" :for="`dp-comment-${turn.id}`">{{ T('feedback.commentLabel') }}</label>
      <textarea
        :id="`dp-comment-${turn.id}`"
        v-model="turn.comment"
        class="docpilot__comment"
        rows="3"
        :maxlength="COMMENT_MAX"
        :placeholder="T('feedback.commentPlaceholder')"
        :aria-describedby="`dp-hint-${turn.id}`"
      ></textarea>
      <p :id="`dp-hint-${turn.id}`" class="docpilot__meta">{{ T('feedback.commentHint') }}</p>
      <!-- Only near the ceiling: a counter that is always on turns a
           comment box into a test. -->
      <p v-if="turn.comment.length >= COMMENT_MAX - 50" class="docpilot__meta">
        {{ T('feedback.counter', { n: turn.comment.length }) }}
      </p>
    </template>

    <div class="docpilot__reasons">
      <button type="submit" class="docpilot__text-btn">{{ T('feedback.submit') }}</button>
      <button type="button" class="docpilot__text-btn" @click="skipFeedback(turn)">
        {{ T('feedback.skip') }}
      </button>
    </div>
  </form>

  <!--
    What the form leaves behind — ui-specs/009, `feedback.confirm`.

    Submitting used to remove the form and say nothing a sighted reader
    could see, which is indistinguishable from closing it unsent.
    Resident rather than timed out: it is the record of what the reader
    did, and a transcript they scroll back through should still show it.

    Two strings, because one would be false under two of the four
    `send` modes — `feedbackLive` is the same predicate that decides
    whether the action row stays visible at rest.
  -->
  <p v-if="turn.feedbackDone && !turn.reasonOpen" class="docpilot__meta">
    {{ T(feedbackLive ? 'feedback.thanksSent' : 'feedback.thanks') }}
  </p>
</template>

<script setup lang="ts">
/** What a reader says about an answer after the thumb — and the line it leaves. */
import { computed, type PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { COMMENT_MAX } from '../../docpilot/feedback.js'
import { usePanel } from './context.js'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const s = session.state
const { T, feedbackLive, submitFeedback, skipFeedback } = usePanel()
const toggleReason = session.toggleReason

// The VALUES are stable — they are recorded in feedback reports and compared
// across runs. Only their labels are translated, which is why the table holds
// no copy any more.
const REASONS = ['wrong', 'incomplete', 'not-in-docs', 'bad-links']

// Whether anything the reader types would leave the device. A textarea whose
// contents go nowhere invites a sentence and silently discards it. The reason
// BUTTONS stay either way — they are useful in the local export, which
// `docpilot feedback pull --from` reads.
const commentable = computed(
  () =>
    s.config.feedback.comment &&
    !!s.config.feedbackEndpoint &&
    s.config.feedback.send !== 'none',
)
</script>
