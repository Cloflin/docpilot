<script setup>
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

// 0 answer · 1 sources · 2 first opens · 3 first closes, second opens · 4 hold
const { step, root } = useTimeline([900, 1200, 2600, 2600, 1400])
const sources = [
  {
    n: 1,
    title: 'Authentication › API keys',
    passage: 'Create a key under Settings → API. Send it as a Bearer token in the Authorization header; keys never expire until revoked.',
  },
  {
    n: 2,
    title: 'Authentication › Rotating keys',
    passage: 'Rotate a key by creating a second one, deploying it, then revoking the first. Both work during the overlap.',
  },
]
const open = (n) => (n === 1 && step.value === 2) || (n === 2 && step.value === 3)
</script>

<template>
  <div ref="root">
    <MockPanel :height="460">
      <div class="mp-q">How do I authenticate requests?</div>
      <Transition name="mp-fade">
        <div v-if="step >= 0" class="mp-a">
          Send an API key as a <b>Bearer token</b><span class="mp-cite">1</span>. To change keys without downtime, create the new one before revoking the old<span class="mp-cite">2</span>.
        </div>
      </Transition>
      <Transition name="mp-fade">
        <div v-if="step >= 1" class="sr-list">
          <div class="sr-head">Sources</div>
          <div v-for="s in sources" :key="s.n" class="sr-item" :class="{ open: open(s.n) }">
            <div class="sr-row">
              <span class="mp-cite">{{ s.n }}</span>
              <span class="sr-title">{{ s.title }}</span>
              <span class="sr-chev" :title="open(s.n) ? 'Hide the passage' : 'Show the passage'">
                <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
              </span>
            </div>
            <div class="sr-body">
              <div class="sr-passage">{{ s.passage }}</div>
            </div>
          </div>
        </div>
      </Transition>
    </MockPanel>
  </div>
</template>

<style scoped>
.sr-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sr-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--cf-muted-foreground);
}
.sr-item {
  border-radius: 12px;
  background: var(--cf-surface);
  overflow: hidden;
}
.sr-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 13px;
}
.sr-title {
  flex: 1;
  color: var(--cf-accent);
}
.sr-chev {
  display: inline-grid;
  place-items: center;
  color: var(--cf-muted-foreground);
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.open .sr-chev {
  transform: rotate(180deg);
}
.sr-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.open .sr-body {
  grid-template-rows: 1fr;
}
.sr-passage {
  overflow: hidden;
  margin: 0 10px;
  font-size: 12.5px;
  color: var(--cf-muted-foreground);
  border-left: 2px solid var(--cf-accent);
  padding-left: 10px;
}
.open .sr-passage {
  margin-bottom: 10px;
}
</style>
