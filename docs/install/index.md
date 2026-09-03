---
title: Installing
---

# Installing

DocPilot has two halves, and only one of them cares what your site is built with.

**The index does not need a site.** `npx docpilot index` walks markdown and writes
static files. Retrieval, the refusal gate and the tool harness are plain ESM
modules that run in any browser. None of it knows what a VitePress is.

**The panel needs a page.** Four answers, really: what is configured, what page
is this, what language is it in, and how do I navigate — and three of the four
have a default it works out on its own (`location.pathname`, `<html lang>`, a
full page load). Every page below is about supplying them properly.

**And it answers from the index, not from the page it is on.** Mounted on a
pricing page it still answers from the markdown you indexed, which is usually
exactly what you want — and is worth knowing before you mount it somewhere your
corpus does not cover. [Where it can go](/guide/where-it-goes) is the page about
that.

## Installing it

One package for both halves. The CLI that builds the index and the panel that
reads it ship together on purpose: split across two installs they drift — the
index gets rebuilt with a different embedding model, or the gate keeps thresholds
measured against a corpus that has since doubled — and nothing says so until a
reader is told the docs do not cover something they do.

::: code-group

```bash [npm]
npm i @cloflin/docpilot
npx docpilot init
```

```bash [Yarn]
yarn add @cloflin/docpilot
yarn docpilot init
```

```bash [pnpm]
pnpm add @cloflin/docpilot
pnpm exec docpilot init
```

```bash [Bun]
bun add @cloflin/docpilot
bunx docpilot init
```

```bash [Deno]
deno add npm:@cloflin/docpilot
deno run -A npm:@cloflin/docpilot init
```

:::

**Node 20 or newer.** That is the `engines.node` the package declares, and the
CLI is written against it.

`pnpm exec`, not `pnpm run docpilot`: `pnpm run` executes scripts out of your
`package.json`, and `pnpm exec` is the one that runs an installed bin.

The scope is part of the name everywhere it appears. Unscoped `docpilot` is not
this package, which is why no line above reaches for a package by bare name —
`npx docpilot` works only because the install on the line above it put that bin
in `node_modules/.bin`.

[`init`](/reference/cli#init) scaffolds the eval sets, the key names and the
authoring skills, and never overwrites. It asks which agent tool the skills go
into — Claude Code, Codex, Cursor, Copilot — and installs a `/docpilot-*` slash
command per CLI command beside them. It is safe to skip on a first look and
safe to run twice; [`update`](/reference/cli#update) is what refreshes the
copied skills after an upgrade.

### Deno

The `npm:` specifier is the only supported way in, and there is no JSR package —
none is planned. DocPilot ships `.vue` source files and reaches them through an
exports map, which is exactly what Deno's npm compatibility layer resolves and
what a JSR publish would have to reimplement.

## Which entry point is yours

The question is **not which framework you use**. It is whether your bundler can
compile a `.vue` file, because the panel is written in Vue and ships its
components as source.

| your setup | entry point | why |
|---|---|---|
| [VitePress](./vitepress) | `@cloflin/docpilot/theme` | a theme, five lines, nothing else to decide |
| [Docusaurus](./docusaurus) | `@cloflin/docpilot/docusaurus` | webpack, no `.vue` loader → a prebuilt bundle |
| [Vue](./vue) | `@cloflin/docpilot/vue` | you already compile `.vue` |
| [React](./react) | `@cloflin/docpilot/react` | prebuilt, and no Vue anywhere in your tree |
| [JavaScript](./javascript) | `@cloflin/docpilot/mount` | any bundler with the Vue plugin |
| [Web](./web) | `dist/docpilot.web.js` | a `<script>` tag, no bundler at all |
| [TypeScript](./typescript) | — | types for every entry above |

If you are unsure, the honest test is one line in your bundler config: if
`@vitejs/plugin-vue`, `vue-loader` or `@rollup/plugin-vue` is already there, use
`/mount` or `/vue` and ship source. If it is not, use `/web` and ship the
prebuilt bundle — about 150 KB gzipped with Vue inside, loaded lazily, and a
reader who never opens the panel pays for none of it.

## What every host does the same way

Whichever page you follow, three steps are identical.

### 1 · The settings — optional

There may be none. `chat.provider` ships as `'auto'`, which reads your
environment and takes the first service in
[the provider chain](/guide/providers#name-nothing-the-provider-chain) that a key
is set for; that service's default model and embedder come with it.

```bash [.env.local]
OPENAI_API_KEY=sk-…
```

When you do have settings, export them **by name**:

```js [docpilot.config.mjs]
export const docPilot = {
  product: 'Acme Editor',
  docsDir: 'docs',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}
```

The CLI looks for this file in six places, in order — the four VitePress config
paths first, then `docpilot.config.mjs` and `docpilot.config.js` at your project
root. A VitePress project keeps its settings in its own config and needs no
second file.

**The named export is the contract.** The CLI imports it, so the index is built
with the model the panel queries with. A second copy of that decision is a copy
that drifts, and the failure is silent: a query scored against a foreign vector
space degrades retrieval to keyword matching, and a calibrated gate then refuses
questions your docs can answer.

### 2 · The index

```bash
npx docpilot index       # build the index
npx docpilot calibrate   # measure the refusal thresholds on YOUR corpus
```

A page's route is its path under `docsDir` with `.md` dropped and a trailing
`index` collapsed — `docs/guide/install.md` becomes `/guide/install`. That value
is what a citation links to, so **it has to be the URL your site actually
serves**. A generator that publishes `docs/guide/install.md` at
`/en/guide/install/` produces citations that 404, and no amount of retrieval
quality fixes it. Check one link before you check anything else.

### 3 · The client config

`themeConfig` is the client half — resolved providers, model names, thresholds,
translations. It carries **no key and no upstream host**, which is what makes it
safe to compile into a bundle.

```js
import { defineDocPilot } from '@cloflin/docpilot'
import { docPilot } from './docpilot.config.mjs'

const ai = defineDocPilot(docPilot, process.env)
// ai.themeConfig  →  the object every entry point below takes
```

When nothing is configured — no key, no index — `themeConfig` is
`{ enabled: false }`, nothing mounts, and your site builds exactly as before.
That is deliberate: a dependency that can break someone's build on the day it
lands is a dependency they remove.

## Then the parts that differ

- **Where the panel mounts**, which is what the pages below are mostly about.
- **[Syntax highlighting](/reference/highlighting)** — Shiki, Prism or
  highlight.js, or your own. Nothing is installed by default except on VitePress
  and in the prebuilt bundle.
- **[`host`](/reference/config#host)** — the site's base path and the three DOM
  selectors the panel cannot guess. The VitePress theme and the Docusaurus plugin
  fill these in; everywhere else you may need one or two.
- **[Appearance](/guide/appearance)** — one stylesheet on real values, plus an
  adapter that maps them to your host's tokens.
- **[Production](/guide/production)** — the reverse proxy that holds your key.
  Identical on every host, because the browser makes the same three requests.
