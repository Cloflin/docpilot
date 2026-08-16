# 008 — Editing a question, asking it again, and finding the way back down

## Problem

Four gaps, one surface, and they are one change because they are all the same
omission: **the thread is a transcript the reader cannot act on.**

**A question cannot be copied.** The answer can — `.docpilot__actions` has
carried a copy button since the panel existed. The question above it is a
`<p>`. Selecting sixty words of it inside a 360px drawer, with a selection
listener watching for a passage to quote, is not the same gesture.

**A question cannot be corrected.** The reader who typed *"how do i authnticate"*
and got a refusal has one move: type the whole thing again. Every other re-ask
path in this package — `error.retry`, `refusal.widen`, `askWithoutSecret` —
re-runs a question the panel already holds, because retyping is understood to be
the failure. The one case where the reader *wants* to change the words is the one
case with no path.

**A refusal cannot be tested.** *"I couldn't find this in the docs"* is a verdict
about **one retrieval**, and retrieval is not a constant: it moves with the
index the site last built, with the scope in force, and with whether the
embedder answered — when it does not, search degrades to BM25 alone and a
question in another language has no lexical overlap left to score. The reader has
no way to ask again except to retype the question, and the panel's own
`error.retry` proves that retyping is understood to be the failure.

**A long thread has no way back down.** The autoscroll disengages on intent
(wheel, touch) and re-engages only on the next submit. A reader who scrolls up to
re-read the second answer, in a thread of ten, gets back to the newest one by
scrolling — through everything they just read, on a panel that is one column wide.

## Research

- **ChatGPT is the reference for all three**, and the measurements come from the
  same reproduction 000 already cites. Its question row is hover-revealed, sits
  under the bubble at the bubble's edge, and holds copy / share / edit. Its editor
  replaces the bubble in place and keeps the rest of the turn on screen. Its jump
  control is a small round button above the composer.
- **Two of its three buttons are taken.** *Share* is not: this package has no
  hosted conversation and therefore nothing to link to, and `navigator.share` on a
  string of text is unavailable on most desktops — a control that falls back to
  the button beside it is a control that should not exist.
- **The pill is oblong, not round.** The reference's is round; this package has
  exactly two circles — the send button and the FAB — and both are the primary
  action of their surface. A third circle for a navigation aid would flatten that
  distinction. `--dp-r-pill` on a 48×32 box reads as the same family without
  claiming the rank.
- **Editing does not branch.** ChatGPT keeps both versions behind a `‹ 1/2 ›`
  switcher. Rejected: it needs a version list on every turn, a schema migration
  for the archive (`SCHEMA = 1`), and a control that appears on a turn the reader
  edited once and never again. The thread truncates instead, which is what the
  reader means by *"no, ask this instead"*.
- **`interfaces:better-accessibility`** — a control revealed on hover must be
  reachable without one. Both rows inherit the existing `(hover: none)` rule that
  makes them resident on touch, and the editor is opened and dismissed entirely
  from the keyboard. The pill goes further and leaves the tab order when it is
  not actionable.
- **`better-ui`** — one row, one reveal. The question row does not get a hover
  trigger of its own: a hover scoped to the bubble needs a bridge across the gap
  to the row below it, and a bridge is where hover reveals begin to flicker.

## The change

### Truncate, then re-ask — `truncateAndAsk`

```js
function truncateAndAsk(turn, question) { … }    // → boolean, private
export function editTurn(turn, question) { … }   // the words changed
export function retryTurn(turn) { … }            // the words did not
```

**Two paths that truncate, against three that append.** `error.retry`, `widen`
and `askWithoutSecret` re-ask the same question and leave the old turn where it
is, because the old answer is still a true record of what was asked. These two
withdraw the answer itself, and with it everything said after: the history this
panel hands the model is `state.turns.slice(0, -1)`, so a turn left behind would
go on answering text that is no longer in the thread — once per turn, for the
rest of the conversation.

The guards live in the shared half and all run before the `splice`, returning
`false` so a caller can leave its editor open rather than dropping a draft into a
thread it never reached: empty text · `state.busy` · `state.degraded` · a turn
not in this thread. **Busy is the one that would corrupt rather than no-op:**
`stop()` aborts the controller, but `state.busy` is cleared asynchronously in
`finishTurn`, so a nested `submit` would return early and leave the thread short
by one turn with nothing in its place.

The two exported halves differ by one guard each and by which line is announced.
`editTurn` refuses text identical to the question — that is `retryTurn`, and it
is a different button. `retryTurn` adds nothing, because "the same question" is
the whole point of it.

### Where Ask again is offered, and where it is not

In the answer's action row, on `complete`, `no-answer` and `aborted` — and first
in the row on a refusal, where copy is absent and the verdict is the thing the
reader most wants to test.

**Withheld from a credential or a social turn**, and the component decides that
rather than the session: both settle from a template before retrieval, with no
model call to run differently a second time, so the control would visibly do
nothing. The credential turn already carries the button that *is* its retry —
*ask without the secret*.

The glyph is `history`'s arc **mirrored**. One shape in this package says "around
again", and which way it turns is the whole difference between going back to
something and running it forward.

`saveCurrent()` fires immediately after the splice, where the archive is
otherwise written a whole answer later. Without it a reader could truncate a
thread, close the panel mid-answer, and reopen the conversation with the deleted
turns restored.

**The row's title moves when the first question is replaced.** `history.js`
compared `previous?.title || …`, which froze the title at the first question
forever. It now compares the **id** of the head turn: unchanged while the
conversation merely grows, replaced when `editTurn` pushes a new head. A row
still named by a question the reader deleted is the same "cannot find it again"
the original rule was written to prevent, from the other direction.

### The editor is component state, not turn state

`editingId` and `editDraft`, two refs. A turn is the transcript — archived,
attachable to a feedback report, handed to the model — and a draft is none of
those. One `editingId` makes "at most one editor is open" structurally true
rather than an invariant maintained in a loop. And the object a per-turn flag
would live on is the one `editTurn` destroys.

Escape discards the draft, where the feedback comment's is kept: the original
question is still one line above, unharmed, while a comment exists nowhere else
once it is gone. The branch sits **below** `if (askOpen.value)` in `onEsc`, which
keeps the popover's first claim on the key.

### The empty state waits for the thread

`v-if="!s.turns.length && !s.busy"`. Editing the first question empties
`state.turns` for the width of one flush before the replacement is pushed, and a
greeting that blinks through that gap reads as the panel resetting itself. The
same guard covers every other path that empties the thread while work is running.

### Two signals, not one — `atBottom` beside `pinned`

`pinned` answers *"keep chasing the answer?"* and answers it from **intent** — a
wheel, a finger — because smooth scrolling makes a `scroll` event
indistinguishable from user input. `atBottom` answers *"where is the reader
now"*, and position is exactly what it should read. Folding them together would
put the scroll event back into the autoscroll decision, which is the rule
`pinned` exists to keep.

`atBottom` is written from the scroll handler, from inside the autoscroll's own
`requestAnimationFrame` (after the write, so a growing answer cannot flash the
pill in for one frame), and from the three places that swap the thread's contents
without reliably producing a scroll event — the same three that already reset
`scrolled`.

## What this moves in 000

- **§Elevation** — two new rings (15 of 20), and the jump pill named as the case
  that tests "only three things float" without breaking it.
- **§Component recipes** — three entries: the question row, the question editor,
  the jump pill and its rail.
- **§Question bubble** — its bottom margin is 2px; the 18 that left went to the
  row below it, which is transparent at rest.

## What is checked

`scripts/check-docpilot.sh` needs no new rule — every clause above is already
policed by one. `test/docpilot.test.js` adds the truncation itself for both
paths (through the social seam, where a re-ask settles with no transport), the
archive write, the four refusals, the title rule, the mirrored glyph, and a
source-read contract for the parts that have no DOM to test against: the row is
under the bubble, the rail is between the thread and the popover, the pill leaves
the tab order, Ask again is withheld from the two template turns, and Esc still
reaches the popover first.
