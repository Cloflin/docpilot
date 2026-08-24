# A host of your own

There is an adapter for VitePress, Docusaurus, Vue, React, plain JavaScript and a
bare `<script>` tag — [Installing](/install/) picks between them. This page is
what is left when none of those fits: the contract the panel has with a host, and
the two things about the index that are the same everywhere.

::: tip This page used to be a workaround
It documented aliasing the bare specifier `vitepress` at your bundler to a
hand-written shim module. That is gone. The components import a binding now, so
nothing has to pretend to be VitePress, and the shim's `useData()` shape is no
longer what they consume.
:::

## The index does not need a site

`npx docpilot index` walks markdown and writes `manifest.json`, chunk shards,
vectors and document frequencies. It reads its settings from a config file it
looks for in six places, in order:

```
docs/.vitepress/config.mjs
docs/.vitepress/config.js
.vitepress/config.mjs
.vitepress/config.js
docpilot.config.mjs
docpilot.config.js
```

The VitePress paths come first because that is where an existing project already
keeps the settings, and the CLI reading the same object the site builds with is
what stops the index and the runtime drifting onto different embedders. A project
with no VitePress uses the last two. Either way the file has to export
**`docPilot`** by name — and nothing else is mandatory:

```js [docpilot.config.mjs]
export const docPilot = {
  product: 'Acme Editor',
  docsDir: 'docs',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
  embed: 'auto',
}
```

That is enough for `index`, `calibrate`, `lint`, `eval`, `bench` and `doctor`.
VitePress does not have to be installed: the CLI reads `.env` and `.env.local`
through VitePress's loader **when it is there** and falls back to the process
environment when it is not.

### Routes are derived from file paths

A page's route is its path under `docsDir` with `.md` dropped and a trailing
`index` collapsed — `docs/guide/install.md` becomes `/guide/install`, and
`docs/index.md` becomes `/`. That value is what a citation links to, so **it has
to be the URL your site actually serves**. A generator that publishes
`docs/guide/install.md` at `/en/guide/install/` will produce citations that 404,
and no amount of retrieval quality fixes that. Check one link before you check
anything else.

### A sidebar buys you the scope picker

The config's default export is optional and is read for exactly one thing:
`themeConfig.sidebar`, which is how chunks are grouped into the sections the scope
picker offers.

```js
export default {
  themeConfig: {
    sidebar: [
      { text: 'Guide', base: '/guide/', items: [{ text: 'Install', link: 'install' }] },
    ],
  },
}
```

Without it the build reports `sections 0` and every page as an orphan. Retrieval is
unaffected — pages, headings and chunks are all still there — and the picker has
nothing to offer but *All docs*.

For pages that live on a site you do not build from markdown at all,
`npx docpilot import <url>` turns an allowlisted URL into a page of the corpus. See
[imported pages](./imported-pages).

## What a host actually supplies

Four reactive values and a way to navigate. That is the whole contract:

| what | type | what it is |
|---|---|---|
| `theme` | `Ref<{docPilot}>` | the client config |
| `route` | `Ref<string>` | the current page's route, **base-less** |
| `lang` | `Ref<string>` | the page's locale, e.g. `'en'` |
| `router.go(href)` | function | follow a citation without a full reload |

```js
import { setHost, createStandaloneHost } from '@cloflin/docpilot/host'

const host = createStandaloneHost({
  theme: { docPilot: config },
  route: '/guide/install',
  lang: 'en',
  router: { go: (href) => myRouter.navigate(href) },
})

setHost(host.factory, {
  base: '/docs/',
  selectors: { article: 'article', search: '.search-button', content: 'main' },
})

// …then on every navigation:
host.update({ route: '/reference/config' })
```

**A factory, not a value.** It runs inside a component's setup, which is the only
place a framework hook like VitePress's `useData()` is legal to call. For an
imperative host it makes no difference; for a framework one it is the difference
between working and not.

`update()` writes only the keys it is given. It is called on every navigation with
a route and nothing else, and a spread over defaults would blank the config on the
first route change — the panel would mount, work once, and switch itself off the
moment the reader clicked a link.

### The base invariant

`base` is applied at exactly **two** points: the index fetch, and `router.go`.
Nowhere else. Routes, `manifest.pages[].path` and every href in an answer are
base-less, which is what lets the citation validator compare them literally. A
base that reaches that comparison de-links every source in the answer, on a site
whose only fault is being served from a subdirectory.

### The three selectors

They are described under [`host`](/reference/config#host). Two notes worth
repeating:

- **`article`** bounds the offer to quote a passage. The nav, the sidebar and the
  footer are deliberately outside it — *Ask AI* over a sidebar link is a control
  offering to ask a question about a menu.
- **`search`** has no neutral value, because no two sites agree on one. Without a
  selector from either layer the affordance is not rendered, and even with one the
  panel checks the element is actually on the page first. A button that clicks
  nothing is worse than no button.

## Mounting

[`mountDocPilot`](/install/javascript) does all of the above in one call, and is
what every adapter in this package is built on. Reach for the raw binding only
when you are composing the components into an app you already have — in which case
[the Vue plugin](/install/vue) probably does what you want.

## Serving it

Identical to a VitePress deployment, because the browser makes the same three
requests: the bundle, `/rag/*`, and the two `/ai/…` endpoints.
[Production](./production) covers the reverse proxy, the cache rules for the
index, the container and the failure table.
