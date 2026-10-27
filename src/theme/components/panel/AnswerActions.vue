<template>
  <div class="docpilot__actions" :class="{ 'is-resident': feedbackLive }">
    <button
      v-if="turn.state !== 'no-answer'"
      type="button"
      class="docpilot__icon-btn"
      :aria-label="T('actions.copy')"
      @click="copy(turn)"
    >
      <Icon :name="turn.copied ? 'check' : 'copy'" />
    </button>
    <!-- Ask the same question again, in place of this answer rather
         than below it. On a refusal it is the FIRST control in the
         row, because copy is absent there and "I couldn't find this"
         is the one verdict a reader most wants to test. -->
    <button
      v-if="canRetry(turn)"
      type="button"
      class="docpilot__icon-btn"
      :aria-label="T('actions.retry')"
      :aria-disabled="String(s.busy)"
      @click="retryTurn(turn)"
    >
      <Icon name="retry" />
    </button>
    <button
      type="button"
      class="docpilot__icon-btn"
      :aria-label="T('actions.helpful')"
      :aria-pressed="String(turn.verdict === 'up')"
      @click="vote(turn, 'up')"
    >
      <Icon name="thumbUp" :filled="turn.verdict === 'up'" />
    </button>
    <button
      :id="`dp-down-${turn.id}`"
      type="button"
      class="docpilot__icon-btn"
      :aria-label="T('actions.notHelpful')"
      :aria-pressed="String(turn.verdict === 'down')"
      @click="vote(turn, 'down')"
    >
      <Icon name="thumbDown" :filled="turn.verdict === 'down'" />
    </button>
    <!-- The thumb is a toggle, so pressing it again withdraws the vote
         rather than reopening the form. Without this control a reader
         who closed the form has no way back that does not also take
         back what they already said. -->
    <button
      v-if="turn.verdict === 'down' && !turn.reasonOpen"
      type="button"
      class="docpilot__text-btn"
      @click="turn.reasonOpen = true"
    >
      {{ T('actions.tellUsMore') }}
    </button>
  </div>
</template>

<script setup lang="ts">
/** A settled turn's own row — copy it, ask it again, and say whether it helped. */
import type { PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Icon from './Icon.vue'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const s = session.state
const { T, feedbackLive, withSources, threadFollow, closeAsk } = usePanel()
const vote = session.vote

async function copy(turn) {
  try {
    await navigator.clipboard.writeText(withSources(turn))
    turn.copied = true
    setTimeout(() => (turn.copied = false), 2000)
    session.say(T('announce.copied'))
  } catch {
    /* clipboard denied — the answer is still selectable */
  }
}

/**
 * Which turns can be asked again.
 *
 * Not the credential or social ones. Both settle from a template with no model
 * call — `detectSocial` and `redactSecrets` decide them before retrieval — so a
 * second run returns the identical words, and a control that visibly does
 * nothing is worse than an absent one. The credential turn already carries the
 * button that IS its retry: "ask without the secret".
 *
 * Everything else qualifies, refusals first. `no-evidence` is a verdict about
 * one retrieval, and retrieval moves with the index, the scope and whether the
 * embedder was reachable at the time.
 */
const canRetry = (turn) =>
  (turn.state === 'complete' || turn.state === 'no-answer' || turn.state === 'aborted') &&
  turn.refusal?.cause !== 'credential' &&
  turn.refusal?.cause !== 'social'

function retryTurn(turn) {
  if (s.busy) return
  threadFollow.repin()
  closeAsk()
  session.retryTurn(turn)
}
</script>
