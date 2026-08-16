<template>
  <!--
    ONE sprite per document, teleported to `<body>`.

    Teleported rather than rendered in place because VitePress writes
    `${teleports?.body || ''}` as the FIRST thing inside `<body>` — so the sprite
    is in the server-rendered HTML and lands ahead of everything that references
    it. A sprite appended in `onMounted` would leave every icon blank until
    hydration, on every page load.

    0×0 with `overflow: hidden`, never `display: none`: a hidden sprite is a
    sprite whose symbols some engines decline to resolve.
  -->
  <Teleport to="body">
    <svg class="docpilot__sprite" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <symbol v-for="sym in SYMBOLS" :id="sym.id" :key="sym.id" :viewBox="sym.box">
          <path v-for="d in sym.paths" :key="d" :d="d" />
        </symbol>
      </defs>
    </svg>
  </Teleport>
</template>

<script setup>
import { SYMBOLS } from '../docpilot/glyphs.js'

/**
 * The icon set, as `<symbol>` definitions — ui-specs/001.
 *
 * A component of its own rather than a branch inside `DocPilot.vue` for two
 * reasons. The panel is `v-if`-ed on `open` and the sprite has to outlive that;
 * and "the icon set exists" is not a fact about the answer panel, so it should
 * not be reachable only through it.
 *
 * The symbols carry SHAPE ONLY. Every paint attribute — `stroke`, `fill`,
 * `stroke-width`, and `currentColor` through them — is inherited from the
 * `<use>` element that references the symbol, not from where it was defined.
 * That inheritance direction is the whole reason a sprite works here: one
 * drawing renders dim in a footnote, promoted on hover and filled as a pressed
 * thumb, with no second asset and no per-state class.
 *
 * MOUNTED ONCE, from `docPilotSlots()`. Two instances would publish two sets of
 * the same ids, and `<use>` would resolve against whichever parsed first.
 *
 * The nav trigger and the floating button deliberately do NOT use it: they are
 * individually exported and a consumer may compose only those, so their single
 * glyph stays inline. `GLYPHS` is the source of truth for both routes.
 */
</script>

<!--
  No <style> block, deliberately, on the same terms as the other three
  components: `.docpilot__sprite` is styled in `src/theme/styles/core.scss`, so
  a consumer never needs `sass` to build a `.vue` file out of this package.
-->
