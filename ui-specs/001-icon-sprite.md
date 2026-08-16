# 001 — The icon set as an SVG symbol sprite

## Problem

Two things at once.

1. **New chat is a `plus`.** A plus means "add" — a row, a file, a tag. Every
   product this panel sits beside (ChatGPT, Claude, Gemini) uses a **compose**
   mark for "start a new conversation", because the action is *write something
   new*, not *append to a list*.
2. **The glyphs are inlined at every mount.** `GLYPHS` is one source of truth,
   but each use re-emits the `<path>` data: the panel's `Icon` component builds
   paths per render, and the code-fence copy button — an HTML **string**, with no
   component instance — carries a second copy of the attribute list
   (`ICON_ATTRS`). Two renderings of one drawing is exactly the drift this file
   set out to prevent.

## Research

- **`<symbol>` + `<use>` is the answer to (2), and it is old and universal.**
  Same-document `<use href="#id">` is supported everywhere this package ships.
  `currentColor`, `stroke`, `stroke-width` and `fill` **inherit into the shadow
  tree from the referencing `<use>`**, not from where the symbol is defined —
  which is what makes one symbol able to render dim, promoted, filled and
  outlined without a second asset. This is `better-ui` principle 14, *One SVG,
  recolored per state*.
- **External sprite files (`<use href="/sprite.svg#id">`) are wrong here.** They
  need an asset the consumer must copy into `public/`, and this is an npm package
  dropped into someone else's docs site. The sprite is inline, in the document.
- **The sprite must be in the SSR output, not injected on mount.** VitePress
  renders `${teleports?.body || ''}` as the first thing inside `<body>`
  (verified in `vitepress/dist/node`), so a `<Teleport to="body">` is
  server-rendered and lands *before* the app markup. A sprite appended in
  `onMounted` would leave every icon blank until hydration.
- **`better-ui` 13** — 1.5px stroke beside regular text. Unchanged; the whole set
  is already 1.5 on a 16 grid.

## Decision

### The sprite

A new component, `DocPilotIcons.vue`, mounted from `docPilotSlots()` in
`layout-bottom` beside the panel. It teleports one 0×0 `<svg>` into `<body>`
holding a `<defs>` of `<symbol>` elements — `id="dp-i-<name>"`, each carrying its
**own** `viewBox`, which is how the one off-grid glyph (`sparkle`, on a 24 box)
stops being an exception the call site has to know about.

It is a component of its own rather than a branch inside `DocPilot.vue` because
the panel is `v-if`-ed on `open` and the sprite must outlive that, and because
"the icon set exists" is not a fact about the answer panel.

### Who uses it

| surface | how | why |
|---|---|---|
| panel (`Icon`) | `<use>` | ~9 glyphs, several per turn — the whole point |
| code-fence copy button | `<use>` ×2 | kills `ICON_ATTRS`'s duplicate attribute list |
| **nav trigger / FAB** | **stays inline** | it renders on pages where `DocPilotIcons` may not be mounted — the components are individually exported and a consumer may compose only the trigger. One glyph, above the fold, with no dependency, is the right trade. |

`GLYPHS` remains the single source of truth for all three.

### The compose glyph

Replaces `plus`, which becomes unused and is deleted — a dead glyph in a set of
ten is a glyph someone reaches for by accident.

```
compose: [
  'M13.5 8.6V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3.4',
  'M11.2 2.4a1.7 1.7 0 0 1 2.4 2.4L8.5 9.9l-3 .6.6-3z',
]
```

Two paths for the reason `history` and `sparkle` are two: one stroke cannot cross
itself and stay one line. The box opens at its top-right corner so the pencil
enters rather than overlaps it — the standard reading of this mark.

## Contract

- `symbolId(name)` → `dp-i-<name>`. Exported, so the string-built button and the
  component agree by construction rather than by a matching literal.
- `SYMBOLS` is derived from `GLYPHS` + `GLYPH_BOX`. **Adding a glyph is one line
  in `GLYPHS`**; nothing else has to be touched for it to be in the sprite.
- The referencing `<svg>` carries the geometry (`viewBox`, `width`, `height`) and
  the paint (`stroke`, `stroke-width`, `fill`, `aria-hidden`, `focusable`). The
  symbol carries shape only.
- `filled` stays a prop on the referencing `<svg>` — the thumbs' active state.

## Accessibility

No change. Every icon is `aria-hidden="true"` and `focusable="false"`; the
control around it is named by `aria-label`. The sprite itself is `aria-hidden`,
0×0 and `overflow: hidden` — never `display: none`, which historically breaks
`<use>` resolution.

## Checks

- `npm run check` — untouched by this spec: no border, no font-size, no
  animation is added.
- The sprite's container needs one rule in `core.scss` (`position: absolute;
  width: 0; height: 0; overflow: hidden`), which no rule counts.
