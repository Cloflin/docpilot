<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'

/*
 * One site in miniature and the three shapes the panel opens in, in the order
 * the page describes them: the bar, the popup, the drawer that pushes the page
 * aside. Each shape gets three beats — idle, the reader acts, the conversation
 * is open — and the conversation is the same one in all three, because only
 * the shape is a setting.
 */
const shapes = [
  { id: 'bar', label: "panel: 'bar'" },
  { id: 'popup', label: "panel: 'popup'" },
  { id: 'push', label: "layout: 'push'" },
]
const { step, root, go } = useTimeline([1000, 1600, 2800, 900, 700, 2600, 900, 700, 3000])
const s = computed(() => shapes[Math.floor(step.value / 3)])
const beat = computed(() => step.value % 3)
const open = computed(() => beat.value === 2)
const pick = (i) => go(i * 3 + 2)
</script>

<template>
  <div ref="root" class="sd">
    <div class="sd-tabs">
      <button v-for="(x, i) in shapes" :key="x.id" class="mp-chip" :class="{ on: x === s }" @click="pick(i)">
        <span class="sd-n">{{ i + 1 }}</span>{{ x.label }}
      </button>
    </div>
    <div class="sd-site">
      <div class="sd-nav">
        <span class="sd-logo" />
        <span class="sd-links"><i /><i /><i /></span>
        <span class="sd-search">Search <kbd>⌘K</kbd></span>
      </div>
      <div class="sd-main" :class="{ pushed: s.id === 'push' && open }">
        <div class="sd-side"><i /><i /><i /><i /></div>
        <div class="sd-article">
          <div class="sd-h" />
          <i /><i /><i class="s" /><i /><i class="s" /><i /><i class="s" />
        </div>
      </div>

      <!-- 1 — the bar: the field stays in the bar, the window rises above it -->
      <Transition name="sd-rise">
        <div v-if="s.id === 'bar' && beat > 0" class="sd-window">
          <div class="sd-ph">DocPilot</div>
          <div v-if="open" class="sd-thread">
            <div class="mp-q">How do retries work?</div>
            <div class="mp-a">A failed webhook is retried five times, with backoff <span class="mp-cite">1</span></div>
          </div>
          <div v-else class="sd-empty">How can I help you today?</div>
        </div>
      </Transition>
      <div v-if="s.id === 'bar'" class="sd-bar" :class="{ wide: beat > 0 }">
        <svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.8L20 10l-5 3.9L16.5 20 12 16.6 7.5 20 9 13.9 4 10l6.1-1.2Z" /></svg>
        <span class="sd-field">
          <span v-if="beat === 1" class="sd-typed">How do retries work?</span>
          <span v-else class="sd-hint">{{ open ? 'Ask a follow-up' : 'Ask about Acme' }}</span>
        </span>
        <kbd v-if="beat === 0">⌘I</kbd>
        <span class="sd-send" :class="{ live: beat === 1 }">
          <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </span>
      </div>

      <!-- 2 and 3 — the floating button is the door -->
      <span v-if="s.id !== 'bar' && !(s.id === 'push' && open)" class="sd-fab" :class="{ hot: beat === 1 }">
        <svg v-if="s.id === 'popup' && open" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
        <svg v-else viewBox="0 0 24 24"><path d="M12 3l1.9 5.8L20 10l-5 3.9L16.5 20 12 16.6 7.5 20 9 13.9 4 10l6.1-1.2Z" /></svg>
        Ask AI
      </span>
      <Transition name="sd-popup">
        <div v-if="s.id === 'popup' && open" class="sd-popup">
          <div class="sd-ph">DocPilot</div>
          <div class="sd-thread">
            <div class="mp-q">How do retries work?</div>
            <div class="mp-a">A failed webhook is retried five times, with backoff <span class="mp-cite">1</span></div>
          </div>
          <div class="sd-pc">Ask a follow-up</div>
        </div>
      </Transition>
      <Transition name="sd-drawer">
        <div v-if="s.id === 'push' && open" class="sd-drawer">
          <div class="sd-ph">DocPilot</div>
          <div class="sd-thread">
            <div class="mp-q">How do retries work?</div>
            <div class="mp-a">A failed webhook is retried five times, with backoff <span class="mp-cite">1</span></div>
          </div>
          <div class="sd-pc">Ask a follow-up</div>
        </div>
      </Transition>
    </div>
    <div class="sd-note">
      <template v-if="s.id === 'bar'">The question box is on every page. The window rises at the first character typed.</template>
      <template v-else-if="s.id === 'popup'">A floating button. The conversation opens above it and covers a corner of the page.</template>
      <template v-else>A full-height drawer. The page narrows beside it, so nothing is covered.</template>
    </div>
  </div>
</template>

<style scoped>
.sd {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.sd-tabs {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
.sd-tabs .mp-chip {
  font-family: var(--font-mono, monospace);
  cursor: pointer;
}
.mp-chip.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.sd-n {
  font-weight: 600;
  opacity: 0.6;
}
.sd-site {
  position: relative;
  width: min(620px, 100%);
  height: 340px;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-background);
  overflow: hidden;
  box-shadow: 0 18px 48px -20px rgb(0 0 0 / 0.25);
  font-size: 12px;
}
.sd-site :deep(svg) {
  width: 15px;
  height: 15px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sd-nav {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--cf-border);
}
.sd-logo {
  width: 56px;
  height: 10px;
  border-radius: 4px;
  background: var(--cf-foreground);
}
.sd-links {
  display: flex;
  gap: 8px;
  flex: 1;
}
.sd-links i,
.sd-side i,
.sd-article i {
  display: block;
  height: 7px;
  border-radius: 4px;
  background: var(--cf-surface);
}
.sd-links i {
  width: 36px;
}
.sd-search {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--cf-surface);
  color: var(--cf-muted-foreground);
}
kbd {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
  border: 1px solid var(--cf-border);
  background: var(--cf-background);
}
.sd-main {
  display: flex;
  gap: 20px;
  padding: 18px;
  transition: padding-right 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
.sd-main.pushed {
  padding-right: 238px;
}
.sd-side {
  width: 90px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sd-article {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sd-h {
  width: 50%;
  height: 16px;
  border-radius: 5px;
  background: var(--cf-accent-bg);
}
.sd-article i.s {
  width: 70%;
}
.hot {
  box-shadow: 0 0 0 2px var(--cf-accent);
  transform: scale(0.95);
}

/* 1 — the bar and its window */
.sd-bar {
  position: absolute;
  left: 50%;
  bottom: 14px;
  translate: -50% 0;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 240px;
  max-width: calc(100% - 28px);
  padding: 5px 5px 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  background: var(--cf-popover);
  box-shadow: 0 10px 28px -12px rgb(0 0 0 / 0.35);
  color: var(--cf-muted-foreground);
  transition: width 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
.sd-bar.wide {
  width: 360px;
}
.sd-field {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.sd-typed {
  display: inline-block;
  vertical-align: bottom;
  width: 0;
  overflow: hidden;
  color: var(--cf-foreground);
  border-right: 1px solid currentColor;
  animation: sd-type 1.1s steps(20, end) 0.15s forwards;
}
@keyframes sd-type {
  to {
    width: 9.6em;
  }
}
.sd-send {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--cf-surface);
  transition: background-color 0.2s, color 0.2s;
}
.sd-send.live {
  background: var(--cf-foreground);
  color: var(--cf-background);
}
.sd-send :deep(svg) {
  width: 13px;
  height: 13px;
}
.sd-window {
  position: absolute;
  left: 50%;
  bottom: 58px;
  translate: -50% 0;
  width: 360px;
  max-width: calc(100% - 28px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cf-border);
  border-radius: 14px;
  background: var(--cf-popover);
  box-shadow: 0 18px 40px -12px rgb(0 0 0 / 0.35);
  transform-origin: bottom center;
}
.sd-empty {
  padding: 22px 12px;
  font-size: 14px;
  font-weight: 600;
}

/* 2 and 3 — the floating button, its popup, the drawer */
.sd-fab {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border-radius: 999px;
  background: var(--cf-foreground);
  color: var(--cf-background);
  font-weight: 500;
  transition: all 0.2s;
}
.sd-popup,
.sd-drawer {
  position: absolute;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cf-border);
  background: var(--cf-popover);
  box-shadow: 0 18px 40px -12px rgb(0 0 0 / 0.35);
}
.sd-popup {
  right: 14px;
  bottom: 58px;
  width: 230px;
  height: 230px;
  border-radius: 14px;
  transform-origin: bottom right;
}
.sd-drawer {
  right: 0;
  top: 40px;
  bottom: 0;
  width: 220px;
  border-width: 0 0 0 1px;
}
.sd-ph {
  padding: 8px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--cf-border);
}
.sd-thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px;
  line-height: 1.45;
}
.sd-thread .mp-q {
  padding: 5px 10px;
  border-radius: 14px;
}
.sd-pc {
  margin: 8px;
  padding: 7px 10px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  color: var(--cf-muted-foreground);
}
.sd-note {
  max-width: 460px;
  min-height: 2.6em;
  text-align: center;
  font-size: 13px;
  color: var(--cf-muted-foreground);
}

.sd-rise-enter-active,
.sd-popup-enter-active,
.sd-drawer-enter-active {
  transition: opacity 0.25s, transform 0.45s cubic-bezier(0.16, 1, 0.3, 1);
}
.sd-rise-leave-active,
.sd-popup-leave-active,
.sd-drawer-leave-active {
  transition: opacity 0.18s, transform 0.2s ease-in;
}
.sd-rise-enter-from,
.sd-rise-leave-to {
  opacity: 0;
  transform: translateY(16px) scale(0.96);
}
.sd-popup-enter-from,
.sd-popup-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(8px);
}
.sd-drawer-enter-from,
.sd-drawer-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>
