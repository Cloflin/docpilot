# 002 — The header divider appears on scroll

> **Partly superseded by [000](000-design-system.md).** The mechanism below is
> unchanged and still ships: a border declared `transparent` and switched by
> colour, so the 1px never enters or leaves the box model. What is superseded is
> the border-budget table under *Rule 1* — the hairline is now one of ten rings
> rather than one of six exceptions, and rule 1 is a claim about a border's
> **shape** instead of a count.

## Problem

The header has no divider at all today: "the 56px band and the thread padding
separate" (`core.scss`). That reads correctly at the top of an empty panel and
badly once the thread is scrolled — an answer's text slides under the title with
nothing to say the header is a fixed layer above it.

The reverse — a permanent hairline — is worse. At rest the panel's chrome is one
uninterrupted surface, and a resting rule under the title is a second boundary
competing with the panel's own edge.

So: **absent at `scrollTop === 0`, present the moment the thread moves.**

## Research

- **CSS scroll-state queries** (`container-type: scroll-state` +
  `@container scroll-state(stuck: top)` / `(scrollable: top)`) are the native
  answer and were the first candidate. `modern-web-guidance`'s
  *state-aware-sticky-headers* guide confirms availability: **Chrome/Edge 133+,
  unsupported in Firefox and Safari.** For a package that ships onto arbitrary
  docs sites that is a majority-of-readers miss on the one cue that says "there
  is more above". Rejected as the primary mechanism; not added as a
  progressive-enhancement second mechanism either, because two implementations of
  one hairline is the drift these specs exist to stop.
- The guide's own documented fallback — *"duplicate your CSS styles under an
  `.is-stuck` class"* — is what ships. The panel already listens to `wheel` and
  `touchmove` on the thread for autoscroll pinning, so a class toggled from
  scroll position is the existing idiom rather than a new one.
- `IntersectionObserver` on a sentinel is the other standard fallback. Rejected:
  it needs a sentinel node inside the scroller, and the state wanted here is the
  simplest possible predicate — `scrollTop > 0`.
- **`better-ui` 11** — never `transition: all`. The transition names
  `border-color` and nothing else.

## Decision

`DocPilot.vue` keeps a `scrolled` ref, set from a **passive** `scroll` listener on
`.docpilot__thread`:

```
scrolled = el.scrollTop > 0
```

`.docpilot__header` carries `is-scrolled` from it.

```scss
.docpilot__header {
  border-block-end: 1px solid transparent;
  transition: border-color var(--dp-dur-fast) linear;

  &.is-scrolled { border-color: var(--dp-line); }
}
```

**A transparent border, not a toggled one.** The declaration is unconditional, so
the 1px never enters or leaves the box model and the header cannot shift the
thread by a pixel when the state flips. The state change is a colour, which is
the only thing that transitions.

Why a border rather than a `box-shadow` or a pseudo-element: the shadow would be
erased by `forced-colors`, and a pseudo-element would need its own stacking
context over a scroller. A border-colour transition is one declaration and
degrades to a visible line in every mode.

## Rule 1 — the border budget

This adds the **fifth** border declaration in `core.scss` + `vitepress.scss`.
`scripts/check-docpilot.sh` moves from `≤ 4` to `≤ 6` (the sixth is
[003](003-history-dock.md)) and its selector allowlist gains
`docpilot__header`.

The rule's intent is unchanged and worth restating in the script: **a hairline
that paints at rest must be named.** This one does not paint at rest — at
`scrollTop === 0` it is `transparent`.

Named budget after 002 and 003:

| # | selector | when it paints |
|---|---|---|
| 1 | `.docpilot__panel--drawer` | always, desktop drawer only — the panel boundary |
| 2 | `.docpilot__sr` | `border: 0`, a reset |
| 3 | `.docpilot__picker` | only while the scope picker is open |
| 4 | `.docpilot__picker-acts` | only while the scope picker is open |
| 5 | `.docpilot__header` | only once the thread is scrolled |
| 6 | `.docpilot__dock` | only while the conversation list is open |

## Accessibility

Decorative. The header's role is unchanged and nothing is announced. Under
`forced-colors` the border resolves to the system border colour and the cue
survives — which a shadow would not.

## Checks

- `npm run check` — rule 1 count and selector list updated in the same commit.
- No new font size, no animation, no `infinite`.
