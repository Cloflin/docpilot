/**
 * The panel in a Vue application that is not VitePress.
 *
 *     import { createApp } from 'vue'
 *     import { DocPilotPlugin } from '@cloflin/docpilot/vue'
 *     import '@cloflin/docpilot/style/core.css'
 *
 *     createApp(App).use(DocPilotPlugin, { config: __DOCPILOT__, router }).mount('#app')
 *
 * Then place the components wherever they belong:
 *
 *     <DocPilotIcons />          <!-- once, anywhere -->
 *     <DocPilotTrigger />        <!-- wherever a button goes -->
 *     <DocPilot />               <!-- once, anywhere: it teleports -->
 *
 * SHIPPED AS SOURCE, which is the right form here and only here: a Vue project
 * has an SFC compiler by definition. Every other adapter in this directory
 * imports the prebuilt bundle instead, because their hosts do not.
 *
 * `mountDocPilot` is re-exported for the other Vue case — an app that wants the
 * panel on the page without putting a component in its tree.
 */

import { computed } from 'vue'

import { HOST_KEY, setHost, createStandaloneHost } from '../theme/docpilot/host.js'
import { setHighlighter } from '../theme/docpilot/highlight.js'
import DocPilot from '../theme/components/DocPilot.vue'
import DocPilotTrigger from '../theme/components/DocPilotTrigger.vue'
import DocPilotCta from '../theme/components/DocPilotCta.vue'
import DocPilotIcons from '../theme/components/DocPilotIcons.vue'
import DocPilotQuote from '../theme/components/DocPilotQuote.vue'

export { DocPilot, DocPilotTrigger, DocPilotCta, DocPilotIcons, DocPilotQuote }
export { mountDocPilot } from '../mount.js'
export { setHighlighter, getHighlighter } from '../theme/docpilot/highlight.js'
export { setHost, useHost, createStandaloneHost, HOST_KEY, routeOf } from '../theme/docpilot/host.js'

const COMPONENTS = {
  DocPilot,
  DocPilotTrigger,
  DocPilotCta,
  DocPilotIcons,
  DocPilotQuote,
}

/**
 * A binding driven by a Vue Router instance — DUCK-TYPED, with no import of
 * `vue-router`.
 *
 * The two things needed from it are a current path and a way to navigate, and
 * both are stable across Vue Router 3 and 4. Importing the package to name a
 * type would make a router a dependency of a panel that works fine without one,
 * and would pin a major version for projects on the other.
 *
 * @param {{currentRoute: {value: {path: string, fullPath?: string}}, push: Function}} router
 */
export function createVueRouterHost(router, init = {}) {
  const host = createStandaloneHost({
    ...init,
    router: { go: (href) => router.push(href) },
  })
  // A computed rather than a watcher: the router's own reactivity is already the
  // source of truth, and a watcher would be a second copy of it that can lag.
  const route = computed(() => router.currentRoute.value.path)
  return {
    ...host,
    factory: () => ({ ...host.binding, route }),
  }
}

/**
 * @param {object} options
 * @param {object} [options.config]     the client config — `ai.themeConfig` from `defineDocPilot`
 * @param {object} [options.router]     a Vue Router instance. Full page loads without one
 * @param {object} [options.host]       a binding of your own, instead of `router`
 * @param {string} [options.base]       the site's base path
 * @param {object} [options.selectors]  `{article, search, content}` for this host
 * @param {object} [options.highlighter]  an adapter from `/shiki`, `/prism` or `/hljs`
 */
export const DocPilotPlugin = {
  install(
    app,
    options: {
      config?: Record<string, unknown>
      router?: unknown
      host?: import('../../types/host.js').StandaloneHost | null
      base?: string | null
      selectors?: Record<string, string> | null
      highlighter?: unknown
      lang?: string
    } = {},
  ) {
    const {
      config = {},
      router = null,
      host = null,
      base = null,
      selectors = null,
      highlighter = null,
      lang = 'en',
    } = options

    const binding =
      host ||
      (router
        ? createVueRouterHost(router, { theme: { docPilot: config }, lang })
        : createStandaloneHost({ theme: { docPilot: config }, lang }))

    // Both, for the reason `mountDocPilot` gives: `provide` scopes the binding
    // to this app, the registry reaches a component mounted outside it.
    app.provide(HOST_KEY, binding.factory)
    setHost(binding.factory, { base, selectors })

    if (highlighter) setHighlighter(highlighter)

    for (const [name, component] of Object.entries(COMPONENTS)) app.component(name, component)

    // Handed back so the app can push route and language changes in, for a
    // router this plugin was not given.
    app.config.globalProperties.$docPilot = binding
  },
}

export default DocPilotPlugin
