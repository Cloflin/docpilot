/**
 * The host binding — what the panel needs to know about the site it is mounted
 * on, and the only place any of it is written down.
 *
 * The components used to import `useData` and `useRouter` from `vitepress`
 * directly. That made the panel's four questions — *what is configured, what
 * page is this, what language is it in, how do I navigate* — VitePress's to
 * answer, and the documented workaround for every other site was to alias the
 * bare specifier `vitepress` at the bundler and hand-write a module that
 * answered them. This file is that shim, promoted to an API, so the answer is
 * given by whoever actually knows it.
 *
 * TWO HALVES, and the split is not cosmetic:
 *
 *   · THE BINDING is reactive and is produced by a FACTORY, because `useData()`
 *     calls `inject()` and `inject()` is only legal during a component's setup.
 *     A binding built at install time would be built at import time, which is
 *     before any app exists. So what is installed is a function, and it runs
 *     inside the component that needs it.
 *
 *   · THE ENVIRONMENT is static — the site's base path and the host's own DOM
 *     selectors — and is stored as plain values, because `session.js` and the
 *     retrieval store read it and neither of them is a component. A ref would
 *     be unreadable from there; a getter that needed setup would be worse.
 *
 * The shape is deliberately NOT `useData()`'s. `page.relativePath` is a source
 * FILE path, a concept only a markdown-driven generator has; every host knows
 * its own route. So the binding carries `route`, and turning a file path into
 * one is the VitePress binding's job — see `host-vitepress.js`.
 *
 * ```js
 * // a host that is not VitePress
 * import { setHost, createStandaloneHost } from '@cloflin/docpilot/host'
 *
 * const host = createStandaloneHost({ theme: { docPilot: config }, route: '/', lang: 'en' })
 * setHost(host.factory, { base: '/docs/', selectors: { article: 'article' } })
 * // …then on every navigation:
 * host.update({ route: '/guide/install' })
 * ```
 */

import { getCurrentInstance, inject, ref, shallowRef } from 'vue'

/**
 * Per-app override, for the case the module registry cannot express: two panels
 * on one page bound to different hosts.
 *
 * `Symbol.for`, not `Symbol()`. A duplicated copy of this module — two versions
 * resolved side by side, which is a normal outcome of a bundler and a linked
 * package disagreeing — would otherwise mint two different keys, and the
 * `provide` from one would be invisible to the `inject` in the other. The
 * failure that produces is a panel that silently renders the inert default.
 */
export const HOST_KEY = Symbol.for('docpilot.host')

/**
 * The default: a host that answers every question with a defensible nothing.
 *
 * It exists so that importing a component into a context nobody bound — a unit
 * test, an SSR pass, a story — renders rather than throws. `enabled` is absent
 * rather than false, so the panel's own `!== false` test still admits it and a
 * config pushed in later through `update()` takes effect without a reinstall.
 */
let fallback = null
let factory = null
let env = { base: null, selectors: null }

/**
 * Install a host.
 *
 * @param {() => object} fn   called inside a component's setup; returns the binding
 * @param {{base?: string, selectors?: object}} [environment]  static, readable anywhere
 */
export function setHost(fn, environment = {}) {
  factory = typeof fn === 'function' ? fn : null
  env = {
    base: environment.base ?? null,
    selectors: environment.selectors ?? null,
  }
}

/**
 * Uninstall YOUR host, not whoever's is currently installed.
 *
 * The registry holds exactly one binding, and a panel that did not put it there
 * has no business taking it out. `mountDocPilot().destroy()` used to call
 * `setHost(null)` unconditionally, which on a page with two panels — the case
 * this registry exists for — left the survivor on the inert fallback: `route`
 * pinned to `/`, no config, and navigation by full page load. Silently, because
 * the fallback is built to render rather than throw.
 *
 * @param {() => object} fn  the factory this caller passed to `setHost`
 */
export function releaseHost(fn) {
  if (fn && factory === fn) setHost(null)
}

/** The static half — safe to call from a module that is not a component. */
export function hostEnv() {
  return env
}

/**
 * The binding, from inside a component's setup.
 *
 * Order is `provide` → registry → inert, and it is the order of specificity:
 * an app that was explicitly given a host beats the one the package installed
 * for the whole page, which beats no host at all.
 */
export function useHost() {
  // `inject` outside setup logs a warning and returns the default, so the guard
  // is what keeps a unit test that calls this directly from printing one.
  const provided = getCurrentInstance() ? inject(HOST_KEY, null) : null
  const fn = provided || factory
  if (fn) return fn()
  if (!fallback) fallback = createStandaloneHost()
  return fallback.binding
}

/**
 * A binding driven by function calls rather than by a framework.
 *
 * This is what every non-Vue host uses: React, a Docusaurus client module, a
 * `<script>` tag on a blog. The refs are real refs, so the panel's watchers fire
 * exactly as they do on VitePress; what changes is who writes to them.
 *
 * @returns {{factory: () => object, update: (next: object) => void, binding: object}}
 */
export function createStandaloneHost(init = {}) {
  const theme = shallowRef(init.theme ?? {})
  const route = ref(init.route ?? '/')
  const lang = ref(init.lang ?? 'en')

  /**
   * The last-resort navigation: a full page load.
   *
   * Correct rather than merely adequate — a host with no router IS a site where
   * following a link means loading a page. A host that has one passes it in and
   * the panel keeps its thread.
   */
  const router = init.router ?? {
    go(href) {
      if (typeof location !== 'undefined') location.href = href
    },
  }

  const binding = { theme, route, lang, router }

  return {
    binding,
    factory: () => binding,
    /**
     * Only the keys present are written. `update({ route })` on every navigation
     * must not reset the config to a default the caller never mentioned, which
     * is what a spread over a defaults object would do.
     */
    update(next = {}) {
      if ('theme' in next) theme.value = next.theme
      if ('route' in next) route.value = next.route
      if ('lang' in next) lang.value = next.lang
    },
  }
}

/**
 * Re-exported, not redefined — see `route.js` for the two copies this used to be
 * and what their disagreement cost. Any host whose routes come from file paths
 * wants it; the VitePress binding is simply the first one that did.
 */
export { routeOf } from './route.js'

/**
 * `base` + a relative path, with exactly one slash between them and none at the
 * end.
 *
 * The trailing slash is what makes it worth a function: `loadIndex` builds
 * `${base}/manifest.json`, so a base that already ends in one produces a double
 * slash. Most servers forgive that; a signed CDN URL does not, and neither does
 * a cache key.
 */
export function joinBase(base, rel) {
  const b = String(base || '/').replace(/\/+$/, '')
  const r = String(rel || '').replace(/^\/+/, '')
  return `${b}/${r}`.replace(/\/+$/, '') || '/'
}

/**
 * The site's four seams, resolved: author → binding → neutral.
 *
 * Takes the config rather than reading it, and that is not a style choice.
 * `session.js` would be the obvious place to read it from, but `session.js` has
 * to call this to know where the index is — so a module-level read here would
 * be an import cycle. Passing it in also serves the caller this file could not
 * otherwise reach: `DocPilotQuote` mounts on every page and needs `article`
 * BEFORE `configure()` has run, so it passes `theme.docPilot` straight off the
 * host binding.
 *
 * @param {object} [cfg]  the `docPilot` config — `theme.value.docPilot` or `session.state.config`
 */
export function hostConfig(cfg) {
  const authored = cfg?.host || {}
  const bound = env.selectors || {}
  const base = String(authored.base ?? env.base ?? '/')
  return {
    base,
    ragBase: authored.ragBase ?? joinBase(base, 'rag'),
    article: authored.article ?? bound.article ?? 'main',
    // `false` is the author saying "not on this site" and has to survive a
    // binding that supplies one; `null` is the author saying nothing.
    search: authored.search === false ? null : (authored.search ?? bound.search ?? null),
    content: authored.content ?? bound.content ?? 'main',
  }
}

/** Test seam. Releases both halves, including the memoised inert binding. */
export function __resetHostForTests() {
  factory = null
  fallback = null
  env = { base: null, selectors: null }
}
