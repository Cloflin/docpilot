<template>
  <div id="dp-prompt" class="docpilot__prompt" tabindex="0"
       role="region" :aria-label="T('promptDoc.region')">
    <template v-for="block in promptBlocks" :key="block.heading">
      <p class="docpilot__prompt-h">{{ block.heading }}</p>
      <textarea
        v-if="block.yours && editing"
        v-model="draft"
        class="docpilot__prompt-edit"
        rows="3"
        :maxlength="s.config.prompt.appendMaxChars"
      />
      <p v-else :class="block.yours ? 'docpilot__prompt-yours' : null">{{ block.body }}</p>
    </template>
    <p v-if="s.config.prompt.allowAppend" class="docpilot__row">
      <template v-if="editing">
        <button type="button" class="docpilot__text-btn" @click="saveEdit">{{ T('promptDoc.save') }}</button>
        <button type="button" class="docpilot__text-btn" @click="editing = false">{{ T('promptDoc.cancel') }}</button>
      </template>
      <template v-else>
        <button type="button" class="docpilot__text-btn" :aria-disabled="String(s.busy)" @click="startEdit">
          {{ T(s.instruction ? 'promptDoc.edit' : 'promptDoc.add') }}
        </button>
        <button
          v-if="s.instruction"
          type="button"
          class="docpilot__text-btn"
          :aria-disabled="String(s.busy)"
          @click="removeInstruction"
        >
          {{ T('promptDoc.remove') }}
        </button>
      </template>
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * The prompt document — what the model is told, published to the reader, and
 * the one paragraph of it the reader may write. The editor's state is the
 * panel's (`editing`, `draft`): closing the dock is what discards a draft.
 */
import { computed, nextTick } from 'vue'
import * as session from '../../docpilot/session.js'
import { promptDocument } from '../../docpilot/prompt.js'
import { siteFor } from '../../docpilot/tools.js'
import { usePanel } from './context.js'

const s = session.state
const { T, panel, editing, draft } = usePanel()

const promptBlocks = computed(() =>
  promptDocument({
    scope: s.scope,
    fallback: s.fallback,
    addendum: s.instruction,
    promptListLimit: s.config.scope.promptListLimit,
    prompt: s.config.prompt,
    product: s.config.product,
    // The DECLARED mode only. A runtime degradation also sends the block on its
    // own turns, but the disclosure describes the deployment, not the last
    // turn's weather — and a panel whose published instructions flickered with
    // an embedder's uptime would be less honest, not more.
    lexicalOnly: s.config.embed.lexicalOnly,
    // The site's tools — engine-spec 038 — as a turn in THIS browser would send
    // them. A server install's page holds no description to publish: the turn,
    // and what it sends, are the server's.
    site: s.config.runtime === 'server' ? null : siteFor(s.config.tools),
    // Headings only. The bodies are the exact text sent to the model, and a
    // translated body would make this disclosure a description of something
    // other than what was sent.
    labels: {
      headingInstructions: T('promptDoc.headingInstructions'),
      headingToolsNative: T('promptDoc.headingToolsNative'),
      headingToolsText: T('promptDoc.headingToolsText'),
      headingScope: T('promptDoc.headingScope'),
      headingYours: T('promptDoc.headingYours'),
      scopeAllPages: T('promptDoc.scopeAllPages'),
      yoursNone: T('promptDoc.yoursNone'),
    },
  }),
)

function startEdit() {
  draft.value = s.instruction
  editing.value = true
  nextTick(() => panel.value?.querySelector('.docpilot__prompt-edit')?.focus())
}
function saveEdit() {
  session.setInstruction(draft.value)
  editing.value = false
}
function removeInstruction() {
  session.setInstruction('')
  editing.value = false
}
</script>
