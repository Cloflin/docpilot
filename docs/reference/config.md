---
title: Configuration
---

# Configuration

Everything below goes in the object you pass to `defineDocPilot`, exported by
name from `.vitepress/config.mjs` so the CLI reads the same one.

```js [docs/.vitepress/config.mjs]
import { defineConfig, loadEnv } from 'vitepress'
import { defineDocPilot } from '@cloflin/docpilot'

export const docPilot = {
  product: 'Acme Editor',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
}

const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { docPilot: ai.themeConfig },
})
```

Nested objects merge with their defaults one level deep. Two do not: `embed` is a
union rather than an object, and `sources` is assigned whole — a half-merged
allowlist is one whose contents nobody wrote.

## enabled

- **Type:** `boolean`
- **Default:** `true`

`false` mounts nothing. The site builds as if the package were absent.

## product

- **Type:** `string | null`
- **Default:** `null`
- **Related:** [`i18n`](#i18n)

What the docs are about, in the reader's words. The one brand-shaped string this
package has.

```js
product: 'Acme Editor'
```

It reaches three places: the system instruction (`You answer questions about …`),
the composer placeholder, and the assistant's own introduction when a reader says
hello. Null renders as "this documentation" in every one of them.

It is deliberately **not** part of `i18n`: two locales disagreeing about a
product's name is a defect with no upside, and this value also reaches the system
message, which is build-time and untranslatable by design.

Setting it changes what is sent, so it moves `promptHash` and every eval report is
filed under a new name. That is correct — see
[Calibration and evaluation](/guide/evaluation).

## docsDir

- **Type:** `string`
- **Default:** `'docs'`

Where the VitePress site lives, relative to the project root.

## indexDir

- **Type:** `string | null`
- **Default:** `null` — meaning `${docsDir}/public/rag`

Set it only if you moved the index.

## evalDir

- **Type:** `string`
- **Default:** `'docpilot'`
- **Related:** [Calibration and evaluation](/guide/evaluation)

Where the golden set, the calibration set and the reports live.

## importDir

- **Type:** `string | null`
- **Default:** `null`
- **Related:** [`sources`](#sources), [Imported pages](/guide/imported-pages)

A second corpus root for pages that are indexed but have no route. Off by
default.

```js
importDir: 'knowledge-base'
```

Point it at a directory **outside** `docsDir` and VitePress never sees it: no
route is built, nothing enters the sidebar, the sitemap or llms.txt, and the copy
cannot compete with the original in search. What those pages get instead is a
mandatory frontmatter `source:`, which is the only address their citation can
point at.

## sources

- **Type:** `{ allow: string[] } | null`
- **Default:** `null`
- **Related:** [`importDir`](#importdir)

The list of origins a page may name in its frontmatter `source:`.

```js
sources: {
  allow: [
    'https://example.com',
    'https://example.com/blog',   // that prefix and nothing else on the host
  ],
}
```

A `source:` outside the list **fails the build**, and so does a non-https one —
this value becomes an `href` inside the answer panel, so markdown is never
trusted with a URL scheme. A path narrows the origin at a segment boundary.

`sources` is assigned whole, never merged: a half-merged allowlist is one whose
contents nobody wrote.

## chat

- **Type:** `object`
- **Default:** `{ provider: 'ollama', model: 'qwen3:8b', models: null, temperature: 0.2, maxTokens: 2048, numCtx: 8192 }`
- **Related:** [`embed`](#embed), [Choosing providers](/guide/providers)

The model that answers.

```js
chat: {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 2048,
  numCtx: 8192,
}
```

### chat.provider

Any id from [Choosing providers](/guide/providers). A misspelling stops the build
rather than quietly becoming a local Ollama nobody is running.

### chat.model

The name the provider knows the model by. **The default belongs to the default
provider** — `qwen3:8b` is a statement about Ollama — so naming another provider
and no model does *not* inherit it. What happens instead depends on the provider:

- `openrouter` falls back to its **free pool** (see `chat.models` below).
- Everything else stops the build, because a provider with no model named and no
  pool behind it has nothing to send.

`'auto'` and `'free'` mean the same as leaving the key out, and are normalised to
that before anything reads them — neither is ever sent as a model name.

### chat.models

- **Type:** `string[] | null`
- **Default:** `null`

An **ordered fallback pool**. The transport tries the first, and moves to the
next on a rate limit, a retired id, a moderation refusal, a 5xx, or a 200 that
carries no answer at all. The model that answers is remembered and tried first
next time; the ones that refused are set aside for a minute.

It exists for **shared free tiers**, where a `429` says how many other people are
asking rather than anything about the model — so pinning one free id buys a panel
that works until somebody else's traffic arrives. It is `null` everywhere else on
purpose: on a provider that bills per token, silently moving to another model
changes what a turn costs without being asked.

```js
// the shipped free pool — nothing to write
chat: { provider: 'openrouter' }

// a paid primary with free understudies
chat: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6', models: ['openrouter/free'] }

// your own order, nothing else
chat: { provider: 'openrouter', models: ['openai/gpt-oss-20b:free', 'google/gemma-4-31b-it:free'] }
```

Four failures never rotate, because asking the next model would be worse than
stopping: the reader pressed stop; an answer has already started painting on
screen; a 401, since a rejected key rejects every model in the pool and rotating
turns one clear message into ten pointless requests; and the **day's** limit
rather than the minute's, which belongs to the account and refuses every
candidate behind it identically.

Nor does it rotate once the turn has no requests left to spend — see
[`budget.rotateAbove`](#budget-oneshotbelow-budget-rotateabove). Rotation buys a
better answer with a request that would have answered the next question, and
that is a trade only a comfortable budget can make.

### chat.temperature, chat.maxTokens

`temperature` is 0.2 because this is documentation, not prose: the same question
asked twice should not produce two different sets of steps. `maxTokens` caps one
answer; the panel's own composer caps a question at a thousand characters, and
the two are unrelated ceilings.

### chat.numCtx

Sent on the Ollama transport only; hosted providers size their own context and
ignore it. Ollama's server default is 4096, and a primed turn plus one tool call
already exceeds that — past which llama.cpp shifts the window and drops the
system block off the front, which surfaces as an unexplained refusal.

### chat.extraBody

- **Type:** `object | null`
- **Default:** the provider's own fragment — `{ provider: { require_parameters: true } }`
  on `openrouter`, nothing anywhere else

Fields merged into the body of every chat request, for the things one brand
understands and the transport does not. The transport knows adapters, not
vendors, so this is the one place a brand's own body field is named.

**On OpenRouter it defaults to `provider.require_parameters`, and that is a
defect fix rather than a preference.** OpenRouter picks an upstream for each
request, and an upstream that does not honour `response_format` is sent the
request anyway with the strict answer schema silently dropped. Six of the ten
free chat models measured against this corpus then answered the final call with
prose. A well-formed reply is a spent request, the parse fails, and the reader is
shown *I couldn't find this in the docs* for a question the model in fact
answered. `require_parameters` says: route this only to an upstream that actually
honours the parameters I sent.

It narrows routing, though — a model served by one strict upstream and three
loose ones has fewer places to go, and on a bad day that is a *no provider
available* where there would have been an answer. So it is declinable. Whatever
you write **replaces** the provider's fragment entirely, including `null`:

```js
// widest routing OpenRouter offers, prose replies and all
chat: { provider: 'openrouter', extraBody: null }

// your own fragment in place of the shipped one
chat: {
  provider: 'openrouter',
  extraBody: { provider: { require_parameters: true, sort: 'throughput' } },
}
```

Leave the key out and you get the provider's fragment. The merge is at the top
level of the request body and happens **before** the fields the adapter owns, so
`model`, `messages` and `response_format` can never be overwritten from
configuration. The same fragment reaches `docpilot import`'s annotation pass, so
the CLI and the panel route the same way — a CLI that silently annotated worse
than the panel is a difference nobody would think to look for.

## embed

- **Type:** `'auto' | false | 'none' | { provider?: string, model?: string, baseURL?: string }`
- **Default:** `'auto'` — follow `chat.provider`
- **Related:** [`chat`](#chat), [Building the index](/guide/indexing)

The model that embeds, for the index and for every query. `false` is the third
form and means no embedder at all — [see below](#embed-false).

```js
embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' }
```

`model` **must** be the model that built the index. `baseURL` is read only for a
local provider; a hosted embedder goes through the same proxy the chat does.

`'auto'` on a chat provider with no embeddings endpoint — `anthropic`,
`deepseek`, `groq`, `xai`, `cerebras` — **borrows OpenRouter's free embedding
pool** rather than stopping the build. Set `OPENROUTER_API_KEY`; the borrow is
named in the startup block and in `npx docpilot doctor`, because it means the
text of every chunk is posted to OpenRouter at build time. Naming `embed`
explicitly is never rewritten — and naming a provider that cannot embed still
stops the build.

The choice does not read the environment: a machine without the key resolves the
same embedder as the one that built the index, so the two cannot disagree about
which vector space the index is in. A missing key is reported as a missing key.

### An unnamed embedder, and why it does not rotate

`model` may be **left out** on a provider with a free embedding pool —
`openrouter` today. `npx docpilot index` then walks the pool, embeds with the
first one that answers, and writes that name into the manifest. The browser reads
it from there, so the query vector and the chunks always come from one model.

**The browser never reconsiders that choice.** Two embedding models are two
vector spaces: a query embedded by the understudy scores numbers against these
chunks that look like similarities and are not, and every guardrail downstream —
the width check in the retriever, the calibrated gate — reads them as real. So a
busy embedder at query time is retried, and then retrieval drops to lexical-only,
which is a mode the panel already knows how to report. Rotation is a **build**
decision only.

If the chosen embedder dies mid-build, the index restarts on the next one and
discards what it had collected. One index, one vector space.

An index whose manifest names a model **outside** the pool now in force — switch
`chat.provider` from `ollama` to `anthropic` and the embedder moves without the
index moving — is reported by `readiness` and `npx docpilot doctor` as a rebuild,
not left to fail as a 404 per question.

`npx docpilot doctor --models` compares the pool this package shipped with
against the provider's live catalogue and names any id that has been retired. It
is the only thing in `doctor` that touches the network, which is why it is a flag
rather than a default.

### embed: false

No embedder, anywhere. `npx docpilot index` writes an index with no vectors in
it, the browser fetches no vector blob and embeds no query, and every question is
retrieved on the BM25 channel alone. `'none'` is accepted as the same value
spelled out.

```js
embed: false
```

**It costs most of the recall, and the cost was measured** — on a 1191-chunk
corpus, recall@8 fell from 0.97 to 0.41, retrieval F1 from 0.35 to 0.18, and 11
of 44 answerable questions were refused outright. Those are one corpus's numbers.
`npx docpilot eval --gate-only --lexical` reports yours, against the index you
already have and the golden set you wrote for it, which is the measurement to
take before building one without vectors.

The lexical channel also scores **zero** for a question asked in a language your
corpus is not written in: there is no overlap to count. For a multilingual
audience this is not a trade-off, it is a mode that answers one language and
refuses the rest.

What it buys is a build that makes no embedding calls, one key instead of two, no
corpus posted to an embedding service, and a vector blob — 2 KB per chunk on a
2048-dimensional embedder — that is neither written nor downloaded.

It is a **declared mode, not the degradation of the same name**. Nothing is
retried, nothing is written to the console, and no refusal tells the reader the
search was degraded, because nothing failed. See
[No embedder at all](/guide/providers#no-embedder-at-all) for telling the two
apart in a browser.

`chat` is still required, and no embedding key is.
`npx docpilot index --no-embed` builds one vectorless index without touching the
config, which is the shape for trying it; the key is what a deployment sets,
because the browser has to be told as well.
`npx docpilot doctor` names either disagreement, and they are not symmetric.
An index carrying vectors that `embed: false` will never read is a **note**: the
site ships bytes no reader will use, and the panel works. A vectorless index
under a named embedder is a **failure**: the deployment would embed every
question and have nothing to score it against, so `readiness` refuses it and the
build emits `{enabled: false}` — the panel is not rendered at all. That is the
one to know about if you reach for `--no-embed` on its own: the flag alone
switches the panel off until the config says `embed: false` too.

## topK

- **Type:** `number | null`
- **Default:** `null` — whatever this corpus measured
- **Related:** [`docpilot tune`](/reference/cli#tune), [`guard`](#guard)

How many excerpts the gate hands the model to open a turn with — the retriever's
`GATE_K` under its documented name, and the k every retrieval number in an eval
report is measured at.

**Nothing read this key until now.** It was documented from the first release
with a default of `12`, and no code anywhere looked at it: the gate's k was a
literal in `retriever.js` — `5` — so `5` is what every site has been retrieving
with, whatever this key said, while the build's own startup line printed the
number from here as though it were in force. It is wired up now, and its default
is `null` rather than a number, because no single number is right for every
corpus.

`null` means **use what this corpus measured**. `npx docpilot tune` sweeps the k
against your golden set and writes the winner to `${evalDir}/tuning.json`;
`npx docpilot index` validates that file and inlines it into the manifest; the
browser reads it from there. With no tuning in the manifest, `null` resolves to
the package's own `5` — exactly what every build shipped before this key woke
up, so leaving it alone changes nothing.

A **number** is you overriding that measurement by hand, on the same terms as a
hand-set [`guard.tau`](#guard-tau-guard-taulexical): it wins over the manifest,
it is rounded to an integer and clamped to **1..12** — below 1 the gate hands
over nothing and the model answers from the question alone; above 12 it is asking
the fusion for candidates it never produced, since the fused pool is 12 — and it
stamps `source: 'config'` where the manifest's `'tuned'` would have been, which
is what makes an author's k visible in a report rather than invisible in
behaviour. Only the k moves: an `MMR_LAMBDA` the sweep measured on your corpus
stays measured. A value that is not a number is not reported anywhere; it falls
through to the manifest as though the key were absent.

The whole precedence is one rule with one implementation: a `DOCPILOT_GATE_K` in
the shell you are sweeping from, then this key, then `manifest.tuning`, then the
package default.

**The model's own k is a different number.** `search_docs` takes a k as a tool
argument and that one is clamped `1..8` independently of this setting, so a
`topK` above 8 widens only the excerpts the turn is *primed* with — the model
cannot reach a k of 10 by asking for it. Read a win above 8 as a first-turn win.

### If your config already sets topK

Then it has been setting a value nothing read, and on upgrade it starts moving
retrieval for the first time. Two things before deploying it:

**Check which layer is in force.** The build says so on startup:

```
[docpilot] turn   topK 12 (config) · maxIterations 2 · temperature 0.2
[docpilot] turn   topK tuned (manifest) · maxIterations 2 · temperature 0.2
```

The first line is the key doing something; the second is `null` letting the
measurement through. Before this the line printed a bare number, which was the
same fiction the key was.

**Measure the number rather than keeping it.** `npx docpilot tune` sweeps
λ × k against your golden set on pure retrieval metrics — no chat calls, no
judge — and writes the grid out beside the winner. A k chosen by taste was
harmless while nothing read it, and is not now.

One thing `topK` does **not** reach: `eval`, `bench`, `calibrate` and `tune` all
retrieve off `manifest.tuning` and never read your config, so a hand-set `topK`
moves the browser and leaves the numbers your eval reports where they were. A k
you mean to keep belongs in `tuning.json` — which is `tune`, and then `index`.

## maxIterations

- **Type:** `number`
- **Default:** `2`

**2, and raising it is more expensive than it looks.** The host primes the turn
with the gate's own excerpts, and every accumulated observation is re-sent on
every step, so the cost of a turn grows with the square of its steps rather than
with the evidence in it. Measured at 2 with an 8192-token context: 5.9k prompt
tokens and 0.7k output per turn.

At 20 the worst case is roughly 138k tokens for a single question — and a local
model with an 8192-token window will have shifted the system instruction out of
context long before reaching it.

## budget

- **Type:** `object | false`
- **Default:** `{ mode: 'auto', oneShotBelow: 15, rotateAbove: 6, maxContinuations: 1, showRemaining: true, probe: 'auto', dailyLimit: null }`

The day's **requests**, which is a different scarcity from the tokens
[`maxIterations`](#maxiterations) argues about. OpenRouter's free tier caps at
50 requests a day while the models behind it offer 128k–512k of context, so a
turn costing three or four of them — the capability probe, the loop, the forced
final call — is about fourteen questions before the panel starts reporting an
outage that is not one.

**None of it fires on a budget this package cannot defend.** Two separate things
have to hold before a single rule below engages:

1. **A daily allowance exists to be rationed** — either you wrote one down in
   [`dailyLimit`](#budget-dailylimit), or the answering half is running on a
   provider's own **free pool**: `chat: { provider: 'openrouter' }` with no model
   named, or with the shipped pool behind it. A funded key on a metered provider
   is not a free tier; neither is a `chat.models` list you wrote yourself, since
   a list you chose says nothing about which tier serves it. If one of those is
   in fact metered, `dailyLimit` is how you say so.
2. **The number describing it is daily.** A count read from
   `x-ratelimit-remaining` is believed only when its reset is at least ten
   minutes out, because nginx, Kong, Tyk, AWS API Gateway and the IETF
   `RateLimit-*` draft all emit those same three header names for **per-minute**
   windows: a self-hosted model behind a 20-a-minute gateway reports
   `remaining: 14` all day long, and reading that as fourteen answers left would
   put a paid deployment into one-shot mode permanently.

Anything else leaves the budget unknown and every turn exactly as it is today.
Inferring scarcity from a missing header, or from somebody else's per-minute
allowance, would quietly shorten answers for everyone paying per token.

```js
budget: { mode: 'auto', oneShotBelow: 15 }
```

**The count never refuses a question.** It is a local reading of an account-wide
allowance — another browser profile, another tab, or this project's own CLI may
have been spending the same fifty — so a panel that stopped answering because its
own arithmetic said so would be refusing turns the service would have answered.
The only refusal here is the service's own `429`, and that one arrives with the
time it resets.

`budget: false` is the whole block off in one word: agentic every turn, no line
in the panel, the probe unconditional, and both thresholds set to `-1` — a
comparison against a remaining count that can never come true, so the rules stay
in the code and stop happening. `maxContinuations` alone keeps its shipped value,
because finishing a reply the provider truncated mid-sentence is a defect fix on
any tier rather than a rationing measure.

`probe`, `rotateAbove` and `maxContinuations` are in this block rather than
beside [`chat.models`](#chat-models) and `chat.maxTokens` deliberately. Not one
of them is a fact about the model: they decide whether a request is worth making
before the reader has asked anything, whether a second model is worth one, and
whether finishing this answer is worth one. What they have in common is the only
thing you will have in mind when you go looking for them — they are what you turn
when **requests** are scarce — and splitting one cost-control feature across three
sections makes it three features nobody can find.

### budget.mode

`'auto' | 'agentic' | 'one-shot'`. `'agentic'` is the turn that shipped: up to
`maxIterations` tool-calling steps and then a forced final call. `'one-shot'` is
one model request for the whole question — the iteration ceiling is driven to 0
and control falls straight through to that final call, which already carries the
priming retrieval, the strict answer schema and the citable set. The answer is
narrower, not degraded: it cannot go looking for more evidence first.

`'auto'` is one-shot only once the remaining count is at or below
`oneShotBelow`.

### budget.oneShotBelow, budget.rotateAbove

The two thresholds, in answers left today.

At or below `oneShotBelow` (15) a turn costs one request instead of three or
four, which is what turns the last quarter of the day into roughly three times
as many questions.

At or below `rotateAbove` (6) the pool stops rotating. Rotation spends a second
request on the hope that another model does better, and what stopping buys is the
**request** rather than a worse answer to this question: a reply with no
citations is withheld whatever it cost, so the one that is kept here ends the
turn on the refusal it would have ended on anyway. Six answers left is six more
questions, or three if every turn may ask twice.

`-1` retires either rule on its own — a remaining count is never negative, so the
comparison cannot come true — and it is what `budget: false` writes into both.
Anything else below zero is reported and replaced.

### budget.maxContinuations

How many follow-up requests a **truncated** reply may spend. A provider that
stops at its output ceiling says so, and the half-written JSON object it hands
back fails to parse — so an answer that was three quarters written used to end as
*I couldn't find this in the docs*. One more request finishes it, and the seam is
invisible: the fragments are concatenated before anything reads them. Driven to 0
with two answers left, where the reader is better served by two more questions
than by one tidier paragraph.

**0 to 3.** This is the one number in the block that spends requests rather than
saving them, and it spends them per turn: a truncated reply needs one more
request, occasionally two, so above three it is no longer finishing an answer —
it is retrying a different failure at a request each, against the same fifty a
day. A larger value is reported and the shipped 1 used instead.

### budget.showRemaining

The one muted line under the composer — *38 of 50 free answers left today* — and,
once the panel has dropped to one-shot, one sentence saying that answers get
shorter, which is announced to a screen reader as well as shown. It renders only
where there is something to state: a known count, on a deployment that is
actually metered — the free pool from the first test above, and nothing else. A
`chat.models` list you wrote yourself is not that test, so the line follows the
rationing rather than the shape of the config, and the deployment being rationed
is never the one left unable to see it.

**On by default**, because it is a line inside this package's own panel, and
because it is what turns a panel that has stopped working into a limit that was
stated.

### budget.probe

`'auto' | 'always' | 'never'`. The capability probe is a full model call made
before the reader has read a word — on a pool it asks up to three candidates —
and on a 50-request day it is the single most expensive habit here: opening two
pages spends two answers finding out something the configuration already implies.

`'auto'` skips it where a pool is configured, because a pooled provider's members
are tool-capable by construction and the fallback parser recovers the case where
one is not. `'always'` keeps the behaviour that shipped, for a local model zoo
where the question is genuinely open. `'never'` skips it outright.

### budget.dailyLimit

A ceiling to count against locally, for a metered service that sends no
rate-limit headers. `null` means learn from the headers — and on a provider's own
free pool, the published free-tier number is used until the first response
teaches it better. Header numbers always win over the local count.

**`null`, or a whole number of 1 or more.** `0` is reported and ignored rather
than obeyed, because everything under this key reads a falsy ceiling as
*absence*: written literally, `dailyLimit: 0` would have meant no ceiling at all
and no free-tier fallback either — the opposite of what it looks like, silently.
Declaring a ceiling is also the one way to have these rules apply to a provider
this package does not know to be metered.

## suggestions

- **Type:** `string[] | { questions?: string[], scoped?: boolean, followUps?: boolean }`
- **Default:** `{ questions: [], scoped: true, followUps: false }` — the built-in three
- **Related:** [ui-specs/009]

The three questions on the empty state, and what the panel offers when it cannot
show them.

An **array is still legal** and still means what it always meant — it is
`{ questions: [...] }` with the two behaviours left at their defaults.

```js
suggestions: [
  'How do I connect the editor to my app?',
  'How do I authenticate requests?',
  'How do I build a custom extension?',
]
```

Strings, not `{label, question}` objects: the row submits what it shows, so a
separate label would put a question the reader never read into the thread.

The first three are used. Extras, empties, repeats and non-strings are dropped and
**named on stdout** — a silent cap reads as "covered everything" when it did not.

These are gate inputs, not headings. A question your corpus cannot answer produces
a refusal on the reader's first click, in the one state that exists to show the
panel working. The built-in three are engine-agnostic for exactly that reason, and
are worth replacing.

### suggestions.questions

The array, under its own name. `suggestions: ['One?']` and
`suggestions: { questions: ['One?'] }` are the same setting.

### suggestions.scoped

What an empty panel offers when the scope is **not** all the docs. The openers
above are suppressed there — they would fall outside the scope and the gate would
refuse every one of them — and before this the result was a blank panel shown to
the one reader who had narrowed things down on purpose. What goes there instead
is the pages in the scope, as rows. Nothing is generated.

```js
suggestions: { questions: [...], scoped: false }   // back to the blank panel
```

### suggestions.followUps

Two or three questions under the newest answer, built from the headings on the
pages that answer cited, minus the ones it used. No model call, and nothing
invented: the wording is a template, so it cannot name a section your corpus does
not have.

**Off by default, and the reason is measured rather than felt.** ChatGPT ships
follow-up suggestions and its readers write custom instructions to suppress them.
Copy that ships on has to be good for every corpus; copy you opt into only has to
be good enough for yours.

## quote

- **Type:** `object`
- **Default:** `{ fromAnswer: true, fromDocs: false }`

Selecting a passage and asking about it.

```js
quote: { fromAnswer: true, fromDocs: false }
```

### quote.fromAnswer

Select inside an answer and one button appears above the selection; pressing it
attaches the passage to the composer as a chip. This is the behaviour the panel
has shipped with — it simply had no switch until now.

### quote.fromDocs

The same popover over **your own article**. It is the gesture a documentation
reader actually has — select the paragraph that confused you — and until this it
led nowhere: open the panel, retype the question, lose the text it was about.

**Off by default**, because it paints a control on your prose. The reader who
selects a command in order to copy it must not meet a button every time, and that
is a decision about your site rather than about this panel.

## citations

- **Type:** `object`
- **Default:** `{ passage: true, inCopy: true, pagesRead: false }`
- **Related:** [What DocPilot guarantees](/concepts/guarantees)

What a reader can do with a citation besides believe it.

```js
citations: { passage: true, inCopy: true, pagesRead: false }
```

Not to be confused with [`sources`](#sources), which is the allowlist of origins
an imported page may name. That one decides what may become a link; this one
decides what the reader can see behind the links that are already there.

### citations.passage

A source row expands to show the exact retrieved passage — the chunk the host put
in front of the model on that turn. It costs no request: the text is already in
the reader's browser.

The point is what [the guarantees](/concepts/guarantees) say out loud — citation
is provenance, not entailment — which makes checking a source a normal step of
reading rather than an edge case. Without it, the only way to take that step is a
navigation that on a narrow screen closes the panel and takes the thread with it.

On a conversation restored from a previous visit the passage is resolved by id
against the current index; if the docs have been rebuilt and that chunk is gone,
the control is simply absent.

### citations.inCopy

Copying an answer appends its sources as Markdown links, with absolute URLs.
Without it a `[1]` pasted into a ticket arrives with nothing behind it, which is
worse than no citation at all because it looks like provenance.

### citations.pagesRead

Names the pages a refused turn actually read, under the line that already says
*searched and read 3 pages*. **Off by default:** it is a second list on a surface
that already carries one.

## composer

- **Type:** `object`
- **Default:** `{ editLastOnArrowUp: true, deepLink: true }`

Two ways into the field.

```js
composer: { editLastOnArrowUp: true, deepLink: true }
```

### composer.editLastOnArrowUp

`↑` in an **empty** composer opens the last question for editing, caret at the
end. ChatGPT's own behaviour, and readline's before it. The empty condition is
not a nicety: without it the key would stop moving the caret inside a multi-line
draft.

### composer.deepLink

`?dp-ask=…` opens the panel with that text in the composer.

```
https://docs.example.com/guide/auth?dp-ask=How%20do%20I%20rotate%20a%20key
```

**It does not submit.** The reader stays in charge of spending a turn, a crawler
following the link spends nothing, and a question somebody else wrote is one the
reader should get to read first. `&dp-scope=page` narrows the search to the page
they landed on. Both parameters are removed from the address bar once read, so a
reload does not refill a composer they emptied.

The names are prefixed because a documentation site may well own `ask` already.

## guard

- **Type:** `object`
- **Default:** `{ mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3 }`
- **Related:** [The refusal gate](/concepts/the-gate)

Overrides for the calibrated thresholds. Use `npx docpilot calibrate` instead.

```js
guard: { mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3 }
```

### guard.mode, guard.supportMinIdentifiers

`mode` selects which thresholds the gate reads: `'calibrated'` takes the measured
pair from the manifest, and it is the only value worth setting. Everything below
is what happens when you do not.

`supportMinIdentifiers` is the floor under the support check — an answer carrying
fewer than this many code identifiers is not scored for support at all, because
three symbols is not enough evidence to call a ratio a measurement.

### guard.tau, guard.tauLexical

**Measured, not chosen.** `npx docpilot calibrate` writes them into
`${evalDir}/calibration.json` and `npx docpilot index` inlines them into the
manifest. Setting them here overrides the measurement and stamps
`gate.source: "config"` on every record of the session, which is what makes a
hand-set threshold visible in a report rather than invisible in behaviour.

On a vectorless index there is no dense channel to measure `tau` against, so
`calibrate` sweeps `tauLexical` alone and leaves `tau` null rather than writing a
number nothing measured.

## scope

- **Type:** `object`
- **Default:** `{ enabled: true, default: 'all', promptListLimit: 12, filter: 'auto', groupBySection: true }`

The scope picker.

```js
scope: { enabled: true, default: 'all', promptListLimit: 12, filter: 'auto', groupBySection: true }
```

`enabled: false` removes the picker; every question then searches the whole
corpus. `default` accepts `'all'` and nothing else — a build-time default of
`page` would silently narrow every reader's first question. `promptListLimit`
caps how many page titles the scope block names in the instruction.

### scope.filter

A filter field above the page list. `'auto'` — the default — shows it once the
corpus is past twelve pages, which is `promptListLimit`'s own number and the same
judgement: a list longer than that is a list nobody scans. `true` and `false`
decide it outright.

A flat, unfiltered list of every page inside a 240px scroller is fine at twelve
pages and unusable at three hundred.

### scope.groupBySection

Section headings inside the picker, taken from your sidebar. Suspended while a
filter is on: grouping a filtered list fragments it into headings with one row
under each, which is the opposite of what narrowing was for.

## history

- **Type:** `object`
- **Default:** `{ enabled: true, maxConversations: 20, exportThread: true }`
- **Related:** [Conversation history](/guide/history)

Past conversations, kept in the reader's `localStorage` and listed in the panel.

```js
history: { enabled: true, maxConversations: 20, exportThread: true }
```

### history.exportThread

A button in the panel header that copies the whole conversation as Markdown.
Per-turn copy already existed; what somebody pastes into a ticket is the thread,
and reassembling one out of four separate copies is the work this removes. It
honours [`citations.inCopy`](#citations-incopy), so an exported thread and an
exported answer agree about provenance.

### history.maxConversations

The length of that list; the oldest falls off the end. A byte ceiling applies
underneath it and is deliberately not a setting: `localStorage` is about 5MB **per
origin**, shared with VitePress and your own theme, so the panel keeps to a tenth
of it rather than asking you to reason about the split.

### history.enabled

`false` does two things, not one. It stops recording, **and it clears what is
already stored** on the reader's next visit — the same rule `prompt.show: false`
applies to a reader's saved instruction. A site that turns this off after a
privacy review leaves nothing behind.

## ui

- **Type:** `object`
- **Default:** `{ trigger: 'nav', panel: 'auto', fabLabel: true, fabIcon: true, layout: 'overlay', prefetch: 'hover', firstRunHint: false }`
- **Related:** [Appearance](/guide/appearance)

Where the button lives, what shape the panel takes, what the floating button is
made of, and how the panel treats the page it opens over.

```js
ui: { trigger: 'nav', panel: 'auto', fabLabel: true, fabIcon: true }
```

| key | values | default |
|---|---|---|
| `trigger` | `'nav'` — beside the search box · `'fab'` — floating, bottom right | `'nav'` |
| `panel` | `'auto'` · `'drawer'` — full height, right edge · `'popup'` — floating, above the button | `'auto'` |
| `fabLabel` | `true` — the shipped words · a string — those words · `false` — no label | `true` |
| `fabIcon` | `false` drops the sparkle | `true` |
| `layout` | `'overlay'` — the panel covers the page · `'push'` — the page moves aside | `'overlay'` |
| `prefetch` | `'hover'` · `'idle'` · `false` | `'hover'` |
| `firstRunHint` | `true` shows one dismissible line on a first visit | `false` |

A value outside either enum is reported on stdout during the build and falls back
to the default; nothing throws, because a typo in a cosmetic setting must not be
able to fail a docs build.

### ui.layout

The desktop drawer is fixed to the trailing edge, so it covers your right aside
and, on a narrow desktop, part of the prose column. `'push'` gives the content an
inline-end padding while the panel is open, so the two sit side by side.

**Off by default**, because it reflows your layout on every open and not every
theme will take that well — it is a mode you choose rather than a fix that
arrives. Below 960px it does nothing: the panel is edge to edge there and there
is nothing to push.

### ui.prefetch

When the retrieval index is fetched. Before this it happened on open, so the
first question of a session was the slow one and the reader's first impression of
the panel was *Loading the docs index*.

| value | when |
|---|---|
| `'hover'` | the first pointer or focus on the trigger — close to intent, almost never wrong |
| `'idle'` | once the page has settled, for a site that would rather pay up front |
| `false` | on open, as it happened before this setting existed |

Only the download is prefetched. Restoring the scope and the conversation stays
on open, because that half can announce into a screen-reader live region and the
panel is not on screen yet.

The index of a large corpus is real traffic, spent on readers who may never open
the panel — so it is skipped entirely when the browser reports `saveData` or a
2G-class connection.

### ui.firstRunHint

One dismissible line under the empty state's suggestions, shown once per device,
naming the single thing a reader will not discover on their own: that selecting a
passage offers to ask about it.

**Off by default** — it paints something nobody asked for on a first visit. It is
also withheld when both [`quote`](#quote) switches are off, because a hint naming
a gesture the panel does not answer is worse than no hint.

### ui.panel

`'auto'` follows the trigger: `nav` opens the drawer, `fab` opens the popup. The
crossed pairs — `nav` + `popup`, `fab` + `drawer` — are carried out in silence,
which is what `'auto'` is for: once the implied pairing has a name of its own, an
explicit value is an intention rather than a mistake to correct.

Below 960px both shapes are the same full-screen sheet, and the floating button
hides itself while it is open.

### ui.fabLabel, ui.fabIcon

A sparkle alone means "AI" to people who already know the pattern and nothing to
everyone else — and unlike the navbar trigger it has no search box beside it to
borrow context from. So it carries words:

```js
ui: { trigger: 'fab', fabLabel: 'Спросить ИИ' }   // exactly these words
ui: { trigger: 'fab', fabLabel: false }           // the 48px circle, icon only
ui: { trigger: 'fab', fabIcon: false }            // words only
```

`fabLabel: true` looks the string up through [i18n](/guide/i18n) as
`trigger.fabLabel` — **Ask AI** by default — so a multilingual site gets it per
locale from the tree it already has. A **string** is taken verbatim and is *not*
looked up: an author who typed the words has already chosen the language. A blank
string is the same as `false`.

`fabIcon: false` and `fabLabel: false` together is the one combination that has no
rendering. It is reported on stdout and the icon is kept: the failure mode of a
cosmetic setting must never be a panel nobody can open.

Both keys describe the **floating** placement only. The navbar trigger has always
been icon-only beside the host's search box and the mobile nav-screen row has
always been text; neither reads them, and `npx docpilot init` still asks only the
two placement questions.

**This is a departure from convention, and worth saying so.** No package in either
dependency tree of this project exposes an enum for placement — placement is
normally the consumer's business, expressed by choosing which slot to fill. Here
the slots belong to `docPilotSlots()`, which runs at import time when
`themeConfig` cannot be read, so an enum is the only way for a consumer to express
the choice at all. [Appearance](/guide/appearance) covers the geometry each value
produces.

## feedbackEndpoint

- **Type:** `string | null`
- **Default:** `null`
- **Related:** [`feedback`](#feedback), [Production](/guide/production#collecting-feedback)

Where a thumbs-up/down POSTs.

Null keeps every vote in `localStorage`, readable from the console with
`window.__docPilot.exportFeedback()`. Set a URL and a vote is POSTed as JSON —
question, verdict, reasons, any sentence the reader wrote, the gate's own numbers,
the model, the prompt hash. The full body, the receiver contract and the SQL are
on [Production](/guide/production#collecting-feedback).

Two keys for one subject, because `feedbackEndpoint` shipped first and a bare
`feedbackEndpoint: '/feedback'` keeps working unchanged. The endpoint is
**where**; [`feedback`](#feedback) is **what** and **whether**.

## feedback

- **Type:** `object`
- **Default:** `{ send: 'both', comment: true, confirm: true }`
- **Related:** [`feedbackEndpoint`](#feedbackendpoint)

```js
feedback: { send: 'both', comment: true, confirm: true }
```

| key | values | |
|---|---|---|
| `send` | `'both'` · `'down'` · `'up'` · `'none'` | Which verdicts leave the device. `'none'` keeps everything local while leaving the thumbs on screen. |
| `comment` | `true` · `false` | Whether a down-vote offers a free-text box. The box is hidden anyway when nothing would be transmitted. |
| `confirm` | `true` · `false` | Whether submitting the form leaves a line saying so. |

### feedback.confirm

Submitting used to remove the form and say nothing a sighted reader could see,
which is indistinguishable from closing it unsent. The line that replaces it
names where the report went, and it says two different things depending on
`send` — because one sentence would be false under two of the four modes.

### feedback.send

**`'both'` is the default because a table of complaints is not a measurement.** A
helpfulness rate needs a denominator, and probes drawn from down-votes alone are a
purely negative sample — calibrating a threshold against one moves the gate toward
refusing every reader. `npx docpilot feedback report` says so in its own output
when it has to. Set `'down'` if you only want to hear about failures and will not
be using the sample to move a threshold.

The panel's disclaimer follows this setting, in the reader's language: no endpoint
or `send: 'none'` says nothing about reports, `'down'` says not-helpful reports
are sent, and `'up'`/`'both'` says the rating is. A reader who is told their
report goes nowhere and finds that it does is entitled to be annoyed.

### feedback.comment

A down-vote opens a form: the four reasons, which are **multi-select** — a wrong
answer is often also an incomplete one — and a text box.

What the reader types is capped at 500 characters and run through the same
credential redaction the question gets, **before** it is stored and before it is
sent. That is not a setting. `credentials.js` exists so the panel can tell a
reader that a pasted key went nowhere, and it names feedback reports as one of the
directions such a key travels; a comment box that shipped raw text would make that
promise false. A key in a comment is replaced with `YOUR_SECRET_KEY` in
`localStorage` and in the request body alike.

### Two POSTs per report, one row

The thumb POSTs immediately — a reader who closes the tab has still been heard —
and the form POSTs again when it is submitted, under the **same `messageId`** with
`revision` raised. Withdrawing a vote posts too, with `verdict: null`, so a reader
can take back what they said.

**Your receiver must upsert on `messageId` and keep the higher revision.** The SQL
that does it is on [Production](/guide/production#collecting-feedback), along with
the two clauses that are load-bearing and easy to leave out.

## prompt

- **Type:** `object`
- **Default:** `{ show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: '' }`

```js
prompt: { show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: '' }
```

Two different things under one key.

### prompt.show, prompt.allowAppend

About the **reader**: whether the instruction is published in the panel, and
whether they may add a line to it for their session. That line never reaches the
system message.

### prompt.appendMaxChars

The ceiling on the reader's own instruction, in characters. It is a `maxlength`
on the field, so it is visible before it is hit rather than after; `0` switches
`allowAppend` off entirely, which is the same thing said twice and is accepted as
such.

### prompt.override, prompt.extend

The instruction the **model** is sent. `override` replaces the shipped text
outright; `extend` is appended to whichever is in force.

**Three rules in the shipped text are load-bearing for the host, not style.** An
override that drops them refuses every turn however good the model is, because the
answer is checked, not the prompt:

- cite every claim with `[1]`, `[2]` matching the citations array;
- return confidence 0 when the excerpts do not answer the question;
- no headings; code in fenced blocks.

An override also drops the credential rules, silently — no host check notices
their absence. After any override, re-run `npx docpilot calibrate`: the gate was
measured against the shipped instruction.

`{product}` is not interpolated into an override. An override is text you wrote in
full, and substituting into it would make `{product}` a syntax you never opted
into.

## host

- **Type:** `{ base?: string, ragBase?: string, article?: string, search?: string|false, content?: string }`
- **Default:** every key `null`
- **Related:** [Sites that are not VitePress](/guide/other-sites)

The four things about your site the panel cannot work out for itself: where it is
served from, and which elements on the page are the article, the search button
and the main content.

```js
host: {
  base: '/docs/',
  article: '.theme-doc-markdown',
  search: '.DocSearch-Button',
}
```

**Every default is `null`, and that is the design.** `null` means *nobody said*,
which has to stay distinguishable from a value you chose — a default of `'main'`
would outrank the `.vp-doc, main` the VitePress binding supplies, and the
selection-to-quote offer would stop appearing on half the pages of a VitePress
site with nothing to explain why.

Three layers resolve, in this order: **what you write here**, then **what the
host binding supplies** — `@cloflin/docpilot/theme` installs one for VitePress,
and the framework adapters install their own — then a neutral fallback. On
VitePress you never set any of these.

### host.base

The site's base path. `/docs/` for a site served in a subdirectory; neutral `/`.

Applied at exactly **two** points — the index fetch and following a citation —
and nowhere else. Paths in the manifest and hrefs in an answer are base-less
everywhere, which is what lets the citation validator compare the two literally.
On VitePress the binding reads it from Vite, so it is already correct.

### host.ragBase

Where the built index is served from. Derived as `${base}rag` — which is what a
static host does with `public/rag` — and set explicitly only when the index lives
somewhere else, a CDN or a separate origin.

This replaces a workaround: the panel used to fetch the literal `/rag`, so a site
at `https://example.com/docs/` had to mount that directory at the root of its
origin in the reverse proxy. It no longer does.

### host.article

The element a selection has to be inside for the panel to offer to quote it —
neutral `main`, `.vp-doc, main` on VitePress.

The nav, the sidebar and the footer are deliberately outside it: *Ask AI* over a
sidebar link is a control offering to ask a question about a menu.

### host.search

The host's own search button, which the panel's degraded and error states offer
as the thing to do instead.

There is no neutral value, because no two sites agree on one — so **without a
selector from either layer the affordance is not rendered at all**. A button that
clicks nothing is worse than no button. Pass `false` to suppress it on a host
whose binding supplies one.

### host.content

The element focus returns to when the panel closes and the control that opened it
has gone with a route change. Neutral `main`, `#VPContent, main` on VitePress.

## i18n

- **Type:** `{ translations?: object, locales?: object }`
- **Default:** `{ translations: {}, locales: {} }`
- **Related:** [Translating the panel](/guide/i18n)

```js
i18n: {
  translations: { empty: { heading: 'How can I help?' } },
  locales: { ru: { translations: { empty: { heading: 'Чем помочь?' } } } },
}
```

The inside is byte-for-byte VitePress's own
[local-search i18n](https://vitepress.dev/reference/default-theme-search#local-search-i18n),
so their example transfers unchanged. The full key table, the two selectors and
the fallback chain are on [Translating the panel](/guide/i18n).

## What reaches the browser

`ai.themeConfig` is compiled into the client bundle. It carries the provider
**adapter** (not the brand), a same-origin base path, the model name, and the
settings above — `ui` crosses already resolved, so `'auto'` never reaches the
browser. It never carries a key or an upstream host.

Three facts about the service travel with it as data rather than as a brand
name: a request-body fragment the adapter merges without reading
([`chat.extraBody`](#chat-extrabody)); whether the service publishes a daily
request ceiling at all; and — the narrower of those two, and the only one
anything acts on — whether this deployment answers off the provider's own **free
pool**, which is what tells the panel there is a [`budget`](#budget) worth
counting and rationing. The wider flag is true for a funded key on the same
service, which has no daily ceiling of any kind; reading it as a free tier is
what once put a paying deployment on one request per turn. None of the three
names who is answering, so the browser still knows adapters and transports rather
than vendors.

Five keys are deliberately withheld — `docsDir`, `indexDir`, `evalDir`,
`importDir` and `sources`. They describe the build, not the panel, and the
allowlist in particular has already done its work by then: the origin it approved
is baked into `manifest.pages[].origin`.

That list is asserted, not remembered: a test walks every key of `DEFAULTS` and
fails unless it is either emitted to the client or named in `SERVER_ONLY`. A
setting that is documented but never sent — which is how `suggestions`, `guard`,
`scope` and `feedbackEndpoint` all shipped once — cannot happen twice.
