/**
 * The panel, for `tsc`. Deliberately loose, on the same reasoning as
 * `types/components.d.ts`: a generated declaration would state the whole
 * internal shape of the panel and pin it. It takes no props.
 *
 * These siblings exist because `moduleResolution: NodeNext` resolves a relative
 * `./Panel.vue` on disk and never consults the `declare module '*.vue'`
 * wildcard — that wildcard only answers for bare specifiers. `tsconfig.json`
 * sets `allowArbitraryExtensions`, which is what makes this filename the
 * declaration for the file beside it.
 *
 * The parts under `panel/` have none, and need none: only other components
 * import them, and `tsc` reads no `.vue` file.
 */
import type { DefineComponent } from 'vue'
declare const component: DefineComponent<Record<string, never>>
export default component
