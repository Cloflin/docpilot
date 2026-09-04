<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
  <img alt="DocPilot" src="docs/public/logo-light.svg" width="320">
</picture>

A grounded **AI assistant** for **any page of any site** — VitePress, Docusaurus, Vue, React, or a landing page with a `<script>` tag.

It is a chat, not a search box with better typography: scope a question to one section, ask about a passage you selected, follow up, edit what you asked, keep the thread. It mounts wherever a page can load a stylesheet and a script: a docs site, a landing page, a pricing page, a help centre, an app you already ship. What it answers **from** is the corpus you built — `npx docpilot index` walks your markdown and OpenAPI files, and `npx docpilot import <url>` pulls in an allowlisted page that lives in neither. A panel on your pricing page answers from that corpus, not from the pricing page.

Retrieval runs **in the reader's browser** against a static index built at deploy time — no vector database, no search service, no server beyond the one already serving your site. It is **hybrid**: a BM25 pass over the chunk text and a cosine pass over the vectors, merged by Reciprocal Rank Fusion. The vectors are quantised at build time to **signed int8, one byte per dimension** — 855 KB for this project's own 570-chunk index, where float32 would be 3.3 MB — and the build measures the round-trip error and refuses to ship above `0.01` mean |Δcos|. A relevance floor on retrieval is scored on every turn and, opt-in (`guard.mode: 'calibrated'`), refuses **before the model is called** so an off-topic question costs zero tokens — off by default, because that threshold has to be calibrated per corpus **and per language**, and a reader's language is not something a threshold can see; the model's own citation contract is what handles it otherwise. Every citation the reader sees is checked against what the host actually retrieved during that turn.

## Install

| | install | then |
|---|---|---|
| npm | `npm i @cloflin/docpilot` | `npx docpilot init` |
| Yarn | `yarn add @cloflin/docpilot` | `yarn docpilot init` |
| pnpm | `pnpm add @cloflin/docpilot` | `pnpm exec docpilot init` |
| Bun | `bun add @cloflin/docpilot` | `bunx docpilot init` |
| Deno | `deno add npm:@cloflin/docpilot` | `deno run -A npm:@cloflin/docpilot init` |

`pnpm exec docpilot` is the form written here. A bare `pnpm docpilot` also works — pnpm falls back to `pnpm exec` for a name that is not a script — but `pnpm run docpilot` does not, and reports the bin as missing. Nothing here runs `dlx` or `npx` against the bare name — the unscoped `docpilot` is not this package, and nothing is published under that name today.

Node 20 or newer. Every command below is written `npx docpilot …`; substitute the runner from your own row — it is the same bin either way.

## Where it mounts

Any page that can load a stylesheet and a script — a docs site, a landing page, a help centre, an app you already ship. Which *build* of the panel you load is the only real question, and it is not which framework you use: it is whether your bundler compiles a `.vue` file, because that decides whether you get the source or a prebuilt bundle.

| your setup | entry point |
|---|---|
| VitePress | `@cloflin/docpilot/theme` |
| Docusaurus | `@cloflin/docpilot/docusaurus` |
| Vue | `@cloflin/docpilot/vue` |
| React | `@cloflin/docpilot/react` |
| any bundler | `@cloflin/docpilot/mount` or `/web` |
| a `<script>` tag | `dist/docpilot.web.js` |

Every entry point ships TypeScript declarations. The full matrix is in the docs — see [Documentation](#documentation) — and what follows is VitePress.

## Add it

Two files and one environment variable. There are no settings to write.

```js
// docs/.vitepress/config.mjs
import { defineConfig, loadEnv } from 'vitepress'
import { defineDocPilot } from '@cloflin/docpilot'

const ai = defineDocPilot({}, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { docPilot: ai.themeConfig },
})
```

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme'

export default withDocPilot(DefaultTheme)
```

```bash
echo 'OPENAI_API_KEY=sk-…' >> .env.local   # or any one of fifteen — see below
npx docpilot index                          # build the retrieval index from your docs
npx docpilot calibrate                      # measure the refusal thresholds against your corpus
```

**One key is the whole configuration.** `chat.provider` ships as `'auto'`, which walks an ordered list of services and stops at the first one your environment holds a key for. That service's default model comes with it, and so does its embedder — so a single key covers both the answering and the retrieval half:

| | | | |
|---|---|---|---|
| **embeds too** | `openai` · `gemini` · `mistral` | `together` · `fireworks` · `nebius` | `openrouter` |
| **answers only** | `anthropic` · `groq` | `deepseek` · `xai` | `cerebras` |
| **self-hosted** *(by address)* | `custom` | `llamacpp` | `ollama` |

Providers that embed come first, and that is the ordering argument rather than a ranking of answer quality: the alternative needs a *second* key and posts the text of your whole corpus to a third party at build time. The self-hosted three have no credential to be found by, so `OLLAMA_BASE_URL` and `LLAMACPP_BASE_URL` select them and say where they are.

**With nothing set at all, the chain falls through to OpenRouter's free tier** — one free key, no model to choose on either half, no card. `npx docpilot doctor` prints the list and marks the member that answered.

To pin a provider, pass settings — and then export them **by name**:

```js
export const docPilot = {
  product: 'Acme Editor',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
}

const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))
```

The `docPilot` **named export** is the contract between the build and the CLI: both read the same object, so there is no second place to state which model embeds or where the docs live. A provider you name is never overridden by the environment, and naming a provider without a model is a complete sentence — every one carries its own default.

`product` is optional. It is what the assistant says it answers questions about — in the instruction, in the composer placeholder, and when a reader says hello. Left out, all three read "this documentation".

**`vitepress dev` proxies `/ai/*` for you; a built site does not.** `npx docpilot doctor --proxy` prints the contract for the configuration you actually have: one route per hosted half — its exact path, its upstream, and the *name* of the variable holding the key, never the key — followed by the five rules those routes have to satisfy. The paths are asked of the adapter the browser will use rather than written out, so an Anthropic chat provider prints `/ai/v1/messages`; a setup that calls a local Ollama for both halves prints `none needed`.

## Nothing configured yet?

The site still builds. The panel switches itself off and the build prints one block:

```
[docpilot] the panel is OFF — 2 things to set up:

  · chat and embed: "openrouter" needs a key and none is set
      export OPENROUTER_API_KEY=…
  · no index at docs/public/rag
      npx docpilot index
  · chat.provider is 'auto' and no provider key was found in the environment,
    so both halves fell through to openrouter — its free tier needs no model
    named on either side and no card, so one free key finishes the install.

  The site builds and every other feature is untouched.
  Run `npx docpilot doctor` to re-check without a full build.
```

A dependency that can fail someone else's docs build the moment it lands is a dependency they remove. `npx docpilot doctor` is the opt-in place to turn the same facts into a non-zero exit for CI.

## What it guarantees

Four things are true of every answer, for every model, under every prompt — including a prompt you have edited. They are enforced by host code that no message can reach, and each is covered by a test.

- **Every source link points at a page that exists in the index.** Enforced in the markdown-it token stream, on a normalised path compared by set membership, before anything renders. An invented route is de-linked and left as plain text.
- **When retrieval finds nothing above the threshold, no answer is generated, because the model is never called.** There is no text to be wrong.
- **The assistant is shown only chunks from the active scope** — through priming, search, fetch, listing and section expansion alike. The tools carry no argument in which a wider scope could be expressed.
- **Every citation shown corresponds to a chunk the host itself put in front of the model during that turn**, checked against a set the host maintains — never by searching the text of what the model was sent.

### What it is not

It is a control against a weak, badly-behaved or injected **model**. It is **not a security boundary** and cannot be one: everything runs in the reader's browser, the corpus is a public website, and the model is one the reader could talk to directly. Scope is focus, not containment.

Three claims this README will not make. *"It only answers from the documentation"* — it answers **with** documentation in context, and generated text can contain anything the model knows. *"Answers are grounded in their cited sources"* — citation is provenance, not entailment. *"It cannot be taken off-topic"* — the gate is a relevance floor, not an entailment check, and a question overlapping a documented subject reaches the model by design.

## What the chat does

Six doors open it — a floating button in the corner (the default), the navbar
button beside your search, a row in the mobile menu, <kbd>⌘I</kbd> (bound even
with no visible button), a call-to-action under each article, and `open()` on
the handle from `mountDocPilot`. One setting, `ui.trigger`, picks which of them
exist.

Inside it:

| | |
|---|---|
| **Scope** | a picker in the composer narrows the search to this page, this section, or a hand-picked list — with a filter above the list once there are more than a dozen pages |
| **Quote** | select a passage and one button attaches it to the composer as a removable chip. On by default inside an answer, off over your own prose (`quote.fromDocs`) |
| **Status** | six named states rather than a spinner — loading the index, searching, looking at the page list, reading a page, thinking, writing — and reasoning collapses behind "Thought for 4s" |
| **Citations** | a **Sources** list, an optional disclosure opening the exact passage a marker was drawn from, and the sources appended to a copied answer |
| **Refusals** | the closest pages, what was searched, how many pages were read, and one button to clear the scope and search everything |
| **The thread** | edit a question and everything below it is discarded and answered again; ask again re-runs an answer that arrived; copy one turn, or the whole conversation as Markdown |
| **Feedback** | two thumbs, four reasons, and a 500-character comment redacted before it leaves the browser — posted to an endpoint **you** own, or nowhere at all |
| **The prompt** | `prompt.show` puts the assistant's own instruction, its tool definitions and the active scope in front of the reader, and `prompt.allowAppend` lets them add one of their own — sent with the question, never merged into the system prompt |

Every one of them is a setting with a default and a reason, and all of them are
in the docs under **The assistant panel**.

## How it compares

Algolia's Ask AI, kapa.ai, Inkeep, Mintlify's assistant and Orama are all real
answers to this problem. **One architectural decision separates them from this
one:** DocPilot does retrieval in the reader's browser against a static file you
built, and every one of them does it on a server.

### What each of them asks for it

Quoted from the vendor's own pricing page, checked August 2026. `not published`
means there is nothing on the page to quote — not that it is free.

| | published price |
|---|---|
| **DocPilot** | **$0** — MIT, no vendor, no plan, no per-answer fee |
| Algolia Ask AI | $0.50 per additional 1K search requests on Grow ($1.75 on Grow Plus), plus your own LLM key; Ask AI is not line-itemed on the pricing page |
| kapa.ai | not published — 14-day trial, then "Talk to us" |
| Inkeep | free, self-hosted; enterprise not published |
| Mintlify AI | ≈$0.23 an answer past the allowance — 23 credits at $0.01 over the 10,000 included; Starter has no AI |
| Orama | free, self-hosted (Apache 2.0); cloud price not published |

**`$0` is the software, not the answers.** DocPilot bills nothing and has no
hosted half to bill from — no account, no service, no telemetry. You bring a
model provider key and pay them directly, or run the whole thing on OpenRouter's
free tier: one key, no card, and a ceiling of **50 requests a day** that also
covers rebuilding the index. See
[Living on the free tier](docs/guide/free-tier.md).

### And how it is built

| | DocPilot | hosted answer services |
|---|---|---|
| Where retrieval runs | the reader's browser | the vendor's cloud |
| Where the index lives | a static file on the host already serving your site | the vendor's platform |
| Index the reader downloads | int8 vectors, one byte per dimension — 855 KB for this site's 570 chunks | n/a — the index is theirs |
| An off-topic question costs | zero model calls, zero tokens | not documented by any of them |
| Citations checked against what was retrieved | yes, by host code no message can reach | not documented by any of them |
| Refusal threshold measured on **your** corpus | `npx docpilot calibrate` | not documented by any of them |
| Self-hostable | there is nothing to host | Inkeep and Orama yes; the rest no |

**Not documented is not the same as no.** Where a vendor publishes nothing about
a mechanism, both this table and the docs say so rather than guessing, and every
non-DocPilot cell is sourced and dated on the comparison page.

The reasons to buy one of the others are on that page too, under *What DocPilot
is worse at* — chiefly: it indexes what you can put in a directory, the reader
downloads the index, nobody is tuning it for you, there is no analytics
dashboard, and there is no support contract.

## Commands

| | |
|---|---|
| `npx docpilot index` | build the retrieval index from your markdown and OpenAPI files |
| `npx docpilot import <url>` | turn an allowlisted external page into a page of the corpus |
| `npx docpilot calibrate` | measure the refusal thresholds against your own corpus |
| `npx docpilot lint` | check the golden set against the index it measures |
| `npx docpilot eval` | run your golden set and write a report |
| `npx docpilot bench` | A/B two retrieval configurations on answer quality, with no API key |
| `npx docpilot tune` | sweep the retrieval levers (lambda, k) against the golden set into `docpilot/tuning.json`, with a report of the grid beside it |
| `npx docpilot feedback` | turn readers' votes into candidates for the eval sets |
| `npx docpilot doctor` | check the configuration without a full build; exits non-zero when not ready |
| `npx docpilot init` | scaffold the environment, the eval sets and the authoring skills; asks which agent tool gets them |
| `npx docpilot update` | refresh those copied skills and the `/docpilot-*` slash commands after an upgrade |

`eval`, `bench` and `tune` each take a `--level=low|medium|high|xhigh|max|ultra`, and the six tiers are cumulative: `--level=medium` runs low + medium, no `--level` runs everything. Two reports are comparable only within one tier.

The loop is `index → calibrate → lint → eval → bench`, with `tune` where it is retrieval that has to move — **and then `index` again, because that is the step that inlines `tuning.json` into the manifest a reader downloads.** Until it runs, a swept lever is a file on disk and nothing more. The first two make the panel work; the last three tell you whether it works well, and they are the half that gets skipped.

`feedback` sits outside the loop: it reads what your own endpoint collected and *proposes* probes for it. It never writes to the eval sets — a stratum is a judgement and a gold answer is written by a person.

**Calibrate before you ship.** Thresholds are a statement about one corpus and do not transfer between projects. Until `calibrate` has run, the gate uses provisional values and every record says so.

## Providers

One provider is usually enough. `embed: 'auto'` follows `chat.provider` and uses that service's own embedding model.

Chat **and** embeddings: `openai`, `together`, `fireworks`, `mistral`, `nebius`, `gemini`, `openrouter`, `ollama`, `custom`.

Chat only — no embeddings endpoint: `anthropic`, `deepseek`, `groq`, `xai`, `cerebras`.

Choosing one of them with `embed: 'auto'` borrows **OpenRouter's free embedding pool** for the retrieval half: set `OPENROUTER_API_KEY`, and `npx docpilot index` picks whichever free embedder answers. The borrow is printed rather than assumed — the text of every chunk is posted to OpenRouter at build time, so name `embed` explicitly if your corpus may not leave for a third party.

`chat: { provider: 'openrouter' }` with no model named runs both halves on the **free tier**: chat rotates through a pool of free models per call, and `npx docpilot index` picks whichever free embedder answers and records it in the manifest. That tier meters **requests, not tokens** — 50 a day under 10 credits bought — and one turn is an embedding request plus two or three model calls, so fifty is a dozen-odd questions rather than fifty. What the panel does about that, and what you have to decide, is [Living on the free tier](docs/guide/free-tier.md).

`embed: false` runs no embedder at all: the index carries no vectors and every question is retrieved by keyword. It is supported, and it costs most of the recall — measured on a 1191-chunk corpus, recall@8 fell from 0.97 to 0.41, retrieval F1 from 0.35 to 0.18, and 11 of 44 answerable questions were refused outright. Keyword matching also scores zero for a question asked in a language your corpus is not written in. Measure your own corpus with `npx docpilot eval --gate-only --lexical` before choosing it — it reads the golden set you wrote, so that comes first.

`chat: false` runs no model at all — **search-only**. A question is scored against the index exactly as before and answered with the ranked passages themselves: each one an excerpt under a link to the heading it was cut from. The scope picker, the credential check and the calibrated gate all still run; what changes is that nothing is generated, so nothing can be wrong and no request is made. Paired with `embed: false` it is a deployment that holds no provider key and makes no outbound request of any kind after the page loads.

See [Choosing providers](docs/guide/providers.md).

## Credentials

The panel refuses a question containing a credential shape — API keys, JWTs, bearer tokens, AWS key ids, hex digests — **before the embedding call**, so the value never leaves the browser. It is replaced with a placeholder, the warning is written in the reader's language, and one button answers the original question without it.

This is a habit guard, not a security boundary. It cannot stop a reader who pastes a key into a model directly.

## Greetings

"Hello" carries no documented subject, so the gate scores it at zero and refuses it — a correct verdict that tells the reader, on their very first message, that the assistant is broken. Greetings, thank-yous, farewells and "who are you" are recognised before the gate and answered from a template in eighteen languages, with no model call. A greeting attached to a real question is not claimed.

## Conversation history

Conversations are kept in the reader's own `localStorage` and listed in the panel, so a reload — or a citation followed into a new tab — no longer throws a thread away. The archive is shared by every tab; which conversation a tab is showing is not, so two tabs are two conversations.

Reasoning, retrieved excerpts and the reader's own instruction are never written. Nothing is sent anywhere. The reader can delete one conversation or all of them, and `history: { enabled: false }` stops recording *and* clears what is stored.

## Imported pages

`npx docpilot import <url>` turns an allowlisted external page into a page of the corpus. If the site already publishes `page.md` beside `page` — declared as an alternate, or derived from its canonical URL — **that** file is the import, because it is what the page was built from. Otherwise the markup is converted to markdown **in code**, never summarised by a model. Either way, one final model pass may add `<llm-only>` / `<llm-exclude>` and nothing else, verified by comparing its output to its input character for character.

Point `importDir` at a directory outside your docs and the assistant will answer from pages that have no route on your site — a product page, a policy — and cite the original. Every `source:` is checked against `sources.allow`, https-only, at build time: that value becomes an `href` in the answer panel, so markdown is never trusted with a URL scheme.

## Translating it

Every reader-facing string — 173 of them, in 25 groups — is replaceable one at a time, in the same shape as VitePress's own local-search i18n:

```js
i18n: {
  locales: { ru: { translations: { empty: { heading: 'Чем помочь?' } } } },
}
```

Panel chrome follows the page's locale; the credential and greeting replies follow the language the reader typed. A key that does not exist is dropped and named on stdout.

## Skills

`npx docpilot init` asks which agent tool you use — Claude Code, Codex, Cursor, Copilot — and copies two skills into it: `docs-rag`, the measurement and tuning loop with a list of experiments already run and what they cost, and `docs-import`, the contract for imported pages. It also generates a `/docpilot-<command>` slash command for every command of this CLI. A skill inside `node_modules` reaches nobody, so copying is the only delivery there is.

`npx docpilot update` refreshes both after you upgrade the package. A file you edited is replaced and your version kept beside it as `.bak`.

## Documentation

Full documentation — [the assistant panel, feature by feature](docs/guide/panel.md), [how it compares to the hosted services](docs/guide/comparison.md), the install matrix for every host, the configuration reference, the [pluggable highlighter API](docs/reference/highlighting.md) (Shiki, Prism or highlight.js, none of them installed by default), the retrieval contract, translation, imported pages, and deploying it (nginx, containers, cache rules for the index): run `npm run docs:dev` in this repository.

## License

MIT
