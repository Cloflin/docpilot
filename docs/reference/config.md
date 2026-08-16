# Configuration

Everything below goes in the object you pass to `defineDocPilot`, exported by name from `.vitepress/config.mjs` so the CLI reads the same one.

## Top level

| key | default | |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing. The site builds as if the package were absent. |
| `product` | `null` | What the docs are about, in the reader's words. Null renders as "this documentation". |
| `docsDir` | `'docs'` | Where the VitePress site lives, relative to the project root. |
| `indexDir` | `null` | Defaults to `${docsDir}/public/rag`. Set it only if you moved the index. |
| `evalDir` | `'docpilot'` | Where the golden set, calibration set and reports live. |
| `importDir` | `null` | A second corpus root, outside `docsDir` — see [Imported pages](/guide/imported-pages). |
| `sources` | `null` | The origins a page may name in `source:`. A security boundary. |
| `topK` | `12` | Excerpts handed to the model per turn. |
| `maxIterations` | `2` | See below — this default is measured, not chosen. |
| `suggestions` | `[]` | Empty falls back to the built-in three. |
| `feedbackEndpoint` | `null` | Where a thumbs-up/down POSTs. Null keeps every vote in `localStorage`. |
| `feedback` | see below | Which votes are sent, and whether the reader may write a sentence. |
| `guard` | see below | Overrides the calibrated thresholds. Use `docpilot calibrate` instead. |
| `scope` | see below | The scope picker. |
| `history` | see below | Past conversations, kept on the reader's own device. |
| `prompt` | see below | The instruction, and whether it is published. |
| `i18n` | `{}` | Every reader-facing string — see [Translating the panel](/guide/i18n). |

### `product`

The one brand-shaped string this package has. It reaches three places: the system instruction (`You answer questions about …`), the composer placeholder, and the assistant's own introduction when a reader says hello.

```js
product: 'Acme Editor'
```

It is deliberately **not** part of `i18n`: two locales disagreeing about a product's name is a defect with no upside, and this value also reaches the system message, which is build-time and untranslatable by design.

Setting it changes what is sent, so it moves `promptHash` and every eval report is filed under a new name. That is correct — see [Evaluation](/guide/evaluation).

### `maxIterations`

**2, and raising it is more expensive than it looks.** The host primes the turn with the gate's own excerpts, and every accumulated observation is re-sent on every step, so the cost of a turn grows with the square of its steps rather than with the evidence in it. Measured at 2 with an 8192-token context: 5.9k prompt tokens and 0.7k output per turn.

At 20 the worst case is roughly 138k tokens for a single question — and a local model with an 8192-token window will have shifted the system instruction out of context long before reaching it.

## `chat`

```js
chat: {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 2048,
  numCtx: 8192,
}
```

`provider` is any id from [Choosing providers](/guide/providers). A misspelling stops the build rather than quietly becoming a local Ollama nobody is running.

`numCtx` is sent on the Ollama transport only; hosted providers size their own context and ignore it. Ollama's server default is 4096, and a primed turn plus one tool call already exceeds that — past which llama.cpp shifts the window and drops the system block off the front, which surfaces as an unexplained refusal.

## `embed`

Either `'auto'` (the default — follow `chat.provider`) or an explicit object:

```js
embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' }
```

`model` **must** be the model that built the index. `baseURL` is read only for a local provider; a hosted embedder goes through the same proxy the chat does.

## `sources` and `importDir`

```js
importDir: 'knowledge-base',
sources: {
  allow: [
    'https://example.com',
    'https://example.com/blog',   // that prefix and nothing else on the host
  ],
}
```

`sources.allow` is the list of origins a page may name in its frontmatter `source:`. A `source:` outside the list **fails the build**, and so does a non-https one — this value becomes an `href` inside the answer panel, so markdown is never trusted with a URL scheme.

`importDir` is a second corpus root for pages that are indexed but have no route. Off by default. Full contract: [Imported pages](/guide/imported-pages).

`sources` is assigned whole, never merged: a half-merged allowlist is one whose contents nobody wrote.

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

These are gate inputs, not headings. A question your corpus cannot answer produces a refusal on the reader's first click, in the one state that exists to show the panel working. The built-in three are engine-agnostic for exactly that reason, and are worth replacing.

## `guard`

```js
guard: { mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3 }
```

`tau` and `tauLexical` are **measured, not chosen**: `npx docpilot calibrate` writes them into `${evalDir}/calibration.json` and `npx docpilot index` inlines them into the manifest. Setting them here overrides the measurement and stamps `gate.source: "config"` on every record of the session, which is what makes a hand-set threshold visible in a report rather than invisible in behaviour.

## `scope`

```js
scope: { enabled: true, default: 'all', promptListLimit: 12 }
```

`enabled: false` removes the scope picker; every question then searches the whole corpus. `default` accepts `'all'` and nothing else — a build-time default of `page` would silently narrow every reader's first question. `promptListLimit` caps how many page titles the scope block names in the instruction.

## `history`

```js
history: { enabled: true, maxConversations: 20 }
```

Past conversations, kept in the reader's `localStorage` and listed in the panel — see [Conversation history](/guide/history) for what the reader sees and what is stored.

`maxConversations` is the length of that list; the oldest falls off the end. A byte ceiling applies underneath it and is deliberately not a setting: `localStorage` is about 5MB **per origin**, shared with VitePress and your own theme, so the panel keeps to a tenth of it rather than asking you to reason about the split.

`enabled: false` does two things, not one. It stops recording, **and it clears what is already stored** on the reader's next visit — the same rule `prompt.show: false` applies to a reader's saved instruction. A site that turns this off after a privacy review leaves nothing behind.

## `ui`

```js
ui: { trigger: 'nav', panel: 'auto', fabLabel: true, fabIcon: true }
```

Where the button lives, what shape the panel takes, and what the floating button is made of.

| key | values | default |
|---|---|---|
| `trigger` | `'nav'` — beside the search box · `'fab'` — floating, bottom right | `'nav'` |
| `panel` | `'auto'` · `'drawer'` — full height, right edge · `'popup'` — floating, above the button | `'auto'` |
| `fabLabel` | `true` — the shipped words · a string — those words · `false` — no label | `true` |
| `fabIcon` | `false` drops the sparkle | `true` |

`'auto'` follows the trigger: `nav` opens the drawer, `fab` opens the popup. The crossed pairs — `nav` + `popup`, `fab` + `drawer` — are carried out in silence, which is what `'auto'` is for: once the implied pairing has a name of its own, an explicit value is an intention rather than a mistake to correct. A value outside either enum is reported on stdout during the build and falls back to the default; nothing throws, because a typo in a cosmetic setting must not be able to fail a docs build.

Below 960px both shapes are the same full-screen sheet, and the floating button hides itself while it is open.

### The floating button's label

A sparkle alone means "AI" to people who already know the pattern and nothing to everyone else — and unlike the navbar trigger it has no search box beside it to borrow context from. So it carries words:

```js
ui: { trigger: 'fab', fabLabel: 'Спросить ИИ' }   // exactly these words
ui: { trigger: 'fab', fabLabel: false }           // the 48px circle, icon only
ui: { trigger: 'fab', fabIcon: false }            // words only
```

`fabLabel: true` looks the string up through [i18n](/guide/i18n) as `trigger.fabLabel` — **Ask AI** by default — so a multilingual site gets it per locale from the tree it already has. A **string** is taken verbatim and is *not* looked up: an author who typed the words has already chosen the language. A blank string is the same as `false`.

`fabIcon: false` and `fabLabel: false` together is the one combination that has no rendering. It is reported on stdout and the icon is kept: the failure mode of a cosmetic setting must never be a panel nobody can open.

Both keys describe the **floating** placement only. The navbar trigger has always been icon-only beside the host's search box and the mobile nav-screen row has always been text; neither reads them, and `npx docpilot init` still asks only the two placement questions.

**This is a departure from convention, and worth saying so.** No package in either dependency tree of this project exposes an enum for placement — placement is normally the consumer's business, expressed by choosing which slot to fill. Here the slots belong to `docPilotSlots()`, which runs at import time when `themeConfig` cannot be read, so an enum is the only way for a consumer to express the choice at all. [Appearance](/guide/appearance) covers the geometry each value produces.

## `feedbackEndpoint` and `feedback`

```js
feedbackEndpoint: null,
feedback: { send: 'both', comment: true },
```

Two keys for one subject, because `feedbackEndpoint` shipped first and a bare `feedbackEndpoint: '/feedback'` keeps working unchanged. The endpoint is **where**; `feedback` is **what** and **whether**.

Null keeps every vote in `localStorage`, readable from the console with `window.__docPilot.exportFeedback()`. Set a URL and a vote is POSTed as JSON — question, verdict, reasons, any sentence the reader wrote, the gate's own numbers, the model, the prompt hash. The full body, the receiver contract and the SQL are on [Production](/guide/production#collecting-feedback).

| key | values | |
|---|---|---|
| `send` | `'both'` · `'down'` · `'up'` · `'none'` | Which verdicts leave the device. `'none'` keeps everything local while leaving the thumbs on screen. |
| `comment` | `true` · `false` | Whether a down-vote offers a free-text box. The box is hidden anyway when nothing would be transmitted. |

**`'both'` is the default because a table of complaints is not a measurement.** A helpfulness rate needs a denominator, and probes drawn from down-votes alone are a purely negative sample — calibrating a threshold against one moves the gate toward refusing every reader. `npx docpilot feedback report` says so in its own output when it has to. Set `'down'` if you only want to hear about failures and will not be using the sample to move a threshold.

The panel's disclaimer follows this setting, in the reader's language: no endpoint or `send: 'none'` says nothing about reports, `'down'` says not-helpful reports are sent, and `'up'`/`'both'` says the rating is. A reader who is told their report goes nowhere and finds that it does is entitled to be annoyed.

### The sentence, and what happens to it

A down-vote opens a form: the four reasons, which are **multi-select** — a wrong answer is often also an incomplete one — and a text box.

What the reader types is capped at 500 characters and run through the same credential redaction the question gets, **before** it is stored and before it is sent. That is not a setting. `credentials.js` exists so the panel can tell a reader that a pasted key went nowhere, and it names feedback reports as one of the directions such a key travels; a comment box that shipped raw text would make that promise false. A key in a comment is replaced with `YOUR_SECRET_KEY` in `localStorage` and in the request body alike.

### Two POSTs per report, one row

The thumb POSTs immediately — a reader who closes the tab has still been heard — and the form POSTs again when it is submitted, under the **same `messageId`** with `revision` raised. Withdrawing a vote posts too, with `verdict: null`, so a reader can take back what they said.

**Your receiver must upsert on `messageId` and keep the higher revision.** The SQL that does it is on [Production](/guide/production#collecting-feedback), along with the two clauses that are load-bearing and easy to leave out.

## `prompt`

```js
prompt: { show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: '' }
```

Two different things under one key.

`show` / `allowAppend` are about the **reader**: whether the instruction is published in the panel, and whether they may add a line to it for their session. That line never reaches the system message.

`override` / `extend` are the instruction the **model** is sent. `override` replaces the shipped text outright; `extend` is appended to whichever is in force.

**Three rules in the shipped text are load-bearing for the host, not style.** An override that drops them refuses every turn however good the model is, because the answer is checked, not the prompt:

- cite every claim with `[1]`, `[2]` matching the citations array;
- return confidence 0 when the excerpts do not answer the question;
- no headings; code in fenced blocks.

An override also drops the credential rules, silently — no host check notices their absence. After any override, re-run `npx docpilot calibrate`: the gate was measured against the shipped instruction.

`{product}` is not interpolated into an override. An override is text you wrote in full, and substituting into it would make `{product}` a syntax you never opted into.

## `i18n`

```js
i18n: {
  translations: { empty: { heading: 'How can I help?' } },
  locales: { ru: { translations: { empty: { heading: 'Чем помочь?' } } } },
}
```

The inside is byte-for-byte VitePress's own [local-search i18n](https://vitepress.dev/reference/default-theme-search#local-search-i18n), so their example transfers unchanged. The full key table, the two selectors and the fallback chain are on [Translating the panel](/guide/i18n).

## What reaches the browser

`ai.themeConfig` is compiled into the client bundle. It carries the provider **adapter** (not the brand), a same-origin base path, the model name, and the settings above — `ui` crosses already resolved, so `'auto'` never reaches the browser. It never carries a key or an upstream host.

Five keys are deliberately withheld — `docsDir`, `indexDir`, `evalDir`, `importDir` and `sources`. They describe the build, not the panel, and the allowlist in particular has already done its work by then: the origin it approved is baked into `manifest.pages[].origin`.

That list is asserted, not remembered: a test walks every key of `DEFAULTS` and fails unless it is either emitted to the client or named in `SERVER_ONLY`. A setting that is documented but never sent — which is how `suggestions`, `guard`, `scope` and `feedbackEndpoint` all shipped once — cannot happen twice.
