# vitepress-plugin-ask-ai

A grounded AI answer panel for VitePress documentation.

Retrieval runs **in the reader's browser** against a static index built at deploy time — no vector database, no search service, no server beyond the one already serving your site. A calibrated gate refuses **before the model is called**, so an off-topic question costs zero tokens and produces zero generated text. Every citation the reader sees is checked against what the host actually retrieved during that turn.

```bash
npm i vitepress-plugin-ask-ai
npx ask-ai init
```

## Add it

```js
// docs/.vitepress/config.mjs
import { defineConfig, loadEnv } from 'vitepress'
import { defineAskAI } from 'vitepress-plugin-ask-ai'

export const askAI = {
  chat:  { provider: 'openai', model: 'gpt-4o' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}

const ai = defineAskAI(askAI, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { askAI: ai.themeConfig },
})
```

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withAskAi } from 'vitepress-plugin-ask-ai/theme'

export default withAskAi(DefaultTheme)
```

```bash
npx ask-ai index        # build the retrieval index from your docs
npx ask-ai calibrate    # measure the refusal thresholds against your corpus
```

The `askAI` **named export** is the contract between the build and the CLI: both read the same object, so there is no second place to state which model embeds or where the docs live.

## Nothing configured yet?

The site still builds. The panel switches itself off and the build prints one block:

```
[ask-ai] the panel is OFF — 2 things to set up:

  · chat: "openai" needs a key and none is set
      export OPENAI_API_KEY=…
  · no index at docs/public/rag
      npx ask-ai index

  The site builds and every other feature is untouched.
  Run `npx ask-ai doctor` to re-check without a full build.
```

A dependency that can fail someone else's docs build the moment it lands is a dependency they remove. `npx ask-ai doctor` is the opt-in place to turn the same facts into a non-zero exit for CI.

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
| `npx ask-ai index` | build the retrieval index from your markdown and OpenAPI files |
| `npx ask-ai calibrate` | measure the refusal thresholds against your own corpus |
| `npx ask-ai eval` | run your golden set and write a report |
| `npx ask-ai doctor` | check the configuration without a full build; exits non-zero when not ready |
| `npx ask-ai init` | scaffold `.env.example` and print the next step |

**Calibrate before you ship.** Thresholds are a statement about one corpus and do not transfer between projects. Until `calibrate` has run, the gate uses provisional values and every record says so.

## Providers

One provider is usually enough. `embed: 'auto'` follows `chat.provider` and uses that service's own embedding model.

Chat **and** embeddings: `openai`, `together`, `fireworks`, `mistral`, `nebius`, `gemini`, `ollama`, `custom`.

Chat only — these need `embed` pointed elsewhere: `anthropic`, `openrouter`, `deepseek`, `groq`, `xai`, `cerebras`.

Choosing a chat-only provider with `embed: 'auto'` stops the build and names both ways out.

## Credentials

The panel refuses a question containing a credential shape — API keys, JWTs, bearer tokens, AWS key ids, hex digests — **before the embedding call**, so the value never leaves the browser. It is replaced with a placeholder, the warning is written in the reader's language, and one button answers the original question without it.

This is a habit guard, not a security boundary. It cannot stop a reader who pastes a key into a model directly.

## Documentation

Full documentation, including configuration reference and the retrieval contract: run `npm run docs:dev` in this repository.

## License

MIT
