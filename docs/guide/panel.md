# The assistant panel

The panel is the AI assistant a reader actually touches: a chat, on any page,
answering from the corpus you indexed. This page is the tour of it — every
surface it opens from, everything a reader can do inside it, and the setting
behind each one.

It is a reference for what the chat *does*. What happens underneath, between the
question and the answer, is [How a turn works](/concepts/a-turn).

## Opening it

Six doors, and a site can have all of them at once.

| | what it is | setting |
|---|---|---|
| **Navbar button** | beside your search box | [`ui.trigger: 'nav'`](/reference/config#ui-trigger) |
| **Mobile row** | a text row inside the hamburger menu | carried by `'nav'`; `'screen'` on its own |
| **Floating button** | bottom corner, every page, every width | `ui.trigger: 'fab'` — **the default**, with [`ui.fabLabel`](/reference/config#ui-fablabel-ui-fabicon) for the words on it |
| **<kbd>⌘I</kbd> / <kbd>Ctrl I</kbd>** | always bound, even with no visible button at all | nothing to set |
| **Under an article** | "Didn't find it? Ask DocPilot", in the `doc-footer-before` slot | rendered by the theme wrapper |
| **A selection** | select a passage, press **Ask AI** above it | [`quote.fromDocs`](/reference/config#quote-fromdocs) — off by default |

`ui.trigger: 'none'` removes every button and keeps the hotkey. On a host that
mounts the panel itself, `open()` on the handle from
[`mountDocPilot`](/install/javascript) is a seventh door.

**The panel has two shapes.** A drawer pinned to the trailing edge at full
height, or a popup floating above the button that opened it —
[`ui.panel`](/reference/config#ui) picks one, and `'auto'` follows the trigger:
the shipped floating button opens the popup, and `trigger: 'nav'` brings the
drawer back with it.
[`ui.layout: 'push'`](/reference/config#ui-layout) makes the page move aside
instead of being covered.

**It warms up before it is opened.** [`ui.prefetch`](/reference/config#ui-prefetch)
fetches the index on hover by default, so the first question is not also the
first download.

## The empty panel

The first thing a reader sees, and the state most assistants waste.

- **Three to five suggested questions.**
  [`suggestions.questions`](/reference/config#suggestions-questions) — replace the
  built-in three with up to five of your own. They are gate inputs, not headings:
  `docpilot index` scores each one against the corpus at build time and prints
  which of them the gate would refuse — a hint worth heeding, since it is the
  reader's very first click, whether or not `guard.mode` acts on it at runtime.
  If nobody has used the panel yet and you have no idea what to put there, the
  `docs-rag` skill proposes candidates from the corpus itself.
- **Under a narrow scope, the pages instead.** When the reader has scoped to one
  page or one section, the openers would fall outside it and be refused, so the
  panel lists the pages in scope as rows —
  [`suggestions.scoped`](/reference/config#suggestions-scoped).
- **One dismissible line on a first visit**, naming the one gesture nobody
  discovers: *Select any passage to ask about it.*
  [`ui.firstRunHint`](/reference/config#ui-firstrunhint), off by default, because
  an onboarding overlay is what a panel gets removed for.

## Asking

### The composer

Placeholder is *Ask about {product}* — one string, from
[`product`](/reference/config#product), and left unset it reads "the docs".
A counter appears as the question approaches 1000 characters. The hint line
underneath always says what is being searched: *Type a question to send.
Searching this page.*

<kbd>↑</kbd> on an empty composer brings the last question back for editing —
[`composer.editLastOnArrowUp`](/reference/config#composer-editlastonarrowup).

### Scoping the question

A chip in the composer opens a picker: **All docs**, **This page**, **This
section**, or a hand-picked list of pages. Over about a dozen pages a filter
field appears above the list — [`scope.filter`](/reference/config#scope-filter) —
and pages are grouped by section.

Scope is focus, not containment: the assistant is shown only chunks from the
active scope, through every tool it has, but a scope is a retrieval decision
rather than a security one. [`scope.default`](/reference/config#scope) sets where
a fresh conversation starts.

### Quoting a passage

Select text and one button appears above the selection. Pressing it attaches the
passage to the composer as a removable chip, so the question can be *what does
this mean?* with a *this* on screen.

Inside an answer this is on by default
([`quote.fromAnswer`](/reference/config#quote-fromanswer)); over your own prose
it is off ([`quote.fromDocs`](/reference/config#quote-fromdocs)), because it
paints a control on your article and that is a decision about your site.

### A question with a key in it

A question containing a credential shape — an API key, a JWT, a bearer token, an
AWS key id, a hex digest — is stopped **before the embedding call**, so the value
never leaves the browser. It is replaced with a placeholder, the warning is
written in the language the reader typed in, and one button asks the original
question without it. See [Credentials in questions](/guide/credentials).

This is a habit guard, not a security boundary.

### "Hello"

A greeting carries no documented subject, so the gate scores it at zero and
refuses it — a correct verdict that tells a reader, on their first message, that
the assistant is broken. Greetings, thank-yous, farewells and *who are you* are
recognised before the gate and answered from a template in eighteen languages,
with no model call. A greeting attached to a real question is not claimed. See
[Social openers](/guide/social-openers).

## While it answers

The status line says which of six things is happening rather than spinning:
*Loading the docs index*, *Searching the docs*, *Looking at the page list*,
*Reading `guide/indexing`*, *Thinking*, *Writing the answer*.

- **Reasoning** collapses behind *Thought for 4s* on providers that emit it.
  It opens itself while thinking is the only thing happening, and pressing it
  overrules that for the rest of the answer — collapsed stays collapsed while
  the model keeps thinking, open stays open once the answer starts. The next
  question decides for itself again. It is never written to history — it is a
  scratchpad, not an answer.
- **Stop** ends the turn and keeps what arrived.
- **The composer stays open.** The next question can be written down as it
  occurs to the reader, while the answer is still arriving. Enter does nothing
  until the answer settles, and Stop is still the only thing that ends a turn.
- **Scrolling up stops the chase.** The thread follows a streaming answer only
  while the reader is at its foot; scroll up to re-read something — with a
  wheel, a finger, the scrollbar or `PageUp` — and it stands still until you
  come back down. The reasoning box behaves the same way inside itself.
- **Jump to latest** appears when the reader has scrolled up mid-answer, and
  resumes the chase.

**Closing the panel is not stopping.** A reader who puts the panel away while a
turn is running — the `×`, `Escape`, the floating button again, the scrim — keeps
the turn: it finishes in the background, and the button they opened it from takes
a small dot when it settles. Opening the panel again clears the dot and shows the
answer already in place. The turn survives moving to another page of your site,
because the thread always has; it does not survive a full page load.

**Stop is still Stop.** The button above, and the `Escape` that stands in for it
while a turn is running, end the turn as they always did. The two gestures were
one abort until [`ui.background`](/reference/config#ui-background) separated them,
and the symptom of their being one was a reader who closed the panel mid-search
and reopened it to *I couldn't find this in the docs.* — the gate's refusal, for a
turn the gate never ran. Set `ui: { background: 'open' }` to have the panel come
back by itself instead of waiting, or `false` to abandon the turn on close.

## Reading the answer

**Citations are checked, not trusted.** Every marker corresponds to a chunk the
host itself put in front of the model that turn, verified against a set the host
maintains — never by searching the text of what the model was sent. A link to a
route that does not exist in the index is de-linked before anything renders.
The full statement, and its limits, is
[What it guarantees](/concepts/guarantees).

| what the reader gets | setting |
|---|---|
| A **Sources** list under the answer | always |
| **Show the passage** — a disclosure opening the exact text a citation was drawn from | [`citations.passage`](/reference/config#citations-passage) |
| **Pages read** — what "read 3 pages" was actually reading | [`citations.pagesRead`](/reference/config#citations-pagesread) |
| Sources appended to a copied answer, under a `Sources:` heading | [`citations.inCopy`](/reference/config#citations-incopy) |
| A deep link into the cited chunk | [`composer.deepLink`](/reference/config#composer-deeplink) |

Code in an answer is highlighted by whichever highlighter you plug in — Shiki,
Prism or highlight.js, none of them installed by default. See
[Syntax highlighting](/reference/highlighting).

An answer the model was unsure of carries one line saying so: *The model was
unsure of this one — check the sources below.*

## When it refuses

A refusal is not an error, and it does not look like one. The panel says what it
searched and what it did not find — *I couldn't find this in this section* —
and then does the useful thing:

- **Closest pages** — the best chunks that fell under the threshold, as links.
  Under a narrow scope it also offers **Closest pages elsewhere**, and one button:
  *Clear the scope and search all docs*.
- **Searched the docs and read 4 pages** — what the turn actually did, so the
  refusal is checkable.
- **Degraded** — a separate sentence for the case where the semantic index could
  not be loaded and only word matching ran, because that is a different fact from
  "not in the docs".

Nothing was generated and nothing was spent. [The refusal gate](/concepts/the-gate)
is the two channels behind the decision, and `npx docpilot calibrate` is what
sets the floor against your corpus rather than someone else's.

## When something is wrong

| the reader sees | when |
|---|---|
| *The AI service didn't respond.* with **Retry** and **Search the docs** | the transport failed **before** retrieval, so there is nothing to show instead. The second button needs [`host.search`](/reference/config#host) — without a selector it is not rendered, because a button that clicks nothing is worse than no button |
| *The AI models aren't reachable right now — this is a search answer. The closest passages:* with the ranked rows under it, then **Retry** and **Search the docs** | every service in the chain was asked and none answered, but retrieval had already finished — so the turn settles as the same rows a search-only site serves. The last rung of [the answer ladder](/concepts/the-ladder) |
| *The free daily limit for this site's AI is used up. Answers resume 18:40.* | a quota, not a failure — so **Retry** is deliberately absent, and the time is in the reader's own locale. The passages are listed beneath it too, under *Meanwhile, the closest passages:*, because they cost nothing and are what the reader came for |
| *12 of 50 answers left today* | [`budget.showRemaining`](/reference/config#budget-showremaining) |
| *Running low — answers get shorter to stretch the daily limit.* | the panel has dropped to one model call per question. Stating the trade beats letting the reader conclude it got worse |
| *No embedding model — search matches words only.* | the site declared [`embed: false`](/reference/config#embed-false). A statement, not an apology |
| *AI answers are off in this environment.* | no key, or no index — the panel says so instead of pretending |

Living inside a request-metered free tier is its own page:
[Living on the free tier](/guide/free-tier).

## Working the thread

- **Edit question** replaces the question with a textarea. Committing it discards
  everything below and answers again — and the screen reader is told exactly
  that: *Question edited. Everything below it was removed.*
- **Ask again** throws away an answer that arrived and re-asks. Different from
  **Retry**, which re-runs a question the transport dropped.
- **Copy answer**, **Copy question**, and **Copy conversation** — the whole
  thread as Markdown, which is the artefact a support engineer actually wants
  ([`history.exportThread`](/reference/config#history-exportthread)).
- **Follow-up questions** under the newest answer, built from headings on the
  pages that answer cited. No model call and nothing invented — the wording is a
  template, so it cannot name a section your corpus does not have.
  [`suggestions.followUps`](/reference/config#suggestions-followups), off by
  default.

## Past conversations

Behind the clock button in the header: every conversation, titled by its first
question, dated relative to its last. Kept in the reader's own `localStorage`
and **sent nowhere** — the archive is shared by every tab, which conversation a
tab is showing is not.

Delete one row, or all of them in a two-step confirmation that is never a browser
dialog. Rebuilding the index does not throw the archive away; an older
conversation opens with one line above it saying the docs have changed.

[`history.enabled: false`](/reference/config#history-enabled) stops recording
**and** clears what is stored. The whole model is
[Conversation history](/guide/history).

## Telling you it was wrong

Two thumbs under every answer. A down-vote opens four reasons — *Wrong answer*,
*Incomplete*, *Not in the docs*, *Bad links* — and an optional 500-character
comment whose label says what happens to it before the reader writes it: *Sent
to the docs team. Keys and tokens are removed automatically.* They are, by the
same redaction the composer uses.

Where it goes is [`feedbackEndpoint`](/reference/config#feedbackendpoint) — an
endpoint **you** own, or nowhere at all, in which case the vote stays on the
device and the panel says so. Which verdicts travel is
[`feedback.send`](/reference/config#feedback-send); `'none'` keeps the thumbs on
screen and transmits nothing.

The disclaimer under the composer changes to match, and there are three of them,
because two would be a lie under two of the four send modes.

`npx docpilot feedback` turns what your endpoint collected into *candidates* for
the eval sets. It never writes to them — a gold answer is written by a person.

## Showing the reader how it works

Off by default, and worth turning on for a technical audience.

[`prompt.show`](/reference/config#prompt-show-prompt-allowappend) puts a **How
this works** disclosure in the panel, containing the assistant's actual
instruction, its tool definitions — separated into the ones delivered as tool
definitions and the ones sent as text — and the scope in force.

[`prompt.allowAppend`](/reference/config#prompt-show-prompt-allowappend) lets the
reader add an instruction of their own, capped by
[`prompt.appendMaxChars`](/reference/config#prompt-appendmaxchars). It is sent
**with the question, never merged into the system prompt**, it lives in
`sessionStorage`, and it dies with the tab. The panel says so in the disclosure
itself.

## In the reader's language

Panel chrome follows the page's locale. The credential warning and the greeting
reply follow the language the **reader typed in**, which is not always the same
thing.

All 173 reader-facing strings are replaceable one at a time, in 25 groups, in the
same shape as VitePress's own local-search i18n:

```js
i18n: {
  locales: { ru: { translations: { empty: { heading: 'Чем помочь?' } } } },
}
```

A key that does not exist is dropped and named on stdout. See
[Translating the panel](/guide/i18n).

## For a reader not using a mouse

<kbd>⌘I</kbd> opens it from anywhere and closing it returns focus to the article.
Every state change that has no visual equivalent is announced: *Answer ready. 3
sources.* · *Question edited. Everything below it was removed.* · *Scope reset to
all docs.* · *Quote added to your question.* · *Conversation deleted.*

The list is in the `announce` group of the [i18n keys](/guide/i18n#the-keys),
which is the only complete inventory of it.

## Making it yours

- Colours, fonts, density and the two style bundles: [Appearance](/guide/appearance).
- Every setting on this page, with its default and its reasoning:
  [Configuration](/reference/config).
- How it stacks up against a hosted answer service: [How it compares](/guide/comparison).
