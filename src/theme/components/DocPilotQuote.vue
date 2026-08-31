<template>
  <!--
    The same popover as the panel's, pointed at the host's own article —
    ui-specs/009, `quote.fromDocs`.

    Teleported to `<body>` rather than left where this component is mounted:
    `layout-bottom` is inside the host's Layout, and a fixed box whose ancestor
    has a transform, a filter or a containment is a fixed box positioned against
    that ancestor instead of the viewport. The panel's own popover is teleported
    for the same reason and does not say so, because it has always been inside a
    Teleport for another one.
  -->
  <Teleport to="body">
    <div
      v-if="askOpen"
      ref="askEl"
      class="docpilot__ask"
      :class="{ 'is-below': askBelow }"
      :popover="canPopover ? 'manual' : null"
      :style="askStyle"
      @keydown.esc.stop.prevent="closeAsk"
    >
      <button type="button" class="docpilot__text-btn docpilot__ask-btn" @click="take">
        <!--
          INLINE, not a `<use>` into the sprite — ui-specs/001's rule for a
          component that may be composed on its own. `DocPilotIcons` ships in the
          same slot as this today, but a consumer who mounts only some of these
          components must not get a button with a hole where its glyph was. The
          nav trigger inlines its one glyph for the same reason.
        -->
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path v-for="d in GLYPHS.quote" :key="d" :d="d" />
        </svg>
        {{ T('quote.ask') }}
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * Quoting a passage from the DOCUMENTATION — ui-specs/009, `quote.fromDocs`.
 *
 * [007](../../../ui-specs/007-quote-a-passage.md) gave the panel a selection
 * popover over its own answers. The gesture a documentation reader actually has
 * is the other one — select the paragraph that confused you, in the article —
 * and until this it led nowhere: open the panel, retype the question, and lose
 * the exact text the question was about.
 *
 * OFF BY DEFAULT, and the reason is the reader who is not asking anything. A
 * command selected in order to be copied must not meet a button every time, so
 * this paints on somebody else's prose only when the project said to.
 *
 * NOT A CHATGPT PATTERN, and 009's research says so rather than borrowing the
 * authority: ChatGPT quotes its own responses because it has no host article to
 * quote. The nearest real precedent is a browser-integrated assistant.
 *
 * THE MECHANISM IS SHARED. Everything about `selectionchange`, the pointer
 * suppression, the three ways a drag can end and why the passage is captured at
 * open rather than at press lives in `selection.js`, one copy, because a list of
 * platform failures that exists twice is a list one of whose entries comes back.
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import * as session from '../docpilot/session.js'
import { useHost, hostConfig } from '../docpilot/host.js'
import { createSelectionAsk } from '../docpilot/selection.js'
import { clampQuote } from '../docpilot/prompt.js'
import { GLYPHS } from '../docpilot/glyphs.js'
import { resolveI18n, t as translate, normaliseLocale } from '../docpilot/i18n.js'
import { resolveQuote } from '../docpilot/switches.js'

const { theme, lang } = useHost()

// Read straight off themeConfig, not off the store: this mounts on every page
// and renders long before `session.configure` has run — the same terms the nav
// trigger and the article CTA are on, and `resolveQuote` is idempotent.
const enabled = computed(
  () =>
    theme.value?.docPilot?.enabled !== false &&
    resolveQuote(theme.value?.docPilot).fromDocs,
)

const i18nTree = computed(() => resolveI18n(theme.value?.docPilot?.i18n))
const T = (path) =>
  translate(i18nTree.value, normaliseLocale(lang.value, i18nTree.value), path)

const askEl = ref(null)
const coarse = ref(false)
let coarseMql = null

/**
 * The host's article, and nothing else on the page.
 *
 * `.vp-doc` is VitePress's content wrapper and `main` is the fallback for a
 * theme that does not use it. Neither can ever contain the panel — it teleports
 * to `<body>` — so the two mounts cannot both claim one selection: a passage in
 * an answer resolves to null here, and a passage in the article resolves to null
 * there.
 *
 * The nav, the sidebar and the footer are deliberately outside it. "Ask AI"
 * over a sidebar link is a control offering to ask a question about a menu.
 */
function articleOf(range) {
  const node = range.commonAncestorContainer
  const el = node.nodeType === 1 ? node : node.parentElement
  // Off the host binding, not off the session store: this component mounts on
  // every page and a selection can be made before `configure()` has ever run.
  return el?.closest?.(hostConfig(theme.value?.docPilot).article) || null
}

const ask = createSelectionAsk({
  el: () => askEl.value,
  enabled: () => enabled.value,
  containerOf: articleOf,
  /**
   * The whole viewport, where the panel's instance uses its thread's box. There
   * is no smaller box to clamp to here — the article IS the page — and a rect
   * built from `documentElement` is the same thing without the `visualViewport`
   * question a zoomed mobile page would raise.
   */
  boxOf: () =>
    typeof window === 'undefined'
      ? null
      : { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth },
  clamp: clampQuote,
  coarse: () => coarse.value,
})

const askOpen = ask.open
const askStyle = ask.style
const askBelow = ask.below
const canPopover = ask.canPopover
const closeAsk = ask.close

let unbind = null

onMounted(() => {
  coarseMql = window.matchMedia('(pointer: coarse)')
  const sync = () => (coarse.value = coarseMql.matches)
  sync()
  coarseMql.addEventListener('change', sync)
  unbind = ask.bind((accepted) => {
    if (accepted) nextTick(() => ask.present())
  })
  onBeforeUnmount(() => coarseMql?.removeEventListener('change', sync))
  // The article scrolls under a fixed popover, so the passage moves out from
  // under it. Passive, and `reposition` is a no-op while it is closed, which is
  // nearly always.
  window.addEventListener('scroll', ask.reposition, { passive: true })
})

onBeforeUnmount(() => {
  unbind?.()
  unbind = null
  window.removeEventListener('scroll', ask.reposition)
})

/**
 * Take the passage and open the panel with it attached.
 *
 * The question is NOT asked. The reader picked a paragraph, not a question, and
 * submitting one on their behalf would spend a turn on words nobody wrote.
 * `pendingQuote` is drained by the panel into its composer chip, which is the
 * same place a passage from an answer lands.
 */
function take() {
  const text = ask.take()
  if (!text) return
  session.state.pendingQuote = text
  session.open()
}
</script>

<!--
  No <style> block — `.docpilot__ask` is styled in core.scss with the rest of
  this package's own selectors, and it is the SAME popover recipe the panel's
  instance uses. Keeping SCSS in a shipped .vue file would make `sass` a build
  requirement for every consumer.
-->
