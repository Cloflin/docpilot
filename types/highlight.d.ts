/**
 * The highlighter registry — the public API for plugging in your own.
 *
 * These declarations ARE the documented contract; `/reference/highlighting`
 * explains the reasoning behind each rule.
 */

/**
 * An adapter. Five members, no base class, nothing to extend.
 *
 * `render` MUST be synchronous: the answer is re-rendered every ~90ms while it
 * streams, and an adapter that returns a promise gets one console error and its
 * output discarded. It must also ESCAPE the code it wraps — the return value is
 * inserted as HTML — and it must never emit a class containing `language-`,
 * because VitePress binds a window-level listener to
 * `div[class*="language-"] > button.copy` and the panel teleports to `<body>`.
 */
export interface Highlighter {
  /** Identifies it in error messages. */
  id: string
  /**
   * Extra fence aliases, `alias → canonical id`.
   *
   * Validated when the adapter is installed, not when a fence is rendered: the
   * value reaches a `data-lang` attribute unescaped, so both halves must match
   * `/^[a-z0-9+#.-]{1,20}$/` and the right-hand side must be something
   * `loaded()` reports.
   */
  langs?: Record<string, string>
  /** Everything asynchronous. Called once, by `ensureHighlighter()`. */
  load?(): Promise<void>
  /** The canonical ids ready to render — the panel's names, not the engine's. */
  loaded?(): Iterable<string>
  /** Complete markup including the `<pre>`, or null. Synchronous. */
  render(code: string, lang: string): string | null
}

/** The canonical ids this panel speaks. */
export type CanonicalLang = 'ts' | 'js' | 'bash' | 'json' | 'jsonc' | 'yaml' | 'html' | 'css'

/** The shipped alias table. Frozen, and with no prototype to reach through. */
export declare const LANGS: Readonly<Record<string, CanonicalLang>>

/** A fence's info string to a canonical id, or null. The sanitiser. */
export declare function resolveLang(info: string | undefined): string | null

/** Install a highlighter, or `null` to remove one. Clears the memo. */
export declare function setHighlighter(next: Highlighter | null): void
export declare function getHighlighter(): Highlighter | null

/** Load the installed highlighter's grammars. Idempotent; a no-op with none. */
export declare function ensureHighlighter(): Promise<void>

/** Fires once, when a highlighter finishes loading. Returns an unsubscribe. */
export declare function onReady(fn: () => void): () => void

/** Synchronous, and null-returning rather than throwing. */
export declare function highlight(code: string, lang: string): string | null
