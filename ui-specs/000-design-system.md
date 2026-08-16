# 000 — The design system

Every value the panel paints, and the rule that keeps it there.

This file outranks the numbered specs. They record *why a change was made*, on
the day it was made; this records *what the system is now*. Where a numbered spec
states a value that has since moved, this file wins and that spec says so at the
top.

---

## Where it comes from

**OpenAI supplies the structure. The host supplies the colour.**

That one sentence is the whole arrangement. The type scale, the radii, the
spacing, the motion tiers, the surface hierarchy and the component recipes are
taken from OpenAI's design language and from measurements of the ChatGPT product,
because that is the interface every reader of an AI answer panel already has in
their head. The colours are not, and never will be: this package mounts into
somebody else's documentation site, and a panel that ignores its host's brand is
a panel that reads as an advertisement.

So `core.scss` holds no OpenAI neutral. Its colour literals are the **no-host
fallback** — what the panel looks like when `vitepress.scss` is not loaded at all
— and not one of them moved when this system was adopted. The commit story is
exactly: *structure changed, colour did not.*

### The reference, as measured

| | OpenAI's brand system | the ChatGPT product |
|---|---|---|
| type | 12 / 13 / 16 / 18 / 20 / 28 · weights 400, 500, 600 · body 1.65 · display `-0.02em` | body 16 · muted 13 · empty-state heading 24/400 |
| radii | 12 · 16 · 9999 | bubble 22 · composer 28 · action icons 8 |
| edges | ring `0 0 0 1px var(--border)` | composer 1px border in light, surface-only in dark |
| elevation | raised `0 4px 16px rgba(13,13,13,.06)` | popovers ring **and** shadow |
| motion | fast 150ms · base 220ms · `cubic-bezier(0.16, 1, 0.3, 1)` | colour-only transitions; corners never move |
| spacing | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 | — |
| surfaces | bg → surface → border | the hover wash is **a different value** from the resting surface: black 7% light, white 15% dark |

Sources: [OpenAI design system](https://open-design.ai/systems/openai/) ·
[assistant-ui's ChatGPT reproduction](https://www.assistant-ui.com/examples/chatgpt) ·
`modern-web-guidance` for the `color-mix()` and `:has()` baselines ·
`interfaces:better-ui` for the craft principles the recipes cite.

### What is deliberately not taken

- **The palette.** See above.
- **The teal accent.** This package is allowed exactly one accent and it is the
  host's, named once (rule 3).
- **12px.** It is on OpenAI's brand scale. The panel is 360–460px wide and 13px
  already carries the source tails and the character counter; a fifth tier below
  that would be a size nobody can read in a drawer.
- **Serif display type.** OpenAI pairs Söhne with Signifier. The panel has no
  editorial voice to give a serif, and it inherits `--vp-font-family-base` from
  the host anyway.

### The three stylesheets

`core.scss` decides. `vitepress.scss` translates. `docpilot.scss` is the two
`@use` lines that load them in that order — and order, not specificity, is the
mechanism: the adapter re-declares the whole colour set on `:root` and wins by
coming second. A consumer who loads the adapter alone gets no panel at all.

---

## Tokens

### The two-level surface rule

This is the load-bearing idea in the whole file, and it is what the system
before it got wrong.

| level | token | owned by |
|---|---|---|
| 0 | `--dp-surface` | the panel, and anything that **is** a surface: the composer, the copy button's occluder, the floating button |
| 1 | `--dp-surface-2` | an **object's** own paint — the question bubble, a suggestion row, a toggle's track, inline code — and a **row's** hover |
| 2 | `--dp-wash` | a pointer on a **control** — an icon button, a ghost pill, an inline text button — composited *on top of* whatever it sits on |

**The corollary is the point.** A delete button inside a hovered history row
paints level 2 over level 1 and renders as a visibly darker chip inside a lighter
row. It separates by compositing, so there is no special case to write — which is
why [006](006-row-controls.md)'s `:has()` rule was withdrawn rather than kept.

Before this split, one token — `--dp-fill` — was the resting surface *and* the
hover wash, so a control nested in a hoverable row painted the same colour over
the same colour and vanished into it.

### `--dp-wash` is derived, and must stay that way

```scss
--dp-wash: color-mix(in srgb, var(--dp-text, #0d0d0d) 12%, transparent);
```

It re-themes automatically: custom-property substitution resolves at computed-value
time against `:root`'s winning `--dp-text`, so the adapter's mapping — or a
consumer's override of it — reaches this token without declaration order
mattering. 12% is the single value that lands near ChatGPT's light target and
slightly under its dark one, from one declaration.

> **It must never acquire a dark variant.** `test/styles.test.js` requires every
> token in core's `prefers-color-scheme` block to be re-declared
> **unconditionally** by the adapter, and no VitePress token expresses "7% in
> light, 15% in dark" as one unconditional value. A dark variant here would make
> that invariant unsatisfiable.

`color-mix()` is not a new platform bet: VitePress uses it in `base.css` for
placeholder colour, and the VoidZero theme this repo's own docs run on uses it to
build `--vp-c-default-soft`.

### A host token that cannot be used

`--vp-c-bg-soft` looks like the obvious mapping for a raised surface. It is not.
On `@voidzero-dev/vitepress-theme` it is `--color-slate` in dark while
`--vp-c-bg` is `--color-primary` — **darker than the page** — so a bubble mapped
to it inverts. `--vp-c-default-soft` is translucent on every host checked and
therefore composites in the right direction whatever it lands on. Do not re-point
it.

### The table

**Colour**

| token | job | core light | core dark | adapter |
|---|---|---|---|---|
| `--dp-surface` | level 0 — the panel, the composer, the occluder, the FAB | `#ffffff` | `#1b1b1f` | `var(--vp-c-bg)` |
| `--dp-surface-2` | level 1 — an object's paint, and a row's hover | `rgba(101,117,133,.12)` | `rgba(101,117,133,.16)` | `var(--vp-c-default-soft)` |
| `--dp-wash` | level 2 — a pointer on a control | derived, see above | derived — **no dark variant** | not re-declared |
| `--dp-line` | the 1px ring, everywhere | `rgba(101,117,133,.24)` | `rgba(130,130,140,.32)` | `var(--vp-c-divider)` |
| `--dp-text` | primary text; the armed send and pressed toggle fill | `#1f2328` | `#dfdfd6` | `var(--vp-c-text-1)` |
| `--dp-text-dim` | muted text, list markers, placeholders | `#5c6672` | `#98989f` | `var(--vp-c-text-2)` |
| `--dp-on-text` | ink on `--dp-text` | `#ffffff` | `#1b1b1f` | `var(--vp-c-neutral-inverse, var(--vp-c-bg))` |
| `--dp-focus` | the one focus ring | `#1f2328` | `#dfdfd6` | `var(--vp-c-brand-1)` |
| `--dp-accent-soft` | the single accent — a marker-linked source row | `rgba(100,108,255,.18)` | — | `var(--brand-bg-active, var(--vp-c-brand-soft))` |
| `--dp-chip` | the nav trigger's fill — it must match the host's search box, which is a different job from anything inside the panel | `rgba(101,117,133,.08)` | `rgba(101,117,133,.16)` | `var(--vp-c-bg-alt)` |
| `--dp-code-bg` | the code card's surface | `rgba(101,117,133,.08)` | `rgba(101,117,133,.16)` | `var(--vp-code-block-bg)` |
| `--dp-shadow` | the three things that float: the popup, the FAB and the selection popover | two-layer black alpha | — | `var(--vp-shadow-3)` |
| `--dp-scrim` | the sheet's backdrop | `rgba(0,0,0,.6)` | — | `var(--vp-backdrop-bg-color)` |

`--dp-on-text` used to map to `var(--vp-c-white-invrert, …)`. **That token does
not exist** — not in VitePress, not in the VoidZero theme — so it had always
silently fallen through to its fallback. The real name is
`--vp-c-neutral-inverse`.

**Type**

| token | core | adapter |
|---|---|---|
| `--dp-font` | system sans stack | `var(--vp-font-family-base)` |
| `--dp-font-mono` | system mono stack | `var(--vp-font-family-mono)` |

**Geometry** — no dark variants; only `--dp-top` is mapped

| token | value | for |
|---|---|---|
| `--dp-top` | `0px` → `var(--vp-nav-height)` | how far below the host's header the panel starts |
| `--dp-width` | `clamp(360px, 30vw, 460px)` | the drawer and the popup, deliberately the same |
| `--dp-gutter` | `20px` | the panel's inline padding |
| `--dp-fab-size` / `--dp-fab-size-coarse` | `48px` / `56px` | the floating button's **block** size — an input to the popup's geometry |
| `--dp-popup-inset` | `20px` | the distance from the corner, shared by the button and the popup so they line up |
| `--dp-popup-block` | `640px` | the popup's height ceiling |
| `--dp-r-sm` … `--dp-r-pill` | see [Radius](#radius) | |
| `--dp-z` | `29`, raised to `70` below 960px | VitePress puts its sidebar at 60 and its backdrop at 50 |

**Motion**

| token | value |
|---|---|
| `--dp-dur` | `220ms` — entrances |
| `--dp-dur-fast` | `150ms` — every colour, background and opacity change |
| `--dp-ease` | `cubic-bezier(0.16, 1, 0.3, 1)` |

### The invariants a token change has to keep

`test/styles.test.js` asserts three, and they are the reason the split works:

1. every `var(--dp-*)` used in either sheet is **declared in `core.scss`**;
2. the adapter declares **nothing core does not** — it overrides, it never
   introduces;
3. every token in core's dark block is re-declared **unconditionally** in the
   adapter's `:root`, and that block holds more than five.

A derived token like `--dp-wash` satisfies all three by staying out of the dark
block. A token declared only in the adapter fails (2) — which is what makes the
core loadable on its own.

---

## Type

Four sizes. Three weights. Nothing else.

| size | line-height | weight | role |
|---|---|---|---|
| **24px** | 1.3, `letter-spacing: -0.02em` | 400 | **display** — the empty state's greeting heading, and nothing else in the package |
| **16px** | 1.65 | 400 | **body** — the answer, the question bubble, the greeting paragraph, the lead line, both composers, the mobile nav row |
| **14px** | 1.5 | 400 / 500 / 600 | **UI** — the panel title (600), answer headings (600), source titles (500), the FAB label (500), suggestion rows, the article CTA |
| **13px** | 1.5, or 1.6 for mono | 400 / 500 | **meta** — the status line, pills, counters, footnotes, source indices and tails, the reasoning and prompt blocks |

Two relative sizes, and they are the only ones allowed to be relative because
both have to track the text they sit in:

- `0.9em` — inline `code`
- `0.75em` — the citation superscript, at `line-height: 0`, which is load-bearing:
  without it a superscript inflates the 1.65 line box and the answer's rhythm
  breaks on every cited line.

`letter-spacing` is non-zero at 24px and nowhere else. It is a display treatment;
applying it at 14px, as this package used to, tightens a label for no reason.

**24px is a departure from OpenAI's brand scale**, which stops at 20. It is the
ChatGPT product's own empty-state measurement, taken deliberately: the greeting is
the one moment the panel has a canvas rather than a conversation. It wraps to two
lines at `--dp-width: 360px`, and that is accepted.

### The iOS zoom guard

Safari zooms the viewport when a focused form control's computed `font-size` is
below 16px. Both composers are 16px at every width now, so the two
`@media (max-width: 959px)` overrides that used to force it are dead and are
gone.

One field still needs the guard and never had it: **`.docpilot__prompt-edit`**,
which inherits 13px mono from `.docpilot__prompt`. The guard did not disappear —
it moved to the field that actually has the bug.

---

## Radius

```scss
--dp-r-sm: 8px;      // icon buttons, the copy chip, the nav trigger,
                     // inline text buttons, inline code, the citation focus ring
--dp-r-md: 12px;     // rows and blocks: suggestion, source, pick, the code card
--dp-r-lg: 16px;     // panels and cards: the popup, the feedback textarea
--dp-r-bubble: 22px; // the question
--dp-r-field: 28px;  // the composer
--dp-r-pill: 999px;  // send, ghost pills, the FAB, the status dot
```

**Radii do not animate.** The panel used to carry a rest → hover → focus morph
(4 → 8 → 12, and 8 → 12 → 20 on shells), mirrored from the host site's prev/next
pager. It is gone: ChatGPT's corners are static, and a shape that moves under the
cursor competes with the colour change that is already saying the same thing.

Concentricity, where it matters: the send button is a 36px circle inside a 52px
composer with 8px of padding. `better-ui`'s rule would put the outer corner at 26;
the reference uses 28 on ~52 and so does this. The deviation is the reference's,
not an oversight.

---

## Elevation

### The ring is the structure

One device, one value: `1px solid var(--dp-line)`.

**Wears a ring:** the drawer's leading edge · the popup (all four sides) · the
selection popover · the header's bottom, `transparent` until the thread is
scrolled · the conversation dock · the scope picker and its actions row · the
composer field · the feedback textarea · the question editor · the jump pill ·
the code card · the floating button.

**Fill only:** the question bubble (the reference's has no border) · suggestion,
source and pick rows · every button · the nav trigger, which has to match a search
box the host draws as a fill.

**Three things float, and they get a shadow as well as a ring:** the popup, the
FAB and the selection popover ([007](007-quote-a-passage.md)). Nothing else in
the package is elevated.

The jump pill ([008](008-edit-a-question.md)) is the case that tests this and
does not break it. It paints over the thread, which looks like elevation and is
not: a floating surface is one that has left the box it belongs to, and this one
is inside its own panel. So it occludes with `--dp-surface` and a ring, and takes
no shadow — the same treatment, and the same argument, as the code card's copy
chip.

### `outline` is focus, and nothing else

The composer and the feedback textarea used to draw their resting edge with a 2px
`outline` in `--dp-line`. That was never a design decision — it existed to keep
those two elements out of the old rule 1's border count, and their own comment
said so. Both are real borders now, and `outline` went back to being the focus
ring: `2px solid var(--dp-focus)`, `outline-offset: 2px`, on every control in the
package including the nav trigger and the article CTA, which used to draw theirs
in `--dp-text`.

### `box-sizing` is core's own

`core.scss` declares `box-sizing: border-box` for its own subtree. VitePress
supplies it globally from `base.css`, but inside a cascade layer and only on a
VitePress host — and every ring above is a 2px layout change without it. A
consumer loading `style/core.css` alone must get the same geometry.

### `forced-colors`

That mode replaces every `background-color` with a system colour, so a design
carrying its structure in fills degrades badly in it. A design carrying it in
rings does not: `border-color` is forced to a system colour too, so an element
with a real border needs no restatement — which is why the popup and the
selection popover are absent from the list. Only the fill-only surfaces are in
it — the question bubble, the quote chip, the send button, the prompt editor, the
copy chip — plus the status label, whose gradient is clipped to text and would
otherwise render as an empty line.

---

## Motion

| tier | value | for |
|---|---|---|
| fast | `--dp-dur-fast` 150ms | colour, background, opacity — every state change |
| base | `--dp-dur` 220ms | the three panel entrances |
| easing | `--dp-ease` `cubic-bezier(0.16, 1, 0.3, 1)` | transforms and entrances |

Colour transitions run `linear`. For a fade between two colours the curve is
imperceptible, and reserving the ease for movement is what keeps it meaningful.

`scale(0.96)` on `:active` is the press response, on all four pressable controls —
`better-ui`'s value, and never below 0.95.

Six `@keyframes` exist: three entrances (`dp-in-x`, `dp-in-y`, `dp-in-pop`), one
reduced-motion fade, and **two that repeat, both on the busy status node** — the
breathing dot and the label's sweep. Their 1.8s and 2.4s are perceptual pacing,
not part of the motion scale, and they do not move with these tokens.

> `prefers-reduced-motion` replaces every entrance with a fade, stops both
> repeating animations, and cancels all four press scales. It must also restore
> the status label's `-webkit-text-fill-color`: cancelling that animation alone
> freezes a transparent fill mid-gradient and the label renders as an empty line.
> `forced-colors` has the same obligation for the same reason.

---

## Spacing

The 4px scale — `4 · 8 · 12 · 16 · 20 · 24 · 32 · 48` — with `2` and `6` as
inline half-steps for controls that sit inside a line of text.

**Not tokenised, deliberately.** A spacing token has no override value to a
consumer (nobody re-themes a gap), and rule 5's failure mode argues against it:
a literal grep cannot see a value hidden behind `var()`, so a scale that a check
has to read is a scale that should stay literal.

Negative inline margins are optical corrections and are always paired with the
padding that pays for them — a pill's 12px padding pulled back by `-12px` so its
*text* lands on the paragraph's alignment while its fill extends past it.

---

## Component recipes

Each of these is the CSS that actually ships. Where one contradicts a numbered
spec, this is the one that is true.

### The panel

**Drawer** — full height at the trailing edge, `--dp-width` wide, starting below
`--dp-top`, one ring on its leading edge, entering on `dp-in-x`.

**Popup** — `--dp-width` wide and at most `--dp-popup-block` tall, sitting 12px
above the floating button at `--dp-popup-inset` from the corner, `--dp-r-lg`,
**ring and shadow**, `overflow: hidden` so the thread cannot paint over its
corners, entering on `dp-in-pop` from `transform-origin: bottom`.

**Sheet** — below 960px both shapes are the same full-screen sheet with a scrim,
`role="dialog"`, safe-area padding, and no border: it is edge to edge and there is
nothing to separate from.

### Selection popover — `.docpilot__ask`

The third floating surface, and the only one placed from JavaScript: a selection
has no anchor element, so its position comes from `Range.getBoundingClientRect()`
clamped to the panel's box. `--dp-r-pill` around 2px of padding and one ghost
pill, `--dp-surface`, **ring and shadow**, `dp-in-pop` with `transform-origin`
flipped to `top` by `.is-below`.

`popover="manual"` where the platform has the API — the top layer is what clears
the popup shape's `overflow: hidden` — and a plain `position: fixed` box where it
does not, which an ancestor's overflow does not clip either. That is why the
recipe carries a `z-index` it does not always need and **no `display: none`**: in
a browser with the API the UA sheet hides it until `showPopover()`, and in one
without, the absence is the fallback. `inset: auto` and `margin: 0` undo the same
UA sheet, which would otherwise centre it in the viewport;
`overflow: visible` undoes the scroll box that would clip the button's focus ring.

### Quote chip — `.docpilot__quote`

`--dp-surface-2`, `--dp-r-md`, 13px/`--dp-text-dim`, one line with an ellipsis.
Level 1 and one tier quieter than the question bubble above which it sits,
because it is the reference and the question is the ask; it shares the bubble's
`max-width: 70%` and auto margin so the two line up on one edge. No ring — a
quotation is signalled here by dimmed text, which is what the answer's own
`blockquote` does. `--draft` is the same chip in the composer: full width, and
carrying the `×` that withdraws it.

### Header

56px minimum, `12px var(--dp-gutter)`, title at 14px/600. The bottom border is
declared `transparent` and coloured by `.is-scrolled` — declared unconditionally
so the 1px never enters or leaves the box model and the thread cannot shift when
the reader crosses the top of the scroller.

### Question bubble

`--dp-surface-2`, `--dp-r-bubble`, `max-width: 70%`, `padding: 10px 16px`,
16px/1.65, right-aligned by `margin-inline-start: auto`. No ring.

Its bottom margin is **2px**, not the 20 it used to be — [008](008-edit-a-question.md).
The 18 that left went to the action row below it, which is transparent at rest,
so the resting rhythm is unchanged: `2 + 32 + 6` is the same 40 the pair occupies
together.

### Answer row — `.docpilot__actions`

Copy · **Ask again** · thumbs up · thumbs down, plus the reopen link when a
down-vote's form has been closed. On a refusal copy drops out and Ask again leads
the row. It is withheld entirely on a credential or social turn, which settle
from a template with no model call — see [008](008-edit-a-question.md).

### Question row — `.docpilot__actions--ask`

The answer's action row, under the bubble and aligned to the edge the bubble sits
on: `justify-content: flex-end`, `margin-block: 0 6px`, two `.docpilot__icon-btn`.
It reuses `.docpilot__actions` **entirely** — the same `opacity: 0` and the same
`.docpilot__turn:hover / :focus-within` reveal — so both rows in a turn appear
together. A hover scoped to the bubble alone would need a bridge across the gap,
and a bridge is where a hover reveal starts flickering.

### Question editor — `.docpilot__edit`

The bubble becomes the field it stood for: `--dp-surface` and a **ring**,
`--dp-r-lg`, the whole column rather than 70%. Level 0 for the reason the
composer is — a tinted field *and* a ring are two devices doing one job — and the
width jump is the signal that the text stopped being a record. The textarea
inside is transparent, 16px (the body size and the iOS zoom floor), capped at
`calc(5lh + 12px)`. Its two ghost pills sit below it at the same edge, pulled
back `-12px` so their text lands on the field's alignment.

### Jump pill — `.docpilot__jump`

**The one thing that occludes without floating.** A `--dp-r-pill` at
`--dp-surface` with a ring, 48×32 around a 16px chevron, `min-block-size: 44px`
on a coarse pointer — and **no shadow**: it lives inside the panel it belongs to,
so it separates by occluding the thread with the panel's own surface, exactly as
the code card's copy chip does. Hover moves colour only, because `--dp-wash` is
translucent and would let the thread show through the pill.

It rides a **rail of zero height** between the thread and the composer:
`block-size: 0` with `align-items: flex-end` puts its bottom edge on the boundary
and lets it grow upward. That is what keeps the placement out of the panel's only
scroller — autoscroll, `scroll-padding`, `100dvh` on iPadOS and
`overscroll-behavior` all hang off that element — and off the composer's height,
which moves with the quote chip, the counter, the footnote and both docks.
Hidden by `opacity` + `pointer-events` and taken out of the tab order, never by
`visibility`.

### Composer

`--dp-r-field`, a **ring**, `--dp-surface` — a tinted field *and* a ring would be
two devices doing one job, and the reference's light composer is the page colour
plus a hairline. Grid `1fr 36px`, `min-height: 52px` (36 + 8 + 8), padding
`8px 8px 8px 16px`. **No hover state**: the reference composer does not answer a
pointer. Focus is the standard 2px ring on `:focus-within`.

The textarea inside is transparent, borderless, `font-size: 16px`, capped at
`calc(5lh + 12px)`.

### Send

36px circle, `--dp-r-pill`, transparent until armed and then `--dp-text` on
`--dp-on-text`. 44px on a coarse pointer. Presses like every other control.

### Icon button

32px (44 coarse), `--dp-r-sm`, no fill at rest, `--dp-wash` on hover and focus,
`--dp-text-dim` → `--dp-text`.

### Ghost pill — `.docpilot__text-btn`

`--dp-r-pill`, `min-height: 32px` (44 coarse), `padding: 6px 12px`, 13px/500,
`--dp-wash` on contact. A button that looks like a link reads as navigation, and
every control wearing this class acts in place.

**A toggle carries a track at rest; an action appears on contact.**
`[aria-pressed]` unqualified takes `--dp-surface-2` and dim text — level 1, because
level 2 on a resting control would read as permanently hovered — and
`[aria-pressed="true"]` takes the inverted `--dp-text` / `--dp-on-text` pair, the
same relationship the armed send button uses.

### Suggestion row

Not a pill: these are whole sentences, and a pill around a sentence is a paragraph
with a rounded rectangle drawn on it. `--dp-surface-2` at rest — resting, because
these three rows are the only thing to do in an empty panel and a control whose
only affordance is hover has none at all on a touchscreen — `--dp-wash` and
promoted text on contact, `--dp-r-md`, 14px.

### Source and pick rows

Grid, `--dp-r-md`, `--dp-text-dim`, `--dp-surface-2` on hover and `:focus-within`.
A control inside separates by compositing level 2 on top; there is no `:has()`
rule and no hover underline. `.is-linked` is the one accent surface in the
package.

### Code card

`--dp-code-bg`, a **ring**, `--dp-r-md`. The `pre` inside keeps
`border-radius: 0` and supplies the padding and the horizontal scroll. The card is
the positioning context for the copy chip — `pre` is a scroller and would carry an
absolutely positioned child off-screen with the code.

**No `overflow: hidden` on the card**: it would clip the `pre`'s focus ring, which
is drawn at `outline-offset: 2px`, and the `pre` has no background to show through
the corners anyway.

The copy chip is 32px (44 where there is no hover), `--dp-r-sm`, painted
`--dp-surface` so it occludes the code beneath it, invisible until the card is
hovered — by `opacity` and `pointer-events`, never `visibility`, so it stays
reachable by Tab.

### Dock and scope picker

Full-bleed bands: the gutter is cancelled and restored as padding, because a line
inset 20px reads as an underline on the row above it rather than as a boundary.
One ring each. Their scrollers cap at `min(240px, 32dvh)`.

Turning them into inset cards was considered and rejected — a card with a 32dvh
scroller inside it, inside a 420px column, is heavier than the band it replaced.

### Nav trigger and the floating button

The nav trigger is 40px (44 below 768px), `--dp-r-sm`, `--dp-chip`, because it sits
beside the host's search box and has to match *that*.

The FAB is a floating card: `--dp-surface`, a ring, a shadow, `--dp-r-pill`,
`--dp-fab-size` block (56px coarse). With a label it grows on the **inline axis
only** — the popup measures the button's block size to place itself — taking
`padding-inline: 16px` and 14px/500, with the glyph pulled back 4px so a bounding
box does not out-pad the letterforms beside it.

### Article CTA

An inline text control, not a pill: it lives in the host's article, and a pill
there would be the only one on the page. Underlined, 14px, with the same
`--dp-wash` at `--dp-r-sm` that the two in-sentence composer buttons take.

---

## The rules

Design direction that can be checked, is. `scripts/check-docpilot.sh`, run by
`npm run check` and `npm run verify`.

| # | rule | predicate |
|---|---|---|
| 0 | every checked file exists and is non-empty | a rename must fail loudly rather than make a count trivially true |
| 1a | **every border is the hairline** — `1px solid` from `--dp-line`, `transparent` or `CanvasText`, or a `none`/`0` reset; `border-color` names only `--dp-line` or `transparent` | grep |
| 1b | a stated ceiling on rings, **and the inventory is printed** | grep + awk |
| 1c | every ring is on a `.docpilot*` selector | awk |
| 1d | **`outline` is only ever the focus ring** — `2px solid var(--dp-focus)` or `Highlight` | grep |
| 2a | every `border-radius` is `0` or a `--dp-r-*` token | grep |
| 2b | **no `transition` names `border-radius`** | grep |
| 3 | the accent is declared once per file and used once; no brand token is named outside a `--dp-*` declaration | grep |
| 5 | the four type sizes plus the two relative ones, and nothing else | grep |
| 6a | exactly two repeating animations | grep |
| 6b | both guard blocks restore the status label's text fill | awk |
| 7 | `--vp-c-text-3` never reaches text | grep |
| 8 | `core.scss` names no VitePress token or selector | grep |
| 9 | the adapter is a mapping: only foreign selectors, only `--dp-*` on `:root`, and the bundle entry is nothing but `@use` | awk |
| 10 | the published token table and `core.scss` agree | comm |

Three of these are worth stating in prose because their *shape* matters more than
their text.

**Rule 1 stopped being a budget.** It used to count resting borders and name the
five selectors allowed to carry one, because the old design carried structure in
fills and a border was an exception. It does not any more — the ring *is* the
structure — so the rule became a claim about shape instead: there is one hairline
in this package, one pixel wide, drawn from one token, and every declaration in
either sheet is that hairline or a reset. 1b keeps the inventory visible in the
check output so a reviewer still sees every ring by name.

**Rule 5's extractor is deliberately loose about the value.** It used to match
`[0-9.]+(px|em)`, which meant a size hidden behind a `var()`, a `rem` or a
`clamp()` was invisible to the one rule that exists to catch exactly that. It now
captures everything up to the semicolon.

**Rule 6a counts the substring `infinite` across both stylesheets, comments
included.** Do not write that word in a comment in `core.scss` or
`vitepress.scss`. Say "loop", or "repeats". This file is not counted, which is why
it can say it.

**Rule 10 is why this file and the published guide can both exist.** 000 is
repo-internal and carries the reasoning; `docs/guide/appearance.md` is published
and carries the table. Rule 10 diffs the token names in one against the
declarations in the other, so a token added and not documented — or documented and
not declared — fails the build rather than drifting quietly.

> **Never run a `--dp-` search-and-replace across `docs/`.**
> `docs/.vitepress/theme/styles.css` declares `--dp-brand-gradient`, which belongs
> to the documentation *site's* own theme and has nothing to do with the panel.
> Renames belong in `src/theme/styles/`, `ui-specs/` and `docs/guide/`.

---

## What this supersedes

| spec | status |
|---|---|
| [001](001-icon-sprite.md) | **stands entirely.** The sprite, the `<use>` model, the inline-glyph exception and the two view boxes are untouched. |
| [002](002-header-hairline.md) | **mechanism stands.** Its border-budget table is superseded — the header's hairline is now one of ten rings rather than one of six exceptions. |
| [003](003-history-dock.md) | **stands.** The dock is still a full-bleed band with one hairline; the card alternative was reconsidered here and rejected again. |
| [004](004-button-system.md) | **substance stands.** Its §Research concluded that OpenAI's system "is built on fills, not outlines" and that the two design languages "agree by accident" — true of the reference's *buttons*, false of its *composer*, which carries a 1px border. That agreement is no longer needed. Also superseded: `--dp-fill` is now two tokens; the radius tiers are gone; the 6px on `.docpilot__scope` is `--dp-r-sm`; the pill is 13px not 14px. |
| [005](005-fab-label.md) | **stands.** `padding-inline` 18px → 16px, and the button gained a ring and moved to `--dp-surface`. |
| [006](006-row-controls.md) | **half superseded.** §"The row yields to the control inside it" is **withdrawn** — the two-level surface makes the separation structural, so the `:has()` rule and the hover underline it suppressed are both gone. Its problem statement was right; the fix moved a layer down. §The trash glyph stands. |
| [007](007-quote-a-passage.md) | **stands.** Written against this file rather than before it: the elevation, forced-colors and component-recipe entries above are its edits. |
