---
description: The same conversation in three shapes on one page — a question bar at the bottom centre, a popup above a floating button, and a drawer that pushes the page aside.
---

# Panel shapes

The panel has three shapes, and the conversation inside is the same in each: the thread, the sources, the scope, the history. Only where it sits on the page changes. The mock-up plays them in order — the bar, the popup, then the drawer that pushes the page.

<Demo>
  <ShapesDemo />
  <template #code>

```ts
// 1 — a question bar at the bottom centre, the shipped shape
docPilot: { ui: { panel: 'bar' } }

// 2 — a popup above the floating button
docPilot: { ui: { trigger: 'fab', panel: 'popup' } }

// 3 — a drawer that pushes the page aside
docPilot: { ui: { panel: 'drawer', layout: 'push', side: 'end' } }
```

  </template>
</Demo>

## 1. Bar {#bar}

The question box is on every page, at the bottom centre. The reader starts typing, the bar widens, and a window with the conversation rises above it. The field stays in the bar; the window holds everything else — the header, the thread, the scope, the footnote.

```ts
ui: { panel: 'bar' }
```

The bar takes the place of the floating button, and `ui.side` does not apply to it, because it is centred. <kbd>Esc</kbd>, the close button or a press elsewhere on the page closes the window; the bar stays, with a button that brings the conversation back. With the floating button in the trigger list and `panel` left at `'auto'`, this is the shape the panel opens in.

## 2. Popup {#popup}

A floating button in the corner, and the conversation in a popup above it. The popup covers a corner of the page and nothing else; the button turns into a chevron while it is open.

```ts
ui: { trigger: 'fab', panel: 'popup' }
```

`ui.side` moves the button and the popup together — `'left'` puts both in the bottom-left corner. `ui.fabLabel` sets the words on the button, or `false` for the icon alone.

## 3. Push panel {#push}

A drawer the full height of the window, docked to an edge. With `layout: 'push'` the page narrows beside it instead of being covered, and moves back as the drawer leaves.

```ts
ui: { panel: 'drawer', layout: 'push', side: 'end' }    // the trailing edge
ui: { panel: 'drawer', layout: 'push', side: 'left' }   // a sidebar on the left
```

What moves is the host adapter's decision: on VitePress the whole layout narrows and the article re-centres; on Docusaurus `.main-wrapper` is padded. Any other host gets classes on `<html>` — `docpilot-push`, `docpilot-push-start`, `docpilot-push-end` — and styles its own wrapper from them. Without `layout: 'push'`, the drawer covers that side of the page.

## On a phone

Below 960 px all three shapes are the same full-screen sheet. The bar becomes a button at the bottom centre that opens it, and `layout: 'push'` does nothing, because there is no page beside the sheet to move.

More: [`ui.panel`](/reference/config#ui-panel), [`ui.layout`](/reference/config#ui-layout) and [`ui.side`](/reference/config#ui-side) in the reference, [Triggers and layout](/features/triggers) for the doors into the panel, and [Appearance](/guide/appearance) for the tokens that size each shape.
