# Getting started

## Install

```bash
npm i vitepress-plugin-ask-ai
npx ask-ai init
```

`init` writes `.env.example` and prints the next step. It touches nothing else.

## Wire the config

```js
// docs/.vitepress/config.mjs
import { defineConfig, loadEnv } from 'vitepress'
import { defineAskAI } from 'vitepress-plugin-ask-ai'

export const askAI = {
  chat:  { provider: 'openai', model: 'gpt-4o' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}

const ai = defineAskAI(askAI, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { askAI: ai.themeConfig },
})
```

Two details are load-bearing.

**`askAI` is exported by name.** The CLI imports it from this file, so the index is built with the model the site queries with. A second copy of that decision is a copy that drifts, and the failure is silent: a query scored against a foreign vector space degrades retrieval to keyword matching, and a calibrated gate then refuses questions your docs can answer, with nothing in the UI to say why.

**`loadEnv` is called by you, not by the plugin.** `defineAskAI` reads whatever object you hand it, defaulting to `process.env`. A package that decided which `.env` files your project has would be wrong for half of them.

## Wire the theme

```js
// docs/.vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import { withAskAi } from 'vitepress-plugin-ask-ai/theme'

export default withAskAi(DefaultTheme)
```

`withAskAi` wraps a theme you already have; slots it fills survive, except the four the panel claims — `layout-bottom`, `nav-bar-content-before`, `nav-screen-content-after` and `doc-footer-before`.

If you have no theme of your own, the package's default export is one:

```js
export { default } from 'vitepress-plugin-ask-ai/theme'
```

## Build the index

```bash
npx ask-ai index
```

This reads your markdown (and any OpenAPI YAML under `public/`), chunks it, embeds every chunk, and writes `docs/public/rag/`. Commit the output or build it in CI — it is a deploy artefact, and identical input produces byte-identical output, so it diffs cleanly.

## Calibrate

```bash
npx ask-ai calibrate
```

Until this has run, the refusal thresholds are provisional values measured against a different corpus, and every record says so. **Thresholds do not transfer between projects.** See [Calibration and evaluation](/guide/evaluation).

## Nothing set up yet?

The build does not fail. The panel switches itself off and one block appears:

```
[ask-ai] the panel is OFF — 2 things to set up:

  · chat: "openai" needs a key and none is set
      export OPENAI_API_KEY=…
  · no index at docs/public/rag
      npx ask-ai index

  The site builds and every other feature is untouched.
```

That is deliberate. A dependency that can break someone's docs build on the day it lands is a dependency they remove. When you want the same facts to fail a pipeline, `npx ask-ai doctor` exits non-zero.
