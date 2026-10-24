---
description: When a model is rate-limited, retired or down, the question moves to the next model in your list — and the one that answered goes first next time.
---

# Model fallback

Give the panel more than one model and an outage stops being the reader's problem. A 429 from the first model sends the same question to the second; the model that answers is tried first on the next question, and the one that failed is set aside for a minute.

<Demo>
  <FallbackDemo />
  <template #code>

```ts
docPilot: {
  chat: {
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    models: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash'],
  },
}
```

  </template>
</Demo>

## Two levels

| Key | Moves between | Use it for |
|---|---|---|
| `chat.models` | models on **one** provider | A pool on a gateway like OpenRouter, or several sizes on one account. |
| `chat.chain` | **providers** — each with its own key | OpenAI first, Anthropic if OpenAI is down. `'auto'` builds the chain from the keys in your environment. |

```ts
// providers, in order — each member names its own key variable
chat: {
  chain: [
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'anthropic', model: 'claude-haiku-4-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  ],
}
```

## When it moves, and when it does not

It moves on a 429, a retired model id, a moderation refusal, a 5xx, or an empty reply. It does **not** move when the reader pressed Stop, when an answer has already started painting, on a 401 (a wrong key is not fixed by another model), or on a daily limit.

The embedding model never rotates: two embedders are two different vector spaces, and the index was built in one of them. If every model fails, the reader still gets something useful — *The AI models aren't reachable right now — this is a search answer* — with the closest passages and a **Retry** button.

More: [`chat.models`](/reference/config#chat-models) and [`chat.chain`](/reference/config#chat-chain) in the reference, and [Choosing providers](/guide/providers).
