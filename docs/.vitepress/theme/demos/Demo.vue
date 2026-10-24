<script setup>
import { ref, useSlots } from 'vue'

/**
 * The preview box every feature page opens with: a dotted stage holding an
 * animated mock-up, and a second tab with the config that turns it on.
 *
 *   <Demo>
 *     <ScopeDemo />
 *     <template #code>
 *
 *   ```ts
 *   scope: { enabled: true }
 *   ```
 *
 *     </template>
 *   </Demo>
 *
 * The blank lines around the fence are what let VitePress render the markdown
 * inside the slot. "Replay" re-mounts the mock-up, which restarts its timeline.
 */
defineProps({ caption: { type: String, default: '' } })
const slots = useSlots()
const tab = ref('preview')
const run = ref(0)
</script>

<template>
  <div class="dm">
    <div class="dm-bar">
      <div class="dm-tabs" role="tablist">
        <button role="tab" :aria-selected="tab === 'preview'" :class="{ on: tab === 'preview' }" @click="tab = 'preview'">Preview</button>
        <button v-if="slots.code" role="tab" :aria-selected="tab === 'code'" :class="{ on: tab === 'code' }" @click="tab = 'code'">Config</button>
      </div>
      <button v-if="tab === 'preview'" class="dm-replay" title="Replay" aria-label="Replay the demo" @click="run++">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
      </button>
    </div>
    <div v-show="tab === 'preview'" class="dm-stage">
      <div :key="run" class="dm-inner"><slot /></div>
    </div>
    <div v-if="slots.code" v-show="tab === 'code'" class="dm-code"><slot name="code" /></div>
    <div v-if="caption" class="dm-caption">{{ caption }}</div>
  </div>
</template>

<style scoped>
.dm {
  margin: 1.5rem 0 2rem;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  overflow: hidden;
  background: var(--cf-background);
}
.dm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--cf-border);
}
.dm-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--cf-surface);
}
.dm-tabs button,
.dm-replay {
  font: 500 13px/1 var(--font-sans, inherit);
  color: var(--cf-muted-foreground);
  padding: 7px 12px;
  border-radius: 7px;
  transition: color 0.15s, background-color 0.15s;
}
.dm-tabs button.on {
  color: var(--cf-foreground);
  background: var(--cf-background);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}
.dm-replay {
  display: inline-flex;
  padding: 7px;
}
.dm-replay:hover,
.dm-tabs button:hover {
  color: var(--cf-foreground);
}
.dm-stage {
  position: relative;
  min-height: 360px;
  display: grid;
  place-items: center;
  padding: 28px 16px;
  background-color: var(--cf-surface);
  background-image: radial-gradient(color-mix(in oklab, var(--cf-muted-foreground) 28%, transparent) 1px, transparent 1px);
  background-size: 16px 16px;
}
.dm-inner {
  width: 100%;
  display: grid;
  place-items: center;
}
.dm-code :deep(div[class*='language-']) {
  margin: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
}
.dm-caption {
  padding: 10px 14px;
  font-size: 13px;
  color: var(--cf-muted-foreground);
  border-top: 1px solid var(--cf-border);
}
</style>
