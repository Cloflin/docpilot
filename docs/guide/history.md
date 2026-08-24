# Conversation history

The panel keeps the reader's conversations on the reader's own device, and lists them behind the clock button in its header.

Nothing here reaches your servers. This page is about what is written, where, and how it is removed — because a store that outlives the browser tab is worth stating plainly rather than discovering.

## What the reader sees

The list opens from the clock button in the panel's header and appears **directly under it**, above the conversation — a disclosure opens where its trigger is, and picking a row replaces the whole thread, so it is navigation rather than something to hold the composer still for.

A conversation appears in the list once it has an answer in it. The row is titled with the first question asked in it and dated relative to the last one — "3 hours ago", in the page's language.

- **Open** a row to switch the panel to that conversation and carry on in it.
- **New chat** — the compose button in the header — lets go of the conversation on screen without deleting it. It is still in the list.
- **Delete** a row with the bin beside it. Deleting the conversation currently on screen empties the panel too. Pointing at the bin lights it as a darker chip inside the lighter row, so the thing under the cursor is unambiguous — `×` in this panel always means *dismiss*, and this is the one control with nothing behind it.
- **Delete all** clears the list and the panel in one step. It asks twice, and never through a browser dialog.

Reloading the page brings back the conversation that tab was in. Following a citation into a new tab starts a fresh conversation there — see [Two tabs](#two-tabs) below.

## What is stored

Per turn:

- the question **as it was redacted** — a pasted key is caught before the turn exists, so the mask is what is written, and the mask is what titles the row (see [Credentials in questions](/guide/credentials));
- the passage it was asked about, if the reader quoted one — without it a restored thread shows "what does this mean?" above an answer with no *this* on screen. It is redacted on the same rule and capped at 500 characters. The row is still titled by the first **question**: a title taken from a quote would be a title the reader did not write;
- the answer text, its source links, and whether the reader voted on it;
- the scope the question was asked in, and the gate numbers a feedback report reads.

What is **not** stored:

- **the model's reasoning** — the largest field on a turn, and a scratchpad rather than an answer. A restored turn has no reasoning disclosure at all;
- **the retrieved excerpts** — kilobytes per turn. The only consequence is that a vote cast on a restored turn reports no retrieved ids;
- **the rendered HTML.** It is recomputed on restore, which is not only smaller but more correct: a link to a page that has since been deleted comes back as plain text rather than as a link into a 404;
- **the reader's own instruction.** That stays in `sessionStorage` and still dies with the tab.

## Where

Two keys, in two different storages:

| key | storage | what |
|---|---|---|
| `docpilot:history` | `localStorage` | the archive — every conversation, shared by every tab of the site |
| `docpilot:conversation` | `sessionStorage` | which conversation *this tab* is showing |

Both are on the reader's device, under your site's origin, and neither is ever sent anywhere. The one thing that leaves the browser is a vote — with whatever reasons and sentence the reader attached to it — and only when you have configured `feedbackEndpoint`. Which verdicts travel is [`feedback.send`](/reference/config#feedback-send); `'none'` keeps the thumbs on screen and sends nothing at all.

## Two tabs {#two-tabs}

A new tab starts a new conversation instead of adopting the one another tab is mid-way through — that is what the second key is for. Both tabs see the full list, and each writes by re-reading it first, so neither erases the other's rows.

Two consequences worth knowing:

- The list is re-read when the switcher **opens**, not continuously. A conversation started in another tab a moment ago appears the next time the list is opened.
- Deleting a conversation that another tab is actively using brings it back when that tab writes its next turn. That is the safer of the two available failures: the alternative is a tab that silently stops saving anything for the rest of its life.

## When the docs change

Rebuilding the index does not throw the archive away. An older conversation still opens; the panel says so above it:

> The docs have changed since this conversation. Some links may no longer work.

Answers are re-rendered against the *current* index, so links to pages that no longer exist come back de-linked. A source row underneath an answer is different — it is a fixed address written at the time — and can still point at a page that has gone.

## Turning it off

```js
history: { enabled: false }
```

This stops recording **and clears what is already stored**, on the reader's next visit. See [`history`](/reference/config#history) for the cap and its byte ceiling.

There is no expiry, deliberately. The list is bounded by its length instead, because "it fell off the end of a twenty-slot list" is something a reader can reason about and "it disappeared on its own" is not.
