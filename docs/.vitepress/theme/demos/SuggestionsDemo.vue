<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

const answer = 'Install the package, run init, build the index, and add the theme wrapper. The panel appears on the next dev start.'
const words = answer.split(' ')
// 0 empty · 1 row pressed · 2-17 the baked answer paints in 16 frames · 18 follow-ups
const frames = Array.from({ length: 16 }, () => 90)
const { step, root } = useTimeline([1600, 500, ...frames, 3000])
const shown = computed(() => {
  if (step.value < 2) return ''
  const f = Math.min(step.value - 1, 16)
  return words.slice(0, Math.ceil((words.length * f) / 16)).join(' ')
})
const rows = ['How do I get started?', 'How do I authenticate requests?', 'What does it cost?']
</script>

<template>
  <div ref="root">
    <MockPanel :height="400">
      <Transition name="mp-fade" mode="out-in">
        <div v-if="step < 2" key="e" class="sg-empty">
          <div class="sg-h">How can I help you today?</div>
          <div v-for="(r, i) in rows" :key="r" class="mp-row sg-row" :class="{ hot: step === 1 && i === 0 }">
            <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>{{ r }}
          </div>
        </div>
        <div v-else key="t" class="sg-thread">
          <div class="mp-q">{{ rows[0] }}</div>
          <div class="mp-a">{{ shown }}<span v-if="step >= 17" class="mp-cite">1</span></div>
          <Transition name="mp-fade">
            <div v-if="step >= 18" class="sg-fu">
              <div class="mp-muted">Follow-up questions</div>
              <div class="mp-row">Tell me about Building the index</div>
              <div class="mp-row">Tell me about Production</div>
            </div>
          </Transition>
        </div>
      </Transition>
    </MockPanel>
  </div>
</template>

<style scoped>
.sg-empty {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sg-h {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 4px;
}
.sg-row {
  transition: background-color 0.2s, transform 0.15s;
}
.sg-row.hot {
  background: var(--cf-accent-bg);
  transform: scale(0.98);
}
.sg-thread,
.sg-fu {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
