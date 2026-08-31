/**
 * highlight.js — for a blog or an older docs site where it is already on the
 * page.
 *
 *     import { createHljsHighlighter } from '@cloflin/docpilot/hljs'
 *     setHighlighter(createHljsHighlighter())
 *
 * Same argument as the Prism adapter: a site that already has a tokeniser and a
 * theme should not download a second one so that one panel can match itself.
 *
 * THE FILE IS NAMED `hljs.js`, NOT `highlight.js`. The npm package is called
 * `highlight.js` and so is the panel's own registry module one directory up.
 * Nothing actually collides — this module's imports are bare specifiers and the
 * registry's are relative — but a reader opening `highlighters/highlight.js`
 * would have every reason to expect the other one.
 *
 * ONE THING THE HOST HAS TO HAVE: a highlight.js stylesheet. Every theme paints
 * `.hljs` itself, which is why the core stylesheet neutralises that one rule
 * inside the code card — see `core.scss`. Without a theme the code is correct,
 * escaped and monochrome.
 */
import type { Highlighter } from '../../../../types/highlight.js'

/**
 * The panel's canonical ids to highlight.js's own names.
 *
 * `jsonc` maps to `json` for the reason the Prism adapter states, and `html`
 * maps to `xml`, which is highlight.js's one grammar for HTML, XML and SVG.
 */
const NATIVE = {
  ts: 'typescript',
  js: 'javascript',
  bash: 'bash',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  html: 'xml',
  css: 'css',
}

/**
 * Static specifiers, for the reason the Prism adapter states: a template
 * literal inside `import()` is a glob, and highlight.js ships ~190 languages.
 *
 * `lib/core` rather than the package root, which is the full bundle.
 */
const GRAMMARS = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  bash: () => import('highlight.js/lib/languages/bash'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
}

/**
 * @param {{hljs?: object}} [options]
 *   `hljs` is an existing instance — `globalThis.hljs` is used when one is
 *   there, which is how the common `<script src="…/highlight.min.js">` blog
 *   setup already has every language it needs.
 */
export function createHljsHighlighter(options: { hljs?: unknown; langs?: Record<string, string> } = {}): Highlighter {
  let hljs = null
  let ids = []

  return {
    id: 'hljs',

    async load() {
      if (hljs) return
      const supplied = options.hljs || globalThis.hljs
      hljs = supplied || (await import('highlight.js/lib/core')).default

      // Registering into an instance the host handed us would change what its
      // own code blocks are highlighted with. A supplied hljs is used exactly as
      // configured — and the full browser build already registers everything.
      if (!supplied) {
        for (const native of new Set(Object.values(NATIVE))) {
          if (hljs.getLanguage(native)) continue
          try {
            hljs.registerLanguage(native, (await GRAMMARS[native]()).default)
          } catch {
            /* a grammar that will not load is a language this panel does not offer */
          }
        }
      }

      ids = Object.keys(NATIVE).filter((id) => !!hljs.getLanguage(NATIVE[id]))
    },

    loaded: () => ids,

    render(code, lang) {
      const native = NATIVE[lang]
      if (!native || !hljs?.getLanguage(native)) return null
      // `.value` is inner HTML with the text escaped — verified against
      // `<img src=x onerror=…>`. The `hljs` class is on the `<code>` because
      // some themes scope their token colours under it; every theme also paints
      // `.hljs` itself with a background and a colour, which would fight
      // `--dp-code-bg`, so `core.scss` neutralises exactly that inside the card.
      const inner = hljs.highlight(code, { language: native, ignoreIllegals: true }).value
      return `<pre tabindex="0"><code class="hljs">${inner}</code></pre>`
    },
  }
}
