<template>
  <button
    v-if="enabled"
    type="button"
    class="ask-ai-nav-trigger"
    :class="variant === 'screen' ? 'is-screen' : null"
    :title="variant === 'screen' ? undefined : `Ask AI (${hint})`"
    aria-label="Ask AI"
    aria-keyshortcuts="control+i meta+i"
    @click="toggle"
  >
    <!--
      Drawn in glyphs.js rather than pulled from the theme: `vpi-sparkles` and
      VPNavBarAskAiButton ship with VitePress 2, and this site is on 1.6.4.
      When the upgrade happens the icon and the slot both come from upstream.
      The paths live beside the drawer's own icon set because the drawer header
      carries the same mark — one drawing, two mounts.
    -->
    <svg
      v-if="variant !== 'screen'"
      class="ask-ai-nav-trigger__glyph"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path v-for="d in GLYPHS.sparkle" :key="d" :d="d" />
    </svg>
    <template v-else>
      <span class="ask-ai-nav-trigger__label">Ask AI</span>
      <span class="ask-ai-nav-trigger__hint">{{ hint }}</span>
    </template>
  </button>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useData } from 'vitepress'
import * as session from '../ask-ai/session.js'
import { GLYPHS } from '../ask-ai/glyphs.js'

defineProps({ variant: { type: String, default: 'nav' } })

const { theme } = useData()
const enabled = computed(() => theme.value?.askAI?.enabled !== false)

const mac = ref(false)

/**
 * The hotkey is Cmd/Ctrl+I, explicitly NOT Cmd+K: VitePress search owns that,
 * and taking it would break the control readers already use. It is the same
 * pair VitePress 2's own Ask AI button announces, so `aria-keyshortcuts` above
 * matches upstream verbatim.
 */
const hint = computed(() => (mac.value ? '⌘I' : 'Ctrl I'))

function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    session.toggle()
  }
}

onMounted(() => {
  mac.value = /mac/i.test(navigator.platform || navigator.userAgent)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const toggle = () => session.toggle()
</script>

<style lang="scss">
/**
 * Position, not decoration.
 *
 * VitePress 1.6.4 renders the navbar as
 *   [slot before] search · menu · translations · appearance · social · extra ·
 *   [slot after] · hamburger
 * and there is no slot between search and menu, which is where VitePress 2 puts
 * its own Ask AI button. The trigger therefore goes in `nav-bar-content-before`
 * — first in source order — and search is pulled ahead of it with one `order`
 * declaration. Ordering our element instead would mean ordering every element
 * after it, which is six selectors into someone else's component rather than
 * one. The `.menu + …` divider rules upstream draws are untouched: they look at
 * siblings after `.menu`, and this sits before it.
 */
.VPNavBar .search {
  order: -1;
}

/**
 * `.VPNavBarSearch` grows to fill the navbar, which is how upstream keeps the
 * search box at the left of the content area and everything else at the right.
 * Placed after a grown wrapper the trigger lands at the wrapper's far edge —
 * measured, 398px away from the box it is supposed to belong to. So the growing
 * moves onto the trigger: the wrapper shrinks to its box, the trigger sits 8px
 * after it, and one auto margin does the pushing the growth used to do.
 *
 * Only above the breakpoint. Below it nothing grows upstream either — search
 * and hamburger sit together at the right, and an auto margin there would drag
 * them apart.
 */
@media (min-width: 768px) {
  .VPNavBar .search {
    flex-grow: 0;
  }
  .ask-ai-nav-trigger:not(.is-screen) {
    margin-inline-end: auto;
  }
}

/**
 * The same object VPNavBarAskAiButton is in VitePress 2: a filled square in the
 * search box's own treatment, 8px to its right, so the two read as one control
 * rather than as a search box and an unrelated icon.
 *
 * Upstream sizes it by padding (11.5px around a 15px glyph = 38px). Here the
 * number is taken from the neighbour instead — 1.6.4's search button is
 * `height: 40px; background: var(--vp-c-bg-alt); border-radius: 8px` — because
 * a 38px button beside a 40px one is not "close enough", it is misaligned.
 */
.ask-ai-nav-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 40px;
  height: 40px;
  margin-inline-start: 8px;
  border: none;
  border-radius: 8px;
  background: var(--vp-c-bg-alt);
  font-family: var(--vp-font-family-base);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition:
    color 250ms ease,
    background-color 120ms linear;

  &:hover,
  &:focus-visible {
    color: var(--vp-c-brand-1);
  }
  &:focus-visible {
    outline: 2px solid var(--vp-c-text-1);
    outline-offset: 2px;
  }

  // Below the breakpoint the search box drops its fill and becomes a bare icon;
  // the trigger follows it rather than sitting there as the one filled chip in
  // a row of glyphs.
  @media (max-width: 767px) {
    width: 44px;
    height: 44px;
    margin-inline-start: 0;
    background: none;
  }

  // The mobile nav screen is a list of text rows, not a toolbar: no fill, no
  // square, full width, and the label carries the meaning.
  &.is-screen {
    width: 100%;
    height: 44px;
    margin-inline-start: 0;
    justify-content: flex-start;
    gap: 6px;
    padding: 0;
    background: none;
    font-size: 16px;
    font-weight: 500;
    color: var(--vp-c-text-1);

    &:hover,
    &:focus-visible {
      background: none;
      color: var(--vp-c-text-1);
    }
  }

  &__hint {
    font-size: 12px;
    color: var(--vp-c-text-2);
  }
}
</style>
