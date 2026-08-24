/**
 * Prism — for a site that already ships it.
 *
 * Optional peer: `prismjs`. Emits no `language-*` class, so the host's theme
 * colours the tokens while the code card keeps `--dp-code-bg`. The page has to
 * carry a Prism stylesheet; see `/reference/highlighting`.
 */
import type { Highlighter } from './highlight.js'

export declare function createPrismHighlighter(options?: {
  /** An existing Prism. `globalThis.Prism` is used when one is there. */
  prism?: unknown
}): Highlighter
