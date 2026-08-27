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
| 10 | `deepseek` | `DEEPSEEK_API_KEY` | no | `deepseek-chat` |
| 11 | `xai` | `XAI_API_KEY` | no | `grok-4` |
| 12 | `cerebras` | `CEREBRAS_API_KEY` | no | `llama-3.3-70b` |
| 13 | `custom` | `CUSTOM_API_KEY` *(`CUSTOM_BASE_URL` moves it)* | yes | — *you name it* |
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
                     ✓ ollama      no key needed
```

Everything below is how to override it. **A provider you name is never
overridden**, whatever the environment holds — so a stray `OPENAI_API_KEY` set
for something else cannot move a site that said `provider: 'ollama'`.

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

### llama.cpp

`llama-server` speaks the OpenAI-compatible API and serves whatever weights it
was started with, so DocPilot has nothing to name:

```bash
llama-server -m ./model.gguf --port 8080 --embeddings
```

```bash
LLAMACPP_BASE_URL=http://localhost:8080
```

That variable is all of it — no config file entry, no key. The model id sent
with each request is the literal `local`, which llama-server ignores; the
`--embeddings` flag is what makes the same server cover the retrieval half.
Point the variable at another host and requests follow it.

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

## Where the key lives

In Node, never in the page. `themeConfig` is compiled into the client bundle, so a key written there is a key published.

- **Development**: the Vite plugin installs a proxy that attaches the key.
- **Production**: your reverse proxy does the same. The built site expects a same-origin `/ai` path in front of it.

`vitepress preview` has no proxy, so the panel cannot answer there. That is not a bug to work around by moving the key.
