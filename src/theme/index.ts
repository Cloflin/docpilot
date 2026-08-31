/**
 * The theme, with its stylesheet — the entry point everything documented uses.
 *
 *   import { withDocPilot } from '@cloflin/docpilot/theme'
 *
 * The whole of this file is the CSS import. `theme.js` holds the components and
 * the slot wiring; a project that ships its own build of the styles imports
 * `@cloflin/docpilot/theme-without-styles` instead and gets this file's
 * exports without the side effect.
 *
 * `dist/docpilot.css` is the bundle: the core stylesheet followed by the
 * VitePress adapter, in that order, which is the order the override depends on.
 */

// @ts-ignore — a bare stylesheet import; the side effect IS the statement.
import '../../dist/docpilot.css'

export * from './theme.js'
export { default } from './theme.js'
