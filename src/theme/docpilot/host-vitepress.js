/**
 * The VitePress binding — the one file in the browser half that imports the bare
 * specifier `vitepress`.
 *
 * Keeping it to one file is the whole point. Before this, four components
 * imported `useData`, which meant a project on any other generator had to make
 * the string `vitepress` resolve to something; now the components import
 * `host.js`, and this module is simply not loaded unless the VitePress theme is.
 *
 * It is installed by `theme.js`, which already depends on `vitepress/theme` — so
 * nothing that was framework-neutral becomes coupled by its existence.
 */

import { computed } from 'vue'
import { useData, useRouter, withBase } from 'vitepress'
import { setHost, routeOf } from './host.js'

/**
 * The three host selectors, and what each is for.
 *
 * `article` bounds the selection-to-quote popover: a selection outside it is not
 * a passage of documentation, so the offer is not made. The nav, the sidebar and
 * the footer are deliberately outside — "Ask AI" over a sidebar link is a
 * control offering to ask a question about a menu.
 *
 * `search` is what the panel's degraded and error states click when they offer
 * to search the docs instead. It names VitePress's own button and DocSearch's,
 * because a site has one or the other and never both.
 *
 * `content` is the focus target of last resort when the panel closes and the
 * element that opened it has gone with a route change.
 */
const SELECTORS = {
  article: '.vp-doc, main',
  search: '.VPNavBarSearchButton, .DocSearch-Button',
  content: '#VPContent, main',
}

let installed = false

/** Idempotent — `theme.js` calls it from three places for three reasons. */
export function installVitePressHost() {
  if (installed) return
  installed = true

  setHost(
    () => {
      const { theme, page, lang } = useData()
      const router = useRouter()
      return {
        theme,
        route: computed(() => routeOf(page.value?.relativePath)),
        lang,
        /**
         * `withBase`, and it is a fix rather than a formality.
         *
         * VitePress's `router.go` does not apply `base` — `normalizeHref` in its
         * router never touches it, because the handler it was written for is
         * given an href off a DOM anchor, which already carries one. Every href
         * the panel navigates comes from the manifest instead, so on a site
         * served at `/docs/` a citation click landed one directory too high.
         */
        router: { go: (href) => router.go(withBase(href)) },
      }
    },
    {
      /**
       * Vite's `BASE_URL`, not a VitePress API, and not by preference: the
       * static half is read from `session.js`, which is not a component and
       * cannot call `useData()`. VitePress configures Vite's base from its own,
       * so the two agree by construction. Undefined outside a Vite build — the
       * `?.` is what lets this module be imported by plain Node.
       */
      base: import.meta.env?.BASE_URL || '/',
      selectors: SELECTORS,
    },
  )
}

/** Test seam — the install is a module-level latch. */
export function __resetVitePressHostForTests() {
  installed = false
}
