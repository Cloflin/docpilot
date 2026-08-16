# Appearance

The panel ships as two stylesheets: one that knows nothing about VitePress, and one that translates it into VitePress's own tokens. Everything on this page follows from that split — which file to import, which custom properties to override, and what the two placements actually do.

## Three entry points

| import | what it is | when |
|---|---|---|
| `@cloflin/docpilot/style.css` | core + VitePress adapter | the default, and what `…/theme` already imports |
| `@cloflin/docpilot/style/core.css` | the panel, on real values | not VitePress, or your own mapping |
| `@cloflin/docpilot/style/vitepress.css` | the mapping only | you replaced the core and kept the host |

`import { withDocPilot } from '@cloflin/docpilot/theme'` pulls in the bundle. To supply the CSS yourself:

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme-without-styles'
import '@cloflin/docpilot/style/core.css'
import './my-docpilot-tokens.css'

export default withDocPilot(DefaultTheme)
```

**Order is the mechanism, not a convention.** The core declares every token with a real value; the adapter re-declares the colour set on `:root` at the same specificity and wins by coming second. Load the adapter first and it loses. Load it alone and the panel has no styles at all — it declares no rules of its own, only a translation table.

## Surfaces come in three levels

This is the one thing worth knowing before the table. Everything the panel paints sits on one of three levels, and the level is what decides which token it uses:

| level | token | what wears it |
|---|---|---|
| 0 | `--dp-surface` | the panel, and anything that **is** a surface — the composer, the code copy button, the floating button |
| 1 | `--dp-surface-2` | an **object's** own paint — the question bubble, a suggestion row, a pressed toggle's track, inline code — and a **row's** hover |
| 2 | `--dp-wash` | a pointer on a **control** — an icon button, a pill, an inline text button — composited *on top of* whatever it sits on |

A delete button inside a hovered history row therefore paints level 2 over level 1 and reads as a darker chip inside a lighter row. It separates by compositing, with no rule written for the case.

## The tokens

Everything the panel paints goes through one of these. The middle column is what the core declares with no host; the right is what the VitePress adapter re-declares it as.

| token | core (light / dark) | on VitePress |
|---|---|---|
| `--dp-surface` | `#ffffff` / `#1b1b1f` | `var(--vp-c-bg)` |
| `--dp-surface-2` | `rgba(101,117,133,.12)` / `.16` | `var(--vp-c-default-soft)` |
| `--dp-wash` | `color-mix(in srgb, var(--dp-text) 12%, transparent)` | derived — not re-declared |
| `--dp-line` | `rgba(101,117,133,.24)` / `rgba(130,130,140,.32)` | `var(--vp-c-divider)` |
| `--dp-text` | `#1f2328` / `#dfdfd6` | `var(--vp-c-text-1)` |
| `--dp-text-dim` | `#5c6672` / `#98989f` | `var(--vp-c-text-2)` |
| `--dp-on-text` | `#ffffff` / `#1b1b1f` | `var(--vp-c-neutral-inverse, var(--vp-c-bg))` |
| `--dp-focus` | `#1f2328` / `#dfdfd6` | `var(--vp-c-brand-1)` |
| `--dp-accent-soft` | `rgba(100,108,255,.18)` | `var(--vp-c-brand-soft)` |
| `--dp-chip` | `rgba(101,117,133,.08)` / `.16` | `var(--vp-c-bg-alt)` |
| `--dp-code-bg` | `rgba(101,117,133,.08)` / `.16` | `var(--vp-code-block-bg)` |
| `--dp-shadow` | two-layer black alpha | `var(--vp-shadow-3)` |
| `--dp-scrim` | `rgba(0,0,0,.6)` | `var(--vp-backdrop-bg-color)` |
| `--dp-font`, `--dp-font-mono` | system stacks | the host's two families |
| `--dp-top` | `0px` | `var(--vp-nav-height)` |

`--dp-wash` is **derived rather than mapped**, and deliberately: substitution resolves it against whatever `--dp-text` ends up being, so it follows the host's theme — and your override of it — without a second declaration. It has no dark variant and must not be given one; the suite requires every token that darkens to be re-declared unconditionally by an adapter, and no host token expresses "7% in light, 15% in dark" as one value.

Geometry is declared once and does not vary with appearance:

| token | value | for |
|---|---|---|
| `--dp-width` | `clamp(360px, 30vw, 460px)` | the drawer and the popup, deliberately the same |
| `--dp-gutter` | `20px` | the panel's inline padding |
| `--dp-r-sm` | `8px` | icon buttons, the copy chip, the nav trigger, inline text buttons, inline code |
| `--dp-r-md` | `12px` | rows and blocks: suggestion, source, pick, the code card |
| `--dp-r-lg` | `16px` | the popup, the feedback textarea |
| `--dp-r-bubble` | `22px` | the question |
| `--dp-r-field` | `28px` | the composer |
| `--dp-r-pill` | `999px` | send, pills, the floating button, the status dot |
| `--dp-dur` | `220ms` | the three panel entrances |
| `--dp-dur-fast` | `150ms` | every colour, background and opacity change |
| `--dp-ease` | `cubic-bezier(0.16, 1, 0.3, 1)` | transforms and entrances |
| `--dp-z` | `29`, `70` below 960px | above VitePress's own sidebar on the sheet |
| `--dp-fab-size`, `--dp-fab-size-coarse` | `48px`, `56px` | the floating button's **block** size |
| `--dp-popup-inset` | `20px` | the distance from the corner, shared by the button and the popup so they line up |
| `--dp-popup-block` | `640px` | the popup's height ceiling |

**Radii do not animate.** They used to be rest/hover/focus tiers that grew under the cursor; they are static now, because the reference this design follows has static corners and a shape that moves competes with the colour change already saying the same thing.

Override any of them after the stylesheet:

```css
:root {
  --dp-width: 520px;
  --dp-popup-block: 560px;
}
```

The core's dark values come from `prefers-color-scheme`. An adapter has to re-declare **the whole colour set unconditionally**, not the tokens that differ: VitePress switches appearance by class and lets a reader pin a site to light, and a token left out would keep its OS-driven value and paint one dark element into an otherwise light panel. The suite checks this pairing.

## Two shapes, two placements

```js
docPilot: {
  ui: { trigger: 'nav', panel: 'auto', fabLabel: true, fabIcon: true },
}
```

See [`ui`](/reference/config#ui) for the values. What each produces:

**Drawer** — full height, docked to the trailing edge, `--dp-width` wide, starting below `--dp-top`, with a hairline on its leading edge.

**Popup** — `--dp-width` wide and at most `--dp-popup-block` tall, `--dp-popup-inset` from the trailing edge, sitting `12px` above the floating button, at `--dp-r-lg`. It carries a hairline **and** `--dp-shadow`: a shadow alone is invisible on a dark host and erased outright by `forced-colors`, which is the one mode where a floating surface most needs an edge.

The floating button stays visible while the popup is open and closes it again — the convention every chat widget has already taught, and what makes returning focus to it correct. It hides itself when it would be underneath: always beneath a drawer, and below 960px beneath either shape.

With a label it becomes a pill and grows on the **inline axis only** — `--dp-fab-size` is an input to the popup's own geometry, which sits a fixed distance above the button, so a taller control would move the panel and a wider one cannot. `--dp-fab-size-coarse` still applies as the block size on a pointer-less device, so the target floor is met either way.

## What the panel's chrome does

**The header's divider is absent at rest.** At the top of the thread there is no rule under the title; it fades in the moment the conversation is scrolled, and out again at the top. The native form of this — `@container scroll-state(...)` — is Chromium-only, so it is a class from a passive scroll listener, which is the fallback that feature's own guidance prescribes. The border is declared `transparent` and switched by colour, never added and removed, so crossing the top of the scroller cannot move the thread by a pixel.

**Past conversations open above the thread**, under the header button that opens them, with one hairline against the thread and a list that scrolls inside `min(240px, 32dvh)`. The scope picker and the prompt disclosure stay at the bottom, under the footnote row *they* are opened from. At most one of the three is open.

**Selecting inside an answer offers to quote it.** A one-button popover appears above the selection; pressing it puts the passage in the composer as a chip the reader can withdraw, and the question is then asked *about* it. The popover is the third and last thing in the package that floats, so it takes a hairline **and** `--dp-shadow` like the popup. It uses the platform's top layer where there is one, which is what keeps the popup shape from clipping it, and a plain fixed box where there is not. The chip is `--dp-surface-2` at `--dp-r-md`, one line, 13px, dimmed — a quotation reads as quieter text here, never as a rule down its side.

**The hairline is the structure.** One device, one value — `1px solid var(--dp-line)` — on the drawer's edge, the popup, the selection popover, the header (transparent until the thread is scrolled), the conversation dock, the scope picker, the composer, the feedback textarea, the code card and the floating button. `outline` is the focus ring and nothing else: `2px solid var(--dp-focus)` at `2px` offset, on every control.

**Buttons are pills, not links.** No border, a `--dp-wash` on hover and focus, `scale(0.96)` on press, and the inverted `--dp-text` / `--dp-on-text` pair for a toggle that is on. The two controls inside the footnote sentence, and the call-to-action under each article, keep their underline — a pill in running text breaks the line box — and take the same wash at `--dp-r-sm`.

**The composer does not answer a hover.** It is a `--dp-r-field` stadium with a hairline and the page's own surface, and only focus changes it. A tinted field *and* a ring would be two devices doing one job.

**Icons come from one sprite.** `DocPilotIcons` teleports a 0×0 `<svg>` of `<symbol>` definitions into `<body>`; every glyph in the panel is a `<use>` into it, painted by `currentColor` inherited from the referencing element. It is mounted for you by `withDocPilot` / `docPilotSlots()`. If you compose the components by hand, mount it alongside the panel:

```js
import { DocPilot, DocPilotIcons, DocPilotTrigger } from '@cloflin/docpilot/theme'
```

The navbar trigger and the floating button deliberately do not depend on it — their single glyph is inline, so composing only the trigger still works.

**Type is four sizes.** 24px for the empty state's greeting and nothing else; 16px for the answer, the question and both composers; 14px for titles, rows and labels; 13px for meta and mono. Weights are 400, 500 and 600. Both composers are 16px at every width, which is also what stops iOS zooming the viewport when one is focused.

Below 960px the two shapes are identical: a full-screen sheet with a scrim, `role="dialog"` and safe-area padding.

## What degrades, and how

Two rules use `:has()` — hiding the floating button under an open panel, and shrinking the host's search box only when the navbar trigger is actually there. A browser without `:has()` applies neither: the button stays visible behind a drawer that covers it, and the trigger sits at the far edge of the navbar instead of beside search. Both are cosmetic, and both miss in the safe direction — nothing is hidden and nothing stops working.

`prefers-reduced-motion` replaces every entrance with a fade, stops the two repeating animations and cancels every press scale, restoring the status label's own colour rather than freezing it mid-gradient.

`forced-colors` needs less than it used to. That mode replaces every background with a system colour, but it forces a border's colour too — so the surfaces that wear a hairline survive it untouched, and only the fill-only ones (the question bubble, the quote chip, the send button, the prompt editor, the copy chip, the suggestion rows) take a `CanvasText` edge. The status label is repainted as well, since its gradient is clipped to text and would otherwise render as an empty line.

## Syntax highlighting

Shiki writes both themes onto every token as custom properties and applies neither, so a stylesheet has to pick one. The core picks off `prefers-color-scheme`; the adapter states both branches by class, including `html:not(.dark)` — without it, a dark-OS reader on a site pinned to light would get the panel's code painted for a dark background. This is the one thing in the package a token cannot cover: the `var()` has to sit on a rule targeting the spans, because that is the only place the variables exist.
