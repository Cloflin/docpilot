/**
 * Link resolution, outside the serialiser — engine-spec 043 (D-10).
 *
 * It used to be a private function of html-to-md.ts that returned null for a
 * link it could not resolve, and nobody learned how many there were. A relative
 * link with no base URL becomes plain text, which is the right fallback, but a
 * page full of them is a page whose navigation is gone, and the build must say
 * so. The resolver therefore counts what it resolved and what it could not.
 */

export interface LinkStats {
  resolved: number
  degraded: number
  /** The first raw href that could not be resolved, '' when none. */
  firstDegraded: string
}

export interface LinkResolver {
  /** The absolute http(s) URL for `href`, or null when the link stays text. */
  resolve(href: string | null | undefined): string | null
  stats: LinkStats
}

export function createLinkResolver({ base = '', id = '' }: { base?: string; id?: string } = {}): LinkResolver {
  const stats: LinkStats = { resolved: 0, degraded: 0, firstDegraded: '' }
  return {
    stats,
    resolve(href) {
      if (!href) return null
      const raw = href.trim()
      // A same-page anchor needs no base and loses nothing as text.
      if (!raw || raw.startsWith('#')) return null
      try {
        const url = new URL(raw, base || undefined)
        // Only http(s) survives. `javascript:` and `data:` never reach a file
        // that somebody could then trust; they are refused, not degraded.
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          stats.resolved++
          return url.href
        }
        return null
      } catch {
        stats.degraded++
        if (!stats.firstDegraded) stats.firstDegraded = raw
        return null
      }
    },
  }
}
