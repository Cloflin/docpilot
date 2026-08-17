/**
 * A sidebar whose links are all absolute — a workaround for someone else's bug.
 *
 * WHY IT EXISTS. VitePress reads a group's `base` and prefixes its items'
 * relative links with it. `vitepress-plugin-llms` builds llms.txt from the same
 * object and joins the two differently, producing links like
 * `/getting-started/getting-started/creating-an-application.md`. A doubled
 * segment is not cosmetic there: llms.txt exists so that someone else's agent
 * can FOLLOW the links, and a 404 is the whole file failing at its job.
 *
 * WHEN TO DELETE THIS. The moment vitepress-plugin-llms joins `base` the way
 * VitePress does. It is exported from this package rather than pasted into every
 * consumer's config because a workaround copied into twenty projects is a
 * workaround that outlives the bug by years — here it is one import, and one
 * deletion when upstream is fixed.
 *
 *   import { absoluteSidebar } from '@cloflin/docpilot/sidebar'
 *
 *   llmstxt({ sidebar: (s) => absoluteSidebar(s) })
 *
 * Pure and non-mutating: the object VitePress renders from is untouched.
 */
/** VitePress's own `EXTERNAL_URL_RE`, copied rather than imported: this module
 *  is dependency-free by design and the pattern has been stable for years. */
const EXTERNAL_LINK = /^(?:[a-z]+:|\/\/)/i

export function absoluteSidebar(node, base = '') {
  if (Array.isArray(node)) return node.map((n) => absoluteSidebar(n, base))
  if (!node || typeof node !== 'object') return node

  // A multi-sidebar is keyed by route prefix — { '/': [...], '/reference/': [...] }
  // — and its values are the arrays that actually hold the groups. Walking it
  // as if it were a group is why the first version of this function silently
  // did nothing: it found no `link` and no `items` at the top level and
  // returned the object untouched.
  const isGroup = 'link' in node || 'items' in node || 'text' in node || 'base' in node
  if (!isGroup) {
    return Object.fromEntries(
      Object.entries(node).map(([route, value]) => [route, absoluteSidebar(value, base)]),
    )
  }

  const here = node.base || base
  const out = { ...node }
  // The rule VitePress applies, not an approximation of it — this file exists to
  // produce the links VitePress produces, so the two must agree exactly.
  //
  // `addBase` (theme-default/support/sidebar.js) is:
  //   if (base && link && !isExternal(link))
  //     link = base + link.replace(/^\//, base.endsWith('/') ? '' : '/')
  //
  // The old condition here — skip anything starting with `/` — was wrong at both
  // ends. An external link does not start with `/`, so `https://github.com/x`
  // became `/https://github.com/x`. And a link that DOES start with `/` still
  // gets the base under a group that declares one, so `/intro` stayed `/intro`
  // where VitePress renders `/guide/intro` — the 404 in llms.txt this module was
  // written to prevent, arriving from the other direction.
  if (here && typeof out.link === 'string' && !EXTERNAL_LINK.test(out.link)) {
    out.link = here + out.link.replace(/^\//, here.endsWith('/') ? '' : '/')
  }
  delete out.base
  if (out.items) out.items = absoluteSidebar(out.items, here)
  return out
}
