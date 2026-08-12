/**
 * The icon set — UI-SPEC 63.
 *
 * Six glyph families, 16×16, stroke 1.5, currentColor. No emoji anywhere.
 *
 * It lives here rather than inside AskAi.vue because the fence renderer emits a
 * copy button as an HTML STRING — that button has no component instance, so it
 * cannot call the Icon component and would otherwise carry a second, drifting
 * copy of two path values.
 *
 * A value may be an array of paths. `sparkle` is the only one, and it is also
 * the only glyph off the 16 grid — it is drawn at the size and on the box the
 * nav trigger already used, so the panel and the control that opens it carry
 * one mark rather than two drawings of it. GLYPH_BOX carries that exception.
 */
export const GLYPHS = {
  plus: 'M8 3v10M3 8h10',
  x: 'M4 4l8 8M12 4l-8 8',
  arrowUp: 'M8 13V4M4 8l4-4 4 4',
  square: 'M5 5h6v6H5z',
  copy: 'M6 6h7v7H6zM3 10V3h7',
  check: 'M3 8.5l3.5 3.5L13 5',
  thumbUp: 'M5 14V7l3.5-4 .8.6-.8 3.4H13l-1.4 7H5z',
  thumbDown: 'M5 2v7l3.5 4 .8-.6-.8-3.4H13l-1.4-7H5z',
  sparkle: [
    'M12 3.5 13.6 8.4a3 3 0 0 0 1.9 1.9l4.9 1.6-4.9 1.6a3 3 0 0 0-1.9 1.9L12 20.5l-1.6-4.9a3 3 0 0 0-1.9-1.9L3.6 12l4.9-1.6a3 3 0 0 0 1.9-1.9z',
    'M19 3v3M20.5 4.5h-3M5 17v2M6 18H4',
  ],
}

/** Per-glyph geometry, for the ones that are not 16×16 on a 16 box. */
export const GLYPH_BOX = {
  sparkle: { box: '0 0 24 24', size: 20 },
}

/** The Icon component's attributes, as a string, for the string-built button. */
export const ICON_ATTRS =
  'viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false"'
