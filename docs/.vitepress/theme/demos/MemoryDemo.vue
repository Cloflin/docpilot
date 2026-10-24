<script setup>
import { useTimeline } from './timeline.js'

// 0 three turns · 1 new question · 2 older answer folds to its summary · 3 last answer stays whole · 4 request built
const { step, root } = useTimeline([1400, 1300, 1700, 1500, 3200])
const turns = [
  {
    q: 'How do webhooks retry?',
    a: 'Failed deliveries are retried with exponential backoff: 1 min, 5 min, 30 min, then hourly, up to 8 attempts over 24 hours. Each attempt carries the same event id, so a handler must be idempotent…',
    s: 'Retries use exponential backoff, 8 attempts over 24 h, same event id.',
  },
  {
    q: 'Can I replay one by hand?',
    a: 'Yes. Open Webhooks → Deliveries, pick the event and press Replay. A replay is a new attempt with the original payload and the same event id, and it does not reset the retry schedule.',
  },
]
</script>

<template>
  <div ref="root" class="md">
    <div class="md-col">
      <div class="md-label">What the reader sees</div>
      <div class="md-card">
        <template v-for="t in turns" :key="t.q">
          <div class="mp-q">{{ t.q }}</div>
          <div class="mp-a md-a">{{ t.a }}</div>
        </template>
        <Transition name="mp-fade">
          <div v-if="step >= 1" class="mp-q">And for a signature mismatch?</div>
        </Transition>
      </div>
    </div>
    <div class="md-arrow" :class="{ on: step >= 1 }">→</div>
    <div class="md-col">
      <div class="md-label">What the model is sent</div>
      <div class="md-card md-wire">
        <div class="md-msg"><span class="md-role">user</span>{{ turns[0].q }}</div>
        <div class="md-msg" :class="{ fold: step >= 2 }">
          <span class="md-role">assistant</span>
          <span class="md-full">{{ turns[0].a }}</span>
          <span class="md-sum"><span class="md-tag">summary</span>{{ turns[0].s }}</span>
        </div>
        <div class="md-msg"><span class="md-role">user</span>{{ turns[1].q }}</div>
        <div class="md-msg" :class="{ whole: step >= 3 }">
          <span class="md-role">assistant</span>{{ turns[1].a }}
          <span v-if="step >= 3" class="md-tag keep">whole · ≤ 2000 chars</span>
        </div>
        <Transition name="mp-fade">
          <div v-if="step >= 4" class="md-msg now"><span class="md-role">user</span>And for a signature mismatch? <span class="md-tag">+ 8 retrieved passages</span></div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.md {
  width: 100%;
  display: grid;
  gap: 14px;
  align-items: center;
  font-size: 13px;
  text-align: left;
}
@media (min-width: 900px) {
  .md {
    grid-template-columns: 1fr auto 1fr;
  }
}
.md-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cf-muted-foreground);
  margin-bottom: 6px;
}
.md-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-background);
}
.md-a {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.md-arrow {
  justify-self: center;
  font-size: 22px;
  color: var(--cf-muted-foreground);
  transition: color 0.3s, transform 0.3s;
}
.md-arrow.on {
  color: var(--cf-accent);
  transform: translateX(3px);
}
.md-wire {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.55;
}
.md-msg {
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--cf-surface);
  transition: background-color 0.3s, box-shadow 0.3s;
}
.md-role {
  display: block;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cf-muted-foreground);
}
.md-full {
  display: grid;
  max-height: 80px;
  overflow: hidden;
  transition: max-height 0.6s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s;
}
.md-sum {
  display: block;
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height 0.6s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s 0.2s;
}
.fold .md-full {
  max-height: 0;
  opacity: 0;
}
.fold .md-sum {
  max-height: 60px;
  opacity: 1;
}
.fold,
.whole {
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--cf-accent) 45%, transparent);
}
.md-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 10px;
  background: color-mix(in oklab, var(--cf-accent) 14%, transparent);
  color: var(--cf-accent);
}
.md-tag.keep {
  margin: 4px 0 0;
}
.now {
  box-shadow: inset 0 0 0 1px var(--cf-accent);
}
</style>
