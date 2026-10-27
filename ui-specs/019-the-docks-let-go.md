# 019 — The docks let go

The scope picker and the conversation list close when the reader moves on: a
press in the thread, or typing in the composer.

## Problem

Both docks closed three ways — their own `×`, their opener pressed again, and
Esc. None of the three is what a reader does next. A reader who opened the
picker, looked, and went back to the question typed it with the picker still
open over the composer. A reader who opened the conversation list and then
pressed into the thread to read on read it with a third of the panel still
taken by the list. Each dock outlived the moment it was opened for.

## Research

- The HTML `popover="auto"` light dismiss closes a popover on a press outside
  it and on Esc. It is the platform's answer for a surface that is open only
  while it has the reader's attention.
- The WAI-ARIA APG *Disclosure* pattern keeps the content open until its button
  is pressed again. The docks are disclosures by markup, and that stays true:
  the opener still toggles, and `aria-expanded` still tracks it.

The docks take the light dismiss's rule, narrowed to the two moves that say the
reader is done with them. A press anywhere outside is too wide here: the
footnote row that opens the picker, the header that opens the list, and the
composer field the reader clicks into before typing are all outside, and none
of them means "done".

## Decision

- **A press in `.docpilot__thread` closes either dock.** On `click`, not on
  `pointerdown`. The conversation list sits above the thread, in flow; closing
  it on the press moves the thread up under the pointer before the release, and
  the click lands on another row — the defect [015](015-the-panel-opens-three-ways.md)
  measured on the bar.
- **A click is a press only when a pointer made it.** Three clicks reach the
  thread without one, and none closes a dock:
  - Enter or Space on a control in the thread — Copy, a citation, feedback.
    The click it synthesises has `detail` 0.
  - The end of a drag that selected text. It lands on the common ancestor, and
    the "Ask AI" button is already placed on the selection; the thread moving
    up would leave it over other lines. A non-collapsed selection skips it.
  - Chromium's scrollbar on the thread. The click reaches the element, and the
    thread would grow under the thumb the reader holds. A press outside the
    thread's client box skips it.
- **Typing in the composer closes either dock.** On the field's `input` event,
  so a paste and a deletion count, and an arrow key or a focus does not.
- **Focus stays where the reader put it.** `closeDock()` returns focus to the
  opener, which is right for the `×` and for Esc. Here it would pull the caret
  out of the field between two keystrokes, so `dismissDock()` resets the dock
  without it.
- **The prompt document is not included.** It is read beside the question it
  shapes, and it keeps its three exits.

## Checks

- `test/mount.test.js` — "the docks let go": each dock closes on a press in the
  thread and on typing, and the caret stays in the field. A keyboard click, a
  click that ends a selection and a press on the scrollbar keep it open, and
  the prompt document stays open through a press and through typing.
