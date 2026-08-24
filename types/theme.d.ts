/**
 * `@cloflin/docpilot/theme` — the VitePress half.
 *
 * Importing it installs the VitePress host binding and chooses Shiki. Nothing is
 * loaded by either; the grammars are fetched when the panel is first opened.
 */
import type { Component } from 'vue'

export * from './components.js'

/** The four layout slots the panel claims. */
export declare function docPilotSlots(
  slots?: Record<string, unknown>,
): Record<string, () => unknown>

/**
 * Add the panel to any theme, including one that already fills layout slots.
 * A theme that fills one of the four claimed slots loses it.
 */
export declare function withDocPilot<T extends { Layout?: Component; extends?: unknown }>(
  theme?: T,
): T

declare const theme: { Layout: Component; extends?: unknown }
export default theme
