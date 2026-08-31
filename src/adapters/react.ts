'use client'
/**
 * The panel in a React application.
 *
 *     import { DocPilotPanel } from '@cloflin/docpilot/react'
 *     import '@cloflin/docpilot/web.css'
 *
 *     <DocPilotPanel config={config} route={pathname} />
 *
 * IT IMPORTS THE PREBUILT BUNDLE, not `../mount.js`, and that is the whole
 * reason this file is short. A React project's bundler is webpack, Turbopack or
 * esbuild; none of them compiles a `.vue` file, and `babel-loader` excludes
 * `node_modules` besides. `dist/docpilot.web.mjs` is that same code already
 * compiled, with Vue bundled in — so the host needs no Vue, no loader and no
 * configuration.
 *
 * NO JSX. This package has no JSX build step and does not want one for four
 * elements' worth of markup, so the component is written with `createElement`.
 *
 * `'use client'` is the first line so the module drops into a Next App Router
 * tree unchanged. Everywhere else it is an inert string expression.
 */

// @ts-ignore — react is the CONSUMER's dependency, never this package's.
import { createElement, useEffect, useRef, useState } from 'react'
import { mountDocPilot } from '@cloflin/docpilot/web'

/**
 * Mount the panel and keep it in step with the host's router.
 *
 * @param {object}  props
 * @param {object}  props.config       the client config — `ai.themeConfig` from `defineDocPilot`
 * @param {string}  [props.route]      the current route, base-less. Read from `location` when omitted
 * @param {string}  [props.lang]       the page's locale
 * @param {'fab'|'nav'|'screen'|'none'|Array<'fab'|'nav'|'screen'>} [props.trigger='fab']
 * @param {string}  [props.base]       the site's base path
 * @param {string}  [props.ragBase]    where the index is served from
 * @param {object}  [props.selectors]  `{article, search, content}` for this host
 * @param {{go: Function}} [props.router]  SPA navigation. A full page load without one
 * @param {object}  [props.highlighter]  an adapter from `/shiki`, `/prism` or `/hljs`
 */
export function DocPilotPanel(
  props: {
    config?: any
    route?: string
    lang?: string
    router?: { go: (href: string) => void }
    highlighter?: import('../../types/highlight.js').Highlighter | false
    [key: string]: unknown
  } = {},
) {
  const { config, route, lang, ...rest } = props
  const el = useRef(null)
  const panel = useRef(null)

  /**
   * The mount effect takes NO dependency on `route` or `lang`.
   *
   * Those are pushed in by the effects below instead. Listing them here would
   * tear the panel down and build it again on every navigation, which throws
   * away the reader's conversation — the one thing the panel is careful to keep
   * across route changes on every other host.
   */
  useEffect(() => {
    if (!el.current) return undefined
    panel.current = mountDocPilot({
      ...rest,
      config,
      target: el.current,
      route,
      lang,
    })
    panelHandle = panel.current
    return () => {
      panel.current?.destroy()
      if (panelHandle === panel.current) panelHandle = null
      panel.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (route != null) panel.current?.setRoute(route)
  }, [route])

  useEffect(() => {
    if (lang != null) panel.current?.setLang(lang)
  }, [lang])

  useEffect(() => {
    if (config) panel.current?.setConfig(config)
  }, [config])

  // The panel, the sprite and the popover all teleport to `<body>`, so this node
  // renders nothing visible. It still has to be in the tree: a teleport resolves
  // its destination on mount, and there is nothing to mount into without it.
  return createElement('div', { ref: el, className: 'docpilot-root' })
}

/**
 * Open, close and ask, from anywhere under a mounted panel.
 *
 * A hook rather than a context, because the panel is a module-level store on
 * every host — one panel per page is the design — so a provider would be
 * ceremony around a value that is already global.
 */
export function useDocPilot() {
  const [api] = useState(() => ({
    open: () => panelHandle?.open(),
    close: () => panelHandle?.close(),
    toggle: () => panelHandle?.toggle(),
    ask: (question) => panelHandle?.ask(question),
  }))
  return api
}

/**
 * The most recent mount, for `useDocPilot`.
 *
 * Written by `DocPilotPanel` rather than exported: a host with two panels on one
 * page has bigger questions than which one this hook talks to, and answering
 * them with a context would make the common case — one panel, one button
 * somewhere else in the tree — need a provider it does not otherwise need.
 */
let panelHandle = null

export { mountDocPilot }
