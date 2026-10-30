/**
 * Link resolution, outside the serialiser — engine-spec 043 (D-10).
 *
 * It used to be a private function of html-to-md.ts that returned null for a
 * link it could not resolve, and nobody learned how many there were. A relative
 * link with no base URL becomes plain text, which is the right fallback, but a
 * page full of them is a page whose navigation is gone, and the build must say
 * so. The resolver therefore counts what it resolved and what it could not, and
 * keeps a failure apart from a link that was never meant to be a web link.
 */

/**
 * A warning names a few degraded hrefs; the count says how many. Three are
 * enough to show whether the cause is one template or a whole site
 * (engine-spec 043).
 */
export const MAX_LINK_SAMPLES = 3

/**
 * Does the href start with a URL scheme? Anchored, with one bounded character
 * class and no nested quantifier (engine-spec 043): `mailto:`, `tel:`,
 * `javascript:` and `data:` are absolute and need no base; `guide/x` and
 * `../x` are not.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

export interface LinkStats {
  /** An http(s) URL came out. */
  resolved: number
  /** The href was relative or malformed and no base made it an http(s) URL: a link failure. */
  degraded: number
  /** An absolute URL with another scheme: kept as text, not a failure (the 2.x security rule). */
  schemeDropped: number
  /** The first raw href that could not be resolved, '' when none. */
  firstDegraded: string
  /** The first MAX_LINK_SAMPLES degraded hrefs. */
  samples: string[]
}

export interface LinkResolver {
  /** The absolute http(s) URL for `href`, or null when the link stays text. */
  resolve(href: string | null | undefined): string | null
  stats: LinkStats
}

export function createLinkResolver({ base = '', id = '' }: { base?: string; id?: string } = {}): LinkResolver {
  const stats: LinkStats = { resolved: 0, degraded: 0, schemeDropped: 0, firstDegraded: '', samples: [] }
  const degrade = (raw: string) => {
    stats.degraded++
    if (!stats.firstDegraded) stats.firstDegraded = raw
    if (stats.samples.length < MAX_LINK_SAMPLES) stats.samples.push(raw)
    return null
  }
  return {
    stats,
    resolve(href) {
      if (!href) return null
      const raw = href.trim()
      // An empty href and a same-page anchor need no base and lose nothing as text.
      if (!raw || raw.startsWith('#')) return null
      try {
        // WHATWG serialisation: an IDN host in punycode, a space as %20, so two
        // spellings of one URL are one string in the corpus.
        const url = new URL(raw, base || undefined)
        // Only http(s) survives. `javascript:` and `data:` never reach a file
        // that somebody could then trust; they are refused, not degraded.
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          stats.resolved++
          return url.href
        }
        if (SCHEME.test(raw)) {
          stats.schemeDropped++
          return null
        }
        // A relative href resolved against a non-web base is a missing base.
        return degrade(raw)
      } catch {
        // `mailto:` and its kin parse without a base, so a throw is a relative
        // or malformed href: a real failure.
        return degrade(raw)
      }
    },
  }
}
