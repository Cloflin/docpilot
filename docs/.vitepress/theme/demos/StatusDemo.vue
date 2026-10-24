<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

const phases = ['Loading the docs index', 'Searching the docs', 'Reading guide/webhooks', 'Thinking', 'Writing the answer']
const { step, root } = useTimeline([1000, 1000, 1200, 1700, 1100, 3200])
const phase = computed(() => phases[step.value] ?? '')
const thought = computed(() => step.value >= 4)
</script>

<template>
  <div ref="root">
    <MockPanel :height="380">
      <div class="mp-q">Why did my webhook stop firing?</div>
      <div class="st-reason" :class="{ open: step === 3 }">
        <span v-if="step >= 3" class="st-rh">
          <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
          {{ thought ? 'Thought for 4s' : 'Thinking for 2s' }}
        </span>
        <div class="st-rbody">
          <div class="st-rtext">The reader asks about deliveries stopping. The webhooks page says an endpoint is disabled after 8 failed attempts…</div>
        </div>
      </div>
      <Transition name="mp-fade" mode="out-in">
        <div v-if="step < 5" :key="phase" class="st-phase"><span class="st-sh">{{ phase }}</span></div>
        <div v-else class="mp-a">An endpoint is <b>disabled after 8 failed attempts</b> in a row<span class="mp-cite">1</span>. Fix the endpoint, then re-enable it under Webhooks → Endpoints<span class="mp-cite">2</span>.</div>
      </Transition>
    </MockPanel>
  </div>
</template>

<style scoped>
.st-phase {
  font-size: 13.5px;
}
.st-sh {
  background: linear-gradient(90deg, var(--cf-muted-foreground) 30%, var(--cf-foreground) 50%, var(--cf-muted-foreground) 70%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: st-sh 1.3s linear infinite;
}
@keyframes st-sh {
  to {
    background-position: -200% 0;
  }
}
.st-rh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--cf-muted-foreground);
}
.st-rh svg {
  transition: transform 0.3s;
}
.open .st-rh svg {
  transform: rotate(90deg);
}
.st-rbody {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.open .st-rbody {
  grid-template-rows: 1fr;
}
.st-rtext {
  overflow: hidden;
  font-size: 12.5px;
  color: var(--cf-muted-foreground);
  border-left: 2px solid var(--cf-border);
  padding-left: 10px;
  margin-top: 4px;
}
</style>
