# Choosing providers

Chat and embeddings are **two decisions**, and the second is the one that is easy to get wrong.

## One provider, if it can do both

```js
export const askAI = {
  chat: { provider: 'openai', model: 'gpt-4o' },
  // embed: 'auto' is the default — it follows chat.provider
}
```

`embed: 'auto'` uses the chat provider's own embedding model. Providers that serve both:

`openai` · `together` · `fireworks` · `mistral` · `nebius` · `gemini` · `ollama` · `custom`

## Two providers, when the first cannot embed

These answer but do not retrieve — they have no embeddings endpoint at all:

`anthropic` · `openrouter` · `deepseek` · `groq` · `xai` · `cerebras`

Choosing one of them with `embed: 'auto'` **stops the build** and names both ways out. Do not treat that as an inconvenience: it is the failure that is otherwise silent until a reader asks a question and gets a refusal.

```js
export const askAI = {
  chat:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}
```

A project-scoped key limited to chat models hits the same wall with a provider that *does* embed. The split is the fix in both cases.

## Fully local, no key

```js
export const askAI = {
  chat: { provider: 'ollama', model: 'qwen3:8b' },
}
```

```bash
ollama pull bge-m3
ollama pull qwen3:8b
```

Nothing to put in `.env`. This is the setup to develop against.

## Dropping the embedder is not an option

It was measured on a 1191-chunk corpus: recall@8 fell from 0.97 to 0.41, retrieval F1 from 0.35 to 0.18, and 11 of 44 answerable questions were refused outright. Keyword matching alone also scores zero for any question asked in a language your corpus is not written in — there is no lexical overlap to score.

## Where the key lives

In Node, never in the page. `themeConfig` is compiled into the client bundle, so a key written there is a key published.

- **Development**: the Vite plugin installs a proxy that attaches the key.
- **Production**: your reverse proxy does the same. The built site expects a same-origin `/ai` path in front of it.

`vitepress preview` has no proxy, so the panel cannot answer there. That is not a bug to work around by moving the key.
