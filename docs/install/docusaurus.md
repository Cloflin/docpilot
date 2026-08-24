---
title: Docusaurus
---

# Docusaurus

A plugin. No swizzling, no `@theme/Root`, and nothing added to your component
tree.

```bash
npm i @cloflin/docpilot
```

On Yarn, pnpm, Bun or Deno, take that line from
[Installing](/install/#installing-it) instead.

## The settings

```js [docpilot.config.mjs]
export const docPilot = {
  product: 'Acme Editor',
  docsDir: 'docs',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}
```

```bash
npx docpilot index
npx docpilot calibrate
```

The index lands in `docs/public/rag` by default. Docusaurus serves `static/`
rather than `public/`, so point the build at it:

```js
export const docPilot = {
  docsDir: 'docs',
  indexDir: 'static/rag',
  // …
}
```

## The plugin

```js [docusaurus.config.js]
import { defineDocPilot } from '@cloflin/docpilot'
import { docPilot } from './docpilot.config.mjs'

const ai = defineDocPilot(docPilot, process.env)

export default {
  // …
  plugins: [['@cloflin/docpilot/docusaurus', { config: ai.themeConfig }]],
}
```

That is the whole integration. The plugin does three things:

- **`getClientModules()`** mounts the panel and lists its two stylesheets, core
  first and the Docusaurus adapter second — the order is what makes the adapter
  win, because it overrides by cascade rather than by specificity.
- **`injectHtmlTags()`** inlines the client config as `window.__DOCPILOT__`. Safe
  by construction: that object carries no key and no upstream host.
- **`onRouteDidUpdate`** keeps the panel's *this page* scope in step with the
  router.

### Why a plugin and not a theme

The obvious way to put a component on every page is to provide `@theme/Root`.
Only one theme can provide it without wrapping, so a package that does collides
with `docusaurus-theme-search-typesense`, `@docusaurus/theme-live-codeblock` and
anything else that wraps the app — and the symptom for you would be that your
search stops working. A client module needs none of that.

The trade is that a client module cannot call `useDocusaurusContext()`, which is
a React hook. So the locale comes from `<html lang>` and the colour scheme from
`<html data-theme>` — both of which Docusaurus sets itself, and both of which are
the right sources for an imperative host rather than workarounds.

## Options

```js
['@cloflin/docpilot/docusaurus', {
  config: ai.themeConfig,
  highlighter: 'shiki',      // or 'none'
  ragBase: '/rag',           // where the index is served from
  styles: true,              // include the two stylesheets
  selectors: { search: '.DocSearch-Button' },
}]
```

Defaults for the three selectors are `.theme-doc-markdown, main` for the article,
`.DocSearch-Button, .navbar__search-input` for search, and `main` for focus
return. `base` is read from your `siteConfig.baseUrl` — you do not set it.

## Syntax highlighting

**Shiki by default, and on Docusaurus that costs nothing.** The bundle the plugin
loads has Shiki compiled into it already — it has to, because the same artifact
serves a `<script>` tag on a blog — so choosing Prism would save no bytes and
would cost a stylesheet: Docusaurus paints its own code blocks with
`prism-react-renderer`, which applies colour as inline styles and ships no
`.token` CSS at all.

To use Prism anyway, so the panel matches your blocks exactly, add a client module
of your own:

```js [src/docpilot-prism.js]
import { setHighlighter } from '@cloflin/docpilot/web'
import { createPrismHighlighter } from '@cloflin/docpilot/prism'
import 'prismjs/themes/prism.css'

setHighlighter(createPrismHighlighter())
```

```js [docusaurus.config.js]
clientModules: ['./src/docpilot-prism.js'],
```

**It has to be your module, not a plugin option.** Webpack resolves dynamic
imports at build time, so a client module inside this package that so much as
names `@cloflin/docpilot/hljs` would fail the build of every site that has not
installed `highlight.js`. In your own file, your own dependencies resolve.

Importing a Prism theme does not disturb your existing code blocks: Prism scopes
block chrome under `[class*="language-"]`, which this panel never emits, and
Docusaurus's inline styles win over a stylesheet anyway. See
[Syntax highlighting](/reference/highlighting).

## Serving it

Identical to any other deployment — the browser makes the same three requests: the
bundle, `/rag/*`, and the two `/ai/…` endpoints. Docusaurus has no dev proxy for
the third, so even in development the key needs somewhere to live;
[Production](/guide/production) covers the reverse proxy and the failure table.
