---
title: JavaScript
---

# JavaScript

One function, for any site with a bundler. This is the layer every other adapter
is built on — the Vue plugin, the React component and the Docusaurus client
module all end up here.

```bash
npm i @cloflin/docpilot
```

On Yarn, pnpm, Bun or Deno, take that line from
[Installing](/install/#installing-it) instead.

## Two entry points, one API

```js
import { mountDocPilot } from '@cloflin/docpilot/mount'   // source
import { mountDocPilot } from '@cloflin/docpilot/web'     // prebuilt
```

They are the same function. The difference is what your bundler has to do:

- **`/mount` ships source** and imports `.vue` files. Use it if your bundler has
  the Vue SFC plugin — Vite, Rollup, Nuxt, most Astro setups. Nothing is bundled
  twice, and Vue comes from your own dependencies.
- **`/web` ships prebuilt**, with Vue and Shiki compiled in. Use it if it does
  not — webpack, Turbopack, esbuild, Parcel. About 150 KB gzipped, loaded lazily.

Everything below applies to both.

## Mounting

```js
import { mountDocPilot } from '@cloflin/docpilot/mount'
import '@cloflin/docpilot/style/core.css'

const panel = mountDocPilot({
  config: window.__DOCPILOT__,
  route: location.pathname,
})
```

With no `target`, a `div` is created and appended to `<body>`. Everything visible
teleports there anyway, so the node holds nothing — but it has to be **in** the
document, because a teleport resolves its destination on mount.

`mountDocPilot` returns an inert handle when there is no `document`, so the module
is safe to import in an SSR pass without a guard at every call site. It also
mounts nothing at all when `config.enabled` is `false`, which is what
`defineDocPilot` emits when nothing is set up.

## The handle

```js
panel.open()
panel.close()
panel.toggle()
panel.ask('How do I install this?')   // fills the composer; does NOT submit
panel.setRoute('/guide/install')
panel.setLang('de')
panel.setConfig(nextConfig)
panel.destroy()
```

`ask` does not submit on purpose: the reader reads what somebody else wrote before
it is asked on their behalf. The same rule the `?dp-ask=` deep link follows.

## Keeping it in step

The panel needs to be told about navigation — that is what *this page* means when
the reader narrows the scope:

```js
router.afterEach((to) => panel.setRoute(to.path))         // Vue Router
history.listen((location) => panel.setRoute(location.pathname))  // History API
```

`setRoute` takes a **base-less** route. On a site served from a subdirectory, pass
`base` once at mount and keep passing bare routes.

## Every option

```js
mountDocPilot({
  config: window.__DOCPILOT__,   // ai.themeConfig from defineDocPilot
  target: document.querySelector('#panel'),
  trigger: 'fab',                // 'fab' | 'nav' | 'none'
  route: '/guide/install',       // base-less
  lang: 'en',                    // read from <html lang> when omitted
  base: '/docs/',
  ragBase: 'https://cdn.example.com/rag',
  selectors: { article: 'article', search: '.search', content: 'main' },
  router: { go: (href) => myRouter.navigate(href) },
  highlighter: createShikiHighlighter(),
})
```

`base` is applied at exactly two points — the index fetch and following a citation
— and nowhere else. `ragBase` overrides the first of those; set it when the index
does not live under your site. `selectors` are described under
[`host`](/reference/config#host).

## Your own trigger

```js
const panel = mountDocPilot({ config, trigger: 'none' })
document.querySelector('#ask').addEventListener('click', () => panel.open())
```

## Syntax highlighting

`/mount` installs nothing; `/web` installs Shiki. Either way:

```js
import { createHljsHighlighter } from '@cloflin/docpilot/hljs'

mountDocPilot({ config, highlighter: createHljsHighlighter() })
```

With no highlighter, every code block renders as a plain escaped `<pre>` with its
copy button — the same shape an unsupported language already produces, not a
broken state. See [Syntax highlighting](/reference/highlighting).

## Composing the pieces yourself

`mountDocPilot` creates a Vue app. If you already have one, use
[the Vue plugin](./vue) instead, or install the host binding directly:

```js
import { setHost, createStandaloneHost } from '@cloflin/docpilot/host'

const host = createStandaloneHost({ theme: { docPilot: config }, route: '/', lang: 'en' })
setHost(host.factory, { base: '/docs/', selectors: { article: 'article' } })
host.update({ route: '/guide/install' })   // on every navigation
```

That is the whole contract the panel has with a host: four reactive values and a
`go`. Everything else in this package is built on top of it.
