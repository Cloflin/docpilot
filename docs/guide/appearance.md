# Appearance

The panel ships as one stylesheet that knows nothing about any host, plus one
small adapter per host that translates it into that host's own tokens. Everything
on this page follows from that split — which file to import, which custom
properties to override, and what the two placements actually do.

## Five entry points

| import | what it is | when |
|---|---|---|
| `@cloflin/docpilot/style.css` | core + VitePress adapter | the default, and what `…/theme` already imports |
| `@cloflin/docpilot/style/core.css` | the panel, on real values | any other host, or your own mapping |
| `@cloflin/docpilot/style/vitepress.css` | the VitePress mapping only | you replaced the core and kept the host |
| `@cloflin/docpilot/style/docusaurus.css` | the Docusaurus mapping only | loaded for you by the Docusaurus plugin |
| `@cloflin/docpilot/web.css` | the core, from the prebuilt bundle | a `<script>` tag, or the React adapter |

An adapter is loaded **after** the core, always. The Docusaurus plugin lists them
in that order itself; everywhere else it is the order of your two imports.

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

Everything the panel paints goes through one of these. The second column is what the core declares with no host; the two after it are what each adapter re-declares it as.

| token | core (light / dark) | on VitePress | on Docusaurus |
|---|---|---|---|
| `--dp-surface` | `#ffffff` / `#1b1b1f` | `var(--vp-c-bg)` | `var(--ifm-background-color)` |
| `--dp-surface-2` | `rgba(101,117,133,.12)` / `.16` | `var(--vp-c-default-soft)` | `var(--ifm-color-emphasis-100)` |
| `--dp-wash` | `color-mix(in srgb, var(--dp-text) 12%, transparent)` | derived — not re-declared | derived |
| `--dp-line` | `rgba(101,117,133,.24)` / `rgba(130,130,140,.32)` | `var(--vp-c-divider)` | `var(--ifm-color-emphasis-300)` |
| `--dp-text` | `#1f2328` / `#dfdfd6` | `var(--vp-c-text-1)` | `var(--ifm-font-color-base)` |
| `--dp-text-dim` | `#5c6672` / `#98989f` | `var(--vp-c-text-2)` | `var(--ifm-color-emphasis-700)` |
| `--dp-on-text` | `#ffffff` / `#1b1b1f` | `var(--vp-c-neutral-inverse, var(--vp-c-bg))` | `var(--ifm-background-color)` |
| `--dp-focus` | `#1f2328` / `#dfdfd6` | `var(--vp-c-brand-1)` | `var(--ifm-color-primary)` |
| `--dp-accent-soft` | `rgba(100,108,255,.18)` | `var(--vp-c-brand-soft)` | the primary at 18%, via `color-mix` |
| `--dp-chip` | `rgba(101,117,133,.08)` / `.16` | `var(--vp-c-bg-alt)` | `var(--ifm-color-emphasis-100)` |
| `--dp-code-bg` | `rgba(101,117,133,.08)` / `.16` | `var(--vp-code-block-bg)` | `var(--ifm-code-background)` |
| `--dp-shadow` | two-layer black alpha | `var(--vp-shadow-3)` | `var(--ifm-global-shadow-lw)` |
| `--dp-scrim` | `rgba(0,0,0,.6)` | `var(--vp-backdrop-bg-color)` | the same literal — Infima has no token |
| `--dp-font`, `--dp-font-mono` | system stacks | the host's two families | the host's two families |
| `--dp-top` | `0px` | `var(--vp-nav-height)` | `var(--ifm-navbar-height)` |

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
| `--dp-fab-clear` | `--dp-fab-size + 12px`, or `0px` with no floating button on the page | the room the popup leaves below itself for the button it opens above |

**Radii do not animate.** They used to be rest/hover/focus tiers that grew under the cursor; they are static now, because the reference this design follows has static corners and a shape that moves competes with the colour change already saying the same thing.

Override any of them after the stylesheet:

```css
:root {
  --dp-width: 520px;
  --dp-popup-block: 560px;
}
```

The core's dark values come from `prefers-color-scheme`. An adapter has to re-declare **the whole colour set unconditionally**, not the tokens that differ: every host switches appearance by a class or an attribute and lets a reader pin the site against their OS, so a token left out would keep its OS-driven value and paint one dark element into an otherwise light panel. The suite checks this pairing, for every adapter.

Writing one for a host of your own is the same shape: a `:root` block that
re-declares those fifteen names in your tokens' terms, loaded after the core. It
must introduce no `--dp-*` of its own — a token that exists only in an adapter is
a token the core cannot render without it, which is the failure the split exists
to prevent.

## Two shapes, two placements

```js
docPilot: {
  ui: { trigger: 'nav', panel: 'auto', fabLabel: true, fabIcon: true },
}
```

See [`ui`](/reference/config#ui) for the values. What each produces:

**Drawer** — full height, docked to the trailing edge, `--dp-width` wide, starting below `--dp-top`, with a hairline on its leading edge.

**Popup** — `--dp-width` wide and at most `--dp-popup-block` tall, `--dp-popup-inset` from the trailing edge, sitting `--dp-fab-clear` above that edge — `12px` above the floating button, or flush against the inset when [`ui.trigger`](/reference/config#ui) does not include one — at `--dp-r-lg`. It carries a hairline **and** `--dp-shadow`: a shadow alone is invisible on a dark host and erased outright by `forced-colors`, which is the one mode where a floating surface most needs an edge.

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

Three rules use `:has()` — hiding the floating button under an open panel, shrinking the host's search box only when the navbar trigger is actually there, and dropping the room the popup reserves below itself when there is no floating button to reserve it for. A browser without `:has()` applies none of them: the button stays visible behind a drawer that covers it, the trigger sits at the far edge of the navbar instead of beside search, and a popup opened from the navbar floats one button-height above the corner. All three are cosmetic, and all three miss in the safe direction — nothing is hidden and nothing stops working.

`prefers-reduced-motion` replaces every entrance with a fade, stops the two repeating animations and cancels every press scale, restoring the status label's own colour rather than freezing it mid-gradient.

`forced-colors` needs less than it used to. That mode replaces every background with a system colour, but it forces a border's colour too — so the surfaces that wear a hairline survive it untouched, and only the fill-only ones (the question bubble, the quote chip, the send button, the prompt editor, the copy chip, the suggestion rows) take a `CanvasText` edge. The status label is repainted as well, since its gradient is clipped to text and would otherwise render as an empty line.

## Syntax highlighting

The highlighter is pluggable — Shiki, Prism, highlight.js, or your own — and
[Syntax highlighting](/reference/highlighting) is the whole of that API. What
belongs on this page is the part that is about colour.

**Shiki** writes both themes onto every token as custom properties and applies
neither, so a stylesheet has to pick one. The core picks off
`prefers-color-scheme`; each adapter states both branches by the host's own dark
signal — `html.dark` and `html:not(.dark)` on VitePress,
`html[data-theme='dark']` and its negation on Docusaurus. The negative branch is
not decoration: without it, a dark-OS reader on a site pinned to light gets the
panel's code painted for a dark background. This is the one thing in the package a
token cannot cover, because the `var()` has to sit on a rule targeting the spans,
which is the only place those variables exist.

**Prism and highlight.js** write classes, and the theme that colours them is the
host's — the same stylesheet that already colours the host's own code blocks, and
switched by whatever already switches those. The panel adds nothing and undoes
exactly one thing: the background. Every highlight.js theme paints `.hljs`, and
Prism's default theme gives `.token.operator` a translucent white that reads as a
smear on a dark panel. The code card is one surface — `--dp-code-bg` — so both are
neutralised inside it, and colour is left alone.
