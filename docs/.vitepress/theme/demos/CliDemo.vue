<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'

/*
 * A first session with the CLI, on an imaginary Acme docs site: `init` asks
 * where the skills go and which install, `index` builds, `eval --gate-only`
 * measures, `status` names the next step. The figures are Acme's, not this
 * site's — the real ones live in `status` and are checked elsewhere.
 *
 * Each command is one beat for the typing, one per output line, and a hold on
 * the last line; `go()` jumps to the end of a command, fully printed.
 */
const runs = [
  {
    id: 'init',
    cmd: 'npx docpilot init',
    out: [
      ['ask', 'Which agent tool should get the DocPilot skills and /docpilot-* commands?', 'claude'],
      ['ask', 'For this project, or for you on this machine?', 'project'],
      ['ask', 'Where should a question be answered?', 'browser'],
      ['ask', 'Where should the button live?', 'fab'],
      ['ask', 'What shape should the panel be?', 'auto'],
      ['ok', '[docpilot] wrote    .claude/skills/  docs-rag · docs-import · docs-tune'],
      ['ok', '[docpilot] wrote    .claude/commands/  docpilot-*.md'],
      ['ok', '[docpilot] wrote    docpilot/  golden.jsonl · calibration.jsonl'],
      ['dim', "  paste:  runtime: 'browser',  ui: { trigger: 'fab', panel: 'auto' }"],
    ],
  },
  {
    id: 'index',
    cmd: 'npx docpilot index',
    out: [
      ['head', 'DocPilot index'],
      ['dim', '  embedder  qwen/qwen3-embedding-8b · 4096d'],
      ['bar', '  embedding'],
      ['kv', '  pages            42'],
      ['kv', '  chunks           318'],
      ['ok', '  written to docs/public/rag/  612 KB total · 214 KB on the wire (brotli)'],
      ['dim', '  hash 3f9a1c07'],
    ],
  },
  {
    id: 'eval',
    cmd: 'npx docpilot eval --gate-only',
    out: [
      ['bar', '  56 records'],
      ['dim', '  metric               value      Δ  trend'],
      ['kv', '  retrieval F1         0.712  +0.031  ▃▅█'],
      ['kv', '  recall@8             0.884  +0.020  ▄▆█'],
      ['kv', '  MRR                  0.741  −0.004  ▇█▇'],
      ['kv', '  negatives caught     93.3%       —  ▆▆'],
      ['ok', '  ✔ hallucinated citations 0 · ✔ scope containment 1.000'],
    ],
  },
  {
    id: 'status',
    cmd: 'npx docpilot status',
    out: [
      ['head', 'DocPilot status'],
      ['kv', '  project     runtime browser · config docs/.vitepress/config.mjs'],
      ['ok', '  index       ✔ fresh  3f9a1c07 · 318 chunks · 42 pages'],
      ['kv', '  eval sets   golden  56 records · answer 41 · refuse 15'],
      ['kv', '  last eval   gate-only · 2 min ago'],
      ['next', '  next        ❯ npx docpilot eval'],
      ['dim', '                retrieval is measured — now the answers, with the model'],
    ],
  },
]

const LINE = 280
const durations = []
const at = []
const ends = []
runs.forEach((r, i) => {
  durations.push(900)
  at.push([i, 0])
  r.out.forEach((line, j) => {
    const last = j === r.out.length - 1
    durations.push(last ? 2600 : line[0] === 'bar' ? 1300 : LINE)
    at.push([i, j + 1])
  })
  ends.push(at.length - 1)
})
const { step, root, go } = useTimeline(durations)
const run = computed(() => runs[at[step.value][0]])
const shown = computed(() => at[step.value][1])
const pick = (i) => go(ends[i])
</script>

<template>
  <div ref="root" class="cd">
    <div class="cd-tabs">
      <template v-for="(r, i) in runs" :key="r.id">
        <span v-if="i > 0" class="cd-arrow">→</span>
        <button class="mp-chip" :class="{ on: r === run }" @click="pick(i)">{{ r.id }}</button>
      </template>
    </div>
    <div class="cd-term">
      <div class="cd-top">
        <span /><span /><span />
        <b>acme-docs</b>
      </div>
      <div class="cd-body">
        <div class="cd-line">
          <span class="cd-p">$</span>
          <span :key="run.id" class="cd-cmd" :style="{ '--n': run.cmd.length }">{{ run.cmd }}</span>
        </div>
        <template v-for="(line, j) in run.out" :key="run.id + j">
          <div v-if="j < shown" class="cd-line" :class="'k-' + line[0]">
            <template v-if="line[0] === 'ask'">
              <span class="cd-q">{{ '  ' + line[1] }}</span> <span class="cd-a">{{ line[2] }}</span>
            </template>
            <template v-else-if="line[0] === 'bar'">
              <span>{{ line[1] }}</span><span class="cd-track"><span class="cd-fill" /></span>
            </template>
            <template v-else>{{ line[1] }}</template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd {
  width: min(640px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.cd-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.cd-tabs .mp-chip {
  font-family: var(--font-mono, monospace);
  cursor: pointer;
}
.mp-chip.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.cd-arrow {
  color: var(--cf-muted-foreground);
  font-size: 12px;
}
.cd-term {
  width: 100%;
  border: 1px solid var(--cf-border);
  border-radius: 12px;
  background: var(--cf-background);
  overflow: hidden;
  box-shadow: 0 18px 48px -20px rgb(0 0 0 / 0.25);
  text-align: left;
}
.cd-top {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--cf-border);
}
.cd-top span {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--cf-surface);
  border: 1px solid var(--cf-border);
}
.cd-top b {
  margin-left: 8px;
  font: 500 12px/1 var(--font-mono, monospace);
  color: var(--cf-muted-foreground);
}
.cd-body {
  height: 290px;
  padding: 12px 14px;
  overflow: hidden;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.7;
}
.cd-line {
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: cd-in 0.18s ease-out;
}
.cd-p {
  color: var(--cf-accent);
  margin-right: 8px;
}
.cd-cmd {
  display: inline-block;
  vertical-align: bottom;
  overflow: hidden;
  width: 0;
  animation: cd-type 0.7s steps(var(--n), end) forwards;
}
@keyframes cd-type {
  to {
    width: calc(var(--n) * 1ch);
  }
}
@keyframes cd-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
.cd-q {
  font-weight: 600;
}
.cd-a,
.k-next {
  color: var(--cf-accent);
}
.k-ok {
  color: var(--cf-callout-tip);
}
.k-dim {
  color: var(--cf-muted-foreground);
}
.k-head {
  font-weight: 600;
}
.cd-track {
  display: inline-block;
  vertical-align: middle;
  width: 220px;
  max-width: 50%;
  height: 6px;
  margin-left: 12px;
  border-radius: 999px;
  background: var(--cf-surface);
  overflow: hidden;
}
.cd-fill {
  display: block;
  height: 100%;
  width: 0;
  background: var(--cf-accent);
  animation: cd-fill 1.1s ease-in-out forwards;
}
@keyframes cd-fill {
  to {
    width: 100%;
  }
}
</style>
