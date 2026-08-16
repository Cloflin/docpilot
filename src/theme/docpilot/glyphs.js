/**
 * The icon set — ui-specs/001.
 *
 * Fifteen glyphs, 16×16, stroke 1.5, currentColor. No emoji anywhere.
 *
 * It lives here rather than inside DocPilot.vue because two consumers have no
 * component instance to reach a component from: the fence renderer emits a copy
 * button as an HTML STRING, and `DocPilotIcons.vue` builds the sprite from this
 * table as data.
 *
 * A value may be an array of paths. Four are — `history`, `sparkle`, `compose`
 * and `pencil` — and always for the same reason: one stroke cannot cross itself
 * and stay one line.
 *
 * `sparkle` is the only glyph off the 16 grid. It is drawn at the size and on
 * the box the nav trigger already used, so the panel and the control that opens
 * it carry one mark rather than two drawings of it. GLYPH_BOX carries that
 * exception, and the sprite hands it to the `<symbol>` so no call site has to
 * know about it.
 */
export const GLYPHS = {
  // Start a new conversation. A compose mark, not a plus: the action is "write
  // something new", not "append a row" — which is what every product this panel
  // sits beside means by the same button. The box opens at its top-right corner
  // so the pencil enters it rather than crossing it.
  compose: [
    'M13.5 8.6V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3.4',
    'M11.2 2.4a1.7 1.7 0 0 1 2.4 2.4L8.5 9.9l-3 .6.6-3z',
  ],
  // Edit the question above. A pencil ON ITS OWN, where New chat is a pencil
  // ENTERING a box: one verb, and what tells the two apart is what it is aimed
  // at — a blank sheet, or words already written. Body with its nib · the
  // ferrule, two paths for the reason `compose` has two.
  pencil: ['M10.6 2.2a1.7 1.7 0 0 1 2.4 2.4L5.1 12.5l-3.2.8.8-3.2z', 'M4.4 8.4 6.8 10.8'],
  x: 'M4 4l8 8M12 4l-8 8',
  // The passage a question is about — ui-specs/007. A reply mark: the line the
  // reader came down from, turning into the text they pointed at. Two paths,
  // for the reason `compose` has two. It is not a quotation mark: this chip
  // already carries the quoted words, and a pair of commas beside them would be
  // punctuation drawn twice.
  quote: ['M4 3v6.6A1.4 1.4 0 0 0 5.4 11H12', 'M9.5 8.5 12 11l-2.5 2.5'],
  // Destroy, where `x` means dismiss — ui-specs/006. The panel had one mark for
  // both, and the one with no undo was the one borrowing. Rim and handle · can ·
  // ribs, three paths for the reason the others have more than one.
  trash: [
    'M2.5 4.5h11M6 4.5V3.4a0.9 0.9 0 0 1 0.9-0.9h2.2a0.9 0.9 0 0 1 0.9 0.9V4.5',
    'M12.5 4.5V12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 12V4.5',
    'M6.5 7v4M9.5 7v4',
  ],
  arrowUp: 'M8 13V4M4 8l4-4 4 4',
  // Back to the newest answer. The same chevron `arrowUp` carries, pointing the
  // other way and without the shaft: one mark for "the direction the thread
  // runs", and the button it sits in is already the whole affordance.
  chevronDown: 'M4 6 8 10 12 6',
  square: 'M5 5h6v6H5z',
  copy: 'M6 6h7v7H6zM3 10V3h7',
  check: 'M3 8.5l3.5 3.5L13 5',
  thumbUp: 'M5 14V7l3.5-4 .8.6-.8 3.4H13l-1.4 7H5z',
  thumbDown: 'M5 2v7l3.5 4 .8-.6-.8-3.4H13l-1.4-7H5z',
  // Past conversations: a clock face with its hands, behind the counter-
  // clockwise arc that says "back".
  history: ['M8 5v3.2l2.4 1.4', 'M3.2 7.6V4.4M3.2 7.6h3.2M3.6 6.6A5.3 5.3 0 1 1 3 9.3'],
  // Ask the same question again. Deliberately `history`'s arc MIRRORED rather
  // than a second drawing: one shape says "around again" in this package, and
  // which way it turns is the whole difference between going back to something
  // and running it forward.
  retry: 'M12.8 7.6V4.4M12.8 7.6h-3.2M12.4 6.6A5.3 5.3 0 1 0 13 9.3',
  sparkle: [
    'M12 3.5 13.6 8.4a3 3 0 0 0 1.9 1.9l4.9 1.6-4.9 1.6a3 3 0 0 0-1.9 1.9L12 20.5l-1.6-4.9a3 3 0 0 0-1.9-1.9L3.6 12l4.9-1.6a3 3 0 0 0 1.9-1.9z',
    'M19 3v3M20.5 4.5h-3M5 17v2M6 18H4',
  ],
}

/** Per-glyph geometry, for the ones that are not 16×16 on a 16 box. */
export const GLYPH_BOX = {
  sparkle: { box: '0 0 24 24', size: 20 },
}

/** The default, stated once so the sprite and the components cannot disagree. */
export const GLYPH_DEFAULTS = { box: '0 0 16 16', size: 16 }

/**
 * The id a `<symbol>` is published under, and the only place that string is
 * built. `DocPilotIcons.vue` defines them; `DocPilot.vue` and the string-built
 * copy button reference them — three call sites that would otherwise agree by
 * matching literals.
 */
export const symbolId = (name) => `dp-i-${name}`

/**
 * The sprite, as data.
 *
 * Derived, deliberately: adding a glyph is ONE line in `GLYPHS`, and it is in
 * the sprite. Each symbol carries its own `viewBox`, which is what lets the one
 * off-grid drawing stop being an exception anybody has to remember.
 */
export const SYMBOLS = Object.entries(GLYPHS).map(([name, d]) => ({
  name,
  id: symbolId(name),
  box: (GLYPH_BOX[name] || GLYPH_DEFAULTS).box,
  paths: [d].flat(),
}))

/**
 * The attributes carried by an `<svg>` that REFERENCES a symbol — geometry and
 * paint. The symbol itself carries shape and nothing else, which is how one
 * drawing renders dim, promoted, filled and outlined with no second asset.
 *
 * A string, because its one consumer is the copy button the fence renderer
 * builds as HTML.
 */
export const ICON_ATTRS =
  `viewBox="${GLYPH_DEFAULTS.box}" width="${GLYPH_DEFAULTS.size}" height="${GLYPH_DEFAULTS.size}" ` +
  'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false"'
