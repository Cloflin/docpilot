# 004 — The button system

> **Substance stands; several values superseded by [000](000-design-system.md).**
>
> The load-bearing claim in *§Research* — *"Nothing borders at rest… OpenAI's
> system is built on fills, not outlines… The two design languages agree by
> accident"* — was true of the reference's **buttons** and false of its
> **composer**, which carries a 1px border. 000 adopts the ring as the structural
> device and rewrites rule 1 accordingly, so that agreement is no longer needed.
>
> Also superseded: `--dp-fill` is now `--dp-surface-2` for an object's resting
> paint and `--dp-wash` for a pointer on a control; the rest/hover/focus radius
> tiers named under *§`.docpilot__suggestion`* and *§`.docpilot__icon-btn`* are
> gone; the off-scale `6px` on *§`.docpilot__scope`* is `--dp-r-sm`.
>
> The pill system, the `aria-pressed` track, the row-not-pill decision for
> suggestions, the hit-area floor and the CTA exception all stand.

## Problem

Every non-icon control in the panel is an **underlined text link**:
`.docpilot__text-btn` (retry, widen, clear all, save, cancel, the four feedback
reasons, submit, skip), `.docpilot__suggestion`, `.docpilot__thoughts-toggle`.

Three things go wrong with that.

1. **A button that looks like a link reads as navigation.** "Try again", "Search
   the docs", "Ask without the key" all *do* something in place; underlining them
   says they leave.
2. **The multi-select reasons have no resting state to carry.** They are
   `aria-pressed` toggles whose only pressed cue today is the underline colour —
   the same cue hover uses.
3. **Hit area.** An underlined 13px string with `padding-block: 8px` is a target
   as wide as its text and no wider.

The reference the user named is ChatGPT/OpenAI, and it is the right one: the panel
sits next to that product in every reader's head.

## Research — what the reference actually does

| role | OpenAI's shape |
|---|---|
| ghost / secondary | full-round pill, no border at rest, subtle surface fill on hover, 13–14px, medium weight |
| primary | solid inverted fill (black on light, white on dark), full-round |
| icon | 32–36px square, ~8px radius in chrome, full-round in the composer, same hover fill |
| selected toggle | the solid inverted fill, at ghost size |
| suggestion row | a full-width row that takes the hover fill, not a link |
| send | circle, inverted fill once armed |

Transitions are colour-only and fast (~120–150ms). Nothing borders at rest.

That last point is what makes this adoptable here at all: **rule 1 forbids
resting borders**, and OpenAI's system is built on fills, not outlines. The two
design languages agree by accident, which is the cheapest kind of agreement.

Applicable `better-ui` principles:

- **1, concentric radius** — a pill inside the dock/picker shell needs a radius
  smaller than the shell's, or equal-and-full-round. Full-round is chosen: at
  32px tall, `999px` and "shell radius minus padding" are indistinguishable, and
  full-round never needs recomputing when the shell's tier changes.
- **9, scale on press** — `scale(0.96)`, the value already used by
  `.docpilot__icon-btn` and `.docpilot__send`. Extended to the pills.
- **11, never `transition: all`** — every transition names its properties.
- **15, motion restraint** — no entrance animation on any of these. They are
  high-frequency controls; colour and fill are the feedback.

## Decision

### `.docpilot__text-btn` — the ghost pill

```scss
display: inline-flex; align-items: center; justify-content: center;
min-height: 32px;
padding: 6px 12px;
border-radius: 999px;
background: none;
color: var(--dp-text);
font-size: 13px; font-weight: 500;
text-decoration: none;

&:hover, &:focus-visible { background: var(--dp-fill); }
&:active                 { transform: scale(0.96); }
&:focus-visible          { outline: 2px solid var(--dp-focus); outline-offset: 2px; }

/* a TOGGLE carries a track at rest; an ACTION appears on contact */
&[aria-pressed]          { background: var(--dp-fill); color: var(--dp-text-dim); }
&[aria-pressed]:hover    { color: var(--dp-text); }
&[aria-pressed='true']   { background: var(--dp-text); color: var(--dp-on-text); }
```

`[aria-pressed]` is deliberately unqualified. Without a resting track the four
feedback reasons are indistinguishable from the paragraph above them until a
pointer arrives — and where there is no pointer, never. **A control whose only
affordance is hover has none at all on a touchscreen**, which is the failure the
first draft of this spec walked into: dropping the underline without putting
anything in its place.

Rows that hold them lose their link-era spacing: `.docpilot__row` and
`.docpilot__reasons` go from `16px`/`12px` gaps to `8px`, because a pill carries
12px of its own padding on each side and the old gap was paying for text that had
none. Both rows get `margin-inline: -12px` so the first pill's *text* still lines
up with the paragraph above it — optical alignment, `better-ui` 2.

The toggle's two fills are the fourth and fifth this component paints, and both
are deliberate: rule 2 counts fills in a **settled** thread, and these exist only
while a reader is holding a feedback form open — bounded the same way the scope
picker's two borders are. A toggle whose only selected cue is a hover colour is a
toggle with no state.

### `.docpilot__thoughts-toggle`

Keeps `@extend`, keeps `display: block`, keeps `--dp-text-dim`. Gains
`margin-inline-start: -12px` so the pill's padding does not indent the reasoning
line relative to the answer under it. `width: fit-content`, so a block-level pill
does not stretch to the thread's width.

### `.docpilot__suggestion` — the row

Not a pill: these are full sentences and a pill around a sentence is a paragraph
with a rounded rectangle drawn on it. It becomes the row shape the reference
products give their own suggestions — a **resting** `--dp-fill` surface, dim text
promoted on contact, and the rest / hover / focus radius tiers `.docpilot__source`
already answers a pointer with.

The surface is resting for the same reason the toggle's is. These three rows are
the only thing to do in an empty panel and the underline was their one
affordance; they exist only while the thread is empty (or beside a social reply
that has nothing else to offer), so they never add a fill to a settled
conversation.

### `.docpilot__icon-btn`

Radius `999px → var(--dp-radius-hover)` (8px). These are chrome controls in a
32px box; OpenAI rounds those at ~8px and reserves the full round for the
composer. `.docpilot__send` keeps `999px` for exactly that reason, as does the
FAB.

### `.docpilot__scope` and `.docpilot__prompt-toggle`

These are **inline inside a sentence** — the footnote reads "All docs ·
AI-generated. Check the linked pages." A pill in running text breaks the line
box. They keep their underline, and gain the hover wash at a small radius
(`padding: 2px 6px; border-radius: 6px`) so they answer a pointer the same way
everything else does.

### What does not change

`.docpilot__send` (already the primary shape), `.docpilot__field`,
`.docpilot__pick`, `.docpilot__source`, `.docpilot-cta` — the CTA lives in the
host's article, not in the panel, and a pill there would be the only one on the
page.

## Rules touched

- **Rule 1** — none of this declares a border. Verified: every shape is a fill.
- **Rule 5** — sizes stay 13px on the pills, 14px on the suggestion rows.
- **Rule 6** — no animation added; `transform` on `:active` is a transition, and
  `prefers-reduced-motion` already cancels `:active` transforms for
  `.docpilot__icon-btn` and `.docpilot__send`. The pills join that list.

## Accessibility

- Hit area grows from "as wide as the text" to a 32px minimum block size, 44px
  under `pointer: coarse` — `better-accessibility`'s target-size floor.
- `aria-pressed` is unchanged and now has a visual state that is not a hover
  colour, so pressed is legible without a pointer.
- Focus rings are unchanged: 2px `--dp-focus`, 2px offset, on every control.
- Contrast: `--dp-text` on `--dp-on-text` is the same inverted pair the armed
  send button already uses.
