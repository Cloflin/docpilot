<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
  <img alt="DocPilot" src="docs/public/logo-light.svg" width="320">
</picture>

A grounded AI answer panel for VitePress documentation.

Retrieval runs **in the reader's browser** against a static index built at deploy time — no vector database, no search service, no server beyond the one already serving your site. A calibrated gate refuses **before the model is called**, so an off-topic question costs zero tokens and produces zero generated text. Every citation the reader sees is checked against what the host actually retrieved during that turn.

```bash
npm i @cloflin/docpilot
npx docpilot init
```

## Add it

```js
// docs/.vitepress/config.mjs
import { defineConfig, loadEnv } from 'vitepress'
import { defineDocPilot } from '@cloflin/docpilot'

export const docPilot = {
  product: 'Acme Editor',
  chat:  { provider: 'openai', model: 'gpt-4o-mini' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}

const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))

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
npx docpilot index        # build the retrieval index from your docs
npx docpilot calibrate    # measure the refusal thresholds against your corpus
```

The `docPilot` **named export** is the contract between the build and the CLI: both read the same object, so there is no second place to state which model embeds or where the docs live.

`product` is optional. It is what the assistant says it answers questions about — in the instruction, in the composer placeholder, and when a reader says hello. Left out, all three read "this documentation".

**`vitepress dev` proxies `/ai/*` for you; a built site does not.** `npx docpilot doctor --proxy` prints the two rules a production reverse proxy needs.

## Nothing configured yet?

The site still builds. The panel switches itself off and the build prints one block:

```
[docpilot] the panel is OFF — 2 things to set up:

  · chat: "openai" needs a key and none is set
      export OPENAI_API_KEY=…
  · no index at docs/public/rag
      npx docpilot index

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

## Commands

| | |
|---|---|
| `npx docpilot index` | build the retrieval index from your markdown and OpenAPI files |
| `npx docpilot import <url>` | turn an allowlisted external page into a page of the corpus |
| `npx docpilot calibrate` | measure the refusal thresholds against your own corpus |
| `npx docpilot lint` | check the golden set against the index it measures |
| `npx docpilot eval` | run your golden set and write a report |
| `npx docpilot bench` | A/B two retrieval configurations on answer quality, with no API key |
| `npx docpilot doctor` | check the configuration without a full build; exits non-zero when not ready |
| `npx docpilot init` | scaffold the environment, the eval sets and the authoring skills |

The loop is `index → calibrate → lint → eval → bench`. The first two make the panel work; the last three tell you whether it works well, and they are the half that gets skipped.

**Calibrate before you ship.** Thresholds are a statement about one corpus and do not transfer between projects. Until `calibrate` has run, the gate uses provisional values and every record says so.

## Providers

One provider is usually enough. `embed: 'auto'` follows `chat.provider` and uses that service's own embedding model.

Chat **and** embeddings: `openai`, `together`, `fireworks`, `mistral`, `nebius`, `gemini`, `ollama`, `custom`.

Chat only — these need `embed` pointed elsewhere: `anthropic`, `openrouter`, `deepseek`, `groq`, `xai`, `cerebras`.

Choosing a chat-only provider with `embed: 'auto'` stops the build and names both ways out.

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

Every reader-facing string — about a hundred of them — is replaceable one at a time, in the same shape as VitePress's own local-search i18n:

```js
i18n: {
  locales: { ru: { translations: { empty: { heading: 'Чем помочь?' } } } },
}
```

Panel chrome follows the page's locale; the credential and greeting replies follow the language the reader typed. A key that does not exist is dropped and named on stdout.

## Skills

`npx docpilot init` copies two skills into `.claude/skills/`: `docs-rag`, the measurement and tuning loop with a list of experiments already run and what they cost, and `docs-import`, the contract for imported pages. A skill inside `node_modules` reaches nobody, so copying is the only delivery there is.

## Documentation

Full documentation — configuration reference, the retrieval contract, translation, imported pages, deploying it (nginx, containers, cache rules for the index) and mounting it on a site that is not VitePress: run `npm run docs:dev` in this repository.

## License

MIT
