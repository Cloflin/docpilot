<template>
  <!-- The class as an object bound whole, not `:class`: a `:class` that names
       nothing still writes `class=""`, and every other glyph carries none. -->
  <svg
    v-bind="name === 'check' ? { class: 'docpilot__glyph-check' } : null"
    :viewBox="glyph.box"
    :width="glyph.size"
    :height="glyph.size"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <use :href="`#${symbolId(name)}`" />
  </svg>
</template>

<script setup lang="ts">
/**
 * A reference into the sprite `Icons.vue` publishes — ui-specs/001.
 *
 * The shape lives in exactly one `<symbol>`; this element carries the geometry
 * and the paint. That split is what makes `filled` a prop rather than a second
 * drawing: `fill` is inherited into the symbol's shadow tree from HERE, not from
 * where the symbol was defined, so one thumb renders outlined at rest and solid
 * when pressed.
 *
 * One glyph is drawn on a 24 box at 20px — the nav trigger's sparkle, reused
 * here rather than redrawn. Everything else is the 16×16 default it always was,
 * and the `viewBox` is stated so the symbol maps 1:1 into it either way.
 *
 * The check is the one glyph that is an EVENT — copied, picked — and it carries
 * a class the stylesheet pops it in on: ui-specs/015. Every copy button swaps
 * its glyph by name on the same element, so the class arriving is what starts
 * the animation, and nothing here has to know which button it is.
 */
import { computed } from 'vue'
import { GLYPH_BOX, GLYPH_DEFAULTS, symbolId } from '../../docpilot/glyphs.js'

const props = defineProps<{ name: string; filled?: boolean }>()

const glyph = computed(() => ({ ...GLYPH_DEFAULTS, ...(GLYPH_BOX[props.name] || {}) }))
</script>
