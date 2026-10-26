<script setup>
import { computed } from 'vue'
import { useTimeline } from './timeline.js'

/*
 * A site in miniature, and the four doors into the panel. Each variant gets
 * three beats: idle, the door is pressed, the panel is open. The floating
 * placement is the bar — the shipped shape, ui-specs/015: pressing it is typing
 * into it, and the window rises above it with the field left where it was.
 */
const variants = [
  { id: 'fab', label: "trigger: 'fab'", panel: 'bar' },
  { id: 'nav', label: "trigger: 'nav'", panel: 'drawer' },
  { id: 'key', label: '⌘ I', panel: 'drawer' },
  { id: 'cta', label: 'under the article', panel: 'drawer' },
]
const { step, root, go } = useTimeline(variants.flatMap(() => [900, 700, 2000]))
const v = computed(() => variants[Math.floor(step.value / 3)])
const beat = computed(() => step.value % 3)
const pick = (i) => go(i * 3 + 2)
</script>

<template>
  <div ref="root" class="td">
    <div class="td-tabs">
      <button v-for="(x, i) in variants" :key="x.id" class="mp-chip" :class="{ on: x === v }" @click="pick(i)">{{ x.label }}</button>
    </div>
    <div class="td-site">
      <div class="td-nav">
        <span class="td-logo" />
        <span class="td-links"><i /><i /><i /></span>
        <span class="td-search">Search <kbd>⌘K</kbd></span>
        <span v-if="v.id === 'nav'" class="td-navbtn" :class="{ hot: beat === 1 }">
          <svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.8L20 10l-5 3.9L16.5 20 12 16.6 7.5 20 9 13.9 4 10l6.1-1.2Z" /></svg>
        </span>
      </div>
      <div class="td-main">
        <div class="td-side"><i /><i /><i /><i /></div>
        <div class="td-article">
          <div class="td-h" />
          <i /><i /><i class="s" /><i /><i class="s" />
          <div v-if="v.id === 'cta'" class="td-cta" :class="{ hot: beat === 1 }">Didn't find it? Ask DocPilot</div>
        </div>
      </div>
      <Transition name="mp-pop">
        <span v-if="v.id === 'key' && beat === 1" class="td-keys"><kbd>⌘</kbd><kbd>I</kbd></span>
      </Transition>
      <Transition name="td-window">
        <div v-if="beat === 2 && v.panel === 'bar'" class="td-window">
          <div class="td-ph">DocPilot</div>
          <div class="td-pb">How do I deploy?</div>
        </div>
      </Transition>
      <span v-if="v.id === 'fab'" class="td-bar" :class="{ hot: beat === 1, open: beat > 0 }">
        <svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.8L20 10l-5 3.9L16.5 20 12 16.6 7.5 20 9 13.9 4 10l6.1-1.2Z" /></svg>
        <span class="td-bar-field" :class="{ typed: beat > 0 }">{{ beat > 0 ? 'How do I deploy?' : 'Ask about Acme' }}</span>
        <kbd>⌘I</kbd>
      </span>
      <Transition name="td-drawer">
        <div v-if="beat === 2 && v.panel === 'drawer'" class="td-drawer">
          <div class="td-ph">DocPilot</div>
          <div class="td-pb">How can I help you today?</div>
          <div class="td-pc">Ask about Acme</div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.td {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.td-tabs {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
.td-tabs .mp-chip {
  font-family: var(--font-mono, monospace);
  cursor: pointer;
}
.mp-chip.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
  border-color: transparent;
}
.td-site {
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
.td-site :deep(svg) {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linejoin: round;
}
.td-nav {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--cf-border);
}
.td-logo {
  width: 56px;
  height: 10px;
  border-radius: 4px;
  background: var(--cf-foreground);
}
.td-links {
  display: flex;
  gap: 8px;
  flex: 1;
}
.td-links i,
.td-side i,
.td-article i {
  display: block;
  height: 7px;
  border-radius: 4px;
  background: var(--cf-surface);
}
.td-links i {
  width: 36px;
}
.td-search {
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
.td-navbtn {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--cf-muted-foreground);
  transition: all 0.2s;
}
.hot {
  box-shadow: 0 0 0 2px var(--cf-accent);
  transform: scale(0.95);
}
.td-main {
  display: flex;
  gap: 20px;
  padding: 18px;
}
.td-side {
  width: 90px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.td-article {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.td-h {
  width: 50%;
  height: 16px;
  border-radius: 5px;
  background: var(--cf-accent-bg);
}
.td-article i.s {
  width: 70%;
}
.td-cta {
  align-self: flex-start;
  margin-top: 12px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  transition: all 0.2s;
}
.td-keys {
  position: absolute;
  left: 50%;
  top: 50%;
  translate: -50% -50%;
  display: flex;
  gap: 4px;
}
.td-keys kbd {
  font-size: 18px;
  padding: 6px 12px;
  box-shadow: 0 6px 18px -6px rgb(0 0 0 / 0.3);
}
.td-bar {
  position: absolute;
  left: 50%;
  bottom: 14px;
  translate: -50% 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 230px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  background: var(--cf-popover);
  box-shadow: 0 10px 28px -12px rgb(0 0 0 / 0.35);
  color: var(--cf-muted-foreground);
  transition: all 0.2s, width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.td-bar.open {
  width: 290px;
}
.td-bar-field {
  flex: 1;
}
.td-bar-field.typed {
  color: var(--cf-foreground);
}
.td-window,
.td-drawer {
  position: absolute;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cf-border);
  background: var(--cf-popover);
  box-shadow: 0 18px 40px -12px rgb(0 0 0 / 0.35);
}
.td-window {
  left: 50%;
  bottom: 58px;
  translate: -50% 0;
  width: 290px;
  height: 220px;
  border-radius: 14px;
  transform-origin: bottom center;
}
.td-drawer {
  right: 0;
  top: 40px;
  bottom: 0;
  width: 220px;
  border-width: 0 0 0 1px;
}
.td-ph {
  padding: 8px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--cf-border);
}
.td-pb {
  flex: 1;
  display: flex;
  align-items: flex-end;
  padding: 10px;
  font-size: 14px;
  font-weight: 600;
}
.td-pc {
  margin: 8px;
  padding: 7px 10px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  color: var(--cf-muted-foreground);
}
.td-window-enter-active,
.td-window-leave-active,
.td-drawer-enter-active,
.td-drawer-leave-active {
  transition: opacity 0.25s, transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.td-window-enter-from,
.td-window-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
.td-drawer-enter-from,
.td-drawer-leave-to {
  opacity: 0;
  transform: translateX(40px);
}
</style>
