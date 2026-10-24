<script setup>
import { ref } from 'vue'

/*
 * The same five pairs as the README and `docs/guide/index.md`. `pnpm exec`,
 * not `pnpm run`: `run` executes package.json scripts, `exec` runs a bin. No
 * line runs the unscoped `docpilot`, which is a different package.
 */
const tabs = [
  { label: 'npm', lines: ['npm i @cloflin/docpilot', 'npx docpilot init'] },
  { label: 'Yarn', lines: ['yarn add @cloflin/docpilot', 'yarn docpilot init'] },
  { label: 'pnpm', lines: ['pnpm add @cloflin/docpilot', 'pnpm exec docpilot init'] },
  { label: 'Bun', lines: ['bun add @cloflin/docpilot', 'bunx docpilot init'] },
  { label: 'Deno', lines: ['deno add npm:@cloflin/docpilot', 'deno run -A npm:@cloflin/docpilot init'] },
]
const active = ref(0)
const copied = ref(false)
let timer = 0

async function copy() {
  try {
    await navigator.clipboard.writeText(tabs[active.value].lines.join('\n'))
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 1500)
  } catch {}
}
</script>

<template>
  <div class="it">
    <div class="it-bar">
      <div class="it-tabs" role="tablist" aria-label="Package manager">
        <button
          v-for="(t, i) in tabs"
          :key="t.label"
          role="tab"
          :aria-selected="i === active"
          :class="{ on: i === active }"
          @click="active = i"
        >{{ t.label }}</button>
      </div>
      <button class="it-copy" :aria-label="copied ? 'Copied' : 'Copy code'" :title="copied ? 'Copied' : 'Copy code'" @click="copy">
        <svg v-if="!copied" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
        <svg v-else viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
      </button>
    </div>
    <pre class="it-code"><code><span v-for="l in tabs[active].lines" :key="l" class="it-line"><span class="it-p">$</span> {{ l }}</span></code></pre>
  </div>
</template>

<style scoped>
.it {
  width: min(560px, 100%);
  margin: 1.25rem 0;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-background);
  overflow: hidden;
  text-align: left;
}
.it-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid var(--cf-border);
}
.it-tabs {
  display: flex;
  gap: 2px;
}
.it-tabs button {
  padding: 6px 10px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
  color: var(--cf-muted-foreground);
  transition: color 0.15s, background-color 0.15s;
}
.it-tabs button:hover {
  color: var(--cf-foreground);
}
.it-tabs button.on {
  color: var(--cf-foreground);
  background: var(--cf-accent-bg);
}
.it-copy {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  color: var(--cf-muted-foreground);
}
.it-copy:hover {
  color: var(--cf-foreground);
  background: var(--cf-accent-bg);
}
.it-copy svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.it-code {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
  font-family: var(--font-mono, monospace);
  font-size: 13.5px;
  line-height: 1.75;
  background: transparent;
}
.it-line {
  display: block;
  white-space: pre;
}
.it-p {
  color: var(--cf-muted-foreground);
  user-select: none;
}
</style>
