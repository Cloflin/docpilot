/**
 * The theme with no stylesheet attached.
 *
 *   import { withDocPilot } from '@cloflin/docpilot/theme-without-styles'
 *   import '@cloflin/docpilot/style/core.css'   // …and your own mapping
 *
 * Same exports as `./index.js`, same components, no CSS side effect — the
 * arrangement `vitepress/theme-without-fonts` uses. It exists for two cases:
 * a site that is not VitePress and supplies its own token mapping, and a site
 * that wants the core styles under a different adapter of its own.
 *
 * Importing this and no stylesheet at all leaves the panel unstyled. There is
 * no fallback on purpose: a half-styled panel is harder to diagnose than a
 * completely unstyled one.
 */

export * from './theme.js'
export { default } from './theme.js'
