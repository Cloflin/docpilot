# 005 — The floating button carries a label

> **Stands; two measurements moved** — see [000](000-design-system.md).
> `padding-inline` is `16px`, not `18px`, which was off the spacing scale; and the
> button is now a floating card: `--dp-surface` with a ring and a shadow, where it
> used to be `--dp-chip` with a shadow alone. The inline-axis-only argument, the
> block size the popup measures, and the −4px optical pull on the glyph are
> unchanged.

## Problem

In `ui: { trigger: 'fab' }` the only entry point to the panel is a 48px circle
with a sparkle in it, bottom right. A sparkle means "AI" to people who already
know this pattern and means nothing to everyone else — and unlike the navbar
trigger, it has no search box beside it to borrow context from.

Every hosted docs-AI widget solves this the same way: **icon + a short label**.

The label also has to be the author's, not ours. A German docs site wants
"KI fragen"; a site whose product *is* an assistant does not want the word AI in
its corner at all; a site with a strict brand mark wants the label and not the
sparkle.

## Research

- Intercom, Crisp, Algolia Ask AI, Mintlify and Kapa all ship the same object: a
  rounded **pill** in the corner, icon on the leading edge, one or two words after
  it, full-round corners, the same elevation the round button had.
- The pill grows on the inline axis only. Height is unchanged, which matters
  here: `--dp-fab-size` is an input to the popup's own geometry
  (`inset-block-end: calc(var(--dp-popup-inset) + var(--dp-fab-size) + 12px)`),
  so a taller button would move the popup and a wider one does not.
- **`better-accessibility`** — a control with a visible label must have an
  accessible name that *contains* that label, or voice control cannot address it.
  With the label visible the button is named by its own text; `aria-label` is only
  needed for the icon-only case.
- **`better-writing`** — sentence case, two words, no trailing punctuation.
  "Ask AI" is the default.

## Decision

Two new keys under `ui`, resolved by `resolveUi` alongside `trigger` and `panel`
so all three reach every consumer already settled:

```js
ui: {
  trigger: 'fab',
  fabLabel: true,   // true → the i18n string · a string → that string · false → no label
  fabIcon: true,    // false → no sparkle
}
```

| `fabLabel` | `fabIcon` | result |
|---|---|---|
| `true` (default) | `true` (default) | sparkle + `trigger.fabLabel`, default **Ask AI** |
| `'Спросить ИИ'` | `true` | sparkle + that exact string, untranslated |
| `true` | `false` | text only |
| `false` | `true` | the 48px circle that ships today |
| `false` | `false` | **invalid** — reported, and `fabIcon` is forced back on |

The last row is the only guard: a button with no icon and no text is an invisible
control, and the failure mode of a cosmetic setting must never be "the panel
cannot be opened". It follows the same discipline the enums already use — report
on stdout during the build, fall back, never throw.

`fabLabel: true` resolves through i18n (`trigger.fabLabel`), so a multilingual
site gets it per locale from the tree it already has. A **string** is taken
verbatim and is not looked up: an author who typed the words has already chosen
the language.

The keys are `fab`-prefixed because they describe that placement only. The navbar
trigger has always been icon-only beside the search box, and the nav-screen row
has always been text — neither is affected.

### Shape

```scss
&.is-fab {
  block-size: var(--dp-fab-size);   // height is fixed — the popup measures it
  inline-size: var(--dp-fab-size);  // a circle when there is no label
  border-radius: 999px;
  gap: 8px;

  &.has-label {
    inline-size: auto;
    padding-inline: 18px;            // 8px less on the icon side when there is one
    font-size: 14px;
    font-weight: 500;
  }
}
```

Full-round rather than a radius tier: `better-ui` 1 — at 48px tall the pill's own
corners are the outer radius of nothing, and a chat launcher is round everywhere
this pattern appears.

## Accessibility

- With a label, the visible text **is** the accessible name; the `aria-label`
  that used to supply it is dropped for that case so the two cannot disagree.
- Icon-only keeps `aria-label` from `trigger.label`.
- `aria-expanded` and `aria-keyshortcuts` are unchanged.
- The icon is `aria-hidden` in both cases.
- Coarse pointers keep `--dp-fab-size-coarse` (56px) as the block size, so the
  target floor is met with or without a label.

## Ripple

`resolveUi`'s return shape grows two keys, and four places assert or restate it:

- `src/config.js` `DEFAULTS.ui` and the build's `[docpilot] ui` line;
- `session.js`'s hardcoded pre-`configure` default;
- `test/docpilot.test.js`, which compares the resolved object exactly;
- `docs/reference/config.md` and `docs/guide/appearance.md`.

Idempotency is preserved by construction: every resolved value (`true`, `false`,
a string) is itself legal input.

## Checks

- `npm run check` — rule 5: the label is 14px, already an allowed size.
- `npm test` — `resolveUi` idempotency and the `settings → build → browser` hop.
