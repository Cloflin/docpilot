# Sites that are not VitePress

The package is named for VitePress and most of it does not know what VitePress is. The index is markdown in and static files out; retrieval, the gate and the tool harness are plain ESM modules that run in any browser. What is VitePress-shaped is the mounting: three Vue components that ask the framework four questions.

This page is the whole of what a Docusaurus, Astro, Eleventy, MkDocs or hand-rolled site has to supply. It is more work than `withDocPilot(DefaultTheme)`, and it is not much more.

## The index does not need a site

`npx docpilot index` walks markdown and writes `manifest.json`, chunk shards, vectors and document frequencies. It reads its settings from a config file it looks for in four places:

```
docs/.vitepress/config.mjs
docs/.vitepress/config.js
.vitepress/config.mjs
.vitepress/config.js
```

The name is historical; the requirement is not. The file has to export **`docPilot`** — and nothing else is mandatory:

```js
// docs/.vitepress/config.mjs — a project whose site is not VitePress
export const docPilot = {
  product: 'Acme Editor',
  docsDir: 'docs',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
  embed: 'auto',
}
```

That is enough for `index`, `calibrate`, `lint`, `eval`, `bench` and `doctor`. VitePress does not have to be installed: the CLI reads `.env` and `.env.local` through VitePress's loader **when it is there** and falls back to the process environment when it is not.

### Routes are derived from file paths

A page's route is its path under `docsDir` with `.md` dropped and a trailing `/index` removed — `docs/guide/install.md` becomes `/guide/install`. That value is what a citation links to, so **it has to be the URL your site actually serves**. A generator that publishes `docs/guide/install.md` at `/en/guide/install/` will produce citations that 404, and no amount of retrieval quality fixes that. Check one link before you check anything else.

### A sidebar buys you the scope picker

The default export is optional and is read for exactly one thing: `themeConfig.sidebar`, which is how chunks are grouped into the sections the scope picker offers.

```js
export default {
  themeConfig: {
    sidebar: [
      { text: 'Guide', base: '/guide/', items: [{ text: 'Install', link: 'install' }] },
    ],
  },
}
```

Without it the build reports `sections 0` and every page as an orphan. Retrieval is unaffected — pages, headings and chunks are all still there — and the picker has nothing to offer but *All docs*.

For pages that live on a site you do not build from markdown at all, `npx docpilot import <url>` turns an allowlisted URL into a page of the corpus. See [imported pages](./imported-pages).

## The panel needs four things from your framework

The components import two functions from `vitepress`, and use them for four values:

| what | where it comes from | what it is |
|---|---|---|
| `useData().theme` | your app | a ref holding `{ docPilot: <client config> }` |
| `useData().page` | your router | a ref with `relativePath` — the current page, for the "this page" scope |
| `useData().lang` | your app | a ref with the page locale, e.g. `'en'` |
| `useRouter().go` | your router | follow a citation without a full reload |

So the adapter is a module with two exports:

```js
// src/vitepress-shim.js
import { ref } from 'vue'

const theme = ref({ docPilot: __DOCPILOT__ })   // see below
const page = ref({ relativePath: 'guide/install.md' })
const lang = ref('en')

export function useData() {
  return { theme, page, lang }
}

export function useRouter() {
  return {
    go(href) {
      window.location.href = href        // or your router's navigate()
    },
  }
}
```

Keep `page` and `lang` updated on navigation — they are refs, and the panel watches them: `lang` re-renders its chrome, `page` is what the *this page* scope means.

Point the bundler at it:

```js
// vite.config.js
export default {
  resolve: { alias: { vitepress: '/src/vitepress-shim.js' } },
}
```

The same alias exists in every bundler: `resolve.alias` in webpack, `alias` in Rollup, `paths` in tsconfig for the types.

## Mounting

Import the components directly rather than through `@cloflin/docpilot/theme` — that entry point imports VitePress's default theme, which is the one part of the package that genuinely needs it.

```js
import DocPilot from '@cloflin/docpilot/theme/components/DocPilot.vue'
import DocPilotTrigger from '@cloflin/docpilot/theme/components/DocPilotTrigger.vue'
import DocPilotIcons from '@cloflin/docpilot/theme/components/DocPilotIcons.vue'
import '@cloflin/docpilot/style.css'
```

All three go in the same Vue app: `DocPilotTrigger` wherever a button belongs, `DocPilot` once, anywhere — it renders through a teleport, so its position in your tree does not decide where the panel appears — and `DocPilotIcons` **once**, which publishes the `<symbol>` sprite every glyph inside the panel references. Two of it would publish two sets of the same ids; none of it renders a panel with empty icon buttons. The trigger's own glyph is inline and does not depend on it.

A site with its own design tokens can swap `style.css` for `@cloflin/docpilot/style/core.css` and map the `--dp-*` variables itself; see [appearance](./appearance). The core carries its own `box-sizing: border-box` for the three subtrees it owns, so the panel's hairlines measure the same with or without a host reset.

Vue 3 is a peer dependency and your bundler needs the Vue SFC plugin. Nothing else is required.

## Where the client config comes from

`themeConfig` is the client half of the settings — resolved providers, model names, thresholds, translations. It carries **no key and no upstream host**, which is what makes it safe to compile into a bundle. Produce it at build time from the same `docPilot` object the CLI reads:

```js
// vite.config.js
import { defineDocPilot } from '@cloflin/docpilot'
import { docPilot } from './docs/.vitepress/config.mjs'

const ai = defineDocPilot(docPilot, process.env)

export default {
  define: { __DOCPILOT__: JSON.stringify(ai.themeConfig) },
  resolve: { alias: { vitepress: '/src/vitepress-shim.js' } },
}
```

When nothing is configured — no key, no index — `themeConfig` is `{ enabled: false }`, the trigger renders nothing and your site builds exactly as before. That is the same behaviour VitePress projects get, and it is worth keeping: it is what makes a broken environment a missing panel rather than a broken site.

`defineDocPilot().plugin()` is a Vite plugin, and its dev-server half — the `/ai/*` proxy that attaches your key — works in any Vite project, not only VitePress. A non-Vite dev server needs that proxy from somewhere else; the two rules are the same ones [production](./production) states.

## What the shim does not give you

- **`withDocPilot` and the theme slots.** VitePress-only, by construction. You place the components yourself, which you were going to do anyway.
- **The "Search the docs" button** in the panel's degraded and error states clicks `.VPNavBarSearchButton, .DocSearch-Button`. With DocSearch on the page it works; without either, it does nothing. Nothing else in the panel depends on a selector from another package.
- **Locale detection.** VitePress knows the page's language; your shim decides what `lang` holds. Whatever you put there selects the panel's translations — the reply copy still follows the language the reader typed.

## Serving it

Identical to a VitePress deployment, because the browser makes the same three requests: the bundle, `/rag/*`, and the two `/ai/…` endpoints. [Production](./production) covers the reverse proxy, the cache rules for the index, the container and the failure table.
