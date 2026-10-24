<script setup>
import { computed, ref } from 'vue'
import { useTimeline } from './timeline.js'
import { useFigures } from '../intro/figures.js'

/*
 * One bar per question: the relevance score of its best passage against the
 * calibrated floor. The floor is this site's own, from the committed manifest.
 */
const fig = useFigures()
const TAU = fig.value.tau ?? 0.68
const questions = [
  { q: 'How do I rebuild the index in CI?', s: 0.84 },
  { q: 'What is the capital of Peru?', s: 0.31 },
  { q: 'Can the panel run on a landing page?', s: 0.73 },
  { q: 'Write me a poem about cats', s: 0.22 },
]
const mode = ref('calibrated')
const { step, root } = useTimeline(questions.map(() => 2600))
const cur = computed(() => questions[step.value])
const pass = computed(() => cur.value.s >= TAU)
const refused = computed(() => mode.value === 'calibrated' && !pass.value)
</script>

<template>
  <div ref="root" class="gd">
    <div class="gd-modes">
      <button v-for="m in ['off', 'calibrated']" :key="m" class="mp-chip" :class="{ on: mode === m }" @click="mode = m">guard.mode: '{{ m }}'</button>
    </div>
    <Transition name="mp-fade" mode="out-in">
      <div :key="step" class="gd-q">{{ cur.q }}</div>
    </Transition>
    <div class="gd-bar">
      <div class="gd-fill" :class="{ low: !pass }" :style="{ width: cur.s * 100 + '%' }" />
      <div class="gd-tau" :style="{ left: TAU * 100 + '%' }"><span>τ {{ TAU }}</span></div>
    </div>
    <div class="gd-score">best passage scores <b>{{ cur.s.toFixed(2) }}</b></div>
    <div class="gd-out">
      <div class="gd-cell" :class="{ on: !refused }">
        <div class="gd-k">Model call</div>
        <div class="gd-v">{{ refused ? 'none — 0 tokens' : 'yes' }}</div>
      </div>
      <div class="gd-cell" :class="{ on: true }">
        <div class="gd-k">Reader sees</div>
        <div class="gd-v">{{ refused ? '“I couldn’t find this in the docs.” + closest pages' : pass ? 'a cited answer' : 'the model declines, citing nothing' }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gd {
  width: min(480px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  text-align: left;
}
.gd-modes {
  display: flex;
  gap: 6px;
  justify-content: center;
}
.gd-modes .mp-chip {
  font-family: var(--font-mono, monospace);
  cursor: pointer;
}
.mp-chip.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.gd-q {
  align-self: flex-end;
  padding: 8px 14px;
  border-radius: 18px;
  background: var(--cf-accent-bg);
}
.gd-bar {
  position: relative;
  height: 12px;
  border-radius: 999px;
  background: var(--cf-border);
  margin-top: 18px;
}
.gd-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--cf-callout-tip);
  transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.3s;
}
.gd-fill.low {
  background: var(--cf-callout-danger);
}
.gd-tau {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 2px;
  background: var(--cf-foreground);
}
.gd-tau span {
  position: absolute;
  bottom: 100%;
  left: 50%;
  translate: -50% -2px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  white-space: nowrap;
}
.gd-score {
  color: var(--cf-muted-foreground);
}
.gd-out {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 8px;
}
.gd-cell {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--cf-border);
  background: var(--cf-background);
}
.gd-k {
  font-size: 11px;
  color: var(--cf-muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.gd-v {
  margin-top: 2px;
  font-weight: 500;
}
</style>
