/**
 * `@cloflin/docpilot/docusaurus` — the Docusaurus plugin.
 *
 * A PLUGIN, not a theme: only one theme may provide `@theme/Root` without
 * wrapping, so a package that does collides with every other theme that wraps
 * the app — and the symptom for the user is that their search stops working.
 * `getClientModules()` needs no React, no swizzle and no theme.
 */
import type { DocPilotThemeConfig } from './config.js'
import type { HostSelectors } from './host.js'

export interface DocPilotDocusaurusOptions {
  /** The client config — `ai.themeConfig` from `defineDocPilot`. */
  config?: DocPilotThemeConfig
  /**
   * Two values, not four. Webpack resolves dynamic imports at BUILD time, so a
   * client module that names `@cloflin/docpilot/hljs` fails the build of every
   * site without `highlight.js` installed. For Prism or highlight.js, add a
   * `clientModules` entry of your own — see `/reference/highlighting`.
   */
  highlighter?: 'shiki' | 'none'
  selectors?: HostSelectors
  ragBase?: string | null
  /** Include the panel's two stylesheets. */
  styles?: boolean
}

export interface DocusaurusPlugin {
  name: string
  getClientModules(): string[]
  injectHtmlTags(): {
    preBodyTags: Array<{ tagName: string; innerHTML: string }>
  }
}

export default function docpilotPlugin(
  context: { siteConfig?: { baseUrl?: string } },
  options?: DocPilotDocusaurusOptions,
): DocusaurusPlugin
