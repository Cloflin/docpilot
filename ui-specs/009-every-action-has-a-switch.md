# 009 — Every action has a switch

## Problem

Seventeen gaps, and they would be seventeen specs if they did not share one
omission. They do, and it is not any of them individually:

**This package has no rule about what a project is allowed to remove.**

Four settings groups exist — `scope`, `history`, `prompt`, `feedback` — and each
was added when somebody needed it. Nothing says a *new* reader-visible action has
to arrive with one. The evidence that this matters is already in the codebase, in
`themeDocPilot`'s own comment: `docPilot.suggestions` was read by the client and
never emitted by the build, so for the whole life of the setting the fallback was
the only branch that could run. A documented knob whose only reachable value was
its default. Nothing failed; nothing was visible in a diff.

That is the shape of the problem, and it points the other way too. This package
mounts into somebody else's documentation. The README states the consequence
plainly — *a dependency that can fail someone else's docs build the moment it
lands is a dependency they remove* — and seventeen new visible behaviours
arriving on an `npm update`, none of them removable, is exactly that dependency.

The seventeen themselves fall into five groups, and each group is one sentence:

**Provenance cannot be checked without leaving.** The README's honest position is
that *citation is provenance, not entailment*, which makes checking a source a
normal step of reading rather than an edge case. The only way to take that step
is a click on a source row — SPA navigation, and on a narrow screen `goSource`
calls `close()` and the thread goes with it. Meanwhile the retrieved chunk text
is already in the browser: `state.index` holds the corpus and `turn.gate.chunks`
holds exactly what the host put in front of the model this turn. Copying an
answer has the same hole from the other side — `copy(turn)` writes
`turn.answerText`, so a `[1]` pasted into a ticket arrives with nothing behind it.

**The reader can only ask from inside the panel.** [007](007-quote-a-passage.md)
lets a passage be quoted, but `answerOf()` requires both ends of the selection
inside `.docpilot__answer`. The most common gesture a documentation reader has —
select the paragraph that confused you — leads nowhere. And the first question of
a session is the slowest one, because `ensureIndex()` hangs off `open()`: the
reader's first impression of the panel is *Loading the docs index*.

**An empty panel under a narrow scope offers nothing at all.** `suggestions`
returns `[]` as soon as `scope.kind !== 'all'`, and the code says why: the
built-in three would almost certainly fall outside the scope and the gate would
refuse all of them. The reasoning is right and the result is that a reader who
narrowed the scope — who expressed intent *more* precisely than usual — is the
one shown a blank panel.

**The thread cannot be worked.** `↑` in an empty composer does nothing, where
every reader arrives expecting it to. Submitting feedback removes the form and
says nothing a sighted reader can see. A conversation can be copied one turn at a
time and never as a whole, though the artefact a support engineer wants is the
thread. And the scope picker is a flat, unfiltered list of every page in the
corpus inside a `min(240px, 32dvh)` scroller.

**The desktop panel covers the documentation it says it does not.**
`DocPilot.vue`'s own header comment states the position — non-modal, *docs stay
readable beside the answer* — and the implementation is `position: fixed` with
`inset-inline-end: 0`, which covers the host's right aside and, at 1280px, part
of the prose column.

Four further items are not features and are listed separately below, because
the rule this spec introduces has to say what it does **not** cover: a defect has
no user who would want to keep it.

---

## Research

### The reference, where there is one

000 already settles the arrangement: *OpenAI supplies the structure. The host
supplies the colour.* These are the measurements that decided the entries below.

- **`↑` edits the last message when the composer is empty.** Native ChatGPT
  behaviour on web and desktop, and the readline convention it comes from is
  older than either. B2 is a port, not an invention, and it needs no new surface.
- **Selecting inside a response offers a quote.** ChatGPT shows a quote bubble on
  selection; taking it attaches the passage to the composer. That is
  [007](007-quote-a-passage.md), already shipped here.
- **A citation previews its source on hover; a *Sources* panel sits below the
  response.** ChatGPT Search does both on desktop, and the help page says the
  hover preview does not exist on mobile, where verification means clicking
  through. That asymmetry is the argument for putting the passage on the **row**
  as a disclosure rather than only on the marker: a disclosure is reachable by
  pointer, touch and keyboard alike, and the marker already lights its row.
- **Follow-up suggestions exist and are widely switched off.** The measurement
  that matters is not that ChatGPT has them — it is that its users write custom
  instructions to suppress them, and the complaint is consistent: they are
  offered where nobody asked. That is the reason B3 defaults **off**, and it is a
  measurement rather than a preference.

### Where the reference does not reach

- **Quoting the *documentation* is not a ChatGPT pattern.** ChatGPT quotes its
  own responses; it has no host article to quote. A1 is an extension, and this
  spec says so rather than borrowing authority it does not have. The nearest real
  precedent is a browser-integrated assistant, where selecting anything on a page
  offers to ask about it — which is also why A1 defaults off: it puts a control
  on top of somebody else's prose.
- **ChatGPT's sidebar resizes.** Not taken — see *What this does not do*.
- **ChatGPT keeps both versions of an edited question behind `‹ 1/2 ›`.** Already
  rejected in [008](008-edit-a-question.md), and rejected again here.

### The accessibility pass

`modern-web-guidance` § accessibility supplies three of the four defects:

- **Semantic tables** want `<th scope="col">`. `markdown-it` runs on its default
  preset, so tables are enabled — `md.disable` names `image` and `autolink` and
  stops there — and `core.scss` has no rule for `table` inside
  `.docpilot__answer` at all: `overflow-x: auto` exists on `pre` alone. A
  comparison table is the genre norm for a documentation answer, and today one
  renders with no rhythm, no header rule, and wider than the column it is in.
- **Safari drops list semantics** from `<ul>`/`<ol>` outside `<nav>` when
  `list-style: none` is applied. `.docpilot__sources` sets exactly that, on three
  lists, each carrying an `aria-label` — which then names an element with no
  role, the one thing the same guide says not to do.
- **Live regions should be debounced, not overwritten.** The watcher on
  `s.announce` debounces 500ms and replaces the pending value, so two
  announcements inside half a second lose the first. *Quote added* followed by
  *Answer ready* is not a hypothetical pair.

`interfaces:better-accessibility`'s standing rule — a control revealed on hover
must be reachable without one — is what the picker's roving tabindex answers from
the other direction: every `.docpilot__pick` currently carries `tabindex="0"`, so
a 300-page corpus puts 300 tab stops between the picker and the composer, where
the listbox pattern expects one.

---

## The change

### Rule 11 — every reader-visible action is removable, and its switch is documented

Three clauses, modelled on rule 10, which diffs the declared tokens against the
published table for the same reason: neither drift is visible in a diff.

- **11a** — every `config.<group>.<key>` read anywhere in `src/theme/` exists in
  `DEFAULTS`. This is the `suggestions` defect, made unrepeatable.
- **11b** — every leaf key in `DEFAULTS` appears in `docs/reference/config.md`. A
  knob added and not written down is a knob nobody will find.
- **11c** — the inventory of switches is printed, the way 1b prints the rings.

**It lives in the vitest suite, not in `check-docpilot.sh`.** The rule has to
`import { DEFAULTS }` and walk a tree, and portable `grep` cannot do that. The
precedent is stated in the check script's own header: two of the original rules
moved into vitest precisely because they could not survive BSD `grep`.

**Rule 11 does not cover defects.** A bug has no user who would want to keep it,
so a switch for one is a switch that only ever gets set wrong. The four below
ship without keys and the rule's own text says so.

### The namespace is by subject

`quote.*`, `citations.*`, `composer.*` join `scope.*`, `history.*`, `prompt.*`,
`feedback.*` and `ui.*`. A single flat `features` block was considered and
rejected: this config already groups by subject, and a second organising
principle running alongside the first is two places to look for one answer.

**`citations`, not `sources`, and the near-miss is worth recording.**
`docPilot.sources` is taken — by the allowlist of origins an imported page may
name in its `source:` frontmatter, which is the object deciding what may become a
link in an answer. A cosmetic block landing on that name would have been the
worst kind of collision: one that merges cleanly and changes a security boundary
without failing anything. `citations` is the better name in its own right, being
what the panel calls them everywhere else in the code.

`suggestions` becomes a **union** rather than a replacement. It ships today as
`string[]` and is read by `resolveSuggestions`; an array stays legal and means
`{ questions: [...] }` with the behavioural defaults. `ui.fabLabel` already
establishes the union precedent in this config — `true | false | string`.

Every new resolver takes the contract the three existing ones have: **idempotent,
warn-and-drop, never throw.** These run during somebody's docs build, and a typo
in a cosmetic setting has no business failing one.

### The defaults policy

Three tiers, and the tier is decided by what the setting can disturb rather than
by how much anyone likes the feature.

| tier | default | why |
|---|---|---|
| a defect | no switch | see above |
| an action inside the panel | **on** | the panel is this package's own surface; a reader who opened it asked for it |
| an action that changes the host's layout, or paints outside the panel | **off** | an `npm update` must not rearrange somebody's documentation site |

The third tier holds exactly three: `ui.layout: 'push'`, `quote.fromDocs`, and
`ui.firstRunHint`.

Three more are off for reasons of their own, each recorded where it is resolved,
and they are the exceptions the second tier's rule does not reach:

- `suggestions.followUps` — the separate, measured reason above.
- `citations.passage` — a source row is already a link, and the disclosure is a
  second layer over one. Density inside the panel is still a decision about
  somebody's documentation site; a project that wants checking a source to be a
  normal step of reading turns it on.
- `budget.showRemaining` — the line is inside the panel, but the NUMBER is not
  the reader's. On a shared key a browser's own count is a lower bound on other
  people's spending, so *35 of 50 left* claims an authority its arithmetic does
  not have. Turned on it also states a declared `embed: false`, which is the
  other thing that limits what the next question can find.

**The asymmetry between A5 and B3 is deliberate and is the policy working.**
Copy that ships **on** has to be good for every corpus, which is why A5 does not
generate questions from headings — *"How does Introduction work?"* is what that
produces, and a default that names something the gate refuses reads to a
first-time reader as a broken panel. Copy that is **opt-in** only has to be good
enough for the project that opted in, which is why B3 may.

---

### A defect is not a feature

**Tables in an answer.** `<table>` is wrapped in a scroller — the same device the
code card uses, and for the same reason: the panel is one column and the content
is wider than it. `scope="col"` is set on header cells in the token stream,
beside the existing sanitising rules.

**Images are not part of this**, and checking was the point: `md.disable` already
names `image`, for a stated reason with teeth — an enabled `![](https://…/?q=…)`
would fire a request from the docs origin carrying the reader's question. There
is no `img` to style because there is no `img`.

The wrapper is a tab stop, like the `pre` it borrows from, and carries **no
role**: a `region` needs a name, a table arriving from a model has no caption to
give it one, and an unnamed landmark is worse than none.

**The scope picker's tab order.** Roving tabindex: the listbox is one tab stop,
options carry `tabindex="-1"`, `↑ ↓ Home End` move the active option, `Enter` and
`Space` toggle, and type-ahead matches on the leading characters — which a
listbox is expected to offer whether or not the filter below also exists.

**Three lists lose their semantics in Safari.** `role="list"` on
`.docpilot__sources` wherever it appears — the answer's sources, the refusal's
closest pages, and the conversation list.

**The polite region drops announcements.** The watcher queues rather than
replaces, draining at the same 500ms interval it already debounces at.

### Provenance you can check without leaving

**`citations.passage` — the row expands to the passage.** A source row becomes a
disclosure carrying `aria-expanded`, and opening it shows the exact retrieved
chunk, in the quote chip's dimmed treatment: level 1, no ring, no new token.

**The chunk is RENDERED, not printed.** A chunk is corpus markdown, so shown as
a text node the disclosure was the one surface in the panel that asked a reader
to parse `##`, `**` and a fence themselves — directly under an answer that never
does. It runs through the same `markdown-it` instance the answer does, with two
departures: no copy button on a fence, because a copy control inside a 240px
quotation sits under the turn's own and adds a tab stop to a scroller that
already is one; and headings demoted to a bold line, because a corpus `##` is
the heading of the page it was cut from and not of this box.

This does not touch the invariant above it. *The exact retrieved chunk* means
all of it, uncut — which is why the box is a scroller and not a clamp — and
rendering changes only whether the syntax is in front of the text or behind it.
The link filter is the answer's, for a different reason: a corpus link is
written relative to the page it sits on, and resolved against a panel teleported
to `body` it points at nothing, which is exactly the question `isKnownPath`
already answers.

The text is read from `turn.gate.chunks` on a live turn and by id **through the
retriever** otherwise — never off `state.index` directly, because the check
script holds the rule that ids resolve through the retriever and the panel is not
the place to make an exception to it.

`history.js` does not persist `gate.chunks` — a stated, deliberate loss — so a
restored conversation resolves by id against whatever index is loaded now. When
the corpus has moved on and the id is gone, **the disclosure is absent**, which
is the honest rendering: there is no passage to show, and a control that opens
onto nothing is worse than no control. The turn already carries
`conversationStale` for the neighbouring case.

**`citations.inCopy` — the copied answer carries its sources.** Appended as
numbered markdown links with absolute URLs, because the paste lands outside the
site. The default moves: today's behaviour silently drops the one thing the
package exists to provide.

**`citations.pagesRead` — what was actually read, on a refusal.** The pages a turn
read are collected as they are read and listed under the settled line, which
already claims *searched and read N pages* without giving the reader the N. Off
by default: it is a second list on a surface that already carries one.

### Asking from where the reader already is

**`ui.prefetch` — the index arrives before the panel does.** `'hover'` by
default: the trigger's `pointerenter` and `focus` are close to intent and almost
never false. `'idle'` fetches after the page settles; `false` keeps today's
behaviour.

**`ensureIndex()` is split, and this is the load-bearing detail.** It does three
things — download, restore the scope, restore the conversation — and the second
of those can announce `scopeReset`. Prefetching the whole function would speak
into a polite region while the panel is closed. Only the network half is
prefetched; the restore stays on `open()`, where a reader is looking.

Guarded on `navigator.connection.saveData` and on `effectiveType`. The index of a
large corpus is real bandwidth, paid by every reader including the ones who never
open the panel, and *the setting exists* is not an answer to that on its own.

**`composer.deepLink` — `?dp-ask=`.** A support reply, a release note or an error
page can link a reader to a specific question. The panel opens with the text in
the composer and **does not submit it**: the reader stays in charge of spending a
turn, and a crawler following the link spends nothing. `&dp-scope=page` narrows
it. The parameter is namespaced because a documentation site may well own `ask`
already, and it is removed with `history.replaceState` so a reload does not
refill a composer the reader emptied.

**`quote.fromDocs` — the selection popover works in the article.** Off by
default. The popover moves out of `DocPilot.vue` into a component mounted both
inside the panel and at theme level, and the passage travels through the store as
a pending quote. The suppressors 007 already carries — the debounce, the pointer
tracking, the minimum length — matter more here than they did inside the panel: a
reader selecting a command in order to copy it must not have a button appear over
it every time.

007's existing behaviour gains `quote.fromAnswer`, which is the rule applied
backwards: an action that predates the rule is not exempt from it.

### What to do next

**`suggestions.scoped` — a narrow scope shows the pages in it.** Rows, not
questions. Clicking one opens the page. This replaces a blank panel with the
answer to the question the reader actually has at that moment, which is *what did
I scope this to*, and it generates nothing.

**`suggestions.followUps` — two or three questions after a settled answer**, from
the headings adjacent to the cited chunks. No model call, in scope by
construction, and rendered only under the newest turn: three rows after every
answer turns a thread into a feed. Off by default, for the measured reason above.

**`ui.firstRunHint` — one dismissible line, once.** It names exactly one thing —
selecting a passage — because a reader will find the rest and an onboarding
overlay is what a panel gets removed for. Off by default: it paints something
nobody asked for on a first visit.

### Working the thread

**`composer.editLastOnArrowUp`.** `↑` in an **empty** composer opens the last
turn's editor. The empty condition is not a nicety: without it the key stops
moving the caret inside a multi-line draft, which is the behaviour it is
borrowing from. `startTurnEdit` already places the caret at the end.

**`feedback.confirm` — the form is replaced by a line, not by nothing.** Today
`submitFeedback` writes to the polite region and returns focus to the thumb, and
a sighted reader sees the form vanish, which is indistinguishable from closing it
unsent. The line has to be true under all four `send` modes — the same discipline
the three `disclaimer` variants already keep, and for the same reason: a
confirmation that overstates is worse than none.

**`history.exportThread` — the conversation as Markdown.** A fourth header
button, under the same condition as *New chat*. The width arithmetic at
`--dp-width: 360px` is tight — four 32px controls plus gaps against the title —
and the title truncates first, which is accepted: at that width the panel is
named by the thread under it, not by its heading.

**`scope.filter` and `scope.groupBySection`.** The filter field sits **outside**
the listbox — a text input is not an option — and is bound to it with
`aria-controls`. `'auto'` shows it once the corpus is past the point where
scanning works. Grouping comes from `manifest.sections`, which `sectionFor`
already reads.

### The panel beside the docs

**`ui.layout: 'push'`.** A class on the root element while the panel is open, and
one rule in `vitepress.scss` giving `.VPContent` an inline-end padding of
`--dp-width`, transitioned on `--dp-dur`. It belongs in the adapter under its
rule 2 — the selector is VitePress's — and nowhere else.

Off by default, and stated as a mode rather than a fix, because it reflows the
host on every open and not every theme will take that well. What it settles is
the contradiction: `overlay` is honest about covering the aside, `push` makes the
component comment true.

---

## The switches

| key | default | what it removes |
|---|---|---|
| `ui.layout` | `'overlay'` | `'push'` shifts the host's content instead of covering it |
| `ui.prefetch` | `'hover'` | `'idle'`, or `false` to fetch the index only on open |
| `ui.firstRunHint` | `false` | the one-line first-visit hint |
| `quote.fromAnswer` | `true` | the selection popover inside an answer — 007 |
| `quote.fromDocs` | `false` | the same popover in the host's article |
| `citations.passage` | `true` | the retrieved passage under a source row |
| `citations.inCopy` | `true` | the source list appended to a copied answer |
| `citations.pagesRead` | `false` | the pages a refused turn actually read |
| `composer.editLastOnArrowUp` | `true` | `↑` opening the last question's editor |
| `composer.deepLink` | `true` | `?dp-ask=` prefilling the composer |
| `suggestions.scoped` | `true` | the scoped pages shown in an empty panel |
| `suggestions.followUps` | `false` | follow-up questions under the newest answer |
| `scope.filter` | `'auto'` | the picker's filter field |
| `scope.groupBySection` | `true` | section headings in the picker |
| `history.exportThread` | `true` | copying the whole conversation |
| `feedback.confirm` | `true` | the line that replaces a submitted form |

Four changes carry no key, by rule: the answer's tables and images, the picker's
tab order, the three lists' `role`, and the announcement queue.

---

## What this moves in 000

- **§The rules** — rule 11 in three clauses, and the note that it is enforced in
  vitest rather than in the shell, with the same reasoning the header of the
  check script already carries for the two rules that moved there.
- **§Elevation** — **three** new rings, not the two this spec first estimated:
  the answer table's scroller, the hairline under its header row, and the
  picker's filter field. 18 of 20; 1b's ceiling did not have to move.
- **§Component recipes** — four entries: the source passage, the answer's table,
  the picker filter, and the confirmation-and-hint pair. Each states its surface
  level and that it introduces no token.
- **§Type** — unchanged. Every new element lands on the four sizes; the passage
  is 13px meta, like the quote chip it borrows from.
- **The supersedes table** — 007's mechanism moved into `selection.js` and now
  runs twice; 008's editor gained a second way in.

## What is checked

`test/docpilot.test.js` gains rule 11 in three parts, and behaviour tests per
group: the passage's three resolution paths (live gate, restored by id, absent
when the id has gone), the copied answer's source block under both settings, the
`↑` guard against a non-empty composer, the deep link's refusal to submit, the
prefetch split that keeps `scopeReset` off a closed panel, and — the one that
covers the whole spec — **every switch set to its non-default value, asserting
the panel returns to the behaviour it had before this change.**

`scripts/check-docpilot.sh` needed one edit, and not the one expected. 1b's
ceiling holds at 20. What moved is **rule 9a**, which admits `html.docpilot-*`
as a state qualifier: `ui.layout: 'push'` has to move the host's `.VPContent`,
so the rule's SUBJECT is foreign — which is what 9a requires — while our class
only says when. The exception is anchored to `html.` so a bare
`.docpilot__thing` in the adapter still fails.

### Three things this turned up that were not in the plan

Recorded because each is the rule working rather than the feature landing.

- **`config.llm.think` had no writer.** Read in `harness.js`, set by nothing —
  not by `themeDocPilot`, not by a hand-written themeConfig, not by the eval
  runner's own `llm` object — so it always resolved to `true`. Rule 11a found it
  on its first run. Deleted rather than exempted; `thinkSupported` is the switch
  that exists, and it answers the question that can be answered.
- **`loadIndex` memoised its rejection.** A settled rejected promise stayed in
  `loading`, so one dropped connection meant a panel that could never load its
  index again short of a reload — the identical defect `ensureHighlighter` was
  already fixed for. Harmless while `open()` was the only caller; load-bearing
  the moment a hover can fire it seconds after page load.
- **Images were already off.** This spec first claimed `img` needed a rule
  beside the table's. It does not: `md.disable` names `image`, for a stated
  reason with teeth — an enabled `![](https://…/?q=…)` would fire a request from
  the docs origin carrying the reader's question.

## What this does not do

| | why |
|---|---|
| **Text fragments** — `#anchor:~:text=…` to land on the sentence | The fragment is processed by the browser on navigation, and internal links go through `router.go()`, which will almost certainly ignore it. The fallback — driving the CSS Custom Highlight API ourselves — is a separate piece of work, not the free upgrade the idea was written up as. |
| **A resizable drawer** | It needs pointer capture and text-selection suppression during the drag, and selection inside this panel is working machinery. The conflict is real and deserves its own spec. |
| **Continuing a stopped turn** | Resuming needs support from the transport, which may not exist. *Ask again* already covers `aborted`. |
| **Branching an edited question** | Rejected in 008 and rejected again: an archive schema migration for a control that appears once. |
| **Heading-derived openers by default** | See the A5/B3 asymmetry above. |
