<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'

/*
 * Where a turn runs. Three boxes — the reader's browser, your server, the model
 * provider — and the same five beats for each install: the page loads, the
 * question is asked, it is worked on, the model is called, the answer streams
 * back. What travels on each wire, and what each box holds, is the difference.
 *
 * `wires.a` is browser ↔ server, `wires.b` is server ↔ provider; each beat
 * names the direction and the label of the wires that carry something.
 */
const installs = [
  {
    id: 'static',
    label: "runtime: 'browser'",
    holds: { page: ['index', 'prompt', 'thresholds'], server: ['the key'], model: ['the model'] },
    beats: [
      { wires: { a: ['left', 'index · prompt · thresholds'] }, act: { page: 'downloads the index' } },
      { act: { page: 'searches · gates · builds the prompt' } },
      { wires: { a: ['right', '/ai/v1/chat'] }, act: { server: 'attaches the key' } },
      { wires: { b: ['right', 'prompt + key'] }, act: { model: 'answers' } },
      { wires: { a: ['left', 'stream'], b: ['left', 'stream'] }, act: { page: 'draws the answer' } },
    ],
    run: 'no process of your own — the /ai proxy beside the site forwards the call',
    public: ['page text', 'vectors', 'the prompt', 'the thresholds'],
  },
  {
    id: 'server',
    label: "runtime: 'server'",
    holds: { page: ['page list'], server: ['index', 'prompt', 'thresholds', 'the key', 'limits', 'metrics'], model: ['the model'] },
    beats: [
      { wires: { a: ['left', 'pages · sections'] }, act: { page: 'loads the shell' } },
      { wires: { a: ['right', 'the question'] }, act: { page: 'sends the question' } },
      { act: { server: 'searches · gates · runs the loop' } },
      { wires: { b: ['right', 'prompt + key'] }, act: { model: 'answers' } },
      { wires: { a: ['left', 'SSE stream'], b: ['left', 'stream'] }, act: { page: 'draws the answer' } },
    ],
    run: 'one process — npx docpilot serve, or createDocPilotServer in your own',
    public: ['the page list', 'the passages an answer cites', 'the answer stream'],
  },
]
const { step, root, go } = useTimeline([1400, 1300, 1300, 1100, 2600, 1400, 1100, 1500, 1100, 2600])
const k = computed(() => installs[Math.floor(step.value / 5)])
const b = computed(() => k.value.beats[step.value % 5])
const pick = (i) => go(i * 5 + 4)
const boxes = [
  { id: 'page', name: "Reader's browser" },
  { id: 'server', name: 'Your server' },
  { id: 'model', name: 'Model provider' },
]
</script>

<template>
  <div ref="root" class="rd">
    <div class="rd-tabs">
      <button v-for="(x, i) in installs" :key="x.id" class="mp-chip" :class="{ on: x === k }" @click="pick(i)">
        {{ x.id }} · {{ x.label }}
      </button>
    </div>
    <div class="rd-flow">
      <template v-for="(box, i) in boxes" :key="box.id">
        <div v-if="i > 0" class="rd-wire" :class="b.wires?.[i === 1 ? 'a' : 'b']?.[0]">
          <span class="rd-dot" />
          <Transition name="mp-fade" mode="out-in">
            <span v-if="b.wires?.[i === 1 ? 'a' : 'b']" :key="b.wires[i === 1 ? 'a' : 'b'][1]" class="rd-tag">{{ b.wires[i === 1 ? 'a' : 'b'][1] }}</span>
          </Transition>
        </div>
        <div class="rd-box" :class="{ hot: b.act?.[box.id] }">
          <div class="rd-name">{{ box.name }}</div>
          <TransitionGroup name="mp-pop" tag="div" class="rd-holds">
            <span v-for="h in k.holds[box.id]" :key="k.id + h" class="rd-chip">{{ h }}</span>
          </TransitionGroup>
          <div class="rd-act">{{ b.act?.[box.id] ?? '' }}</div>
        </div>
      </template>
    </div>
    <dl class="rd-facts">
      <div>
        <dt>The page can download</dt>
        <dd>{{ k.public.join(' · ') }}</dd>
      </div>
      <div>
        <dt>You run</dt>
        <dd>{{ k.run }}</dd>
      </div>
      <div>
        <dt>The key</dt>
        <dd>on your server, in both</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.rd {
  width: min(640px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  font-size: 12px;
}
.rd-tabs {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
.rd-tabs .mp-chip {
  font-family: var(--font-mono, monospace);
  cursor: pointer;
}
.mp-chip.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.rd-flow {
  width: 100%;
  display: flex;
  align-items: stretch;
}
.rd-box {
  flex: 1 1 0;
  min-width: 0;
  min-height: 196px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--cf-border);
  border-radius: 12px;
  background: var(--cf-background);
  transition: box-shadow 0.25s, transform 0.25s;
}
.rd-box.hot {
  box-shadow: 0 0 0 2px var(--cf-accent);
}
.rd-name {
  font-weight: 600;
  font-size: 13px;
}
.rd-holds {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 48px;
  align-content: flex-start;
}
.rd-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--cf-surface);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}
.rd-act {
  min-height: 2.8em;
  color: var(--cf-accent);
  font-weight: 500;
}
.rd-wire {
  position: relative;
  flex: 0 0 96px;
  align-self: center;
  height: 2px;
  background: var(--cf-border);
}
.rd-dot {
  position: absolute;
  top: 50%;
  left: 0;
  width: 8px;
  height: 8px;
  margin-top: -4px;
  border-radius: 999px;
  background: var(--cf-accent);
  opacity: 0;
}
.rd-wire.right .rd-dot {
  animation: rd-right 0.9s ease-in-out infinite;
}
.rd-wire.left .rd-dot {
  animation: rd-left 0.9s ease-in-out infinite;
}
.rd-wire.right,
.rd-wire.left {
  background: color-mix(in oklab, var(--cf-accent) 45%, var(--cf-border));
}
@keyframes rd-right {
  from {
    left: 0;
    opacity: 1;
  }
  to {
    left: calc(100% - 8px);
    opacity: 1;
  }
}
@keyframes rd-left {
  from {
    left: calc(100% - 8px);
    opacity: 1;
  }
  to {
    left: 0;
    opacity: 1;
  }
}
.rd-tag {
  position: absolute;
  left: 50%;
  bottom: 10px;
  translate: -50% 0;
  width: max-content;
  max-width: 92px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--cf-popover);
  border: 1px solid var(--cf-border);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  line-height: 1.3;
  text-align: center;
}
.rd-facts {
  width: 100%;
  margin: 0;
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.rd-facts div {
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--cf-background);
}
.rd-facts dt {
  color: var(--cf-muted-foreground);
}
.rd-facts dd {
  margin: 0;
}
@media (max-width: 560px) {
  .rd-flow {
    flex-direction: column;
  }
  .rd-box {
    min-height: 0;
  }
  .rd-wire {
    flex: 0 0 40px;
    width: 2px;
    height: auto;
  }
  .rd-tag {
    max-width: 200px;
  }
  .rd-wire .rd-dot {
    left: -3px;
    margin-top: 0;
  }
  .rd-wire.right .rd-dot {
    animation-name: rd-down;
  }
  .rd-wire.left .rd-dot {
    animation-name: rd-up;
  }
  .rd-tag {
    left: 12px;
    bottom: auto;
    top: 50%;
    translate: 0 -50%;
  }
  .rd-facts div {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
@keyframes rd-down {
  from {
    top: 0;
    opacity: 1;
  }
  to {
    top: calc(100% - 8px);
    opacity: 1;
  }
}
@keyframes rd-up {
  from {
    top: calc(100% - 8px);
    opacity: 1;
  }
  to {
    top: 0;
    opacity: 1;
  }
}
</style>
