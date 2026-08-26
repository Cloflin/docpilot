# Living on the free tier

OpenRouter's free tier is a real way to run this panel, and it is metered in a
way that catches people out. This page is what the constraint actually is, what
DocPilot does about it, and what you have to decide.

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
