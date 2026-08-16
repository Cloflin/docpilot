/**
 * Retrieval scope — RAG-SPEC 2.5, 3.3.
 *
 * A scope is an enumerated set of page paths, never a prefix, and it is resolved
 * at build time into the manifest. This module owns the live value, its label
 * and its restoration; enforcement lives in retriever.js and nowhere else.
 */

const KEY = 'docpilot:scope'

export const ALL = Object.freeze({ kind: 'all', paths: [], label: 'All docs' })

/**
 * Label precedence: all > page > section > custom.
 *
 * A set-equal match against a section wins over "{n} pages" because a reader who
 * ticked every page of Getting Started means Getting Started, and being told
 * they selected "5 pages" is a worse description of their own action.
 */
export function labelFor(scope, manifest) {
  if (!scope || scope.kind === 'all' || !scope.paths.length) return 'All docs'
  if (scope.paths.length === 1) {
    const page = manifest.pages.find((p) => p.path === scope.paths[0])
    return page ? page.title : scope.paths[0]
  }
  const key = [...scope.paths].sort().join('|')
  for (const s of manifest.sections) {
    const paths = s.pageIdx.map((i) => manifest.pages[i]?.path).filter(Boolean)
    if (paths.length === scope.paths.length && [...paths].sort().join('|') === key) return s.label
  }
  return `${scope.paths.length} pages`
}

export function makeScope(paths, manifest) {
  const unique = [...new Set(paths)].filter(Boolean)
  if (!unique.length) return { ...ALL }
  const scope = { kind: unique.length === 1 ? 'page' : 'custom', paths: unique }
  scope.label = labelFor(scope, manifest)
  const key = [...unique].sort().join('|')
  const section = manifest.sections.find((s) => {
    const paths2 = s.pageIdx.map((i) => manifest.pages[i]?.path).filter(Boolean)
    return paths2.length === unique.length && [...paths2].sort().join('|') === key
  })
  if (section) scope.kind = 'section'
  return scope
}

/** The deepest section containing `path`, or null. Drives the `This section` preset. */
export function sectionFor(path, manifest) {
  let best = null
  for (const s of manifest.sections) {
    const paths = s.pageIdx.map((i) => manifest.pages[i]?.path).filter(Boolean)
    if (!paths.includes(path)) continue
    if (!best || s.depth > best.depth || paths.length < best.paths.length) best = { ...s, paths }
  }
  return best
}

/**
 * `This section` is hidden where it would be a synonym of `This page`: the five
 * orphan pages belong to no section, and the three one-page sections contain
 * only the page the reader is standing on.
 */
export function offersSection(path, manifest) {
  const s = sectionFor(path, manifest)
  return !!s && s.paths.length > 1
}

/**
 * A scope is frozen into the turn at submit. The drawer is non-modal and
 * survives route changes, so a live "current page" preset would silently
 * re-scope a running thread and make the guarantee unfalsifiable to the only
 * person it is for.
 */
export function freeze(scope) {
  return Object.freeze({
    kind: scope.kind,
    label: scope.label,
    paths: Object.freeze([...scope.paths]),
  })
}

export function save(scope, indexHash) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ hash: indexHash, scope }))
  } catch {
    /* private mode, quota, disabled storage — the scope simply does not persist */
  }
}

/**
 * Restored only when the index hash matches AND every path still exists. A page
 * can be renamed between the session being saved and restored, and a scope that
 * silently drops a page is worse than one that resets and says so.
 */
export function restore(manifest) {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return { scope: { ...ALL }, reset: false }
    const { hash, scope } = JSON.parse(raw)
    if (hash !== manifest.hash) return { scope: { ...ALL }, reset: true }
    const known = new Set(manifest.pages.map((p) => p.path))
    if (!scope.paths.every((p) => known.has(p))) return { scope: { ...ALL }, reset: true }
    return { scope, reset: false }
  } catch {
    return { scope: { ...ALL }, reset: false }
  }
}
