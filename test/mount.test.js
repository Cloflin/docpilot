// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mountDocPilot } from '../src/mount.js'
import { hostConfig, hostEnv, __resetHostForTests } from '../src/theme/docpilot/host.js'
import { getHighlighter, setHighlighter } from '../src/theme/docpilot/highlight.js'
import * as session from '../src/theme/docpilot/session.js'

/**
 * `mountDocPilot` — the panel on a site that is not VitePress.
 *
 * This is the only suite in the package that mounts anything, and the only one
 * that needs a DOM. Everything it asserts is something a source-text check could
 * not: that the app really mounts, that the sprite is published once, that the
 * teleports find `<body>`, and that a route pushed in from outside reaches the
 * store the panel scopes with.
 */
const CONFIG = {
  enabled: true,
  product: 'Acme Editor',
  ui: { trigger: 'fab', panel: 'popup' },
}

let panel = null
let realFetch = null

/**
 * NOTHING IN THIS FILE TOUCHES THE NETWORK.
 *
 * Mounting starts the index prefetch — `mayPrefetch()` consults
 * `navigator.connection`, happy-dom has none, so it says yes — and the manifest
 * request then resolves against happy-dom's `http://localhost:3000`, where
 * nothing is listening. It is handled, so it failed nothing, but every run
 * printed an `AggregateError: ECONNREFUSED` and a sandboxed runner would make it
 * slow or flaky instead. So the suite answers for itself, with the rejection an
 * offline browser produces: the panel under test is the one a reader gets when
 * the index cannot be fetched, which is a state it must survive anyway.
 */
beforeEach(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('offline: the mount suite makes no requests'))
  __resetHostForTests()
  setHighlighter(null)
  document.body.innerHTML = ''
})

afterEach(() => {
  panel?.destroy()
  panel = null
  globalThis.fetch = realFetch
})

describe('mounting', () => {
  it('creates its own node and puts it in the document', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(panel.mounted).toBe(true)
    const root = document.querySelector('.docpilot-root')
    expect(root).not.toBe(null)
    // Teleport resolves its destination on mount; a detached app never mounts.
    expect(document.body.contains(root)).toBe(true)
  })

  it('uses the node it was given and leaves it behind on destroy', () => {
    const target = document.createElement('div')
    target.id = 'mine'
    document.body.appendChild(target)
    panel = mountDocPilot({ config: CONFIG, target })
    panel.destroy()
    panel = null
    expect(document.getElementById('mine')).not.toBe(null)
    expect(document.querySelector('.docpilot-root')).toBe(null)
  })

  it('takes its own node away again', () => {
    panel = mountDocPilot({ config: CONFIG })
    panel.destroy()
    panel = null
    expect(document.querySelector('.docpilot-root')).toBe(null)
  })

  /**
   * Every glyph in the panel is a `<use>` into one `<symbol>` sprite. Two of it
   * publishes two sets of the same ids; none of it renders a panel whose icon
   * buttons are empty boxes.
   */
  it('publishes exactly one icon sprite', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(document.querySelectorAll('symbol#dp-i-copy').length).toBe(1)
  })

  it('renders the floating button by default', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(document.querySelector('.docpilot-nav-trigger.is-fab')).not.toBe(null)
  })

  /**
   * TWO GATES, and a placement has to pass both.
   *
   * `trigger` here says which instances are MOUNTED — the host's decision, made
   * from its own layout — and `config.ui.trigger` says which of them render, the
   * project's decision, made in the same settings file every other host reads.
   * A list on either side is legal, and this is the combination that proves the
   * two are actually independent: the navbar instance is mounted and stays
   * silent because the config never asked for it.
   */
  it('mounts a list of triggers, and each one still asks the config', () => {
    panel = mountDocPilot({
      config: { ...CONFIG, ui: { trigger: ['nav', 'fab'], panel: 'popup' } },
      trigger: ['nav', 'fab'],
    })
    expect(document.querySelector('.docpilot-nav-trigger.is-fab')).not.toBe(null)
    expect(document.querySelectorAll('.docpilot-nav-trigger').length).toBe(2)

    panel.destroy()
    // Same mount list, a config that names one of them: one button.
    panel = mountDocPilot({ config: CONFIG, trigger: ['nav', 'fab'] })
    expect(document.querySelectorAll('.docpilot-nav-trigger').length).toBe(1)
    expect(document.querySelector('.docpilot-nav-trigger.is-fab')).not.toBe(null)
  })

  // The panel itself is `v-if="s.open"` — a reader who never asks pays for no
  // DOM at all — so "it is still there" means it can still be opened by hand.
  it('renders no trigger when the host places its own', async () => {
    panel = mountDocPilot({ config: CONFIG, trigger: 'none' })
    expect(document.querySelector('.docpilot-nav-trigger')).toBe(null)
    panel.open()
    await nextTick()
    expect(document.querySelector('.docpilot__panel')).not.toBe(null)
  })

  /**
   * `{enabled: false}` is the unconfigured payload, and the promise attached to
   * it is that the panel is absent rather than empty. Nothing is mounted at all
   * — and `open()` on the returned handle has to stay a no-op, because this
   * entry point hands the host a door the VitePress theme never had.
   */
  it('mounts nothing at all when the config is off', async () => {
    panel = mountDocPilot({ config: { enabled: false } })
    expect(panel.mounted).toBe(false)
    expect(document.querySelector('.docpilot-root')).toBe(null)
    panel.open()
    await nextTick()
    expect(document.querySelector('.docpilot__panel')).toBe(null)
    expect(document.querySelector('symbol#dp-i-copy')).toBe(null)
  })
})

describe('the host it installs', () => {
  it('carries the config to the components', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(document.querySelector('.docpilot-nav-trigger.is-fab')).not.toBe(null)
  })

  it('hands base and selectors to the binding, not to the config', () => {
    panel = mountDocPilot({
      config: CONFIG,
      base: '/docs/',
      selectors: { article: '.theme-doc-markdown', search: '.DocSearch-Button' },
    })
    expect(hostEnv().base).toBe('/docs/')
    expect(hostConfig().article).toBe('.theme-doc-markdown')
    expect(hostConfig().ragBase).toBe('/docs/rag')
  })

  // `ragBase` is a thing an author chooses rather than a fact about the host, so
  // it travels in the config exactly as it would on a VitePress site.
  it('lets an explicit ragBase override the derived one', () => {
    panel = mountDocPilot({ config: CONFIG, base: '/docs/', ragBase: 'https://cdn.example.com/rag' })
    expect(hostConfig(session.state.config).ragBase).toBe('https://cdn.example.com/rag')
  })

  it('does not write into the config object it was given', () => {
    const frozen = Object.freeze({ ...CONFIG })
    expect(() => {
      panel = mountDocPilot({ config: frozen, ragBase: '/x/rag' })
    }).not.toThrow()
  })

  it('reads the page language off the document when not told one', () => {
    document.documentElement.lang = 'de'
    panel = mountDocPilot({ config: CONFIG })
    expect(session.state.lang).toBe('de')
    document.documentElement.lang = ''
  })

  /**
   * DESTROYING ONE PANEL DOES NOT UNINSTALL ANOTHER PANEL'S HOST.
   *
   * The registry is a module singleton and `destroy()` used to clear it whatever
   * was in it, so on a page with two panels — the case the registry exists for —
   * the survivor silently fell back to the inert binding: `route` pinned to `/`,
   * no config, and navigation by full page load. Nothing throws, which is why
   * this needs a test rather than a bug report.
   */
  it('leaves a second panel\'s binding alone when the first is destroyed', () => {
    const first = mountDocPilot({ config: CONFIG, base: '/a/' })
    panel = mountDocPilot({ config: CONFIG, base: '/b/' })
    expect(hostEnv().base).toBe('/b/')

    first.destroy()
    expect(hostEnv().base).toBe('/b/')
    expect(hostConfig().ragBase).toBe('/b/rag')
  })

  /**
   * And the other half of the same rule: the panel that DID install the binding
   * still takes it out, so a mount/unmount cycle is not a leak.
   */
  it('still clears the binding it installed itself', () => {
    const only = mountDocPilot({ config: CONFIG, base: '/a/' })
    expect(hostEnv().base).toBe('/a/')

    only.destroy()
    expect(hostEnv().base).toBe(null)
  })
})

describe('the handle it returns', () => {
  it('opens and closes the panel', () => {
    panel = mountDocPilot({ config: CONFIG })
    panel.open()
    expect(session.state.open).toBe(true)
    panel.close()
    expect(session.state.open).toBe(false)
  })

  /**
   * A question handed in from outside is NOT submitted. The reader reads what
   * somebody else wrote before it is asked on their behalf — the same rule the
   * `?dp-ask=` deep link and the article's quote popover follow.
   */
  it('puts a question in the composer without asking it', () => {
    panel = mountDocPilot({ config: CONFIG })
    panel.ask('How do I install this?')
    expect(session.state.open).toBe(true)
    expect(session.state.turns).toEqual([])
  })

  it('pushes a route change through to the scope the panel uses', async () => {
    panel = mountDocPilot({ config: CONFIG, route: '/guide' })
    expect(session.state.currentPath).toBe('/guide')
    panel.setRoute('/reference/config')
    await new Promise((r) => setTimeout(r, 0))
    expect(session.state.currentPath).toBe('/reference/config')
  })

  it('pushes a language change through', async () => {
    panel = mountDocPilot({ config: CONFIG, lang: 'en' })
    panel.setLang('fr')
    await new Promise((r) => setTimeout(r, 0))
    expect(session.state.lang).toBe('fr')
  })
})

/**
 * `ui.font` — the one setting that lands on the DOCUMENT rather than on a
 * component, and the only reason this suite needs a DOM to check it.
 *
 * Written as an inline custom property on `<html>` because that is the one layer
 * above a host adapter: `vitepress.scss` maps `--dp-font` to the site's own
 * family on `:root`, so a rule of ours at the same specificity would lose on the
 * host where naming a face is most likely to be the point.
 */
describe('ui.font', () => {
  const face = () => document.documentElement.style.getPropertyValue('--dp-font')
  const mono = () => document.documentElement.style.getPropertyValue('--dp-font-mono')

  afterEach(() => {
    document.documentElement.style.removeProperty('--dp-font')
    document.documentElement.style.removeProperty('--dp-font-mono')
  })

  // Nothing is written, and that is the feature: `--dp-font` is `inherit` in the
  // stylesheet, so an unconfigured panel already wears the page's own face and
  // an inline property here would be the one thing overriding a site's CSS.
  it('writes nothing when nobody named a font', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(face()).toBe('')
    expect(mono()).toBe('')
  })

  it('writes the family it was given', () => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, font: 'Inter, sans-serif' } } })
    expect(face()).toBe('Inter, sans-serif')
  })

  // The spelling a site that already has the value reaches for. The wrapper is
  // the one part of it with no decision in it, so the resolver supplies it.
  it('grows a var() around a bare custom property name', () => {
    panel = mountDocPilot({
      config: { ...CONFIG, ui: { ...CONFIG.ui, font: '--brand-font', fontMono: '--brand-mono' } },
    })
    expect(face()).toBe('var(--brand-font)')
    expect(mono()).toBe('var(--brand-mono)')
  })

  /**
   * REMOVED, not skipped. `configure` runs once per mounted panel and a page
   * outlives one — an SPA route that unmounts and remounts it, a second panel,
   * a build whose settings changed — so a face taken out of the config has to
   * leave the document with it rather than surviving as an inline property
   * nothing can now explain.
   */
  it('takes the property away again when the config no longer names one', () => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, font: 'Inter, sans-serif' } } })
    expect(face()).toBe('Inter, sans-serif')
    session.configure({ docPilot: CONFIG })
    expect(face()).toBe('')
  })

  it('drops a value that could end the declaration', () => {
    panel = mountDocPilot({
      config: { ...CONFIG, ui: { ...CONFIG.ui, font: 'Inter; position: fixed' } },
    })
    expect(face()).toBe('')
  })
})

/**
 * `ui.theme` — the other setting that lands on the DOCUMENT.
 *
 * A class rather than an inline property, because a pin is nine tokens and a
 * `color-scheme`, and those values belong in `core.scss` beside the light and
 * dark sets they are copies of. `html.docpilot-dark` is one class deeper than
 * the `:root` an adapter maps on, which is what lets it win over a stylesheet
 * that beats the core by loading second.
 */
describe('ui.theme', () => {
  const pinned = () =>
    ['docpilot-light', 'docpilot-dark'].filter((c) => document.documentElement.classList.contains(c))

  afterEach(() => document.documentElement.classList.remove('docpilot-light', 'docpilot-dark'))

  // `'auto'` is what the panel has always done — the host's toggle, or the OS —
  // and both are the stylesheet's business, so there is nothing to write.
  it('writes no class when nobody pinned a scheme', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(pinned()).toEqual([])
  })

  it.each(['light', 'dark'])('puts the %s pin on the root', (theme) => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, theme } } })
    expect(pinned()).toEqual([`docpilot-${theme}`])
  })

  // The word and what it means are the same setting, so neither reaches the
  // document as itself: `'system'` is folded into `'auto'` by the resolver and
  // nothing is written, exactly as if the key had been left alone.
  it('treats `system` as `auto`', () => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, theme: 'system' } } })
    expect(pinned()).toEqual([])
  })

  /**
   * REMOVED, not skipped — the same rule `ui.font` above is held to. `setConfig`
   * runs on a live page, so a pin taken out of the settings has to leave the
   * document with it or the panel keeps a scheme nothing can now explain.
   */
  it('takes the pin off again when the config stops naming one', () => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, theme: 'dark' } } })
    expect(pinned()).toEqual(['docpilot-dark'])
    session.configure({ docPilot: CONFIG })
    expect(pinned()).toEqual([])
  })

  // One pin at a time: switching schemes must not leave both classes on the
  // root, where the later block in the stylesheet would silently decide it.
  it('replaces one pin with the other', () => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, theme: 'dark' } } })
    session.configure({ docPilot: { ...CONFIG, ui: { ...CONFIG.ui, theme: 'light' } } })
    expect(pinned()).toEqual(['docpilot-light'])
  })
})

describe('the highlighter option', () => {
  it('installs nothing by default', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(getHighlighter()).toBe(null)
  })

  it('installs the adapter it is handed', () => {
    const adapter = { id: 'stub', load: async () => {}, loaded: () => [], render: () => null }
    panel = mountDocPilot({ config: CONFIG, highlighter: adapter })
    expect(getHighlighter()).toBe(adapter)
  })
})

/**
 * The unread dot — ui-specs/010.
 *
 * The behaviour behind it is held in `background.test.js`, which needs no DOM.
 * What only a mounted panel can show is the pairing: the dot is `aria-hidden`
 * decoration, and the words that go with it land on the button's accessible
 * name — in its content when there is a visible label to join, and in
 * `aria-label` when the button is the icon-only circle and there is nothing to
 * join. Both at once would be writing it twice, because an `aria-label`
 * silently replaces the content it sits on.
 */
describe('the unread dot on the trigger', () => {
  const fab = () => document.querySelector('.docpilot-nav-trigger.is-fab')
  const dot = () => document.querySelector('.docpilot-nav-trigger__badge')

  // The store is a module singleton and outlives a mount, so a suite that
  // opened the panel leaves it open for the next one. The dot is defined as
  // "waiting AND not on screen", which makes that leak the difference between
  // a dot and no dot — so both halves are stated here rather than assumed.
  beforeEach(() => {
    session.state.open = false
    session.state.unread = false
  })

  afterEach(() => {
    session.state.unread = false
  })

  it('is absent until something settles behind a closed panel', async () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(dot()).toBe(null)

    session.state.unread = true
    await nextTick()
    expect(dot()).not.toBe(null)
    expect(dot().getAttribute('aria-hidden')).toBe('true')
  })

  it('goes out when the reader opens the panel', async () => {
    panel = mountDocPilot({ config: CONFIG })
    session.state.unread = true
    await nextTick()
    expect(dot()).not.toBe(null)

    panel.open()
    await nextTick()
    expect(session.state.unread).toBe(false)
    expect(dot()).toBe(null)
  })

  /**
   * With words on the button there IS content to join, so the name is the label
   * plus the hidden line — and `aria-label` stays away, which is the rule
   * ui-specs/005 already holds this button to.
   */
  it('joins the visible label rather than replacing it', async () => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, fabLabel: 'Ask AI' } } })
    session.state.unread = true
    await nextTick()

    expect(fab().getAttribute('aria-label')).toBe(null)
    expect(fab().textContent).toContain('Ask AI')
    expect(fab().textContent).toContain('Answer ready.')
  })

  /** And with no words, the name is the only place left for them. */
  it('goes into the accessible name when the button is icon-only', async () => {
    panel = mountDocPilot({ config: { ...CONFIG, ui: { ...CONFIG.ui, fabLabel: false } } })
    expect(fab().getAttribute('aria-label')).toBe('DocPilot')

    session.state.unread = true
    await nextTick()
    expect(fab().getAttribute('aria-label')).toBe('DocPilot Answer ready.')
  })
})

/**
 * The polite live region outlives the panel — ui-specs/010.
 *
 * It used to sit in the composer, inside the `v-if`, so a turn that settled
 * while the panel was shut announced into nothing — and that stopped being an
 * edge case the moment a turn was allowed to outlive the panel. Being resident
 * also removes a race the open path always had: a live region inserted in the
 * same frame as its text is one some screen readers never announce.
 */
describe('the live region', () => {
  const live = () => document.querySelector('.docpilot__sr[aria-live="polite"]')

  beforeEach(() => {
    session.state.open = false
  })

  it('is in the document with the panel closed', () => {
    panel = mountDocPilot({ config: CONFIG })
    expect(session.state.open).toBe(false)
    expect(live()).not.toBe(null)
  })

  it('is still the only one once the panel is open', async () => {
    panel = mountDocPilot({ config: CONFIG })
    panel.open()
    await nextTick()
    expect(document.querySelectorAll('.docpilot__sr[aria-live="polite"]').length).toBe(1)
  })
})
