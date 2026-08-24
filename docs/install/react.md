---
title: React
---

# React

One component. No Vue in your dependencies, no loader in your bundler config.

```bash
npm i @cloflin/docpilot
```

On Yarn, pnpm, Bun or Deno, take that line from
[Installing](/install/#installing-it) instead.

## Mounting

```jsx
import { DocPilotPanel } from '@cloflin/docpilot/react'
import '@cloflin/docpilot/web.css'

export function Layout({ children, pathname }) {
  return (
    <>
      {children}
      <DocPilotPanel config={window.__DOCPILOT__} route={pathname} />
    </>
  )
}
```

The component renders one empty `div`. Everything visible — the panel, the icon
sprite, the selection popover — teleports to `<body>`, so where you place it in
the tree does not decide where it appears. Place it once.

## Why it imports a prebuilt bundle

`@cloflin/docpilot/react` imports `@cloflin/docpilot/web`, not the package's
source. A React project's bundler is webpack, Turbopack or esbuild; none of them
compiles a `.vue` file, and `babel-loader` excludes `node_modules` besides. The
web bundle is the same code already compiled, with Vue inside — so your app needs
no Vue, no loader and no configuration.

It is about 150 KB gzipped and is loaded lazily. A reader who never opens the
panel downloads none of it.

`'use client'` is the module's first line, so it drops into a Next App Router tree
unchanged.

## Keeping it in step

Pass `route` and `lang` as props and change them on navigation:

```jsx
import { usePathname } from 'next/navigation'

const pathname = usePathname()
return <DocPilotPanel config={config} route={pathname} lang="en" />
```

**The panel does not remount when they change.** They are pushed into the running
instance instead — a remount would throw away the reader's conversation, which is
the one thing the panel keeps across route changes on every other host.

`route` is base-less: `/guide/install`, not `/docs/guide/install`. If your site is
served from a subdirectory, say so once with `base`:

```jsx
<DocPilotPanel config={config} route={pathname} base="/docs/" />
```

## Opening it from your own button

```jsx
import { DocPilotPanel, useDocPilot } from '@cloflin/docpilot/react'

function AskButton() {
  const docpilot = useDocPilot()
  return <button onClick={() => docpilot.open()}>Ask AI</button>
}
```

Render the panel with `trigger="none"` and place your own control anywhere.
`ask(question)` puts a question in the composer without submitting it — the reader
reads what somebody else wrote before it is asked on their behalf.

## The rest of the options

```jsx
<DocPilotPanel
  config={config}
  route={pathname}
  trigger="fab"                                    // 'fab' | 'nav' | 'none'
  base="/docs/"
  ragBase="https://cdn.example.com/rag"
  selectors={{ article: 'article', search: '.DocSearch-Button' }}
  router={{ go: (href) => navigate(href) }}
  highlighter={myHighlighter}
/>
```

`router` is what a citation click uses. Without it the panel follows a link with a
full page load, which is correct — a host with no router IS a site where following
a link means loading a page — but you almost certainly have one.

`selectors.article` is what bounds the offer to quote a passage; the neutral
default is `main`. See [`host`](/reference/config#host).

## Syntax highlighting

The web bundle installs Shiki itself, so code in an answer is coloured with no
setup. To use something else:

```jsx
import { createHljsHighlighter } from '@cloflin/docpilot/hljs'

<DocPilotPanel config={config} highlighter={createHljsHighlighter()} />
```

`highlighter={false}` removes it and renders every block as a plain escaped
`<pre>`. See [Syntax highlighting](/reference/highlighting).
