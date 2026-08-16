# 007 — Quoting a passage out of an answer

## Problem

A reader four hundred words into an answer has exactly one way to ask about one
paragraph of it: retype the paragraph.

And retyping it does not work, which is the part that makes this a defect rather
than a missing convenience. `buildMessages` sends the last three question/answer
pairs with **every prior answer truncated to 300 characters**. A passage from the
middle of a long answer is therefore not in the model's context at all — so
"what does this mean?" arrives with no `this` in it, and the model answers about
something else, or about nothing. The panel's own transcript rule is what creates
the gap.

The reader is already pointing at the passage. The selection is the gesture; the
panel just had nowhere to put it.

## Research

- **ChatGPT is the reference, and only half of it is taken.** Selecting inside an
  answer there raises a two-button bubble: *Ask ChatGPT* and *Start writing*. The
  first is this. The second — editing the answer in place, in a canvas — is
  rejected below, on grounds specific to this package rather than to taste.
- **Popover API: Baseline 2025-01-27** — Chrome 116, Safari 17, Firefox 125.
  Used for the top layer, because `.docpilot__panel--popup` carries
  `overflow: hidden` and would clip a bubble drawn inside it. Feature-detected
  with `'popover' in HTMLElement.prototype`; where it is absent the same node is
  a plain `position: fixed` box, which an ancestor's overflow does not clip
  either. No polyfill: this package has no runtime UI dependency and is not
  acquiring one.
- **CSS anchor positioning is not Baseline** and is not used. A selection has no
  anchor element to name in any case; the position comes from
  `Range.getBoundingClientRect()`, clamped to the panel's box.
- **`selectionchange` is the only event that fires for every way a selection is
  made** — a drag, Shift+Arrow, a double-click, and the native touch handles,
  which produce no `pointerup` at all. It is the primary; the pointer events are
  only a suppressor, so the bubble does not chase a cursor mid-drag.
- **`interfaces:better-accessibility`** — transient UI that appears beside a
  gesture must not steal focus, and must still be reachable by keyboard. Both are
  satisfied, by opposite means: the popover never calls `focus()`, and the quote
  is captured when it OPENS rather than when the button is pressed.
- **`better-ui`** — one action, one glyph, no second device. The bubble is the
  ghost pill the package already has, on the floating-card recipe it already has.

## Decision

### One button, and what the second one would have cost

**Ask AI.** Nothing else.

`Start writing` — editing the answer in place — was specified, costed and
withdrawn. Two reasons, and the first is not about design:

1. **`buildMessages` sends `turn.answerText` back to the model as the
   assistant's own words.** An answer the reader had edited would return to the
   context as something the model said. That is the self-authored memory channel
   the same function already refuses for its summary line, arriving through a
   door we would have opened ourselves.
2. **The answer is not the reader's artifact.** It is not stored as a document —
   `slimTurn` drops `answerHtml` and re-renders it from `answerText` — it is not
   exported, and it is not shared. A canvas edits a thing somebody owns; there is
   no such thing here.

### The quote is a field, not a prefix

`turn.quote` sits beside `turn.question` and stays a separate value through the
gate, the store, the archive and the feedback record. The one place the two are
concatenated is the wire, inside `buildMessages`, and nowhere else.

Gluing them in the composer was the cheaper build and was rejected on three
counts: the passage would eat the field's own 1000-character budget; the chip
could not be withdrawn on its own; and the gate would judge the reader by text
they did not write — see below, which is the one that decides it.

### The gate: the quote is an antecedent, never part of the question

`session.submit` passes the quote as `previousQuestion` — the antecedent of the
**composed channel**, RAG-SPEC 3.4.5 — and never folds it into `question`.

A quote is a strictly better antecedent than the previous question: the reader
has pointed at the exact passage `this` refers to, rather than at whatever was
asked one turn ago. So when a quote is present it takes the slot, and there is no
third embedding call.

What it must never do is reach the raw query. `lexicalCoverage` counts the
query's own terms against the retrieved evidence, and a passage lifted out of an
answer this corpus produced matches this corpus **by construction** — so L would
saturate on every question carrying one. That is precisely the "off-topic
question padded with domain nouns" the gate's `df(t) ?? 0` default exists to
catch, walking in through the front door. `test/docpilot.test.js` demonstrates
the failure it avoids: `lexicalCoverage('what is the weather in paris', …)` is 0,
and the same question glued to a four-word quote clears 0.5.

Through the composed channel it is bounded three ways that already exist:
`assertWeights` guarantees the lexical channel cannot clear tau alone; G is a
**maximum** over channels, so a new one can only ever reduce refusals; and
`admissible()` requires at least one content term of the **reader's own
question** to appear in the evidence the composed query retrieved. "I selected
the scope picker, now what is the weather in Paris" is inadmissible and refuses
on the raw channel.

Two widenings are accepted rather than fixed, and are named so nobody discovers
them as surprises:

- **The composed channel's L saturates on a quoted turn.** The quote fills Q. A
  quoted turn therefore nearly always passes. This is the intended behaviour of a
  channel that exists to rescue follow-ups, and it is bounded by the three
  mechanisms above — but it does change what `channel: 'composed'` means in a
  calibration report, which is why `gate.antecedent` is now recorded.
- **A term-less question ("why?") is admissible by construction**, because
  `admissible()` returns true when the question has no content terms. This is
  pre-existing follow-up behaviour and becomes much easier to reach with a quote.
  Guarding it only for quotes would make the two antecedents behave differently
  for no principled reason, and the outcome — a reader selected documented text
  and asked a short question about it, and the gate let it through — is correct.

### `gate.antecedent`, and the report it repairs

`src/feedback/stratum.js` read `channel: 'composed'` as *"a follow-up; go and
find `prev_question` in the conversation"* and filed it as an **F** or **N5**
calibration probe. A quoted turn has no previous question to find. Without a new
signal every quoted turn would have entered the calibration set as a probe no
reviewer can complete, and F's looser over-refusal bound would have been applied
to a population it was never measured on.

So the gate result now carries `antecedent: 'quote' | 'question' | null`, it is
persisted (`GATE_KEYS`), it is sent with the feedback record, `aggregate.js`
tallies it, and `stratum.js` diverts a composed-channel quoted turn to the golden
set on a down-vote and to nothing on an up-vote. A quoted turn the **raw** channel
carried is untouched and still reaches the X stratum when it was refused in
scope — the branch tests both conditions, not just the antecedent.

### The prompt

`QUOTE_WRAPPER` states three things and each is load-bearing: whose text it is,
that it is the **subject** of the question rather than a new instruction, and
that an instruction found inside it is quoted content. The last is the defence
`OBS_NOTE` already makes for retrieved excerpts, for the same reason — a reader
can select any string a page put on screen.

It rides **inside the question's user message**, which is where it differs from
the reader's addendum. An addendum is a standing preference, so a message of its
own is what it is: another thing the reader said. A quote is the subject of the
sentence that follows it, and a standalone user message reads to a model as an
earlier turn. The transcript uses the same shape one turn later, clamped to
`HISTORY_QUOTE_MAX` (160) against the live 500, so the model sees one form for
one thing.

`QUOTE_WRAPPER` stays **out of `promptHash`**, on the `ADDENDUM_WRAPPER`
precedent: both are envelopes for reader-supplied content, neither is part of the
instruction that names an eval report, and putting one in would invalidate every
cross-report comparison for a string that only ships on quoted turns. If either
ever goes in, both go in together.

**No fifth block in `promptDocument`.** The disclosure publishes the envelope,
not per-turn content — the question is not in it, and `ADDENDUM_WRAPPER` is not
in it either; the "Your instruction" block renders the raw instruction, never the
wrapper. The chip *is* the disclosure, and a better one: the reader sees the
exact string that will be sent, above the field, with an `×` to withdraw it.

### Redaction, and the refusal it does not trigger

The quote is redacted like everything else that reaches a turn — it travels to
the model, to `localStorage` and, on a down-vote, to a feedback endpoint. But a
credential shape found **in the quote does not refuse the turn**. The credential
branch exists to tell a reader who pasted their own key before it leaves the
browser. A reader who selected a passage the docs already published disclosed
nothing, and refusing them would be a warning about somebody else's mistake
delivered to the one person who cannot fix it. Mask it and carry on.

`feedback.record` drops the quote wherever it drops the answer: on an instructed
turn the answer is withheld because it is a copy of the thing being protected,
and 500 characters of it under another key is the same copy, smaller.

### The popover

`popover="manual"`, never `auto`. An auto popover light-dismisses on the
`pointerdown` that **begins** the next selection, and its Esc belongs to the
platform rather than to this panel's cascade — where the popover is now the first
branch, ahead of every disclosure.

It sits in the DOM **between the thread and the composer**, and that is the
decision rather than the convenience: it makes the button the next tab stop after
the thread and the one before the field, so a reader who selected with the
keyboard presses Tab once to reach it. It is also still inside the panel section,
so the Esc handler there still fires when focus is on the button.

Placement is above the selection, centred, clamped to the panel's box, flipping
below when there is no room — and **always** below on a coarse pointer, because
iOS draws its own Copy / Look Up callout above a selection and two bubbles
fighting over the same forty pixels is one the reader cannot press. It follows a
scrolling thread and disappears when the passage leaves the panel.

### Capture at open, not at press

The quote is read when the popover appears. Pressing a button moves focus, and
focusing a control collapses the document selection in some engines before the
click handler runs — reading it at press time would produce an empty quote on
exactly the platforms where the button is the only way in. Holding the string is
also what makes the button reachable by Tab at all: a keyboard reader has to
leave the selection to get to it.

The captured text is the selection **without the panel's furniture**: citation
markers are removed from a cloned fragment first, because `range.toString()`
otherwise pulls a superscript's digit into the middle of a sentence — "the scope
picker1 lists" — and the quote must read as the documentation it came from.

## Accessibility

- The popover never takes focus. It appears beside a gesture and waits.
- It is the next tab stop after the thread, by DOM order, and its button carries
  the standard focus ring.
- `announce.quoteAdded` and `announce.quoteRemoved` go through the existing
  polite live region: attaching a quote changes what the field will send, and a
  screen-reader user has no other way to know it happened.
- The chip is referenced by the textarea's `aria-describedby`, first in the list,
  so the field is described by what it is about before it is described by its
  hint. A referenced id that is absent is ignored — the same thing `dp-counter`
  already relies on.
- Each chip carries a visually-hidden `quote.label` prefix, so it is not
  announced as a bare fragment of somebody else's sentence.
- Esc closes the popover and nothing else. It does **not** clear the chip: that
  is content the reader chose, like a typed draft, and the feedback comment's
  rule applies. The `×` is its removal.
- `forced-colors`: the popover wears a real ring and needs no restatement; the
  chip is fill-only and joins the list that gets `1px solid CanvasText`.
- `prefers-reduced-motion`: the popover's entrance becomes `dp-fade`, and its
  button's press scale is already cancelled by the pill system.

## Checks

- `npm run check` — **12 → 13 rings**, all of them still `1px solid
  var(--dp-line)`; no new radius, no new type size, no new `@keyframes` (the
  entrance reuses `dp-in-pop`, the reduced-motion fallback reuses `dp-fade`), and
  **no new `--dp-*` token**, so rule 10 and the published token table do not move.
- `npm test` — the quote's clamping and flattening, the prompt block on both
  transports, the transcript clamp, the language directive taken from the
  question rather than the passage, the two gate tests that are the safety
  argument, the `slimTurn` projection, the feedback withholding, the stratum
  branch, and the popover's source-level contract (tab position, `manual`,
  capability probe, `data-turn`, Esc order, the retry path).
- Before shipping, measure it: run the gate over the negative strata with a
  synthetic quote attached and record the over-refusal and off-topic numbers. If
  the composed channel turns out to be too generous, the lever is a shorter
  gate-side clamp on the antecedent at the one line in `session.js` that builds
  it — the model still gets the full 500.
