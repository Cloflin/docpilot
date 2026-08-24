import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  LANGS,
  resolveLang,
  setHighlighter,
  getHighlighter,
  ensureHighlighter,
  onReady,
  highlight,
} from '../src/theme/docpilot/highlight.js'
import { createShikiHighlighter } from '../src/theme/docpilot/highlighters/shiki.js'
import { createPrismHighlighter } from '../src/theme/docpilot/highlighters/prism.js'
import { createHljsHighlighter } from '../src/theme/docpilot/highlighters/hljs.js'

/**
 * The highlighter registry.
 *
 * The contract the code-fence suite in `docpilot.test.js` pins — wrapper markup,
 * alias mapping, memo identity, the length cap, the plain fallback — is
 * deliberately NOT restated here. That suite passes unedited across this split,
 * which is the evidence that the registry took the panel's half and left the
 * highlighter's. What is new is everything below: what happens when the
 * highlighter is somebody else's.
 */
const fake = (over = {}) => ({
  id: 'fake',
  load: async () => {},
  loaded: () => ['ts', 'js'],
  render: (code, lang) => `<pre data-fake="${lang}">${code}</pre>`,
  ...over,
})

describe('the alias table is a sanitiser', () => {
  beforeEach(() => setHighlighter(null))

  it('is frozen and has no prototype to reach through', () => {
    expect(Object.isFrozen(LANGS)).toBe(true)
    expect(Object.getPrototypeOf(LANGS)).toBe(null)
  })

  // The info string is model output. Before the table had a null prototype these
  // resolved to a function, a prototype object and a method — each truthy, none
  // of them a language name, and the value went into an attribute.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'refuses %s',
    (name) => {
      expect(resolveLang(name)).toBe(null)
    },
  )

  it('reads only the first word of an info string, lowercased', () => {
    expect(resolveLang('TypeScript twoslash {1,3}')).toBe('ts')
    expect(resolveLang('   yml  ')).toBe('yaml')
    expect(resolveLang('python')).toBe(null)
    expect(resolveLang('')).toBe(null)
    expect(resolveLang(undefined)).toBe(null)
  })

  it('still answers with the shipped table when nothing is installed', () => {
    expect(resolveLang('ts')).toBe('ts')
  })
})

describe('an adapter contributing aliases', () => {
  let error

  beforeEach(() => {
    setHighlighter(null)
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => error.mockRestore())

  it('admits a well-formed alias for a grammar it loaded', () => {
    setHighlighter(fake({ loaded: () => ['ts', 'js', 'rust'], langs: { rs: 'rust', rust: 'rust' } }))
    expect(resolveLang('rs')).toBe('rust')
    expect(resolveLang('rust')).toBe('rust')
  })

  /**
   * The reason validation happens at registration.
   *
   * `data-lang` is written unescaped, so a value that can close an attribute is
   * an injection with an adapter as its vector. Checking the fixed set once
   * beats checking every fence the model writes.
   */
  it.each([
    ['x" onload="alert(1)', 'ts'],
    ['ok', 'x" onload="alert(1)'],
    ['ok', '<script>'],
    ['UPPER', 'ts'],
    ['with space', 'ts'],
    ['a'.repeat(21), 'ts'],
  ])('drops the pair %s → %s', (alias, canonical) => {
    setHighlighter(fake({ langs: { [alias]: canonical } }))
    expect(resolveLang(alias)).toBe(null)
    expect(error).toHaveBeenCalled()
  })

  // An alias pointing at a grammar that is not there renders nothing and hides
  // the reason — the block silently falls back and the author blames the model.
  it('drops an alias for a grammar it has not loaded', () => {
    setHighlighter(fake({ loaded: () => ['ts'], langs: { rs: 'rust' } }))
    expect(resolveLang('rs')).toBe(null)
    expect(error).toHaveBeenCalled()
  })

  it('cannot overwrite a shipped alias with an unloadable one', () => {
    setHighlighter(fake({ loaded: () => ['ts'], langs: { ts: 'not-loaded' } }))
    expect(resolveLang('ts')).toBe('ts')
  })

  it('forgets the aliases when the adapter is removed', () => {
    setHighlighter(fake({ loaded: () => ['ts', 'rust'], langs: { rs: 'rust' } }))
    expect(resolveLang('rs')).toBe('rust')
    setHighlighter(null)
    expect(resolveLang('rs')).toBe(null)
  })
})

describe('render is required to be synchronous and total', () => {
  let error

  beforeEach(() => {
    setHighlighter(null)
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => error.mockRestore())

  it('returns the adapter output verbatim', () => {
    setHighlighter(fake())
    expect(highlight('x', 'ts')).toBe('<pre data-fake="ts">x</pre>')
  })

  // markdown.js falls back with a single `||`, on a frame that is being redrawn
  // every 90ms. A throw there would take the whole answer down mid-stream.
  it('swallows a throw', () => {
    setHighlighter(
      fake({
        render: () => {
          throw new Error('grammar exploded')
        },
      }),
    )
    expect(highlight('x', 'ts')).toBe(null)
  })

  it('refuses a promise rather than rendering [object Promise]', () => {
    setHighlighter(fake({ render: async () => '<pre>x</pre>' }))
    expect(highlight('x', 'ts')).toBe(null)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('must be synchronous'))
  })

  it.each([[42], [{}], [undefined], [null]])('refuses the non-string %s', (value) => {
    setHighlighter(fake({ render: () => value }))
    expect(highlight('x', 'ts')).toBe(null)
  })

  it('renders nothing at all with no adapter installed', () => {
    expect(highlight('x', 'ts')).toBe(null)
  })

  it('renders nothing for a language the adapter has not loaded', () => {
    setHighlighter(fake({ loaded: () => ['ts'] }))
    expect(highlight('x', 'js')).toBe(null)
  })
})

describe('the memo', () => {
  beforeEach(() => setHighlighter(null))

  it('returns the identical string for the identical block', () => {
    setHighlighter(fake({ render: () => `<pre>${Math.E}</pre>` }))
    expect(highlight('const a = 1', 'ts')).toBe(highlight('const a = 1', 'ts'))
  })

  /**
   * A memo that survived a swap would serve the previous highlighter's markup —
   * Shiki spans in a page whose stylesheet now colours Prism's classes — for
   * every block the reader had already seen.
   */
  it('is cleared when the highlighter changes', () => {
    setHighlighter(fake({ id: 'a', render: () => '<pre>A</pre>' }))
    expect(highlight('x', 'ts')).toBe('<pre>A</pre>')
    setHighlighter(fake({ id: 'b', render: () => '<pre>B</pre>' }))
    expect(highlight('x', 'ts')).toBe('<pre>B</pre>')
  })

  it('refuses a pathological block rather than blocking the frame', () => {
    setHighlighter(fake())
    expect(highlight('a'.repeat(20001), 'ts')).toBe(null)
    expect(highlight('a'.repeat(20000), 'ts')).not.toBe(null)
  })
})

describe('ensureHighlighter', () => {
  beforeEach(() => setHighlighter(null))

  it('is a resolved no-op when nothing is installed', async () => {
    await expect(ensureHighlighter()).resolves.toBeUndefined()
  })

  it('loads once, however many times it is called', async () => {
    const load = vi.fn(async () => {})
    setHighlighter(fake({ load }))
    await Promise.all([ensureHighlighter(), ensureHighlighter(), ensureHighlighter()])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('announces readiness to every listener', async () => {
    const seen = vi.fn()
    const off = onReady(seen)
    setHighlighter(fake())
    await ensureHighlighter()
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  /**
   * A docs site fetches grammars as chunks over the network, so the common
   * failure is a dropped connection rather than a broken build. A settled
   * rejected promise left in the memo is what every later call returns — one
   * blip meant unhighlighted code until the reader reloaded the page.
   */
  it('releases its memo on failure, so a later call retries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    setHighlighter(
      fake({
        load: async () => {
          attempts++
          if (attempts === 1) throw new Error('offline')
        },
      }),
    )
    await ensureHighlighter()
    expect(highlight('x', 'ts')).toBe(null)
    await ensureHighlighter()
    expect(attempts).toBe(2)
    expect(highlight('x', 'ts')).toBe('<pre data-fake="ts">x</pre>')
    error.mockRestore()
  })
})

/**
 * The Shiki adapter, exercised through its `create` seam.
 *
 * No network, no 600 KB grammar compile — and unlike the old test seam, this
 * reaches the real `render()`, so the options that make the panel's code match
 * the page's are asserted rather than assumed.
 */
describe('the shiki adapter', () => {
  const instance = (over = {}) => ({
    getLoadedLanguages: () => ['ts', 'typescript', 'js', 'javascript', 'bash', 'shellscript'],
    codeToHtml: vi.fn(() => '<pre class="shiki"><span style="--shiki-light:#111">x</span></pre>'),
    ...over,
  })

  beforeEach(() => setHighlighter(null))

  it('reports nothing loaded before load()', () => {
    expect([...createShikiHighlighter({ create: async () => instance() }).loaded()]).toEqual([])
  })

  it('reports Shiki own names and aliases once loaded', async () => {
    const hl = createShikiHighlighter({ create: async () => instance() })
    await hl.load()
    expect([...hl.loaded()]).toContain('ts')
    expect([...hl.loaded()]).toContain('bash')
  })

  it('renders with both themes attached and neither applied', async () => {
    const core = instance()
    const hl = createShikiHighlighter({ create: async () => core })
    await hl.load()
    core.codeToHtml.mockClear()
    hl.render('const a = 1', 'ts')
    const [code, opts] = core.codeToHtml.mock.calls[0]
    expect(code).toBe('const a = 1')
    expect(opts.lang).toBe('ts')
    expect(opts.themes).toEqual({ light: 'github-light', dark: 'github-dark' })
    // The stylesheet picks the branch. Applying one here would paint the panel
    // for whichever scheme the build happened to prefer.
    expect(opts.defaultColor).toBe(false)
  })

  // Shiki writes both themes' resolved colours onto <pre> as an inline style,
  // which would override `--dp-code-bg` and make the code card a different
  // surface from everything around it.
  it('strips the inline style Shiki puts on <pre>', async () => {
    const core = instance()
    const hl = createShikiHighlighter({ create: async () => core })
    await hl.load()
    core.codeToHtml.mockClear()
    hl.render('x', 'ts')
    const [, opts] = core.codeToHtml.mock.calls[0]
    const node = { properties: { style: 'color:#111', class: 'shiki' } }
    opts.transformers[0].pre(node)
    expect(node.properties.style).toBeUndefined()
    expect(node.properties.class).toBe('shiki')
  })

  /**
   * 161ms for TypeScript cold against 3.5ms warm — unwarmed that lands inside
   * the first frame that contains code, which is the one moment the reader is
   * watching the answer draw.
   */
  it('warms every grammar it loaded, and no alias twice', async () => {
    const core = instance()
    const hl = createShikiHighlighter({ create: async () => core })
    await hl.load()
    const warmed = core.codeToHtml.mock.calls.map(([, o]) => o.lang)
    expect(warmed).toEqual(['typescript', 'javascript', 'shellscript'])
  })

  it('renders nothing before load, rather than throwing', () => {
    expect(createShikiHighlighter({ create: async () => instance() }).render('x', 'ts')).toBe(null)
  })

  it('plugs into the registry as the panel installs it', async () => {
    const hl = createShikiHighlighter({ create: async () => instance() })
    setHighlighter(hl)
    await ensureHighlighter()
    expect(getHighlighter().id).toBe('shiki')
    expect(highlight('x', 'ts')).toContain('class="shiki"')
  })
})

/**
 * Prism and highlight.js, against the real packages.
 *
 * Against the real ones and not fakes, because the claims that matter here are
 * claims ABOUT those packages: that the text they wrap comes back escaped, that
 * their token colours apply without the block class, and that the grammars this
 * panel needs are reachable as static specifiers. A fake would assert only that
 * this file believes them.
 */
const HOSTILE = 'const a = "<img src=x onerror=alert(1)>"'

describe.each([
  ['prism', createPrismHighlighter, 'token'],
  ['hljs', createHljsHighlighter, 'hljs-'],
])('the %s adapter', (id, create, tokenClass) => {
  let hl

  beforeEach(async () => {
    setHighlighter(null)
    hl = create()
    await hl.load()
    setHighlighter(hl)
  })

  it('reports the panel canonical ids, not its own grammar names', () => {
    const ids = [...hl.loaded()]
    expect(ids).toContain('ts')
    expect(ids).toContain('js')
    expect(ids).toContain('bash')
    expect(ids).toContain('json')
    expect(ids).toContain('yaml')
    expect(ids).toContain('html')
    // Neither highlighter has a JSON-with-comments grammar; both fold it onto
    // `json` rather than dropping the fence to no highlighting at all.
    expect(ids).toContain('jsonc')
  })

  it('is reachable through the shipped alias table', () => {
    expect(resolveLang('TypeScript')).toBe('ts')
    expect(highlight('const a = 1', resolveLang('TypeScript'))).toContain(tokenClass)
    expect(highlight('a: 1', resolveLang('yml'))).toContain(tokenClass)
  })

  it('brings its own frame, and that frame is a tab stop', () => {
    const out = highlight('const a = 1', 'ts')
    expect(out.startsWith('<pre tabindex="0">')).toBe(true)
    expect(out.endsWith('</pre>')).toBe(true)
  })

  /**
   * The card's wrapper must never contain `language-`: VitePress binds a
   * window-level listener to `div[class*="language-"] > button.copy`, and the
   * panel teleports to `<body>` where that listener can reach it.
   *
   * Omitting the class is also what keeps the host's theme colouring TOKENS
   * while the code card keeps `--dp-code-bg` — Prism's block chrome hangs off
   * `[class*="language-"]` and its 34 token rules do not.
   */
  it('emits no language- class anywhere in its output', () => {
    expect(highlight('const a = 1', 'ts')).not.toContain('language-')
  })

  it('escapes hostile code rather than emitting a tag', () => {
    const out = highlight(HOSTILE, 'js')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  it('renders nothing for a language it does not have', () => {
    expect(hl.render('x', 'nope')).toBe(null)
  })

  it('renders nothing before load, rather than throwing', () => {
    expect(create().render('x', 'ts')).toBe(null)
  })
})

describe('an adapter handed the host own instance', () => {
  beforeEach(() => setHighlighter(null))

  // Registering into somebody else's Prism would change what the HOST's code
  // blocks are highlighted with, and which instance a `prismjs/components/*`
  // script mutates depends on the bundler's CJS interop.
  it('offers only what that instance already has', async () => {
    const languages = { javascript: { comment: /x/ } }
    const hl = createPrismHighlighter({
      prism: { languages, highlight: () => '<span class="token">x</span>' },
    })
    await hl.load()
    expect([...hl.loaded()]).toEqual(['js'])
  })

  it('does the same for highlight.js', async () => {
    const hl = createHljsHighlighter({
      hljs: {
        getLanguage: (n) => (n === 'javascript' ? {} : undefined),
        highlight: () => ({ value: 'x' }),
      },
    })
    await hl.load()
    expect([...hl.loaded()]).toEqual(['js'])
  })
})
