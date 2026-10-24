<script setup>
import { useTimeline } from './timeline.js'
import MockPanel from './MockPanel.vue'

// 0 closed · 1 open: instructions · 2 tools · 3 scope · 4 your instruction added
const { step, root } = useTimeline([1300, 1600, 1400, 1400, 2600])
</script>

<template>
  <div ref="root">
    <MockPanel :height="430">
      <div class="pd-toggle" :class="{ open: step >= 1 }">
        <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
        {{ step >= 4 ? 'How this works, with your instruction' : 'How this works' }}
      </div>
      <div class="pd-body" :class="{ open: step >= 1 }">
        <div class="pd-inner">
          <div class="pd-sec" :class="{ hot: step === 1 }">
            <div class="pd-h">Instructions</div>
            <div class="pd-t">You answer questions about Acme using only the excerpts you are given. Never invent APIs, methods, fields or routes. Mark every claim with a citation marker…</div>
          </div>
          <div class="pd-sec" :class="{ hot: step === 2 }">
            <div class="pd-h">Tools (delivered as tool definitions)</div>
            <div class="pd-t"><code>search_docs</code> · <code>fetch_section</code> · <code>expand_section</code> · <code>list_pages</code> · <code>answer</code></div>
          </div>
          <div class="pd-sec" :class="{ hot: step === 3 }">
            <div class="pd-h">Scope</div>
            <div class="pd-t">All documentation pages are searched.</div>
          </div>
          <div class="pd-sec" :class="{ hot: step === 4 }">
            <div class="pd-h">Your instruction</div>
            <div class="pd-t">{{ step >= 4 ? 'Answer in short bullet points.' : 'None. Anything you add is sent with your question, never as part of the instruction above.' }}</div>
          </div>
        </div>
      </div>
    </MockPanel>
  </div>
</template>

<style scoped>
.pd-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--cf-muted-foreground);
}
.pd-toggle svg {
  transition: transform 0.3s;
}
.pd-toggle.open svg {
  transform: rotate(90deg);
}
.pd-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
.pd-body.open {
  grid-template-rows: 1fr;
}
.pd-inner {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pd-sec {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--cf-surface);
  transition: box-shadow 0.3s;
}
.pd-sec.hot {
  box-shadow: inset 0 0 0 1px var(--cf-accent);
}
.pd-h {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cf-muted-foreground);
}
.pd-t {
  font-size: 12.5px;
}
</style>
