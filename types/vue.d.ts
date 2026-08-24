/**
 * `@cloflin/docpilot/vue` — the panel in a Vue application that is not
 * VitePress. Ships source, which is the right form here: a Vue project has an
 * SFC compiler by definition.
 */
import type { Plugin } from 'vue'
import type { DocPilotThemeConfig } from './config.js'
import type { HostBinding, HostSelectors, StandaloneHost } from './host.js'
import type { Highlighter } from './highlight.js'

export * from './components.js'
export { mountDocPilot } from './mount.js'
export { setHighlighter, getHighlighter } from './highlight.js'
export { setHost, useHost, createStandaloneHost, HOST_KEY, routeOf } from './host.js'

export interface DocPilotPluginOptions {
  config?: DocPilotThemeConfig
  /** A Vue Router instance. Duck-typed; `vue-router` is not a dependency. */
  router?: { currentRoute: { value: { path: string } }; push(href: string): void }
  /** A binding of your own, instead of `router`. */
  host?: StandaloneHost
  base?: string | null
  selectors?: HostSelectors | null
  highlighter?: Highlighter | null
  lang?: string
}

export declare const DocPilotPlugin: Plugin<[DocPilotPluginOptions?]>
export default DocPilotPlugin

/** A binding that TRACKS a Vue Router rather than copying it. */
export declare function createVueRouterHost(
  router: { currentRoute: { value: { path: string } }; push(href: string): void },
  init?: { theme?: { docPilot?: DocPilotThemeConfig }; lang?: string },
): StandaloneHost & { factory: () => HostBinding }
