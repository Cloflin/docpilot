# 003 — Past conversations open above the thread

> **Stands.** [000](000-design-system.md) reconsidered turning the dock into an
> inset card — the OpenAI-shaped alternative — and rejected it again: a card
> holding a 32dvh scroller, inside a 420px column, is heavier than the band it
> would replace. Type and radius inside it follow 000.

## Problem

The conversation list opens **inside the composer**, at the bottom of the panel,
because it was built on the scope picker's shell and the scope picker belongs
there — it is anchored to the scope button it is opened from, which sits in the
footnote row.

The history button is not there. It is in the **header**, top right, beside New
chat and Close. Pressing a control at the top and having a panel appear at the
bottom breaks the one rule a disclosure has: it opens where its trigger is.

It is also the wrong end of the panel. The list is a navigation surface — pick a
past conversation and the whole thread is replaced — and a navigation surface
that pushes the composer around while you read it is a surface you have to hold
still to use.

## Research

- ChatGPT, Claude and Gemini all put conversation switching at the **top** of the
  surface (a sidebar's top, or a top-anchored popover from a top-bar control).
  None of them put it under the composer.
- WAI-ARIA APG *Disclosure*: the disclosed content is adjacent to its trigger. The
  trigger keeps `aria-expanded` and `aria-controls`; nothing about the pattern
  changes when the content moves, so the existing focus contract carries over
  unchanged.
- **`better-layout`** — reading order. Header → what you are switching to →
  thread → composer is source order and visual order at the same time. The
  current arrangement is neither.

## Decision

The `dockPanel === 'history'` block moves out of `.docpilot__composer` and
becomes a sibling **between the header and the thread**.

```
┌ header ──────────────────┐  divider on scroll (002)
├ dock — past conversations ┤  only while open; own bottom hairline
├ thread ───────────────────┤
└ composer ─────────────────┘  scope picker and prompt stay here
```

The scope picker and the prompt document **stay in the composer**: both are
opened from the footnote row directly above it, so both are already adjacent to
their trigger. Only history moves. `dockPanel` remains one value — at most one
disclosure is open, whichever end it opens at.

### It stops borrowing the picker's shell

Today the list wears `docpilot__picker docpilot__history` and inherits a
`border-block-start` — a top rule, correct under a thread, wrong under a header.
Inverting it by overriding would mean a `border-block-end: none` somewhere, which
is still a border declaration to the check script and reads as an undo.

So it gets its own minimal shell, `.docpilot__dock`:

- one `border-block-end` — the boundary against the thread;
- **no** inner rule under the actions row: at the bottom of the panel the actions
  row needed a line to separate it from the rows below, but under a header the
  dock's own bottom edge is the only boundary the block needs;
- full-bleed, like the picker: the gutter is cancelled and restored as padding,
  because a line inset 20px reads as an underline on the row above it;
- the list keeps `max-block-size: min(240px, 32dvh)` and scrolls inside itself,
  so the thread never loses more than a third of the panel.

Everything else is reused verbatim — `.docpilot__picker-label`,
`.docpilot__text-btn`, `.docpilot__icon-btn`, `.docpilot__source*`,
`.docpilot__history-row`, `.docpilot__history-open`.

## Focus and keyboard

Unchanged, and that is the point of keeping the ids:

- `#dp-history` is still the dock's id, so `toggleDock('history')`'s
  `#dp-${which}` focus call still lands on it;
- `aria-controls="dp-history"` on the header button still resolves;
- `closeDock()` still returns focus to `#dp-history-btn`;
- the Esc cascade is unchanged — Esc inside the dock closes the dock.

One thing does change: `onEsc` tests `.docpilot__picker` / `.docpilot__prompt`
containment to decide whether Esc is closing a *disclosure* or the *panel*. The
dock is no longer a `.docpilot__picker`, so that test gains `.docpilot__dock`.
Without it, Esc from inside the conversation list would fall through and close
the whole panel.

## Rule 1

Adds the sixth border declaration. See the named budget in
[002](002-header-hairline.md); `scripts/check-docpilot.sh` allows
`docpilot__dock` alongside `docpilot__picker`.

## Checks

- `npm run check` — rule 1.
- No new type size: the dock uses 13px (label) and the source row's existing
  14/13 pair.
