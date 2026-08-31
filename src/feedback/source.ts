/**
 * Where the rows come from — a file the owner exported, or their own endpoint.
 *
 * THIS PACKAGE SHIPS NO DATABASE DRIVER AND WILL NOT. The panel POSTs JSON to an
 * endpoint the site owner runs, into storage the site owner chose, and the way
 * back out is theirs too: `--from ./export.jsonl` reads whatever they dumped,
 * with `psql -c … > export.jsonl` or anything else. A driver here would be this
 * package having an opinion about someone else's infrastructure, and would put
 * their connection string in a docs build.
 *
 * `--from https://…` is the convenience on top, not the mechanism: an owner who
 * already runs a receiver can add a GET beside it rather than exporting by hand.
 * The token for it comes from the ENVIRONMENT, never from the config file — the
 * same rule provider keys already follow, and for the same reason: a config file
 * is committed.
 */

const TOKEN_ENV = 'DOCPILOT_FEEDBACK_TOKEN'

/** JSONL, or a JSON array — sniffed, because both are things people export. */
export function parseRows(text) {
  const s = String(text || '').trim()
  if (!s) return []
  if (s[0] === '[') {
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) throw new Error('expected an array of records')
    return arr
  }
  const rows = []
  for (const [i, line] of s.split('\n').entries()) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      throw new Error(`line ${i + 1} is not JSON — is this JSONL?`)
    }
  }
  return rows
}

/**
 * @param {object} o
 * @param {string} o.from a URL
 * @param {Record<string, string|undefined>} [o.env]
 * @param {number} [o.maxPages]
 * @param {string|null} [o.since] ISO date, passed through as `?since=`
 * @param {(msg: string) => void} [o.log]
 * @param {typeof fetch} [o.fetchImpl]
 */
export async function fetchRows({
  from,
  env = {},
  maxPages = 50,
  since = null,
  log = (_msg: string) => {},
  fetchImpl,
}: {
  from: string
  env?: Record<string, string | undefined>
  maxPages?: number
  since?: string | null
  log?: (msg: string) => void
  fetchImpl?: typeof fetch
}) {
  const doFetch = fetchImpl || globalThis.fetch
  const token = env[TOKEN_ENV]
  const rows = []
  let cursor = null
  let page = 0

  while (page < maxPages) {
    const url = new URL(from)
    if (since) url.searchParams.set('since', since)
    if (cursor) url.searchParams.set('cursor', cursor)
    page++

    const res = await doFetch(url.toString(), {
      headers: {
        accept: 'application/x-ndjson, application/json',
        ...(token ? {authorization: `Bearer ${token}`} : {}),
      },
    })
    // The URL is not printed with its query string: `cursor` is opaque and a
    // token pasted into the URL by mistake must not reach a log line.
    if (!res.ok) throw new Error(`${url.origin}${url.pathname} responded ${res.status}`)

    const type = res.headers.get('content-type') || ''
    const body = await res.text()

    if (type.includes('json') && !type.includes('ndjson') && body.trim()[0] === '{') {
      const payload = JSON.parse(body)
      const items = payload.items || payload.rows || payload.data || []
      rows.push(...items)
      cursor = payload.cursor || payload.next || null
      log(`  page ${page}: ${items.length} rows${cursor ? '' : ' (last)'}`)
      if (!cursor) return rows
    } else {
      const items = parseRows(body)
      rows.push(...items)
      log(`  page ${page}: ${items.length} rows (last)`)
      return rows
    }
  }

  // NO SILENT CAP. Stopping at a page limit and reporting a total looks like
  // "that is all of it", which is the one thing it is not.
  log(`  stopped at --max-pages=${maxPages}; there may be more`)
  return rows
}

export {TOKEN_ENV}
