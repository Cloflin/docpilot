<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'

/*
 * The life of the skills in a project, in three acts: `init` copies them into
 * the agent tool's directory, the agent reads one and runs the CLI it
 * describes, `update` refreshes them after an upgrade and keeps an edited file
 * beside the new one. The tree on the left is the project's `.claude/`; the
 * pane on the right is the terminal, then the agent, then the terminal again.
 *
 * Every row and line carries `at`, the step it appears on — one timeline for
 * all three acts, so the tree is always in the state the act left it in.
 */
const acts = [
  { id: 'init', label: '1 · init copies', last: 4 },
  { id: 'use', label: '2 · the agent reads', last: 8 },
  { id: 'update', label: '3 · update refreshes', last: 12 },
]
const { step, root, go } = useTimeline([900, 500, 500, 500, 2000, 1000, 1200, 1200, 2800, 900, 600, 900, 2600])
const act = computed(() => acts.findIndex((a) => step.value <= a.last))
const pick = (i) => go(acts[i].last)

const tree = [
  { at: 1, d: 0, name: '.claude/' },
  { at: 1, d: 1, name: 'skills/' },
  { at: 1, d: 2, name: 'docs-rag/', note: 'measure and tune', hl: [6] },
  { at: 1, d: 3, name: 'SKILL.md', hl: [6, 10] },
  { at: 1, d: 3, name: 'judge-protocol.md', edited: 9, hl: [11] },
  { at: 11, d: 3, name: 'judge-protocol.md.bak', bak: true },
  { at: 2, d: 2, name: 'docs-import/', note: 'imported pages' },
  { at: 2, d: 2, name: 'docs-tune/', note: 'the improvement loop' },
  { at: 3, d: 1, name: 'commands/', note: '/docpilot-index, /docpilot-eval, …', hl: [5, 12] },
  { at: 4, d: 1, name: 'agents/', note: 'docpilot-tuner, docpilot-writer' },
]
const rows = computed(() => tree.filter((r) => step.value >= r.at))

/** @type {Array<Array<{ at: number, cmd?: string, ok?: string, warn?: string, you?: string, tool?: string, agent?: string }>>} */
const lines = [
  [
    { at: 0, cmd: 'npx docpilot init --target=claude --scope=project' },
    { at: 1, ok: '[docpilot] wrote    .claude/skills/docs-rag/' },
    { at: 2, ok: '[docpilot] wrote    .claude/skills/docs-import/ · docs-tune/' },
    { at: 3, ok: '[docpilot] wrote    .claude/commands/docpilot-*.md' },
    { at: 4, ok: '[docpilot] wrote    .claude/agents/docpilot-tuner.md · docpilot-writer.md' },
  ],
  [
    { at: 5, you: '/docpilot-eval --gate-only' },
    { at: 6, tool: 'Read  .claude/skills/docs-rag/SKILL.md' },
    { at: 7, tool: 'Bash  npx docpilot eval --gate-only --quiet' },
    {
      at: 8,
      agent: 'recall@8 0.884, up 0.020 on the last run. Retrieval holds; the two misses are vocabulary, so the fix is an alias, not a constant. MMR is under Things already measured — not proposing it again.',
    },
  ],
  [
    { at: 9, cmd: 'npx docpilot update' },
    { at: 10, ok: '[docpilot] updated  .claude/skills/docs-rag/SKILL.md' },
    { at: 11, warn: '[docpilot] REPLACED .claude/skills/docs-rag/judge-protocol.md   (your copy kept as judge-protocol.md.bak)' },
    { at: 12, ok: '[docpilot] updated  .claude/commands/docpilot-*.md' },
  ],
]
const shown = computed(() => lines[act.value].filter((l) => step.value >= l.at))
</script>

<template>
  <div ref="root" class="kd">
    <div class="kd-tabs">
      <button v-for="(a, i) in acts" :key="a.id" class="mp-chip" :class="{ on: i === act }" @click="pick(i)">{{ a.label }}</button>
    </div>
    <div class="kd-grid">
      <div class="kd-tree">
        <TransitionGroup name="mp-fade">
          <div
            v-for="r in rows"
            :key="r.name"
            class="kd-row"
            :class="{ hl: r.hl?.includes(step), bak: r.bak }"
            :style="{ paddingLeft: 8 + r.d * 14 + 'px' }"
          >
            <span class="kd-name">{{ r.name }}</span>
            <span v-if="r.edited && step >= r.edited && step < 11" class="kd-edit">✎ edited</span>
            <span v-else-if="r.note" class="kd-note">{{ r.note }}</span>
          </div>
        </TransitionGroup>
      </div>
      <div class="kd-pane" :class="act === 1 ? 'chat' : 'term'">
        <div class="kd-top">{{ act === 1 ? 'Claude Code' : 'terminal' }}</div>
        <div class="kd-body">
          <TransitionGroup name="mp-fade">
            <div v-for="l in shown" :key="l.at" class="kd-line">
              <span v-if="l.cmd"><span class="kd-p">$</span> {{ l.cmd }}</span>
              <span v-else-if="l.ok" class="k-ok">{{ l.ok }}</span>
              <span v-else-if="l.warn" class="k-warn">{{ l.warn }}</span>
              <div v-else-if="l.you" class="mp-q kd-you">{{ l.you }}</div>
              <div v-else-if="l.tool" class="kd-tool">{{ l.tool }}</div>
              <div v-else-if="l.agent" class="kd-agent">{{ l.agent }}</div>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kd {
  width: min(680px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: left;
}
.kd-tabs {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
.kd-tabs .mp-chip {
  cursor: pointer;
}
.mp-chip.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.kd-grid {
  width: 100%;
  display: grid;
  grid-template-columns: 230px 1fr;
  gap: 12px;
}
.kd-tree,
.kd-pane {
  height: 300px;
  border: 1px solid var(--cf-border);
  border-radius: 12px;
  background: var(--cf-background);
  overflow: hidden;
  box-shadow: 0 18px 48px -20px rgb(0 0 0 / 0.2);
}
.kd-tree {
  padding: 10px 6px;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
}
.kd-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-block: 3px;
  padding-right: 8px;
  border-radius: 6px;
  transition: background-color 0.25s;
}
.kd-row.hl {
  background: var(--cf-accent-bg);
}
.kd-row.bak .kd-name {
  color: var(--cf-callout-warn);
}
.kd-name {
  flex: none;
}
.kd-note {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--cf-muted-foreground);
  font-family: var(--font-sans, inherit);
  font-size: 11px;
}
.kd-edit {
  color: var(--cf-callout-warn);
  font-size: 11px;
}
.kd-top {
  padding: 8px 12px;
  border-bottom: 1px solid var(--cf-border);
  font: 500 12px/1 var(--font-mono, monospace);
  color: var(--cf-muted-foreground);
}
.kd-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
}
.term .kd-body {
  gap: 2px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
}
.chat .kd-body {
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.5;
}
.kd-p {
  color: var(--cf-accent);
}
.k-ok {
  color: var(--cf-callout-tip);
}
.k-warn {
  color: var(--cf-callout-warn);
}
.kd-line {
  display: flex;
  flex-direction: column;
}
.kd-you {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  padding: 5px 12px;
}
.kd-tool {
  align-self: flex-start;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--cf-surface);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--cf-muted-foreground);
}
@media (max-width: 600px) {
  .kd-grid {
    grid-template-columns: 1fr;
  }
  .kd-tree {
    height: auto;
    min-height: 120px;
  }
}
</style>
