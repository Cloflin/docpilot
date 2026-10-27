/**
 * The site-tool registry — engine-spec 038.
 *
 * A tool is DEFINED in the config (`tools`), where the build checks it and the
 * model is told about it. This supplies what the config cannot carry to a
 * browser, which is a function: `registerTool('plan_limits', handler)` runs that
 * tool with `handler` from then on, ahead of any `run` the config declares.
 *
 * One registry per page, whichever entry registered — it lives on `globalThis`.
 */
import type { ToolContext } from './config.js'

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>

/** @returns a function that removes this handler again */
export declare function registerTool(name: string, handler: ToolHandler): () => void
