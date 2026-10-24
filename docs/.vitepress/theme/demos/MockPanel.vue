<script setup>
/**
 * The panel's chrome, drawn rather than mounted: header with the history and
 * new-chat buttons, a scrolling body, and the composer with its scope chip.
 * Every feature demo puts its own story in the body and the composer slots, so
 * the frame stays identical from page to page, the way the real panel does.
 *
 * Labels are the shipped English defaults from `src/theme/docpilot/i18n.ts`.
 */
defineProps({
  title: { type: String, default: 'DocPilot' },
  placeholder: { type: String, default: 'Ask about Acme' },
  text: { type: String, default: '' },
  caret: { type: Boolean, default: false },
  scope: { type: String, default: 'All docs' },
  scopeActive: { type: Boolean, default: false },
  footnote: { type: String, default: 'AI-generated. Check the linked pages.' },
  historyActive: { type: Boolean, default: false },
  height: { type: Number, default: 420 },
})
</script>

<template>
  <div class="mp" :style="{ height: height + 'px' }">
    <div class="mp-head">
      <span class="mp-title">{{ title }}</span>
      <span class="mp-icons">
        <slot name="head" />
        <span class="mp-ic" :class="{ on: historyActive }" title="Past conversations">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </span>
        <span class="mp-ic" title="New chat">
          <svg viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        </span>
        <span class="mp-ic" title="Close">
          <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </span>
      </span>
    </div>
    <slot name="under-head" />
    <div class="mp-body"><slot /></div>
    <slot name="above-composer" />
    <div class="mp-composer">
      <slot name="composer-top" />
      <div class="mp-field">
        <span v-if="text" class="mp-text">{{ text }}<i v-if="caret" class="mp-caret" /></span>
        <span v-else class="mp-ph">{{ placeholder }}<i v-if="caret" class="mp-caret" /></span>
        <span class="mp-send" :class="{ on: text }">
          <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </span>
      </div>
      <div class="mp-foot">
        <span class="mp-scope" :class="{ on: scopeActive }">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M6 12h12M10 18h4" /></svg>{{ scope }}
        </span>
        <span class="mp-note">{{ footnote }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mp {
  position: relative;
  width: min(380px, 100%);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cf-border);
  border-radius: 16px;
  background: var(--cf-background);
  box-shadow: 0 18px 48px -16px rgb(0 0 0 / 0.25), 0 2px 6px rgb(0 0 0 / 0.04);
  overflow: hidden;
  font-size: 14px;
  line-height: 1.5;
  color: var(--cf-foreground);
  text-align: left;
}
.mp :deep(svg) {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex: none;
}
.mp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--cf-border);
}
.mp-title {
  font-weight: 600;
}
.mp-icons {
  display: inline-flex;
  gap: 2px;
}
.mp-ic {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  color: var(--cf-muted-foreground);
  transition: background-color 0.2s, color 0.2s;
}
.mp-ic.on {
  background: var(--cf-accent-bg);
  color: var(--cf-foreground);
}
.mp-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mp-composer {
  padding: 10px 12px 10px;
}
.mp-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 6px 6px 16px;
  border: 1px solid var(--cf-border);
  border-radius: 22px;
  background: var(--cf-surface);
}
.mp-text,
.mp-ph {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mp-ph {
  color: var(--cf-muted-foreground);
}
.mp-caret {
  display: inline-block;
  width: 1.5px;
  height: 1.05em;
  margin-left: 1px;
  vertical-align: -2px;
  background: var(--cf-accent);
  animation: mp-blink 1s steps(1) infinite;
}
@keyframes mp-blink {
  50% {
    opacity: 0;
  }
}
.mp-send {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: var(--cf-border);
  color: var(--cf-muted-foreground);
  transition: background-color 0.2s, color 0.2s;
}
.mp-send.on {
  background: var(--cf-foreground);
  color: var(--cf-background);
}
.mp-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--cf-muted-foreground);
}
.mp-scope {
  flex: none;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  transition: border-color 0.2s, color 0.2s, background-color 0.2s;
}
.mp-scope :deep(svg) {
  width: 12px;
  height: 12px;
}
.mp-scope.on {
  border-color: var(--cf-accent);
  color: var(--cf-accent);
}
.mp-note {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>

<style>
/*
 * Pieces every demo body draws with. Global on purpose: a scoped style would
 * have to be repeated in each of a dozen components.
 */
.mp-q {
  align-self: flex-end;
  max-width: 85%;
  padding: 8px 14px;
  border-radius: 18px;
  background: var(--cf-accent-bg);
}
.mp-a {
  max-width: 100%;
}
.mp-a b {
  font-weight: 600;
}
.mp-cite {
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin: 0 1px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 600;
  vertical-align: 1px;
  background: color-mix(in oklab, var(--cf-accent) 14%, transparent);
  color: var(--cf-accent);
}
.mp-muted {
  color: var(--cf-muted-foreground);
  font-size: 13px;
}
.mp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--cf-surface);
  font-size: 13px;
}
.mp-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--cf-border);
  font-size: 12px;
  background: var(--cf-background);
}
.mp-btns {
  display: flex;
  gap: 2px;
  color: var(--cf-muted-foreground);
}
.mp-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  transition: background-color 0.2s, color 0.2s, transform 0.15s;
}
.mp-btn.on {
  background: var(--cf-accent-bg);
  color: var(--cf-foreground);
  transform: scale(0.94);
}
.mp-fade-enter-active,
.mp-fade-leave-active {
  transition: opacity 0.3s ease, transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.mp-fade-enter-from,
.mp-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.mp-pop-enter-active,
.mp-pop-leave-active {
  transition: opacity 0.2s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.mp-pop-enter-from,
.mp-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(4px);
}
</style>
