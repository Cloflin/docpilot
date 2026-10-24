<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

const typed = 'Why does sk-proj-8fK2xQ9mWv3 return 401?'
const masked = 'Why does YOUR_SECRET_KEY return 401?'
// typing frames · send · warning · ask without the key
const frames = Array.from({ length: 14 }, () => 110)
const { step, root } = useTimeline([600, ...frames, 600, 2600, 2600])
const n = frames.length
const text = computed(() => {
  if (step.value === 0) return ''
  if (step.value <= n) return typed.slice(0, Math.ceil((typed.length * step.value) / n))
  return ''
})
const warned = computed(() => step.value >= n + 2)
const resent = computed(() => step.value >= n + 3)
</script>

<template>
  <div ref="root">
    <MockPanel :height="380" :text="text" :caret="step > 0 && step <= n + 1">
      <Transition name="mp-fade">
        <div v-if="warned" class="cr-thread">
          <div class="mp-q">{{ masked }}</div>
          <div v-if="!resent" class="cr-warn">
            <div><b>Don't paste keys or tokens here.</b> This one was not sent anywhere — the question stopped in the browser and the value is not kept in the thread.</div>
            <span class="mp-chip">Answer the question without the key</span>
          </div>
          <div v-else class="mp-a">A 401 means the key is missing or revoked. Check the <code>Authorization</code> header<span class="mp-cite">1</span>.</div>
        </div>
      </Transition>
    </MockPanel>
  </div>
</template>

<style scoped>
.cr-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cr-warn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 13px;
  background: color-mix(in oklab, var(--cf-callout-warn) 12%, var(--cf-background));
  border: 1px solid color-mix(in oklab, var(--cf-callout-warn) 40%, transparent);
}
</style>
