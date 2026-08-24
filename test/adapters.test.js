import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import { createApp, h, ref } from 'vue'
import docpilotPlugin from '../src/adapters/docusaurus/index.js'
import { DocPilotPlugin, createVueRouterHost } from '../src/adapters/vue.js'
import { hostEnv, hostConfig, useHost, __resetHostForTests } from '../src/theme/docpilot/host.js'
import { getHighlighter, setHighlighter } from '../src/theme/docpilot/highlight.js'

/**
 * The three framework adapters.
 *
 * `react.js` and `docusaurus/client.js` both import `@cloflin/docpilot/web`,
 * which resolves into `dist/` — a build artifact, absent on a fresh clone. So
 * neither is imported here; what they promise is asserted over their SOURCE, the
 * way `packaging.test.js` already asserts the shape of `theme.js`. The Node half
 * of the Docusaurus plugin has no such import and is exercised directly.
 */
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

/**
 * Both files state their own rules in prose directly above the code that keeps
 * them, so a naive grep flags the documentation of a rule as a violation of it —
 * the same reason `check-docpilot.sh` strips comments before rules 7 and 8.
 */
const code = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('the Docusaurus plugin', () => {
  const context = { siteConfig: { baseUrl: '/docs/' } }

  it('is a plugin, not a theme', () => {
    const plugin = docpilotPlugin(context, {})
    expect(plugin.name).toBe('docpilot')
    expect(typeof plugin.getClientModules).toBe('function')
    expect(typeof plugin.injectHtmlTags).toBe('function')
    /**
     * Only one theme may PROVIDE `@theme/Root` without wrapping. A package that
     * does collides with `docusaurus-theme-search-typesense` and
     * `@docusaurus/theme-live-codeblock`, and the symptom for the user is that
     * their search stops working. Adding a panel is not worth breaking that.
     */
    expect(plugin.getThemePath).toBeUndefined()
  })

  it('loads the core stylesheet before the adapter', () => {
    const modules = docpilotPlugin(context, {}).getClientModules()
    const core = modules.findIndex((m) => m.endsWith('docpilot-core.css'))
    const adapter = modules.findIndex((m) => m.endsWith('docpilot-docusaurus.css'))
    expect(core).toBeGreaterThanOrEqual(0)
    // The adapter wins by cascade ORDER, not specificity. Reversed, it loses and
    // the panel ignores the site's theme entirely.
    expect(adapter).toBeGreaterThan(core)
  })

  /**
   * The plugin names `dist/` files directly rather than resolving them through
   * `exports`, because `require.resolve` would also check that they exist and
   * `dist/` is absent on a fresh clone — constructing the plugin would throw in
   * a repository that had not run `npm run build`.
   *
   * This is the check that buys that back: a renamed build artifact fails here
   * instead of at a consumer's Docusaurus build.
   */
  it('names the same stylesheets the exports map publishes', () => {
    const pkg = JSON.parse(read('package.json'))
    const published = new Set(
      Object.values(pkg.exports)
        .filter((t) => typeof t === 'string' && t.endsWith('.css'))
        .map((t) => t.split('/').pop()),
    )
    for (const m of docpilotPlugin(context, {}).getClientModules()) {
      if (!m.endsWith('.css')) continue
      expect(published.has(m.split('/').pop()), `${m} is not in the exports map`).toBe(true)
    }
  })

  // Absolute, because `getClientModules()` entries are resolved against the
  // PLUGIN's directory: a bare specifier became
  // `…/src/adapters/docusaurus/@cloflin/docpilot/style/core.css` and failed the
  // build with what reads like a missing file.
  it('returns absolute paths, not module specifiers', () => {
    for (const m of docpilotPlugin(context, {}).getClientModules()) {
      expect(m.startsWith('/'), m).toBe(true)
    }
  })

  it('points at a client module that exists', () => {
    const modules = docpilotPlugin(context, {}).getClientModules()
    const client = modules.find((m) => m.endsWith('client.js'))
    expect(client).toBeTruthy()
    expect(fs.existsSync(client)).toBe(true)
  })

  it('can be told to bring no styles', () => {
    const modules = docpilotPlugin(context, { styles: false }).getClientModules()
    expect(modules.some((m) => m.endsWith('.css'))).toBe(false)
    expect(modules.length).toBe(1)
  })

  it('inlines the config with the site base', () => {
    const [tag] = docpilotPlugin(context, { config: { product: 'Acme' } }).injectHtmlTags()
      .preBodyTags
    expect(tag.tagName).toBe('script')
    const payload = JSON.parse(tag.innerHTML.replace('window.__DOCPILOT__=', ''))
    expect(payload.config.product).toBe('Acme')
    expect(payload.base).toBe('/docs/')
    expect(payload.selectors.article).toContain('.theme-doc-markdown')
  })

  /**
   * The config that reaches the page is the CLIENT half — `themeDocPilot` never
   * emits a key or an upstream host, because the credential stays in the reverse
   * proxy. This is the assertion that says so at the point it becomes visible in
   * someone's HTML.
   */
  it('inlines no credential', () => {
    const [tag] = docpilotPlugin(context, {
      config: { llm: { provider: 'openai', baseURL: '/ai/chat' } },
    }).injectHtmlTags().preBodyTags
    for (const secret of ['apiKey', 'authorization', 'Bearer', 'sk-']) {
      expect(tag.innerHTML).not.toContain(secret)
    }
  })

  // A `</script>` inside the JSON would close the tag the payload sits in, and
  // everything after it would be parsed as markup.
  it('cannot be broken out of by a config value', () => {
    const [tag] = docpilotPlugin(context, {
      config: { product: '</script><img src=x onerror=alert(1)>' },
    }).injectHtmlTags().preBodyTags
    expect(tag.innerHTML).not.toContain('</script>')
    expect(JSON.parse(tag.innerHTML.replace('window.__DOCPILOT__=', '')).config.product).toBe(
      '</script><img src=x onerror=alert(1)>',
    )
  })

  it('defaults to a base of / when the site has none', () => {
    const [tag] = docpilotPlugin({}, {}).injectHtmlTags().preBodyTags
    expect(JSON.parse(tag.innerHTML.replace('window.__DOCPILOT__=', '')).base).toBe('/')
  })
})

describe('the Docusaurus client module', () => {
  const src = read('src/adapters/docusaurus/client.js')

  it('follows the router through onRouteDidUpdate', () => {
    expect(src).toContain('export function onRouteDidUpdate')
    expect(src).toContain('setRoute')
  })

  // Client modules are imported during the server render too. A DOM read at
  // module scope would throw there and take the whole build down.
  it('touches no DOM at module scope', () => {
    expect(src).toContain("typeof document === 'undefined'")
    const moduleScope = src.split('function ensure()')[0]
    expect(/\bdocument\.\w/.test(moduleScope)).toBe(false)
  })

  // It cannot call `useDocusaurusContext()` — that is a React hook, and the
  // whole point of the plugin form is to stay out of the component tree.
  it('reads the locale off the document rather than from a hook', () => {
    expect(src).toContain('document.documentElement.lang')
    expect(code('src/adapters/docusaurus/client.js')).not.toContain('useDocusaurusContext')
  })

  it('imports the prebuilt bundle, not the source', () => {
    expect(src).toContain("from '@cloflin/docpilot/web'")
    expect(src).not.toContain("from '../../mount.js'")
  })
})

describe('the React adapter', () => {
  const src = read('src/adapters/react.js')

  it('imports the prebuilt bundle, because no React bundler compiles a .vue', () => {
    expect(src).toContain("from '@cloflin/docpilot/web'")
    expect(src).not.toContain("from '../mount.js'")
  })

  it('carries the client directive first, for the Next App Router', () => {
    expect(src.trimStart().startsWith("'use client'")).toBe(true)
  })

  it('uses createElement rather than JSX, because there is no JSX build', () => {
    expect(src).toContain('createElement')
    expect(src).not.toMatch(/return\s*</)
  })

  /**
   * The mount effect must not depend on `route`.
   *
   * Listing it would tear the panel down and rebuild it on every navigation,
   * throwing away the reader's conversation — the one thing the panel keeps
   * across route changes on every other host.
   */
  it('does not remount on navigation', () => {
    const mountEffect = src.match(/panelHandle = panel\.current[\s\S]*?\}, \[\]\)/)
    expect(mountEffect).not.toBe(null)
    expect(src).toContain('}, [route])')
    expect(src).toContain('}, [lang])')
  })
})

describe('the Vue plugin', () => {
  beforeEach(() => {
    __resetHostForTests()
    setHighlighter(null)
  })

  const install = (options) => {
    const app = createApp({ render: () => h('div') })
    app.use(DocPilotPlugin, options)
    return app
  }

  it('registers all five components', () => {
    const app = install({ config: {} })
    for (const name of [
      'DocPilot',
      'DocPilotTrigger',
      'DocPilotCta',
      'DocPilotIcons',
      'DocPilotQuote',
    ]) {
      expect(app.component(name), name).toBeTruthy()
    }
  })

  it('installs the host with the base and selectors it was given', () => {
    install({ config: {}, base: '/handbook/', selectors: { article: 'article' } })
    expect(hostEnv().base).toBe('/handbook/')
    expect(hostConfig().article).toBe('article')
    expect(hostConfig().ragBase).toBe('/handbook/rag')
  })

  it('carries the config to the binding', () => {
    install({ config: { product: 'Acme' } })
    expect(useHost().theme.value.docPilot.product).toBe('Acme')
  })

  it('installs the highlighter it was given, and none otherwise', () => {
    install({ config: {} })
    expect(getHighlighter()).toBe(null)
    const adapter = { id: 'stub', load: async () => {}, loaded: () => [], render: () => null }
    install({ config: {}, highlighter: adapter })
    expect(getHighlighter()).toBe(adapter)
  })

  /**
   * Duck-typed, with no import of `vue-router`.
   *
   * The two things needed are a current path and a way to navigate, and both are
   * stable across Vue Router 3 and 4. Importing the package to name a type would
   * make a router a dependency of a panel that works without one, and pin a
   * major version for projects on the other.
   */
  it('drives a router it never imported', () => {
    const pushed = []
    const router = {
      currentRoute: { value: { path: '/guide/install' } },
      push: (href) => pushed.push(href),
    }
    const host = createVueRouterHost(router, { theme: { docPilot: {} } })
    expect(host.factory().route.value).toBe('/guide/install')
    host.factory().router.go('/reference/config')
    expect(pushed).toEqual(['/reference/config'])
  })

  // A real Vue Router's `currentRoute` is a ref, so the fake has to be one too:
  // the point being asserted is that the binding TRACKS it rather than copying
  // it, and a copy is a thing that can lag.
  it('tracks the router rather than copying it', () => {
    const currentRoute = ref({ path: '/a' })
    const host = createVueRouterHost({ currentRoute, push: () => {} })
    const route = host.factory().route
    expect(route.value).toBe('/a')
    currentRoute.value = { path: '/b' }
    expect(route.value).toBe('/b')
  })

  it('falls back to a full page load with no router', () => {
    const app = install({ config: {} })
    expect(typeof app.config.globalProperties.$docPilot.binding.router.go).toBe('function')
  })
})
