<template>
  <p v-if="enabled" class="docpilot-cta">
    <button type="button" @click="open">{{ T('cta.label') }}</button>
  </p>
</template>

<script setup lang="ts">
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
import * as session from '../docpilot/session.js'
import { useHost } from '../docpilot/host.js'
import { resolveI18n, t as translate, normaliseLocale } from '../docpilot/i18n.js'

const { theme, lang } = useHost()
const enabled = computed(() => theme.value?.docPilot?.enabled !== false)
const open = () => session.open()

// Mounted in every article footer, and it renders before the drawer has ever
// been opened — so it reads the override straight off themeConfig rather than
// off the session store, which `configure()` has not filled in yet.
const i18nTree = computed(() => resolveI18n(theme.value?.docPilot?.i18n))
const T = (path) => translate(i18nTree.value, normaliseLocale(lang.value, i18nTree.value), path)
</script>

<!--
  No <style> block, deliberately. `.docpilot-cta` is styled in
  `src/theme/styles/core.scss` with the rest of this package's own selectors:
  a `.vue` file carrying SCSS makes `sass` a build requirement for anyone who
  imports the component, and the stylesheet ships compiled.
-->
