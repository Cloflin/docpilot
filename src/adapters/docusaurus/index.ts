/**
 * The Docusaurus plugin.
 *
 *     // docusaurus.config.js
 *     plugins: [
 *       ['@cloflin/docpilot/docusaurus', { config: docPilotThemeConfig }],
 *     ]
 *
 * A PLUGIN, NOT A THEME, and the choice is not stylistic.
 *
 * The obvious way to put a component on every Docusaurus page is to provide
 * `@theme/Root`. Only one theme can provide it without wrapping, so a package
 * that does collides with `docusaurus-theme-search-typesense`,
 * `@docusaurus/theme-live-codeblock` and anything else that wraps the app — and
 * the symptom for the user is that their search stops working. Breaking somebody
 * else's feature to add ours is not a trade this package gets to make.
 *
 * `getClientModules()` needs none of that. A client module is imported into the
 * client bundle for its side effects and may export `onRouteDidUpdate`, which is
 * exactly the imperative route push the panel's standalone host wants. No React,
 * no swizzle, no theme.
 */
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('./client.js', import.meta.url))

/**
 * ABSOLUTE PATHS, because `getClientModules()` entries are resolved against the
 * PLUGIN's directory rather than as module specifiers. Returning
 * `'@cloflin/docpilot/style/core.css'` produced
 * `…/src/adapters/docusaurus/@cloflin/docpilot/style/core.css` and a build
 * failure that reads like a missing file.
 *
 * Built from a URL rather than by `require.resolve`, which would be the more
 * obvious way to go through the `exports` map: it also checks that the file
 * EXISTS, and `dist/` is a build artifact that a fresh clone does not have — so
 * merely constructing this plugin would throw in a repository that had not run
 * `npm run build`. The pairing with `exports` is asserted in the test suite
 * instead, which is where a renamed artifact should be caught anyway.
 */
const dist = (name) => fileURLToPath(new URL(`../../../dist/${name}`, import.meta.url))

/**
 * ORDER IS THE MECHANISM. The core declares every `--dp-*` with a real value;
 * the adapter re-declares the colour set at the same specificity and wins by
 * coming second. Reversed, the adapter loses and the panel ignores the site's
 * theme entirely.
 */
const STYLES = ['docpilot-core.css', 'docpilot-docusaurus.css']

/**
 * The selectors Docusaurus's own layout uses.
 *
 * `article` is what bounds the offer to quote a passage: `.theme-doc-markdown`
 * is the doc body, and `main` covers the blog and a custom page.
 */
const SELECTORS = {
  article: '.theme-doc-markdown, main',
  search: '.DocSearch-Button, .navbar__search-input',
  content: 'main',
}

/**
 * `</script>` inside a JSON string would close the tag the payload is inside.
 * Escaping the `<` is the standard fix and leaves the JSON valid, because
 * `<` is what a JSON parser turns back into `<`.
 */
const inlineJson = (value) => JSON.stringify(value ?? null).replace(/</g, '\\u003c')

/**
 * @param {object} context   Docusaurus's own — `siteConfig.baseUrl` is read from it
 * @param {object} [options]
 * @param {object} [options.config]        the client config — `ai.themeConfig` from `defineDocPilot`
 * @param {'shiki'|'none'} [options.highlighter='shiki']
 *   Two values, not four. Webpack resolves dynamic imports at BUILD time, so a
 *   client module that so much as names `@cloflin/docpilot/hljs` fails the build
 *   of every site without `highlight.js` installed — measured against a stock
 *   `create-docusaurus` site. A site that wants Prism or highlight.js installs
 *   it from a `clientModules` entry of its own, where its dependencies resolve.
 *   See `/reference/highlighting`.
 * @param {object} [options.selectors]     overrides for the three above
 * @param {string} [options.ragBase]       where the index is served from
 * @param {boolean} [options.styles=true]  include the panel's stylesheets
 */
export default function docpilotPlugin(
  context,
  options: {
    config?: Record<string, unknown>
    highlighter?: string | false
    selectors?: Record<string, string>
    ragBase?: string | null
    styles?: boolean
  } = {},
) {
  const {
    config = {},
    highlighter = 'shiki',
    selectors = {},
    ragBase = null,
    styles = true,
  } = options

  return {
    name: 'docpilot',

    getClientModules() {
      return styles ? [...STYLES.map(dist), CLIENT] : [CLIENT]
    },

    /**
     * The config, inlined into the page.
     *
     * Safe by construction rather than by care: `themeDocPilot` produces the
     * CLIENT half, which carries no key and no upstream host — the credential
     * stays in the reverse proxy. That is the same object VitePress compiles
     * into its hydration payload on every page.
     *
     * `setGlobalData` would be the more Docusaurus-shaped answer, but reading it
     * back means `useGlobalData()`, which is a React hook — and a hook drags this
     * plugin back into the component tree it exists to stay out of.
     */
    injectHtmlTags() {
      return {
        preBodyTags: [
          {
            tagName: 'script',
            innerHTML: `window.__DOCPILOT__=${inlineJson({
              config,
              base: context?.siteConfig?.baseUrl || '/',
              highlighter,
              ragBase,
              selectors: { ...SELECTORS, ...selectors },
            })}`,
          },
        ],
      }
    },
  }
}
