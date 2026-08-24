/**
 * Shiki — the default on VitePress, and the closest match between the panel's
 * code blocks and a Shiki-built page's.
 *
 * Optional peers: `@shikijs/core`, `@shikijs/engine-javascript`,
 * `@shikijs/langs`, `@shikijs/themes`.
 */
import type { Highlighter } from './highlight.js'

export declare function createShikiHighlighter(options?: {
  /**
   * Returns a Shiki core instance. The supported way to ship different themes
   * or extra grammars — and the seam the unit tests inject through.
   */
  create?: () => Promise<unknown>
}): Highlighter
