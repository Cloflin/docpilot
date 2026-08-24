/**
 * A source file path to the route the site serves it at — the one rule, in the
 * one place both halves read it from.
 *
 * `docs/guide/install.md` → `/guide/install`, and an `index` collapses to its
 * directory, so `docs/index.md` → `/` and `docs/guide/index.md` → `/guide`.
 *
 * IT USED TO BE WRITTEN TWICE, and the two copies disagreed. The indexer built
 * `/${rel}` and then stripped a trailing `/index`; the panel stripped `/index`
 * from `rel` first, where it has no leading slash and therefore never matched.
 * Both produced `/guide` for `guide/index.md`; on the site root one produced `/`
 * and the other `/index`. Nothing in the UI said so — `state.currentPath` simply
 * matched no page in the manifest, so on the home page the *this page* scope
 * offered nothing and the reader saw a picker with one option missing.
 *
 * That is the failure mode a duplicated rule has: it agrees on the cases anyone
 * tests and diverges on the one nobody does. Hence this module, which is
 * imported by `build-rag-index.js` on the Node side and by `host.js` on the
 * browser side, and imports nothing itself — not even Vue, so the index builder
 * does not pull a UI framework in to compute a string.
 *
 * The value is BASE-LESS, and every path in the manifest is too. That is the
 * invariant the citation validator depends on: `isKnownPath` compares an href
 * against `manifest.pages[].path`, and a base on either side of that comparison
 * would de-link the product's own citations.
 */
export function routeOf(rel) {
  const bare = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/\.md$/, '')
  return `/${bare}`.replace(/\/index$/, '') || '/'
}
