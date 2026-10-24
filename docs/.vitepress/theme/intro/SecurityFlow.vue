<script setup>
import { computed } from 'vue'
import { useTimeline } from '../demos/timeline.js'

/*
 * One answer's round trip, and where the key is at each moment. It exists in
 * exactly one box — the server you run — and only as an environment variable
 * that the proxy reads when it forwards the request.
 *
 * The checks are the five rules `npx docpilot doctor --proxy` prints and that
 * this site's own proxy (`lib/ai-proxy.js`) enforces.
 */
const steps = [
  { at: 0, title: 'The browser builds the request', body: 'The question — already scrubbed of anything that looks like a key — plus the passages retrieved from the static index. There is no key in the page to add.' },
  { at: 1, title: 'POST to your own origin', body: 'The panel calls /ai/v1/chat/completions on the site it is running on. Not the provider, not a DocPilot server.' },
  { at: 2, title: 'Your server checks it', body: 'Exact path, POST only, same origin, a body ceiling, a rate limit per IP. Any Authorization, x-api-key or Cookie the client sent is dropped.' },
  { at: 3, title: 'The key is attached here, and only here', body: 'The proxy adds Authorization: Bearer $OPENAI_API_KEY from its environment and forwards to the provider.' },
  { at: 4, title: 'The answer streams back', body: 'Unbuffered, with no credential and no CORS header on the way out. The browser receives text, never the key.' },
]
const checks = ['location = /ai/v1/…', 'POST only', 'same origin', 'body ceiling', 'rate limit / IP', 'strip client auth']
const { step, root, go, play, hold } = useTimeline(steps.map(() => 3200))
const cur = computed(() => steps[step.value])
</script>

<template>
  <div ref="root" class="sf">
    <div class="sf-lane">
      <div class="sf-node" :class="{ on: step === 0 || step === 4 }">
        <div class="sf-h">Reader’s browser</div>
        <div class="sf-items">
          <span>JS bundle</span><span>/rag/* index</span><span>prompt + passages</span>
        </div>
        <div class="sf-nokey">no key</div>
      </div>

      <div class="sf-wire">
        <span class="sf-packet" :class="['s' + step]">
          <span v-if="step === 4">answer ⟵</span>
          <span v-else>question</span>
        </span>
      </div>

      <div class="sf-node server" :class="{ on: step === 2 || step === 3 }">
        <div class="sf-h">Your server <small>nginx · Docker · Vercel</small></div>
        <div class="sf-checks">
          <span v-for="(c, i) in checks" :key="c" class="sf-check" :class="{ ok: step >= 2 }" :style="{ transitionDelay: i * 90 + 'ms' }">{{ c }}</span>
        </div>
        <div class="sf-key" :class="{ on: step === 3 }">
          <svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3M17 6l3 3M15 8l2 2" /></svg>
          OPENAI_API_KEY <small>env only</small>
        </div>
      </div>

      <div class="sf-wire">
        <span class="sf-packet right" :class="['s' + step]">
          <span v-if="step === 4">stream ⟵</span>
          <span v-else>+ key</span>
        </span>
      </div>

      <div class="sf-node" :class="{ on: step === 3 || step === 4 }">
        <div class="sf-h">Model provider</div>
        <div class="sf-items"><span>OpenAI · Anthropic · OpenRouter · …</span></div>
      </div>
    </div>

    <Transition name="mp-fade" mode="out-in">
      <div :key="step" class="sf-cap">
        <b>{{ step + 1 }}. {{ cur.title }}</b>
        <span>{{ cur.body }}</span>
      </div>
    </Transition>
    <div class="sf-steps">
      <button v-for="(s, i) in steps" :key="i" :class="{ on: i === step }" :aria-label="s.title" @click="go(i)">{{ i + 1 }}</button>
      <button class="sf-play" @click="play">{{ hold ? '▶ play' : '❚❚' }}</button>
    </div>
  </div>
</template>

<style scoped>
.sf {
  margin: 1.5rem 0 2rem;
  padding: 20px;
  border: 1px solid var(--cf-border);
  border-radius: 16px;
  background-color: var(--cf-surface);
  background-image: radial-gradient(color-mix(in oklab, var(--cf-muted-foreground) 25%, transparent) 1px, transparent 1px);
  background-size: 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sf-lane {
  display: grid;
  grid-template-columns: 1fr 70px 1.3fr 70px 1fr;
  align-items: stretch;
}
@media (max-width: 760px) {
  .sf-lane {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .sf-wire {
    height: 34px;
  }
}
.sf-node {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-background);
  font-size: 12.5px;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.sf-node.on {
  border-color: var(--cf-accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--cf-accent) 15%, transparent);
}
.sf-h {
  font-weight: 600;
  font-size: 13.5px;
}
.sf-h small {
  display: block;
  font-weight: 400;
  font-size: 11.5px;
  color: var(--cf-muted-foreground);
}
.sf-items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sf-items span,
.sf-check {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  font-size: 11.5px;
  color: var(--cf-muted-foreground);
}
.sf-nokey {
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: color-mix(in oklab, var(--cf-callout-tip) 16%, transparent);
  color: var(--cf-callout-tip);
}
.sf-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sf-check {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  transition: all 0.3s;
}
.sf-check.ok {
  border-color: color-mix(in oklab, var(--cf-callout-tip) 50%, transparent);
  color: var(--cf-callout-tip);
}
.sf-key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 5px 10px;
  border-radius: 8px;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  border: 1px dashed var(--cf-border);
  color: var(--cf-muted-foreground);
  transition: all 0.35s;
}
.sf-key small {
  font-family: var(--font-sans, sans-serif);
  opacity: 0.7;
}
.sf-key svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
}
.sf-key.on {
  border-style: solid;
  border-color: var(--cf-callout-warn);
  color: var(--cf-foreground);
  background: color-mix(in oklab, var(--cf-callout-warn) 16%, transparent);
  transform: translateX(6px);
}
.sf-wire {
  position: relative;
  display: grid;
  place-items: center;
}
.sf-wire::before {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  top: 50%;
  border-top: 1.5px dashed var(--cf-border);
}
@media (max-width: 760px) {
  .sf-wire::before {
    left: 50%;
    right: auto;
    top: 2px;
    bottom: 2px;
    border-top: 0;
    border-left: 1.5px dashed var(--cf-border);
  }
}
.sf-packet {
  position: relative;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  background: var(--cf-foreground);
  color: var(--cf-background);
  opacity: 0;
  transition: opacity 0.3s;
}
.sf-packet:not(.right).s1,
.sf-packet:not(.right).s4,
.sf-packet.right.s3,
.sf-packet.right.s4 {
  opacity: 1;
  animation: sf-go 1.2s ease-in-out infinite alternate;
}
.sf-packet.right.s3 {
  background: var(--cf-callout-warn);
  color: #1a1a1a;
}
@keyframes sf-go {
  from {
    transform: translateX(-10px);
  }
  to {
    transform: translateX(10px);
  }
}
.sf-cap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 64px;
  font-size: 14px;
}
.sf-cap span {
  color: var(--cf-muted-foreground);
}
.sf-steps {
  display: flex;
  gap: 6px;
}
.sf-steps button {
  min-width: 30px;
  height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  background: var(--cf-background);
  font-size: 12px;
  color: var(--cf-muted-foreground);
}
.sf-steps button.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
</style>
