# 017 — The panel moves by default, and all of its CSS is in one layer

## Problem

**Motion.** Since 015 the panel's motion is a system: two springs, an exit for
every entrance, a lens that travels. Every rule of it sat behind
`@media (prefers-reduced-motion: reduce)`, which swapped it for fades with no
way for a site to say otherwise. On a machine with the OS switch on, the panel
showed none of it — measured 2026-10-26 in the Chrome the maintainer reviews
the docs in, where `matchMedia('(prefers-reduced-motion: reduce)')` is `true`.
The owner decided the default: the panel moves, and following the OS is a
setting.

**Layers.** Only `docpilot.web.css` was in `@layer docpilot` (1.x). The four
stylesheets for VitePress and Docusaurus were unlayered, so a site that wanted
to restyle a recipe had to out-specify `.docpilot__…` selectors, and the panel
behaved differently under the same override depending on which file a host
loaded. The owner decided all of it goes in the layer.

## Research

**What outranks a layer.** An unlayered declaration beats every layered one
whatever its specificity; among layers, the one named first loses. So the
change hands control to the site *and* to every unlayered reset on its page.
What the supported hosts load, read from their stylesheets:

| host | its reset | layered? |
|---|---|---|
| VitePress 2.0.0-alpha.19 | Tailwind-Preflight-based `base.css` — `button { padding: 0; background: transparent }`, `ul { list-style: none }`, `a { color: inherit }`, `svg { display: block }` | yes, `@layer __vitepress_base` |
| VitePress 1.6.4 | the same family of rules | no |
| Docusaurus 3 | Infima — bare `h1`–`h6`, `ul`, `code`, `pre`, `a` | no, unless `future.v4.useCssCascadeLayers` |
| this docs site | Tailwind v4 Preflight | yes, `@layer base` |

**Import order on VitePress 2.** `src/theme/index.ts` imports `docpilot.css`
before `theme.js` pulls in `vitepress/theme`. In a stock-theme fixture the
browser saw `docpilot` named before `__vitepress_base` — the reset would win
over every button and list in the panel.

**VitePress's own components.** Two rules in the adapter exist to beat
VitePress's scoped (unlayered) CSS on VitePress's elements:
`.VPNavBarSearch { flex-grow: 1 }`, which put the nav trigger 398px from the
search box before the adapter shrank it, and `.VPSidebar { transition: opacity
.5s, transform .25s }`, which would leave the pushed sidebar jumping while the
page slides.

**VitePress takes motion away itself.** Both majors' `base.css` carry
`animation-duration: 1ms !important; transition-duration: 0s !important` on `*`
under `prefers-reduced-motion: reduce`. Measured in the fixture: the panel's
entrance ran `dp-in-x` at `0.001s`. A layered `!important` could only beat it
from a layer named *before* `__vitepress_base`, and the package writes no
`!important` (000, rule 1).

**Cost to readers.** WCAG 2.2 SC 2.3.3 (AAA) asks that motion triggered by
interaction can be disabled. Under `'full'` a site can disable it; a reader
cannot from inside the panel.

## Decision

**`ui.motion: 'full' | 'auto' | 'reduce'`, default `'full'`.** `'system'` is a
spelling of `'auto'`, as for `theme`. `'auto'` survives resolution for
`theme`'s reason — the signal is in the browser. `session.configure` writes
`docpilot-motion-auto` or `docpilot-motion-reduce` on `<html>`; `'full'` writes
nothing. The reveal of a baked answer follows the same setting.

**The still variant is one block, emitted twice.** `_motion.scss` holds
`@mixin still`: the content once under `:where(html.docpilot-motion-reduce)`,
once under `:where(html.docpilot-motion-auto)` inside the media query. The OS
signal stays in CSS — live, with no `matchMedia` listener. `:where()` adds no
specificity, so every rule keeps the weight it had as a media override. The two
adapters and the docs site state their push rule in full instead, because it
has to beat their own `html.docpilot-push …` at `(0,2,1)`.

**Every stylesheet declares `@layer docpilot` in its source.** `core.scss`,
`vitepress.scss` and `docusaurus.scss` wrap themselves; the web build's wrapping
plugin is gone. The blocks are not indented, so `:root {` stays at column 0 for
rule 9's awk.

**Three VitePress rules stay outside the layer**, at the end of
`vitepress.scss` under one heading: the navbar `flex-grow` recipe and the
sidebar's two push transitions with their still variant. A rule joins them only
when it has a VitePress declaration on the same element to beat.

**The bundle names the reset first.** `build-css.js` writes
`@layer __vitepress_base,docpilot;` ahead of `docpilot.css` only. On a host
without that layer the name is an empty layer.

**Not taken.** A switch back to unlayered builds — it would be a second set of
stylesheets to keep in step. `!important` against VitePress's motion rule.

## What the rules see

- Rule 6b reads the still block from `@include motion.still` and the forced
  colours block from `@media`; a new line asserts the mixin keeps the OS query
  and both root classes. `_motion.scss` joins rule 0.
- `test/packaging.test.js` holds all five built files to the layer: nothing
  outside it in `core`, `docusaurus` and `web`; the order statement first in the
  bundle; outside the layer in the VitePress files, only rules headed
  `.VPNavBar…` or `html.docpilot-…`.

## Supersedes

- 000 § The three stylesheets and § Motion — updated in the same change.
- The 1.x note "only `web.css` is layered" in `bin/build-web.js`, the CHANGELOG
  and `docs/install/web.md`.

## Verification

- `npm run verify`.
- Docs site, Chrome with reduced motion on: the bar and the window run
  `dp-in-pop`; adding either root class turns both into `dp-fade`. The
  `docpilot` layer is named after Tailwind's four. `--docpilot-rise` resolves to
  `8px`, so `@property` registers from inside the layer.
- Stock VitePress 2 fixture (`withDocPilot()` alone, `trigger: 'nav'`,
  `layout: 'push'`): the trigger sits 8px from search with `flex-grow: 0`; it
  keeps its 40px box, radius and fill against `__vitepress_base`; the pushed
  sidebar transitions `padding-inline-*, translate`.
- Not run: VitePress 1 and Docusaurus.
