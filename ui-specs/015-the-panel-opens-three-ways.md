# 015 — The panel opens three ways

> **Кратко.** Три способа открыть панель, и все три — настройка, а не форк:
> (1) **сайдбар**, который сдвигает страницу, слева или справа — `panel:
> 'drawer'`, `layout: 'push'` и новый ключ `ui.side`; (2) **попап** над
> плавающей кнопкой — как было, теперь по имени `panel: 'popup'`; (3) **строка
> внизу по центру** — новый `panel: 'bar'`, и с 2.0 это дефолт: `'auto'` при
> `fab` в trigger даёт строку. Композер живёт в строке, окно с разговором
> поднимается над ней, как только читатель начинает печатать. Движение —
> пружины в `linear()`, вход И выход через Vue `<Transition>`, без новой
> зависимости. Ни один ключ или значение не исчезает; меняются дефолтная
> форма панели и значения двух motion-токенов.

## Problem

**One page edge, one host.** The drawer is pinned to the trailing edge
(`inset-inline-end: 0`, `core.scss`), and so is the floating button and the
popup above it. A site whose own navigation lives on the right, or whose
readers expect the assistant on the left, has no way to say so.
`ui.layout: 'push'` moves the page only on VitePress, and only towards the
start: the one rule is `html.docpilot-push .VPContent { padding-inline-end }`.
The Docusaurus adapter has no push rule at all, so the setting silently does
nothing there.

**No shape for a search-first site.** Both shapes hide the composer until a
button is pressed. A docs site that wants the question box to be the first
thing a reader sees — the bottom-centre bar some docs platforms ship — has no
configuration that produces it.

**Motion that only arrives.** The panel has three entrance keyframes
(`dp-in-x`, `dp-in-y`, `dp-in-pop`) at 220 ms on an expo-out curve, and no exit
at all: `v-if="s.open"` removes the whole tree in one frame. Docks, turns,
suggestions and the floating button appear without motion, and a closing
drawer under `layout: 'push'` lets the page snap back while nothing visible
leaves.

## Research

### What the references do

The pass is recorded in full, with a source for every number, in the
session's research file; what follows is what the decisions use.

| reference | what it does | why it matters here |
|---|---|---|
| animate-ui sheet | spring `stiffness 150, damping 22`, offscreen `x: ±100%` | the panel spring family |
| animate-ui sidebar, highlight | spring `350 / 35` — ζ 0.94, no visible overshoot | **the panel spring** |
| animate-ui popover | spring `300 / 25` — ζ 0.72, 3.8 % overshoot, from `scale 0.5` | **the pop spring** |
| animate-ui sidebar push | an in-flow spacer animates its width while a fixed panel slides | push is layout, not transform |
| Motion Primitives morphing popover | spring `bounce 0.1, duration 0.4` | same order of duration |
| shadcn sheet / popover | 500 ms in, 300 ms out; popover `zoom-in-95` + 8px slide, 150 ms | exits are shorter than entrances |
| Inkeep sidebar chat | `position: 'left' \| 'right'`, default right, 420 px, pushes through a host-owned flex wrapper | the side is a setting; the push needs the host's layout |
| Kapa sidebar | a modal with an overlay — no push | push is the less common, more useful choice |
| Thesys chatbar | input fixed bottom centre; **the window opens on typing**, above the input | the behaviour the request names |
| Fern prompt, Anagram center bar | open on submit or focus; a drawer under 768 px | the mobile fallback |

### Platform

| feature | status, late 2026 | used for |
|---|---|---|
| `linear()` easing | Baseline widely available (2026-06-11) | every spring — unconditionally |
| Web Animations / CSS animations | widely available | entrances and exits |
| `:dir()` | Baseline since 2023-12 | mapping `left`/`right` onto the logical edge |
| `@starting-style`, `allow-discrete` | newly available; Firefox does not transition `display` | **not used** — Vue's `<Transition>` delays the removal in every engine |
| `interpolate-size`, `calc-size()` | Chromium only | **not used** |
| same-document View Transitions | newly available | **not used** — it snapshots the HOST's whole document and competes with a host that uses it for its own theme toggle |

**`motion-v` is about 50 KB gzip** for `motion` + `AnimatePresence`, measured.
That is more than everything else this panel ships to a reader, for springs a
`linear()` string already draws. The package keeps its two runtime
dependencies.

### Springs as `linear()`

The two springs are solved analytically (a damped oscillator, `m = 1`),
sampled every 10 ms — Motion's own resolution for its `linear()` conversion —
and simplified by Ramer–Douglas–Peucker at 0.0015, which keeps 24 and 26 stops.

| token | spring | ζ | settles | peak |
|---|---|---|---|---|
| `--dp-ease` | 350 / 35 | 0.935 | 370 ms | 1.000 |
| `--dp-ease-pop` | 300 / 25 | 0.722 | 440 ms | 1.038 |

Both are played over `--dp-dur`, now **400 ms**. Stretching or squeezing a
spring's time axis changes its stiffness, not its shape, so one duration token
serves both curves — and a site that set `--dp-dur: 0ms` to switch the
entrances off still switches every one of them off.

## Decision

```
 1 — drawer + push, either side      2 — popup                     3 — bar (the default)
┌────┬───────────────────┐        ┌─────────────────────────┐   ┌─────────────────────────┐
│    │                   │        │                 ┌─────┐ │   │       ┌─────────┐       │
│ ✦  │  the page,        │        │   the page      │ ✦   │ │   │       │ window  │       │
│ AI │  moved aside      │        │                 │     │ │   │       │ (thread)│       │
│    │                   │        │                 └─────┘ │   │       └─────────┘       │
│    │                   │        │                   (✦ ▾) │   │    ( ✦ ask…    ⌘I ↑ )   │
└────┴───────────────────┘        └─────────────────────────┘   └─────────────────────────┘
 side: 'left' | 'right' |          side moves the button        the composer IS the bar;
       'start' | 'end'             and the popup with it         the window rises on typing
```

### `ui.side` — new, default `'end'`

`'end' | 'start' | 'left' | 'right'`. Which edge the floating button, the
popup above it and the drawer belong to, and which way `layout: 'push'` moves
the page. `'end'` is where all three have always been, so the default changes
nothing. `'start'` and `'end'` follow the page's writing direction; `'left'`
and `'right'` name a physical edge and stay there in a right-to-left locale.

The CSS stays logical. The start-edge rules carry
`:is(.is-side-start, .is-side-left:dir(ltr), .is-side-right:dir(rtl))`, so the
floating button — which is server-rendered — needs no script to land on the
right edge on the first paint. The bar is centred and ignores the key.

### Push moves the page from either edge, on both adapters

The component writes three classes onto `<html>`:

| class | present |
|---|---|
| `docpilot-push` | while the panel is open and pushing — **the meaning it had** |
| `docpilot-push-start` / `docpilot-push-end` | the same time, naming the edge (logical, from `side` and the document's direction) |
| `docpilot-push-closing` | from the moment the drawer starts to leave until it has gone |

`-closing` exists because a transition is read from the state being entered:
with the padding rule and its `transition` both keyed on the open classes, the
page snapped back the frame the drawer started to leave. The adapters declare
the transition on the open and the closing state alike, so the page and the
drawer move together in both directions.

- **VitePress, both edges:** `.Layout` takes the padding. The rule that shipped
  padded `.VPContent`, and measured at 2560px it padded nothing: VitePress's own
  `.VPContent.has-sidebar` padding is scoped, `(0,3,0)` against our `(0,2,1)`,
  and from 1440px up it sets `padding-right` itself. `.Layout` has no padding of
  VitePress's to lose to, and VitePress 2 centres the article against `100%` of
  it, so the article re-centres in what is left of the window.
- **VitePress's sidebar is fixed at the physical left** and does not move with
  the flow, so it is translated by the distance the article's left edge moved:
  the whole width below 1440px when the drawer docks on its side, nothing when
  it docks on the other, and half the width either way beyond 1440px, where the
  narrowing is split between the two gutters. Measured with it left alone, the
  article slid 230px under it. VitePress 1 centres against `100vw`, so there the
  translation opens a gap rather than closing one — the safe miss.
- **Docusaurus, both edges:** `.main-wrapper`. Its navbar is sticky, not fixed,
  and its sidebar lives inside the wrapper, so one rule per edge is the whole of
  it. This is the push Docusaurus never had.
- **Any other host:** the three classes are the contract, and they are
  documented. A site styles its own content wrapper from them.

### `ui.panel: 'bar'` — new

**The composer is the bar.** On a pointer-and-keyboard width it is a pill,
fixed at the bottom centre, `--dp-bar-inline` wide (400 px) at rest and
`--dp-bar-inline-open` (640 px) once it has focus, text or an open window. The
width moves on the panel spring. It carries the panel's glyph, the field, the
`⌘I` hint at rest, a button that reopens the conversation when one exists and
the window is shut, and the send button.

**The window is the popup's recipe, centred above the bar** — ring, shadow,
`--dp-r-lg`, at most `--dp-popup-block` tall, growing with its content and
rising from the bar's centre. It holds everything the other two shapes hold:
the header with history, copy, new chat and close; the thread; the quote chip,
the counter, the budget line and the footnote with the scope and prompt
toggles; the picker and prompt docks. Only the field moved out. **One field
exists at a time** — the markup is defined once in the component and placed
either in the panel's composer or in the bar — so every `aria-describedby`,
every draft and every keyboard rule is the same field's.

| opens the window | closes the window |
|---|---|
| the first character typed into the bar (Thesys's behaviour, and the request's) | `Esc`, after the existing cascade has nothing smaller to close |
| sending a question | the window's close button |
| `⌘I` / `Ctrl I`, a navbar trigger, `open()`, a deep link | a pointer pressed outside the bar and the window |
| the reopen button in the bar | |

Closing the window is closing the panel: `s.open` is the window, so the turn
runs on under `ui.background` exactly as it does for the other shapes, and the
reopen button carries the unread dot the floating button would have carried.

**The bar replaces the floating button.** `showFab` resolves false under
`'bar'`, whatever the trigger list says, because the bar is the floating
placement in this shape. `nav` and `screen` keep working and open the window.

**`'auto'` resolves to `'bar'` whenever `fab` is in the trigger list**, and to
the drawer when it is not. The first draft took the bar by name only: a bar is
a decision about what the page leads with, not a consequence of where the
button is. 2.0 makes that decision for the shipped pair, in the major where a
default may move — the page leads with the question box. `panel: 'popup'` keeps
the corner button and its popup, and a list without `fab` never finds a bar it
did not ask for.

**Below 960 px the bar is a button.** A pill at the bottom centre that opens
the same full-screen sheet the other shapes use, with the field inside it. A
fixed input on a phone sits under the software keyboard's own toolbar and
fights the visual viewport; the sheet already solves both.

**Server rendering.** The bar renders after mount. It is fixed-position, so
its arrival shifts nothing, and it enters on the pop spring.

### Motion

| element | enters | leaves |
|---|---|---|
| drawer | `translateX(±100%)` → 0, `--dp-ease` | back out, `--dp-ease-exit`, half of `--dp-dur` |
| sheet (< 960 px) | `translateY(100%)` → 0, `--dp-ease` | back down, `--dp-ease-exit` |
| popup | from the button's corner: `scale(.94) translateY(8px)`, `blur(4px)`, `--dp-ease-pop` | `scale(.97)`, fade, `--dp-ease-exit` |
| bar window | the popup's recipe from the bar's centre, `translateY(16px)` | the popup's |
| scrim | fade | fade |
| bar | rises on mount, `--dp-ease-pop`; width on `--dp-ease` | — resident |
| floating button | pops in on mount and whenever it reappears from under a drawer | — `display: none` |
| floating button glyph | sparkle → chevron while the popup is open: rotate, scale, cross-fade | the reverse |
| a turn asked in this view | the question rises on `--dp-ease-pop`; its answer un-blurs on first paint | — none: an edit truncates instantly |
| empty-state suggestions | rise in a 40 ms stagger | — |
| docks | fade and 6px slide from the edge they open from | fade |
| copy → check | the check pops in | — |

**Entrances stay keyframes on the element's own class**, as they were: an
element that mounts is already animating, with nothing to coordinate. **Exits
are `*-leave-active` classes on a `<Transition>`**, which keeps the node until
its `animationend` — the one thing CSS cannot do for a `v-if`. A turn restored
from history or a conversation re-opened does not animate: only a turn whose
arrival the reader caused does.

**`prefers-reduced-motion`** replaces every entrance with `dp-fade` and every
exit with the same fade reversed, drops the blur and the stagger, and makes the
bar's width change instant. The push transition was already cancelled there.

### What it costs the rules

- **Rule 1's ceiling moves from 20 to 22.** The start-edge drawer draws its
  ring on the other side of itself — one declaration that has no other way to
  be written — and the window shares the popup's ring by sharing its rule.
- **Elevation.** The bar and its window float, so they take the ring and the
  shadow. The list of things that float grows from three to five.
- **Keyframes.** Seven become eleven: `dp-in-blur` for an answer's first
  paint, and three exits. The pop is parametrised by registered custom
  properties rather than multiplied. Still exactly two loop.

### What the browser found

Each of these was found by driving the three shapes in Chrome, and each is
fixed in the same change because the shape it was found in does not work
without it.

- **A button that moved under the pointer.** The bar widened on focus, and a
  press on its reopen button focused the bar on `pointerdown`, so the button
  slid out from under the pointer and `pointerup` landed elsewhere — no
  `click`. The bar now widens for its text field only and narrows only when
  focus leaves it altogether.
- **A grey thumb in the field.** The composer sizes its textarea to
  `scrollHeight`, which is rounded: one 16 × 1.65 line is 0.4px taller than the
  height it is given. Invisible under an overlay scrollbar; a thumb on a host
  that styles its scrollbars, which this package's own docs site does. The
  field scrolls only past its five-line cap now.
- **A restored conversation that rose in.** Opening a stored conversation of one
  turn is also "one more turn than there was". Restored turns carry `restored`,
  and that is excluded.
- **A popup blur that leaked.** The pop's knobs are custom properties, which
  inherit: the popup's 4px blur reached every bubble inside it and none inside
  the drawer. They are registered with `inherits: false`.

## API

Additive, except for one default: `'auto'` with `fab` resolves to `'bar'`
where it resolved to `'popup'`.

| | before | after |
|---|---|---|
| `ui.panel` | `'auto' \| 'drawer' \| 'popup'` | `+ 'bar'`; `'auto'` with `fab` → `'bar'` |
| `ui.side` | — | `'end' \| 'start' \| 'left' \| 'right'`, default `'end'` |
| `ResolvedUi` | | `+ side`; `panel` gains `'bar'` |
| `<html>` classes | `docpilot-push` | `+ docpilot-push-start`, `-end`, `-closing` |
| i18n | | `+ composer.expand` |
| tokens | `--dp-dur: 220ms`, `--dp-ease: cubic-bezier(…)` | `--dp-dur: 400ms`, `--dp-ease: linear(…)`; `+ --dp-ease-pop`, `--dp-ease-exit`, `--dp-bar-inline`, `--dp-bar-inline-open` |

`mountDocPilot`, the components, the exports, the CLI's flags and every other
key keep their names, values and defaults. `fabLabel` and `fabIcon` dress the
corner button only, so under the shipped bar they do nothing. `npx docpilot init --panel=bar`
works because the CLI reads `UI_PANELS`.

## What this does not do

**A resizable sidebar.** Inkeep's can be dragged between 250 and 600 px. The
drawer is `--dp-width` and stays a token.

**Search results in the bar.** The bar asks; it does not list pages as the
reader types. The panel's search-only fallback is unchanged.

**A morph from the button into the panel.** A shared-element FLIP from the
floating button's box to the popup's would need both boxes measured on every
open and a clip-path animation on the popup; the scale-from-the-corner entrance
says the same thing — *it came from here* — at none of that cost.

**Push on a host with no adapter.** There is no element this package can
safely move on a page it does not know. The classes are the contract.
