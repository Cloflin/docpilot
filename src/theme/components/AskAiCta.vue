<template>
  <p v-if="enabled" class="ask-ai-cta">
    <button type="button" @click="open">Didn't find it? Ask AI</button>
  </p>
</template>

<script setup>
/**
 * The end-of-article entry point — UI-SPEC 14.
 *
 * Mounted in the `doc-footer-before` slot, which lives only inside VPDoc. Pages
 * generated with `layout: page` (every docs/reference/*.md) render through
 * VPPage and the home page renders the home layout, so neither mounts the slot:
 * the CTA appears on exactly the guides and the Extensions SDK pages with no
 * route conditional anywhere in this component.
 *
 * It opens the drawer with an empty composer. It does NOT prefill, does not
 * submit, and does not scope to the current page: the copy says the reader did
 * not find it *on this page*, so scoping to this page is the opposite of what
 * the sentence means.
 */
import { computed } from 'vue'
import { useData } from 'vitepress'
import * as session from '../ask-ai/session.js'

const { theme } = useData()
const enabled = computed(() => theme.value?.askAI?.enabled !== false)
const open = () => session.open()
</script>

<style lang="scss">
.ask-ai-cta {
  margin-block-start: 32px;

  button {
    appearance: none;
    background: none;
    border: none;
    border-radius: 0;
    padding-block: 8px;
    font-family: var(--vp-font-family-base);
    font-size: 13px;
    line-height: 1.5;
    color: var(--vp-c-text-1);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--vp-c-text-2);
    text-decoration-thickness: from-font;
    text-underline-offset: 3px;

    &:hover,
    &:focus-visible {
      text-decoration-color: currentColor;
    }
    &:focus-visible {
      outline: 2px solid var(--vp-c-text-1);
      outline-offset: 2px;
    }
  }
}
</style>
