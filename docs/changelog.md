---
description: What changed in each release, newest first. The full technical notes for every version are in CHANGELOG.md on GitHub.
outline: 2
---

<script setup>
const gh = (anchor) => `https://github.com/Cloflin/docpilot/blob/main/CHANGELOG.md#${anchor}`
</script>

# Changelog

Each release in a few lines. The full notes — every change, every migration step, every measurement — are in [`CHANGELOG.md`](https://github.com/Cloflin/docpilot/blob/main/CHANGELOG.md), and a tagged release copies its section to [GitHub Releases](https://github.com/Cloflin/docpilot/releases) automatically.

<div class="cl">

## 1.5.0

<div class="cl-date">Oct 25, 2026</div>

### The turn on your own server, a smaller index, and a security pass

- **`runtime: 'server'`.** Retrieval, the gate, the prompt and every key run on your server; the panel posts a question and reads a stream. `npx docpilot serve` runs it, `docker/` runs it against local models. See [The server runtime](/guide/server).
- **The turn log, and four commands that read it**: `traffic`, `dataset`, `model` and `llms`. See [Improving answers](/guide/improving) and [Fine-tuning](/guide/fine-tuning).
- **Security fixes from a full scan.** A key now goes only to the host it belongs to, the dev proxy serves your machine only, `serve` survives malformed requests and withholds the index by real path, `import` checks every redirect, and reader and remote text is escaped. See [Security](/guide/security).
- **One bit per dimension.** Chunk vectors are stored as sign bits when the embedder can afford it: this site's vectors went from 2.3 MB to 292 KB with the same recall. `--quantize=int8` keeps the old format.
- **Conversation memory.** The last answer goes to the model whole; older answers go as one- or two-sentence summaries the model writes itself. See [Conversation memory](/features/memory).
- **Cross-language retrieval.** A question in one language finds sections written in another more often: the embedder now also sees your vocabulary's terms.
- **Enter no longer stops a running answer**, and code blocks in the panel get room to breathe.

<a class="cl-more" :href="gh('150--2026-10-25')">Full notes</a>

## 1.4.0

<div class="cl-date">Sep 4, 2026</div>

### One request per question by default

- A provider named without a model now takes that provider's own default model, instead of a pool the browser walked through one model at a time.
- `chat.chain` ships `false`: a second key in the environment no longer quietly adds a second provider.
- Request accounting and the chain resolver were made exact; a member behind the head no longer inherits a pool it was not given.

<a class="cl-more" :href="gh('140--2026-09-04')">Full notes</a>

## 1.3.0

<div class="cl-date">Sep 3, 2026</div>

### The relevance gate is opt-in

- **`guard.mode` ships as `'off'`.** A floor calibrated on one language refused good questions in another; the gate now scores every turn and refuses only when you opt in. See [Relevance gate](/features/gate).
- A prepared opener that cannot serve its own text still hands the turn its evidence.

<a class="cl-more" :href="gh('130')">Full notes</a>

## 1.2.0

<div class="cl-date">Sep 2, 2026</div>

### Better follow-ups, and feedback you can collect

- A follow-up starts from the evidence the previous turn already retrieved.
- The feedback receiver ships, and `npx docpilot init` copies it into your project.
- Eval reports say what moved, not only how much, and name the embedder they ran on. The golden set grew from 56 to 70 questions.

<a class="cl-more" :href="gh('120')">Full notes</a>

## 1.1.0

<div class="cl-date">Sep 2, 2026</div>

### Measurement you can trust

- Eval reports gain `citationRecall`, cached-token counts and a seed that actually reaches the model.
- `doctor --json`, `lint --json`, `docpilot help <command>`, four exit codes, diagnostics on stderr.
- The empty panel holds five suggestions, not three.

<a class="cl-more" href="https://github.com/Cloflin/docpilot/releases/tag/v1.1.0">Release on GitHub</a>

## 1.0.1

<div class="cl-date">Sep 1, 2026</div>

### Prepared answers and a cheaper rebuild

- The empty panel's questions are answered at build time — a click needs no request. See [Suggestions](/features/suggestions).
- `npx docpilot feedback faq` ranks the questions your readers actually asked.
- A content-addressed embedding cache: a rebuild buys only the chunks that changed.

<a class="cl-more" :href="gh('101--2026-09-01')">Full notes</a>

## 1.0.0

<div class="cl-date">Aug 31, 2026</div>

### TypeScript throughout, and a stable API

- The package is built from TypeScript; every entry point resolves into `dist/`, with hand-checked type declarations.
- `index --html-dir` indexes a site that is already built; `docPilot.openapi` points at your specs.
- A reload keeps a streaming answer and a half-typed question; the status line says *Still working* at 8 and 25 seconds.
- CI runs the full gate on every push and pull request.

<a class="cl-more" :href="gh('100--2026-08-31')">Full notes</a>

## 0.5.0

<div class="cl-date">Aug 29, 2026</div>

### Pin the panel's colours

- `ui.theme` pins the panel to light or dark, in DocPilot's own palette.

<a class="cl-more" :href="gh('050--2026-08-29')">Full notes</a>

## 0.4.0

<div class="cl-date">Aug 28, 2026</div>

### The answer ladder

- A turn never ends empty-handed: when the model is unavailable, the reader gets a search answer with the closest passages.
- `chat: false` — a search-only panel with no model at all.
- Turns outlive the panel (`ui.background`), the vocabulary maps readers' words to your docs' words, and the panel wears your site's font.
- The floating button becomes the default trigger.

<a class="cl-more" :href="gh('040--2026-08-28')">Full notes</a>

## 0.3.3

<div class="cl-date">Aug 27, 2026</div>

### No peer dependencies

- All eleven `peerDependencies` were removed; nothing else changed.

<a class="cl-more" :href="gh('033--2026-08-27')">Full notes</a>

## 0.3.2

<div class="cl-date">Aug 27, 2026</div>

### The provider chain

- `chat.provider: 'auto'` picks a provider from the keys in your environment; every provider carries its own default model.
- The embedding model is discovered from the provider when you name none — it changes the model, never the provider.
- `llamacpp` joins as a provider; `embed: { fallback: 'lexical' }` prefers a word-only index to no index.

<a class="cl-more" :href="gh('032--2026-08-27')">Full notes</a>

## 0.3.1

<div class="cl-date">Aug 27, 2026</div>

### Triggers as a list

- `ui.trigger` accepts a list of placements, and no value can fail a build.
- Every setting is in one table in the configuration reference, checked against the code.

<a class="cl-more" :href="gh('031--2026-08-27')">Full notes</a>

## 0.3.0

<div class="cl-date">Aug 26, 2026</div>

### For any site, not only documentation

- DocPilot is described — and documented — as an assistant for any page: a new [Where it can go](/guide/where-it-goes) guide.
- Every default is written out in one block in the reference.

<a class="cl-more" :href="gh('030--2026-08-26')">Full notes</a>

## 0.2.0

<div class="cl-date">Aug 24, 2026</div>

### Beyond VitePress

- Entry points for Docusaurus, Vue, React, plain JavaScript and a script tag.
- Conversation history, quoting a selection, and a switch for every reader-visible action.
- A block-aware chunker, `docpilot tune`, a pluggable syntax highlighter, and `embed: false`.

<a class="cl-more" :href="gh('020--2026-08-24')">Full notes</a>

</div>

<style>
.cl {
  position: relative;
  padding-left: 28px;
  border-left: 1px solid var(--cf-border);
  margin-left: 6px;
}
.cl h2 {
  position: relative;
  display: inline-block;
  margin: 3rem 0 0 !important;
  padding: 2px 10px;
  border-radius: 7px;
  font-size: 13px !important;
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  background: var(--cf-accent-bg);
  border: 1px solid var(--cf-border);
}
.cl h2:first-child {
  margin-top: 0.5rem !important;
}
.cl h2::before {
  content: '';
  position: absolute;
  left: -35px;
  top: 50%;
  width: 13px;
  height: 13px;
  translate: 0 -50%;
  border-radius: 999px;
  background: var(--cf-background);
  border: 3px solid var(--cf-foreground);
}
.cl h2 .header-anchor {
  display: none;
}
.cl-date {
  display: inline-block;
  margin-left: 10px;
  font-size: 13px;
  color: var(--cf-muted-foreground);
}
.cl h3 {
  margin-top: 0.9rem !important;
  font-size: 1.35rem !important;
}
.cl-more {
  display: inline-block;
  margin-top: 0.25rem;
  font-size: 13px;
}
.cl-more::after {
  content: ' →';
}
</style>
