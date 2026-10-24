<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

// 0 thread · 1 clock pressed · 2 list open · 3 bin hovered · 4 row gone · 5 restored thread
const { step, root } = useTimeline([1400, 500, 1600, 1100, 1400, 3000])
const rows = computed(() => {
  const all = [
    { t: 'How do I rotate a key?', d: 'Just now' },
    { t: 'Webhook retries and backoff', d: '3 hours ago' },
    { t: 'Deploying behind nginx', d: 'Yesterday' },
    { t: 'Translate the panel to German', d: '4 days ago' },
  ]
  return step.value >= 4 ? all.filter((_, i) => i !== 2) : all
})
const stored = computed(() => rows.value.length)
</script>

<template>
  <div ref="root" class="hd">
    <MockPanel :height="400" :history-active="step === 1 || step === 2 || step === 3 || step === 4">
      <template #under-head>
        <Transition name="mp-pop">
          <div v-if="step >= 2 && step <= 4" class="hd-list">
            <TransitionGroup name="mp-fade">
              <div v-for="(r, i) in rows" :key="r.t" class="hd-row" :class="{ hot: step === 3 && i === 2 }">
                <span class="hd-t">{{ r.t }}</span>
                <span class="hd-d">{{ r.d }}</span>
                <span class="hd-bin"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg></span>
              </div>
            </TransitionGroup>
            <div class="hd-all">Delete all</div>
          </div>
        </Transition>
      </template>
      <Transition name="mp-fade" mode="out-in">
        <div v-if="step < 5" key="a" class="hd-thread">
          <div class="mp-q">How do I rotate a key?</div>
          <div class="mp-a">Create a second key, deploy it, then revoke the first<span class="mp-cite">1</span>.</div>
        </div>
        <div v-else key="b" class="hd-thread">
          <div class="mp-q">Webhook retries and backoff</div>
          <div class="mp-a">Failed deliveries are retried with exponential backoff, up to 8 attempts<span class="mp-cite">1</span>.</div>
        </div>
      </Transition>
    </MockPanel>
    <div class="hd-store">
      <div class="hd-store-h">localStorage</div>
      <div class="hd-key">docpilot:history</div>
      <div class="hd-json">
        [<span v-for="r in rows" :key="r.t" class="hd-entry">{ "title": "{{ r.t }}", … },</span>]
      </div>
      <div class="hd-meta">{{ stored }} of 20 conversations · on this device only</div>
    </div>
  </div>
</template>

<style scoped>
.hd {
  width: 100%;
  display: grid;
  gap: 20px;
  justify-items: center;
  align-items: center;
}
@media (min-width: 900px) {
  .hd {
    grid-template-columns: 1.1fr 1fr;
  }
}
.hd-list {
  max-height: 210px;
  overflow: hidden;
  padding: 8px;
  border-bottom: 1px solid var(--cf-border);
  background: var(--cf-background);
}
.hd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 10px;
  font-size: 13px;
  transition: background-color 0.2s;
}
.hd-row.hot {
  background: var(--cf-surface);
}
.hd-t {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.hd-d {
  font-size: 11.5px;
  color: var(--cf-muted-foreground);
}
.hd-bin {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--cf-muted-foreground);
  opacity: 0;
}
.hd-row.hot .hd-bin {
  opacity: 1;
  background: var(--cf-accent-bg);
  color: var(--cf-foreground);
}
.hd-all {
  padding: 6px 10px 2px;
  font-size: 12px;
  color: var(--cf-muted-foreground);
}
.hd-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hd-store {
  width: min(320px, 100%);
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--cf-border);
  background: var(--cf-background);
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  text-align: left;
}
.hd-store-h {
  font-family: var(--font-sans, sans-serif);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cf-muted-foreground);
}
.hd-key {
  color: var(--cf-accent);
  margin: 2px 0 6px;
}
.hd-entry {
  display: block;
  padding-left: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hd-meta {
  margin-top: 8px;
  font-family: var(--font-sans, sans-serif);
  color: var(--cf-muted-foreground);
}
</style>
