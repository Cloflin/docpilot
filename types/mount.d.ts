/**
 * `mountDocPilot` — the panel on a site that is not VitePress.
 *
 * `@cloflin/docpilot/mount` ships SOURCE and needs a bundler that compiles
 * `.vue`. `@cloflin/docpilot/web` is the same API already compiled, with Vue
 * bundled in, for a host that does not.
 */
import type { App, Component } from 'vue'
import type { DocPilotThemeConfig, UiTrigger } from './config.js'
import type { HostRouter, HostSelectors } from './host.js'
import type { Highlighter } from './highlight.js'

export interface MountOptions {
  /** The client config — `ai.themeConfig` from `defineDocPilot`. */
  config?: DocPilotThemeConfig
  /** Where to mount. A div is created and appended to `<body>` without one. */
  target?: Element | null
  /**
   * Which trigger instances to MOUNT — a different question from which of them
   * render, which `config.ui.trigger` answers. A placement has to pass both.
   */
  trigger?: UiTrigger | 'none' | UiTrigger[]
  /** The current route, base-less. Read from `location.pathname` when omitted. */
  route?: string
  /** Read from `<html lang>` when omitted. */
  lang?: string
  base?: string | null
  ragBase?: string | null
  selectors?: HostSelectors | null
  /** SPA navigation. A full page load without one. */
  router?: HostRouter | null
  /** An adapter from `/shiki`, `/prism` or `/hljs`. `false` installs none. */
  highlighter?: Highlighter | false | null
}

export interface DocPilotInstance {
  app: App | null
  /** `false` when nothing was mounted — no document, or `{enabled: false}`. */
  mounted: boolean
  open(): void
  close(): void
  toggle(): void
  /** Puts a question in the composer. NOT submitted. */
  ask(question: string): void
  setRoute(route: string): void
  setLang(lang: string): void
  setConfig(config: DocPilotThemeConfig): void
  destroy(): void
}

export declare function mountDocPilot(options?: MountOptions): DocPilotInstance

export declare const DocPilot: Component
export declare const DocPilotTrigger: Component
export declare const DocPilotIcons: Component
export declare const DocPilotQuote: Component

export { setHighlighter, getHighlighter } from './highlight.js'
export { setHost, useHost, createStandaloneHost, HOST_KEY, routeOf } from './host.js'
