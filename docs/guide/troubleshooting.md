# Troubleshooting

Start with the one command that answers most of this without a build:

```bash
npx docpilot doctor
```

It prints what was resolved — provider, model, index, key — and either confirms
the panel will render or lists what is missing, each with the command or variable
that fixes it. It exits non-zero when the panel is not ready, which is what makes
it usable in CI. `--proxy` adds the contract a production reverse proxy has to
satisfy.

Deployment-specific symptoms — 404s, 401s, 502s, buffering, CORS, rate limits —
are on [Production](./production#when-it-does-not-work), which has the nginx and
Caddy rules beside them.

## The build

### `[docpilot] the panel is OFF — N things to set up`

Not an error. The site builds, every other feature is untouched, and the block
names each missing piece with its fix — usually a key that is not exported, or an
index that has not been built yet:

```bash
npx docpilot index
```

The build never fails for these on purpose: a dependency that can break someone
else's docs build on the day it lands is a dependency they remove. Run
`npx docpilot doctor` to turn the same facts into a non-zero exit.

One cause of this block is worth naming because it looks like nothing:
**you built with `npx docpilot index --no-embed` and left the config naming an
embedder.** That pairing is refused rather than warned about — the deployment
would embed every question and have nothing to score it against — so the panel
is switched off until the config says [`embed: false`](/reference/config#embed-false)
as well.

### `embed: "openrouter" needs a key and none is set` — on a provider you never named

Not a bug. The chat provider answers but does not retrieve — `anthropic`,
`deepseek`, `groq`, `xai` and `cerebras` all do — so `embed: 'auto'` borrows
OpenRouter's free embedding pool for the retrieval half. Set the key:

```bash
OPENROUTER_API_KEY=…     # free tier; the index only
```

The startup block and `npx docpilot doctor` both name the borrow:

```
[docpilot] embed  openrouter/auto — 2 free, nvidia/nemotron-3-embed-1b:free first   …   (auto — anthropic cannot embed, borrowed from openrouter)
```

Read that as **the text of every chunk is posted to OpenRouter at build time**.
Questions still go to the chat provider. If your corpus may not leave for a third
party, name an embedder instead — an explicit `embed` is never rewritten:

```js
export const docPilot = {
  chat:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}
```

Then rebuild the index. A project-scoped key limited to chat models hits the same
wall with a provider that *does* embed, and the split is the fix there too. See
[Choosing providers](./providers).

### `embed.provider "…" has no embeddings endpoint`

You named one explicitly, and it cannot. Only the *unnamed* case borrows the free
pool; a provider you wrote down is a sentence this package will not rewrite.
Point `embed` at a service that embeds, or drop the setting and let `auto` fall
through to the free pool.

### `chat.provider "…" is not a provider this build knows`

A typo. It stops the build rather than quietly becoming a local Ollama nobody is
running. The message lists every known id.

### `sidebar link has no indexed content: /path`

A sidebar entry pointing at a page with zero chunks — a stub, a renamed file, or
a link to a route the index does not have. The entry is dropped from the scope
picker and the build continues. Fix the link or give the page content.

### Suggestions, `ui` values or `i18n` keys reported on stdout

All three are applied-or-named, never silently discarded. Extra `suggestions`
beyond the first three, a `ui` value outside its enum, an `i18n` key that does not
exist: each is dropped, and each is printed. Nothing throws, because a typo in a
cosmetic setting must not be able to fail a docs build.

## The panel

### The panel is not on the page at all

Four things have to be true, in this order: `enabled` is not `false`, a key is
resolvable for the chat provider, `docs/public/rag/` exists, and the theme is
wrapped:

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme'

export default withDocPilot(DefaultTheme)
```

`doctor` covers the first three. For the fourth, the usual cause is a custom
theme that fills the same slots — the panel claims `layout-bottom`,
`nav-bar-content-before`, `nav-screen-content-after` and `doc-footer-before`, and
a theme that replaces VitePress's `VPNav` may never render the navbar slot at
all. When that happens the trigger has nowhere to go: switch to `ui:
{ trigger: 'fab' }`, which mounts in `layout-bottom`.

### *AI answers are off in this environment*

The panel is mounted but `/rag/*` did not load — a 404, or a manifest cached from
an older deploy. See [Production](./production#serving-the-index) for the cache
rules the index needs: the shards are content-hashed and immutable, the manifest
is not.

### It works in `vitepress dev`, not in `vitepress preview`

Expected. `vitepress dev` installs a proxy that attaches the key; `preview` has
no proxy at all, and a built site does not carry one. This is not a bug to work
around by moving the key into `themeConfig` — that publishes it. Run
`npx docpilot doctor --proxy` for the two rules production needs.

## Retrieval

### Every question is refused

Four causes, in the order worth checking.

**This site declared `embed: false`.** Then every turn is lexical-only by design
and `tauLexical` is the *entire* gate — not the fallback it is on a hybrid site,
where a bad value only bites during an outage. An uncalibrated lexical-only index
ships the provisional `tauLexical` 0.3 and over-refuses permanently. Run
`npx docpilot calibrate`: on a vectorless index it sweeps that one threshold and
nothing else. The panel is not reporting an outage — see
[No embedder at all](/guide/providers#no-embedder-at-all).

**The thresholds are provisional.** Until `npx docpilot calibrate` has run
against your own index, the gate uses values measured on a different corpus and
every record says so. Thresholds do not transfer between projects.

**The embedder does not match the index.** `embed.model` must be the model that
built the index. A query scored against a foreign vector space degrades retrieval
to keyword matching, which the gate then reads as no support. The index records
which embedder it was built for, so `docpilot index` catches the mismatch — but a
config edited after the last build will not have been checked.

**A `prompt.override` dropped a load-bearing rule.** Three rules in the shipped
instruction are host contracts, not style: cite every claim with markers matching
the citations array, return confidence 0 when the excerpts do not answer, and no
headings. An override without them refuses every turn however good the model is,
because the answer is checked rather than the prompt. Re-run `calibrate` after
any override — the gate was measured against the shipped text.

### A follow-up is refused

`and for backend calls?` retrieves nothing on its own, so the gate scores the
maximum of the raw question and the question composed with the previous one. That
can only reduce refusals — but admissibility still applies: at least one content
word of the tail must appear in the retrieved evidence. `and for AWS S3
buckets?` is refused by design when your corpus does not document S3.

If the reader is asking about a specific passage, quoting it is the better path —
a selected passage composes with the follow-up in place of the previous question.
See [The refusal gate](/concepts/the-gate#follow-ups).

### A question refuses in one scope and answers in another

That is `out-of-scope`, and it is only claimed when it has been computed: the
panel offers a button that widens and resubmits. If you would rather every
question searched the whole corpus, `scope: { enabled: false }` removes the
picker.

### Retrieval feels like keyword matching

First, which of the two is it. On a site configured `embed: false` retrieval **is**
keyword matching, by declaration, and nothing is wrong — `npx docpilot doctor`
says so in one line, and [No embedder at all](/guide/providers#no-embedder-at-all)
is the page for it. Everywhere else, check that the embedding call is actually
reaching a model: the browser console names the service and the model when it
cannot, and the panel marks its refusals degraded.

Dropping the embedder was measured on a 1191-chunk corpus: recall@8 fell from 0.97
to 0.41 and 11 of 44 answerable questions were refused outright. A question asked
in a language your corpus is not written in scores zero on the lexical channel
alone, so this shows up first for multilingual readers.

## Answers

### An answer was generated but not shown

An answer with no surviving citations becomes a refusal. Citations are checked
against the set of chunk ids the host itself put in front of the model during
that turn; an id the model invented is stripped, and its marker with it. When
nothing survives, there is no cited answer left to show — which is exactly what
the guardrail exists to withhold.

Small models produce this most often. It is visible in an evaluation run before
it is visible to a reader: [Calibration and evaluation](./evaluation).

### Links in an answer render as plain text

The same mechanism, one layer out. A route the model invented is de-linked in the
markdown-it token stream, before anything renders. If a link you expect to work
is being stripped, the page is not in the index — check that it is indexed and
that the path matches what `docpilot index` wrote.

### The answer is marked tentative

A low-confidence answer that *is* cited is kept and marked. Confidence is the
weakest signal in the system — a number the model writes about its own work — and
deleting a checkable answer on that basis costs the whole turn.

## Still stuck

Run the loop. `npx docpilot lint` checks the golden set against the index it
measures, `npx docpilot eval` produces a report with the gate's own numbers, and
`npx docpilot bench` A/Bs two retrieval configurations with no key at all. Most
questions of the form "is this as good as it should be" have a number waiting in
[Calibration and evaluation](./evaluation).
