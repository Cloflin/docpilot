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
  if (typeof out.link === 'string' && !out.link.startsWith('/')) {
    out.link = `${here.replace(/\/$/, '')}/${out.link}`
  }
  delete out.base
  if (out.items) out.items = absoluteSidebar(out.items, here)
  return out
}
