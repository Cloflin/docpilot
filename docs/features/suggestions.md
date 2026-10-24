---
description: Starter questions in the empty panel, prepared answers that need no model call, and follow-up questions under each answer.
---

# Suggestions

An empty panel should not be a blank box. It shows a greeting and up to five questions to start from. `npx docpilot index` answers those questions at build time, so a click paints the answer in at once — no model call, no wait.

<Demo>
  <SuggestionsDemo />
  <template #code>

```ts
docPilot: {
  product: 'Acme',
  suggestions: {
    questions: ['How do I get started?', 'How do I authenticate requests?', 'What does it cost?'],
    followUps: true, // 2–3 next questions under the newest answer
  },
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `suggestions.questions` | `[]` | Your starter questions. With none, three generic ones are shown. A plain array of strings works too. |
| `suggestions.precomputed` | `true` | `npx docpilot index` runs retrieval for each question at build time, so a click needs no embedding call. |
| `suggestions.answers` | `true` | Also writes the answer at build time, so a click costs no request at all. Served only in the language it was written in. |
| `suggestions.authored` | `[]` | Answers you write yourself, `{ q, answer, cite }`, served verbatim. |
| `suggestions.reveal` | `true` | Paints a prepared answer in over about 1.4 seconds instead of all at once. |
| `suggestions.scoped` | `true` | Under a narrow scope, the rows become the pages in scope. |
| `suggestions.followUps` | `false` | Adds *Follow-up questions* under the newest answer. |
| `suggestions.matchTau` / `matchCos` | `0.65` / `0.72` | How close a typed question must be to a prepared one to reuse its answer. |

`product` names your product in the placeholder (*Ask about Acme*) and in the greeting. A *hello*, *thanks* or *who are you* is answered from a template in the reader's language, with no model call — see [Social openers](/guide/social-openers).

More: [`suggestions`](/reference/config#suggestions) in the reference.
