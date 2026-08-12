# Configuration

Everything below goes in the object you pass to `defineAskAI`, exported by name from `.vitepress/config.mjs` so the CLI reads the same one.

## Top level

| key | default | |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing. The site builds as if the package were absent. |
| `docsDir` | `'docs'` | Where the VitePress site lives, relative to the project root. |
| `indexDir` | `null` | Defaults to `${docsDir}/public/rag`. Set it only if you moved the index. |
| `evalDir` | `'ask-ai'` | Where the golden set, calibration set and reports live. |
| `topK` | `12` | Excerpts handed to the model per turn. |
| `maxIterations` | `2` | See below — this default is measured, not chosen. |
| `suggestions` | `[]` | Empty falls back to the built-in three. |

### `maxIterations`

**2, and raising it is more expensive than it looks.** The host primes the turn with the gate's own excerpts, and every accumulated observation is re-sent on every step, so the cost of a turn grows with the square of its steps rather than with the evidence in it. Measured at 2 with an 8192-token context: 5.9k prompt tokens and 0.7k output per turn.

At 20 the worst case is roughly 138k tokens for a single question — and a local model with an 8192-token window will have shifted the system instruction out of context long before reaching it.

## `chat`

```js
chat: { provider: 'openai', model: 'gpt-4o', temperature: 0.2 }
```

`provider` is any id from [Choosing providers](/guide/providers). A misspelling stops the build rather than quietly becoming a local Ollama nobody is running.

## `embed`

Either `'auto'` (the default — follow `chat.provider`) or an explicit object:

```js
embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' }
```

`model` **must** be the model that built the index. `baseURL` is read only for a local provider; a hosted embedder goes through the same proxy the chat does.

## `suggestions`

The three questions on the empty state.

```js
suggestions: [
  'How do I connect the editor to my app?',
  'How do I authenticate requests?',
  'How do I build a custom extension?',
]
```

Strings, not `{label, question}` objects: the row submits what it shows, so a separate label would put a question the reader never read into the thread.

The first three are used. Extras, empties, repeats and non-strings are dropped and **named on stdout** — a silent cap reads as "covered everything" when it did not.

These are gate inputs, not headings. A question your corpus cannot answer produces a refusal on the reader's first click, in the one state that exists to show the panel working.

## `prompt`

```js
prompt: { show: false, allowAppend: false, override: null, extend: '' }
```

Two different things under one key.

`show` / `allowAppend` are about the **reader**: whether the instruction is published in the panel, and whether they may add a line to it for their session. That line never reaches the system message.

`override` / `extend` are the instruction the **model** is sent. `override` replaces the shipped text outright; `extend` is appended to whichever is in force.

**Three rules in the shipped text are load-bearing for the host, not style.** An override that drops them refuses every turn however good the model is, because the answer is checked, not the prompt:

- cite every claim with `[1]`, `[2]` matching the citations array;
- return confidence 0 when the excerpts do not answer the question;
- no headings; code in fenced blocks.

An override also drops the credential rules, silently — no host check notices their absence. After any override, re-run `npx ask-ai calibrate`: the gate was measured against the shipped instruction.

## What reaches the browser

`ai.themeConfig` is compiled into the client bundle. It carries the provider **adapter** (not the brand), a same-origin base path, the model name, and the settings above. It never carries a key or an upstream host.
