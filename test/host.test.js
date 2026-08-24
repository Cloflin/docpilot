import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import { ref, watch, nextTick } from 'vue'
import {
  HOST_KEY,
  setHost,
  useHost,
  hostEnv,
  hostConfig,
  joinBase,
  createStandaloneHost,
  routeOf,
  __resetHostForTests,
} from '../src/theme/docpilot/host.js'
import { isKnownPath } from '../src/theme/docpilot/markdown.js'
import { DEFAULTS } from '../src/config.js'

/**
 * The host binding — the seam that took VitePress out of the components.
 *
 * `host-vitepress.js` is deliberately absent from these imports and cannot be
 * added: it imports the bare specifier `vitepress`, which outside a Vite build
 * resolves to the Node half of that package, where `useData` does not exist.
 * That is the same reason `theme.js` has never been importable here — and it is
 * why the one thing worth asserting about that file is asserted over its SOURCE,
 * at the bottom of this suite.
 */
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

describe('routeOf', () => {
  it.each([
    ['guide/install.md', '/guide/install'],
    ['index.md', '/'],
    ['guide/index.md', '/guide'],
    ['reference/config.md', '/reference/config'],
    ['guide\\install.md', '/guide/install'],
    ['', '/'],
    [undefined, '/'],
  ])('%s → %s', (rel, route) => {
    expect(routeOf(rel)).toBe(route)
  })

  // The whole reason this function is not allowed to grow a `base` argument.
  // `manifest.pages[].path` is written by the indexer from the same rule, and
  // `isKnownPath` compares the two literally.
  it('never emits a base', () => {
    expect(routeOf('guide/install.md').startsWith('/guide')).toBe(true)
  })

  /**
   * The rule has ONE definition, and this is what says so.
   *
   * It was written twice — once here, once in the index builder — and the two
   * disagreed on `index.md` at the root: `/index` from the panel against `/`
   * from the builder, so the home page's *this page* scope matched no page in
   * the manifest and nothing reported it. A copy is what the failure was made
   * of, so the absence of a copy is what is asserted.
   */
  it('is not restated by the index builder', () => {
    const builder = read('src/build/build-rag-index.js')
    expect(builder).toContain("import { routeOf } from '../theme/docpilot/route.js'")
    expect(builder).toContain('return routeOf(path.relative(DOCS, file))')
    expect(/\/\\\/index\$\//.test(builder), 'the builder still strips /index itself').toBe(false)
  })
})

describe('host binding', () => {
  beforeEach(() => __resetHostForTests())

  it('answers with an inert host when nothing is installed', () => {
    const host = useHost()
    expect(host.theme.value).toEqual({})
    expect(host.route.value).toBe('/')
    expect(host.lang.value).toBe('en')
    expect(typeof host.router.go).toBe('function')
  })

  // `enabled` is ABSENT rather than false: every component tests
  // `enabled !== false`, so a config pushed in later through `update()` takes
  // effect without the host being reinstalled.
  it('leaves the inert host admissible', () => {
    expect(useHost().theme.value?.docPilot?.enabled).toBeUndefined()
  })

  it('returns the installed binding', () => {
    const host = createStandaloneHost({ route: '/guide', lang: 'ru' })
    setHost(host.factory)
    expect(useHost().route.value).toBe('/guide')
    expect(useHost().lang.value).toBe('ru')
  })

  it('does not warn when called outside a component', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useHost()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('exposes the static environment to a non-component caller', () => {
    setHost(createStandaloneHost().factory, {
      base: '/docs/',
      selectors: { article: '.theme-doc-markdown' },
    })
    expect(hostEnv().base).toBe('/docs/')
    expect(hostEnv().selectors.article).toBe('.theme-doc-markdown')
  })

  it('reports no environment before a host is installed', () => {
    expect(hostEnv()).toEqual({ base: null, selectors: null })
  })

  it('keys the per-app override on a shared symbol', () => {
    expect(HOST_KEY).toBe(Symbol.for('docpilot.host'))
  })
})

describe('the standalone host', () => {
  beforeEach(() => __resetHostForTests())

  it('drives a watcher the way a framework would', async () => {
    const host = createStandaloneHost({ route: '/' })
    const seen = []
    watch(host.binding.route, (r) => seen.push(r))
    host.update({ route: '/guide/install' })
    await nextTick()
    host.update({ route: '/reference/config' })
    await nextTick()
    expect(seen).toEqual(['/guide/install', '/reference/config'])
  })

  /**
   * The reason `update()` writes only the keys it was given.
   *
   * Every imperative host calls it on each navigation with a route and nothing
   * else. A spread over defaults would blank the config on the first route
   * change — the panel would mount, work once, and switch itself off the moment
   * the reader clicked a link.
   */
  it('leaves untouched keys alone', () => {
    const host = createStandaloneHost({ theme: { docPilot: { product: 'Acme' } }, lang: 'de' })
    host.update({ route: '/guide' })
    expect(host.binding.theme.value.docPilot.product).toBe('Acme')
    expect(host.binding.lang.value).toBe('de')
  })

  it('falls back to a full page load when given no router', () => {
    const host = createStandaloneHost()
    // No `location` in this environment, so the guard is what is under test:
    // the call has to be a no-op rather than a ReferenceError.
    expect(() => host.binding.router.go('/guide')).not.toThrow()
  })

  it('uses the router it was given', () => {
    const go = vi.fn()
    const host = createStandaloneHost({ router: { go } })
    host.binding.router.go('/guide')
    expect(go).toHaveBeenCalledWith('/guide')
  })
})

describe('joinBase', () => {
  it.each([
    ['/', 'rag', '/rag'],
    ['/docs', 'rag', '/docs/rag'],
    ['/docs/', 'rag', '/docs/rag'],
    ['', 'rag', '/rag'],
    ['/docs/', '/rag', '/docs/rag'],
  ])('%s + %s → %s', (base, rel, out) => {
    expect(joinBase(base, rel)).toBe(out)
  })

  // `loadIndex` builds `${base}/manifest.json`. Most servers forgive a double
  // slash; a signed CDN URL does not, and neither does a cache key.
  it('leaves no trailing slash for the caller to trip on', () => {
    expect(joinBase('/docs/', 'rag').endsWith('/')).toBe(false)
  })
})

describe('hostConfig', () => {
  beforeEach(() => __resetHostForTests())

  it('falls back to neutral values with no author and no binding', () => {
    expect(hostConfig()).toEqual({
      base: '/',
      ragBase: '/rag',
      article: 'main',
      search: null,
      content: 'main',
    })
  })

  it('takes the binding over the neutral value', () => {
    setHost(createStandaloneHost().factory, {
      base: '/docs/',
      selectors: { article: '.vp-doc, main', search: '.VPNavBarSearchButton', content: '#VPContent' },
    })
    const cfg = hostConfig()
    expect(cfg.base).toBe('/docs/')
    expect(cfg.ragBase).toBe('/docs/rag')
    expect(cfg.article).toBe('.vp-doc, main')
    expect(cfg.search).toBe('.VPNavBarSearchButton')
    expect(cfg.content).toBe('#VPContent')
  })

  it('takes the author over the binding', () => {
    setHost(createStandaloneHost().factory, {
      base: '/docs/',
      selectors: { article: '.vp-doc, main' },
    })
    const cfg = hostConfig({ host: { base: '/handbook/', article: 'article' } })
    expect(cfg.base).toBe('/handbook/')
    expect(cfg.ragBase).toBe('/handbook/rag')
    expect(cfg.article).toBe('article')
  })

  it('lets an explicit ragBase escape the base entirely', () => {
    expect(hostConfig({ host: { base: '/docs/', ragBase: 'https://cdn.example.com/rag' } }).ragBase).toBe(
      'https://cdn.example.com/rag',
    )
  })

  /**
   * `null` is the author saying nothing; `false` is the author saying no.
   *
   * Without the distinction a VitePress site could not switch the affordance
   * off, because the binding would keep supplying one — and the neutral value
   * for `search` is nothing at all, so `null` has to mean "ask the binding".
   */
  it('separates an unset search from a suppressed one', () => {
    setHost(createStandaloneHost().factory, { selectors: { search: '.VPNavBarSearchButton' } })
    expect(hostConfig({ host: { search: null } }).search).toBe('.VPNavBarSearchButton')
    expect(hostConfig({ host: { search: false } }).search).toBe(null)
  })

  // Every default has to be null for the layering above to mean anything: a
  // default of 'main' would outrank the binding's selector and quietly win.
  it('ships nothing but nulls as defaults', () => {
    expect(Object.values(DEFAULTS.host).every((v) => v === null)).toBe(true)
  })

  /**
   * THE BASE INVARIANT, and the reason it gets a test of its own.
   *
   * `base` is applied at two egress points — the index fetch and `router.go` —
   * and must never reach the citation validator. A based href compared against
   * a base-less `manifest.pages[].path` fails the membership test, and the panel
   * de-links its own citations: every source in the answer silently becomes
   * plain text, on a site whose only fault is being served from a subdirectory.
   */
  it('never lets a base reach the citation validator', () => {
    setHost(createStandaloneHost().factory, { base: '/docs/' })
    const known = new Set(['/guide/install'])
    expect(isKnownPath('/guide/install', known)).toBe(true)
    expect(isKnownPath('/docs/guide/install', known)).toBe(false)
    // …and the index fetch is the place the base DOES belong.
    expect(hostConfig().ragBase).toBe('/docs/rag')
  })
})

/**
 * The point of the whole phase, asserted over source text.
 *
 * A component that reaches for `vitepress` again is a component that cannot
 * mount on Docusaurus, on React, or under a `<script>` tag — and the symptom is
 * not a test failure but an unresolvable bare specifier in somebody else's
 * bundler. `host-vitepress.js` is the one file allowed to name it.
 */
describe('the VitePress specifier', () => {
  const COMPONENTS = [
    'src/theme/components/DocPilot.vue',
    'src/theme/components/DocPilotTrigger.vue',
    'src/theme/components/DocPilotCta.vue',
    'src/theme/components/DocPilotQuote.vue',
    'src/theme/components/DocPilotIcons.vue',
  ]

  it.each(COMPONENTS)('%s imports no framework', (file) => {
    expect(/^\s*import .* from ['"]vitepress['"]/m.test(read(file))).toBe(false)
  })

  it('appears in exactly one module under src/theme/docpilot/', () => {
    const dir = new URL('../src/theme/docpilot/', import.meta.url)
    const named = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /from ['"]vitepress['"]/.test(fs.readFileSync(new URL(f, dir), 'utf8')))
    expect(named).toEqual(['host-vitepress.js'])
  })

  it('reaches the panel through the binding, not through an import', () => {
    const vue = read('src/theme/components/DocPilot.vue')
    expect(vue).toContain("import { useHost, hostConfig } from '../docpilot/host.js'")
    expect(vue).toContain('const { theme, route, lang, router } = useHost()')
  })
})
