# The answer ladder

A turn never ends empty-handed. By the time anything can fail, the question has
been embedded, the corpus has been searched on both channels, the gate has scored
it and every ranked passage is sitting in memory — and not one of those needed a
model. *The AI service didn't respond*, printed over that, throws a completed
turn away to apologise for the half of it that did not finish.

So there is an order, and this page is it: what is tried, what makes each rung
step aside, and what the reader sees when it does.

```
 your question
        │
        ▼
   retrieval — BM25 and vectors, both channels, always
        │
        ├─ embedder unreachable ─▶ 3. lexical-only evidence, and the
        │                            turn continues on it
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ 1. every provider your keys select, billed accounts first   │
 │      openai → gemini → … → the set your environment holds   │
 │      429 · 5xx · 401 · network ─▶ the next provider         │
 │                                                             │
 │ 2. a provider's own free catalogue, beneath every billed    │
 │    account — openrouter/free → nine free ids                │
 │      one model 429s ─▶ the next model, inside that member   │
 │                                                             │
 │    a server of your own — custom · llamacpp · ollama — last │
 └─────────────────────────────────────────────────────────────┘
        │
        ▼
 4. nothing answered — the passages this turn already retrieved,
    linked, under one sentence:
    "The AI models aren't reachable right now — this is a search
     answer. The closest passages:"
```

## 1. Paid providers, in priority order

[`chat.chain`](/reference/config#chat-chain) ships as `false` — one provider,
chosen once. Write `'auto'` and it becomes *every* provider the environment holds
a key for, walked in order rather than the first one and then a shrug. An
environment with one key selects one member either way, which is the scalar
configuration this package has always emitted, to the byte; the word is what
changes an environment holding several.

It ships off because a request going to a provider that appears nowhere in the
config file you are reading is a request you cannot account for from that file.
Everything below this line describes a ladder you asked for.

**They are not walked in the order the table lists them.** [The provider
chain](/guide/providers#name-nothing-the-provider-chain) is ordered by *what one
key covers* — embed-capable services first — which is the right question for
choosing one provider and the wrong one for ordering a set. Walking it verbatim
spends a reader's question on a 50-a-day allowance shared by the whole site while
a funded key sits two rows below it. So the selected set sorts into three tiers,
`CHAIN`'s order preserved inside each:

| tier | members | why here |
|---|---|---|
| 0 | every provider billed to your account | the allowance is yours, and it is per token |
| 1 | a provider's own free catalogue — OpenRouter's [free pool](/guide/free-tier) | 50 requests a day, shared by every reader of the site |
| 2 | a server of your own — `custom`, `llamacpp`, `ollama` | nobody but you can reach it |

`openrouter` sits at position 7 of the table and answers *after* `groq` here.
`ollama` answers last, whatever the table says.

**A model you named keeps its provider billed.** `chat: {model:
'anthropic/claude-sonnet-4'}` beside an OpenRouter key is a paid deployment — the
free catalogue answers only where nothing was named — and sinking it would hand
that model name to whichever provider sorted above it, which is a 404 for a model
nobody typed there. So naming a model, or writing your own
[`chat.models`](/reference/config#chat-models) list, flattens the tiers and the
order is `CHAIN`'s, unchanged. The sort fires exactly where the whole question is
*which of these keys, in what order* — the zero-config path.

The head is picked from the same sorted list, so `chain[0]` **is**
[`chat.provider`](/reference/config#chat-provider) and `embed: 'auto'` follows the
member that leads rather than a member the sort moved past.

### What costs a provider its turn

Wider than the rule inside a pool, and deliberately so: every exclusion the pool
makes is an argument about the same host and the same account, and none of them
survives a provider boundary.

| | inside the pool | across a provider |
|---|---|---|
| `429`, the minute's | next model | next provider |
| `5xx`, a retired id, a moderation refusal, a `200` with no answer | next model | next provider |
| `401` | stops — a rejected key rejects every model behind it | **next provider** — the next one is a different key |
| a network failure, no status at all | stops — same socket | **next provider** — a different host |
| `429`, the day's | stops — the allowance belongs to the account | **next provider** — a second key has its own |
| the reader pressed stop, or the step timed out | stops | stops — the signal every later request inherits is already dead |

**Only the last member's daily `429` escapes**, which is what keeps
`rate-limited` a real state: the turn still settles with the reset the service
named rather than with a generic failure.

A member that stepped aside goes to the **back** of the order for a minute, or
for however long its own `retry-after` asked — never out of it. A chain where
every member is cooling is exactly the moment a reader is waiting. There is no
sticky sibling to that cooldown, and the absence is the point: a sticky member
would let one blip promote a free tier above the billed account the deployment
configured first, which inverts the order this whole feature is about.

**Rotation is silent.** No badge, no notice, no line under the answer — a service
stepping aside for the next one is the ladder working, and reporting it would
label a correctly answered turn a fault. `?dpdebug=1` prints
`turn.ladder = {provider, index, freePool}`, and a
[feedback](/reference/config#feedbackendpoint) record carries it, which is where
*the first member was down all afternoon* is a question somebody can actually ask.

### Writing the order yourself

Three surfaces already exist and no new knob was added:

| what you are ordering | where you say it |
|---|---|
| which providers, in what order | the [`chat.chain`](/reference/config#chat-chain) array — a named `chat.provider` **leads** it and is deduped from the tail |
| which models, on a member that is not the head | the member object — `{provider, model, models, baseURL}` |
| which models on the head | [`chat.model`](/reference/config#chat-model) is the primary, [`chat.models`](/reference/config#chat-models) the ordered understudies |

```js
export const docPilot = {
  chat: {
    chain: [
      { provider: 'openai', models: ['gpt-4o-mini', 'gpt-4o'] },
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      'openrouter',
      { provider: 'ollama', baseURL: 'http://localhost:11434' },
    ],
  },
}
```

A model name never crosses providers — `gpt-4o-mini` posted to Groq is a 404 for
a model nobody typed — so `chat.model` and `chat.models` reach the head member
and no other. Give a later member its own.

## 2. The free pool

Once the walk reaches a provider's own free catalogue, the same argument arrives
one level down — because a free id is a shared allocation, so its `429` reports
how many other people are asking rather than anything about the model, and
pinning one buys a panel that works until somebody else's traffic arrives.

`chat: {provider: 'openrouter'}` with no model named answers that on the
service's side: its default is **`openrouter/free`**, OpenRouter's own router
over the free tier, which picks a free model per request and skips the saturated
ones. One id, one request.

`chat: {provider: 'openrouter', model: 'free'}` is the second rotation proper —
an ordered pool of ten, the router at its head and nine explicit free ids behind
it, walked by the browser. It is opt-in as of 1.4.0, for the reason
[engine-spec 021](https://github.com/Cloflin/docpilot/blob/main/engine-specs) is
about: a refusal that is really about the request body buys the identical refusal
once per member.

The two rotations are the same argument at two levels, and the table above is the
difference between them. Both are metered by the thing that catches people out:
**requests per day, not tokens** — 50 of them under ten lifetime credits, 1000
over. [Living on the free tier](/guide/free-tier) is the whole of that.

**A mixed chain turns per-day rationing off.** Every rationing rule is gated on
an allowance it can defend, and a free tier beside a metered account is two
allowances against one counter. The build says so rather than leaving it to be
discovered on an invoice: once the free tier's day is spent, questions rotate to
the billed member and are billed. Set
[`budget.dailyLimit`](/reference/config#budget-dailylimit) to state one ceiling
for the whole chain and the rationing comes back.

## 3. Retrieval degrades, the answer does not

This rung is not a service the walk reaches — it is the evidence half thinning
out beneath whichever rung answered. The embedder is retried, and then retrieval
drops to lexical-only: BM25 alone over the chunk text, the title, the breadcrumb,
the path and the anchor, with the gate switching to its lexical threshold. The
dense list is simply empty, and the model that answers is whichever one the walk
above reached.

It is a mode rather than a failure, and it is an expensive one — on a 1191-chunk
corpus recall@8 fell from 0.97 to 0.41. Read [what it
costs](/guide/providers#no-embedder-at-all) before treating a run of them as
normal. A site that [declared](/reference/config#embed-false) lexical-only looks
nothing like a site that lost its embedder: the first logs nothing, the second
carries the reason in the console and says *degraded* on a refusal.

What never happens here is a second embedder. Two embedding models are two vector
spaces, and a query embedded by the wrong one scores noise that every guardrail
downstream reads as a real number — so retrieval degrades to a weaker channel
rather than to a foreign space.

## 4. The hybrid answer

Every service was asked and none answered. The turn settles as `results` with
`turn.hybrid` set, which is the [search-only product](/reference/config#chat-false)
reached at runtime rather than by configuration: the same ranked rows, each a
verbatim excerpt under a link to the heading it was cut from, under one sentence
that names the cause and then gets out of the way.

> The AI models aren't reachable right now — this is a search answer. The closest
> passages:

**Retry** and **Search the docs** sit under the rows — the same pair the
transport error offers, for the same reasons: the outage may well have cleared,
the quote travels with the question, and search never depended on a model.
Nothing was generated, so there is no claim here for the panel to be wrong about.

Two turns still settle elsewhere, and both are correct:

- **A failure before retrieval** has no rows to show and is the transport error
  it always was — *The AI service didn't respond.*, `state: 'error'`, with
  `role="alert"` on it.
- **A spent daily limit** keeps `state: 'rate-limited'` and its own copy, because
  the service did answer and what it answered was a schedule. The passages are
  listed beneath it too, links only, under the quieter *Meanwhile, the closest
  passages:* — printing "come back at four" while the sections that answer the
  question sit in memory is the panel being less useful than the index it shipped
  with.

## What the reader sees, rung by rung

| rung | what happens | what is said | turn state |
|---|---|---|---|
| 1 | a provider steps aside for the next | nothing — silent | `complete` |
| 2 | a free model steps aside for the next | nothing — silent | `complete` |
| 3 | the dense channel is gone | nothing on an answer; *Search is running degraded…* on a refusal | `complete` or `no-answer` |
| 4 | nothing answered | *The AI models aren't reachable right now — this is a search answer. The closest passages:* | `results`, `hybrid` |
| — | the day's allowance is spent | *The free daily limit for this site's AI is used up. Answers resume 18:40.* then *Meanwhile, the closest passages:* | `rate-limited` |
| — | it failed before retrieval | *The AI service didn't respond.* | `error` |

## What never happens

**Nothing rotates once a delta is on screen.** Across services as well as within
a pool: there is nowhere to put a second answer, and a turn that started painting
one provider's sentence and finished with another's is worse than the failure it
was avoiding.

**A provider you named is never overridden**, whatever the environment holds — a
promise that predates this key. Naming one is therefore how provider rotation is
declined, and `chain: false` declines it without naming one. An explicit array is
the exception, and only because you wrote the array.

**No key ever reaches the browser.** Every hosted member is called through a
same-origin `/ai` path and the reverse proxy attaches the credential; a chain of
several members is several routes, which `npx docpilot doctor --proxy` prints for
your configuration. See [Production](/guide/production).

**The embed half never rotates.** `npx docpilot index` picks one embedder, writes
it into the manifest, and every reader's browser is bound to that name for the
life of the index. The ladder is the answering half only.

**No rung is announced as a fault.** The fourth is the only one a reader is told
about outright, and only because they are looking at passages instead of prose
and are owed the reason. The third says *degraded* on a refusal, where a weakened
search is a competing explanation for what was not found — never over an answer
that came out fine.

[How a turn works](/concepts/a-turn) is the six stages this ladder hangs under,
and [The refusal gate](/concepts/the-gate) is the one that can end a turn before
any of it runs.
