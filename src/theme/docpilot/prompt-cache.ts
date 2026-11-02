/**
 * Prompt caching on the wire — the places a service takes a hint, and the rule
 * for each. The text of the prompt is not touched here or anywhere this file is
 * used: a hint changes what the provider may reuse, never what the model reads.
 *
 *   anthropic          `system` is a block array whose last block carries
 *                      `cache_control`, and so does the last tool. Native
 *                      Messages API; it always takes the field.
 *
 * NO IMPORTS, and none may be added: this file ships to the browser and the
 * server alike, and `providers.ts` is the only module that calls it.
 */

/** The one marker Anthropic's API defines. A new object each time, so no caller can share a mutation. */
export const ephemeral = () => ({ type: 'ephemeral' as const })

/**
 * The last item of a list with `cache_control` on a COPY of it. The list and its
 * items are shared with the harness, which builds them once and reuses them, so
 * marking one in place would mark it on the next request to a different service.
 */
export function markLast<T extends object>(list: T[]): T[] {
  if (!list.length) return list
  return [...list.slice(0, -1), { ...list[list.length - 1], cache_control: ephemeral() }]
}
