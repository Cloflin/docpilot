---
description: Show readers the exact instruction the model runs under, its tools and its scope — and optionally let them add their own.
---

# How this works

An answer is easier to trust when the rules behind it are visible. With `prompt.show`, a **How this works** disclosure in the panel shows the system instruction, the tools the model may call, and what it is searching. With `prompt.allowAppend`, readers can add an instruction of their own.

<Demo>
  <PromptDemo />
  <template #code>

```ts
docPilot: {
  prompt: {
    show: true,         // the "How this works" disclosure
    allowAppend: true,  // readers may add an instruction
    appendMaxChars: 500,
    extend: 'Prefer TypeScript in code samples.', // your addition, at build time
  },
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `prompt.show` | `false` | Adds the disclosure: instructions, tools, scope. |
| `prompt.allowAppend` | `false` | Lets the reader add an instruction. It is sent with the question, never inside the system instruction, and kept for the session only. |
| `prompt.appendMaxChars` | `500` | Length limit for the reader's instruction. |
| `prompt.extend` | `''` | Text you add after the shipped instruction, at build time. |
| `prompt.override` | `null` | Replaces the shipped instruction entirely. |

On a site with its own [tools](/features/tools), the disclosure lists them with the built-in ones, with the descriptions the model reads, because it publishes what is sent.

More: [`prompt`](/reference/config#prompt) in the reference.
