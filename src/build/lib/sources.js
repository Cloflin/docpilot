/**
 * External provenance — the allowlist that decides which origins a page may
 * name in its frontmatter `source:`.
 *
 * The list itself is `docPilot.sources.allow`, declared once beside every other Ask
 * AI decision and read from there by both consumers. An authoring tool refuses
 * to FETCH outside it; `build-rag-index.js` refuses to BUILD outside it. The
 * second check is not a duplicate of the first: the tool guards the network, the
 * indexer guards the DOM. A `source:` value travels into `manifest.pages[].origin`,
 * into `sourceRow()`, and out as an `href` inside the answer panel — so a
 * hand-written `javascript:…` in any markdown file would be stored XSS if the
 * only gate were the tool that happened to write that file. Markdown is content,
 * and content is never trusted with a URL scheme.
 *
 * Pure and I/O-free, so the rules are unit-testable without a build.
 */

/** An entry is an origin, optionally narrowed to a path prefix. */
function parseEntry(raw, i) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return { error: `docPilot.sources.allow[${i}] is not a URL: ${JSON.stringify(raw)}` }
  }
  if (u.protocol !== 'https:') {
    return { error: `docPilot.sources.allow[${i}] is not https: ${raw}` }
  }
  if (u.search || u.hash) {
    return {
      error: `docPilot.sources.allow[${i}] carries a query or fragment, which cannot narrow an origin: ${raw}`,
    }
  }
  return { origin: u.origin, prefix: u.pathname.replace(/\/$/, '') }
}

/**
 * @param {any} sources the `docPilot.sources` object, or undefined — checked
 *   rather than trusted, which is why this is not typed as the shape it wants
 * @returns {{ entries: Array<{origin: string, prefix: string}>, errors: string[] }}
 */
export function parseAllowlist(sources) {
  const errors = []
  const entries = []
  // Absent is legal and means "no page may declare a source" — a repo with no
  // imported page needs no list. Present-but-malformed is not legal: it reads as
  // an allowlist that is silently allowing nothing.
  if (sources === undefined || sources === null) return { entries, errors }
  if (typeof sources !== 'object' || !Array.isArray(sources.allow)) {
    return { entries, errors: ['docPilot.sources must be an object with an "allow" array'] }
  }
  sources.allow.forEach((raw, i) => {
    const e = parseEntry(raw, i)
    if (e.error) errors.push(e.error)
    else entries.push(e)
  })
  return { entries, errors }
}

/**
 * @param {string} url the frontmatter value, verbatim
 * @param {Array<{origin: string, prefix: string}>} entries
 * @returns {{ href: string } | { error: string }}
 */
export function checkSource(url, entries) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    return { error: `source is not an absolute URL: ${JSON.stringify(url)}` }
  }
  // Scheme first and by allowlist, not by denylist: `javascript:`, `data:` and
  // `vbscript:` are the named ones, and the next one is the one nobody named.
  if (u.protocol !== 'https:') {
    return { error: `source must be https, got "${u.protocol}": ${url}` }
  }
  if (!entries.length) {
    return { error: `source ${u.href} is declared but docPilot.sources.allow is empty` }
  }
  const ok = entries.some(
    (e) =>
      u.origin === e.origin &&
      (!e.prefix || u.pathname === e.prefix || u.pathname.startsWith(`${e.prefix}/`)),
  )
  if (!ok) {
    const list = entries.map((e) => `${e.origin}${e.prefix}`).join(', ')
    return { error: `source ${u.href} is outside docPilot.sources.allow (${list})` }
  }
  return { href: u.href }
}
