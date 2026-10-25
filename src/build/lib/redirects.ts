/**
 * A fetch that walks its own redirects, so the allowlist sees every hop BEFORE
 * it is requested.
 *
 * `redirect: 'follow'` lets the runtime request each `Location` itself, and a
 * check on `res.url` afterwards can only discard a body the network already
 * delivered. An allowed origin that answers `302 Location: http://10.0.0.5/…`
 * would make the importer send that GET from the operator's laptop or CI runner.
 * Here each `Location` is resolved and checked first, and the walk is bounded.
 */

/** Hops after the first request. Enough for http→https→trailing-slash chains. */
export const MAX_HOPS = 5

/**
 * @param {string} url the URL to request; the caller has already checked it
 * @param {object} o
 * @param {((u: string) => {href: string}|{error: string})|null} [o.allow] the check
 *   each redirect target must pass; `null` follows without checking
 * @param {Function} [o.fetchImpl]
 * @param {object} [o.init] fetch options; `redirect` is always replaced
 * @param {number} [o.maxHops]
 * @returns {Promise<{res: any, url: string, refused: string|null}>} the last
 *   response, the URL it came from, and the redirect target that failed the
 *   allowlist (`res` is then the 3xx that named it, and nothing was requested
 *   from that target)
 */
export async function fetchWithin(url, { allow = null, fetchImpl = fetch, init = {}, maxHops = MAX_HOPS } = {}) {
  let current = url
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current, { ...init, redirect: 'manual' })
    const status = Number(res?.status)
    const location = status >= 300 && status < 400 ? res.headers?.get?.('location') : null
    if (!location) {
      // A fetch implementation that follows redirects whatever it is told still
      // reports where the body came from. Refuse that body too.
      const final = res?.url || current
      const refused = allow && final !== current && 'error' in allow(final) ? final : null
      return { res, url: final, refused }
    }
    let next
    try {
      next = new URL(location, current).href
    } catch {
      throw new Error(`${current} redirected to a Location that is not a URL`)
    }
    if (allow && 'error' in allow(next)) return { res, url: next, refused: next }
    if (hop >= maxHops) throw new Error(`${url} redirected more than ${maxHops} times`)
    try {
      await res.body?.cancel?.()
    } catch {
      // Draining is a courtesy to the connection pool, not a requirement.
    }
    current = next
  }
}
