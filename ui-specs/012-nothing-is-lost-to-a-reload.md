# 012 — Nothing is lost to a reload

## Problem

[010](010-a-turn-outlives-the-panel.md) separated two intentions that had been
arriving at one function: *stop this answer* and *get this off my screen*. It was
right, and it closed the case it names — the panel is put away and the turn runs
on.

It also assumed something it never said out loud: **that the panel was the only
thing the reader could leave.** It is not. They can leave the page. And when they
do, three different things are thrown away, all for the same reason — nothing in
this package has ever asked what should be kept at the moment a tab goes away.

```
$ grep -rn "beforeunload\|pagehide\|visibilitychange" src/
src/theme/docpilot/budget.js:504:      globalThis.addEventListener('storage', (e) => {
```

One listener, and it is about somebody else's ledger.

**The answer being written is thrown away.** `saveCurrent()` is called *«once per
settled turn and once per vote — never mid-stream»* (`session.js:922-930`), which
is the right economy: a per-token write would serialise the whole conversation on
every frame. But a reload at second three of an answer loses every token of it,
and the upstream request that produced them is already paid for. On the free
tier that is one of fifty a day, spent on nothing.

**The half-typed question is thrown away.** The composer is a plain `ref('')`
(`DocPilot.vue:1305`). A reader assembling a question up against the 1000-character
ceiling, who reloads by reflex or follows a link out and comes back, starts again
from an empty box.

**And while the answer is coming, the reader cannot tell a slow model from a dead
panel.** `statusLabel` (`DocPilot.vue:2684-2692`) is a pure function of the phase:
`searching · indexing · thinking · reading · listing · writing`. There is no time
in it. `DEFAULT_STEP_TIMEOUT_MS` is 120000 (`harness.js:24`), so a provider that
accepts the connection and then says nothing holds the reader in front of a
motionless word for **two minutes**. The models that stream reasoning give them a
ticking counter through `thoughtLabel`; the ones that do not — which is most of
them — give them nothing that changes.

Three symptoms, one root: **leaving is not a state this package models.** This
spec makes it one.

---

## Research

### The reference

The comparison this time is [vercel/chatbot](https://github.com/vercel/chatbot)
at `main` @ `c2f8235` — Vercel's own reference app on the AI SDK, and the closest
thing to a canonical answer for a chat that has to survive a page load. The
finding is worth stating plainly because it inverts the expected direction:

**Their resume path does not work.** The plumbing is intact — `consumeSseStream`
creates a resumable stream in Redis, a `Stream` table records the id, and
`useAutoResume` fires on mount. The endpoint it fires at,
`app/(chat)/api/chat/[id]/stream/route.ts`, is three lines:

```ts
export function GET() { return new Response(null, { status: 204 }); }
```

A reload there is a plain refetch of persisted messages. So the reference for
"resume the stream" resumes nothing, and the practical distance between their
architecture and one with no server at all is zero on this axis.

What they do have, and it is the one idea in that repository worth taking, is a
**waiting status that escalates**. The route writes transient parts and steps
them up — `waiting → still-waiting → «this model may be slow or unavailable right
now» → thinking` — with the third step sourced from live gateway telemetry at the
nine-second mark. The filter that decides when waiting ends is worth copying too:
envelope chunks (`start`, `start-step`, `finish-step`, `finish`, `raw`) do not
count as activity, so the phase turns over on the first *real* token.

Three widget categories were checked for the storage half, and they agree with
each other: Intercom, Crisp and Zendesk all restore a composer draft on reload,
and none of them asks before doing it.

### What is taken, and what is not

**Taken: the escalation.** Two steps, and the reasoning for stopping at two is in
§*Two steps and no third* below.

**Not taken: a server-side buffer.** `resumable-stream` needs Redis. This package
has no backend beyond a reverse-proxy for two POST routes, that is the first thing
its README claims, and a dependency which turns a static-asset deployment into a
stateful one is not a feature — it is a different product. The honest fraction of
the same benefit is to keep **what was already painted**, and that costs no
server at all.

**Not taken: their third escalation step.** It reads provider health out of
gateway telemetry. There is no telemetry here to read, and the analogue this
package already has is better than a sentence: it rotates. `orderCandidates`
(`llm.js:414-438`) and `orderMembers` (`:1157`) walk a pool and a ladder while the
reader waits. Announcing what rotation is about to do would mean plumbing pool
state out to a component, and the sentence it would enable is one this panel
cannot always keep — see §*The escalation promises nothing*.

### The serialisation was already written

The most useful thing found while researching this is that two thirds of the
storage half is done. `slimTurn` already contemplates exactly this case:

```js
// A turn caught mid-flight settled the moment it was written down. It kept
// what it had already streamed, which is exactly what `stop()` produces.
const state = TERMINAL.has(turn.state) ? turn.state : 'aborted'
```
— `history.js:98-105`

A non-terminal turn is written down as `'aborted'`, which is a state the panel
already renders (`DocPilot.vue:336`) and which `canRetry` already covers
(`:1544`). So a restored mid-flight turn arrives with its text, with **Stopped.**
above it and with **Ask again** under it, and not one line of that had to be
written. What was missing was never the shape. It was the moment.

### `pagehide`, not `beforeunload`

`beforeunload` is for asking a question, and the only question it can ask is a
browser dialog — which this package has ruled out elsewhere for its own reasons
(*«It asks twice, and never through a browser dialog»*, `docs/guide/history.md`).
It is also the event browsers penalise: registering one disqualifies a page from
the back/forward cache in every engine.

`pagehide` is the event for *«write down what you have»*. It fires on navigation
and on bfcache entry alike. Its one gap is mobile Safari, which can discard a
backgrounded tab without ever firing it, so `visibilitychange` at
`document.visibilityState === 'hidden'` is registered beside it — the pairing
every vendor guide has recommended since 2018.

That pairing has a cost, and it is the sharp edge of this spec:
`visibilitychange` fires on **every** tab switch, every app switch and every
screen lock. Without a guard, a reader who switches apps while an answer streams
rewrites the archive on each swipe. So the write is idempotent per turn, and the
flag lives on the turn.

### Two steps and no third

Nielsen's three response-time limits are the oldest usable numbers here: 0.1 s
feels instant, 1 s keeps thought unbroken, and **10 s is the limit of attention on
a dialogue** — past it people switch tasks and need to be told the system is still
theirs. The first step must therefore land *before* ten seconds, and far enough
after the send that the label is not churning under a reader who just pressed the
button. **8 s.**

The second step is not about attention, it is about abnormality. A healthy
provider's time to first byte does not reach half a minute; `stepTimeoutMs` is
120 s, so at 25 s there is still a minute and a half in which the turn may yet
succeed, and the reader deserves to know that what they are seeing is no longer
ordinary. **25 s**, roughly three times the first.

A third step was considered and dropped. It could only say one of two things:
what is wrong — which needs telemetry this package does not have — or what will
happen next, which it must not promise. See below.

### The escalation promises nothing

The temptation is to write *«trying another model»*, because the ladder often is
about to do exactly that. It is refused, and the rule it is refused under is the
one that governs the three `disclaimer` variants: **a line the panel prints has to
be true in every configuration, not in the common one.** A chain with a single
member never rotates. A named model flattens the tiers. A self-hosted Ollama has
nowhere to go. One sentence that is a lie on three shipped configurations is worse
than a vaguer sentence that is true on all of them.

So both steps say only what is certain, and the second one says the thing the
escalation's own gate makes true by construction: it runs **only** while the
newest turn has neither `answerText` nor `thought`, so *«the answer has not
started yet»* is not an observation, it is the condition.

### The draft is a secret until proven otherwise

`docpilot:draft` goes to `sessionStorage`, paired with `docpilot:conversation`
(`history.js:44`) rather than with the `localStorage` archive, and for that key's
own reason: a draft belongs to the tab that is typing it. Two tabs are two
questions.

Two disciplines are inherited rather than invented:

**It is redacted before it is written.** A pasted key is caught before a turn
exists (`session.js:1384`), and every path that writes to storage redacts first —
`redactComment` does it three times over in `session.js` alone. A draft is the
one text in this panel that reaches disk *before* any of that machinery has seen
it, which makes it the exact shape of hole every other path has closed.

**It obeys `history.enabled`.** That setting is documented as *«This stops
recording **and clears what is already stored**»*. A draft surviving it would make
the published sentence false, so the gate is both keys, not one.

---

## The change

**Three settings, one defect fix.** The defect gets no switch — a bug has no user
who wants to keep it, which is the tier [009](009-every-action-has-a-switch.md)
put B7 in.

| | | default | |
|---|---|---|---|
| *(the defect)* | `Enter` during IME composition no longer sends | — | `DocPilot.vue` |
| `history.saveOnUnload` | an unfinished turn is written down when the page goes away | `true` | `unload.js` |
| `ui.waitingEscalation` | the status label escalates at 8 s and 25 s | `true` | `status.js` |
| `composer.draft` | the composer's text survives a reload | `true` | `DocPilot.vue` |

All three defaults are ON by 009's blast-radius test: every one of them is inside
the panel, on this package's own surface, for a reader who opened it.

### The defect

Enter is the send key, and the check was `e.key === 'Enter' && !e.shiftKey`. In
an IME — Japanese, Chinese, Korean — Enter is also how a candidate is committed,
several times per sentence. Every one of those commits was sending a half-typed
question and spending a request against a daily allowance the whole site shares.
The guard is `e.isComposing || e.nativeEvent?.isComposing`, first in the handler
so that `ArrowUp` is covered by it too: a reader mid-composition is not asking to
edit their last question either.

### The listener

`unload.js` follows `hotkey.js` exactly — a module-level singleton with a
reference count, bound on 0 → 1 and released on 1 → 0, clamped at zero so a
double unmount cannot leave a page unlistened. The reason is the same reason
hotkey has one: HMR unmounts twice, and a count that can go negative is a feature
that stops working after a save.

### What is written, and when

`session.saveIfRunning()` returns immediately unless a turn is actually running,
the archive is on, the switch is on, and this turn has not already been written.
Then it calls the existing `saveCurrent()` unchanged. Nothing new is serialised
and nothing new is stored: `slimTurn` does the rest, as quoted above.

A turn with no text yet writes nothing at all — `slimTurn` returns `null` when
there is neither an answer nor a refusal, which is what keeps a reader who
reloads two seconds after asking from finding an empty row in their history.

---

## What this does not do

**It does not resume the stream.** The request is gone with the page; what comes
back is what had already arrived, marked **Stopped.** with **Ask again** under it.
Continuing from the point of interruption needs a buffer on a server, and this
package does not have a server. That is [IDEAS](IDEAS.ru.md)'s **C4**, and this
spec closes half of it: continuing is still impossible, losing is no longer
automatic.

**It does not tell the reader why a wait is long.** See §*The escalation promises
nothing*.

**It does not touch the proxy's error contract.** That was proposed as D5 and
withdrawn during this spec's research, for three reasons worth writing down so
the proposal is not made a second time. First, `limit_source` is not an accident:
`limitResponse` (`lib/ai-proxy.js:304-328`) carries a docblock naming both
readers — `rotatable()` in `llm.js` and `defendable()` in `budget.js` — and
explaining why the burst wording avoids the daily regex, and `test/vercel-proxy.test.js:283`
holds it. Second, it *must* imitate OpenRouter: `classifyLimit` reads limits from
every upstream this package can reach, not only from this proxy, so a
DocPilot-shaped envelope would be a second path rather than a replacement. Third,
the visibility policy it proposed to import is already kept — the `error` state
renders a fixed `T('error.lead')` (`DocPilot.vue:552`) and `turn.error` is held in
state and bound to nothing. Adding a machine-readable code to the remaining
`problem()` responses would create a key with no reader, which is precisely the
defect rule 11a exists to catch.

One thing did come out of looking: `state.degradedReason` was written
(`session.js:767`) and read nowhere. It is deleted, on the same reasoning 009
used to delete `llm.think` rather than add it to `THEME_ONLY`.
