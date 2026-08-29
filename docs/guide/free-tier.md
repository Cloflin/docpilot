# Living on the free tier

OpenRouter's free tier is a real way to run this panel, and it is metered in a
way that catches people out. This page is what the constraint actually is, what
DocPilot does about it, and what you have to decide.

It is also **rung 2 of [the answer ladder](/concepts/the-ladder)**: where the
environment holds a billed key as well, the free pool sinks beneath it and
answers only once that account has stepped aside, because fifty requests a day
shared by every reader of the site is not the allowance to spend first. A chain
mixing the two turns per-day rationing **off** — the rules below need one
allowance to defend and that deployment has more than one — so a spent free day
rotates to the billed member and starts billing with nothing on screen saying so.
The build prints that consequence, and
[`budget.dailyLimit`](/reference/config#budget-dailylimit) is how you state one
ceiling for the whole chain and get the rationing back.

## The constraint is requests, not tokens

The free tier caps **requests per day**, not tokens:

| | |
| --- | --- |
| Under 10 credits bought, lifetime | **50 free-model requests per day** |
| 10 credits or more, lifetime | **1000 per day** |
| Always | 20 requests per minute |

The daily counter covers model ids ending in `:free`. `openrouter/free` — the
router at the head of the shipped pool — carries no such suffix and is **not**
exempt: called against a spent day it returns the same refusal. The window ends
at midnight UTC.

This matters because the intuitive fix is the wrong one. Free models publish
128k–512k context windows, so splitting a question into more calls to fit is
solving a problem you do not have, and each extra call is one of fifty.
**Everything below makes a turn cost fewer requests, never more.**

::: warning The dashboard will tell you nothing is wrong
Free models cost nothing, so `usage_daily` stays at `$0` while you are fully
blocked. The spend graph is flat because the thing being counted is not spend.
:::

## What a turn costs

A turn is one embedding request plus one or more model calls:

| | requests |
| --- | --- |
| One-shot turn | 1 embed + **1** model call |
| Agentic turn | 1 embed + **2–3** model calls, plus any the pool rotates through |

The embedding request is only counted when both halves are served off the same
key — a local Ollama beside a hosted chat model draws on nothing this page is
about. A site configured [`embed: false`](/reference/config#embed-false) makes no
embedding request at all, which halves the cost of a one-shot turn: roughly fifty
questions a day instead of twenty-five. It is the largest saving on this page and
the most expensive one, because it removes the dense retrieval channel — read
[No embedder at all](/guide/providers#no-embedder-at-all) before treating it as a
budget measure.

The agentic turn is the default and it is worth what it costs when the budget is
comfortable: the model reads the retrieved excerpts, decides they are not enough,
and searches again with a better query. The one-shot turn skips that second
search and answers from the retrieval the gate already performed.

The difference is not free. A one-shot answer is as good as the first retrieval
was, and the loop exists because the first retrieval is sometimes not good
enough. What one-shot buys is roughly three times as many questions in a day.

## One key, ten models

The panel is not pinned to a model. `chat: { provider: 'openrouter' }` with no
model named resolves to an **ordered pool of ten**, and the reason is what a free
id actually is: a shared allocation, so its `429` reports how many other people
are asking rather than anything about the model. Pinning one buys a panel that
works until somebody else's traffic arrives.

So a turn walks the list instead:

| | |
| --- | --- |
| head of the pool | `openrouter/free` — OpenRouter's own router over the free tier |
| behind it | nine explicit free ids |
| one refuses | the next one answers; the refuser goes to the back for a minute |
| one answers | it is tried first on the next turn |

The router leads because it is this feature implemented one hop closer to the
pool than a browser can see it: it picks a free model per request, skips the
saturated ones, and reports which one answered. The explicit ids behind it are
what runs when the router itself is unavailable, or when a deployment pins an
older catalogue.

Their order is not "biggest context first". The final step of a turn pins its
shape with a strict `response_format: json_schema`, so a model without
structured outputs fails **that one call** — the interesting one — with a 400.
Structured-output models therefore lead, `response_format`-only models follow,
and tools-only models are the tail the walk reaches when nothing better is free.

### What costs a model its turn

A rate limit, a retired id, a moderation refusal, a 5xx — and a `200` that
carries no answer at all, which is the one no status code will tell you about.
The refuser is set aside for sixty seconds, or for however long the service's
own `retry-after` asked, and then it is back in the list. **Nothing is ever
dropped from the pool**: a pool where every member is cooling is exactly the
moment a reader is waiting, and answering *no models available* while ten of
them would have answered is the failure this whole arrangement exists to prevent.

Rotating is not the same as retrying, and the pool does both for different
reasons. Measured against the live pool, three failures in four were a `429`
carrying `retry-after: 1` — a second, on a model that is fine. Waiting one
second is cheaper than spending another of the fifty, so exactly one candidate
per call gets the full retry budget and the rest are walked past.

### Four failures that do not rotate

Asking the next model would be worse than stopping:

- **The reader pressed stop.** They did not ask for a second opinion.
- **An answer is already painting on screen.** There is nowhere to put a second one.
- **A `401`.** A rejected key rejects every model behind it, so rotating turns
  one clear message into ten pointless requests.
- **The day's limit rather than the minute's.** That allowance belongs to the
  account and refuses every candidate identically.

Nor does the pool rotate once the turn has no requests left to spend —
[`budget.rotateAbove`](/reference/config#budget-oneshotbelow-budget-rotateabove)
is `6` by default. Rotation buys a better answer with a request that would have
answered somebody's next question, and that is a trade only a comfortable budget
can make.

### Writing your own order

The shipped pool is a snapshot rather than a contract — free ids are retired
weekly. [`chat.models`](/reference/config#chat-models) replaces it with your own
list, tried in the order you wrote it:

```js
export const docPilot = {
  chat: {
    provider: 'openrouter',
    models: [
      'openrouter/free',
      'openai/gpt-oss-20b:free',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-nano-9b-v2:free',
      'dots-studio/dots-3-note-preview:free',
    ],
  },
}
```

Name a `model` beside it and the pair reads as *this one, and these if it is
busy* — a paid primary with free understudies:

```js
chat: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6', models: ['openrouter/free'] }
```

One thing to know before you write the list: **a pool you assembled is not the
free tier**, as far as the rationing in the next section is concerned. Those
rules engage on a count they can defend — a
[`budget.dailyLimit`](/reference/config#budget-dailylimit) you set, or the
shipped free pool's own published ceiling — and a list of `:free` ids you wrote
yourself is neither. Set `dailyLimit` beside it to get the rationing back.

`npx docpilot doctor --models` is what keeps either list honest: it asks
OpenRouter's live catalogue whether the ids in force are still served, prints the
pool size against the catalogue size, and then `RETIRED:` for every id upstream
no longer lists. It is a flag rather than part of the default run because it is
the only thing in `doctor` that touches the network.

## What DocPilot does without being asked

**It counts.** Every response is recorded against a local ledger — see
[`budget.dailyLimit`](/reference/config#budget-dailylimit). It has to be local,
because OpenRouter sends `X-RateLimit-*` headers **only on a 429**; a client
cannot watch its budget drain, it can only count and be corrected at the end.

**It rations, but only on a budget it can defend.** Below
[`budget.oneShotBelow`](/reference/config#budget-oneshotbelow-budget-rotateabove)
turns become one-shot, and below `budget.rotateAbove` the pool stops rotating.
Both rules are gated on a count that is either yours (`dailyLimit`) or the free
pool's known ceiling — a `remaining` header from some gateway in front of your
own model server is not enough, because those headers commonly count a minute.

**It does not waste the request it spends.** Three fixes matter here and none of
them has a switch, because none of them has a user who wants it back: the strict
answer schema is now actually enforced upstream, a model that answers outside
that schema loses its turn to the next one in the pool instead of ending the turn
on a refusal, and `chat.maxTokens` is now sent.

**It skips the capability probe.** With a pool configured, DocPilot no longer
spends a request per page load asking whether the model can call tools.

## What you have to decide

**Whether the key is shared.** On a public documentation site every reader draws
on one key, so a browser's own count is not the account's. That is why the panel
does not print "43 of 50 left" by default —
[`budget.showRemaining`](/reference/config#budget-showremaining) is off, and set
to `true` it shows the count only where it can be true anyway. What is always
shown is the fact the service stated: when the day is gone, the panel says so and
when answers resume.

**Whether to buy ten credits.** It raises the ceiling from 50 to 1000 requests a
day, which is the difference between a demo and a documentation site. Set
[`budget.dailyLimit`](/reference/config#budget-dailylimit) to `1000` afterwards
so the rationing rules know.

**Whether the rationing suits you at all.** `budget: false` turns every rule off
and leaves the transport fixes in place.

```js
export const docPilot = {
  chat: { provider: 'openrouter' },
  embed: 'auto',
  // The shipped defaults, written out. `budget: false` removes all of it.
  budget: {
    mode: 'auto',        // one-shot once the day is nearly gone
    oneShotBelow: 15,
    rotateAbove: 6,
    dailyLimit: null,    // 1000 once you have bought credits
    showRemaining: false, // true on a key only you draw on
  },
}
```

## When it runs out

The panel says the free daily limit is used up and when answers resume, taken
from the service's own reset rather than guessed. It is a distinct state, not the
generic *The AI service didn't respond* — that sentence is for a transport that
failed, and a service that told you exactly when to come back has not failed.

Nothing is refused pre-emptively off the local count. A count that says zero can
be wrong in the direction that costs a reader an answer the service would have
given, so DocPilot asks and lets the service decide.

## When the BUILD runs out

Everything above is about the reader's question. The other half of the free tier
is `npx docpilot index`, and it is the half that surprises people: the embedding
pool draws on the same daily allowance, so a day spent answering questions is a
day the index cannot be rebuilt.

The pool is two models deep. When both refuse, the build says so and stops:

```
  warn  nvidia/nemotron-3-embed-1b:free is not answering (HTTP 429); trying the next embedder
  FAIL  no embedder answered. Tried 2:
```

**Stopping is the default and it is deliberate.** You still have the index you
had, and the site keeps working exactly as it did. What you do not get is a
half-built one, or a vectorless one nobody chose.

Three ways out, in the order they cost you something:

- **Wait.** The allowance is a UTC day, and the service tells you when it resets:
  the `429` carries `X-RateLimit-Reset`. Indexing a 300-chunk corpus is about ten
  requests of the next fifty.
- **Raise the ceiling.** Ten credits on OpenRouter take the daily limit from 50
  to 1000 requests. Set [`budget.dailyLimit`](/reference/config#budget-dailylimit)
  to `1000` afterwards so the rationing rules know.
- **Declare a fallback.** [`embed.fallback: 'lexical'`](/reference/config#embed-fallback)
  builds a vectorless index instead of dying — BM25 over the chunk text, the same
  mode [`embed: false`](/reference/config#embed-false) declares. Read the cost
  first: recall@8 0.97 → 0.41. It is the right answer when a stale index is worse
  than a weaker one — a corpus that changed materially, and a deploy that has to
  go out today — and the wrong one as a standing setting you forget about.

Naming a **second embedder** as the fallback is not offered, and the reason is
worth knowing: the index and every query have to land in one vector space, so a
second embedder is a second index — and its address would have to reach every
reader's browser. A local Ollama solves the build and breaks the site.

## The zero-allowance deployment

There is a floor below all of this, and it has no allowance to run out: turn the
answering half off entirely.

```js
chat: false,
embed: false,
```

[`chat: false`](/reference/config#chat-false) is search-only — a question is
scored against the index and answered with the ranked passages themselves, each
one an excerpt under a link to the heading it came from. Nothing is generated, so
no request is made. With [`embed: false`](/reference/config#embed-false) beside
it, the build makes none either: no key anywhere, no daily count to ration, and
after the page loads the site fetches nothing but its own static index.

What you give up is the answer — the paragraph that reads three pages and tells
the reader which one they wanted — and, from `embed: false`, most of the recall
that finds those pages. What you keep is the scope picker, the credential check,
the calibrated gate deciding whether the panel leads with matches or with *nothing
matches this closely*, and citations that were never going to be wrong because
nothing wrote them.

It is also the shape to reach for when the day IS spent and the site still has to
answer something: search-only degrades to a better site search rather than to a
panel that has stopped working. Keeping the embedder — `chat: false` alone —
costs nothing per question and buys back the hybrid ranking, at the price of a
key and one build-time pass over the corpus.
