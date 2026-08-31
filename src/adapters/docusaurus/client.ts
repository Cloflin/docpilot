/**
 * The Docusaurus client module — mounts the panel and keeps its route in step.
 *
 * Listed by the plugin's `getClientModules()`, which is what makes this run on
 * every page with no component, no swizzle and no React. Docusaurus imports
 * client modules during the server render too, which is why nothing here touches
 * the DOM at module scope: `mountDocPilot` returns an inert handle when there is
 * no `document`, and `ensure()` simply tries again on the client.
 */
import { mountDocPilot } from '@cloflin/docpilot/web'

let panel = null

/**
 * SHIKI IS THE DEFAULT ON DOCUSAURUS, which looks like the wrong call and is
 * not. The bundle this module imports has Shiki compiled into it already — it
 * has to, because a `<script>` tag on a blog has nowhere to put a setup call —
 * so choosing Prism here would save no bytes. What it would cost instead is a
 * stylesheet: Docusaurus paints its own blocks with `prism-react-renderer`,
 * which applies colour as INLINE STYLES and ships no `.token` CSS, so Prism
 * output would arrive correct, escaped and monochrome until the site imported a
 * Prism theme by hand.
 *
 * THIS MODULE NAMES NO OTHER HIGHLIGHTER, and that is a build constraint rather
 * than a preference. Webpack resolves dynamic imports at BUILD time, so an
 * `import('@cloflin/docpilot/hljs')` on a branch nobody takes still fails the
 * build of every site that has not installed `highlight.js`. Measured, not
 * assumed: it broke a stock `create-docusaurus` build with
 * `Module not found: Can't resolve 'highlight.js/lib/core'`.
 *
 * A site that wants Prism or highlight.js adds three lines of its own, in a
 * client module where its own dependencies resolve:
 *
 *     // src/docpilot-prism.js  ·  clientModules: ['./src/docpilot-prism.js']
 *     import { setHighlighter } from '@cloflin/docpilot/web'
 *     import { createPrismHighlighter } from '@cloflin/docpilot/prism'
 *     setHighlighter(createPrismHighlighter())
 */
function ensure() {
  if (panel?.mounted) return panel
  if (typeof document === 'undefined') return null

  const settings = globalThis.__DOCPILOT__ || {}
  panel = mountDocPilot({
    config: settings.config,
    base: settings.base,
    ragBase: settings.ragBase,
    selectors: settings.selectors,
    // `false` removes the Shiki the bundle installs; anything else leaves it,
    // and a site that wants another one installs it from a client module of its
    // own — see the note above.
    highlighter: settings.highlighter === 'none' ? false : undefined,
    // Docusaurus sets both of these on `<html>` itself, and for an imperative
    // host they are the right sources rather than a workaround: a client module
    // cannot call `useDocusaurusContext()`, and these are what that context
    // would have told us.
    lang: document.documentElement.lang || 'en',
    route: location.pathname,
  })

  return panel
}

/**
 * Docusaurus calls this after every client-side navigation. It is the whole of
 * the route plumbing — what the panel means by *this page* follows the router
 * without the panel knowing there is one.
 */
export function onRouteDidUpdate({ location: next }) {
  const p = ensure()
  p?.setRoute(next?.pathname || location.pathname)
}

// The first page is not a route UPDATE, so it needs its own call.
ensure()
