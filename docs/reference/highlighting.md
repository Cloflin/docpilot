---
title: Syntax highlighting
---

# Syntax highlighting

An answer is markdown that arrives token by token and is re-rendered every 90ms.
That single fact decides everything on this page: a highlighter has to be
resident in the browser, its render call has to be **synchronous**, and it has to
fail by returning nothing rather than by throwing.

Three ship with the package. None of them is installed by default.

| adapter | import | when |
|---|---|---|
| Shiki | `@cloflin/docpilot/shiki` | VitePress, and anywhere you want the panel to match a Shiki-built page |
| Prism | `@cloflin/docpilot/prism` | Docusaurus, and any site that already ships Prism |
| highlight.js | `@cloflin/docpilot/hljs` | a blog or an older docs site with `hljs` already on the page |

## Choosing one

```js
import { setHighlighter } from '@cloflin/docpilot/highlight'
import { createPrismHighlighter } from '@cloflin/docpilot/prism'

setHighlighter(createPrismHighlighter())
```

`@cloflin/docpilot/theme` — the VitePress entry point — calls this for you with
Shiki. `mountDocPilot()` takes one as its `highlighter` option. Everywhere else
you call it yourself, once, before the panel is first opened.

**Nothing is installed by default, and that is deliberate.** A default inside the
package would put `import('@shikijs/…')` into every consumer's module graph, and
a bundler that cannot resolve it fails the *build* — so a Docusaurus site that
chose Prism would still have to install Shiki in order to compile.

With no highlighter, every code block renders as a plain escaped `<pre>` with its
copy button. That is the same thing an unsupported language already does, so it
is a shape the panel is designed around rather than a broken state.

## What each one needs

Every highlighter is **yours to install** — this package declares no peer
dependencies at all, so nothing is pulled in for you and nothing this package
says can conflict with a version you already have. Install the one you chose.

::: code-group

```bash [Shiki]
npm i @shikijs/core @shikijs/engine-javascript @shikijs/langs @shikijs/themes
```

```bash [Prism]
npm i prismjs
```

```bash [highlight.js]
npm i highlight.js
```

:::

Four names for Shiki rather than one, because there is no single package that
reaches all of them: `shiki` exports `./core` and `./engine/javascript` but no
per-language or per-theme subpath, and `shiki/langs` is every grammar there is.
On VitePress 1.6 and up they are already installed — `vitepress` depends on
`shiki` — but declaring them is what makes the install work under pnpm and on
every other host.

### Which version, and why not to pin one

**Any Shiki from 2.0 up**, and nothing enforces it — the package declares no peer
ranges at all, so the version is yours to get right. The adapter
needs `createHighlighterCore`, the JavaScript regex engine, and the per-language
and per-theme subpaths — four things that have not moved across 2.x, 3.x and 4.x.
So the version is simply whatever the host already ships: 2.x under VitePress 1.6,
4.x under VitePress 2. Nothing to install, nothing to align, nothing to override.

Below VitePress 1.6 the calculation changes: those releases carry Shiki 1.x, which
never published `@shikijs/langs` or `@shikijs/themes` at all — there the four names
are not optional.

Wanting the newest Shiki on VitePress 1.x is an ordinary dependency, not a version
fight:

```json
"dependencies": {
  "@shikijs/core": "^4.4.3",
  "@shikijs/engine-javascript": "^4.4.3",
  "@shikijs/langs": "^4.4.3",
  "@shikijs/themes": "^4.4.3"
}
```

npm hoists 4.4.3 to the root for the panel and leaves VitePress's own 2.5.0 under
`node_modules/vitepress`. Two copies, neither of them wrong: VitePress highlights
its pages at build time in Node, the panel highlights answers in the browser, and
the two never share a module graph.

**What not to do is `overrides` — or yarn's `resolutions`.** An override installs
nothing; it rewrites the range some existing edge asks for. Here the only edge
naming Shiki is VitePress's own, so an override retargets *that*, the
already-hoisted copy then fails to satisfy the rewritten range, and every `npm i`
and `npm ls` ends the same way:

```
npm error code ELSPROBLEMS
npm error invalid: @shikijs/core@2.5.0 node_modules/@shikijs/core
```

An exact pin — `"4.4.3"` rather than `"^4.4.3"` — buys the same error one patch
release later. Declare the four packages and let npm place them.

### And a stylesheet, for two of the three

Shiki writes colour onto the tokens themselves, so it needs nothing.

Prism and highlight.js write **classes**, which means the page has to carry a
theme that colours them. Most sites that use either already do. Docusaurus is the
exception worth naming: it renders its own blocks through `prism-react-renderer`,
which applies colour as *inline styles* and may ship no `.token` CSS at all. One
import fixes it:

```js
import 'prismjs/themes/prism.css'
```

That does not disturb the host's own code blocks. Prism themes scope block chrome
— background, base colour, padding — under `[class*="language-"]`, and this panel
never emits that class; the 34 token-colour rules are unqualified and apply.
Docusaurus's own blocks keep their inline styles, which win over a stylesheet
anyway.

Without a theme the code is correct, escaped and monochrome.

## Writing your own

An adapter is an object with five members. There is no base class and nothing to
extend.

```ts
interface Highlighter {
  /** Identifies it in error messages. */
  id: string

  /** Extra fence aliases, `alias → canonical id`. Optional. */
  langs?: Record<string, string>

  /** Everything asynchronous. Called once, by `ensureHighlighter()`. */
  load(): Promise<void>

  /** The canonical ids that are ready to render. */
  loaded(): Iterable<string>

  /** MUST be synchronous. Returns complete markup, or null. */
  render(code: string, lang: string): string | null
}
```

```js
setHighlighter({
  id: 'my-highlighter',
  async load() {
    this.engine = await import('./my-engine.js')
  },
  loaded: () => ['ts', 'js'],
  render(code, lang) {
    return `<pre tabindex="0"><code>${this.engine.run(code, lang)}</code></pre>`
  },
})
```

### The five rules

**`render` must be synchronous.** The answer is re-rendered on a timer while it
streams. An adapter that returns a promise gets one console error and its output
discarded — the alternative is `[object Promise]` in the reader's answer.

**`render` must escape the code it wraps.** Its return value is inserted as HTML.
Both shipped third-party adapters rely on their highlighter doing this — Prism's
`highlight()` and highlight.js's `.value` both escape — and both are tested
against `<img src=x onerror=…>`.

**`render` returns complete markup, including the `<pre>`.** The panel wraps it in
the code card and adds the copy button; the frame is yours because a highlighter
that returns inner HTML only, as Prism and highlight.js do, has to be given one
somewhere. Put `tabindex="0"` on the `<pre>`: it is a scroller, and a scroller
nobody can reach by keyboard has content some readers cannot get to.

**Never emit a class containing `language-`.** VitePress binds a window-level
listener to `div[class*="language-"] > button.copy`, and the panel teleports to
`<body>` where that listener can reach it.

**`loaded()` returns the panel's canonical ids, not your engine's names.** They
are `ts js bash json jsonc yaml html css`. Map them to whatever your engine calls
them inside `render` — the shipped Prism adapter turns `html` into `markup` and
`jsonc` into `json`, and the highlight.js one turns `html` into `xml`. A project
that swaps highlighters then does not find its fences suddenly unrecognised.

### Aliases, and why they are validated

`langs` extends the table that maps a fence's info string onto a canonical id:

```js
langs: { rs: 'rust', rust: 'rust' }
```

That table is a **sanitiser**, not a convenience. A fence's info string is written
by the model, and the value it resolves to is written into a `data-lang`
attribute unescaped — so the attribute never receives model text, it receives a
value from the table.

A pair is therefore checked when the adapter is installed, not when a fence is
rendered. Both halves must match `/^[a-z0-9+#.-]{1,20}$/`, and the right-hand
side must be something `loaded()` actually reports. Anything else is dropped with
one console error. An adapter cannot overwrite a shipped alias with a value it
has not loaded.

## What the panel does around it

Written down because an adapter does not have to reimplement any of it:

- **Memoisation.** During streaming only the last block is still changing; every
  completed block above it is a map hit rather than a re-tokenisation, on every
  frame. The memo is cleared whenever the highlighter changes.
- **A 20 000-character ceiling.** Past it a block renders plain rather than
  blocking the frame.
- **Total failure handling.** A throw, a promise, or anything that is not a
  string becomes `null`, and `null` renders the plain block.
- **The copy button, the card and the scroll container.**

## Both colour schemes

Shiki is asked for both themes at once (`defaultColor: false`), which writes
`--shiki-light` and `--shiki-dark` onto every token and applies neither. The
stylesheet picks: `prefers-color-scheme` in the core, the host's own dark signal
in each adapter. This is the one thing in the package a `--dp-*` token cannot
cover — the `var()` has to sit on a rule targeting the spans, because that is the
only place those variables exist.

Prism and highlight.js do not work this way; their themes are two stylesheets and
switching between them is the host's business, exactly as it already is for the
host's own code blocks.

The panel does undo one thing each of them does: the background. Every
highlight.js theme paints `.hljs`, and Prism's default theme gives
`.token.operator` a translucent white that reads as a smear on a dark panel. The
code card is one surface — `--dp-code-bg` — so both are neutralised inside it.
Colour is left alone.
