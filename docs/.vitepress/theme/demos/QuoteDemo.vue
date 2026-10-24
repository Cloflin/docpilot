<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

// 0 page · 1 selecting · 2 popover · 3 pressed · 4 chip in composer · 5 typing · 6 answer
const { step, root } = useTimeline([900, 1200, 1100, 500, 1100, 1600, 3200])
const selected = computed(() => step.value >= 1 && step.value <= 3)
const quote = 'Rate limits reset on a rolling 60-second window.'
</script>

<template>
  <div ref="root" class="qd">
    <div class="qd-page">
      <div class="qd-crumb">Guide › Rate limits</div>
      <div class="qd-h">Rate limits</div>
      <div class="qd-p">
        Each key may send 600 requests a minute.
        <span class="qd-sel" :class="{ on: selected }">{{ quote }}</span>
        A 429 response carries a <code>Retry-After</code> header.
        <Transition name="mp-pop">
          <span v-if="step === 2 || step === 3" class="qd-pop" :class="{ press: step === 3 }">
            <svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.8L20 10l-5 3.9L16.5 20 12 16.6 7.5 20 9 13.9 4 10l6.1-1.2Z" /></svg>
            Ask AI
          </span>
        </Transition>
      </div>
      <div class="qd-line" /><div class="qd-line short" />
    </div>
    <MockPanel
      :height="380"
      :text="step === 5 ? 'Does a 429 reset the window?' : ''"
      :caret="step === 4 || step === 5"
    >
      <Transition name="mp-fade">
        <div v-if="step === 6" class="qd-thread">
          <div class="mp-q"><span class="qd-q">“{{ quote }}”</span>Does a 429 reset the window?</div>
          <div class="mp-a">No. The window keeps rolling; wait for the seconds in <code>Retry-After</code><span class="mp-cite">1</span>.</div>
        </div>
      </Transition>
      <template #composer-top>
        <Transition name="mp-pop">
          <div v-if="step === 4 || step === 5" class="qd-chip">“{{ quote }}”<span class="qd-x">×</span></div>
        </Transition>
      </template>
    </MockPanel>
  </div>
</template>

<style scoped>
.qd {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
  align-items: center;
  justify-items: center;
}
@media (min-width: 900px) {
  .qd {
    grid-template-columns: 1fr 1fr;
  }
}
.qd-page {
  position: relative;
  width: min(340px, 100%);
  padding: 18px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-background);
  font-size: 13.5px;
  line-height: 1.65;
  text-align: left;
}
.qd-crumb {
  font-size: 11px;
  color: var(--cf-muted-foreground);
}
.qd-h {
  font-family: var(--font-serif, serif);
  font-size: 24px;
  margin: 2px 0 8px;
}
.qd-p {
  position: relative;
}
.qd-p code {
  font-size: 12px;
}
.qd-sel {
  background-image: linear-gradient(color-mix(in oklab, var(--cf-accent) 28%, transparent), color-mix(in oklab, var(--cf-accent) 28%, transparent));
  background-repeat: no-repeat;
  background-size: 0% 100%;
  transition: background-size 1s ease;
}
.qd-sel.on {
  background-size: 100% 100%;
}
.qd-pop {
  position: absolute;
  left: 30%;
  top: -14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  background: var(--cf-popover);
  box-shadow: 0 6px 18px -6px rgb(0 0 0 / 0.25);
  font-size: 12.5px;
  font-weight: 500;
  transition: transform 0.15s;
}
.qd-pop svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--cf-accent);
  stroke-width: 2;
}
.qd-pop.press {
  transform: scale(0.94);
}
.qd-line {
  height: 8px;
  margin-top: 10px;
  border-radius: 4px;
  background: var(--cf-surface);
}
.qd-line.short {
  width: 60%;
}
.qd-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 12px;
  border-radius: 12px;
  background: var(--cf-surface);
  font-size: 13px;
  color: var(--cf-muted-foreground);
  white-space: nowrap;
  overflow: hidden;
}
.qd-x {
  margin-left: auto;
}
.qd-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.qd-q {
  display: block;
  font-size: 12px;
  color: var(--cf-muted-foreground);
  margin-bottom: 2px;
}
</style>
