<script setup>
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

// 0 answer · 1 thumb down · 2 reasons · 3 reason picked · 4 comment · 5 sent
const { step, root } = useTimeline([1300, 600, 1200, 1000, 1700, 2600])
const reasons = ['Wrong answer', 'Incomplete', 'Not in the docs', 'Bad links']
</script>

<template>
  <div ref="root">
    <MockPanel :height="430" footnote="AI-generated. Check the linked pages. Not-helpful reports are sent to the docs team.">
      <div class="mp-q">Does the API support GraphQL?</div>
      <div class="mp-a">Yes — send queries to <code>/graphql</code><span class="mp-cite">1</span>.</div>
      <div class="mp-btns">
        <span class="mp-btn"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg></span>
        <span class="mp-btn"><svg viewBox="0 0 24 24"><path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8a2 2 0 0 1-2 1.7H7V10l4-8a3 3 0 0 1 4 3.9Z" /></svg></span>
        <span class="mp-btn" :class="{ on: step >= 1 && step < 5 }"><svg viewBox="0 0 24 24"><path d="M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17v12l-4 8a3 3 0 0 1-4-3.9Z" /></svg></span>
      </div>
      <Transition name="mp-pop">
        <div v-if="step >= 2 && step < 5" class="fb-card">
          <div class="fb-h">What went wrong?</div>
          <div class="fb-chips">
            <span v-for="(r, i) in reasons" :key="r" class="mp-chip" :class="{ on: step >= 3 && i === 2 }">{{ r }}</span>
          </div>
          <Transition name="mp-fade">
            <div v-if="step >= 4" class="fb-area">There is no /graphql endpoint in the reference.<span class="fb-n">48/500</span></div>
          </Transition>
          <div class="fb-hint">Sent to the docs team. Keys and tokens are removed automatically.</div>
        </div>
      </Transition>
      <Transition name="mp-fade">
        <div v-if="step === 5" class="mp-muted">Thanks — sent to the docs team.</div>
      </Transition>
    </MockPanel>
  </div>
</template>

<style scoped>
.fb-card {
  padding: 12px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-h {
  font-weight: 600;
  font-size: 13px;
}
.fb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mp-chip {
  transition: all 0.2s;
}
.mp-chip.on {
  border-color: var(--cf-accent);
  color: var(--cf-accent);
  background: color-mix(in oklab, var(--cf-accent) 8%, transparent);
}
.fb-area {
  position: relative;
  min-height: 52px;
  padding: 8px 10px;
  border: 1px solid var(--cf-border);
  border-radius: 10px;
  font-size: 12.5px;
}
.fb-n {
  position: absolute;
  right: 8px;
  bottom: 4px;
  font-size: 10px;
  color: var(--cf-muted-foreground);
}
.fb-hint {
  font-size: 11.5px;
  color: var(--cf-muted-foreground);
}
</style>
