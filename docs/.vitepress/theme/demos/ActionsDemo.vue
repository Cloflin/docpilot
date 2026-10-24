<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

// 0 answer · 1 copy pressed · 2 copied · 3 ask again pressed · 4 regenerating
// 5 new answer · 6 edit pressed · 7 editing · 8 re-answered
const { step, root } = useTimeline([1200, 400, 1300, 400, 1200, 1500, 400, 1800, 3000])
const question = computed(() => (step.value >= 8 ? 'How do I rotate a key in CI?' : 'How do I rotate a key?'))
const answer = computed(() => {
  if (step.value >= 8) return 'Store both keys as CI secrets, deploy with the new one, then revoke the old key from the dashboard.'
  if (step.value >= 5) return 'Create a second key, deploy it, and revoke the first one. Both keys work during the overlap.'
  return 'Create a new key, switch your app to it, then revoke the old key.'
})
const label = computed(() => ({ 1: 'Copy answer', 2: 'Copy answer', 3: 'Ask again', 4: 'Ask again', 6: 'Edit question', 7: 'Edit question' })[step.value] ?? '')
</script>

<template>
  <div ref="root">
    <MockPanel :height="400">
      <div v-if="step !== 7" class="mp-q ad-q" :class="{ hot: step === 6 }">
        {{ question }}
        <span class="ad-edit"><svg viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></span>
      </div>
      <div v-else class="ad-editing">
        <div class="ad-area">How do I rotate a key in CI?<i class="ad-caret" /></div>
        <div class="ad-edit-btns"><span>Cancel</span><span class="send">Send</span></div>
      </div>
      <div class="mp-a ad-a" :class="{ dim: step === 4 || step === 7 }">
        <span v-if="step === 4" class="ad-shimmer">Writing the answer</span>
        <template v-else>{{ answer }}<span class="mp-cite">1</span></template>
      </div>
      <div class="mp-btns">
        <span class="mp-btn" :class="{ on: step === 1 || step === 2 }">
          <svg v-if="step !== 2" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
        <span class="mp-btn" :class="{ on: step === 3 }"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg></span>
        <span class="mp-btn"><svg viewBox="0 0 24 24"><path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8a2 2 0 0 1-2 1.7H7V10l4-8a3 3 0 0 1 4 3.9Z" /></svg></span>
        <span class="mp-btn"><svg viewBox="0 0 24 24"><path d="M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17v12l-4 8a3 3 0 0 1-4-3.9Z" /></svg></span>
        <Transition name="mp-fade"><span v-if="label" class="ad-tip">{{ step === 2 ? 'Copied' : label }}</span></Transition>
      </div>
    </MockPanel>
  </div>
</template>

<style scoped>
.ad-q {
  position: relative;
  transition: box-shadow 0.2s;
}
.ad-q.hot {
  box-shadow: 0 0 0 2px var(--cf-accent);
}
.ad-edit {
  position: absolute;
  left: -30px;
  top: 50%;
  translate: 0 -50%;
  color: var(--cf-muted-foreground);
  opacity: 0;
  transition: opacity 0.2s;
}
.ad-q.hot .ad-edit {
  opacity: 1;
}
.ad-editing {
  align-self: stretch;
  border: 1px solid var(--cf-accent);
  border-radius: 16px;
  padding: 10px 12px;
}
.ad-area {
  min-height: 40px;
}
.ad-caret {
  display: inline-block;
  width: 1.5px;
  height: 1em;
  vertical-align: -2px;
  background: var(--cf-accent);
}
.ad-edit-btns {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  font-size: 12px;
}
.ad-edit-btns span {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
}
.ad-edit-btns .send {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.ad-a {
  transition: opacity 0.3s;
}
.ad-a.dim {
  opacity: 0.35;
}
.ad-shimmer {
  background: linear-gradient(90deg, var(--cf-muted-foreground) 30%, var(--cf-foreground) 50%, var(--cf-muted-foreground) 70%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: ad-sh 1.2s linear infinite;
}
@keyframes ad-sh {
  to {
    background-position: -200% 0;
  }
}
.mp-btns {
  position: relative;
  align-items: center;
}
.ad-tip {
  margin-left: 6px;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--cf-foreground);
  color: var(--cf-background);
}
</style>
