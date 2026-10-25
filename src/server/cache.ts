/**
 * The two things a server turn can remember between readers — engine-spec 031.
 *
 * QUERY VECTORS, ON BY DEFAULT. The same question costs the same embedding, and
 * a follow-up re-embeds the composed text a previous turn may already have
 * bought. A vector is a pure function of (model, text) — the vocabulary gloss
 * `embedQuery` appends is fixed for the life of the process, because the index
 * is read once at start — so a hit is the byte-identical vector, never an
 * approximation, and caching it changes nothing a reader can see except the
 * time it took.
 *
 * WHOLE ANSWERS, OFF BY DEFAULT. A first turn with no history, no quote, no
 * addendum and the whole corpus in scope is a pure function of (index, prompt,
 * model, question) only in the sense that the model is sampled — two readers
 * asking the same thing would get two different wordings. Serving the first
 * wording to the second reader is a product decision, not a speed fix, so the
 * owner switches it on (`server.cache.answers`) and gets a TTL with it.
 */

/** A Map in insertion order is an LRU once a hit re-inserts. */
export function createLru<V>(max: number, { ttlMs = Infinity, now = Date.now } = {}) {
  const map = new Map<string, { v: V; at: number }>()
  return {
    get(key: string): V | undefined {
      const e = map.get(key)
      if (!e) return undefined
      if (now() - e.at > ttlMs) {
        map.delete(key)
        return undefined
      }
      map.delete(key)
      map.set(key, e)
      return e.v
    },
    set(key: string, v: V) {
      if (max <= 0) return
      map.delete(key)
      map.set(key, { v, at: now() })
      while (map.size > max) map.delete(map.keys().next().value as string)
    },
    get size() {
      return map.size
    },
  }
}

export type Lru<V> = ReturnType<typeof createLru<V>>

/** One key per (model, text). NUL cannot occur in either half. */
export const vectorKey = (model, text) => `${model ?? ''}\u0000${text}`

/**
 * The answer-cache key, or null when the turn is not cacheable at all.
 *
 * Everything that can change the answer is in the key or excludes the turn:
 * the index and prompt hashes, the model, the reader's language, and the
 * question normalised the way the lexical opener normalises it.
 */
export function answerKey(input, { indexHash, promptHash, model }) {
  if (input.history?.length || input.quote || input.addendum || input.scope?.paths?.length) return null
  const q = String(input.question || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim()
  if (!q) return null
  return [indexHash, promptHash, model, input.lang || '', q].join('\u0000')
}
