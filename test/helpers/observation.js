/**
 * Reading the envelope back — engine-spec 048.
 *
 * `buildMessages` renders a tool result as a `<tool_result>` block and every
 * question in `<question>` tags (prompt.ts `renderObservation`, `askedBlock`).
 * The tests that pin what a turn SAYS — the query a search ran on, the ids it
 * found, the question a history pair carried — read it through these, so they
 * assert the content and not one encoding of it.
 */

const unescapeAttribute = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

const attributesOf = (s) =>
  Object.fromEntries([...String(s).matchAll(/ ([a-z_]+)="([^"]*)"/g)].map(([, k, v]) => [k, unescapeAttribute(v)]))

/** A rendered `<tool_result>` → the observation object it was rendered from; null for anything else. */
export function readObservation(content) {
  const s = String(content)
  const head = /^<tool_result([^>]*)>\n/.exec(s)
  if (!head) return null
  const o = attributesOf(head[1])
  const one = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s)?.[1]
  const query = one('query')
  if (query != null) o.query = query
  const note = one('note')
  if (note != null) o.note = note
  const error = one('error')
  if (error != null) o.tool_error = error
  const ids = one('ids')
  if (ids != null) o.ids = ids.split(', ')
  const results = [
    ...s.matchAll(/<document([^>]*?)\/>|<document([^>]*)>\n([\s\S]*?)\n<\/document>|<page([^>]*?)\/>/g),
  ].map(([, empty, open, text, page]) =>
    page != null ? attributesOf(page) : empty != null ? attributesOf(empty) : { ...attributesOf(open), text },
  )
  if (results.length) o.results = results
  return o
}

/** The reader's question inside a user message, without its tags — the message itself when it has none. */
export function questionOf(content) {
  const m = /<question>\n([\s\S]*?)\n<\/question>/.exec(String(content))
  return m ? m[1] : String(content)
}
