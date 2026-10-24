<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'

// 0 question leaves · 1 at model A · 2 A answers 429 · 3 at model B · 4 B streams the answer
// 5 next question · 6 B is tried first and answers
const { step, root } = useTimeline([900, 900, 1300, 900, 1900, 1000, 2600])
const models = ['deepseek/deepseek-v4-flash', 'openai/gpt-4o-mini', 'google/gemini-2.5-flash']
const at = computed(() => ({ 1: 0, 2: 0, 3: 1, 4: 1, 6: 1 })[step.value] ?? -1)
const order = computed(() => (step.value >= 5 ? [1, 0, 2] : [0, 1, 2]))
const state = (i) => {
  if (i === 0 && step.value >= 2) return 'aside'
  if (i === 1 && (step.value === 4 || step.value === 6)) return 'ok'
  if (at.value === i) return 'busy'
  return ''
}
</script>

<template>
  <div ref="root" class="fd">
    <div class="fd-q">
      <span class="fd-dot" />
      {{ step >= 5 ? 'Next question' : 'Question' }}
    </div>
    <div class="fd-chain">
      <TransitionGroup name="fd-move">
        <div v-for="i in order" :key="models[i]" class="fd-model" :class="state(i)">
          <span class="fd-name">{{ models[i] }}</span>
          <span class="fd-status">
            <template v-if="state(i) === 'aside'">429 · set aside for a minute</template>
            <template v-else-if="state(i) === 'ok'">answering ✓</template>
            <template v-else-if="state(i) === 'busy'">sending…</template>
            <template v-else>waiting</template>
          </span>
        </div>
      </TransitionGroup>
    </div>
    <div class="fd-note">
      Rotates on a 429, a retired id, a moderation refusal, a 5xx or an empty reply. Never on Stop, a 401, or once an answer is painting.
    </div>
  </div>
</template>

<style scoped>
.fd {
  width: min(460px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
  text-align: left;
}
.fd-q {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--cf-foreground);
  color: var(--cf-background);
  font-weight: 500;
}
.fd-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--cf-accent);
  animation: fd-p 1s ease-in-out infinite;
}
@keyframes fd-p {
  50% {
    opacity: 0.3;
  }
}
.fd-chain {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fd-model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--cf-border);
  border-radius: 12px;
  background: var(--cf-background);
  transition: border-color 0.3s, background-color 0.3s, opacity 0.3s;
}
.fd-name {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.fd-status {
  font-size: 12px;
  color: var(--cf-muted-foreground);
  white-space: nowrap;
}
.fd-model.busy {
  border-color: var(--cf-accent);
}
.fd-model.ok {
  border-color: var(--cf-callout-tip);
  background: color-mix(in oklab, var(--cf-callout-tip) 8%, var(--cf-background));
}
.fd-model.ok .fd-status {
  color: var(--cf-callout-tip);
}
.fd-model.aside {
  opacity: 0.55;
}
.fd-model.aside .fd-status {
  color: var(--cf-callout-danger);
}
.fd-note {
  font-size: 12px;
  color: var(--cf-muted-foreground);
}
.fd-move-move {
  transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1);
}
</style>
