<script setup>
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

// 0 question · 1 a site tool runs · 2 the answer cites it · 3 the action · 4 its form · 5 sent · 6 hold
const { step, root } = useTimeline([900, 1500, 1800, 1500, 2600, 1800, 1600])
</script>

<template>
  <div ref="root">
    <MockPanel :height="500">
      <div class="mp-q">How many requests does the Pro plan allow?</div>
      <Transition name="mp-fade" mode="out-in">
        <div v-if="step === 1" key="tool" class="tl-phase"><span class="tl-sh">Checking Plan limits</span></div>
        <div v-else-if="step >= 2" key="answer" class="mp-a">
          Pro allows <b>5,000 requests a day</b><span class="mp-cite">1</span>. Above that, a request returns 429 until midnight UTC<span class="mp-cite">2</span>.
        </div>
      </Transition>
      <Transition name="mp-fade">
        <div v-if="step >= 3" class="tl-actions">
          <span v-if="step < 5" class="mp-chip" :class="{ 'tl-on': step === 4 }">Write to support</span>
          <span v-else class="mp-muted">Ticket 42 opened.</span>
        </div>
      </Transition>
      <Transition name="mp-pop">
        <div v-if="step === 4" class="tl-form">
          <label class="mp-muted">Where support replies · required</label>
          <div class="tl-field">reader@example.com</div>
          <label class="mp-muted">The problem · required</label>
          <div class="tl-field tl-area">We need more than 5,000 requests a day on Pro.</div>
          <div class="tl-btns"><span class="mp-chip">Write to support</span><span class="mp-muted">Cancel</span></div>
        </div>
      </Transition>
      <Transition name="mp-fade">
        <div v-if="step >= 2" class="tl-sources">
          <div class="mp-row"><span class="mp-cite">1</span>Plan limits<span class="mp-muted"> · from the site</span></div>
          <div class="mp-row"><span class="mp-cite">2</span><span class="tl-link">Limits › Rate limits</span></div>
        </div>
      </Transition>
    </MockPanel>
  </div>
</template>

<style scoped>
.tl-phase {
  font-size: 13.5px;
}
.tl-sh {
  background: linear-gradient(90deg, var(--cf-muted-foreground) 30%, var(--cf-foreground) 50%, var(--cf-muted-foreground) 70%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: tl-sh 1.3s linear infinite;
}
@keyframes tl-sh {
  to {
    background-position: -200% 0;
  }
}
.tl-actions {
  display: flex;
  gap: 8px;
}
.tl-on {
  border-color: var(--cf-accent);
  color: var(--cf-accent);
}
.tl-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--cf-surface);
}
.tl-field {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--cf-border);
  background: var(--cf-background);
  font-size: 13px;
}
.tl-area {
  min-height: 44px;
}
.tl-btns {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.tl-sources {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tl-link {
  color: var(--cf-accent);
}
</style>
