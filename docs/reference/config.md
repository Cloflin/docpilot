---
title: Configuration
pageClass: wide-table
---

# Configuration

Everything below goes in the object you pass to `defineDocPilot`, exported by
name from `.vitepress/config.mjs` so the CLI reads the same one.

```js [docs/.vitepress/config.mjs]
import { defineConfig, loadEnv } from 'vitepress'
import { defineDocPilot } from '@cloflin/docpilot'

export const docPilot = {
  product: 'Acme Editor',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
}

const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { docPilot: ai.themeConfig },
})
```

Nested objects merge with their defaults one level deep. Two do not: `embed` is a
union rather than an object, and `sources` is assigned whole — a half-merged
allowlist is one whose contents nobody wrote.

## All defaults

Every shipped value, in one block. Write none of it and this is what you get; the
sections below say what each one means and why it is what it is.

```js [every default, written out]
export const docPilot = {
  enabled: true,
  product: null,
  docsDir: 'docs',
  indexDir: null,
  evalDir: 'docpilot',
  importDir: null,
  sources: null,
  openapi: null,
  chat: { provider: 'auto', chain: 'auto', preferLocal: false, model: null, baseURL: null, models: null, temperature: 0.2, maxTokens: 2048, numCtx: 8192, reasoning: 'auto', verbosity: null, topP: null, seed: null },
  embed: 'auto',
  topK: null,
  maxIterations: 2,
  budget: { mode: 'auto', oneShotBelow: 15, rotateAbove: 6, maxContinuations: 1, showRemaining: false, probe: 'auto', dailyLimit: null },
  suggestions: { questions: [], authored: [], scoped: true, followUps: false, precomputed: true, answers: true, matchTau: 0.65, matchCos: 0.72, reveal: true },
  quote: { fromAnswer: true, fromDocs: false },
  citations: { passage: false, inCopy: true, pagesRead: false },
  composer: { editLastOnArrowUp: true, deepLink: true, draft: true },
  feedbackEndpoint: null,
  feedback: { send: 'both', comment: true, confirm: true },
  guard: { mode: 'off', tau: null, tauLexical: null, supportMinIdentifiers: 3 },
  vocabulary: null,
  scope: { enabled: true, default: 'all', promptListLimit: 12, filter: 'auto', groupBySection: true },
  history: { enabled: true, maxConversations: 20, exportThread: true, saveOnUnload: true },
  prompt: { show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: '' },
  ui: { trigger: 'fab', panel: 'auto', fabLabel: true, fabIcon: true, layout: 'overlay', prefetch: 'hover', firstRunHint: false, waitingEscalation: true, background: 'notify', credit: true, theme: 'auto', font: null, fontMono: null },
  host: { base: null, ragBase: null, article: null, search: null, content: null },
  i18n: { translations: {}, locales: {} },
}
```

**This block is checked against the code.** A test walks `DEFAULTS` in
`src/config.ts` and fails unless it equals what is written here — the same
discipline the [i18n key table](/guide/i18n#the-keys) is held to. A default that
moves without this page moving cannot ship.

Four things the block cannot say on its own:

- **[`chat.extraBody`](#chat-extrabody) is absent, because it has no single
  default.** It is the provider's own: `{ provider: { require_parameters: true } }`
  on `openrouter`, nothing anywhere else. Writing `null` is how you decline it.
- **Three keys are unions, and are written above in their resolved form** — the
  shape the browser receives. [`embed`](#embed) also accepts `false`,
  [`budget`](#budget) also accepts `false`, and [`suggestions`](#suggestions) also
  accepts a plain array of strings.
- **[`chat.provider`](#chat-provider) and [`chat.model`](#chat-model) are the
  two the environment can answer.** `'auto'` walks [the provider
  chain](#the-provider-chain) and takes the first service this environment holds
  a key for; that service's own default model comes with it. An empty
  environment resolves to a local Ollama on `qwen3:8b`, which is what this
  package shipped with before the chain existed.
- **A model name never crosses providers.** `qwen3:8b` is a statement about
  Ollama and `gpt-4o-mini` is one about OpenAI, so each lives on its provider's
  row in the table rather than in this block. Naming a provider with no model
  gets that provider's default; naming one that has neither a default nor a free
  pool — `custom` — is still a build-stopping error.
- **Five keys never reach the browser** — `docsDir`, `indexDir`, `evalDir`,
  `importDir` and `sources`. See [What reaches the browser](#what-reaches-the-browser).

## Parameters

Every setting, what it accepts, what it ships as, and one line of what it does.
The block above is what you paste; this is what you scan. Each name links to the
section below that says *why* the default is what it is.

**Both views are checked against the code.** The table's Default column is
executed and compared to `DEFAULTS` in `src/config.ts` by the same test that
holds the block — a setting with no row, a row for a setting that does not exist,
and a default written down wrong all fail the suite. Types and descriptions are
written by hand; only the values are mechanical.

<!-- PARAMETERS TABLE -->

| Name | Type | Default | Description |
|---|---|---|---|
| [`enabled`](#enabled) | `boolean` | `true` | `false` mounts nothing — the site builds exactly as if the package were not installed |
| [`product`](#product) | `string \| null` | `null` | Names what the corpus is about in the system prompt, composer placeholder and greeting; `null` reads as "this documentation" — *reaches the system prompt, so changing it moves `promptHash` and refiles every eval report* |
| [`docsDir`](#docsdir) | `string` | `'docs'` | Where the VitePress site lives, relative to the project root, and the root `indexDir` defaults under — *server-only — the CLI and the build read it, the browser never receives it* |
| [`indexDir`](#indexdir) | `string \| null` | `null` | Overrides where the built index is written and read — set it only if you moved it out of `${docsDir}/public/rag` — *server-only, and a moved index also needs `host.ragBase` so the browser can fetch it* |
| [`evalDir`](#evaldir) | `string` | `'docpilot'` | Holds the golden set, the calibration set and the reports — a statement about your corpus, resolved from the project root — *server-only — the CLI reads it, the panel never sees it* |
| [`importDir`](#importdir) | `string \| null` | `null` | A second corpus root that is indexed but never routed — its pages carry a mandatory frontmatter `source:` as their citation — *server-only, and it must sit outside `docsDir` or VitePress publishes the pages anyway* |
| [`sources`](#sources) | `{ allow: string[] } \| null` | `null` | The https origins a page may name in `source:`, each optionally narrowed to a path prefix; `null` forbids `source:` outright — *server-only, and assigned whole rather than merged, so a partial object is the entire allowlist* |
| [`openapi`](#openapi) | `string[] \| null` | `null` | Where the OpenAPI specs are, as paths from the project root — a directory, a file, or a `*` in the file name; `null` means `${docsDir}/public/openapi` — *server-only, and each spec claims `/reference/<basename>`, so two entries sharing a basename claim one route and the build says so* |
| [`chat.provider`](#chat-provider) | `ProviderId \| 'auto'` | `'auto'` | Picks which service answers and where the request is sent; `'auto'` reads the environment and takes the first key it finds along [the chain](#the-provider-chain) — *fifteen ids, listed under [Choosing providers](/guide/providers); a misspelled one stops the build instead of quietly becoming a local Ollama* |
| [`chat.chain`](#chat-chain) | `'auto' \| false \| Array<ProviderId \| ChainMember>` | `'auto'` | Which SERVICES may answer, in order — the provider-level form of `chat.models`; `'auto'` is every member of [the chain](#the-provider-chain) the environment selects, billed accounts before free tiers, an array is your own set, `false` is one provider chosen once — *fires only where `chat.provider` is also `'auto'`, so naming a provider is how rotation is declined; the embed half never rotates* |
| [`chat.preferLocal`](#chat-preferlocal) | `boolean` | `false` | Puts a server of your own — `custom`, `llamacpp`, `ollama` — at the FRONT of the ladder instead of the back, and makes an environment that selects nothing fall through to a local Ollama rather than to OpenRouter's free tier — *it reorders, it never selects: a local server is still reached by its address, and `readiness` says so when this moved nothing* |
| [`chat.model`](#chat-model) | `string \| null` | `null` | The id the provider knows the model by — `null` takes that provider's own default from the table in [Choosing providers](/guide/providers), and `'auto'`, `'free'` and `''` normalise to it — *never inherited across providers; `openrouter` and `custom` have no default, so a free pool answers for the first and only you can answer for the second* |
| [`chat.baseURL`](#chat-baseurl) | `string \| null` | `null` | Where the provider is, for one that is somewhere of your own — `null` takes the provider's own address, and `OLLAMA_BASE_URL` / `LLAMACPP_BASE_URL` / `CUSTOM_BASE_URL` set it from the environment — *ignored for a hosted provider, which the browser reaches through the same-origin `/ai`* |
| [`chat.models`](#chat-models) | `string[] \| null` | `null` | An ordered fallback pool walked on a 429, a retired id or an empty answer, with the model that answered tried first next time — *left `null` on `openrouter` with no model named, the shipped free pool rotates anyway* |
| [`chat.extraBody`](#chat-extrabody) | `Record<string, unknown> \| null` | *(the provider's own)* | Fields merged into the body of every chat request, for the things one brand understands and the transport does not — *PRESENCE decides: omit it and the provider's fragment stands, `null` posts the plain body, an object REPLACES rather than merges; it is not in `DEFAULTS` because there is no third value to ship* |
| [`chat.temperature`](#chat-temperature-chat-maxtokens) | `number` | `0.2` | Sampling spread for the answering model; 0.2 keeps one question from yielding two different sets of steps, higher loosens the wording — *never sent to Anthropic, whose API rejects sampling parameters outright* |
| [`chat.maxTokens`](#chat-temperature-chat-maxtokens) | `number` | `2048` | Caps the tokens in a single reply; a reply cut off at that ceiling is continued rather than lost, up to `budget.maxContinuations` — *every transport sends it, under the name that API gives it: `max_tokens`, `max_completion_tokens`, or Ollama's `options.num_predict`* |
| [`chat.numCtx`](#chat-numctx) | `number` | `8192` | Context window asked of Ollama; 8192 keeps a primed turn plus its tool calls from shifting the system block off the front |
| [`chat.reasoning`](#chat-reasoning) | `'auto' \| false \| true \| ReasoningLevel \| object` | `'auto'` | How hard the model should think, in one provider-neutral word — `'auto'` leaves it to DocPilot, which asks on the answer and never on a search step — *the level is clamped to the vocabulary the configured service publishes, and no two services publish the same one* |
| [`chat.verbosity`](#chat-verbosity) | `'low' \| 'medium' \| 'high' \| null` | `null` | A soft ceiling on the answer's length, where `maxTokens` is the hard one — *accepted by two providers in the table; naming it beside any other stops the build* |
| [`chat.topP`](#chat-topp-chat-seed) | `number \| null` | `null` | Nucleus sampling, sent only when set — *Anthropic rejects it, so setting it there stops the build* |
| [`chat.seed`](#chat-topp-chat-seed) | `number \| null` | `null` | Pins the sampler so the same question takes the same steps twice — *the Anthropic Messages API has no such parameter at all* |
| [`embed`](#embed) | `EmbedConfig` | `'auto'` | Picks who embeds the corpus and each query — `'auto'` follows `chat.provider`, an object splits them, `false` or `'none'` means BM25 only — *under `'auto'` a provider with no embeddings endpoint borrows OpenRouter's free pool at build time* |
| [`topK`](#topk) | `number \| null` | `null` | How many excerpts the gate primes a turn with — `null` takes the k `docpilot tune` measured into the manifest, a number overrides it — *a number is rounded and clamped to 1..12, and the model's own `search_docs` k stays capped at 8* |
| [`maxIterations`](#maxiterations) | `number` | `2` | Caps the tool-calling steps before the forced final answer — each step re-sends every observation, so a turn's cost grows quadratically — *a budget plan that lands in one-shot mode drives it to 0 for that turn* |
| [`budget.mode`](#budget-mode) | `'auto' \| 'agentic' \| 'one-shot'` | `'auto'` | Shape of a turn: `'agentic'` runs the tool loop, `'one-shot'` spends one request, `'auto'` switches when answers run thin — *the whole `budget` key also accepts `false` — agentic every turn, both thresholds retired* |
| [`budget.oneShotBelow`](#budget-oneshotbelow-budget-rotateabove) | `number` | `15` | Answers left at or below which `'auto'` collapses a turn to one request, roughly tripling the questions left in the day — *a whole number of 0 or more, or `-1` for never; it never fires against a remaining count the panel cannot vouch for* |
| [`budget.rotateAbove`](#budget-oneshotbelow-budget-rotateabove) | `number` | `6` | Pool rotation stops once answers left reach this, buying back the request rather than a second opinion; `-1` retires the rule — *read whatever `mode` is, so `mode: 'agentic'` does not disable it — only `-1` or `budget: false` does* |
| [`budget.maxContinuations`](#budget-maxcontinuations) | `number` | `1` | Follow-up requests a reply truncated at the provider's output ceiling may spend to finish itself; `0` loses the answer to a refusal — *0 to 3 only, and driven to `0` once two answers are left* |
| [`budget.showRemaining`](#budget-showremaining) | `boolean` | `false` | Adds the muted line under the composer — answers left today, and where `embed: false` that this deployment has no embedder — *the count half needs a daily allowance: a declared `dailyLimit`, or the provider's own free pool* |
| [`budget.probe`](#budget-probe) | `'auto' \| 'always' \| 'never'` | `'auto'` | Governs the tool-detection call made on page load: `'auto'` skips it for a pool, `'always'` keeps it, `'never'` drops it |
| [`budget.dailyLimit`](#budget-dailylimit) | `number \| null` | `null` | Declares a ceiling to count against locally for a metered service that sends no rate-limit headers; header counts still win — *`0` is reported and ignored — everything downstream reads a falsy ceiling as no ceiling at all* |
| [`suggestions.questions`](#suggestions-questions) | `(string \| { q, answer, cite })[]` | `[]` | Replaces the built-in three empty-state openers with your own — the first five are used, extras, empties and repeats dropped and named on stdout — *`suggestions: ['One?']` — a bare array — sets this same key* |
| [`suggestions.authored`](#suggestions-authored) | `{ q, answer, cite }[]` | `[]` | The openers you answered yourself: the prose ships verbatim and no model is called for it, at build time or in the browser — *resolved out of `questions`; writing it directly is what makes the resolver idempotent* |
| [`suggestions.scoped`](#suggestions-scoped) | `boolean` | `true` | Under a narrowed scope, fills the empty panel with the pages in that scope as rows rather than leaving it blank — no text is generated — *`false` gives back the blank panel, not the questions: those never show under a narrow scope* |
| [`suggestions.followUps`](#suggestions-followups) | `boolean` | `false` | Adds up to three next-question rows under the newest answer, built from headings on the pages it cited — no model call and nothing invented |
| [`suggestions.precomputed`](#suggestions-precomputed) | `boolean` | `true` | Has `npx docpilot index` resolve the openers ahead of time and the panel use what it resolved, so a reader clicking one spends no embedding request — *off, nothing is baked and nothing is read* |
| [`suggestions.answers`](#suggestions-answers) | `boolean` | `true` | Also bakes the ANSWER to each opener, served instantly and free when the reader's language matches the language it was written in — *costs one model request per opener per index build* |
| [`suggestions.matchTau`](#suggestions-matchtau) | `number \| false` | `0.65` | How much of a typed question's rare wording an opener has to cover, in both directions, to count as the same question — *`false` leaves exact matching only* |
| [`suggestions.matchCos`](#suggestions-matchcos) | `number \| false` | `0.72` | The same test in the vector space, run after the query is embedded, so a paraphrase sharing no words with an opener still finds its answer — *costs nothing: the vector was bought for the turn either way* |
| [`suggestions.reveal`](#suggestions-reveal) | `boolean` | `true` | A baked answer is painted progressively rather than appearing whole — *no request and no model; `prefers-reduced-motion` and Stop both skip it* |
| [`quote.fromAnswer`](#quote-fromanswer) | `boolean` | `true` | Selecting text inside an answer raises one button that attaches the passage to the composer as a chip — *off together with `fromDocs` also suppresses `ui.firstRunHint`, which names that gesture* |
| [`quote.fromDocs`](#quote-fromdocs) | `boolean` | `false` | Extends that selection popover to your own article, so a reader can ask about the paragraph that confused them without retyping it — *only inside `host.article` — nav, sidebar and footer are deliberately out of bounds* |
| [`citations.passage`](#citations-passage) | `boolean` | `false` | Gives every source row a chevron that expands the exact retrieved chunk inline, costing no request since the text is already in the browser — *on a restored conversation the chunk is resolved by id, so a rebuilt index simply drops the control* |
| [`citations.inCopy`](#citations-incopy) | `boolean` | `true` | Copying an answer appends its sources as Markdown links with absolute URLs, so a pasted `[1]` arrives with something behind it — *exported threads honour it too, via `history.exportThread`* |
| [`citations.pagesRead`](#citations-pagesread) | `boolean` | `false` | Names the pages a refused turn actually read, under the line that already counts them, turning that claim into something checkable — *built at turn time, so refusals archived while it was off never gain the list* |
| [`composer.editLastOnArrowUp`](#composer-editlastonarrowup) | `boolean` | `true` | `↑` in an empty composer reopens the last question for editing, caret at the end — ChatGPT's behaviour and readline's before it |
| [`composer.deepLink`](#composer-deeplink) | `boolean` | `true` | Reads `?dp-ask=` into the composer and deliberately does not submit, so a link can hand a reader a question and spend no turn — *`false` disables the companion `&dp-scope=page` as well* |
| [`composer.draft`](#composer-draft) | `boolean` | `true` | Keeps the composer's text in `sessionStorage` so a reload does not empty it, redacted on the same rule a question is — *gated on `history.enabled` too: "record nothing" means nothing* |
| [`feedbackEndpoint`](#feedbackendpoint) | `string \| null` | `null` | Where a thumbs-up or thumbs-down POSTs as JSON; `null` keeps every vote in localStorage for console export |
| [`feedback.send`](#feedback-send) | `'both' \| 'down' \| 'up' \| 'none'` | `'both'` | Which verdicts leave the device — `'down'` for complaints only, `'none'` keeps the thumbs on screen but sends nothing — *inert without `feedbackEndpoint`; an unrecognised value logs and falls back to `'both'`* |
| [`feedback.comment`](#feedback-comment) | `boolean` | `true` | Offers a free-text box beside the down-vote reason buttons; `false` keeps the buttons and drops the box — *the box is hidden anyway when there is no `feedbackEndpoint` or `send` is `'none'`* |
| [`feedback.confirm`](#feedback-confirm) | `boolean` | `true` | Replaces the submitted form with a line naming where the report went; `false` leaves only the live-region announcement |
| [`guard.mode`](#guard-mode-guard-supportminidentifiers) | `'off' \| 'dense-only' \| 'calibrated'` | `'off'` | Whether a failing verdict ENDS the turn before the model is called — `'off'` never, `'dense-only'` enforces it only where there is a dense channel that scored it, `'calibrated'` always — *every value scores every turn and records the verdict; only the refusal moves* |
| [`guard.tau`](#guard-tau-guard-taulexical) | `number \| null` | `null` | Pass mark for the hybrid score `wDense·D + wLexical·L`; null takes the calibrated pair from the manifest, a number overrides it — *a value at or below `wLexical` (0.25 provisional) throws at retrieval init* |
| [`guard.tauLexical`](#guard-tau-guard-taulexical) | `number \| null` | `null` | The pass mark on turns with no dense channel, where G is lexical coverage alone; null keeps the manifest's measured value — *setting either threshold stamps `gate.source: "config"` on every record of the session* |
| [`guard.supportMinIdentifiers`](#guard-mode-guard-supportminidentifiers) | `number` | `3` | Minimum code identifiers an answer must carry before its identifier-support ratio is scored rather than assumed perfect — *support is recorded for calibration only and never enforced, so this blocks no answer* |
| [`vocabulary`](#vocabulary) | `Record<string, string[]> \| null` | `null` | The documentation's own name for things readers call by other names — `{DocPilot: ['widget', 'виджет', 'ассистент']}` — rewritten into the query and into the index by the one tokenizer, so a reader who says `виджет` reaches a page that says `DocPilot`; `null` takes the sidecar `npx docpilot vocabulary` writes — *server-only: the browser gets it from the manifest, because the manifest is what the index was built with* |
| [`scope.enabled`](#scope) | `boolean` | `true` | Shows the scope picker; `false` removes it and every question then searches the whole corpus |
| [`scope.default`](#scope) | `'all'` | `'all'` | The scope a reader's first question starts in — whole-corpus is the only accepted value, since a narrowed default hides pages silently — *anything else is reported to the console and reset to `'all'` at configure() time* |
| [`scope.promptListLimit`](#scope) | `number` | `12` | How many page paths a narrowed scope names in the system prompt before it states a count instead |
| [`scope.filter`](#scope-filter) | `'auto' \| boolean` | `'auto'` | A search field above the page list; `'auto'` shows it once the corpus passes twelve pages, `true` or `false` decide it outright |
| [`scope.groupBySection`](#scope-groupbysection) | `boolean` | `true` | Groups the picker's pages under their sidebar section headings instead of showing one flat list — *suspended while the filter field has text, so a filtered list stays flat* |
| [`history.enabled`](#history-enabled) | `boolean` | `true` | Keeps past threads in the reader's `localStorage` and lists them in the panel switcher, so a reload or a new tab loses nothing — *`false` also clears what is already stored, on the reader's next visit* |
| [`history.maxConversations`](#history-maxconversations) | `number` | `20` | How many threads the switcher holds before the oldest falls off the end; raise it for a longer archive — *A 512KB localStorage ceiling in history.js trims underneath it, so this is a cap and not a guarantee* |
| [`history.exportThread`](#history-exportthread) | `boolean` | `true` | Adds a header button that copies the whole conversation as Markdown, with sources per `citations.inCopy` — *not gated on `history.enabled` — the live thread still exports* |
| [`history.saveOnUnload`](#history-saveonunload) | `boolean` | `true` | Writes an unfinished turn down when the page goes away, so a reload keeps what had already streamed — *the one write that happens mid-stream, and it obeys `history.enabled`* |
| [`prompt.show`](#prompt-show-prompt-allowappend) | `boolean` | `false` | `true` publishes the system instruction verbatim in a disclosure the reader can open from the composer row — *off also forces `allowAppend` off and clears any addendum the reader saved* |
| [`prompt.allowAppend`](#prompt-show-prompt-allowappend) | `boolean` | `false` | Lets a reader add a standing line of their own for the session; it rides as a separate user message, never in the system prompt — *ignored unless `prompt.show` is true and `appendMaxChars` is non-zero* |
| [`prompt.appendMaxChars`](#prompt-appendmaxchars) | `number` | `500` | Caps that reader line as a `maxlength` on the field, so the limit shows before it bites; `0` switches appending off — *the field only — what is sent is clamped at a hard-coded 500 in prompt.js* |
| [`prompt.override`](#prompt-override-prompt-extend) | `string \| null` | `null` | Replaces the shipped system instruction outright with text you wrote in full — `{product}` is not interpolated into it — *losing the shipped citation and confidence-0 rules refuses every turn; re-run `npx docpilot calibrate`* |
| [`prompt.extend`](#prompt-override-prompt-extend) | `string` | `''` | Appended to whichever instruction is in force, shipped or overridden, for house rules short of a full rewrite |
| [`ui.trigger`](#ui-trigger) | `UiTriggerWord \| UiTrigger[]` | `'fab'` | Picks which of the three placements show an open button; `'nav'` moves it into your navigation bar, `'both'` gives all three, `'none'` leaves only the hotkey — *as a word `'nav'` means the navbar button and its mobile row — `['nav']` is the desktop button alone* |
| [`ui.panel`](#ui-panel) | `'auto' \| 'drawer' \| 'popup'` | `'auto'` | Shape the answer opens in — `'drawer'` full height at the trailing edge, `'popup'` floating above the button — *`'auto'` resolves to `'popup'` whenever `fab` is in the trigger list, even alongside `nav`* |
| [`ui.fabLabel`](#ui-fablabel-ui-fabicon) | `true \| false \| string` | `true` | Words on the floating button: `true` takes the i18n string, a string is used verbatim, `false` leaves the icon alone — *floating placement only, and a blank or whitespace string counts as `false`* |
| [`ui.fabIcon`](#ui-fablabel-ui-fabicon) | `boolean` | `true` | Drops the sparkle glyph from the floating button when `false`, leaving the label as the whole control — *floating placement only, and `false` is overruled when `fabLabel` is `false` too* |
| [`ui.layout`](#ui-layout) | `'overlay' \| 'push'` | `'overlay'` | How the panel treats the page beneath it — `'push'` pads the content aside so docs and answer sit side by side — *does nothing below 960px, where the panel is already edge to edge* |
| [`ui.prefetch`](#ui-prefetch) | `'hover' \| 'idle' \| false` | `'hover'` | When the retrieval index is downloaded — `'idle'` pays up front, `false` waits until the panel is opened — *skipped entirely when the browser reports `saveData` or a 2G-class connection* |
| [`ui.firstRunHint`](#ui-firstrunhint) | `boolean` | `false` | Shows one dismissible line on a first visit, naming the gesture nobody discovers: selecting a passage to ask about it — *withheld when both `quote` switches are off* |
| [`ui.waitingEscalation`](#ui-waitingescalation) | `boolean` | `true` | Escalates the status line at 8s and 25s while nothing has arrived, so a silent provider is not indistinguishable from a broken panel — *neither step names a cause or promises a retry* |
| [`ui.background`](#ui-background) | `'notify' \| 'open' \| false` | `'notify'` | Whether a turn outlives the panel it was asked in — `'notify'` marks the trigger with a dot when it settles, `'open'` brings the panel back with the answer in place — *`false` abandons it on close; the composer's Stop always ends a turn regardless* |
| [`ui.credit`](#ui-credit) | `boolean` | `true` | One word at the end of the footnote — `DocPilot`, linked to the project — so a reader can find out what answered them — *`false` removes it; the disclaimer beside it is not affected* |
| [`ui.theme`](#ui-theme) | `'auto' \| 'light' \| 'dark' \| 'system'` | `'auto'` | Which colour scheme the panel wears — `'auto'` follows the page, `'light'` and `'dark'` pin it against both your site's toggle and the reader's OS — *a pinned panel wears DocPilot's own palette, not your site's, because a host has no dark value to read while it is in light mode* |
| [`ui.font`](#ui-font-ui-fontmono) | `string \| false \| null` | `null` | The panel's face, for a site it cannot inherit one from — a family list, or the name of the custom property your site already keeps it in — *unset the panel wears the page's own font; a value here outranks a host adapter's mapping* |
| [`ui.fontMono`](#ui-font-ui-fontmono) | `string \| false \| null` | `null` | The same for code blocks, the reasoning trace and the prompt disclosure — *unset they keep a system monospace stack, because a page has no monospace to inherit* |
| [`host.base`](#host-base) | `string \| null` | `null` | Path the site is served from, e.g. `/docs/` for a subdirectory install — neutral fallback `/` — *applied only at the index fetch and citation navigation — manifest paths and answer hrefs stay base-less* |
| [`host.ragBase`](#host-ragbase) | `string \| null` | `null` | Where the built index is served from — set it when the index lives on a CDN or a separate origin — *unset resolves to `${host.base}rag`, not to nothing* |
| [`host.article`](#host-article) | `string \| null` | `null` | Bounds the selection-to-quote offer to real documentation text — falls back to the binding's selector, then `main` |
| [`host.search`](#host-search) | `string \| false \| null` | `null` | Selector for the host's own search button, offered as the thing to do instead in degraded and error states — *no neutral fallback — nothing renders without a selector, and `false` suppresses one the binding supplies* |
| [`host.content`](#host-content) | `string \| null` | `null` | Focus target when the panel closes and the control that opened it is gone — the binding's selector, else `main` |
| [`i18n`](#i18n) | `I18nSettings` | `{ translations: {}, locales: {} }` | Replaces reader-facing strings one at a time, globally through `translations` or per language through `locales` — *only `reply.*` ships translated — the rest of the chrome stays English until you override it* |

<!-- /PARAMETERS TABLE -->

Five settings are **server-only** and never reach the browser; three keys are
**unions** whose off form is a single word rather than an object. Both are marked
in the table and explained under [What reaches the browser](#what-reaches-the-browser)
and in each key's own section.

## enabled

- **Type:** `boolean`
- **Default:** `true`

`false` mounts nothing. The site builds as if the package were absent.

## product

- **Type:** `string | null`
- **Default:** `null`
- **Related:** [`i18n`](#i18n)

What the corpus is about, in the reader's words. The one brand-shaped string this
package has, and the one setting that matters more on a site that is not a
documentation site: "this documentation" is a correct default for docs and a
wrong one on a pricing page.

```js
product: 'Acme Editor'
```

It reaches three places: the system instruction (`You answer questions about …`),
the composer placeholder, and the assistant's own introduction when a reader says
hello. Null renders as "this documentation" in every one of them.

It is deliberately **not** part of `i18n`: two locales disagreeing about a
product's name is a defect with no upside, and this value also reaches the system
message, which is build-time and untranslatable by design.

Setting it changes what is sent, so it moves `promptHash` and every eval report is
filed under a new name. That is correct — see
[Calibration and evaluation](/guide/evaluation).

## docsDir

- **Type:** `string`
- **Default:** `'docs'`

Where the VitePress site lives, relative to the project root.

## indexDir

- **Type:** `string | null`
- **Default:** `null` — meaning `${docsDir}/public/rag`

Set it only if you moved the index — or if you keep more than one, which is the other reason it exists. `npx docpilot index` writes an index built with an embedder this config does not name into a directory of its own by default, and prints the two lines you paste here to point the panel at it. See [Building the index](/guide/indexing).

## evalDir

- **Type:** `string`
- **Default:** `'docpilot'`
- **Related:** [Calibration and evaluation](/guide/evaluation)

Where the golden set, the calibration set and the reports live.

## importDir

- **Type:** `string | null`
- **Default:** `null`
- **Related:** [`sources`](#sources), [Imported pages](/guide/imported-pages)

A second corpus root for pages that are indexed but have no route. Off by
default.

```js
importDir: 'knowledge-base'
```

Point it at a directory **outside** `docsDir` and VitePress never sees it: no
route is built, nothing enters the sidebar, the sitemap or llms.txt, and the copy
cannot compete with the original in search. What those pages get instead is a
mandatory frontmatter `source:`, which is the only address their citation can
point at.

## sources

- **Type:** `{ allow: string[] } | null`
- **Default:** `null`
- **Related:** [`importDir`](#importdir)

The list of origins a page may name in its frontmatter `source:`.

```js
sources: {
  allow: [
    'https://example.com',
    'https://example.com/blog',   // that prefix and nothing else on the host
  ],
}
```

A `source:` outside the list **fails the build**, and so does a non-https one —
this value becomes an `href` inside the answer panel, so markdown is never
trusted with a URL scheme. A path narrows the origin at a segment boundary.

`sources` is assigned whole, never merged: a half-merged allowlist is one whose
contents nobody wrote.

## openapi

- **Type:** `string[] | null`
- **Default:** `null` — `${docsDir}/public/openapi`
- **Related:** [`docsDir`](#docsdir)

Where your OpenAPI specs live. Each one is chunked per operation and claims the
route `/reference/<basename>`, which is the behaviour that predates this setting;
what the setting adds is the ability to leave the file where it already is.

```js
openapi: ['api/openapi.yaml']       // one file
openapi: ['api']                    // every .yaml and .yml in a directory
openapi: ['specs/v*.yaml']          // a name pattern
openapi: ['api', 'partners/api.yaml']
```

`*` is the only metacharacter and it matches inside the **file name** only — a
`*` in a directory segment stops the build rather than quietly matching nothing,
because a spec that was configured and never indexed leaves a documented
`/reference/` route with nothing behind it. A path you wrote that does not exist
stops the build for the same reason; the default directory is allowed to be
absent, because most projects publish no spec at all.

Chunking a spec needs a parser, which is an optional dependency —
`npm i -D @scalar/openapi-parser`.

## chat

- **Type:** `object | false | 'none'`
- **Default:** `{ provider: 'auto', chain: 'auto', model: null, baseURL: null, models: null, temperature: 0.2, maxTokens: 2048, numCtx: 8192, reasoning: 'auto', verbosity: null, topP: null, seed: null }`
- **Related:** [`chat: false`](#chat-false), [`embed`](#embed), [Choosing providers](/guide/providers)

The model that answers, or [`false`](#chat-false) for no model at all.

```js
chat: {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 2048,
  numCtx: 8192,
}
```

### chat.provider

Any id from [Choosing providers](/guide/providers), or `'auto'` — the default,
which is also what leaving the key out means. A misspelling stops the build
rather than quietly becoming a local Ollama nobody is running.

`'auto'` reads the environment. It walks [the provider chain](#the-provider-chain)
and takes the first service a key is set for; an id you write down is never
overridden, whatever the environment holds.

### The provider chain

The whole of *install the package, put a key in the environment, done*.

Before it, the environment could only ever confirm a choice you had already
made: the resolver went from `chat.provider` to the name of that provider's key,
never the other way. A project with `OPENAI_API_KEY` in `.env.local` and no
`chat` block resolved to the shipped default — a local Ollama — and spent every
question on a connection refused. The key was read, found, and ignored.

`chat.provider: 'auto'` walks this list in order and stops at the first member
the environment selects:

| # | id | Selected by | Embeds? | Model when you name none |
|---|---|---|---|---|
| 1 | `openai` | `OPENAI_API_KEY` | yes | `gpt-4o-mini` |
| 2 | `gemini` | `GEMINI_API_KEY` | yes | `gemini-2.5-flash` |
| 3 | `mistral` | `MISTRAL_API_KEY` | yes | `mistral-small-latest` |
| 4 | `together` | `TOGETHER_API_KEY` | yes | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| 5 | `fireworks` | `FIREWORKS_API_KEY` | yes | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| 6 | `nebius` | `NEBIUS_API_KEY` | yes | `meta-llama/Llama-3.3-70B-Instruct` |
| 7 | `openrouter` | `OPENROUTER_API_KEY` | yes | *the free pool* |
| 8 | `anthropic` | `ANTHROPIC_API_KEY` | no | `claude-sonnet-4-6` |
| 9 | `groq` | `GROQ_API_KEY` | no | `llama-3.3-70b-versatile` |
| 10 | `deepseek` | `DEEPSEEK_API_KEY` | no | `deepseek-v4-flash` |
| 11 | `xai` | `XAI_API_KEY` | no | `grok-4` |
| 12 | `cerebras` | `CEREBRAS_API_KEY` | no | `llama-3.3-70b` |
| 13 | `custom` | `CUSTOM_BASE_URL` *(`CUSTOM_API_KEY` authorises, and does not select)* | yes | — *you name it* |
| 14 | `llamacpp` | `LLAMACPP_BASE_URL` | yes | `local` |
| 15 | `ollama` | `OLLAMA_BASE_URL` | yes | `qwen3:8b` |
| — | **nothing matched** | → `openrouter`, free tier | yes | *the free pool* |

**Providers that embed come first, and that is the whole ordering argument** —
not a ranking of answer quality. One key covering both halves is the difference
between a working install and a second decision. A chat provider with no
embeddings endpoint sends [`embed: 'auto'`](#embed) to OpenRouter's free pool,
which needs a *second* key and posts the text of your whole corpus to a third
party at build time. That is a fine thing to choose and a poor thing to be
defaulted into.

**The self-hosted tail is selected by address, not by key.** A local server has
no credential to be found by, so `LLAMACPP_BASE_URL` and `OLLAMA_BASE_URL` do
both jobs: setting one selects that provider, and its value is where requests go.
`OLLAMA_BASE_URL=http://localhost:11434` says *the usual one*;
`http://gpu.internal:11434` says where instead.

**An environment that selects nothing falls through to OpenRouter's free tier.**
That is the last row, and it is not a list entry — it is what happens when the
list matches nothing. It used to be the local Ollama, which closed the list and
needed nothing to be selected by, so every unconfigured build landed there: right
for a laptop running one, a connection refused everywhere else, and
indistinguishable from inside a build that makes no network calls. OpenRouter is
what a fall-through should reach instead, because its remaining setup is a single
free key — no model to choose on either half, no card, both halves covered — so
the build prints one instruction rather than producing a silent outage:

```
[docpilot] the panel is OFF — 2 things to set up:

  · chat and embed: "openrouter" needs a key and none is set
      export OPENROUTER_API_KEY=…
  · no index at docs/public/rag
      npx docpilot index
```

**Nothing here touches the network.** A config file is read synchronously at
build time, and a resolver that reached out to decide what a default means would
be a build that fails offline and answers differently on two machines. Whether
the chosen provider is actually *reachable* is a different question, and `npx
docpilot doctor` is where it is asked.

The build says which member answered, and only when the environment chose:

```
[docpilot] chain  auto → openai
[docpilot]        openai ✓ · gemini — · mistral — · together — · … · ollama ✓
```

To stop the chain being consulted at all, name the provider:

```js
chat: { provider: 'ollama' }   // whatever the environment holds
```

`OLLAMA_BASE_URL` still moves a named `ollama` — pinning *which* provider and
saying *where* it is are two different statements, and a project that pinned the
local one still deserves to relocate it without editing a config file. Your own
`chat.baseURL` outranks both.

### chat.model

The name the provider knows the model by. `null` — the default — takes **that
provider's** own default, listed in the table above and in
[Choosing providers](/guide/providers).

A model name never crosses providers. `qwen3:8b` is a statement about Ollama and
`gpt-4o-mini` is one about OpenAI, so each lives on its provider's row rather
than as a single shipped value that the next provider inherits — which is what
used to happen, and what used to make `chat: { provider: 'openai' }` a
build-stopping error for want of a name everybody could guess.

Two providers still have no default, for two different reasons:

- `openrouter` falls back to its **free pool** (see `chat.models` below), because
  a shared free tier is a list rather than a model.
- `custom` stops the build, because it names a *host* and not a service — there
  is no catalogue for this package to have an opinion about.

**These names are defaults, not guarantees.** Catalogues change. A wrong one
fails loudly on the first request rather than silently at runtime, and
`npx docpilot doctor --models` is the check that does not need a reader to hit it
first.

`'auto'` and `'free'` mean the same as leaving the key out, and are normalised to
that before anything reads them — neither is ever sent as a model name.

### chat.baseURL

- **Type:** `string | null`
- **Default:** `null` — the provider's own address

Where the service is, for one that is somewhere of your own — `ollama`,
`llamacpp` and `custom`, the three ids that name a HOST rather than a service.

The same three take an address from the environment, which is also what selects
them — see [the provider chain](#the-provider-chain):

```bash
OLLAMA_BASE_URL=http://gpu.internal:11434
LLAMACPP_BASE_URL=http://gpu.internal:8080
CUSTOM_BASE_URL=https://gateway.internal
```

**A value written here outranks all of them**, and `null` takes whichever of
them is set — or the shipped port when none is.

**Which end reads it depends on whether the member has a route.** `ollama` has
none, so the BROWSER calls that address itself; `llamacpp` and `custom` do, so
it is what your proxy posts to and the browser reaches them same-origin like
everything else. `npx docpilot doctor --proxy` prints the resolved upstream, and
it is the only copy of it that cannot go stale.

**Naming it beside a branded provider stops the build.** That service has an
address of its own, and rerouting it on the strength of one line is a surprise
nobody asked for. `custom` is the id for a host of your own that copied
somebody's API:

```js
chat: { provider: 'custom', baseURL: 'https://gateway.internal', model: 'qwen3-8b' }
```

A member of [`chat.chain`](#chat-chain) takes the same key on the same terms,
which is how a deployment reaches two of them at two addresses.

### chat.models

- **Type:** `string[] | null`
- **Default:** `null`

An **ordered fallback pool**. The transport tries the first, and moves to the
next on a rate limit, a retired id, a moderation refusal, a 5xx, or a 200 that
carries no answer at all. The model that answers is remembered and tried first
next time; the ones that refused are set aside for a minute.

It exists for **shared free tiers**, where a `429` says how many other people are
asking rather than anything about the model — so pinning one free id buys a panel
that works until somebody else's traffic arrives. It is `null` everywhere else on
purpose: on a provider that bills per token, silently moving to another model
changes what a turn costs without being asked.

```js
// the shipped free pool — nothing to write
chat: { provider: 'openrouter' }

// a paid primary with free understudies
chat: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6', models: ['openrouter/free'] }

// your own order, nothing else
chat: { provider: 'openrouter', models: ['openai/gpt-oss-20b:free', 'google/gemma-4-31b-it:free'] }
```

Four failures never rotate, because asking the next model would be worse than
stopping: the reader pressed stop; an answer has already started painting on
screen; a 401, since a rejected key rejects every model in the pool and rotating
turns one clear message into ten pointless requests; and the **day's** limit
rather than the minute's, which belongs to the account and refuses every
candidate behind it identically.

Nor does it rotate once the turn has no requests left to spend — see
[`budget.rotateAbove`](#budget-oneshotbelow-budget-rotateabove). Rotation buys a
better answer with a request that would have answered the next question, and
that is a trade only a comfortable budget can make.

#### It does not stop the chain

**A list here is a list of MODELS, and it says nothing about which services may
answer.** When it runs out, [`chat.chain`](#chat-chain) asks the next provider —
with that provider's own model, because a model id never crosses providers.

```js
// two keys in the environment, and this is a two-provider deployment
chat: { models: ['gpt-4.1', 'gpt-4o'] }
// → openai [gpt-4.1, gpt-4o] → groq [llama-3.3-70b-versatile]
```

To end the walk at your list, decline provider rotation as well — either by
naming the provider, or with `false`:

```js
chat: { provider: 'openai', models: ['gpt-4.1', 'gpt-4o'] }  // the chain is not consulted
chat: { chain: false, models: ['gpt-4.1', 'gpt-4o'] }        // one provider, chosen once
```

The one thing a written list DOES do to the chain is keep its provider on the
billed rung — see [Billed accounts first](#billed-accounts-first).

### chat.chain

- **Type:** `'auto' | false | Array<ProviderId | ChainMember>`
- **Default:** `'auto'`

**Which services may answer, in order.** It is the provider-level form of the
argument [`chat.models`](#chat-models) already makes about models: a 429, a
retired id or a rejected key is a statement about *one* service, and a
deployment with a second key in its environment should not spend a reader's
question on the first one's bad afternoon.

| value | what answers |
| --- | --- |
| `'auto'` | every member of [the chain](#the-provider-chain) this environment selects, billed accounts first |
| `[…]` | your own set, in the order you wrote it |
| `false` | one provider, chosen once — every deployment that existed before this key |

**An environment with one key resolves to one member**, which is the scalar
configuration this package has always emitted, to the byte — same single proxy
route, same request. `'auto'` changes what happens to an environment holding
*several*: they are all walked, rather than the first one being the only one
tried. It is [rung 1 of the answer ladder](/concepts/the-ladder).

#### Billed accounts first

The [chain table](#the-provider-chain) is ordered by *what one key covers*,
which is the right question for choosing one provider and the wrong one for
ordering a set to walk. So the resolved set sorts into three rungs, keeping the
table's order inside each:

| rung | members |
| --- | --- |
| 1 | every provider billed to your account |
| 2 | a provider's own free catalogue — OpenRouter's [free pool](/guide/free-tier) |
| 3 | a server of your own — `custom`, `llamacpp`, `ollama` |

OpenRouter sits at position 7 of the table and answers *after* `groq` here,
because its allowance is 50 requests a day shared by every reader of the site
and `groq`'s is the account's. A local server answers last: it is the one
nobody but you can reach.

**A model you name keeps its provider billed.** `chat: {model:
'anthropic/claude-sonnet-4'}` beside an OpenRouter key is a paid deployment —
the free catalogue answers only where nothing was named — so naming a model, or
writing your own `chat.models` list, flattens the rungs and the order is the
table's, unchanged. The sort fires exactly where the whole question is *which of
these keys, in what order*, which is the zero-config path.

```js
// your own set — an entry is a provider id, or an object saying what to send it
chat: {
  chain: [
    'openrouter',
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    'cerebras',
    { provider: 'ollama', baseURL: 'http://localhost:11434' },
  ],
}
```

An entry is a provider id, or a `ChainMember`: `{provider, name?, model?,
models?, baseURL?, apiKeyEnv?}`. An entry that names no model falls to that
provider's own default from the table in
[Choosing providers](/guide/providers), or to its free pool where it has one.

#### Two of one service

A member is identified by its **name**, which defaults to the provider id — so
two entries of one service are two members the moment you name them, each with
its own address, its own credential, its own route and its own cooldown:

```js
chat: {
  chain: [
    { name: 'gw-eu', provider: 'custom', baseURL: 'https://eu.gw.internal', apiKeyEnv: 'GW_EU_KEY', model: 'qwen3-8b' },
    { name: 'gw-us', provider: 'custom', baseURL: 'https://us.gw.internal', apiKeyEnv: 'GW_US_KEY', model: 'qwen3-8b' },
    'openrouter',
  ],
}
```

```
/ai/gw-eu/v1/chat/completions       → https://eu.gw.internal   GW_EU_KEY
/ai/gw-us/v1/chat/completions       → https://us.gw.internal   GW_US_KEY
/ai/openrouter/v1/chat/completions  → https://openrouter.ai/api  OPENROUTER_API_KEY
```

- **`name`** goes into a URL and is matched exactly by your proxy, so it is
  lowercase letters, digits and hyphens. **Two members may not share one** —
  a repeat stops the build rather than being deduped in silence.
- **`apiKeyEnv`** is the NAME of an environment variable, never the value: a key
  written in a config file is a key compiled into the browser bundle. Omitted, it
  takes the provider's own variable from the table.
- **`baseURL`** works for `ollama`, `llamacpp` and `custom` — see
  [`chat.baseURL`](#chat-baseurl) — and stops the build beside a branded
  provider, which has an address of its own.

Nothing here moves for a chain that names no member: the name IS the provider id
then, so every path this package has ever emitted is the path it still emits.

**It fires only where [`chat.provider`](#chat-provider) is also `'auto'`.** *A
provider you name is never overridden* predates this key, and naming one is
therefore how provider rotation is declined; `false` declines it without naming
one. An explicit array is the exception — a named provider **leads** it and is
not asked twice.

**`chat.model` and `chat.models` reach the head member and no other.** A model
name never crosses providers: `gpt-4o-mini` posted to Groq is a 404 for a model
nobody typed. Give a later member its own model in the object form.

#### The embed half does not rotate

It cannot. Two embedding models are two vector spaces, so `npx docpilot index`
picks one and writes it into the manifest, and every reader's browser is bound
to that name for the life of the index — see
[An unnamed embedder, and why it does not rotate](#an-unnamed-embedder-and-why-it-does-not-rotate).
The chain is the **answering** half only, and the first member is what
`embed: 'auto'` follows.

#### What it costs in production

One chat route per member, and the paths change shape when a second member
appears:

```
one member    /ai/v1/chat/completions
two or more   /ai/openrouter/v1/chat/completions
              /ai/groq/v1/chat/completions
```

The prefix is not decoration: `openrouter` and `groq` are both the OpenAI
adapter, so both ask for `/ai/v1/chat/completions` and would collide on one
path. A single member — the shipped default, and every pinned provider — keeps
the bare path this package has always emitted, so no reverse proxy breaks on
upgrade.

`npx docpilot doctor --proxy` prints the routes for **your** configuration,
which is the only copy of them that cannot go stale. Read it again when the
environment changes: with `chain: 'auto'`, a second key in `.env` changes the
*number* of routes, not only the upstream. See [Production](/guide/production).

#### Members a deployed proxy cannot reach

`ollama`, `llamacpp` and `custom` are addresses rather than accounts, and the
contract says so rather than leaving it to be discovered in production:

- **`ollama` gets no route at all** — the browser calls it directly, at its own
  address. That works on the machine running it and nowhere else: an https page
  cannot fetch `http://localhost`, and Ollama sends no CORS headers.
- **`llamacpp` and `custom` get a route**, and it is marked `LOCAL ADDRESS`
  when it resolves to a loopback or private host. A proxy can serve it only if
  it runs on that host.

Neither is removed from the set. Dropping a member because the build machine
judged its address unreachable would mean the resolver read the network, and
then CI and the laptop beside it would resolve two different configurations.

### chat.preferLocal

- **Type:** `boolean`
- **Default:** `false`

**A server of your own answers first.**

The ladder sorts a resolved set into three rungs — billed accounts, then a
provider's own free catalogue, then `custom`, `llamacpp` and `ollama`. This puts
the third rung at the front instead of the back, and makes an environment that
selects nothing fall through to a local Ollama rather than to
[OpenRouter's free tier](/guide/free-tier).

```js
chat: { preferLocal: true }
```

```bash
OLLAMA_BASE_URL=http://localhost:11434
```

**It reorders; it never selects.** A local server is still reached by its
address, because that is the only thing a build can know about it — from inside
this process a laptop running Ollama and a CI box that has never heard of one
are the same environment, which is why
[naming no provider stopped resolving to a local Ollama](#the-provider-chain) in
the first place. Writing this key is not a guess; inferring it would be. So the
one case it selects anything is the fall-through, where there is nothing to
select and the author has said which way to fall.

**`npx docpilot doctor` says when it moved nothing.** Setting it without setting
an address resolves exactly as it would have without it, and the panel then
works — off whatever cloud key is around — with nothing looking wrong. That is
the failure mode this key would otherwise reintroduce, so it is reported rather
than left to be discovered.

**To pin a local server rather than merely prefer it**, name it:

```js
chat: { provider: 'ollama' }   // the chain is not consulted at all
```

### chat.temperature, chat.maxTokens

`temperature` is 0.2 because this is documentation, not prose: the same question
asked twice should not produce two different sets of steps. `maxTokens` caps one
answer; the panel's own composer caps a question at a thousand characters, and
the two are unrelated ceilings.

### chat.numCtx

Sent on the Ollama transport only; hosted providers size their own context and
ignore it. Ollama's server default is 4096, and a primed turn plus one tool call
already exceeds that — past which llama.cpp shifts the window and drops the
system block off the front, which surfaces as an unexplained refusal.

### chat.reasoning

- **Type:** `'auto' | false | true | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | object`
- **Default:** `'auto'`
- **Related:** [What each provider honours](/guide/providers#what-each-provider-honours)

How hard the model should think, written once in a vocabulary that is the same
whoever is answering.

```js
chat: { provider: 'openai', reasoning: 'high' }
chat: { provider: 'ollama', reasoning: false }
chat: { provider: 'anthropic', reasoning: { effort: 'high', budgetTokens: 8192 } }
```

`'auto'` is the shipped value and it means *DocPilot decides*: it asks for
reasoning on the final answer and never on a search step, because a step that is
choosing a tool is not composing anything — leaving reasoning on across four of
them was measured at a p50 of 215 seconds. `false` never asks. `true` is the
same as `'medium'`.

**The level is clamped, not posted as written.** No two services publish the same
vocabulary: OpenAI and OpenRouter have six words, xAI has four, DeepSeek has
three and no `medium` at all, and Groq's Qwen models accept `none` and `default`
and nothing else. So the word you write is ranked and the nearest one the
configured service actually accepts is sent, ties going down — `medium` on
DeepSeek is posted as `low`. `npx docpilot doctor` prints the substitution.

The object form takes three keys:

- **`effort`** — one of the six levels above, or `null` to leave the depth to the
  service.
- **`budgetTokens`** — a thinking budget in tokens, for the services that measure
  it that way rather than in levels. Setting it on one that does not stops the
  build and names the alternative.
- **`visible`** — `false` asks the service to think without sending the trace
  back. That is a genuinely different request from not thinking: the model
  reasons, and the panel — which is not showing the box — pays for less output.
  Two providers can spell it; the rest ignore it.

A model with no thinking capability is never asked, whatever is written here:
capability beats preference, and on Ollama the capability is one this package can
read from the server rather than guess.

### chat.verbosity

- **Type:** `'low' | 'medium' | 'high' | null`
- **Default:** `null`

A soft ceiling on how long the answer should be, where [`chat.maxTokens`](#chat-temperature-chat-maxtokens)
is the hard one — the difference between asking for a shorter reply and cutting
one off mid-sentence.

Two providers in the table accept the field. **Naming it beside any other stops
the build**, by name, rather than being dropped in silence on the way out:

```
[docpilot] chat.verbosity is set to "low", and "anthropic" does not
  accept it — the field belongs to OpenAI's chat-completions surface.
  Drop the key, or say it yourself with chat.extraBody if you know better.
```

### chat.topP, chat.seed

- **Type:** `number | null`
- **Default:** `null` for both

Nucleus sampling, and the seed that pins it. Both are sent only when set, so a
configuration that names neither posts exactly the body it always posted.

`seed` is the stronger form of the argument [`chat.temperature: 0.2`](#chat-temperature-chat-maxtokens)
already makes: the same question asked twice should not produce two different
sets of steps.

Neither reaches Anthropic — that API has no `seed` parameter at all, and its
sampling parameters are version-gated to the point where the only value newer
models accept is the one this package is trying to move away from. Setting either
there stops the build rather than being ignored.

**`chat.stop` is deliberately not a setting.** Every reply this package asks for
has a pinned shape — a strict JSON schema, a JSON object, or a forced tool call —
and a stop sequence that fires inside one truncates the object mid-write. The
result is indistinguishable from a model that ran out of tokens, which is the one
failure the continuation path exists to tell apart. If you need one anyway, it is
one line of [`chat.extraBody`](#chat-extrabody).

### chat.extraBody

- **Type:** `object | null`
- **Default:** the provider's own fragment — `{ provider: { require_parameters: true } }`
  on `openrouter`, nothing anywhere else

Fields merged into the body of every chat request, for the things one brand
understands and the transport does not. The transport knows adapters, not
vendors, so this is the one place a brand's own body field is named.

**On OpenRouter it defaults to `provider.require_parameters`, and that is a
defect fix rather than a preference.** OpenRouter picks an upstream for each
request, and an upstream that does not honour `response_format` is sent the
request anyway with the strict answer schema silently dropped. Six of the ten
free chat models measured against this corpus then answered the final call with
prose. A well-formed reply is a spent request, the parse fails, and the reader is
shown *I couldn't find this in the docs* for a question the model in fact
answered. `require_parameters` says: route this only to an upstream that actually
honours the parameters I sent.

It narrows routing, though — a model served by one strict upstream and three
loose ones has fewer places to go, and on a bad day that is a *no provider
available* where there would have been an answer. So it is declinable. Whatever
you write **replaces** the provider's fragment entirely, including `null`:

```js
// widest routing OpenRouter offers, prose replies and all
chat: { provider: 'openrouter', extraBody: null }

// your own fragment in place of the shipped one
chat: {
  provider: 'openrouter',
  extraBody: { provider: { require_parameters: true, sort: 'throughput' } },
}
```

Leave the key out and you get the provider's fragment. The merge is at the top
level of the request body and happens **before** the fields the adapter owns, so
`model`, `messages` and `response_format` can never be overwritten from
configuration. The same fragment reaches `docpilot import`'s annotation pass, so
the CLI and the panel route the same way — a CLI that silently annotated worse
than the panel is a difference nobody would think to look for.

### chat: false

No model, anywhere — **search-only mode**. A question is scored against the index
exactly as it always was, and what comes back is the ranked passages themselves:
each one an excerpt under a link to the heading it was cut from. No model is
called on any turn, so there is no key to hold, no token to spend and no sentence
that can be wrong. `'none'` is accepted as the same value spelled out.

```js
chat: false
```

Everything before the answer is unchanged. The scope picker narrows the search,
the credential check still settles a pasted key locally, a greeting is still
answered as a greeting, and the calibrated gate still runs.

**What the gate does here is different, and deliberately so.** On an answering
site a failed gate ends the turn — because a model asked to write from weak
evidence produces something plausible and wrong, and the reader cannot tell.
Nothing is generated in this mode, so there is nothing to be wrong about: the
rows are shown either way, and the verdict only chooses the sentence above them.
A question the corpus does not cover reads *Nothing matches this closely in the
docs. The nearest passages:* rather than a refusal, and a question whose answer
sits outside the reader's scope still offers the one-click widen.

What it buys:

| | |
|---|---|
| `chat: false` | no answering key, no per-question cost, no daily allowance to ration |
| `chat: false` **and** [`embed: false`](#embed-false) | no provider key at all, and no outbound request of any kind after the page loads — the index is static files and retrieval runs in the browser |

An embedder is still worth having if you can reach one: `chat: false` with
`embed` left alone ranks on the hybrid channel, which is the same retrieval an
answering site gets. The corpus is then still posted to the embedding service at
**build** time, once per `npx docpilot index`, and `npx docpilot doctor` says so
— switching the model off is not by itself a deployment that sends nothing
anywhere.

`npx docpilot doctor` prints `chat none — search-only` in place of the provider
line, and asks for no chat route in `--proxy`.

## embed

- **Type:** `'auto' | false | 'none' | { provider?: string, model?: string, baseURL?: string }`
- **Default:** `'auto'` — follow `chat.provider`
- **Related:** [`chat`](#chat), [Building the index](/guide/indexing)

The model that embeds, for the index and for every query. `false` is the third
form and means no embedder at all — [see below](#embed-false).

```js
embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' }
```

`model` **must** be the model that built the index. `baseURL` is read only for a
local provider; a hosted embedder goes through the same proxy the chat does.

**Naming the provider and not the model is a complete sentence.** The provider's
own default is used — the same table row `chat.model` reads — and then
`npx docpilot index` asks the service what it actually serves and lines those
candidates up behind it. See [Asking the provider](#asking-the-provider).

```js
embed: { provider: 'openai' }   // → text-embedding-3-small, or whatever openai serves
```

`'auto'` on a chat provider with no embeddings endpoint — `anthropic`,
`deepseek`, `groq`, `xai`, `cerebras` — **borrows OpenRouter's free embedding
pool** rather than stopping the build. Set `OPENROUTER_API_KEY`; the borrow is
named in the startup block and in `npx docpilot doctor`, because it means the
text of every chunk is posted to OpenRouter at build time. Naming `embed`
explicitly is never rewritten — and naming a provider that cannot embed still
stops the build.

The choice does not read the environment: a machine without the key resolves the
same embedder as the one that built the index, so the two cannot disagree about
which vector space the index is in. A missing key is reported as a missing key.

### Asking the provider

`npx docpilot index` does not simply trust the name in the table. When the model
was **not written down by you** — you named a provider and stopped, or you named
neither — the build asks the service which embedding models it serves and walks
the answers in order, starting with the configured name.

```
  embedders 2 to try — custom offers 1, and BAAI/bge-m3 is configured
  warn  BAAI/bge-m3 is not answering (HTTP 404); trying the next embedder
  embedder  acme/gte-large-v2 · 1024d — chosen from 2 candidate(s)
```

Three reasons it exists, all the same defect:

- **`custom` and `llamacpp` name a host, not a service.** `BAAI/bge-m3` and
  `local` are this package guessing what you loaded onto your own gateway.
- **Catalogue names age.** The table above says of itself that its names are
  defaults rather than guarantees, and a stale one used to mean the build dying
  on its first chunk with a 404 naming a model you never typed.
- **A provider named without a model** used to stop the build on the embed half
  while the same shape was a complete sentence on the chat half.

**A name you wrote is never walked past.** `embed: {provider: 'x', model: 'y'}`
is a sentence: it is used as given, no catalogue is read, and a wrong one fails
loudly rather than being quietly replaced with something this package preferred.

**Discovery changes the model, never the provider.** The reverse proxy that
carries `/ai/v1/embeddings` is written from your config at build time,
synchronously, with no network — so a build that moved itself to another service
mid-flight would leave every reader's query vector posted to the wrong upstream.
Where a chat-only provider turns out to serve embeddings after all,
[`npx docpilot doctor --models`](/reference/cli#doctor) says so and you write the
one line.

It costs at most one extra request per build, and none at all when you named the
model or when a free pool already stands behind the provider.

### An unnamed embedder, and why it does not rotate

`model` may be **left out** on a provider with a free embedding pool —
`openrouter` today. `npx docpilot index` then walks the pool, embeds with the
first one that answers, and writes that name into the manifest. The browser reads
it from there, so the query vector and the chunks always come from one model.

**The browser never reconsiders that choice.** Two embedding models are two
vector spaces: a query embedded by the understudy scores numbers against these
chunks that look like similarities and are not, and every guardrail downstream —
the width check in the retriever, the calibrated gate — reads them as real. So a
busy embedder at query time is retried, and then retrieval drops to lexical-only,
which is a mode the panel already knows how to report. Rotation is a **build**
decision only.

If the chosen embedder dies mid-build, the index restarts on the next one and
discards what it had collected. One index, one vector space.

An index whose manifest names a model **outside** the pool now in force — switch
`chat.provider` from `ollama` to `anthropic` and the embedder moves without the
index moving — is reported by `readiness` and `npx docpilot doctor` as a rebuild,
not left to fail as a 404 per question.

`npx docpilot doctor --models` compares the pool this package shipped with
against the provider's live catalogue and names any id that has been retired. It
is the only thing in `doctor` that touches the network, which is why it is a flag
rather than a default.

### embed: false

No embedder, anywhere. `npx docpilot index` writes an index with no vectors in
it, the browser fetches no vector blob and embeds no query, and every question is
retrieved on the BM25 channel alone. `'none'` is accepted as the same value
spelled out.

```js
embed: false
```

**It costs most of the recall, and the cost was measured** — on a 1191-chunk
corpus, recall@8 fell from 0.97 to 0.41, retrieval F1 from 0.35 to 0.18, and 11
of 44 answerable questions were refused outright. Those are one corpus's numbers.
`npx docpilot eval --gate-only --lexical` reports yours, against the index you
already have and the golden set you wrote for it, which is the measurement to
take before building one without vectors.

The lexical channel also scores **zero** for a question asked in a language your
corpus is not written in: there is no overlap to count. For a multilingual
audience this is not a trade-off, it is a mode that answers one language and
refuses the rest.

What it buys is a build that makes no embedding calls, one key instead of two, no
corpus posted to an embedding service, and a vector blob — 2 KB per chunk on a
2048-dimensional embedder — that is neither written nor downloaded.

It is a **declared mode, not the degradation of the same name**. Nothing is
retried, nothing is written to the console, and no refusal tells the reader the
search was degraded, because nothing failed. See
[No embedder at all](/guide/providers#no-embedder-at-all) for telling the two
apart in a browser.

`chat` is still required, and no embedding key is.
`npx docpilot index --no-embed` builds one vectorless index without touching the
config, which is the shape for trying it; the key is what a deployment sets,
because the browser has to be told as well.
`npx docpilot doctor` names either disagreement, and they are not symmetric.
An index carrying vectors that `embed: false` will never read is a **note**: the
site ships bytes no reader will use, and the panel works. A vectorless index
under a named embedder is a **failure**: the deployment would embed every
question and have nothing to score it against, so `readiness` refuses it and the
build emits `{enabled: false}` — the panel is not rendered at all. That is the
one to know about if you reach for `--no-embed` on its own: the flag alone
switches the panel off until the config says `embed: false` too, or declares
[`embed.fallback: 'lexical'`](#embed-fallback).

### embed.fallback

- **Type:** `'lexical'`
- **Default:** absent — the build dies when the embedder will not answer

What to do when the embedder you named refuses. It rides on any of the arms
above, including the automatic one:

```js
embed: { fallback: 'lexical' }                          // 'auto', plus a fallback
embed: { provider: 'openrouter', fallback: 'lexical' }  // an explicit split, plus one
```

**Absent is the right default.** `npx docpilot index` dies, loudly, and you still
have the index you had. An index quietly missing its vectors is a site whose
retrieval got materially worse with nothing said, and the build is the only
moment anyone is looking.

`'lexical'` prefers a vectorless index to no index. It is not a new mode — it is
[`embed: false`](#embed-false), reached by refusal rather than by declaration —
so everything that mode already does applies: no vector blob, BM25 over the chunk
text, and the panel's own *No embedding model — search matches words only* line
under the composer, which is how the reader learns this is not the retrieval the
site usually gives. `readiness` reports it as a **note** rather than a failure,
because the deployment is running exactly the mode it declared for this case.

The build says what it cost, at the moment it costs it:

```
  FELL BACK  no embedder answered, and embed.fallback is "lexical".
             This index ships WITHOUT VECTORS: retrieval is BM25 over the
             chunk text alone.
```

**Read the numbers before you set it.** Measured on a 1191-chunk corpus:
recall@8 0.97 → 0.41, retrieval F1 0.35 → 0.18, 11 of 44 answerable questions
refused outright, and a question asked in a language the corpus is not written in
scores zero. Reproduce with `npx docpilot eval --gate-only --lexical`. A
regression that size arriving because somebody else's free tier was busy has to
be a decision, which is why this is opt-in and why the build shouts.

Rebuild when the embedder is answering again; nothing about the fallback is
sticky.

**A second embedder is deliberately not offered here.** The index and every query
must land in one vector space — see [why it does not rotate](#embed) — so a
second embedder is a second index, and its address would have to reach every
reader's browser. `'lexical'` needs no address, because there is nothing left to
call.

## topK

- **Type:** `number | null`
- **Default:** `null` — whatever this corpus measured
- **Related:** [`docpilot tune`](/reference/cli#tune), [`guard`](#guard)

How many excerpts the gate hands the model to open a turn with — the retriever's
`GATE_K` under its documented name, and the k every retrieval number in an eval
report is measured at.

**Nothing read this key until now.** It was documented from the first release
with a default of `12`, and no code anywhere looked at it: the gate's k was a
literal in `retriever.js` — `5` — so `5` is what every site has been retrieving
with, whatever this key said, while the build's own startup line printed the
number from here as though it were in force. It is wired up now, and its default
is `null` rather than a number, because no single number is right for every
corpus.

`null` means **use what this corpus measured**. `npx docpilot tune` sweeps the k
against your golden set and writes the winner to `${evalDir}/tuning.json`;
`npx docpilot index` validates that file and inlines it into the manifest; the
browser reads it from there. With no tuning in the manifest, `null` resolves to
the package's own `5` — exactly what every build shipped before this key woke
up, so leaving it alone changes nothing.

A **number** is you overriding that measurement by hand, on the same terms as a
hand-set [`guard.tau`](#guard-tau-guard-taulexical): it wins over the manifest,
it is rounded to an integer and clamped to **1..12** — below 1 the gate hands
over nothing and the model answers from the question alone; above 12 it is asking
the fusion for candidates it never produced, since the fused pool is 12 — and it
stamps `source: 'config'` where the manifest's `'tuned'` would have been, which
is what makes an author's k visible in a report rather than invisible in
behaviour. Only the k moves: an `MMR_LAMBDA` the sweep measured on your corpus
stays measured. A value that is not a number is not reported anywhere; it falls
through to the manifest as though the key were absent.

The whole precedence is one rule with one implementation: a `DOCPILOT_GATE_K` in
the shell you are sweeping from, then this key, then `manifest.tuning`, then the
package default.

**The model's own k is a different number.** `search_docs` takes a k as a tool
argument and that one is clamped `1..8` independently of this setting, so a
`topK` above 8 widens only the excerpts the turn is *primed* with — the model
cannot reach a k of 10 by asking for it. Read a win above 8 as a first-turn win.

### If your config already sets topK

Then it has been setting a value nothing read, and on upgrade it starts moving
retrieval for the first time. Two things before deploying it:

**Check which layer is in force.** The build says so on startup:

```
[docpilot] turn   topK 12 (config) · maxIterations 2 · temperature 0.2
[docpilot] turn   topK tuned (manifest) · maxIterations 2 · temperature 0.2
```

The first line is the key doing something; the second is `null` letting the
measurement through. Before this the line printed a bare number, which was the
same fiction the key was.

**Measure the number rather than keeping it.** `npx docpilot tune` sweeps
λ × k against your golden set on pure retrieval metrics — no chat calls, no
judge — and writes the grid out beside the winner. A k chosen by taste was
harmless while nothing read it, and is not now.

One thing `topK` does **not** reach: `eval`, `bench`, `calibrate` and `tune` all
retrieve off `manifest.tuning` and never read your config, so a hand-set `topK`
moves the browser and leaves the numbers your eval reports where they were. A k
you mean to keep belongs in `tuning.json` — which is `tune`, and then `index`.

## maxIterations

- **Type:** `number`
- **Default:** `2`

**2, and raising it is more expensive than it looks.** The host primes the turn
with the gate's own excerpts, and every accumulated observation is re-sent on
every step, so the cost of a turn grows with the square of its steps rather than
with the evidence in it. Measured at 2 with an 8192-token context: 5.9k prompt
tokens and 0.7k output per turn.

At 20 the worst case is roughly 138k tokens for a single question — and a local
model with an 8192-token window will have shifted the system instruction out of
context long before reaching it.

## budget

- **Type:** `object | false`
- **Default:** `{ mode: 'auto', oneShotBelow: 15, rotateAbove: 6, maxContinuations: 1, showRemaining: false, probe: 'auto', dailyLimit: null }`

The day's **requests**, which is a different scarcity from the tokens
[`maxIterations`](#maxiterations) argues about. OpenRouter's free tier caps at
50 requests a day while the models behind it offer 128k–512k of context, so a
turn costing three or four of them — the capability probe, the loop, the forced
final call — is about fourteen questions before the panel starts reporting an
outage that is not one.

**None of it fires on a budget this package cannot defend.** Two separate things
have to hold before a single rule below engages:

1. **A daily allowance exists to be rationed** — either you wrote one down in
   [`dailyLimit`](#budget-dailylimit), or the answering half is running on a
   provider's own **free pool**: `chat: { provider: 'openrouter' }` with no model
   named, or with the shipped pool behind it. A funded key on a metered provider
   is not a free tier; neither is a `chat.models` list you wrote yourself, since
   a list you chose says nothing about which tier serves it. If one of those is
   in fact metered, `dailyLimit` is how you say so.
2. **The number describing it is daily.** A count read from
   `x-ratelimit-remaining` is believed only when its reset is at least ten
   minutes out, because nginx, Kong, Tyk, AWS API Gateway and the IETF
   `RateLimit-*` draft all emit those same three header names for **per-minute**
   windows: a self-hosted model behind a 20-a-minute gateway reports
   `remaining: 14` all day long, and reading that as fourteen answers left would
   put a paid deployment into one-shot mode permanently.

Anything else leaves the budget unknown and every turn exactly as it is today.
Inferring scarcity from a missing header, or from somebody else's per-minute
allowance, would quietly shorten answers for everyone paying per token.

```js
budget: { mode: 'auto', oneShotBelow: 15 }
```

**The count never refuses a question.** It is a local reading of an account-wide
allowance — another browser profile, another tab, or this project's own CLI may
have been spending the same fifty — so a panel that stopped answering because its
own arithmetic said so would be refusing turns the service would have answered.
The only refusal here is the service's own `429`, and that one arrives with the
time it resets.

`budget: false` is the whole block off in one word: agentic every turn, no line
in the panel, the probe unconditional, and both thresholds set to `-1` — a
comparison against a remaining count that can never come true, so the rules stay
in the code and stop happening. `maxContinuations` alone keeps its shipped value,
because finishing a reply the provider truncated mid-sentence is a defect fix on
any tier rather than a rationing measure.

`probe`, `rotateAbove` and `maxContinuations` are in this block rather than
beside [`chat.models`](#chat-models) and `chat.maxTokens` deliberately. Not one
of them is a fact about the model: they decide whether a request is worth making
before the reader has asked anything, whether a second model is worth one, and
whether finishing this answer is worth one. What they have in common is the only
thing you will have in mind when you go looking for them — they are what you turn
when **requests** are scarce — and splitting one cost-control feature across three
sections makes it three features nobody can find.

### budget.mode

`'auto' | 'agentic' | 'one-shot'`. `'agentic'` is the turn that shipped: up to
`maxIterations` tool-calling steps and then a forced final call. `'one-shot'` is
one model request for the whole question — the iteration ceiling is driven to 0
and control falls straight through to that final call, which already carries the
priming retrieval, the strict answer schema and the citable set. The answer is
narrower, not degraded: it cannot go looking for more evidence first.

`'auto'` is one-shot only once the remaining count is at or below
`oneShotBelow`.

### budget.oneShotBelow, budget.rotateAbove

The two thresholds, in answers left today.

At or below `oneShotBelow` (15) a turn costs one request instead of three or
four, which is what turns the last quarter of the day into roughly three times
as many questions.

At or below `rotateAbove` (6) the pool stops rotating. Rotation spends a second
request on the hope that another model does better, and what stopping buys is the
**request** rather than a worse answer to this question: a reply with no
citations is withheld whatever it cost, so the one that is kept here ends the
turn on the refusal it would have ended on anyway. Six answers left is six more
questions, or three if every turn may ask twice.

`-1` retires either rule on its own — a remaining count is never negative, so the
comparison cannot come true — and it is what `budget: false` writes into both.
Anything else below zero is reported and replaced.

### budget.maxContinuations

How many follow-up requests a **truncated** reply may spend. A provider that
stops at its output ceiling says so, and the half-written JSON object it hands
back fails to parse — so an answer that was three quarters written used to end as
*I couldn't find this in the docs*. One more request finishes it, and the seam is
invisible: the fragments are concatenated before anything reads them. Driven to 0
with two answers left, where the reader is better served by two more questions
than by one tidier paragraph.

**0 to 3.** This is the one number in the block that spends requests rather than
saving them, and it spends them per turn: a truncated reply needs one more
request, occasionally two, so above three it is no longer finishing an answer —
it is retrying a different failure at a request each, against the same fifty a
day. A larger value is reported and the shipped 1 used instead.

### budget.showRemaining

The one muted line under the composer, saying what the next question is limited
to. It has two halves and renders whichever it has:

- *38 of 50 answers left today* — a known count, on a deployment with a daily
  allowance: one you declared with [`dailyLimit`](#budget-dailylimit), or the
  provider's own free pool. A `chat.models` list you wrote yourself is neither,
  so the line follows the rationing rather than the shape of the config, and the
  deployment being rationed is never the one left unable to see it. Once the
  panel has dropped to one-shot, one further sentence says that answers get
  shorter — announced to a screen reader as well as shown.
- *No embedding model — search matches words only.* — where the site declared
  [`embed: false`](#embed-false). Both together read as
  *38 of 50 answers left today · No embedding model — search matches words
  only.*

The count does **not** say "free". It renders on a paid key with a declared
ceiling as readily as on a free pool, and whose catalogue the answers come off is
not what the reader is deciding on.

The second half is deliberately **not** the degraded-retrieval warning. That one
belongs to an embedder that was configured and could not be reached, and it
appears on the refusal it explains; this is a mode the site chose, stated calmly
in the place where the reader is deciding what to ask.

**Off by default**, and this is the one switch inside the panel that is. On a
public documentation site every reader draws on one key, so the count a browser
can compute is a lower bound on what other people have already spent — *35 of 50
left* is stated with an authority the arithmetic behind it does not have. A
project that knows its key is not shared turns it on:

```js
budget: { showRemaining: true }
```

**The count half needs a daily allowance**, which is the same test the rationing
runs: a [`dailyLimit`](#budget-dailylimit) you declared, or the provider's own
free pool. With neither there is no ceiling of requests per day to report and the
count stays silent — a deployment paying per token has nothing here to count
against. The no-embedder half is gated on this switch alone and appears either
way.

For one release the count read the free pool alone, so a site that declared a
`dailyLimit` on a paid key was rationed against it all day and never shown the
number — the one deployment being rationed was the one unable to see it. Both
halves now call the same `hasDailyAllowance`, so the line and the rationing
cannot disagree about who has an allowance.

Turning it off is also how a site asks this panel not to discuss its own limits
at all — the low-budget sentence and the no-embedder note go with it.

### budget.probe

`'auto' | 'always' | 'never'`. The capability probe is a full model call made
before the reader has read a word — on a pool it asks up to three candidates —
and on a 50-request day it is the single most expensive habit here: opening two
pages spends two answers finding out something the configuration already implies.

`'auto'` skips it where a pool is configured, because a pooled provider's members
are tool-capable by construction and the fallback parser recovers the case where
one is not. `'always'` keeps the behaviour that shipped, for a local model zoo
where the question is genuinely open. `'never'` skips it outright.

### budget.dailyLimit

A ceiling to count against locally, for a metered service that sends no
rate-limit headers. `null` means learn from the headers — and on a provider's own
free pool, the published free-tier number is used until the first response
teaches it better. Header numbers always win over the local count.

**`null`, or a whole number of 1 or more.** `0` is reported and ignored rather
than obeyed, because everything under this key reads a falsy ceiling as
*absence*: written literally, `dailyLimit: 0` would have meant no ceiling at all
and no free-tier fallback either — the opposite of what it looks like, silently.
Declaring a ceiling is also the one way to have these rules apply to a provider
this package does not know to be metered.

## suggestions

- **Type:** `(string | AuthoredOpener)[] | { questions?: (string | AuthoredOpener)[], authored?: AuthoredOpener[], scoped?: boolean, followUps?: boolean, precomputed?: boolean, answers?: boolean, matchTau?: number | false, matchCos?: number | false, reveal?: boolean }`, where `AuthoredOpener` is `{ q: string, answer: string, cite: string[] }`
- **Default:** `{ questions: [], authored: [], scoped: true, followUps: false, precomputed: true, answers: true, matchTau: 0.65, matchCos: 0.72, reveal: true }` — the built-in three
- **Related:** [ui-specs/009]

The three to five questions on the empty state, and what the panel offers when it
cannot show them.

An **array is still legal** and still means what it always meant — it is
`{ questions: [...] }` with the two behaviours left at their defaults.

```js
suggestions: [
  'How do I connect the editor to my app?',
  'How do I authenticate requests?',
  'How do I build a custom extension?',
  'How do I change the panel’s colours?',
  'What does the assistant refuse to answer?',
]
```

Strings, not `{label, question}` objects: the row submits what it shows, so a
separate label would put a question the reader never read into the thread. The one
object form that **is** accepted carries no label either — it carries the answer,
see [`suggestions.authored`](#suggestions-authored).

**The first five are used, and three is the fallback rather than the maximum.**
Extras, empties, repeats and non-strings are dropped and **named on stdout** — a
silent cap reads as "covered everything" when it did not. The count is yours: the
panel shows what you configure, and a site that configures nothing still shows the
built-in three.

**Five is not free.** Each opener is an embedding request at build time and, with
[`suggestions.answers`](#suggestions-answers) on, a model call as well — and they
are spent again whenever the corpus hash moves **or you edit one of them**,
because the bake is fingerprinted over the whole list rather than per question. At
five with answers on that is ten requests, which on a fifty-a-day free tier is a
fifth of the day. Four good openers beat five where the fifth is one you have not
finished writing.

These are gate inputs, not headings. A question your corpus cannot answer produces
a refusal on the reader's first click, in the one state that exists to show the
panel working. The built-in three are engine-agnostic for exactly that reason, and
are worth replacing.

### suggestions.questions

The array, under its own name. `suggestions: ['One?']` and
`suggestions: { questions: ['One?'] }` are the same setting.

An entry may also be `{ q, answer, cite }` — a question you answered yourself. See
[`suggestions.authored`](#suggestions-authored).

### suggestions.authored

The openers whose answer you wrote, rather than one a model writes for you.

```js
suggestions: {
  questions: [
    'How do I authenticate requests?',
    {
      q: 'How do I get started?',
      answer: '**1) Install and initialise.**\n\n```bash\nnpm i @cloflin/docpilot\n```\n\n…',
      cite: ['install#', 'install#installing-it'],
    },
  ],
}
```

`answer` ships **verbatim**: `npx docpilot index` writes it into the openers bundle
beside the index, and the click serves it. No model is asked for it at build time,
and none is asked in the browser — so this is the one answer a search-only site
can still give, and the one that costs nothing on a metered tier however often the
corpus moves.

**Why you would.** The empty state is the most-asked question on any docs site by
construction, and the questions that belong there are usually the ones whose answer
is spread over four pages. A model handed eight excerpts writes a competent
paragraph about the two it liked; the whole path, in order, with the commands in
it, is an editorial artefact. Write that one and let the model have the rest.

**`cite` is required, and it is checked.** It is a list of chunk ids —
`install#installing-it`, `guide/appearance#five-entry-points` — and the build looks
every one of them up in the index it has just produced. If any is missing the whole
answer is dropped, loudly, and the model answers that opener instead:

```
    UNCITED  "How do I get started?" was answered in your config, citing
             "install#gone" — not in this index. The written answer is NOT baked
             and the model answers instead. Fix the ids, or reindex.
```

That check is not bureaucracy. `settleAnswer` resolves each citation against the
index and silently drops the misses, so an id left behind by a renamed heading
would reach the reader as prose with no sources under it — which is precisely the
artefact [`suggestions.answers`](#suggestions-answers) refuses to bake. An
answer that is missing its text, or that cites nothing at all, is dropped the same
way and **the question survives**: the reader gets a live answer, never a blank
chip.

**The gate does not apply to it.** An opener the gate refuses is exactly the one an
author is most likely to write out by hand, so a written answer is baked regardless
of the score. The build still prints the score, under `covered` rather than
`REFUSED`.

**Editing the prose invalidates the bundle**, the same way editing a question does:
the fingerprint the panel compares covers the answers and the ids as well as the
questions. Until the next `npx docpilot index` the whole bundle is ignored and
every opener behaves as it did before any of this existed.

**Plain markdown only.** Fences, tables and links render; VitePress containers
(`::: warning`) do not — they reach the reader as three colons and a word.

`authored` is **resolved out of `questions`** and is the key everything downstream
reads, which is why it is documented as a key of its own: writing it directly is
legal, is re-validated exactly as the inline form is, and is what makes the
resolver idempotent.

### suggestions.scoped

What an empty panel offers when the scope is **not** all the docs. The openers
above are suppressed there — they would fall outside the scope and the gate would
refuse every one of them — and before this the result was a blank panel shown to
the one reader who had narrowed things down on purpose. What goes there instead
is the pages in the scope, as rows. Nothing is generated.

```js
suggestions: { questions: [...], scoped: false }   // back to the blank panel
```

### suggestions.followUps

Two or three questions under the newest answer, built from the headings on the
pages that answer cited, minus the ones it used. No model call, and nothing
invented: the wording is a template, so it cannot name a section your corpus does
not have.

**Off by default, and the reason is measured rather than felt.** ChatGPT ships
follow-up suggestions and its readers write custom instructions to suppress them.
Copy that ships on has to be good for every corpus; copy you opt into only has to
be good enough for yours.

### suggestions.precomputed

**The openers are resolved at index time, not at read time.**

`npx docpilot index` takes the questions above, embeds each one, and runs the
same retrieval and the same gate your readers run. What it resolved ships beside
the index. A reader who clicks an opener — or types one of these questions
verbatim, or a close paraphrase — gets that resolution instead of an embedding
request.

You never see a chunk id and never write one. Edit the questions, run
`npx docpilot index`, and the resolution follows. Edit them and *don't* rebuild,
and the panel notices the mismatch and asks the embedder as it always did: a
question can only ever be served the evidence it was resolved for.

The build prints what it resolved, including the openers your corpus **refuses**:

```
  openers  5 questions · configHash 3f1c9a02
    ✓ 0.71  'How do I get started?'                 4 chunks
    ✗ 0.22  'How do I authenticate requests?'       < tau 0.57
```

That second line is the one worth the feature on its own. It is the sentence at
the top of this section — *a question your corpus cannot answer produces a
refusal on the reader's first click* — caught on your machine instead of theirs.

Off, nothing is baked and nothing is read, in both directions: a bundle no panel
consults is build-time requests spent on a file that ships and does nothing.

### suggestions.answers

Also bakes the **answer**, so a matching question costs no requests at all.

Served only when the language the reader asked in matches the language the
answer was written in — the same detector that decides which language a greeting
is answered in. Ask an English opener in Russian and the baked answer is passed
over; the model writes a fresh one, in Russian, from the evidence that was baked.
So this key never costs a reader an answer in the wrong language.

**It is the half that costs requests at build time**: one model call per opener,
against the same allowance your readers draw on, whenever the corpus changes —
**or whenever you edit one opener**, because the bundle is fingerprinted over the
whole configured list and a one-word rewrite moves it. At the ceiling of five that
is five embeddings and five model calls, ten of a fifty-a-day tier. Answers are
cached against the index hash, the prompt and the model, so a rebuild that changes
none of the three regenerates none of them.

An answer with no citations is never baked. Turn this off and the evidence bake
stays: the click still costs no embedding. It reverts
[`suggestions.authored`](#suggestions-authored) too — off means no answers at all,
not "no answers except the ones I wrote".

### suggestions.matchTau

How close a typed question has to be to a baked one to be treated as it.

The measure is how much of the question's **rare** wording the opener covers, and
it is required in **both** directions — otherwise `gate` alone would match
`How do I configure the refusal gate?`, and a reader asking about one thing would
be handed the answer to another. Common words buy nothing: the score is weighted
by how rare each word is in your corpus, by the same arithmetic the refusal gate
uses.

`false` retires the paraphrase test and leaves exact matching, which cannot fire
on a different question at all. That is the setting for a corpus where two of
your openers are near neighbours — and the build tells you when they are:

```
  openers  'How do I configure the gate?' and 'How do I configure the guard?'
           score 0.80 against each other, at or above matchTau 0.65 — a reader's
           paraphrase could land on either.
```

**Where 0.65 comes from, and what it is not.** It is a config constant, not a
calibrated threshold: `docpilot calibrate` never measures it and `tuning.json`
never carries it. But it is not a guess either. Scoring all 597 probes of this
project's calibration set against its three openers — 1,791 pairs, no network —
the highest score any probe that is *not* an opener reaches is **0.500**, and
nothing reaches 0.6 at all. Meanwhile a real paraphrase covering two of three key
words scores 0.667. So the threshold sits above every measured false positive
with room, and below the paraphrases the feature exists to catch.

**That measurement is of one corpus.** Yours has different vocabulary and
different openers. The number that is about *your* site is the build's `COLLIDES`
line, which scores your openers against each other with the same function; and
the measurement above is reproducible on your corpus in seconds with no requests
— see the `faq` mode in the `docs-rag` skill.

### suggestions.matchCos

The same question asked of the **vector**, and it is `matchTau`'s complement
rather than its replacement — the two fail on opposite inputs.

Lexical coverage is a fraction of the query's *rare terms* that the opener's text
contains. That is exactly right for a restatement and returns exactly **zero** for
a paraphrase built out of different words. Measured on this package's own docs:

| typed | `matchTau` | `matchCos` |
|---|---|---|
| `how to get started` | 1.00 | 0.98 |
| `getting started` | 0.50 | 0.85 |
| `How do I set this up?` | **0.00** | 0.81 |
| `How do I install it?` | **0.00** | 0.78 |
| `как начать?` | **0.00** | 0.91 |

No threshold rescues the lexical test on those rows, because there is nothing to
lower it to. Recognising them is what a dense embedder is for, and by this point
in the turn the query has already been embedded — for retrieval, on the reader's
own request — so the test costs one dot product per opener and no request at all.
In lexical-only it does not run, because there is no vector.

**It refuses a near-tie.** The best opener has to beat the runner-up by 0.05,
which is `matchTau`'s "a tie refuses" rule written in the unit cosine uses: in a
dense space an exact tie never occurs, so *equal* has to be a band. A question
inside it is answered by the model, which is what happened before this test
existed.

**The number is a floor, not a measurement of your corpus.** It was measured here
on bge-m3: seventeen paraphrases of three openers, and eight questions that are
about this corpus but about no opener. The off-target questions topped out at
**0.60** and the clear paraphrases sat at **0.78** and up, so 0.72 splits a gap
that is narrower than it looks — a dense embedder's cosines do not start at zero,
and an unrelated question here still scores 0.35.

Measure it on yours before trusting it — `opener-cosines.js` in the `docs-rag`
skill is the sweep, and it runs free against a second index. What a wrong match
costs is not a worse answer, it is **a whole written answer about something
else**, with citations that are real and about something else. Set `false` to
retire the test and leave the lexical pass exactly as it was.

### suggestions.reveal

A baked answer is painted progressively instead of appearing whole.

Nothing is generated and no request is made — the string is in memory before the
first frame, and this is a paint schedule over it: sixteen frames on the same
90ms floor the live stream renders at, about 1.4 seconds whatever the answer's
length. A fixed frame count rather than a fixed rate, because a rate that reads
well on a two-kilobyte answer takes eight seconds on a four-kilobyte one.

**Why it is on.** The honest argument is for off: nothing is happening, so an
animation is the panel performing work it is not doing. What that misses is what
the alternative tells the reader. An answer that lands whole and instantly does
not read as *fast* — it reads as **canned**, as a help topic that was going to be
shown whatever was asked, which is the one impression a grounded assistant cannot
afford on its first turn. So it is a default, and this is the switch for a site
that prefers the other reading.

`prefers-reduced-motion: reduce` skips it, because it is motion. **Stop** skips it
too and *completes* the answer rather than truncating it: there is no request in
flight, so a reader pressing Stop is asking to see the rest now.

## quote

- **Type:** `object`
- **Default:** `{ fromAnswer: true, fromDocs: false }`

Selecting a passage and asking about it.

```js
quote: { fromAnswer: true, fromDocs: false }
```

### quote.fromAnswer

Select inside an answer and one button appears above the selection; pressing it
attaches the passage to the composer as a chip. This is the behaviour the panel
has shipped with — it simply had no switch until now.

### quote.fromDocs

The same popover over **your own article**. It is the gesture a documentation
reader actually has — select the paragraph that confused you — and until this it
led nowhere: open the panel, retype the question, lose the text it was about.

**Off by default**, because it paints a control on your prose. The reader who
selects a command in order to copy it must not meet a button every time, and that
is a decision about your site rather than about this panel.

## citations

- **Type:** `object`
- **Default:** `{ passage: false, inCopy: true, pagesRead: false }`
- **Related:** [What DocPilot guarantees](/concepts/guarantees)

What a reader can do with a citation besides believe it.

```js
citations: { passage: true, inCopy: true, pagesRead: false }
```

Not to be confused with [`sources`](#sources), which is the allowlist of origins
an imported page may name. That one decides what may become a link; this one
decides what the reader can see behind the links that are already there.

**The source list itself is not a setting.** Every answer names what it cited and
every one of those rows is a link, whatever is written here. What this block
decides is what sits *on top of* those links.

### citations.passage

A source row grows a chevron, and it expands to show the exact retrieved passage —
the chunk the host put in front of the model on that turn. It costs no request:
the text is already in the reader's browser.

**Off by default.** The row is already a link, and this is a second layer over
one: a disclosure control on every source of every answer, and the raw chunk
inline when it is opened. That is worth having where you want checking a source
to be a normal step of reading — what [the guarantees](/concepts/guarantees) say
out loud is that citation is provenance and not entailment — and it is a decision
about how dense you want this panel to be rather than a defect the package should
fix on everyone's behalf. Turn it on with:

```js
citations: { passage: true }
```

The reader who wants the source has the link either way; what the disclosure buys
them is not having to follow it, which on a narrow screen closes the panel and
takes the thread with it.

On a conversation restored from a previous visit the passage is resolved by id
against the current index; if the docs have been rebuilt and that chunk is gone,
the control is simply absent.

### citations.inCopy

Copying an answer appends its sources as Markdown links, with absolute URLs.
Without it a `[1]` pasted into a ticket arrives with nothing behind it, which is
worse than no citation at all because it looks like provenance.

### citations.pagesRead

Names the pages a refused turn actually read, under the line that already says
*searched and read 3 pages*. **Off by default:** it is a second list on a surface
that already carries one.

## composer

- **Type:** `object`
- **Default:** `{ editLastOnArrowUp: true, deepLink: true }`

Two ways into the field.

```js
composer: { editLastOnArrowUp: true, deepLink: true }
```

### composer.editLastOnArrowUp

`↑` in an **empty** composer opens the last question for editing, caret at the
end. ChatGPT's own behaviour, and readline's before it. The empty condition is
not a nicety: without it the key would stop moving the caret inside a multi-line
draft.

### composer.deepLink

`?dp-ask=…` opens the panel with that text in the composer.

```
https://docs.example.com/guide/auth?dp-ask=How%20do%20I%20rotate%20a%20key
```

**It does not submit.** The reader stays in charge of spending a turn, a crawler
following the link spends nothing, and a question somebody else wrote is one the
reader should get to read first. `&dp-scope=page` narrows the search to the page
they landed on. Both parameters are removed from the address bar once read, so a
reload does not refill a composer they emptied.

The names are prefixed because a documentation site may well own `ask` already.

## guard

- **Type:** `object`
- **Default:** `{ mode: 'off', tau: null, tauLexical: null, supportMinIdentifiers: 3 }`
- **Related:** [The refusal gate](/concepts/the-gate)

Whether a failing verdict ends the turn (`mode`), and overrides for the
calibrated thresholds it is scored against. Use `npx docpilot calibrate` for the
thresholds rather than writing them by hand.

The example below restores the pre-1.3 refusal contract — every failing verdict
ends the turn, on every deployment shape:

```js
guard: { mode: 'calibrated', tau: null, tauLexical: null, supportMinIdentifiers: 3 }
```


### composer.draft

The composer keeps what is in it across a reload. `sessionStorage`, under
`docpilot:draft`.

A question against the thousand-character ceiling is a minute of somebody's
writing, and until now a reflex `⌘R` or a link followed and come back from
emptied the field. The draft belongs to the **tab**, which is why it is paired
with `docpilot:conversation` rather than with the `localStorage` archive: two
tabs are two questions.

**It is redacted before it is written**, on the same rule and with the same
function as a question — a pasted key is caught before a turn exists, and the
draft is the one text in the panel that would otherwise reach storage before that
machinery has seen it.

**It obeys [`history.enabled`](#history-enabled) as well as this key.** That
setting is documented as *stops recording and clears what is already stored*, and
a draft outliving it would make the sentence false — so either switch off both
declines to write and removes what is there.

`?dp-ask=` wins over a restored draft: a link the reader followed a second ago is
a newer intention than a sentence they walked away from.

### guard.mode, guard.supportMinIdentifiers

**`mode` decides whether a failing verdict ENDS the turn.** It never decides
whether one is scored: every value scores every turn and records the result, so
a report reads the same whichever is set — what moves is only the refusal.

| value | a failing verdict |
| --- | --- |
| `'off'` | never refuses — every question reaches the model. **The default.** |
| `'dense-only'` | refuses only where a dense channel scored it |
| `'calibrated'` | refuses always |

**Why the default is not "always".** `L` is token overlap between the question
and the corpus, so it is 0 *by construction* for a question asked in a language
the documentation is not written in — no threshold on top of a zero can tell
that question apart from one about nothing the site covers. Measured on this
package's own English docs: a Russian install question scored a hybrid verdict
of 0.21 against a 0.41 pass mark, while the refusal's own "closest pages" line
named the three pages that actually answered it. The panel would have said *I
couldn't find this in the docs* — which is false. It did not look, and no
per-language threshold closes this: it would have to be measured for Russian,
then Chinese, then whatever a site's next reader types in.
[`vocabulary`](#vocabulary) closes a narrower, same-alphabet case — a reader who
calls the product by a name the docs do not use — but not this one.

So the verdict is scored and kept for the record, and the **model** decides
whether the question is answerable — the judgement it can actually make: it is
shown the passages, it can search again in the corpus's own language, and it
holds a [refusal contract](/concepts/a-turn) of its own — an answer with no
citation in it is withdrawn before the reader sees it.

**What it costs.** A question the corpus has nothing for now spends a model
turn before that is known, on every deployment. On [a shared free
tier](/guide/free-tier) that is one of roughly fifty a day for the whole site.
Write `guard: { mode: 'calibrated' }` to buy the pre-1.3 behaviour back on a
single-language corpus with a probe set to calibrate against — `'dense-only'`
is the same trade, narrowed to sites with no embedder at all.

`supportMinIdentifiers` is the floor under the support check — an answer carrying
fewer than this many code identifiers is not scored for support at all, because
three symbols is not enough evidence to call a ratio a measurement.

### guard.tau, guard.tauLexical

**Measured, not chosen.** `npx docpilot calibrate` writes them into
`${evalDir}/calibration.json` and `npx docpilot index` inlines them into the
manifest. Setting them here overrides the measurement and stamps
`gate.source: "config"` on every record of the session, which is what makes a
hand-set threshold visible in a report rather than invisible in behaviour.

On a vectorless index there is no dense channel to measure `tau` against, so
`calibrate` sweeps `tauLexical` alone and leaves `tau` null rather than writing a
number nothing measured.

## vocabulary

- **Type:** `Record<string, string[]> | null`
- **Default:** `null`

**The documentation's own name for things readers call by other names.**

A plugin that is also an assistant, a chat and a widget has four names before
anybody translates one, and the lexical channel knows only the one the docs
happened to use. A reader who types *виджет* against a corpus that says
*DocPilot* shares no token with it at all, so lexical coverage `L` is 0 — and on
a site with no dense channel that is the whole score, so
[the gate](#guard-tau-guard-taulexical) refuses a question about the product
before any model is asked.

```js
vocabulary: {
  DocPilot: ['widget', 'виджет', 'ассистент', 'чат', 'плагин'],
  'chat.chain': ['fallback', 'фоллбек', 'перебор провайдеров'],
}
```

The key is the word the documentation uses; the array is the words readers use
for it. One entry is still an array of one.

### It rewrites, it never adds

What the gate scores is the question with the reader's word replaced by the
documentation's, exactly as if they had typed the second one. Nothing is
removed either, which is what keeps the guard's sign intact: an off-topic
question padded with product nouns still carries every off-domain term it came
with, so `L` cannot saturate on a rewrite.

The same substitution runs over the corpus at build time and over the query in
the browser, because both go through one tokenizer. That is the safety argument
and it is the same one [suffix stripping](/concepts/a-turn) rests on: a
symmetric rewrite can only ever add matches.

Inflection is handled: a single-word name is matched again after stemming, so
`виджеты` and `виджета` reach the term `виджет` already reached. A multi-word
name — `ии чат` — is matched before anything is stemmed, longest first, so it is
recognised whole rather than as two words.

**A name is a canonical or an alias, never both.** Naming a term on both sides
would put a cycle in the rewrite, and the build says so rather than dropping it.

### Where it comes from

`npx docpilot vocabulary` reads the corpus, asks the configured model which
words readers are likely to use for the terms it finds, and writes
`${evalDir}/vocabulary.json`. It **proposes and never decides**: the file is
committed and edited like the golden set.

This key overrides it, per term rather than wholesale — adding one pair by hand
does not discard the twenty a model found. An empty object is a different
statement from an omitted key: `vocabulary: {}` is *declared, and empty*, and
takes nothing, including the sidecar.

### What it owes

Every lexical score moves when the map does, and `tau` was calibrated against
the old one. The index hash is over chunk text and cannot see it, so the
manifest carries a `vocabHash` beside it and `npx docpilot index` reports a
stale guard when the two disagree:

```
npx docpilot vocabulary && npx docpilot index && npx docpilot calibrate --refresh && npx docpilot index
```

### What the model is told

On a turn with no dense channel the declared pairs are sent in the system block,
so the model's own `search_docs` calls query the documentation's word rather than
the reader's. On a hybrid turn they are not: the embedder already bridges the
two, and the tokens are the excerpts' to spend. Both halves are covered by the
[prompt hash](/guide/i18n), so two sites with different maps do not file their
reports under one number.

## scope

- **Type:** `object`
- **Default:** `{ enabled: true, default: 'all', promptListLimit: 12, filter: 'auto', groupBySection: true }`

The scope picker.

```js
scope: { enabled: true, default: 'all', promptListLimit: 12, filter: 'auto', groupBySection: true }
```

`enabled: false` removes the picker; every question then searches the whole
corpus. `default` accepts `'all'` and nothing else — a build-time default of
`page` would silently narrow every reader's first question. `promptListLimit`
caps how many page titles the scope block names in the instruction.

### scope.filter

A filter field above the page list. `'auto'` — the default — shows it once the
corpus is past twelve pages, which is `promptListLimit`'s own number and the same
judgement: a list longer than that is a list nobody scans. `true` and `false`
decide it outright.

A flat, unfiltered list of every page inside a 240px scroller is fine at twelve
pages and unusable at three hundred.

### scope.groupBySection

Section headings inside the picker, taken from your sidebar. Suspended while a
filter is on: grouping a filtered list fragments it into headings with one row
under each, which is the opposite of what narrowing was for.

## history

- **Type:** `object`
- **Default:** `{ enabled: true, maxConversations: 20, exportThread: true }`
- **Related:** [Conversation history](/guide/history)

Past conversations, kept in the reader's `localStorage` and listed in the panel.

```js
history: { enabled: true, maxConversations: 20, exportThread: true }
```

### history.exportThread

A button in the panel header that copies the whole conversation as Markdown.
Per-turn copy already existed; what somebody pastes into a ticket is the thread,
and reassembling one out of four separate copies is the work this removes. It
honours [`citations.inCopy`](#citations-incopy), so an exported thread and an
exported answer agree about provenance.


### history.saveOnUnload

An answer that is still being written is written down when the page goes away.

Everything else in this package is saved once per settled turn and once per vote,
never mid-stream, because a per-token write would serialise the whole
conversation on every frame. This is the one exception, and it exists because the
alternative is worse than the write: a reload at second three of an answer
otherwise loses every token of it, on a request that has already been paid for —
which on the free tier is one of fifty for the day, spent on nothing.

What comes back is the turn as `stop()` leaves one: the text that had arrived,
**Stopped.** above it, **Ask again** below it. The stream itself is not resumed
and cannot be — that needs a buffer on a server, and this package has no server.

Bound to `pagehide` and to `visibilitychange`, never to `beforeunload`. The write
is idempotent for one turn, because `visibilitychange` fires on every tab switch
and every screen lock.

Off means an interrupted answer is lost, which is the behaviour before this key
existed. It also obeys [`history.enabled`](#history-enabled).

### history.maxConversations

The length of that list; the oldest falls off the end. A byte ceiling applies
underneath it and is deliberately not a setting: `localStorage` is about 5MB **per
origin**, shared with VitePress and your own theme, so the panel keeps to a tenth
of it rather than asking you to reason about the split.

### history.enabled

`false` does two things, not one. It stops recording, **and it clears what is
already stored** on the reader's next visit — the same rule `prompt.show: false`
applies to a reader's saved instruction. A site that turns this off after a
privacy review leaves nothing behind.

## ui

- **Type:** `object`
- **Default:** `{ trigger: 'fab', panel: 'auto', fabLabel: true, fabIcon: true, layout: 'overlay', prefetch: 'hover', firstRunHint: false, background: 'notify', credit: true, theme: 'auto', font: null, fontMono: null }`
- **Related:** [Appearance](/guide/appearance)

Where the buttons live, what shape the panel takes, what the floating button is
made of, and how the panel treats the page it opens over.

```js
ui: { trigger: 'fab', panel: 'auto', fabLabel: true, fabIcon: true }
```

| key | values | default |
|---|---|---|
| `trigger` | a placement, a word standing for several, or an array — [see below](#ui-trigger) | `'fab'` |
| `panel` | `'auto'` · `'drawer'` — full height, right edge · `'popup'` — floating, above the button | `'auto'` |
| `fabLabel` | `true` — the shipped words · a string — those words · `false` — no label | `true` |
| `fabIcon` | `false` drops the sparkle | `true` |
| `layout` | `'overlay'` — the panel covers the page · `'push'` — the page moves aside | `'overlay'` |
| `prefetch` | `'hover'` · `'idle'` · `false` | `'hover'` |
| `firstRunHint` | `true` shows one dismissible line on a first visit | `false` |
| `background` | `'notify'` — a dot on the trigger · `'open'` — the panel returns · `false` — the turn is abandoned on close | `'notify'` |
| `credit` | `false` removes the `DocPilot` link from the footnote | `true` |
| `theme` | `'auto'` — the page decides · `'light'` · `'dark'` — pinned, whatever the page says — [see below](#ui-theme) | `'auto'` |
| `font` | a family list, or the name of a custom property — [see below](#ui-font-ui-fontmono) | `null` — the page's own font |
| `fontMono` | the same, for code — `null` keeps a system monospace stack | `null` |

A value outside either enum is reported on stdout during the build and falls back
to the default; nothing throws, because a typo in a cosmetic setting must not be
able to fail a docs build.

### ui.trigger

**A list**, and a bare word is shorthand for one. The three placements are not
alternatives: the first two only exist inside your navigation bar, and the third
only exists outside it — so a site is allowed all of them at once.

| placement | where |
|---|---|
| `'nav'` | in your navigation bar, beside the search box |
| `'screen'` | a text row inside your mobile navigation menu |
| `'fab'` | floating, bottom corner, on every page and at every width — **the default** |

`'fab'` ships because it is the one placement that needs nothing from your
theme: a navbar slot is a VitePress given and nothing else's, so a custom theme,
a React page or a host with its own header rendered no button at all under the
old `'nav'` default. Say `trigger: 'nav'` to put it back beside your search box —
[`ui.panel`](#ui-panel) is `'auto'`, so the drawer comes back with it.

```js
ui: { trigger: 'nav' }                            // navbar button + mobile row, drawer
ui: { trigger: ['nav', 'fab'], panel: 'popup' }   // both buttons, one popup
ui: { trigger: 'both' }                           // all three
ui: { trigger: 'fab', fabLabel: 'Ask AI' }        // the floating button alone
ui: { trigger: 'none' }                           // no button — ⌘I still opens it
```

Four words stand for a list:

| word | means |
|---|---|
| `'nav'` | `['nav', 'screen']` — the navbar button **and** its mobile row |
| `'both'`, `'all'` | `['nav', 'screen', 'fab']` |
| `'none'` | `[]` — no visible trigger at all |
| `'fab'`, `'screen'` | themselves |

`'nav'` carries the mobile row with it because a navigation bar that collapses
into a hamburger takes the button with it, and a placement with no mobile half
disappears on a phone. **`'nav'` and `['nav']` therefore differ** — spell the
array to get the desktop button on its own. `'fab'` deliberately does *not* pull
in the mobile row: the floating button is on screen at every width already.
Write `['fab', 'screen']` if you want both.

A member the resolver does not recognise is named on stdout and dropped, and the
rest of the list stands. A list that ends up empty because *every* member was a
typo falls back to the default instead — `'none'` and `[]` are how you ask for no
trigger, and a cosmetic setting must never be able to leave a page with no way to
open the panel.

**With no visible trigger the panel is still reachable**: <kbd>⌘I</kbd> /
<kbd>Ctrl I</kbd> binds regardless, and on a host that mounts the panel itself
`open()` on the handle from [`mountDocPilot`](/install/javascript) is the door.

### ui.layout

The desktop drawer is fixed to the trailing edge, so it covers your right aside
and, on a narrow desktop, part of the prose column. `'push'` gives the content an
inline-end padding while the panel is open, so the two sit side by side.

**Off by default**, because it reflows your layout on every open and not every
theme will take that well — it is a mode you choose rather than a fix that
arrives. Below 960px it does nothing: the panel is edge to edge there and there
is nothing to push.

### ui.prefetch

When the retrieval index is fetched. Before this it happened on open, so the
first question of a session was the slow one and the reader's first impression of
the panel was *Loading the docs index*.

| value | when |
|---|---|
| `'hover'` | the first pointer or focus on the trigger — close to intent, almost never wrong |
| `'idle'` | once the page has settled, for a site that would rather pay up front |
| `false` | on open, as it happened before this setting existed |

Only the download is prefetched. Restoring the scope and the conversation stays
on open, because that half can announce into a screen-reader live region and the
panel is not on screen yet.

The index of a large corpus is real traffic, spent on readers who may never open
the panel — so it is skipped entirely when the browser reports `saveData` or a
2G-class connection.

### ui.firstRunHint

One dismissible line under the empty state's suggestions, shown once per device,
naming the single thing a reader will not discover on their own: that selecting a
passage offers to ask about it.

**Off by default** — it paints something nobody asked for on a first visit. It is
also withheld when both [`quote`](#quote) switches are off, because a hint naming
a gesture the panel does not answer is worse than no hint.


### ui.waitingEscalation

While nothing has arrived, the status line says how long that has been true.

The line is otherwise a pure function of what the panel is doing —
`Searching the docs`, `Thinking`, `Writing the answer` — and a provider that
accepts the connection and then says nothing does not move it. The step timeout
is two minutes, so the reader can be left in front of a motionless word with no
way to tell it apart from a panel that has crashed.

Two steps, and no third:

| after | what it says |
|---|---|
| 8s | *Still working* |
| 25s | *Still working — the answer has not started yet* |

**Neither names a cause and neither promises a retry.** The panel often *is*
about to try another model, but a chain with one member never rotates, a named
model flattens the tiers, and a self-hosted server has nowhere to go — a line
that is false on three shipped configurations is worse than a vaguer one true on
all of them.

The escalation runs only while nothing has painted: the moment answer text or
reasoning appears, the phase label is back and the second step's sentence is no
longer reachable. It is not announced — the reasoning counter and the settled
answer already speak, and three messages about one wait is what the polite
region's queue exists to prevent.

### ui.background

What happens to a turn when the reader puts the panel away while it is still
running.

```js
ui: { background: 'notify' }   // the shipped value
ui: { background: 'open' }     // the panel comes back on its own
ui: { background: false }      // the turn is abandoned, as it was before 0.4
```

**Closing the panel and stopping the turn are two different intentions, and they
used to share one `abort()`.** That is the defect this setting is the switch for,
and it is worth stating plainly because the symptom did not look like a bug: a
reader who asked a question and put the panel away during retrieval — which is
most of a turn's latency, before the first token — reopened it to

> I couldn't find this in the docs.

That sentence is the [gate's refusal](/concepts/the-gate), and the gate had never
run. An abort *after* the first token has always settled honestly as **Stopped.**;
an abort before it had no state of its own and fell into the refusal. There is no
value of this setting under which the old behaviour was right, which is why the
default changes it rather than preserving it.

| value | the turn | the reader |
|---|---|---|
| `'notify'` | runs to completion | a dot on the trigger, which the next open clears |
| `'open'` | runs to completion | the panel returns by itself, answer in place |
| `false` | abandoned on close | nothing — the pre-0.4 behaviour, refusal included |

`'notify'` ships because the panel's own position is that
[the docs stay readable beside the answer](/guide/panel), and a reader who
closed the panel was reading something. A panel that reopens itself over that page
is the one behaviour this package has always declined to have; `'open'` is for a
site that has decided otherwise, and it is a single word away.

**Stop is still Stop.** The button in the composer, and the `Escape` that stands
in for it while a turn is running, reach the abort directly and are not affected
by any value here. The setting governs the close button, the scrim, the floating
button and the hotkey — the four ways of saying *get off my screen*, none of which
ever asked for anything to end.

The turn also survives **navigation**: the store is a module singleton, so a
reader who moves to another page of your site keeps the turn and finds the dot
waiting on the trigger there. It does not survive a full page load, because
nothing in a browser does.

**What the dot is.** A 10px circle in `--dp-alert` — see
[Appearance](/guide/appearance) — in the corner of whichever
[trigger placement](#ui-trigger) is on the page, or at the end of the row in the
mobile navigation menu. It bounces three times on arrival and then rests; it is
not a count, and it carries `aria-hidden`, because the words that go with it are
in the button's accessible name and a screen reader is told through the panel's
live region as the turn settles. `prefers-reduced-motion` keeps the dot and drops
the bounce.

### ui.credit

One word at the end of the footnote under the composer — **DocPilot**, linked to
[the project](https://docpilot-nine.vercel.app/) — on the same line as the scope
button and the AI disclaimer:

```
All docs · AI-generated. Check the linked pages. · DocPilot
```

It is there from the first open, before any question, because the moment a reader
wants to know what just answered them is the moment they are looking at an empty
panel. The AI disclaimer beside it appears only once a turn exists and is a
separate string — turning the credit off leaves it exactly as it was.

```js
ui: { credit: false }   // no link; the rest of the footnote is unchanged
```

**On by default.** A site that would rather word the attribution itself turns it
off and writes its own line — the [`i18n`](#i18n) key `credit.label` renames it
in place if all you want is different words.

### ui.theme

**`'auto'` is what the panel has always done, and it is still the default.** With
no adapter loaded the core reads `prefers-color-scheme`, which is the only signal
a page without a theme system has. With one, the adapter maps every colour token
to the host's own — `--vp-c-bg`, `--ifm-background-color` — so the panel follows
your site's light/dark toggle with the rest of the site.

`'light'` and `'dark'` overrule both.

```js
ui: { theme: 'auto' }    // the page decides — the shipped value
ui: { theme: 'light' }   // always light, whatever the site and the OS say
ui: { theme: 'dark' }    // always dark, on the same terms
```

`'system'` is accepted as a spelling of `'auto'` and resolves to it, because the
two words name the same thing everywhere else you have met this setting.

| value | what decides the scheme |
|---|---|
| `'auto'` | your site's own toggle where the panel has a host adapter; the reader's OS where it has none |
| `'light'` | nothing — the panel is light on a dark site, and light for a dark-OS reader |
| `'dark'` | nothing — the same, the other way round |

**A pinned panel wears DocPilot's own palette, not your site's**, and it cannot be
otherwise: `--dp-surface` maps to `--vp-c-bg`, and `--vp-c-bg` only holds a dark
value while VitePress is *in* dark mode — so on a light site there is no host
value for a dark pin to read. Three tokens are deliberately left to the host even
under a pin: `--dp-accent-soft`, `--dp-shadow` and `--dp-scrim` have one value for
both schemes, so they stay your brand tint, your elevation and your backdrop.
Pinning a scheme is not the same as discarding a palette.

The pin is a class on `<html>` — `docpilot-light` or `docpilot-dark` — and the
core stylesheet declares the nine tokens that differ between its own light and
dark sets one class deeper than the `:root` an adapter maps on. That is what lets
it win: an adapter beats the core by **loading second**, not by specificity, so a
rule of ours at `:root` would lose on exactly the two hosts with a toggle to
overrule. It also sets `color-scheme` on the panel and the trigger — the caret,
the scrollbar and any native control — and never on `<html>`, because your page's
own scrollbars are not the panel's to repaint.

This is a site-wide setting with no reader-facing switch. A reader who wants the
panel to follow them already has one: their site's own theme toggle, under
`'auto'`.

### ui.font, ui.fontMono

**The panel ships no font of its own.** `--dp-font` is `inherit`, and the panel
is mounted into `<body>`, so with nothing configured it already wears whatever
face the page is set in — the same thing the navbar trigger and the article call
to action have always done. On VitePress and Docusaurus the adapter maps the
token to the host's own family, so the panel follows a theme change with the
rest of the site.

These two settings are for the site the panel cannot inherit from: a `<body>`
that names no font, a theme that sets one on its article container alone, or a
design system that keeps it in a variable.

```js
ui: { font: 'Inter, system-ui, sans-serif' }   // the family list itself
ui: { font: '--brand-font' }                   // the variable you already have
ui: { font: 'var(--brand-font, Inter)' }       // the same, fallback and all
```

A bare `--name` is wrapped into `var(--name)` for you — that wrapper is the one
part of the value with no decision in it.

`fontMono` is the same setting for the code blocks, the reasoning trace and the
prompt disclosure. It has no `inherit` default and should not be given one: a
page has no monospace face for the panel to borrow, so unset it keeps a system
monospace stack.

Both are written onto `<html>` as `--dp-font` and `--dp-font-mono`, **which
outranks a host adapter** — a value here reaches the panel on VitePress and
Docusaurus too, where a `:root` rule of your own in a stylesheet loaded before
the adapter would not. An inline property on the root is one of the two layers
that can; [`ui.theme`](#ui-theme) is the other, and it gets there by specificity
rather than by being inline. A value that could end the declaration or
open another — `;` `{` `}` `<` `>` `@` `*` `\` or `url()` — is reported on stdout
during the build and dropped, and the panel keeps the page's font.

Overriding the token in CSS instead is still supported and is the right move when
the value depends on something only a stylesheet knows — a media query, a
`[data-theme]`, a container. See [Appearance](/guide/appearance#the-tokens).

### ui.panel

`'auto'` follows the trigger: a list with `fab` in it opens the popup, a list
without one opens the drawer. Both keys ship untouched, so the shipped panel is
the **popup** — and a site that sets `trigger: 'nav'` and nothing else gets the
drawer back without touching this key at all. The crossed pairs — `nav` + `popup`, `fab` +
`drawer` — are carried out in silence, which is what `'auto'` is for: once the
implied pairing has a name of its own, an explicit value is an intention rather
than a mistake to correct.

The floating button decides it **even in company**, so `['nav', 'fab']` opens the
popup: the popup is anchored to the corner the floating button sits in, the
drawer is anchored to nothing, and the one placement with a geometric opinion is
the one that holds it. Say `panel: 'drawer'` to overrule that.

A popup with **no** floating button on the page — `trigger: ['nav'], panel:
'popup'` — sits flush against the corner inset instead of reserving room for a
button that is not there.

Below 960px both shapes are the same full-screen sheet, and the floating button
hides itself while it is open.

### ui.fabLabel, ui.fabIcon

A sparkle alone means "AI" to people who already know the pattern and nothing to
everyone else — and unlike the navbar trigger it has no search box beside it to
borrow context from. So it carries words:

```js
ui: { trigger: 'fab', fabLabel: 'Спросить ИИ' }   // exactly these words
ui: { trigger: 'fab', fabLabel: false }           // the 48px circle, icon only
ui: { trigger: 'fab', fabIcon: false }            // words only
```

`fabLabel: true` looks the string up through [i18n](/guide/i18n) as
`trigger.fabLabel` — **Ask AI** by default — so a multilingual site gets it per
locale from the tree it already has. A **string** is taken verbatim and is *not*
looked up: an author who typed the words has already chosen the language. A blank
string is the same as `false`.

`fabIcon: false` and `fabLabel: false` together is the one combination that has no
rendering. It is reported on stdout and the icon is kept: the failure mode of a
cosmetic setting must never be a panel nobody can open.

Both keys describe the **floating** placement only. The navbar trigger has always
been icon-only beside the host's search box and the mobile nav-screen row has
always been text; neither reads them, and `npx docpilot init` still asks only the
two placement questions — its trigger question offers the four words, and a list
is something you write in your own config.

**This is a departure from convention, and worth saying so.** No package in either
dependency tree of this project exposes an enum for placement — placement is
normally the consumer's business, expressed by choosing which slot to fill. Here
the slots belong to `docPilotSlots()`, which runs at import time when
`themeConfig` cannot be read, so an enum is the only way for a consumer to express
the choice at all. [Appearance](/guide/appearance) covers the geometry each value
produces.

## feedbackEndpoint

- **Type:** `string | null`
- **Default:** `null`
- **Related:** [`feedback`](#feedback), [Production](/guide/production#collecting-feedback)

Where a thumbs-up/down POSTs.

Null keeps every vote in `localStorage`, readable from the console with
`window.__docPilot.exportFeedback()`. Set a URL and a vote is POSTed as JSON —
question, verdict, reasons, any sentence the reader wrote, the gate's own numbers,
the model, the prompt hash. The full body, the receiver contract and the SQL are
on [Production](/guide/production#collecting-feedback).

Two keys for one subject, because `feedbackEndpoint` shipped first and a bare
`feedbackEndpoint: '/feedback'` keeps working unchanged. The endpoint is
**where**; [`feedback`](#feedback) is **what** and **whether**.

## feedback

- **Type:** `object`
- **Default:** `{ send: 'both', comment: true, confirm: true }`
- **Related:** [`feedbackEndpoint`](#feedbackendpoint)

```js
feedback: { send: 'both', comment: true, confirm: true }
```

| key | values | |
|---|---|---|
| `send` | `'both'` · `'down'` · `'up'` · `'none'` | Which verdicts leave the device. `'none'` keeps everything local while leaving the thumbs on screen. |
| `comment` | `true` · `false` | Whether a down-vote offers a free-text box. The box is hidden anyway when nothing would be transmitted. |
| `confirm` | `true` · `false` | Whether submitting the form leaves a line saying so. |

### feedback.confirm

Submitting used to remove the form and say nothing a sighted reader could see,
which is indistinguishable from closing it unsent. The line that replaces it
names where the report went, and it says two different things depending on
`send` — because one sentence would be false under two of the four modes.

### feedback.send

**`'both'` is the default because a table of complaints is not a measurement.** A
helpfulness rate needs a denominator, and probes drawn from down-votes alone are a
purely negative sample — calibrating a threshold against one moves the gate toward
refusing every reader. `npx docpilot feedback report` says so in its own output
when it has to. Set `'down'` if you only want to hear about failures and will not
be using the sample to move a threshold.

The panel's disclaimer follows this setting, in the reader's language: no endpoint
or `send: 'none'` says nothing about reports, `'down'` says not-helpful reports
are sent, and `'up'`/`'both'` says the rating is. A reader who is told their
report goes nowhere and finds that it does is entitled to be annoyed.

### feedback.comment

A down-vote opens a form: the four reasons, which are **multi-select** — a wrong
answer is often also an incomplete one — and a text box.

What the reader types is capped at 500 characters and run through the same
credential redaction the question gets, **before** it is stored and before it is
sent. That is not a setting. `credentials.js` exists so the panel can tell a
reader that a pasted key went nowhere, and it names feedback reports as one of the
directions such a key travels; a comment box that shipped raw text would make that
promise false. A key in a comment is replaced with `YOUR_SECRET_KEY` in
`localStorage` and in the request body alike.

### Two POSTs per report, one row

The thumb POSTs immediately — a reader who closes the tab has still been heard —
and the form POSTs again when it is submitted, under the **same `messageId`** with
`revision` raised. Withdrawing a vote posts too, with `verdict: null`, so a reader
can take back what they said.

**Your receiver must upsert on `messageId` and keep the higher revision.** The SQL
that does it is on [Production](/guide/production#collecting-feedback), along with
the two clauses that are load-bearing and easy to leave out.

## prompt

- **Type:** `object`
- **Default:** `{ show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: '' }`

```js
prompt: { show: false, allowAppend: false, appendMaxChars: 500, override: null, extend: '' }
```

Two different things under one key.

### prompt.show, prompt.allowAppend

About the **reader**: whether the instruction is published in the panel, and
whether they may add a line to it for their session. That line never reaches the
system message.

### prompt.appendMaxChars

The ceiling on the reader's own instruction, in characters. It is a `maxlength`
on the field, so it is visible before it is hit rather than after; `0` switches
`allowAppend` off entirely, which is the same thing said twice and is accepted as
such.

### prompt.override, prompt.extend

The instruction the **model** is sent. `override` replaces the shipped text
outright; `extend` is appended to whichever is in force.

**Three rules in the shipped text are load-bearing for the host, not style.** An
override that drops them refuses every turn however good the model is, because the
answer is checked, not the prompt:

- cite every claim with `[1]`, `[2]` matching the citations array;
- return confidence 0 when the excerpts do not answer the question;
- no headings; code in fenced blocks.

An override also drops the credential rules, silently — no host check notices
their absence. After any override, re-run `npx docpilot calibrate`: the gate was
measured against the shipped instruction.

`{product}` is not interpolated into an override. An override is text you wrote in
full, and substituting into it would make `{product}` a syntax you never opted
into.

## host

- **Type:** `{ base?: string, ragBase?: string, article?: string, search?: string|false, content?: string }`
- **Default:** every key `null`
- **Related:** [Sites that are not VitePress](/guide/other-sites)

The four things about your site the panel cannot work out for itself: where it is
served from, and which elements on the page are the article, the search button
and the main content.

```js
host: {
  base: '/docs/',
  article: '.theme-doc-markdown',
  search: '.DocSearch-Button',
}
```

**Every default is `null`, and that is the design.** `null` means *nobody said*,
which has to stay distinguishable from a value you chose — a default of `'main'`
would outrank the `.vp-doc, main` the VitePress binding supplies, and the
selection-to-quote offer would stop appearing on half the pages of a VitePress
site with nothing to explain why.

Three layers resolve, in this order: **what you write here**, then **what the
host binding supplies** — `@cloflin/docpilot/theme` installs one for VitePress,
and the framework adapters install their own — then a neutral fallback. On
VitePress you never set any of these.

### host.base

The site's base path. `/docs/` for a site served in a subdirectory; neutral `/`.

Applied at exactly **two** points — the index fetch and following a citation —
and nowhere else. Paths in the manifest and hrefs in an answer are base-less
everywhere, which is what lets the citation validator compare the two literally.
On VitePress the binding reads it from Vite, so it is already correct.

### host.ragBase

Where the built index is served from. Derived as `${base}rag` — which is what a
static host does with `public/rag` — and set explicitly only when the index lives
somewhere else, a CDN or a separate origin.

This replaces a workaround: the panel used to fetch the literal `/rag`, so a site
at `https://example.com/docs/` had to mount that directory at the root of its
origin in the reverse proxy. It no longer does.

### host.article

The element a selection has to be inside for the panel to offer to quote it —
neutral `main`, `.vp-doc, main` on VitePress.

The nav, the sidebar and the footer are deliberately outside it: *Ask AI* over a
sidebar link is a control offering to ask a question about a menu.

### host.search

The host's own search button, which the panel's degraded and error states offer
as the thing to do instead.

There is no neutral value, because no two sites agree on one — so **without a
selector from either layer the affordance is not rendered at all**. A button that
clicks nothing is worse than no button. Pass `false` to suppress it on a host
whose binding supplies one.

### host.content

The element focus returns to when the panel closes and the control that opened it
has gone with a route change. Neutral `main`, `#VPContent, main` on VitePress.

## i18n

- **Type:** `{ translations?: object, locales?: object }`
- **Default:** `{ translations: {}, locales: {} }`
- **Related:** [Translating the panel](/guide/i18n)

```js
i18n: {
  translations: { empty: { heading: 'How can I help?' } },
  locales: { ru: { translations: { empty: { heading: 'Чем помочь?' } } } },
}
```

The inside is byte-for-byte VitePress's own
[local-search i18n](https://vitepress.dev/reference/default-theme-search#local-search-i18n),
so their example transfers unchanged. The full key table, the two selectors and
the fallback chain are on [Translating the panel](/guide/i18n).

## What reaches the browser

`ai.themeConfig` is compiled into the client bundle. It carries the provider
**adapter** (not the brand), a same-origin base path, the model name, and the
settings above — `ui` crosses already resolved, so `'auto'` never reaches the
browser. It never carries a key or an upstream host.

Three facts about the service travel with it as data rather than as a brand
name: a request-body fragment the adapter merges without reading
([`chat.extraBody`](#chat-extrabody)); whether the service publishes a daily
request ceiling at all; and — the narrower of those two, and the only one
anything acts on — whether this deployment answers off the provider's own **free
pool**, which is what tells the panel there is a [`budget`](#budget) worth
counting and rationing. The wider flag is true for a funded key on the same
service, which has no daily ceiling of any kind; reading it as a free tier is
what once put a paying deployment on one request per turn. None of the three
names who is answering, so the browser still knows adapters and transports rather
than vendors.

Six keys are deliberately withheld — `docsDir`, `indexDir`, `evalDir`,
`importDir`, `sources` and `openapi`. They describe the build, not the panel, and
the allowlist in particular has already done its work by then: the origin it
approved is baked into `manifest.pages[].origin`.

That list is asserted, not remembered: a test walks every key of `DEFAULTS` and
fails unless it is either emitted to the client or named in `SERVER_ONLY`. A
setting that is documented but never sent — which is how `suggestions`, `guard`,
`scope` and `feedbackEndpoint` all shipped once — cannot happen twice.
