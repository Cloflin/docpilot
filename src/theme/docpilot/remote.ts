/**
 * The panel's half of a server turn — engine-spec 028.
 *
 * Two calls and nothing else: the shell manifest, and one turn read as a stream.
 * No index, no prompt, no threshold and no transport live on this side, so
 * this module has nothing to configure and nothing to keep.
 *
 * `fetch` + a reader, not `EventSource`: the turn is a POST with a body, and
 * `EventSource` can only GET. The framing is SSE all the same — `event:` and
 * `data:` lines, a blank line between events, `:` lines ignored — because every
 * proxy on the way already knows not to buffer it.
 */

/**
 * The index the browser holds under a server runtime: the manifest's pages and
 * sections, and a `byId` that fills only with the chunks an answer cited. Every
 * reader of `state.index` that wants a page or a section works unchanged; every
 * reader that wants the corpus finds nothing, which is the point.
 */
export async function loadShell(endpoint: string) {
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/manifest`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${endpoint}/manifest → ${res.status}`)
  const manifest = await res.json()
  return { manifest, chunks: [], byId: new Map(), shell: true }
}

/** Split an SSE byte stream into `{event, data}` objects. Exported for the tests. */
export function sseParser(onEvent: (event: string, data: any) => void) {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let at
    while ((at = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, at)
      buffer = buffer.slice(at + (buffer[at] === '\r' ? 4 : 2))
      let event = 'message'
      const data = []
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (!data.length) continue
      let parsed
      try {
        parsed = JSON.parse(data.join('\n'))
      } catch {
        continue
      }
      onEvent(event, parsed)
    }
  }
}

/**
 * POST one turn and hand every event to `on`. Resolves when the stream ends;
 * rejects on a transport failure or a non-2xx, and with the signal's reason on
 * abort — the same three outcomes `runTurn` has.
 */
export async function postTurn(
  endpoint: string,
  body: Record<string, unknown>,
  { signal, on }: { signal?: AbortSignal; on: (event: string, data: any) => void },
) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = ''
    let rateLimit = null
    try {
      const doc = await res.json()
      detail = doc?.error || ''
      rateLimit = doc?.rateLimit ?? null
    } catch {
      /* a proxy's HTML error page is not worth parsing */
    }
    const e = new Error(`${endpoint} → ${res.status}${detail ? ` (${detail})` : ''}`)
    // The server's limiter (engine-spec 033) answers 429 with the panel's own
    // rate-limited shape, so the reader sees when answers resume — the state a
    // spent daily allowance already lands on — instead of "didn't respond".
    if (res.status === 429 && rateLimit) Object.assign(e, { rateLimit })
    throw e
  }
  const feed = sseParser(on)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    feed(decoder.decode(value, { stream: true }))
  }
  feed(decoder.decode() + '\n\n')
}
