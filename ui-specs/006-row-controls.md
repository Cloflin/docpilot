# 006 — Controls inside a row that has a hover state

> **Half superseded by [000](000-design-system.md).** *§The row yields to the
> control inside it* is **withdrawn**: its `:has()` rule and the hover underline
> it suppressed are both deleted. The problem it names below was real and is now
> solved a layer down — 000's two-level surface gives a row's hover
> (`--dp-surface-2`) and a control's hover (`--dp-wash`) different values, so a
> button inside a hovered row separates by compositing and there is nothing to
> yield.
>
> *§The trash glyph* stands unchanged.

## Problem

Two defects in the same three pixels — the delete control on a conversation row.

1. **It is an `×`.** In this panel `×` already means *close this*: it is on the
   header, on the scope picker and on the conversation dock. On a row it means
   *destroy this permanently*, which is the one action here with no undo. One
   glyph, two meanings, and the destructive one borrowed the dismissive one's
   mark.
2. **Hovering it is invisible.** `.docpilot__source` takes `--dp-fill` on hover.
   `.docpilot__icon-btn` takes `--dp-fill` on hover. So pointing at the delete
   button paints the same colour over the same colour: the row lights up and the
   button inside it does not separate from it at all. Nothing on screen says
   which of the two actions — *open* or *delete* — a click is about to take.

The second one is the real bug. A destructive control that gives no feedback
about being the thing under the cursor, inside a row whose own click does
something else entirely, is a mis-click waiting to happen.

## Research

- **`:has()` is the right tool and it is safe.** `modern-web-guidance`'s
  *child-state-based-styling* guide confirms: **Baseline widely available since
  2023-12-19** — Safari 15.4, Chrome/Edge 105, Firefox 121. No fallback is
  required. Its performance note applies and is followed: the selector is
  anchored on the row, never on a high-level ancestor.
- **The pattern is standard.** Gmail, Linear, GitHub and every file manager do
  the same thing: the row's own hover yields the moment a control inside it is
  the target. The alternative — nesting two different fills — needs a second
  surface colour whose only job is to be distinguishable from the first.
- **`better-ui` 14** — one `currentColor` SVG, states from CSS. The trash mark
  needs no destructive colour: this panel's one accent is spoken for
  (rule 3), and the two-step confirmation on *Delete all* is what carries weight
  where weight is needed. Red here would be the only hue in the component.
- **`better-accessibility`** — the accessible name is unchanged and already
  states the target: `history.delete` renders "Delete {title}". The glyph swap
  changes nothing a screen reader hears.

## Decision

### The trash glyph

A new entry in `GLYPHS`, so it is in the sprite by derivation (ui-specs/001) —
16×16, stroke 1.5, three paths for the reason the other multi-path glyphs have
three: one stroke cannot cross itself and stay one line.

```
trash: [
  'M2.5 4.5h11M6 4.5V3.4a0.9 0.9 0 0 1 0.9-0.9h2.2a0.9 0.9 0 0 1 0.9 0.9V4.5',
  'M12.5 4.5V12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 12V4.5',
  'M6.5 7v4M9.5 7v4',
]
```

Rim and handle · can · ribs. Used in exactly one place — the conversation row.
Everything that dismisses keeps its `×`, which is the point of the change:
**`×` closes, the bin deletes.**

### The row yields to the control inside it

```scss
.docpilot__source {
  &:hover,
  &:focus-within { background: var(--dp-fill); /* … */ }

  // last, so it beats both
  &:has(.docpilot__icon-btn:hover),
  &:has(.docpilot__icon-btn:focus-visible) {
    background: none;
    .docpilot__source-title { text-decoration: none; }
  }
}
```

Three things happen at once and they are one idea: the row's fill goes, the
title's hover underline goes, and the button's own fill is the only thing left
lit. What is under the cursor is what is highlighted.

The underline matters as much as the fill. It is the row's promise that clicking
opens the conversation, and it must not still be showing while the cursor is on
the control that deletes it.

Written on `.docpilot__source` rather than on `.docpilot__history-row`, because
the rule is about **a row that contains a control**, not about conversations.
Answer-source rows have no button today and are unaffected; the day one has one,
it behaves correctly without a second rule.

`:focus-visible` and not `:focus`: the row keeps its `:focus-within` fill for
keyboard arrival at its opener, and only yields when the ring is actually on the
button.

## Accessibility

- Names, roles and the Esc cascade are untouched.
- The keyboard path gains the same separation the pointer path does: tabbing from
  the row's opener to its delete button moves the highlight rather than
  compounding two.
- `forced-colors`: the fills are erased in that mode anyway and the focus ring is
  a system colour, so the distinction survives on the ring alone.
- No colour-only signalling is introduced — the change is a *removal* of a
  competing cue, plus a glyph that means what it does.

## Checks

- `npm run check` — no border, no font size, no animation added. Rule 2's count
  is unchanged: this rule removes a fill, it does not add one.
- `npm test` — the sprite's derivation test covers the new glyph by construction.
