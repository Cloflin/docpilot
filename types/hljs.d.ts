/**
 * highlight.js — for a blog or an older docs site where it is already on the
 * page.
 *
 * Optional peer: `highlight.js`. The page has to carry a highlight.js theme; see
 * `/reference/highlighting`.
 */
import type { Highlighter } from './highlight.js'

export declare function createHljsHighlighter(options?: {
  /** An existing instance. `globalThis.hljs` is used when one is there. */
  hljs?: unknown
}): Highlighter
