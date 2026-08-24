# Getting started

## Overview

DocPilot is a grounded AI answer panel for documentation. It consists
of three parts:

- **A build step** that turns your markdown into a static retrieval index, and a
  Vite plugin that mounts the panel, proxies the model call in development, and
  reports at build time whether the panel will render at all.

- **A browser-side retriever** that scores a question against that index without
  a vector database, a search service, or any server beyond the one already
  serving your site.

- **A calibrated gate** that refuses before the model is called, so an off-topic
  question costs zero tokens — and a validator that checks every citation the
  reader sees against what the host actually retrieved that turn.

The rationale is in [Why DocPilot](./why), and the rules the project holds itself
to are in [Philosophy](./philosophy). What follows is the ten minutes it takes to
have it running **on VitePress**.

::: tip Not VitePress?
Only the mounting differs. [Installing](/install/) has a page each for
[Docusaurus](/install/docusaurus), [Vue](/install/vue), [React](/install/react),
[JavaScript](/install/javascript), [TypeScript](/install/typescript) and a bare
[`<script>` tag](/install/web) — and the config, the index and the calibration
below are identical on all of them.
:::

## Installing

DocPilot needs **Node 20 or newer**; the package declares `engines.node: ">=20"`.

| manager | install | init |
|---|---|---|
| npm | `npm i @cloflin/docpilot` | `npx docpilot init` |
| Yarn | `yarn add @cloflin/docpilot` | `yarn docpilot init` |
| pnpm | `pnpm add @cloflin/docpilot` | `pnpm exec docpilot init` |
| Bun | `bun add @cloflin/docpilot` | `bunx docpilot init` |
| Deno | `deno add npm:@cloflin/docpilot` | `deno run -A npm:@cloflin/docpilot init` |

`pnpm exec`, not a bare `pnpm docpilot`: `pnpm run` executes the scripts in `package.json`, `pnpm exec` runs a bin. Every `init` line runs the bin the install line beside it just put in the project — none of them fetches the package a second time, and none of them runs the unscoped `docpilot`, which is a different name on the registry and not this package.

`init` scaffolds the whole loop and never overwrites: `.env.example`, a starter golden set and calibration set under `docpilot/`, and the two authoring skills into `.claude/skills/`. Every file is reported as written or kept.

## Wiring the config

```js
// docs/.vitepress/config.mjs
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

Two details are load-bearing.

**`docPilot` is exported by name.** The CLI imports it from this file, so the index is built with the model the site queries with. A second copy of that decision is a copy that drifts, and the failure is silent: a query scored against a foreign vector space degrades retrieval to keyword matching, and a calibrated gate then refuses questions your docs can answer, with nothing in the UI to say why.

**`loadEnv` is called by you, not by the plugin.** `defineDocPilot` reads whatever object you hand it, defaulting to `process.env`. A package that decided which `.env` files your project has would be wrong for half of them.

`embed` is absent on purpose. It defaults to `'auto'`, which embeds with the chat provider's own embedding model — `text-embedding-3-small` for OpenAI — so a single-provider setup needs no second decision and no second key. Where the chat provider serves no embeddings endpoint at all, `'auto'` borrows OpenRouter's free embedding pool and the build says so. Naming a second provider, or none, is [Choosing providers](./providers).

`product` is optional and worth setting: it is what the assistant says it answers questions about, in the instruction and in the panel. Left out, everything reads "this documentation", which is correct and dull.

## Wiring the theme

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme'

export default withDocPilot(DefaultTheme)
```

`withDocPilot` wraps a theme you already have; slots it fills survive, except the four the panel claims — `layout-bottom`, `nav-bar-content-before`, `nav-screen-content-after` and `doc-footer-before`. `layout-bottom` carries two components: the panel itself and the floating button, which renders only when you ask for it.

That import also pulls in `dist/docpilot.css`. If you would rather assemble the styles yourself — no VitePress, or your own token mapping — import `@cloflin/docpilot/theme-without-styles` and one of the two halves in `style/`. See [Appearance](/guide/appearance).

If you have no theme of your own, the package's default export is one:

```js
export { default } from '@cloflin/docpilot/theme'
```

## Building the index

```bash
npx docpilot index
```

This reads your markdown (and any OpenAPI YAML under `public/`), chunks it, embeds every chunk, and writes `docs/public/rag/`. Commit the output or build it in CI — it is a deploy artefact, and identical input produces byte-identical output, so it diffs cleanly.

## Calibrating the gate

```bash
npx docpilot calibrate
```

Until this has run, the refusal thresholds are provisional values measured against a different corpus, and every record says so. **Thresholds do not transfer between projects.** See [Calibration and evaluation](/guide/evaluation).

## The whole loop

```bash
npx docpilot index       # build the index
npx docpilot calibrate   # measure the refusal thresholds on YOUR corpus
npx docpilot lint        # check the golden set against the index it measures
npx docpilot eval        # run the golden set, write a report
npx docpilot bench       # A/B two retrieval configurations, no key needed
npx docpilot tune        # sweep the retrieval levers — and then index again
```

The first two are what the panel needs to work at all. The three after them are what tells you whether it works well, and they are the half that gets skipped — which is how a gate ends up shipping on provisional thresholds forever with nobody finding out.

`tune` is for when it is retrieval itself that has to move: it sweeps the levers against the golden set into `docpilot/tuning.json`, with a report of the grid beside it. **Then run `index` again** — that is the step that inlines `tuning.json` into the manifest a reader downloads, and until it runs a swept lever is a file on disk and nothing more.

## Going to production

`vitepress dev` proxies `/ai/*` for you. A built site does not, and `vitepress preview` has no proxy at all — so the panel stops working at exactly the point nobody is watching. `npx docpilot doctor --proxy` prints the contract; [Production](/guide/production) explains it.

## Nothing set up yet?

The build does not fail. The panel switches itself off and one block appears:

```
[docpilot] the panel is OFF — 2 things to set up:

  · chat: "openai" needs a key and none is set
      export OPENAI_API_KEY=…
  · no index at docs/public/rag
      npx docpilot index

  The site builds and every other feature is untouched.
```

That is deliberate. A dependency that can break someone's docs build on the day it lands is a dependency they remove. When you want the same facts to fail a pipeline, `npx docpilot doctor` exits non-zero.

## Next steps

- A site that is not VitePress: [Installing](/install/).
- Which highlighter colours the code in an answer: [Syntax highlighting](/reference/highlighting).
- Two providers instead of one, or none at all: [Choosing providers](./providers).
- What ends up in the index, and what to put in frontmatter to help it: [Building the index](./indexing).
- What happens between a question and an answer: [How a turn works](/concepts/a-turn).
- Something not working: [Troubleshooting](./troubleshooting).
