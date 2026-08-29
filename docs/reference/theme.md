---
title: Theme tokens
---

# Theme tokens

Every value the panel paints, sizes or times goes through one custom property on
`:root`. This page is the complete list — 33 of them — with the value the core
stylesheet declares when there is no host.

Nothing here is a class you have to target and no component is patched: override
a token after the stylesheet and every element that reads it moves together.
[Appearance](/guide/appearance) is the same set with the reasoning, the three
surface levels and the per-host mapping tables.

## The whole set

Copy this, delete what you are not changing, load it **after** the package's CSS.

```css
:root {
  /* ── Surfaces — three levels, and the level is the rule ─────────────────── */

  /* 0 — the panel itself, and anything that IS a surface: the composer, the
     code copy button's occluder, the floating button. */
  --dp-surface: #ffffff;

  /* 1 — an OBJECT's own paint: the question bubble, a suggestion row, a
     toggle's track, inline code — and a ROW's hover. */
  --dp-surface-2: rgba(101, 117, 133, 0.12);

  /* 2 — a pointer on a CONTROL, composited on top of whatever it sits on, so a
     button inside a hovered row separates from it with no rule written for the
     case. DERIVED from --dp-text, deliberately: it follows the host's theme and
     your override of --dp-text without a second declaration, and it must never
     be given a dark variant. */
  --dp-wash: color-mix(in srgb, var(--dp-text, #0d0d0d) 12%, transparent);

  /* ── Line — one hairline, one colour source ─────────────────────────────── */

  /* Every border in the package is `1px solid` from this: the drawer's edge,
     the popup, the selection popover, the header, the conversation dock, the
     scope picker, the composer, the feedback textarea, the code card, the FAB. */
  --dp-line: rgba(101, 117, 133, 0.24);

  /* ── Text — two readable levels, no third ───────────────────────────────── */

  --dp-text: #1f2328;      /* the answer, the question, titles, labels */
  --dp-text-dim: #5c6672;  /* meta: timestamps, source lines, the footnote row */
  --dp-on-text: #ffffff;   /* text ON --dp-text — the armed send button, a toggle that is on */

  /* ── Focus — a ring, not a hue: it has to survive any host palette ──────── */

  /* The focus ring is `2px solid var(--dp-focus)` at 2px offset, on every
     control. Give it something with contrast against --dp-surface, not a brand
     tint that happens to look nice at rest. */
  --dp-focus: #1f2328;

  /* ── The single accent ──────────────────────────────────────────────────── */

  /* Declared once and used once — the cited-source highlight. Alpha, so one
     value reads on a light panel and a dark one. */
  --dp-accent-soft: rgba(100, 108, 255, 0.18);

  /* ── Surfaces that sit outside the panel ────────────────────────────────── */

  /* The navbar trigger's fill. It has to match whatever the host puts next to
     it — usually the search box — which is a different job from any level
     above, and why it is not --dp-surface-2. */
  --dp-chip: rgba(101, 117, 133, 0.08);

  /* The code block's surface inside an answer. On a docs site, set it to the
     site's own code surface. */
  --dp-code-bg: rgba(101, 117, 133, 0.08);

  /* Worn by the three things that float: the popup, the selection popover and
     the floating button. Each also carries a hairline, because a shadow alone
     is invisible on a dark host and erased outright by `forced-colors`. */
  --dp-shadow:
    0 12px 32px rgba(0, 0, 0, 0.16),
    0 2px 8px rgba(0, 0, 0, 0.12);

  /* Behind the full-screen sheet below 960px. */
  --dp-scrim: rgba(0, 0, 0, 0.6);

  /* ── Type — the host's face, not one of ours ────────────────────────────── */

  /* `inherit` IS the value. The panel is mounted into <body>, so it wears the
     page's own font with nothing configured. Nothing nested may ask for this
     token: `inherit` resolves against the element that uses it, so
     var(--dp-font) inside a monospaced block returns the monospace. */
  --dp-font: inherit;

  /* A real stack, not `inherit`: a page has no monospace face for the panel to
     borrow, and `inherit` here would set code in the body face. */
  --dp-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;

  /* ── Structure ─────────────────────────────────────────────────────────── */

  /* Where the drawer starts. Zero is correct with no fixed header above it; a
     host with one declares its height. */
  --dp-top: 0px;

  /* The drawer's and the popup's width — deliberately the same value. */
  --dp-width: clamp(360px, 30vw, 460px);

  /* The panel's inline padding. */
  --dp-gutter: 20px;

  /* The floating button's BLOCK size, and its block size on a pointer-less
     device — the 44px minimum target with room around the glyph. With a label
     the button grows on the inline axis only, because --dp-fab-size is an input
     to the popup's geometry and a taller control would move the panel. */
  --dp-fab-size: 48px;
  --dp-fab-size-coarse: 56px;

  /* The distance from the trailing corner, shared by the button and the popup
     so the two line up on one edge. */
  --dp-popup-inset: 20px;

  /* The popup's height ceiling. */
  --dp-popup-block: 640px;

  /* The room the popup leaves BELOW itself for the button it opens above. A
     token rather than the sum written twice, because it is not a constant: with
     no floating button on the page it collapses to 0px (see below). */
  --dp-fab-clear: calc(var(--dp-fab-size) + 12px);

  /* ── Radius — six steps, and none of them moves ─────────────────────────── */

  /* Each step names a KIND of thing, not a state. Radii used to be
     rest/hover/focus tiers that grew under the cursor; they are static now,
     because a shape that moves competes with the colour change already saying
     the same thing. */
  --dp-r-sm: 8px;       /* icon buttons, the copy chip, the nav trigger, inline text buttons, inline code */
  --dp-r-md: 12px;      /* rows and blocks: suggestion, source, pick, the code card, the quote chip */
  --dp-r-lg: 16px;      /* panels and cards: the popup, the feedback textarea */
  --dp-r-bubble: 22px;  /* the question */
  --dp-r-field: 28px;   /* the composer */
  --dp-r-pill: 999px;   /* send, ghost pills, the floating button, the status dot */

  /* ── Motion — two tiers and one curve ───────────────────────────────────── */

  /* --dp-dur carries the three panel entrances; --dp-dur-fast carries every
     colour, background and opacity change. Colour transitions run `linear` —
     between two colours the curve is imperceptible — so the ease is reserved
     for movement, which is the only place it does any work. */
  --dp-dur: 220ms;
  --dp-dur-fast: 150ms;
  --dp-ease: cubic-bezier(0.16, 1, 0.3, 1);

  /* ── Stacking ──────────────────────────────────────────────────────────── */

  /* The panel's layer. The scrim sits at calc(var(--dp-z) - 1). */
  --dp-z: 29;
}
```

## The dark set

Nine tokens differ, and only those nine. The core switches them on
`prefers-color-scheme`; everything that is not a colour — geometry, radii,
durations, `z` — is declared once, because it does not vary with appearance.

```css
@media (prefers-color-scheme: dark) {
  :root {
    --dp-surface: #1b1b1f;
    --dp-surface-2: rgba(101, 117, 133, 0.16);
    --dp-line: rgba(130, 130, 140, 0.32);
    --dp-text: #dfdfd6;
    --dp-text-dim: #98989f;
    --dp-on-text: #1b1b1f;
    --dp-focus: #dfdfd6;
    --dp-chip: rgba(101, 117, 133, 0.16);
    --dp-code-bg: rgba(101, 117, 133, 0.16);
  }
}
```

`--dp-wash` is absent on purpose: it is derived from `--dp-text`, so it follows
the branch above without being in it.

An **adapter** — the VitePress and Docusaurus mappings, or one you write — must
re-declare the whole colour set *unconditionally* instead of copying this block.
Every host switches appearance by a class or an attribute and lets a reader pin
the site against their OS, so a token left in the media query would keep its
OS-driven value and paint one dark element into an otherwise light panel.

## Two tokens the stylesheet moves for you

Both are overrides on `:root` or `body` in the core, not defaults you set.

```css
/* Below the sheet breakpoint VitePress raises its own sidebar to 60 and its
   backdrop to 50, so a "modal" sheet at 29 would render underneath the
   hamburger menu. */
@media (max-width: 959px) {
  :root { --dp-z: 70; }
}

/* No floating button on the page — `ui.trigger: ['nav']` with `panel: 'popup'`
   is an ordinary configuration — so the popup reserves no room under itself.
   Written as the ABSENCE of the button so a browser without `:has()` keeps the
   room: the miss in the safe direction. */
body:not(:has(.docpilot-nav-trigger.is-fab)) {
  --dp-fab-clear: 0px;
}
```

## Overriding

Order is the mechanism. The core declares every token with a real value; an
adapter re-declares the colour set on `:root` at the same specificity and wins by
coming second. Your rules have to come after the adapter:

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme'
import './my-docpilot-tokens.css'   // after — this is the whole trick

export default withDocPilot(DefaultTheme)
```

```css
/* my-docpilot-tokens.css */
:root {
  --dp-width: 520px;
  --dp-popup-block: 560px;
  --dp-r-field: 12px;
}
```

The one exception is [`ui.font` / `ui.fontMono`](/reference/config#ui): those are
written onto `<html>` as inline custom properties, the only layer that outranks
an adapter, so they reach the panel on VitePress and Docusaurus without any
ordering on your part.

A token declared here and nowhere in the core is a token nothing reads. The
suite checks that pairing in both directions — the published table and
`core.scss` are asserted to name exactly the same 33 properties — so a token
added to one and forgotten in the other fails the build rather than shipping.
