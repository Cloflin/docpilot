/**
 * Prism — for a site that already ships it, which is most Docusaurus sites and a
 * large share of blogs.
 *
 *     import { createPrismHighlighter } from '@cloflin/docpilot/prism'
 *     setHighlighter(createPrismHighlighter())
 *
 * The argument for it is bytes rather than quality. A Docusaurus site has Prism
 * in its bundle already; asking it to load Shiki as well means a second
 * tokeniser and a second set of grammars, downloaded so that one panel can
 * disagree slightly less with the page behind it.
 *
 * NO `language-*` CLASS IS EMITTED, and that is the design rather than a
 * restriction inherited from elsewhere. Prism's themes split cleanly in two:
 * block chrome — background, base colour, font, padding — hangs off
 * `code[class*="language-"]`, while all 34 token-colour rules are written on an
 * unqualified `.token.…`. Omitting the class therefore gets exactly the split
 * this panel wants: the host's theme colours the tokens, and the code card keeps
 * `--dp-code-bg`, `--dp-text` and its own geometry. Achieved by doing less.
 *
 * (It also happens to satisfy the rule in `markdown.js` that the code card's
 * WRAPPER must never contain the substring `language-`, because VitePress binds
 * a window-level listener to `div[class*="language-"] > button.copy`. That rule
 * is about the wrapper and would have been satisfied either way.)
 *
 * ONE THING THE HOST HAS TO HAVE: a Prism stylesheet on the page. Sites that
 * render Prism through `prism-react-renderer` — Docusaurus among them — paint
 * their own blocks with INLINE styles and may ship no `.token` CSS at all, in
 * which case the panel's code is correct, escaped and monochrome. See
 * `/reference/highlighting` for the one-line fix and why importing a Prism theme
 * there does not disturb the host's own blocks.
 */
import type { Highlighter } from '../../../../types/highlight.js'

/**
 * The panel's canonical ids to Prism's own names.
 *
 * `jsonc` maps to `json`: Prism has no JSON-with-comments grammar, and a comment
 * rendered as plain text inside otherwise-correct JSON is a better outcome than
 * a fence that falls back to no highlighting at all.
 *
 * `html` maps to `markup`, which is Prism's one grammar for HTML, XML and SVG —
 * the same three the panel's own table already folds together.
 */
const NATIVE = {
  ts: 'typescript',
  js: 'javascript',
  bash: 'bash',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  html: 'markup',
  css: 'css',
}

/**
 * The grammars Prism does not ship in its core, as static specifiers.
 *
 * Static, because `import(\`prismjs/components/prism-${name}.js\`)` is a glob to
 * every bundler that sees it and would pull all ~300 of Prism's components into
 * the build. Absent from this table: `markup`, `css` and `javascript`, which the
 * core registers itself.
 */
const COMPONENTS = {
  typescript: () => import('prismjs/components/prism-typescript.js'),
  bash: () => import('prismjs/components/prism-bash.js'),
  json: () => import('prismjs/components/prism-json.js'),
  yaml: () => import('prismjs/components/prism-yaml.js'),
}

/**
 * @param {{prism?: object}} [options]
 *   `prism` is an existing Prism instance — `globalThis.Prism` is used when one
 *   is there, so a site that has already configured its own languages gets those
 *   and no second copy.
 */
export function createPrismHighlighter(options: { prism?: unknown; langs?: Record<string, string> } = {}): Highlighter {
  let prism = null
  let ids = []

  return {
    id: 'prism',

    async load() {
      if (prism) return
      const supplied = options.prism || globalThis.Prism
      prism = supplied || (await import('prismjs')).default

      /**
       * Components are registered ONLY into an instance we created.
       *
       * `prismjs/components/*` are scripts that mutate whichever Prism they can
       * see, and which one that is depends on the bundler's CJS interop. Against
       * an instance the host handed us that is a coin flip with somebody else's
       * global as the stake — so a supplied Prism is used exactly as configured,
       * and whatever languages it already has are the ones the panel offers.
       */
      if (!supplied) {
        for (const native of new Set(Object.values(NATIVE))) {
          if (prism.languages[native]) continue
          try {
            await COMPONENTS[native]?.()
          } catch {
            /* a component that will not load is a language this panel does not offer */
          }
        }
      }

      ids = Object.keys(NATIVE).filter((id) => !!prism.languages[NATIVE[id]])
    },

    loaded: () => ids,

    render(code, lang) {
      const native = NATIVE[lang]
      const grammar = native && prism?.languages?.[native]
      if (!grammar) return null
      // `Prism.highlight` escapes the text it wraps — verified against
      // `<img src=x onerror=…>`, which comes back as `&lt;img …`. The frame is
      // ours because Prism returns inner HTML only, and `tabindex` is on it for
      // the same reason it is on the plain fallback: a scroller nobody can reach
      // by keyboard has content some readers cannot get to.
      return `<pre tabindex="0"><code>${prism.highlight(code, grammar, native)}</code></pre>`
    },
  }
}
