# Choosing providers

Chat and embeddings are **two decisions**, and the second is the one that is easy to get wrong.

You can also make neither. Read the next section first.

## Name nothing: the provider chain

`chat.provider` ships as `'auto'`, which reads your environment:

```bash
# .env.local — one key, any one
OPENAI_API_KEY=sk-…
```

```js
// docs/.vitepress/config.mjs
const ai = defineDocPilot({}, loadEnv('', process.cwd(), ''))
```

That is the whole configuration. `'auto'` walks an ordered list and stops at the
first service a key is set for; that service's own default model comes with it,
and `embed: 'auto'` follows it into the retrieval half.

| # | id | Selected by | Embeds? | Model when you name none |
|---|---|---|---|---|
| 1 | `openai` | `OPENAI_API_KEY` | yes | `gpt-4o-mini` |
| 2 | `gemini` | `GEMINI_API_KEY` | yes | `gemini-2.5-flash` |
| 3 | `mistral` | `MISTRAL_API_KEY` | yes | `mistral-small-latest` |
| 4 | `together` | `TOGETHER_API_KEY` | yes | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| 5 | `fireworks` | `FIREWORKS_API_KEY` | yes | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| 6 | `nebius` | `NEBIUS_API_KEY` | yes | `meta-llama/Llama-3.3-70B-Instruct` |
| 7 | `openrouter` | `OPENROUTER_API_KEY` | yes | *[the free pool](#openrouter-with-nothing-named)* |
| 8 | `anthropic` | `ANTHROPIC_API_KEY` | no | `claude-sonnet-4-6` |
| 9 | `groq` | `GROQ_API_KEY` | no | `llama-3.3-70b-versatile` |
| 10 | `deepseek` | `DEEPSEEK_API_KEY` | no | `deepseek-v4-flash` |
| 11 | `xai` | `XAI_API_KEY` | no | `grok-4` |
| 12 | `cerebras` | `CEREBRAS_API_KEY` | no | `llama-3.3-70b` |
| 13 | `custom` | `CUSTOM_BASE_URL` *(`CUSTOM_API_KEY` authorises, and does not select)* | yes | — *you name it* |
| 14 | `llamacpp` | `LLAMACPP_BASE_URL` | yes | `local` |
| 15 | `ollama` | `OLLAMA_BASE_URL` | yes | `qwen3:8b` |
| — | **nothing matched** | → `openrouter`, free tier | yes | *the free pool* |

**Providers that embed come first**, and that is the ordering argument — not a
ranking of answer quality. One key covering both halves is the difference
between a working install and a second decision: rows 8–12 have no embeddings
endpoint, so they send `embed: 'auto'` to [OpenRouter's free
pool](#a-chat-provider-that-cannot-embed), which needs a *second* key and posts
the text of your whole corpus to a third party at build time. That is a
reasonable thing to choose and a poor thing to be defaulted into.

**The self-hosted tail is selected by address.** A local server has no credential
to be found by, so one variable does both jobs — it selects the provider, and its
value is where requests go:

```bash
OLLAMA_BASE_URL=http://localhost:11434     # the usual one
OLLAMA_BASE_URL=http://gpu.internal:11434  # or wherever yours is
LLAMACPP_BASE_URL=http://localhost:8080
```

**With nothing set at all, the chain falls through to OpenRouter's free tier.**
It is the last row and it is not a list entry — it is what happens when the list
matches nothing. The local Ollama used to hold that place, because it closed the
list and needed nothing to be selected by, so every unconfigured build landed
there: right for a laptop running one, a connection refused everywhere else, and
indistinguishable from inside a build that makes no network calls. OpenRouter is
what a fall-through should reach instead — its remaining setup is a single free
key, with no model to choose on either half and no card — so the build prints one
instruction rather than producing a silent outage:

```
[docpilot] the panel is OFF — 2 things to set up:

  · chat and embed: "openrouter" needs a key and none is set
      export OPENROUTER_API_KEY=…
  · no index at docs/public/rag
      npx docpilot index
```

**Nothing here touches the network.** Whether the chosen provider is actually
*reachable* is a different question, and `npx docpilot doctor` is where it is
asked — it prints the whole chain and marks the member that answered:

```
[docpilot] chain     auto → openai
                     ✓ openai      OPENAI_API_KEY         ←
                     · gemini      GEMINI_API_KEY
                     · mistral     MISTRAL_API_KEY
                     …
                     ✓ ollama      OLLAMA_BASE_URL
```

Everything below is how to override it. **A provider you name is never
overridden**, whatever the environment holds — so a stray `OPENAI_API_KEY` set
for something else cannot move a site that said `provider: 'ollama'`.

## Two keys, and which answers first

[`chat.chain`](/reference/config#chat-chain) ships as `'auto'`, so an environment
holding several keys walks **all** of them rather than spending the reader's
question on the first one's bad afternoon. One key still resolves to one member
and one route, unchanged.

The table above is ordered by *what one key covers*, which is the wrong order to
walk a set in: it would send every question to a 50-a-day allowance shared by the
whole site while a funded key sat two rows below. So the selected set sorts into
three tiers first, keeping the table's order inside each — billed accounts, then
a provider's own free catalogue, then a server of your own. `openrouter` answers
after `groq`; `ollama` answers last.

**A model you name keeps its provider billed.** `chat: {model:
'anthropic/claude-sonnet-4'}` beside an `OPENROUTER_API_KEY` is a paid
deployment, so naming a model — or writing your own `chat.models` — flattens the
tiers back to the table's order. The sort fires on the zero-config path, where
the whole question is *which of these keys, in what order*.

Priority is written with the settings that already exist, and there is no new
knob for it:

| what you are ordering | where you say it |
|---|---|
| the providers | the [`chat.chain`](/reference/config#chat-chain) array — a named `chat.provider` leads it and is not asked twice |
| the models on a member that is not the head | that member's object — `{provider, model, models, baseURL}` |
| the models on the head | [`chat.model`](/reference/config#chat-model), then [`chat.models`](/reference/config#chat-models) in order |

```js
export const docPilot = {
  chat: {
    chain: [
      { provider: 'openai', models: ['gpt-4o-mini', 'gpt-4o'] },
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      'openrouter',
    ],
  },
}
```

A model name never crosses providers — `gpt-4o-mini` posted to Groq is a 404 for
a model nobody typed — so give a later member its own. What steps a provider
aside, what the reader is told when one does (nothing), and what happens when
none of them answers is [The answer ladder](/concepts/the-ladder).

## One provider, if it can do both

```js
export const docPilot = {
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
  // embed: 'auto' is the default — it follows chat.provider
}
```

`embed: 'auto'` uses the chat provider's own embedding model. Providers that serve both:

`openai` · `together` · `fireworks` · `mistral` · `nebius` · `gemini` · `openrouter` · `ollama` · `llamacpp` · `custom`

Naming the provider and not the model is a complete sentence on **both** halves:
every row in the table above carries a default for each.

**Those names are defaults, not guarantees** — catalogues change, and a stale one
used to mean `npx docpilot index` dying on its first chunk with a 404 naming a
model nobody typed. Two things now stand behind them:

- **The embed half asks.** When you did not write the model down yourself, the
  index build asks the provider which embedding models it serves and walks those
  answers behind the configured name. That is how `custom` and `llamacpp` — which
  name a *host*, not a service — stop being guesses about what you loaded.
- **`npx docpilot doctor --models` asks about the chat half**, which cannot be
  walked past at build time because it is what answers the reader.

```
  embedders 2 to try — custom offers 1, and BAAI/bge-m3 is configured
  warn  BAAI/bge-m3 is not answering (HTTP 404); trying the next embedder
  embedder  acme/gte-large-v2 · 1024d — chosen from 2 candidate(s)
```

**A name you wrote is never walked past.** `embed: {provider: 'x', model: 'y'}`
is a sentence — used as given, no catalogue read, and a wrong one fails loudly
rather than being quietly replaced. See
[Asking the provider](/reference/config#asking-the-provider).

## OpenRouter, with nothing named

```js
export const docPilot = {
  chat: { provider: 'openrouter' },
}
```

One key, no model names, both halves covered — and every request on the **free tier**.

Naming no model is not laziness here; it is the shape the service actually has. A free id is a shared pool, so its `429` reports how many other people are asking rather than anything about the model. Pinning one buys a panel that works until somebody else's traffic arrives. So DocPilot keeps an ordered pool instead:

- **Chat** rotates at runtime. The pool is headed by `openrouter/free`, OpenRouter's own router over the free tier, with explicit free ids behind it. A model that is rate limited, retired, moderated, 5xx-ing, or that answers with nothing at all loses its turn to the next one. The one that answers is tried first next time. See [`chat.models`](/reference/config#chat-models).
- **Embeddings** rotate at **build time only**. `npx docpilot index` walks the free embedders, takes the first that answers, and records it in the manifest; the browser is bound to that name for the life of the index. Two embedding models are two vector spaces, and a query embedded by the wrong one scores noise that every guardrail downstream reads as a real number. A busy embedder at query time is retried, then retrieval drops to lexical-only rather than to a foreign space.

  Lexical-only is a **quieter** failure than it sounds. The console carries the reason and a refusal says the search was degraded, but an answer that still passes the gate says nothing — and on a question asked in a language your corpus is not written in there is no lexical overlap to score at all. Treat a run of them as an outage, not as a bad corpus.

  The same two words also name a configuration — [`embed: false`](#no-embedder-at-all) — and a site that declared it looks nothing like a site that lost its embedder: it logs nothing and calls no refusal degraded, because nothing failed. If you are reading this while debugging, the config file settles which one you have.

Both free embedders are 2048-dimensional, so the vector blob alone is **2 KB per chunk** — and the builder's ceiling is on the whole directory, chunk text and document frequencies included, which on a typical corpus is another kilobyte or so per chunk. Past roughly 900 chunks the size warning fires at 3 MB; past roughly 1500 the build refuses at 5 MB. `npx docpilot index` prints the running total either way, so measure rather than estimate.

`model: 'auto'` and `model: 'free'` are accepted spellings of "you choose", if you would rather say it out loud than leave the key out.

To pin your own, name them:

```js
chat: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6' },
embed: { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b' },
```

## A chat provider that cannot embed

These answer but do not retrieve — they have no embeddings endpoint at all:

`anthropic` · `deepseek` · `groq` · `xai` · `cerebras`

With `embed: 'auto'` — the default — DocPilot **borrows OpenRouter's free embedding pool** for the retrieval half. The same pool described above, resolved the same way: no model is named, `npx docpilot index` walks it, takes the first that answers, and writes the winner into the manifest.

```js
export const docPilot = {
  chat: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  // embed: 'auto' — borrowed from OpenRouter's free pool
}
```

```bash
ANTHROPIC_API_KEY=…      # the questions
OPENROUTER_API_KEY=…     # the index, free tier
```

**Is the borrow still necessary?** That list of five is a claim this package wrote
down, and claims age — the same table once said OpenRouter served no embeddings
endpoint for months after it started. `npx docpilot doctor --models` asks your
chat provider directly and says so when the answer has changed:

```
[docpilot] embed?    groq answers /v1/embeddings after all — nomic-embed-text-v1.5
                     embed: {provider: 'groq'} drops the borrowed openrouter key
```

It reports rather than switches. The reverse proxy carrying `/ai/v1/embeddings`
is written from your config at build time, so a build that moved itself would
send every reader's query vector to the wrong upstream — you write the line.

Two things follow from the borrow, and both are printed rather than assumed:

- **The whole corpus is posted to OpenRouter at build time.** Questions still go to the chat provider; the *text of your docs* goes to a service that appears nowhere in your config file. `npx docpilot doctor` says so, the startup block says so, and if that is not allowed where you work, name an embedder instead.
- **`OPENROUTER_API_KEY` is now required**, and its absence is reported as a missing key rather than as a provider error. The choice does not depend on the environment: a CI box without the key resolves the same configuration as the laptop that built the index, so the two never disagree about which vector space the index is in.

To keep embeddings elsewhere, say so — an explicit `embed` is never rewritten:

```js
export const docPilot = {
  chat:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}
```

A project-scoped key limited to chat models hits the same wall with a provider that *does* embed. The split is the fix in both cases — naming a provider that cannot embed still stops the build.

## Fully local, no key

```js
export const docPilot = {
  chat: { provider: 'ollama', model: 'qwen3:8b' },
}
```

```bash
ollama pull bge-m3
ollama pull qwen3:8b
```

```bash
OLLAMA_BASE_URL=http://localhost:11434
```

This is the setup to develop against. The variable and the config entry say two
different things and either is enough on its own: `OLLAMA_BASE_URL` puts Ollama
in the chain and says where it is, while `chat: { provider: 'ollama' }` pins it
whatever the environment holds. Set both and the variable still moves the
address — your own `chat.baseURL` outranks both.

### A local server is never assumed

**Installing this package and running Ollama is not enough.** A local server is
selected by its ADDRESS and by nothing else, and an environment that names
nothing at all falls through to [OpenRouter's free
tier](/guide/free-tier) rather than to `localhost:11434`.

That is deliberate, and the reason is that a build cannot tell the difference: a
laptop with Ollama running and a CI box that has never heard of it are the same
environment from inside this process. The package used to guess, and the guess
was a connection refused everywhere but one machine.

Three ways to say it, in order of how much they commit to:

```bash
OLLAMA_BASE_URL=http://localhost:11434    # selects it, and says where it is
```

```js
chat: { preferLocal: true }   // local answers FIRST, and an empty environment lands there
chat: { provider: 'ollama' }  // pinned; the chain is not consulted at all
```

[`chat.preferLocal`](/reference/config#chat-preferlocal) is the one to reach for
on a machine that has cloud keys lying around for something else: it moves the
local server to the front of the ladder without taking the others out of it, and
`npx docpilot doctor` says so when it moved nothing.

### llama.cpp

`llama-server` speaks the OpenAI-compatible API and serves whatever weights it
was started with, so DocPilot has nothing to name:

```bash
llama-server -m ./model.gguf --port 8080 --embeddings
```

```bash
LLAMACPP_BASE_URL=http://localhost:8080
```

That variable is all of it: it both selects llama.cpp and says where it is. The
model id sent with each request is the literal `local`, which llama-server
ignores; the `--embeddings` flag is what makes the same server cover the
retrieval half. Point the variable at another host and requests follow it, and
`chat: { provider: 'llamacpp', baseURL: 'http://gpu.internal:8080' }` says the
same thing in the config file, where it outranks the variable.

`llama-server --api-key` is honoured if you started it with one: set
`LLAMACPP_API_KEY` and the proxy attaches it. Most people run it without.

## No embedder at all

```js
export const docPilot = {
  chat:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  embed: false,
}
```

A supported configuration, not a fallback. `npx docpilot index` writes an index with no vectors in it, the browser downloads none and embeds no query, and every question is retrieved by keyword. `'none'` is the same value spelled out. See [`embed`](/reference/config#embed-false).

**It costs most of the recall, and the cost was measured** — on a 1191-chunk corpus, recall@8 fell from 0.97 to 0.41, retrieval F1 from 0.35 to 0.18, and 11 of 44 answerable questions were refused outright. Those are one corpus's numbers; `npx docpilot eval --gate-only --lexical` reports yours, against the index you already have and the golden set you wrote for it. Take that measurement before you build one without vectors, not after.

Keyword matching also scores **zero** for any question asked in a language your corpus is not written in — there is no lexical overlap to score. For a multilingual audience this is not a trade-off, it is a mode that answers one language and refuses the rest.

Against that: one key instead of two, a build that makes no embedding calls, no corpus posted to an embedding service, and the vector blob off every reader's download — 2 KB per chunk on the 2048-dimensional free embedders above. A corpus of exact strings — error codes, CLI flags, field names — is what BM25 handles best; prose asked about in the reader's own words is what it handles worst. Which of those describes your docs is the decision, and it is worth measuring rather than guessing.

### Declared is not degraded

Retrieval reports itself as `lexical-only` in both cases, and they are not the same thing.

| | declared — `embed: false` | degraded — the embedder failed |
|---|---|---|
| the index | has no vectors; none were ever built | has vectors, unread this turn |
| the console | silent | carries the reason |
| a refusal | ordinary | says the search was degraded |
| what to do | nothing, or measure and reconsider | fix the embedder |

The console being silent is the point of the distinction: on a declared site there is no failure to report, and a warning printed on every question would train the reader to ignore the one that matters. `npx docpilot doctor` states the mode outright, which is the fastest way to settle it on a deployment you did not configure yourself.

## What each provider honours

One vocabulary goes in; each service gets the spelling it accepts. This table is the map, and it is the same record `npx docpilot doctor` prints and the adapters translate from — there is one copy of it, so the page and the behaviour cannot drift apart.

Cells name the **field that actually goes on the wire**. `—` means the service has nowhere to put it, and naming that knob beside that provider stops the build rather than being dropped in silence.

| provider | reasoning | levels it accepts | budget | verbosity | temperature | topP | seed | token ceiling |
|---|---|---|---|---|---|---|---|---|
| `openai` | `reasoning_effort` | all six † | — | `verbosity` | ✓ | `top_p` | `seed` | `max_completion_tokens` on o-series and GPT-5, `max_tokens` elsewhere |
| `openrouter` | `reasoning: {…}` | all six † | `max_tokens` | `verbosity` | ✓ | `top_p` | `seed` | `max_tokens` |
| `anthropic` | `thinking` | low → max | `budget_tokens` ‡ | — | — | — | — | `max_tokens` |
| `ollama` | `think` | low, medium, high, max | — | — | `options.temperature` | `options.top_p` | `options.seed` | `options.num_predict` |
| `llamacpp` | `reasoning_effort` | all six | `reasoning_budget` | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `groq` | `reasoning_effort` | low, medium, high † | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `xai` | `reasoning_effort` | low, medium, high, xhigh | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `deepseek` | `reasoning_effort` | low, high, max | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `gemini` | `reasoning_effort` | minimal → high | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `together` | `reasoning_effort` | low, medium, high | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `fireworks` | `reasoning_effort` | low → max | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `mistral` | `reasoning_effort` | minimal → xhigh † | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `nebius` | `reasoning_effort` | all six † | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `cerebras` | `reasoning_effort` | low, medium, high † | — | — | ✓ | `top_p` | `seed` | `max_tokens` |
| `custom` | `reasoning_effort` | all six | — | — | ✓ | `top_p` | `seed` | `max_tokens` |

† **Support varies by model on these services**, so nothing static can be asserted about it and nothing here refuses your configuration — the knob is sent and `doctor` prints the caveat. `minimal` on OpenAI is GPT-5-only and gone again at 5.1; Groq's Qwen models take `none` and `default` where its GPT-OSS models take the three levels; Cerebras treats all three as equivalent on some models. `custom` is a **host** rather than a service, so this package cannot know what your gateway accepts and says so instead of guessing.

‡ Anthropic's budget belongs to the older thinking shape. Models after Opus 4.6 reject it and take adaptive thinking steered by an effort instead; models at 4.5 and earlier reject adaptive. The adapter picks the shape from the model name, and an effort you write is converted to a budget where the older shape is the one in play.

Two knobs are refused everywhere for reasons of their own: `chat.stop`, because a stop sequence inside a pinned JSON reply truncates the object, and `top_k`, which only one transport has. Both are one line of `chat.extraBody` if you want them anyway.

### Thinking, turned up

```js
export const docPilot = {
  chat: { provider: 'openai', model: 'gpt-5-mini', reasoning: 'high' },
}
```

Costs more and answers better on questions with several moving parts. Note the model: on GPT-5 and the o-series this package posts `max_completion_tokens`, because those models reject the field every other model wants — a request naming `max_tokens` there fails with a 400, which the panel renders as "I couldn't find this in the docs".

### Thinking, turned off

```js
export const docPilot = {
  chat: { provider: 'ollama', model: 'qwen3:8b', reasoning: false },
}
```

The fastest configuration a thinking model has. It is worth knowing what you are turning off: DocPilot already declines reasoning on every search step, because a step choosing a tool is not composing anything and leaving it on across four of them was measured at a p50 of 215 seconds. This turns off the remaining one — the answer.

On xAI, reasoning cannot be switched off at all. Writing `false` there is not an error; it is a request the service will not honour, and `doctor` says so.

### A thinking budget

```js
export const docPilot = {
  chat: { provider: 'anthropic', model: 'claude-opus-4-5', reasoning: { budgetTokens: 8192 } },
}
```

For the services that measure thinking in tokens rather than in levels — Anthropic's older shape, OpenRouter, and llama.cpp. Naming it on a service that has only levels stops the build and tells you to name an effort instead.

The budget has to stay under `chat.maxTokens`, which is the ceiling for the whole reply; where it cannot, no thinking is requested rather than a request being sent that would be rejected.

### A local model that thinks

```js
export const docPilot = {
  chat: { provider: 'ollama', model: 'qwen3:8b', reasoning: 'high' },
}
```

Ollama is the one service that will tell you whether a model can think at all — `/api/show` publishes a capability list, and sending `think` to a model without it is an error rather than a no-op. So capability beats preference here in a way it cannot elsewhere: a model that cannot think is not asked, however deeply you wanted it to.

`npx docpilot doctor --models` prints what your server has pulled, what the configured model can do, and the `ollama pull` command if it is a model you have not downloaded.

### Reasoning on a rotating pool

```js
export const docPilot = {
  chat: { provider: 'openrouter', reasoning: 'medium' },
}
```

OpenRouter is the one provider whose model moves between requests, so its own per-model support cannot be known when the site is built — the knob is sent and the pool sorts it out.

One caveat worth the paragraph. This package sends `provider: { require_parameters: true }` to OpenRouter by default, which is what makes it route only to upstreams that honour the strict answer schema. Reasoning counts as one of those parameters, so asking for it narrows the routing a second time — and on a thin free pool that can turn an answerable question into *no provider available*. `doctor` prints the caveat when both are in play; `chat.extraBody: null` is how you decline the flag if you would rather have the breadth.

Note that `chat: {reasoning: false}` asks for a parameter rather than declining one — see [`chat.reasoning`](/reference/config#chat-reasoning). Leaving the key unset is what sends no reasoning field at all, and it is the difference between a request that routes and one that does not.

### When the refusal is the account's, not the request's

OpenRouter applies your account's own guardrails after every other routing step, and a request that survives them all and finds nothing left answers `404` like any other:

```
0 endpoints out of 1 requested are available matching your guardrail
restrictions and data policy. We removed them for the following reasons …
ZDR violation (account settings): 1 endpoint excluded
```

Two settings at [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy) produce it — requiring zero data retention, and narrowing the allowed provider list — and both are account-wide. A per-request preference cannot relax either: the request-level `zdr` flag is ORed with the account's, so it can only ever tighten.

**It applies to embeddings as well as to chat**, which is the part that surprises. A site whose readers see *the AI service didn't respond* on every question may also be unable to run `npx docpilot index`, and the two look like unrelated outages. Nothing in a config file fixes either. `npx docpilot doctor --models` posts the real request bodies and names the failing step, which is how you tell this apart from a retired model or a parameter your configuration is adding.

### A knob DocPilot does not name

```js
export const docPilot = {
  chat: {
    provider: 'ollama',
    extraBody: { options: { top_k: 40, repeat_penalty: 1.1 } },
  },
}
```

`chat.extraBody` is merged into the body of every chat request and reaches all four adapters. Nothing it contains can overwrite a field the adapter owns — a stray `stream: false` would otherwise turn off streaming for every reader on the site — and on Ollama its `options` merge with the adapter's rather than replacing them, so `num_ctx` and `temperature` survive.

## Where the key lives

In Node, never in the page. `themeConfig` is compiled into the client bundle, so a key written there is a key published.

- **Development**: the Vite plugin installs a proxy that attaches the key.
- **Production**: your reverse proxy does the same. The built site expects a same-origin `/ai` path in front of it.

`vitepress preview` has no proxy, so the panel cannot answer there. That is not a bug to work around by moving the key.
