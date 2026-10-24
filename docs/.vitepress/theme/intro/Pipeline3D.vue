<script setup>
import { computed } from 'vue'
import { useTimeline } from '../demos/timeline.js'
import { useFigures } from './figures.js'

/*
 * The build loop as a stack of layers, seen from above at an angle. Each CLI
 * step lifts the layer it writes and the terminal on the right shows the
 * command and what it reads and writes. The order is the one in
 * docs/reference/cli.md: index → calibrate → (index again) → lint → eval, with
 * tune and feedback sending you back to the start.
 *
 * Figures are this site's own, from the committed manifest.
 */
const fig = useFigures()
const layers = [
  { id: 'pages', name: 'Your pages', note: 'Markdown · OpenAPI · imported pages' },
  { id: 'chunks', name: 'Chunks', note: '350–500 tokens, split at ## / ###' },
  { id: 'vectors', name: 'Vectors', note: '1 bit per dimension' },
  { id: 'gate', name: 'Calibration', note: 'relevance floor τ for this corpus' },
  { id: 'eval', name: 'Evaluation', note: 'golden questions, scored' },
]

const steps = computed(() => [
  {
    cmd: 'npx docpilot init',
    what: 'Scaffolds the loop: .env.example, a starter golden set and calibration set, agent skills.',
    reads: 'your answers to four questions',
    writes: 'docpilot/ · .env.example · skills',
    lit: ['pages'],
  },
  {
    cmd: 'npx docpilot index',
    what: 'Splits every page into chunks, embeds them, stores one bit per dimension.',
    reads: 'docs/**/*.md',
    writes: `docs/public/rag/ — ${fig.value.chunks} chunks, ${fig.value.kb} of vectors`,
    lit: ['pages', 'chunks', 'vectors'],
  },
  {
    cmd: 'npx docpilot calibrate',
    what: 'Measures where on-topic and off-topic questions separate on your corpus.',
    reads: 'docpilot/calibration.jsonl',
    writes: `docpilot/calibration.json${fig.value.tau ? ` — τ ${fig.value.tau}` : ''}`,
    lit: ['gate'],
  },
  {
    cmd: 'npx docpilot index',
    what: 'Rebuild: the thresholds are inlined into the manifest the browser reads.',
    reads: 'calibration.json',
    writes: 'docs/public/rag/manifest.json',
    lit: ['vectors', 'gate'],
  },
  {
    cmd: 'npx docpilot lint',
    what: 'Checks that every golden question still points at chunks that exist.',
    reads: 'docpilot/golden.jsonl',
    writes: 'nothing — a report',
    lit: ['chunks', 'eval'],
  },
  {
    cmd: 'npx docpilot eval',
    what: 'Scores retrieval and answers against the golden set.',
    reads: 'docpilot/golden.jsonl',
    writes: 'docpilot/reports/latest.json',
    lit: ['eval'],
  },
  {
    cmd: 'npx docpilot tune',
    what: 'Sweeps the retrieval weights; the winner takes effect on the next index.',
    reads: 'the golden set',
    writes: 'docpilot/tuning.json → back to index',
    lit: ['vectors', 'eval'],
    loop: true,
  },
  {
    cmd: 'npx docpilot feedback pull',
    what: 'Turns readers’ thumbs-down into candidate questions for the next eval.',
    reads: 'your feedback endpoint',
    writes: 'docpilot/candidates.jsonl',
    lit: ['eval', 'pages'],
    loop: true,
  },
])

const { step, root, go, play, hold } = useTimeline(Array.from({ length: 8 }, () => 3400))
const cur = computed(() => steps.value[step.value])
const isLit = (id) => cur.value.lit.includes(id)
const bits = Array.from({ length: 48 }, (_, i) => ((i * 7919) % 5) % 2)
</script>

<template>
  <div ref="root" class="p3">
    <div class="p3-scene" aria-hidden="true">
      <div class="p3-stack">
        <div
          v-for="(l, i) in layers"
          :key="l.id"
          class="p3-layer"
          :class="[l.id, { lit: isLit(l.id) }]"
          :style="{ '--z': i * 46 + 'px' }"
        >
          <div class="p3-face">
            <template v-if="l.id === 'pages'">
              <span v-for="n in 6" :key="n" class="p3-doc"><i /><i /><i /></span>
            </template>
            <template v-else-if="l.id === 'chunks'">
              <span v-for="n in 18" :key="n" class="p3-chunk" :style="{ animationDelay: n * 60 + 'ms' }" />
            </template>
            <template v-else-if="l.id === 'vectors'">
              <span v-for="(b, n) in bits" :key="n" class="p3-bit" :class="{ one: b }" />
            </template>
            <template v-else-if="l.id === 'gate'">
              <span class="p3-gauge"><span class="p3-tau" /></span>
            </template>
            <template v-else>
              <span v-for="n in 8" :key="n" class="p3-check" :class="{ miss: n === 6 }" />
            </template>
          </div>
        </div>
      </div>
      <div class="p3-labels">
        <div v-for="l in [...layers].reverse()" :key="l.id" class="p3-label" :class="{ lit: isLit(l.id) }">
          <b>{{ l.name }}</b><span>{{ l.note }}</span>
        </div>
      </div>
    </div>

    <div class="p3-side">
      <div class="p3-term">
        <div class="p3-term-bar"><i /><i /><i /><span>terminal</span></div>
        <div class="p3-term-body">
          <Transition name="mp-fade" mode="out-in">
            <div :key="step">
              <div class="p3-cmd"><span class="p3-prompt">$</span> {{ cur.cmd }}<i class="p3-caret" /></div>
              <div class="p3-what">{{ cur.what }}</div>
              <div class="p3-io"><span>reads</span>{{ cur.reads }}</div>
              <div class="p3-io"><span>writes</span>{{ cur.writes }}</div>
              <div v-if="cur.loop" class="p3-loop">↻ the loop starts again — this is how the assistant improves</div>
            </div>
          </Transition>
        </div>
      </div>
      <div class="p3-steps" role="list">
        <span v-for="(s, i) in steps" :key="i" role="listitem">
          <button :class="{ on: i === step, done: i < step }" @click="go(i)">
            <span class="p3-n">{{ i + 1 }}</span>{{ s.cmd.replace('npx docpilot ', '') }}
          </button>
        </span>
        <button class="p3-play" @click="play">{{ hold ? '▶ play' : '❚❚ playing' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.p3 {
  display: grid;
  gap: 20px;
  margin: 1.5rem 0 2.5rem;
  padding: 20px;
  border: 1px solid var(--cf-border);
  border-radius: 16px;
  background-color: var(--cf-surface);
  background-image: radial-gradient(color-mix(in oklab, var(--cf-muted-foreground) 25%, transparent) 1px, transparent 1px);
  background-size: 16px 16px;
}
@media (min-width: 1000px) {
  .p3 {
    grid-template-columns: 1.1fr 1fr;
    align-items: center;
  }
}

/* ── the scene ───────────────────────────────────────────── */
.p3-scene {
  position: relative;
  height: 400px;
  perspective: 1400px;
  display: grid;
  place-items: center;
}
.p3-stack {
  position: relative;
  width: 230px;
  height: 230px;
  transform-style: preserve-3d;
  transform: translateX(-80px) translateY(70px) rotateX(58deg) rotateZ(-42deg);
}
.p3-layer {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  transform: translateZ(var(--z));
  transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}
.p3-layer.lit {
  transform: translateZ(calc(var(--z) + 22px));
}
.p3-face {
  position: absolute;
  inset: 0;
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  border-radius: 18px;
  border: 1px solid var(--cf-border);
  background: color-mix(in oklab, var(--cf-background) 88%, transparent);
  box-shadow: 0 1px 0 var(--cf-border), -10px 16px 30px -18px rgb(0 0 0 / 0.35);
  transition: border-color 0.4s, background-color 0.4s, box-shadow 0.4s;
}
.lit .p3-face {
  border-color: var(--cf-accent);
  background: color-mix(in oklab, var(--cf-accent) 10%, var(--cf-background));
  box-shadow: 0 0 0 1px var(--cf-accent), -14px 22px 40px -16px color-mix(in oklab, var(--cf-accent) 55%, transparent);
}
.p3-doc {
  width: 46px;
  height: 58px;
  padding: 7px 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-radius: 6px;
  background: var(--cf-background);
  border: 1px solid var(--cf-border);
}
.p3-doc i {
  height: 4px;
  border-radius: 2px;
  background: var(--cf-border);
}
.p3-doc i:last-child {
  width: 60%;
}
.p3-chunk {
  width: 30px;
  height: 18px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--cf-muted-foreground) 30%, transparent);
}
.lit .p3-chunk {
  background: color-mix(in oklab, var(--cf-accent) 45%, transparent);
  animation: p3-pulse 1.4s ease-in-out infinite;
}
@keyframes p3-pulse {
  50% {
    opacity: 0.45;
  }
}
.p3-bit {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: var(--cf-border);
}
.p3-bit.one {
  background: var(--cf-foreground);
}
.lit .p3-bit.one {
  background: var(--cf-accent);
}
.p3-gauge {
  position: relative;
  width: 80%;
  height: 16px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--cf-callout-danger), var(--cf-callout-warn) 55%, var(--cf-callout-tip));
  opacity: 0.75;
}
.p3-tau {
  position: absolute;
  left: 68%;
  top: -8px;
  bottom: -8px;
  width: 3px;
  border-radius: 2px;
  background: var(--cf-foreground);
}
.p3-check {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--cf-callout-tip) 35%, transparent);
}
.p3-check.miss {
  background: color-mix(in oklab, var(--cf-callout-danger) 40%, transparent);
}
.p3-labels {
  position: absolute;
  right: 0;
  top: 18px;
  bottom: 70px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  text-align: right;
}
.p3-label {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--cf-muted-foreground);
  transition: color 0.3s, transform 0.3s;
}
.p3-label b {
  font-size: 13px;
  font-weight: 600;
  color: var(--cf-foreground);
}
.p3-label.lit {
  transform: translateX(-4px);
}
.p3-label.lit b {
  color: var(--cf-accent);
}
@media (max-width: 560px) {
  .p3-scene {
    height: 340px;
  }
  .p3-stack {
    transform: translateX(-60px) translateY(60px) rotateX(58deg) rotateZ(-42deg) scale(0.8);
  }
  .p3-label span {
    display: none;
  }
}

/* ── the terminal ───────────────────────────────────────── */
.p3-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.p3-term {
  border-radius: 12px;
  overflow: hidden;
  background: #0f1115;
  color: #e6e6e6;
  box-shadow: 0 18px 40px -20px rgb(0 0 0 / 0.5);
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  line-height: 1.6;
}
.p3-term-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  background: #171a21;
}
.p3-term-bar i {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #3a3f4b;
}
.p3-term-bar span {
  margin-left: 8px;
  font-size: 11px;
  color: #8b93a3;
}
.p3-term-body {
  min-height: 178px;
  padding: 14px 16px;
}
.p3-cmd {
  color: #fff;
}
.p3-prompt {
  color: #8ba0ea;
}
.p3-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 4px;
  vertical-align: -2px;
  background: #8ba0ea;
  animation: p3-blink 1s steps(1) infinite;
}
@keyframes p3-blink {
  50% {
    opacity: 0;
  }
}
.p3-what {
  margin: 8px 0 10px;
  color: #b9c0cc;
  font-family: var(--font-sans, sans-serif);
  font-size: 13px;
}
.p3-io {
  display: flex;
  gap: 10px;
  color: #e6e6e6;
}
.p3-io span {
  width: 52px;
  flex: none;
  color: #6f7785;
}
.p3-loop {
  margin-top: 10px;
  color: #9fd8a9;
}
.p3-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.p3-steps button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  background: var(--cf-background);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--cf-muted-foreground);
  transition: all 0.2s;
}
.p3-steps button.done {
  color: var(--cf-foreground);
}
.p3-steps button.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.p3-n {
  font-size: 10px;
  opacity: 0.7;
}
.p3-play {
  font-family: var(--font-sans, sans-serif) !important;
}
</style>
