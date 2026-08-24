/**
 * Mount the panel on a site that is not VitePress — one call, no theme, no slots.
 *
 *     import { mountDocPilot } from '@cloflin/docpilot/mount'
 *     import '@cloflin/docpilot/style/core.css'
 *
 *     const panel = mountDocPilot({ config: window.__DOCPILOT__ })
 *     // …on every navigation:
 *     panel.setRoute(location.pathname)
 *
 * THIS ENTRY POINT SHIPS SOURCE, and that decides who it is for. It imports
 * `.vue` single-file components, so the bundler on the other side has to be able
 * to compile them: Vite or Rollup with the Vue plugin, which is every Vue and
 * Nuxt project and most Astro ones. A webpack host — Docusaurus, Create React
 * App, Next — has no `.vue` loader, and `babel-loader` excludes `node_modules`
 * besides. Those use `@cloflin/docpilot/web`, which is this same module already
 * compiled with Vue bundled in.
 *
 * It imports NO stylesheet. `@cloflin/docpilot/style/core.css` is the panel on
 * real values, with its own `prefers-color-scheme` dark branch and no host
 * mapping; a site with its own design tokens maps the `--dp-*` set instead. See
 * [appearance](https://docpilot.dev/guide/appearance).
 */

import { createApp, h } from 'vue'

import * as session from './theme/docpilot/session.js'
import { HOST_KEY, setHost, releaseHost, createStandaloneHost } from './theme/docpilot/host.js'
import { setHighlighter } from './theme/docpilot/highlight.js'
import DocPilot from './theme/components/DocPilot.vue'
import DocPilotTrigger from './theme/components/DocPilotTrigger.vue'
import DocPilotIcons from './theme/components/DocPilotIcons.vue'
import DocPilotQuote from './theme/components/DocPilotQuote.vue'

/**
 * What every method does when there is no document — an SSR pass, a prerender,
 * a Node import.
 *
 * Returned instead of throwing, and instead of making the caller write the
 * guard. A host that renders on the server calls `mountDocPilot` in the same
 * place either way; the alternative is `typeof window !== 'undefined' &&` in
 * front of every call site, which is a condition that gets forgotten once.
 */
const INERT = {
  open() {},
  close() {},
  toggle() {},
  ask() {},
  setRoute() {},
  setLang() {},
  setConfig() {},
  destroy() {},
  app: null,
  mounted: false,
}

/**
 * @param {object}   [options]
 * @param {object}   [options.config]      the client config — `ai.themeConfig` from `defineDocPilot`
 * @param {Element}  [options.target]      where to mount. A div is created and appended to `<body>` without one
 * @param {'fab'|'nav'|'none'} [options.trigger='fab']  which button to render, if any
 * @param {string}   [options.route='/']   the current page's route, base-less
 * @param {string}   [options.lang]        the page's locale. Read from `<html lang>` when omitted
 * @param {string}   [options.base]        the site's base path
 * @param {string}   [options.ragBase]     where the index is served from
 * @param {object}   [options.selectors]   `{article, search, content}` for this host
 * @param {{go: (href: string) => void}} [options.router]  SPA navigation. A full page load without one
 * @param {object|false} [options.highlighter]  an adapter from `/shiki`, `/prism` or `/hljs`
 */
export function mountDocPilot(options = {}) {
  if (typeof document === 'undefined') return { ...INERT }

  /**
   * `{enabled: false}` is what `defineDocPilot` emits when nothing is set up —
   * no key, no index — and the promise attached to it is that the site builds
   * and the panel is simply absent. So nothing is mounted: no Vue app, no
   * teleports, no sprite.
   *
   * On VitePress this was true without a check, because the only ways in are the
   * trigger and its hotkey and both live in a component that renders nothing
   * when disabled. This entry point hands the host an `open()` of its own, which
   * is a door the old arrangement did not have.
   */
  if (options.config?.enabled === false) return { ...INERT }

  const {
    config = {},
    target = null,
    trigger = 'fab',
    route = typeof location === 'undefined' ? '/' : location.pathname,
    lang = document.documentElement.lang || 'en',
    base = null,
    ragBase = null,
    selectors = null,
    router = null,
    highlighter = null,
  } = options

  /**
   * `base` and `selectors` describe the HOST, so they go to the binding;
   * `ragBase` is something an author chooses, so it goes in the config — the
   * same two layers a VitePress site resolves through, filled in from one call
   * instead of from two files. The caller's config object is copied rather than
   * written to: it is very often a frozen literal inlined at build time.
   */
  const withRagBase = ragBase ? { ...config, host: { ...(config.host || {}), ragBase } } : config

  /**
   * `theme` is the shape `useData()` returns, not the config itself.
   *
   * Every component reads `theme.value.docPilot`, because on VitePress that is
   * where `themeConfig` puts it. Keeping the wrapper here means the components
   * ask one question on every host rather than two.
   */
  const host = createStandaloneHost({
    theme: { docPilot: withRagBase },
    route,
    lang,
    router: router || undefined,
  })

  /**
   * Installed BOTH ways, and the pair is not redundant.
   *
   * `provide` is scoped to this app and is what lets two panels on one page bind
   * to different hosts. The module registry is what reaches a component mounted
   * outside this app — the trigger a host places in its own React or Vue tree,
   * which has no ancestor of ours to inject from.
   */
  const factory = host.factory
  setHost(factory, { base, selectors })

  if (highlighter) setHighlighter(highlighter)

  const el = target || document.createElement('div')
  if (!target) {
    // The panel, the sprite and the popover all teleport to `<body>`, so this
    // node holds nothing that is visible. It still has to be IN the document:
    // `Teleport` resolves its destination on mount, and a detached app never
    // mounts at all.
    el.className = 'docpilot-root'
    document.body.appendChild(el)
  }

  const app = createApp({
    render: () => [
      // The sprite FIRST and exactly once — every glyph in the panel is a `<use>`
      // into it. Two of it publishes two sets of the same ids; none of it renders
      // a panel with empty icon buttons.
      h(DocPilotIcons),
      h(DocPilot),
      trigger === 'none' ? null : h(DocPilotTrigger, { variant: trigger }),
      // Renders nothing unless `quote.fromDocs` is on, and decides that itself.
      h(DocPilotQuote),
    ],
  })
  app.provide(HOST_KEY, factory)
  app.mount(el)

  return {
    app,
    mounted: true,
    open: session.open,
    close: session.close,
    toggle: session.toggle,
    /**
     * Put a question in the composer. NOT submitted — the reader reads what
     * somebody else wrote before it is asked on their behalf, which is the same
     * rule the `?dp-ask=` deep link and the article's quote popover follow.
     */
    ask(question) {
      session.state.pendingQuestion = String(question || '')
      session.open()
    },
    setRoute: (next) => host.update({ route: next }),
    setLang: (next) => host.update({ lang: next }),
    setConfig: (next) =>
      host.update({
        theme: { docPilot: ragBase ? { ...next, host: { ...(next.host || {}), ragBase } } : next },
      }),
    destroy() {
      app.unmount()
      if (!target && el.parentNode) el.parentNode.removeChild(el)
      // OURS only. A second panel on the page has its own binding in the
      // registry by now, and clearing that one drops it onto the inert fallback
      // without a word — see `releaseHost`.
      releaseHost(factory)
    },
  }
}

export { DocPilot, DocPilotTrigger, DocPilotIcons, DocPilotQuote }
export { setHighlighter, getHighlighter } from './theme/docpilot/highlight.js'
export { setHost, useHost, createStandaloneHost, HOST_KEY, routeOf } from './theme/docpilot/host.js'
