# 010 — A turn outlives the panel

## Problem

A reader asks *How do I authenticate requests?*, and while the gate is still
retrieving they put the panel away — the `×`, `Escape`, the floating button
again, a tap on the scrim. They come back to:

> I couldn't find this in the docs.

That sentence is `refusal.notFound`. It is the gate's verdict, and the gate had
never run.

The chain is four hops and every one of them was working as written:

```
close()                       session.js
  → stop()
     → controller.abort()
        → catch (e) in submit
           turn.state = turn.answerHtml ? 'aborted' : 'no-answer'
           turn.refusal = { cause: 'not-answerable', … }
              → leadLine(turn) → T('refusal.notFound')
```

An abort **after** the first token settles honestly: `'aborted'`, rendered as
**Stopped.**, with whatever was written kept. An abort **before** it has no state
of its own, so it falls into the same terminal state a refusal uses — and the
window before the first token is most of a turn's latency. The embedding call,
the retrieval, the gate and the model's own time to first byte all sit inside it.
The likeliest moment for a reader to look away is the moment the panel had the
least to say for itself.

**The real defect is that one `abort()` was serving two intentions.** "Stop" and
"get off my screen" are different requests, and only one of them is about the
turn. The panel had no way to tell them apart because both arrived at the same
function.

Three consequences follow from the same root, and this spec closes all three:

**The answer was thrown away, not just mislabelled.** Everything expensive had
already happened — the index was resident, the query was embedded, the corpus was
searched. A reader who reopened and asked again paid for all of it a second time,
on a free-tier request budget the panel otherwise rations carefully.

**Nothing could tell them it was ready.** There is no state for "waiting" in this
package, because until now nothing could be waiting: the panel was the only
surface, and a shut panel was a finished session.

**A screen reader heard nothing either.** `announce.answerReady` already fires
from `finishTurn`, but the polite live region lived inside the panel's `v-if` and
was destroyed with it. That was invisible while a turn could not outlive the
panel, and became load-bearing the moment one could.

---

## Research

### The reference

000 settles the arrangement — *OpenAI supplies the structure, the host supplies
the colour* — but the structure this needs is not in a chat panel. It is in the
launcher, and every widget category that has a launcher has solved it the same
way.

- **Intercom, Crisp, Drift, Zendesk.** The conversation continues when the
  messenger is closed; the launcher takes a small badge when a message lands.
  None of them reopens the messenger by itself, and the reason is stated in
  Intercom's own guidance: an unrequested reopen covers the page the visitor
  chose to go back to. **This is the default here.**
- **The badge is a dot, not a count, once the count is one.** Intercom and
  Zendesk both drop to a plain dot for a single unread. There is nothing to
  count in this package — a turn is a turn — and a number on a 10px circle is a
  number nobody reads.
- **Material's badge and Apple's `.badge`** both place it at the block-start,
  inline-end corner of the target, half outside the bounding box, with a cut-out
  in the parent's own colour so it reads as an object over the button rather than
  a hole in it.

### Motion

- **`better-ui` — motion restraint.** An indicator that repeats forever is a
  notification the reader has to dismiss. There is nothing here to dismiss it
  with: the panel is shut, and the only dismissal is opening it. A finite burst
  says *this just happened*; what remains afterwards says *it is still here*.
  Three iterations is the arrival; the dot is the state.
- This is also what keeps **rule 6a** at two. The rule counts the substring
  `infinite`, and a fixed iteration count writes no such word. The rule did not
  need to move, and a rule that does not need to move should not.
- **`prefers-reduced-motion`** keeps the dot and drops the bounce. The dot is
  information; the bounce is the announcement of it, and a reader who asked for
  less motion has not asked for less information.

### Accessibility

- **`better-accessibility` — a visible label IS the accessible name.** The button
  already holds itself to this (ui-specs/005): `aria-label` steps aside when
  `ui.fabLabel` renders words, because an `aria-label` silently replaces the text
  a sighted reader is looking at. The unread words have to follow the same rule
  rather than route around it — they join the content when there is content, and
  they go into `aria-label` only when the button is the icon-only circle and
  there is nothing to join. Writing both would be writing it twice.
- **The dot itself is `aria-hidden`.** It repeats what the name has already said,
  and an empty box read out as a control is the wrong half of the pair.
- **A live region must be resident.** A region inserted into the document in the
  same frame as its text is one several screen readers do not announce. Moving
  the region out of the panel's `v-if` is required for the closed-panel case and
  fixes a race the open case always had.

### Contrast

The dot is never text and never a border, so the floor is the **3:1 non-text**
one — but against **both** surfaces, because it is the one colour in the package
with no dark variant. `#e34c1e` measures 4.8:1 on `#ffffff` and 3.6:1 on
`#1b1b1f`.

---

## Decision

**`ui.background`** — `'notify'` · `'open'` · `false`, defaulting to `'notify'`.

| value | the turn | the reader |
|---|---|---|
| `'notify'` | runs to completion | a dot on the trigger, cleared by the next open |
| `'open'` | runs to completion | the panel returns by itself, answer in place |
| `false` | abandoned on close | nothing — the behaviour before this spec |

**`close()` reaches `stop()` under exactly one value.** Everything else about the
abort is unchanged: the composer's Stop button and the `Escape` rung above the
close (`if (s.busy) return session.stop()`) go straight to it, at every value of
this setting. That ladder is left alone deliberately — it is how a keyboard
reader stops a turn, and a second `Escape` still closes the panel, which is now
the backgrounding gesture. Two keystrokes, two intentions, in the order a reader
means them.

**The badge is set in `finishTurn`, below the `state.turns.includes(turn)`
guard.** A turn that settled into a thread the reader has since left is already
refused a save; a dot pointing at a conversation they let go of would open the
panel onto something else entirely. It is set for **every** settled state,
refusals included: a refusal is still an answer to a question that was asked, and
a badge that only lit for successes would go dark exactly when the reader most
wants to know what happened.

**`open()` is the only place it clears**, because every path that shows the panel
goes through that one function — the three triggers, the hotkey, the article call
to action, the deep link and the host's own handle.

**The turn survives navigation.** The store is a module singleton, which is what
it has always been for; the dot is waiting on the trigger of whatever page the
reader moved to. It does not survive a full page load, because nothing does.

### The dot

`--dp-alert: #e34c1e`, a new token and the package's **one signal colour**. It is
deliberately outside the theme: it has no dark variant and no adapter mapping,
because *there is something waiting* is not a statement any brand palette holds a
value for. A site that disagrees repoints one token.

10px, `--dp-r-pill`, at the block-start/inline-end corner of the two placements
that are targets, and an inline dot at the end of the mobile nav row, which is a
line of text with no corner near the words. The separation from the button under
it is a **`box-shadow` cut-out, not a border** — rule 1 knows one border in this
package and it is the hairline; cutting a hole in a surface is a different job.
`forced-colors` erases both the fill and the shadow, so that mode gets a real
`1px solid CanvasText` edge, and it is the only place in the package that draws
one for this element.

**That takes rule 1b's ring inventory to 20 of 20.** The ceiling is now met, and
the next ring anywhere in the package is a deliberate edit to
`scripts/check-docpilot.sh` rather than a diff nobody counted.

---

## What this does not cover

**A desktop or system notification.** Out of scope, and not a near miss: it needs
a permission prompt, it fires when the tab is not focused, and a docs page asking
for notification permission because a reader asked one question is the dependency
somebody removes.

**A count.** There is nothing to count. One turn runs at a time — `submit` refuses
while `state.busy` — so the badge is a boolean and the thread holds the detail.

**Restarting a turn the reader stopped.** Stop is Stop. This spec is about the
gesture that was never a stop in the first place.
