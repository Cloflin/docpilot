<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

const { step, root } = useTimeline([1100, 900, 1500, 1100, 1800, 3200])
const scoped = computed(() => step.value >= 3)
const pages = ['Getting started', 'Authentication', 'Webhooks', 'Rate limits']
</script>

<template>
  <div ref="root">
    <MockPanel
      :scope="scoped ? 'This page' : 'All docs'"
      :scope-active="step === 1 || step === 2 || scoped"
      :text="step >= 4 && step < 5 ? 'How do retries work?' : ''"
      :caret="step === 4"
      :footnote="scoped ? 'Type a question to send. Searching this page.' : 'AI-generated. Check the linked pages.'"
    >
      <Transition name="mp-fade">
        <div v-if="step < 5" key="empty" class="sd-empty">
          <div class="sd-h">How can I help you today?</div>
          <div class="mp-muted">I search through your documentation to help you find setup guides, feature details and troubleshooting tips, fast.</div>
        </div>
      </Transition>
      <Transition name="mp-fade">
        <div v-if="step === 5" class="sd-thread">
          <div class="mp-q">How do retries work?</div>
          <div class="mp-a">
            Failed deliveries are retried with exponential backoff, up to <b>8 attempts</b> over 24 hours<span class="mp-cite">1</span>.
          </div>
          <div class="mp-row"><span class="mp-cite">1</span> Webhooks › Retries</div>
        </div>
      </Transition>
      <template #above-composer>
        <Transition name="mp-pop">
          <div v-if="step === 2 || step === 3" class="sd-picker">
            <div class="sd-presets">
              <span class="mp-chip" :class="{ on: step === 2 }">All docs</span>
              <span class="mp-chip" :class="{ on: step === 3 }">This page</span>
              <span class="mp-chip">This section</span>
            </div>
            <div class="sd-label">Pages to search</div>
            <div v-for="p in pages" :key="p" class="sd-page">
              <span class="sd-box" />{{ p }}
            </div>
          </div>
        </Transition>
      </template>
    </MockPanel>
  </div>
</template>

<style scoped>
.sd-empty {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sd-h {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.sd-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sd-picker {
  margin: 0 12px;
  padding: 12px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-popover);
  box-shadow: 0 8px 24px -10px rgb(0 0 0 / 0.2);
  font-size: 13px;
}
.sd-presets {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.mp-chip.on {
  border-color: var(--cf-accent);
  color: var(--cf-accent);
  background: color-mix(in oklab, var(--cf-accent) 8%, transparent);
}
.sd-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cf-muted-foreground);
  margin-bottom: 4px;
}
.sd-page {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.sd-box {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1.5px solid var(--cf-border);
  transition: background-color 0.2s, border-color 0.2s;
}
.sd-box.on {
  background: var(--cf-accent);
  border-color: var(--cf-accent);
}
</style>
