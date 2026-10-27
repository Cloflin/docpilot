# 018 — Actions the answer offers

The reader-facing half of [engine-spec 038](../engine-specs/038-tools-the-site-adds.md).
That spec decides what a site's tool is, what the model may do with it, and what
runs. This one decides what the reader sees: an action under the answer, the
form some actions open, the source row a function tool's result becomes, and the
status line while a tool runs.

## Problem

An answer can now carry `actions` — up to three of the site's own, each with
arguments the model filled in — and can cite a result that came from the site
rather than from a page. The panel has no element for either, and the four
things a reader needs from them are not optional:

1. **What will happen**, before it happens: the action's name and, for a form,
   every value that will be sent.
2. **A choice.** Run it, change it, or ignore it. Ignoring it must cost nothing:
   no dialog, no nag.
3. **What did happen.** "Sent", or the site's own reply, or that it failed —
   in place, and announced.
4. **Where a fact came from** when it came from the site: a source row that does
   not pretend to be a page.

## Research

The approval card is the one pattern the human-in-the-loop libraries converge
on — MUI X Chat's tool approval, the AI SDK's human-in-the-loop recipe,
Gumloop's approval card, Haystack's confirmation strategy. The card names the
tool, shows its intent and its arguments, and offers approve, edit or deny,
inline in the conversation. Two of their choices are deliberately not taken
here:

- **"Don't ask again for this tool."** An action here is the reader's to start,
  every time. Remembering a yes turns the next prompt injection into a click
  the reader never made.
- **Blocking the composer until the card is answered.** These actions sit at the
  end of a settled answer, so there is nothing to block. Ignoring an action is
  the most common answer to it, and it must stay free.

## Decision

### Placement and order

The action group sits between the answer and its sources, on a `complete` turn
only. A refusal, an aborted turn and a turn still streaming show none: an action
is a next step *from an answer*, and there is no answer to step from.

### A button action (`confirm: true`)

One pill per action — the existing `.docpilot__suggestion`, inside a
`.docpilot__suggestions--inline` group with `role="group"` and
`aria-label` = `tools.groupLabel`. The pill's text is the tool's `label` from the
config, which is author text and never model text. Its accessible description
names the arguments the model chose — `plan: pro` — because "Open pricing" for
the wrong plan is a different action from the one the reader read.

A press runs it. While it runs, the pill is `aria-disabled` and reads
`tools.running`.

### A form action (`confirm: 'form'`)

The pill opens a form under the group. The form is the feedback form's shape:
`.docpilot__feedback`, fields, then one row of `.docpilot__text-btn` buttons —
the action's label to send, `tools.cancel` to close.

| parameter | control |
|---|---|
| `string` | `<input>` in `.docpilot__comment`; `format: 'email'` / `'uri'` / `'date'` set the input type |
| `string`, `format: 'multiline'` | `<textarea>` in `.docpilot__comment`, three rows |
| `number`, `integer` | `<input type="number">`, with `minimum` and `maximum` as `min` and `max` |
| `enum` | pressed pills, one per value — `.docpilot__text-btn` with `aria-pressed`, the same answer the reasons row gives to "a checkbox wants a resting border" |
| `boolean` | one pressed pill |

Every field has a visible label: the parameter's `description`, or else its
name. A required field says `tools.required` beside it. The model's arguments
fill the fields, and the reader may change any of them. Sending runs the same
check that engine-spec 038 runs on the model's arguments. A failed field gets
its message under it, and nothing is sent.

Focus moves to the first field when the form opens. On cancel or after a send,
focus returns to the pill.

### After it runs

A `.docpilot__meta` line replaces the pill's place in the group, in
`aria-live="polite"`:

- **Done.** The site's own reply when there is one: a string, or `message` in
  a JSON reply. Otherwise `tools.done`.
- **Failed.** `tools.failed`, and the pill comes back, so the reader can try
  again.
- **Unavailable.** `tools.unavailable`, when the page has no runner for an
  action that the server proposed. The pill is drawn disabled from the start.

A `href` action leaves the page. That is its result, and it needs no line.

### A source that is the site

A cited tool result is a row in `.docpilot__sources` like any other: its
number, the tool's `title`, then ` · ` and `tools.fromSite`. It has no link,
because there is no page to open, and the marker in the answer renders as the
same number without an anchor. The row has no passage disclosure, because the
result was data and not a passage the reader can check against a page.

### While a function tool runs

The status line reads `status.tool` with the tool's title — "Checking Plan
limits" — in the same place, and at the same rhythm, as "Searching the docs".

### Not kept

Actions are not archived. A restored conversation shows its answers and its
sources, not its actions. A reader who reopens yesterday's thread does not
expect yesterday's "Contact support" to still be waiting, and must not be able
to send it twice by accident.

## Rules

Nothing here adds a ring, a border, a radius, a type size, a colour or an
animation. Every element reuses a class that `scripts/check-docpilot.sh` already
polices: `.docpilot__suggestion`, `.docpilot__feedback`, `.docpilot__comment`,
`.docpilot__text-btn`, `.docpilot__meta`, `.docpilot__sources`. So rule 1b's
ceiling stays 22 of 22, and the check is not edited.

**Rule 009's switch** is the key itself. With `tools: null`, which is the
default, nothing in this spec renders. Each action is removed by removing it
from `tools`. `confirm` is the author's decision about whether the reader must
act, and the reader always does for anything that is not a read.

## Strings

One new group, `tools`, and one key in `status`. The table in
`docs/guide/i18n.md` and the counts printed beside it move together:

| key | default |
|---|---|
| `tools.groupLabel` | `Actions` |
| `tools.running` | `Working` |
| `tools.done` | `Done.` |
| `tools.failed` | `That did not work. Try again?` |
| `tools.unavailable` | `This action is not available on this page.` |
| `tools.cancel` | `Cancel` |
| `tools.required` | `required` |
| `tools.invalid` | `Check this value.` |
| `tools.fromSite` | `from the site` |
| `tools.argsLabel` | `With {args}` |
| `status.tool` | `Checking {label}` |
