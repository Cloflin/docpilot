---
title: VitePress
---

# VitePress

The shortest path, because the host answers every question by itself: the theme
installs the binding, chooses Shiki, and fills in all three DOM selectors.

```bash
npm i @cloflin/docpilot
npx docpilot init
```

Yarn, pnpm, Bun and Deno spell those two lines differently — the five are side by
side under [Installing](/install/#installing-it).

## The config

```js [docs/.vitepress/config.mjs]
import { defineConfig, loadEnv } from 'vitepress'
import { defineDocPilot } from '@cloflin/docpilot'

export const docPilot = {
  product: 'Acme Editor',
  chat: { provider: 'openai', model: 'gpt-4o-mini' },
  embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
}

const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))

export default defineConfig({
  vite: { plugins: [ai.plugin()] },
  themeConfig: { docPilot: ai.themeConfig },
})
```

No `docpilot.config.mjs` here: the CLI reads this file, so the index is built with
the model the panel queries with.

**`loadEnv` is called by you, not by the plugin.** `defineDocPilot` reads whatever
object you hand it, defaulting to `process.env`. A package that decided which
`.env` files your project has would be wrong for half of them.

## The theme

```js [docs/.vitepress/theme/index.js]
import DefaultTheme from 'vitepress/theme'
import { withDocPilot } from '@cloflin/docpilot/theme'

export default withDocPilot(DefaultTheme)
```

`withDocPilot` wraps a theme you already have; slots it fills survive, except the
four the panel claims — `layout-bottom`, `nav-bar-content-before`,
`nav-screen-content-after` and `doc-footer-before`.

If you have no theme of your own, the package's default export is one:

```js
export { default } from '@cloflin/docpilot/theme'
```

That import also pulls in `dist/docpilot.css`. To assemble the styles yourself,
import `@cloflin/docpilot/theme-without-styles` and one of the halves in
`style/` — see [Appearance](/guide/appearance).

## What the theme does for you

Three things you would otherwise supply by hand:

**The host binding.** `useData()` and `useRouter()`, wrapped so the panel sees
`{theme, route, lang, router}` — plus `withBase` on navigation, which VitePress's
own `router.go` does not apply. Without that, a citation click on a site served at
`/docs/` lands one directory too high.

**Shiki.** VitePress highlights its own pages with it, so an answer is the same
code in the same colours as the page behind it. The grammars are fetched when the
panel is first opened, never before.

**The three selectors** — `.vp-doc, main` for the article, VitePress's own search
button, `#VPContent` for focus return. You never set [`host`](/reference/config#host)
on VitePress unless your site has a `base`, and even then only `base` itself, and
only if you moved the index off the origin root.

## The rest of the loop

```bash
npx docpilot index       # build the index
npx docpilot calibrate   # measure the refusal thresholds on YOUR corpus
npx docpilot lint        # check the golden set against the index it measures
npx docpilot eval        # run the golden set, write a report
```

The first two are what the panel needs to work at all. The last two are what tells
you whether it works well — and they are the half that gets skipped, which is how
a gate ends up shipping on provisional thresholds forever.

`vitepress dev` proxies `/ai/*` for you. A built site does not, and
`vitepress preview` has no proxy at all — so the panel stops working at exactly
the point nobody is watching. `npx docpilot doctor --proxy` prints the contract;
[Production](/guide/production) explains it.
