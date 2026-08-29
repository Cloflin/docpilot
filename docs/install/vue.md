---
title: Vue
titleTemplate: 'DocPilot for :title'
---

# Vue

A plugin and five components. This is the one adapter that ships **source** —
a Vue project has an SFC compiler by definition, so there is nothing to prebuild
and nothing gets bundled twice.

```bash
npm i @cloflin/docpilot
```

On Yarn, pnpm, Bun or Deno, take that line from
[Installing](/install/#installing-it) instead.

## Mounting

```js [main.js]
import { createApp } from 'vue'
import { DocPilotPlugin } from '@cloflin/docpilot/vue'
import { createShikiHighlighter } from '@cloflin/docpilot/shiki'
import '@cloflin/docpilot/style/core.css'

import App from './App.vue'
import router from './router.js'

createApp(App)
  .use(router)
  .use(DocPilotPlugin, {
    config: __DOCPILOT__,
    router,
    highlighter: createShikiHighlighter(),
  })
  .mount('#app')
```

Shiki is **not** installed by that `npm i` — this package declares no
dependencies on it, so the four packages `@cloflin/docpilot/shiki` imports are
yours to add:

```bash
npm i @shikijs/core @shikijs/engine-javascript @shikijs/langs @shikijs/themes
```

Without them the build fails on `failed to resolve import "@shikijs/core"`. Drop
the `highlighter` line instead and every code block renders as a plain escaped
`<pre>`; [Syntax highlighting](/reference/highlighting) covers Prism and
highlight.js, which are smaller if your app already ships one.

Then place the components:

```vue
<template>
  <DocPilotIcons />               <!-- once, anywhere -->
  <DocPilotTrigger />             <!-- wherever a button belongs -->
  <DocPilot />                    <!-- once, anywhere: it teleports -->
</template>
```

`DocPilotIcons` publishes the `<symbol>` sprite every glyph in the panel
references. Two of it publishes two sets of the same ids; none of it renders a
panel with empty icon buttons. The trigger's own glyph is inline and does not
depend on it, so composing only the trigger still works.

`DocPilotQuote` is the fifth, and renders nothing unless
[`quote.fromDocs`](/reference/config#quote-fromdocs) is on.

## The router

`router` is duck-typed and **`vue-router` is not a dependency of this package**.
Two things are needed from it — a current path and a way to navigate — and both
are stable across Vue Router 3 and 4. The binding *tracks* `currentRoute` rather
than copying it, so there is no watcher to lag behind.

Without a router the panel follows a citation with a full page load, which is
correct for a site that has no router and wrong for yours.

## Where the config comes from

`themeConfig` carries no key and no upstream host, which is what makes it safe to
compile into a bundle:

```js [vite.config.js]
import { defineDocPilot } from '@cloflin/docpilot'
import { docPilot } from './docpilot.config.mjs'

const ai = defineDocPilot(docPilot, process.env)

export default {
  define: { __DOCPILOT__: JSON.stringify(ai.themeConfig) },
}
```

`defineDocPilot().plugin()` is a Vite plugin, and its dev-server half — the
`/ai/*` proxy that attaches your key — works in any Vite project, not only a
VitePress one. Add it to `plugins` and the key never reaches the page in
development. A non-Vite dev server needs that proxy from somewhere else; the rules
are the same ones [Production](/guide/production) states.

## Without a component tree

If you would rather not put anything in your templates:

```js
import { mountDocPilot } from '@cloflin/docpilot/mount'

const panel = mountDocPilot({ config: __DOCPILOT__, router: { go: (h) => router.push(h) } })
router.afterEach((to) => panel.setRoute(to.path))
```

Same API, described on [JavaScript](./javascript).

## The site's seams

```js
.use(DocPilotPlugin, {
  config: __DOCPILOT__,
  router,
  base: '/docs/',
  selectors: { article: 'article.prose', search: '.my-search-button' },
})
```

`base` is applied at exactly two points — the index fetch and following a citation
— and nowhere else. Routes and citation hrefs are base-less everywhere, which is
what lets the citation validator compare them literally. See
[`host`](/reference/config#host).
