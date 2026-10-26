# 016 — The window is glass, and a row has one hover

## Problem

The window is paper laid on the page. The drawer, the popup and the bar's
window all paint `--dp-surface` at full opacity, so the panel reads as a second
document stacked on the first rather than as a tool floating above it. Every
current platform material — macOS and iOS 26's Liquid Glass, Windows' Mica and
Acrylic — draws that layer as a translucent material, and an assistant panel in
2026 that does not reads as dated before the reader has asked anything.

The header's four controls — past conversations, copy, new chat, close — each
answer the pointer on their own: one wash fades out, the next fades in, 150ms
apart. Moving across the row reads as four flickers rather than as one pointer
travelling along one toolbar. The action rows under a question (copy, edit) and
under an answer (copy, retry, two thumbs) are the same arrangement and flicker
the same way, and so do the lists the reader moves down — sources, past
conversations, suggestions — and the scope picker's presets.

## Research

**Where glass belongs.** Apple's guidance for Liquid Glass puts it on the
*control and navigation* layer that floats above content — toolbars, sidebars,
floating panels — and keeps it out of the content layer. It warns against
glass on glass, and its "regular" variant is the one meant to stay legible over
arbitrary content; "clear" needs a dimming layer. The panel is a floating tool
over the page, so its window is the right place. The thread inside it is
content, which is why the material has to be the *regular* kind: mostly opaque,
with the page arriving as colour and shape, never as text.

**What the criticism says.** Axess Lab and the post-WWDC25 commentary agree on
the failure mode: text contrast drifts with whatever scrolls behind the glass,
and the early iOS 26 betas had to raise the opacity of their navigation bars.
Three mitigations recur: a high fill, a blur wide enough to erase glyphs, and an
opaque fallback driven by the reader's own settings — Reduce Transparency and
Increase Contrast, which Liquid Glass itself follows.

**What the web can and cannot do.** `backdrop-filter` gives blur and saturate;
none of its functions displaces pixels, so the refraction at Liquid Glass's
edges is out of reach without an SVG displacement filter, and that works in
`backdrop-filter` in Chromium only. Not taken. The specular edge every CSS
reproduction relies on is one inset highlight line at the top, and that is
taken. `prefers-reduced-transparency` ships in Chromium since 118; Safari does
not report it and Firefox has it behind a flag, so `prefers-contrast: more` is
the second trigger. `forced-colors` keeps a background's alpha while it forces
the colour, so a translucent fill there is a see-through system colour.

**How a hover travels.** The pattern — Vercel's tabs, Linear's toolbars, the
"follow the anchor" demos (una.im, css-tip.com) — is one fill element that moves
to the hovered item. The CSS-only form sets `anchor-name` on the hovered button
and transitions the follower's position. Rejected for three reasons:

1. it needs anchor positioning and a transition between two anchors; the demos
   name Chrome 125+ and Safari 26+ and say nothing for Firefox;
2. a pointer that **arrives** from outside the row must find the fill already
   under it. A CSS follower slides in from wherever it was last anchored, which
   is motion with no cause on screen;
3. New chat removes Copy and itself from under the pointer. A follower anchored
   to a removed node has no anchor to stay on.

A dozen lines in the component do all three, in every engine.

## Decision

### The glass

The drawer, the popup and the bar's window, from 960px up:

```scss
background: color-mix(in srgb, var(--dp-surface) 70%, transparent);
backdrop-filter: blur(24px) saturate(180%);
```

| value | why |
|---|---|
| 70% of `--dp-surface` | at most 30% of a blurred page comes through. `--dp-text` keeps 4.5:1 even over a pure black or white field behind the panel. `--dp-text-dim` does not at that extreme; a docs page's blurred average is close to its own background, so in practice it does. Derived, so under an adapter it is the host's surface. |
| `blur(24px)` | no glyph of the page survives it. Glass that lets a paragraph through competes with the answer on top. |
| `saturate(180%)` | a blur greys what it averages; this gives the colour back, which is what reads as glass rather than smoke. |

**Gated on `@supports (backdrop-filter)`**, as the jump pill is. Without the blur,
70% is a window you read the page through, so outside the query the opaque
surface stands.

**The sheet stays opaque.** Below 960px the window covers the page edge to edge
behind a scrim; there is nothing under it worth showing, and a full-height sheet
is where the platforms themselves turn opaque.

**The rim.** The two floating shapes gain an inset highlight on the top edge,
`inset 0 1px 0 rgb(255 255 255 / 0.14)`, before `--dp-shadow`. A literal on
purpose, and the opposite of `--dp-lip`'s argument: the lip is an *underside* and
must show in both schemes; a highlight is light, and on a light surface it
vanishes exactly as a highlight would. The ring stays the boundary (rule 1); the
rim only says which way is up. The drawer takes no rim — its top edge is under
the host's navbar.

**Glass yields.** One block at the end of `core.scss` puts `--dp-surface` back
and the blur off on the panel **and** the jump pill under
`prefers-reduced-transparency: reduce`, `prefers-contrast: more` and
`forced-colors: active`. The jump pill's own `forced-colors` entry moved into
it: it dropped the blur and kept the translucent fill, which that mode renders
as a see-through system colour.

**Nothing inside is a second glass.** The composer field stays an opaque
`--dp-surface` well on the glass, which is what an input on a material is. The
jump pill keeps its 2px blur: over a glass window anything wider is glass on
glass.

### The lens

Five rows have one hover each — a single fill, the **lens**, that travels from
the item the pointer left to the one it reached:

| row | item | travels | looks like |
|---|---|---|---|
| `.docpilot__header-actions` | `.docpilot__icon-btn` | across | `--dp-wash`, `--dp-r-sm` |
| `.docpilot__actions`, both — under a question and an answer | `.docpilot__icon-btn` | across | `--dp-wash`, `--dp-r-sm` |
| `.docpilot__picker-presets` | `.docpilot__text-btn` | across, and down where the row wraps | `--dp-wash`, `--dp-r-pill` |
| `.docpilot__suggestions` | `.docpilot__suggestion` | down, taking each row's width | `--dp-wash`, `--dp-r-md` |
| `.docpilot__sources` — every list of sources, history included | `.docpilot__source` | down, taking each row's height | `--dp-surface-2`, `--dp-r-md` |

Each look is the hover it replaces: level 2 on a control, level 1 on a source
row, where a hover is a selection. A row's hovers became one object; what a
hover looks like did not change.

- **Between items it travels**, `transform`, `inline-size` and `block-size` on
  `--dp-ease` over `--dp-dur`. Over the gap between two items it stays.
- **Arriving from outside the row it does not travel.** It appears under the
  pointer on the opacity fade, and leaving the row it fades where it is.
- **Only the row's own kind of item takes it.** The answer row's "Tell us more"
  is a ghost pill among icon buttons: a different shape with its own wash, and a
  corner may not animate (rule 2). Over it the lens leaves. A button inside a
  source row — the history row's bin, a citation's chevron — is part of that
  row, so the lens stays on the row and the button paints level 2 over it.
- **It is pressed with its item**, `scale: 0.96` on the press clock, about the
  item's centre — where the item has a press. A source row has none.
- **It follows an item that moves, grows or goes.** One `MutationObserver`, on
  the row that holds the lens and only while it does, watches the row's subtree
  and re-measures whichever item is still `:hover`, or lets the lens go. New
  chat takes Copy and itself out of the header; a thumb down brings the pill
  into the answer row; a citation's passage opens inside its row.
- **Touch is ignored.** A tap has no hover to follow, and the press answers it.
- **Focus is not its job.** `:focus-visible` keeps a control's own wash and
  ring, `:focus-within` keeps a source row's fill, and a linked source keeps its
  accent. The lens suppresses only the per-item `:hover` fill, and only under
  `(hover: hover)`. A suggestion's resting surface gives way under the pointer as
  it always did — to the lens now instead of to its own wash.
- **Reduced motion** keeps it and stops the travel: it appears in place, as a
  hover did, and its press scale goes with the other five.

**It is the row's own `::before`**, not a node. A `<span>` inside an `<ol>` is
not valid HTML, and an extra `<li>` would be counted by every list query. The
row is `position: relative` and `isolation: isolate`, the pseudo-element sits
at `z-index: -1` under the items, and two attributes switch it: `data-lens` on,
`data-lens-instant` for the arriving move. The component writes the box to the
row as four plumbing properties, `--docpilot-lens-x/-y/-w/-h`, read from the
item's `offset*` — to the node, not to reactive state, so a pointer crossing a
list does not re-render the panel. Vue binds no attribute or style on these
rows, so a render undoes nothing written there.

**One pair of listeners, on the panel.** `pointerover` bubbles, so a list of
forty sources needs no listener of its own; `pointerout` with its
`relatedTarget` outside the row is the row's leave. The component's `LENS_ROWS`
maps each row class to its item class, and a new row is one line there and one
selector in each of the three CSS lists.

`left` and `translate` are physical, because `offsetLeft` is measured from the
left in either direction — which is also what places the lens correctly in the
question's row, aligned to the end.

## What the rules see

Nothing moves. No new `--dp-*` token, so rule 10 and both published tables are
unchanged. No new border: the rim is a `box-shadow`, and rule 1b stays at 22 of
22. No new radius, no new type size, no new loop. The four lens properties are
plumbing under `--docpilot-*`, like `--docpilot-rise`.

## Supersedes

[000](000-design-system.md) § Jump pill called it "the one glass in the
package"; it is the first of two now. 000 § Elevation gains the glass, and
§ Header, § Answer row, § Question row, § Icon button, § Suggestion row,
§ Source and pick rows and § Motion gain the lens.

## Verification

- In Chrome, light scheme, bar window over a docs table: the table arrives as
  soft grey shapes, no glyph legible, every line of the answer at full contrast.
- Lens, with reduced motion stripped at runtime: arriving runs `opacity` only;
  first → last header button runs `transform`, 35.8px of 108px at 80ms and
  108px settled; leaving runs `opacity`; a `touch` pointer leaves it off. The
  answer row does the same with a real cursor, caught mid-flight between retry
  and the thumb; the question's end-aligned row puts it at its button's own
  `offsetLeft`.
- Down a list, in Chrome with synthetic events: suggestions measure 166 / 296 /
  247px wide and the lens takes each width; over the history row's bin the lens
  stays on the row, level 1 at 12px.
- The browser tools' `hover` lands about 33 CSS px off the cursor they draw in
  this window, so the lens was checked against where the event arrived, not
  against the drawn cursor.
- `test/mount.test.js` holds arrive / follow / gap / leave on the header, touch,
  one row at a time, the pill, travel down sources and suggestions, and an item
  lost from under the pointer.
