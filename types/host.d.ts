/**
 * The host binding — what the panel needs to know about the site it is on.
 *
 * Deliberately NOT VitePress's `useData()` shape: `page.relativePath` is a
 * source FILE path, a concept only a markdown-driven generator has, and every
 * host knows its own route.
 */
import type { InjectionKey, Ref } from 'vue'
import type { DocPilotThemeConfig } from './config.js'

export interface HostSelectors {
  /** Bounds the offer to quote a passage. */
  article?: string
  /** The host's own search button. `false` suppresses the affordance. */
  search?: string | false
  /** Focus target of last resort when the panel closes. */
  content?: string
}

export interface HostRouter {
  /** `href` is BASE-LESS. Applying the base is the binding's job. */
  go(href: string): void
}

export interface HostBinding {
  theme: Ref<{ docPilot?: DocPilotThemeConfig } | undefined>
  /** The current page's route, base-less — `/guide/install`. */
  route: Ref<string>
  lang: Ref<string>
  router: HostRouter
}

/** The static half, readable from a module that is not a component. */
export interface HostEnvironment {
  base?: string | null
  selectors?: HostSelectors | null
}

export interface StandaloneHost {
  binding: HostBinding
  factory: () => HostBinding
  /** Writes only the keys present. Call it on every navigation. */
  update(next: { theme?: unknown; route?: string; lang?: string }): void
}

/**
 * Per-app override, for two panels on one page bound to different hosts.
 *
 * A FACTORY is what goes in, not a binding: `inject` runs inside setup and the
 * value it yields is called there. `mountDocPilot` and the Vue adapter both
 * provide `standaloneHost.factory`.
 */
export declare const HOST_KEY: InjectionKey<() => HostBinding>

/**
 * Install a host. A FACTORY, not a value — it runs inside a component's setup,
 * which is the only place `inject()` is legal.
 */
export declare function setHost(
  factory: (() => HostBinding) | null,
  environment?: HostEnvironment,
): void

/** The binding, from inside a component's setup. */
export declare function useHost(): HostBinding

export declare function hostEnv(): Required<HostEnvironment>

export declare function createStandaloneHost(init?: {
  theme?: { docPilot?: DocPilotThemeConfig }
  route?: string
  lang?: string
  router?: HostRouter
}): StandaloneHost

/** The four site seams, resolved: author → binding → neutral. */
export declare function hostConfig(cfg?: DocPilotThemeConfig): {
  base: string
  ragBase: string
  article: string
  search: string | null
  content: string
}

/** `base` + a relative path, one slash between and none at the end. */
export declare function joinBase(base: string, rel: string): string

/** A markdown file path to the route the site serves it at. Base-less. */
export declare function routeOf(rel: string | undefined): string
