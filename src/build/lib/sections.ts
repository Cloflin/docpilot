/**
 * Sidebar → scope sections, resolved at BUILD time. RAG-SPEC 2.5.
 *
 * A section is an enumerated path set, never a prefix: in `/reference/` all four
 * groups share the `/reference/` prefix and enumerate arbitrary siblings, so a
 * prefix would collapse them into one. Enumeration also makes the section preset
 * and the multi-page selection the same mechanism.
 */

/** VitePress link resolution: an absolute link ignores `base`; otherwise base + link. */
function resolveLink(base, link) {
  if (!link) return null
  if (link.startsWith('/')) return link.replace(/\/$/, '') || '/'
  const b = base || '/'
  return `${b.endsWith('/') ? b : `${b}/`}${link}`.replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

function walk(nodes, base, depth, out) {
  for (const node of nodes || []) {
    const nodeBase = node.base || base
    const link = resolveLink(nodeBase, node.link)

    // Rule 1: a node without `items` is one page and is never a section.
    if (!node.items) {
      if (link) out.pages.add(link)
      continue
    }

    // Rule 2: a node without `text` is never registered, but its base still
    // propagates and its children are still walked.
    const collected = new Set()

    // Rule 1a: a node carrying BOTH `text` and `items` is a section, and its own
    // resolved link is index 0 of its page list. Four of the six real nodes that
    // do this are group landing pages whose link appears nowhere in their items,
    // so without this a reader standing on /extensions gets a "This section" that
    // excludes the page they are looking at.
    if (link) {
      collected.add(link)
      out.pages.add(link)
    }

    const before = out.pages.size
    const childOut = { pages: new Set(), sections: out.sections }
    walk(node.items, nodeBase, depth + 1, childOut)
    for (const p of childOut.pages) {
      collected.add(p)
      out.pages.add(p)
    }
    void before

    if (node.text) {
      out.sections.push({
        label: node.text,
        depth,
        paths: [...collected],
      })
    }
  }
}

/**
 * VitePress accepts a sidebar in two shapes and this reads both.
 *
 * `SidebarItem[]` — one sidebar for the whole site — and
 * `{ '/guide/': SidebarItem[], … }` — one per route prefix. Only the second was
 * handled, and the first failed as `(nodes || []) is not iterable` from inside
 * `walk`: `Object.entries` on an array yields `['0', node]`, so every "node
 * list" was a single node object. The flat form is the one every small site
 * uses, and it took the whole index build down.
 */
const byScope = (sidebar) =>
  Array.isArray(sidebar) ? { '/': sidebar } : sidebar && typeof sidebar === 'object' ? sidebar : {}

/**
 * @param {object|Array} sidebar themeConfig.sidebar, in either shape
 * @param {(path: string) => boolean} isIndexed a path with zero chunks is dropped
 * @returns {{ sections, orphanPages, allPaths, warnings }}
 */
export function resolveSections(sidebar, isIndexed: (path: string) => boolean = () => true) {
  const warnings: string[] = []
  const out = { pages: new Set<string>(), sections: [] as Array<Record<string, any>> }

  for (const [scope, nodes] of Object.entries(byScope(sidebar))) {
    const scoped = { pages: new Set<string>(), sections: [] as Array<Record<string, any>> }
    walk(nodes, scope === '/' ? '/' : scope, 1, scoped)
    for (const p of scoped.pages) out.pages.add(p)
    for (const s of scoped.sections) out.sections.push({ ...s, scope })
  }

  // Rule 4: a path with zero chunks is dropped and the build warns. A stub page
  // must never break a docs deploy.
  const keep = (p) => {
    if (isIndexed(p)) return true
    warnings.push(`sidebar link has no indexed content: ${p}`)
    return false
  }
  for (const s of out.sections) s.paths = s.paths.filter(keep)
  const allPaths = [...out.pages].filter((p) => isIndexed(p))

  // Rule 5: two sections with set-equal path lists collapse; the deeper survives,
  // ties break on walk order.
  const seen = new Map()
  const sections = []
  for (const s of out.sections) {
    if (!s.paths.length) continue
    const key = [...s.paths].sort().join('|')
    const prior = seen.get(key)
    if (prior) {
      if (s.depth > prior.depth) Object.assign(prior, s)
      warnings.push(`sections collapsed as set-equal: ${prior.label} / ${s.label}`)
      continue
    }
    seen.set(key, s)
    sections.push(s)
  }

  for (const s of sections) {
    s.id = `s--${s.label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`
  }

  return { sections, allPaths, warnings }
}

/**
 * Rule 6. The union of sections is NOT the corpus, and the manifest says so:
 * five real pages sit in no sidebar group and would otherwise be unreachable
 * through any scope narrower than all docs.
 */
export function orphanPages(indexedPaths, sections) {
  const covered = new Set(sections.flatMap((s) => s.paths))
  return indexedPaths.filter((p) => !covered.has(p))
}

/** The deepest section containing a path — the page's `tail` in the manifest. */
export function tailFor(path, sections) {
  let best = null
  for (const s of sections) {
    if (!s.paths.includes(path)) continue
    if (!best || s.depth > best.depth || s.paths.length < best.paths.length) best = s
  }
  return best ? best.label : ''
}
