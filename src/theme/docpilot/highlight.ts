/**
 * Syntax highlighting for the answer — a REGISTRY, and one highlighter behind it.
 *
 * The pages of a documentation site are highlighted once at build time. An
 * answer is markdown that arrives token by token and is re-rendered every 90ms,
 * so a highlighter has to be resident in the browser and its render call has to
 * be SYNCHRONOUS. That constraint is the whole shape of this file: everything
 * asynchronous happens once, behind `ensureHighlighter()`; `markdown.js` only
 * ever calls `highlight()`, and gets `null` rather than a promise or a throw.
 *
 * WHAT LIVES HERE AND WHAT LIVES IN AN ADAPTER. This module keeps the alias
 * table, the memo, the length cap and the readiness test — the parts that are
 * about *this panel*, and that every host needs identically. An adapter keeps
 * grammar loading and tokenisation — the parts that are about a particular
 * highlighter. Shiki was the only one for as long as VitePress was the only
 * host; a Docusaurus site already ships Prism and a blog already ships
 * highlight.js, and asking either to load a second highlighter to colour one
 * panel is asking for a megabyte to avoid a mismatch.
 *
 * NOTHING IS INSTALLED BY DEFAULT, and that is deliberate rather than austere.
 * A default here would put `import('shiki/…')` in every consumer's module graph,
 * and a bundler that cannot resolve it fails the BUILD — so a Docusaurus site
 * that chose Prism would still have to install Shiki to compile. The entry
 * points choose instead: `@cloflin/docpilot/theme` installs Shiki, because that
 * is what VitePress highlights its own pages with, and `mountDocPilot()` takes
 * one as an option. With no adapter every block renders as a plain escaped
 * `<pre>`, which is exactly what an unsupported language already does.
 *
 * ```js
 * import { setHighlighter } from '@cloflin/docpilot/highlight'
 * import { createPrismHighlighter } from '@cloflin/docpilot/prism'
 *
 * setHighlighter(createPrismHighlighter())
 * ```
 */
import type { Highlighter } from '../../../types/highlight.js'

/**
 * Every info string this corpus and this model actually emit, mapped onto the
 * canonical language ids the panel speaks.
 *
 * THIS TABLE IS THE SANITISER. A fence's info string is written by the model,
 * and the value ends up in an attribute — so it is never escaped and echoed, it
 * is LOOKED UP, and only a value from this table is ever written out.
 *
 * Null prototype, and frozen. `Object.hasOwn` was already the guard against
 * ```constructor and ```__proto__ resolving to something truthy that is not a
 * language name; removing the prototype means there is nothing to resolve to in
 * the first place, which is the difference between a check that is correct and a
 * check that is unnecessary.
 *
 * The VALUES are the package's own ids, not any highlighter's. Each adapter maps
 * them onto its native names — `ts` is `typescript` to Prism and to
 * highlight.js, `html` is `markup` to one and `xml` to the other — so a project
 * that swaps highlighters does not find its fences suddenly unrecognised.
 */
export const LANGS = Object.freeze(
  Object.assign(Object.create(null), {
    ts: 'ts',
    typescript: 'ts',
    tsx: 'ts',
    js: 'js',
    javascript: 'js',
    mjs: 'js',
    cjs: 'js',
    jsx: 'js',
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    shellscript: 'bash',
    console: 'bash',
    json: 'json',
    jsonc: 'jsonc',
    yaml: 'yaml',
    yml: 'yaml',
    html: 'html',
    xml: 'html',
    svg: 'html',
    css: 'css',
  }),
)

// `text`/`plaintext` are deliberately absent: a highlighter would wrap them in
// colourless spans, which is the plain fallback with extra steps.

/** The set an adapter's aliases may point at, whatever else it has loaded. */
const CANONICAL = new Set(Object.values(LANGS))

/**
 * What an alias and a canonical id are allowed to look like.
 *
 * Narrow on purpose. The right-hand side of this table reaches an HTML attribute
 * unescaped, so the question is not "is this a plausible language name" but
 * "can this close an attribute" — and a character class that admits no quote, no
 * angle bracket and no whitespace answers it without a parser.
 */
const SAFE_LANG = /^[a-z0-9+#.-]{1,20}$/

let adapter: Highlighter | null = null
let loading: Promise<void> | null = null
let ready = new Set<string>()
let table: Record<string, string> = LANGS
const listeners = new Set<() => void>()

/** Fires once, when a highlighter finishes loading. */
export function onReady(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Merge an adapter's aliases into the shipped table — validated HERE, at
 * registration, rather than at every lookup.
 *
 * An adapter is third-party code and the table is a security boundary, so the
 * question "can this value reach an attribute" has to be answered once, on a
 * fixed set of pairs, instead of on every fence the model writes. A pair is
 * admitted only when both halves are shaped like a language name and the
 * right-hand side is something the adapter actually loaded — an alias pointing
 * at a grammar that is not there renders nothing and hides the reason.
 */
function mergeLangs(next) {
  const merged = Object.assign(Object.create(null), LANGS)
  const loaded = new Set(next?.loaded?.() || [])
  for (const [alias, canonical] of Object.entries(next?.langs || {})) {
    if (!SAFE_LANG.test(alias) || !SAFE_LANG.test(String(canonical))) {
      // eslint-disable-next-line no-console
      console.error(`[docpilot] highlighter "${next?.id}" declared an unusable alias`, alias)
      continue
    }
    if (!loaded.has(canonical) && !CANONICAL.has(canonical)) {
      // eslint-disable-next-line no-console
      console.error(
        `[docpilot] highlighter "${next?.id}" aliases ${alias} to ${canonical}, which it has not loaded`,
      )
      continue
    }
    merged[alias] = canonical
  }
  return Object.freeze(merged)
}

/**
 * Install a highlighter, or `null` to remove one.
 *
 * THE MEMO IS CLEARED, and that is not housekeeping. Its entries are finished
 * markup from the previous adapter — a panel that swapped Shiki for Prism
 * mid-session would otherwise keep serving Shiki markup for every block it had
 * already drawn, in a page whose stylesheet now colours Prism's classes.
 *
 * @param {{id: string, langs?: object, load?: () => Promise<void>, loaded?: () => Iterable<string>, render: (code: string, lang: string) => string|null}|null} next
 */
export function setHighlighter(next) {
  memo.clear()
  loading = null
  adapter = next || null
  ready = new Set(adapter?.loaded?.() || [])
  table = adapter ? mergeLangs(adapter) : LANGS
}

/** The installed highlighter, or null. */
export function getHighlighter() {
  return adapter
}

/**
 * A fence's info string to a canonical language id, or null.
 *
 * Lived in `markdown.js` while there was one table. It belongs beside the table
 * it reads, and the reason is the comment on `LANGS`: this is the only function
 * allowed to answer "what language is this", because it is the only one that
 * cannot answer with model text.
 */
export function resolveLang(info) {
  const first = String(info || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
  return Object.hasOwn(table, first) ? table[first] : null
}

/**
 * Load the installed highlighter's grammars. Idempotent; safe from anywhere.
 *
 * A no-op when nothing is installed — the panel then renders every block plain,
 * which is a decision the host made rather than a failure to report.
 */
export function ensureHighlighter() {
  if (loading) return loading
  if (!adapter) return Promise.resolve()
  loading = (async () => {
    await adapter.load?.()
    // Canonical names AND aliases, so this is the exact readiness test for the
    // values `resolveLang` can return.
    ready = new Set(adapter.loaded?.() || [])
    table = mergeLangs(adapter)
    for (const fn of listeners) fn()
  })().catch((e) => {
    // The memo has to be released too. A docs site loads grammars as dynamic
    // import chunks over the network, so the common failure here is a dropped
    // connection rather than a broken build — and a settled rejected promise
    // left in `loading` is what every later call returns, so one blip meant
    // unhighlighted code until the reader reloaded the page.
    loading = null
    ready = new Set()
    // eslint-disable-next-line no-console
    console.error('[docpilot] highlighter unavailable; code renders unhighlighted', e)
  })
  return loading
}

/** Past this, a block renders plain rather than blocking the frame. */
const MAX_CHARS = 20000
const MEMO_MAX = 64
const memo = new Map()

/**
 * Synchronous, and null-returning rather than throwing.
 *
 * null covers "nothing installed", "not loaded yet", "a language this
 * highlighter does not have" and "too long", and the caller renders the same
 * plain block for all four.
 */
export function highlight(code, lang) {
  if (!adapter || !lang || !ready.has(lang)) return null
  if (code.length > MAX_CHARS) return null

  const key = `${lang} ${code}`
  if (memo.has(key)) {
    const hit = memo.get(key)
    memo.delete(key)
    memo.set(key, hit)
    return hit
  }

  let html = null
  try {
    html = adapter.render(code, lang)
  } catch {
    html = null
  }
  // An adapter that returns a promise would render `[object Promise]` into the
  // answer. The contract says synchronous; this is where saying so costs one
  // comparison instead of a support thread.
  if (html && typeof html.then === 'function') {
    // eslint-disable-next-line no-console
    console.error(`[docpilot] highlighter "${adapter.id}" render() must be synchronous`)
    html = null
  }
  if (typeof html !== 'string') html = null

  // The memo is what makes live highlighting affordable: during streaming only
  // the last block is still changing, and every completed block above it is a
  // map hit rather than a re-tokenisation, on every frame.
  memo.set(key, html)
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value)
  return html
}

/**
 * Test seam: lets the unit tests exercise both paths without loading a
 * highlighter.
 *
 * Two arguments, unchanged from when Shiki was the only one — an object with
 * `codeToHtml(code, opts)` and the languages to treat as loaded. It models the
 * ADAPTER CONTRACT rather than any adapter's option set; the real Shiki
 * adapter's options are tested against it directly, by injecting a fake core.
 */
export function __setHighlighterForTests(instance, languages) {
  if (!instance) {
    setHighlighter(null)
    return
  }
  setHighlighter({
    id: 'test',
    load: async () => {},
    loaded: () => languages || [],
    render: (code, lang) => instance.codeToHtml(code, { lang }),
  })
}
