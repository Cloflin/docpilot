<template>
  <!-- The passage this question was about — ui-specs/007. Above the
       bubble and quieter than it: the reference is not the ask. -->
  <p v-if="turn.quote" class="docpilot__quote">
    <Icon name="quote" /><span class="docpilot__quote-text"
      ><span class="docpilot__sr">{{ T('quote.label') }} </span>{{ turn.quote }}</span
    >
  </p>
  <!-- The bubble, or the field it stands for. The rest of the turn —
       the answer, its sources, its actions — stays on screen while
       the editor is open: nothing has been withdrawn until it is
       sent. -->
  <template v-if="editingId === turn.id">
    <div class="docpilot__edit">
      <label class="docpilot__sr" :for="`dp-edit-field-${turn.id}`">
        {{ T('actions.editLabel') }}
      </label>
      <textarea
        :id="`dp-edit-field-${turn.id}`"
        v-model="editDraft"
        class="docpilot__edit-field"
        rows="1"
        maxlength="1000"
        @input="grow"
        @keydown="onEditKeydown"
      ></textarea>
    </div>
    <div class="docpilot__edit-acts">
      <button type="button" class="docpilot__text-btn" @click="cancelTurnEdit">
        {{ T('actions.editCancel') }}
      </button>
      <button
        type="button"
        class="docpilot__text-btn"
        :aria-disabled="String(!canSaveEdit)"
        @click="saveTurnEdit(turn)"
      >
        {{ T('actions.editSave') }}
      </button>
    </div>
  </template>
  <template v-else>
    <p class="docpilot__question">{{ turn.question }}</p>
    <!-- The same hover-revealed row as the answer's below, at the
         edge the bubble sits on. Copy works while a turn is running;
         editing does not, because `submit` refuses on `busy` and the
         thread would be truncated for nothing. -->
    <div class="docpilot__actions docpilot__actions--ask">
      <button
        type="button"
        class="docpilot__icon-btn"
        :aria-label="T('actions.copyQuestion')"
        @click="copyQuestion(turn)"
      >
        <Icon :name="turn.questionCopied ? 'check' : 'copy'" />
      </button>
      <button
        :id="`dp-edit-${turn.id}`"
        type="button"
        class="docpilot__icon-btn"
        :aria-label="T('actions.edit')"
        :aria-disabled="String(s.busy)"
        @click="startTurnEdit(turn)"
      >
        <Icon name="pencil" />
      </button>
    </div>
  </template>
</template>

<script setup lang="ts">
/**
 * The question a turn answers — its quoted passage, the bubble, and the editor
 * that stands in for the bubble while it is being rewritten. Which turn has the
 * editor open is the panel's (`editingId`): at most one, and the Esc cascade
 * and the composer's ↑ both reach it.
 */
import { computed, nextTick, type PropType } from 'vue'
import * as session from '../../docpilot/session.js'
import type { Turn } from '../../docpilot/session.js'
import { usePanel } from './context.js'
import Icon from './Icon.vue'

defineProps({ turn: { type: Object as PropType<Turn>, required: true } })

const s = session.state
const { T, thread, threadFollow, closeAsk, grow, editingId, editDraft, startTurnEdit, cancelTurnEdit } =
  usePanel()

const canSaveEdit = computed(() => editDraft.value.trim().length > 0)

// Its own flag, not `turn.copied`: there are two copy buttons in a turn now,
// and one flag would light the tick on both. Neither field is in `makeTurn` and
// neither reaches the archive — `slimTurn` builds a whitelist.
async function copyQuestion(turn) {
  try {
    await navigator.clipboard.writeText(turn.question)
    turn.questionCopied = true
    setTimeout(() => (turn.questionCopied = false), 2000)
    session.say(T('announce.questionCopied'))
  } catch {
    /* clipboard denied — the question is still selectable */
  }
}

function saveTurnEdit(turn) {
  if (!canSaveEdit.value) return
  const next = editDraft.value.trim()
  // Unchanged text is a cancel, not an ask: re-running it would destroy an
  // answer that is already on screen to get another one to the same question.
  if (next === turn.question) return cancelTurnEdit()
  threadFollow.repin()
  closeAsk()
  // Left open on a refusal — busy, degraded, or a conversation swapped out from
  // under the click — so a draft is never dropped into a thread it never reached.
  if (!session.editTurn(turn, next)) return
  editingId.value = null
  editDraft.value = ''
  // The turn this editor belonged to no longer exists, so focus would land on
  // <body>. The thread is where the replacement appears, and it is a named,
  // focusable region already.
  nextTick(() => thread.value?.focus({ preventScroll: true }))
}

// The composer's IME guard, and for the composer's reason — ui-specs/012. The
// Enter that commits a candidate re-ran a half-typed question here, and that
// re-run truncates the thread and spends a request from the shared allowance.
function onEditKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.nativeEvent?.isComposing) return
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  const turn = s.turns.find((t) => t.id === editingId.value)
  if (turn) saveTurnEdit(turn)
}
</script>
