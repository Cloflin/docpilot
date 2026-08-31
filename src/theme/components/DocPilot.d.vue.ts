/**
 * The panel, for `tsc`. Deliberately loose, on the same reasoning as
 * `types/components.d.ts`: a generated declaration would state the whole
 * internal shape of a 3000-line component and pin it. It takes no props.
 *
 * These siblings exist because `moduleResolution: NodeNext` resolves a relative
 * `./DocPilot.vue` on disk and never consults the `declare module '*.vue'`
 * wildcard — that wildcard only answers for bare specifiers. `tsconfig.json`
 * sets `allowArbitraryExtensions`, which is what makes this filename the
 * declaration for the file beside it.
 */
import type { DefineComponent } from 'vue'
declare const component: DefineComponent<Record<string, never>>
export default component
