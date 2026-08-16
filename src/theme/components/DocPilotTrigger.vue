<template>
  <button
    v-if="visible"
    type="button"
    class="docpilot-nav-trigger"
    :class="[kind === 'nav' ? null : `is-${kind}`, kind === 'fab' && fabLabel ? 'has-label' : null]"
    :title="kind === 'screen' ? undefined : T('trigger.title', { hint })"
    :aria-label="ariaLabel"
    :aria-expanded="kind === 'fab' ? s.open : undefined"
    aria-keyshortcuts="control+i meta+i"
    @click="toggle"
  >
    <!--
      Drawn in glyphs.js rather than pulled from the theme: `vpi-sparkles` and
      VPNavBarAskAiButton ship with VitePress 2, and this site is on 1.6.4.
      When the upgrade happens the icon and the slot both come from upstream.
      The paths live beside the drawer's own icon set because the drawer header
      carries the same mark — one drawing, two mounts.

      INLINE, not a `<use>` into the sprite, and ui-specs/001 says why: this
      component is exported on its own and a consumer may compose only it, so
      its single glyph must not depend on `DocPilotIcons` being mounted.
    -->
    <svg
      v-if="showGlyph"
      class="docpilot-nav-trigger__glyph"
      viewBox="0 0 24 24"
      :width="glyphSize"
      :height="glyphSize"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path v-for="d in GLYPHS.sparkle" :key="d" :d="d" />
    </svg>
    <!-- The floating button's own words. A visible label IS the accessible
         name, which is why `aria-label` steps aside above when it is present:
         voice control can only address a control by what is written on it. -->
    <span v-if="kind === 'fab' && fabLabel" class="docpilot-nav-trigger__label">{{ fabLabel }}</span>
    <template v-if="kind === 'screen'">
      <span class="docpilot-nav-trigger__label">{{ T('trigger.label') }}</span>
      <span class="docpilot-nav-trigger__hint">{{ hint }}</span>
    </template>
  </button>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useData } from 'vitepress'
import * as session from '../docpilot/session.js'
import { bindHotkey, unbindHotkey } from '../docpilot/hotkey.js'
import { GLYPHS } from '../docpilot/glyphs.js'
import { resolveI18n, t as translate, normaliseLocale } from '../docpilot/i18n.js'
import { resolveUi } from '../docpilot/ui.js'

/**
 * One button, three placements — a variant rather than three components,
 * because all three share the i18n lookup, the `enabled` check and the hotkey
 * reference, and three copies of those is three places for them to drift.
 *
 *   nav    — beside the host's search box
 *   screen — a text row in the mobile nav menu
 *   fab    — floating, bottom right, the popup's own opener
 */
const props = defineProps({ variant: { type: String, default: 'nav' } })

const KINDS = ['nav', 'screen', 'fab']

const kind = computed(() => {
  if (KINDS.includes(props.variant)) return props.variant
  // Degrade rather than throw: this renders on every page of a docs build, and
  // a typo in a slot argument must not be able to take the site down.
  // eslint-disable-next-line no-console
  console.error(`[docpilot] DocPilotTrigger variant must be one of ${KINDS.join(', ')} — using "nav"`, props.variant)
  return 'nav'
})

const s = session.state
const { theme, lang } = useData()
const enabled = computed(() => theme.value?.docPilot?.enabled !== false)

// Read straight off themeConfig and resolved again here, for the same reason
// the i18n tree is: all three placements render before `configure()` has run.
// `resolveUi` is idempotent, so re-resolving what the build already resolved
// costs nothing and covers a hand-written themeConfig.
const ui = computed(() => resolveUi(theme.value?.docPilot))

/**
 * The nav-screen row follows the NAV trigger, not the FAB: in `fab` mode the
 * floating button is on screen at every width, and a second entry point in the
 * mobile menu is exactly what choosing one placement said not to have.
 */
const visible = computed(
  () => enabled.value && (kind.value === 'fab' ? ui.value.showFab : ui.value.showNavTrigger),
)

// The FAB stands alone on the page rather than beside a 40px search box, so it
// carries the mark two pixels larger. Same drawing, same stroke.
const glyphSize = computed(() => (kind.value === 'fab' ? 22 : 20))

/**
 * The floating button is made of two halves, either of which the project may
 * switch off — ui-specs/005. `resolveUi` has already settled the pair, including
 * the one combination with no rendering, so nothing here re-derives it.
 *
 * `fabLabel === true` means "the shipped words, in this page's language", which
 * is a lookup. A STRING is taken verbatim and is deliberately not looked up: an
 * author who typed the words has already chosen the language.
 */
const fabLabel = computed(() => {
  if (kind.value !== 'fab') return ''
  const value = ui.value.fabLabel
  if (value === false) return ''
  return value === true ? T('trigger.fabLabel') : value
})

const showGlyph = computed(() =>
  kind.value === 'screen' ? false : kind.value === 'fab' ? ui.value.fabIcon : true,
)

// Absent when the button carries visible text, so the two cannot disagree — an
// aria-label silently replaces the name a sighted reader is looking at, and a
// speech-input user who says the words on the button would then miss it.
const ariaLabel = computed(() => (fabLabel.value ? undefined : T('trigger.label')))

// Same reason as the CTA: this button is in the nav bar of every page, long
// before `configure()` has run, so the override comes from themeConfig direct.
const i18nTree = computed(() => resolveI18n(theme.value?.docPilot?.i18n))
const T = (path, vars) =>
  translate(i18nTree.value, normaliseLocale(lang.value, i18nTree.value), path, vars)

const mac = ref(false)

/** The shortcut itself lives in `hotkey.js`; this is only how it is written. */
const hint = computed(() => (mac.value ? '⌘I' : 'Ctrl I'))

// Whether THIS instance holds a reference, rather than re-reading `enabled` on
// unmount: a themeConfig that changed in between would otherwise release a
// reference this component never took, or keep one forever.
let bound = false

onMounted(() => {
  mac.value = /mac/i.test(navigator.platform || navigator.userAgent)
  // Not bound when the panel is off. Two instances of this component are
  // mounted on every page and the key used to work even with `enabled: false`,
  // when there was no trigger anywhere to press.
  if (!enabled.value) return
  bindHotkey(session.toggle)
  bound = true
})

onBeforeUnmount(() => {
  if (!bound) return
  unbindHotkey()
  bound = false
})

const toggle = () => session.toggle()
</script>

<!--
  No <style> block, deliberately. `.docpilot-nav-trigger` is styled in
  `src/theme/styles/core.scss` — the button is this package's own element, so
  its chrome is written against `--dp-*` like everything else — and where it
  SITS inside the VitePress navbar is stated in `src/theme/styles/vitepress.scss`
  next to the other foreign selectors. Keeping SCSS in a shipped `.vue` file
  would make `sass` a build requirement for every consumer.
-->
