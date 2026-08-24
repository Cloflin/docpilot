/**
 * Shiki — the default on VitePress, and the closest thing to a match between the
 * panel's code blocks and the page's.
 *
 * VitePress highlights its own pages with Shiki at build time, so an answer
 * rendered with the same grammars and the same two themes is the same code, in
 * the same colours, in a narrower box. That is the whole argument for it being
 * the default there and for it not being the default anywhere else.
 *
 *     import { createShikiHighlighter } from '@cloflin/docpilot/shiki'
 *     setHighlighter(createShikiHighlighter())
 *
 * FOUR OPTIONAL PEERS, and they are named individually because there is no
 * single package that reaches all of them. `shiki` exports `./core` and
 * `./engine/javascript` but no per-language or per-theme subpath, and the full
 * `shiki/langs` bundle is every grammar there is — so the imports below have to
 * go through `@shikijs/*` directly. Until this file existed none of the four
 * were declared at all: they resolved because `vitepress` depends on `shiki` and
 * npm lays node_modules out flat, which meant the panel rendered unhighlighted
 * code under pnpm and on every host that is not VitePress, with one console
 * error and no other symptom.
 */

/**
 * The two themes VitePress ships with, so the panel matches the page.
 *
 * NOT AN OPTION, and the reason is the bundler rather than taste: a per-theme
 * import has to be a static specifier, because `import(\`…/${name}\`)` is a glob
 * to every bundler that sees it and would pull every theme Shiki publishes into
 * the build. A project that wants different ones passes `create` and loads them
 * itself — one function instead of a megabyte.
 */
const THEMES = { light: 'github-light', dark: 'github-dark' }

// Shiki writes the resolved colours of BOTH themes onto <pre> as an inline
// style. Removing it — which is what VitePress does with its own output — keeps
// `--dp-fill` as the panel's one code surface no matter what the theme options
// later become.
const STRIP_PRE_STYLE = [
  {
    pre(node) {
      delete node.properties.style
    },
  },
]

/** What `load()` compiles: the grammars this corpus and this model emit. */
const GRAMMARS = ['typescript', 'javascript', 'shellscript', 'json', 'jsonc', 'yaml', 'html', 'css']

async function createCore() {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('@shikijs/core'),
    import('@shikijs/engine-javascript'),
  ])
  return createHighlighterCore({
    // Not optional, despite the name of the field it sits next to: with no
    // engine, core 2.x falls back to Oniguruma and fetches a 600 KB wasm
    // binary — silently, with only a deprecation warning. The JS engine is
    // ~2.5x slower and ~11x lighter; at a 90ms render floor the second number
    // is the one that matters. `forgiving` keeps a pattern the JS engine
    // cannot express from taking the whole grammar down with it.
    //
    // If a grammar ever mis-parses, this one line becomes:
    //   engine: createOnigurumaEngine(import('shiki/wasm'))
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
    langs: [
      import('@shikijs/langs/typescript'),
      import('@shikijs/langs/javascript'),
      import('@shikijs/langs/shellscript'), // bash · sh · shell · zsh
      import('@shikijs/langs/json'),
      import('@shikijs/langs/jsonc'),
      import('@shikijs/langs/yaml'),
      import('@shikijs/langs/html'), // pulls javascript and css with it
    ],
    warnings: false,
  })
}

/**
 * @param {{create?: () => Promise<object>}} [options]
 *   `create` returns a Shiki core instance. It is the seam the unit tests inject
 *   through — what lets the render path, including the options below, be
 *   exercised without a network fetch or a 600 KB grammar compile — and it is
 *   also the supported way to ship different themes or extra grammars.
 */
export function createShikiHighlighter(options = {}) {
  let hl = null

  return {
    id: 'shiki',

    async load() {
      if (hl) return
      hl = await (options.create || createCore)()
      warmUp(hl)
    },

    // Canonical names AND aliases — Shiki reports both, so `ts`, `bash` and
    // `css` are all present without this adapter declaring a single alias. The
    // panel's canonical ids are Shiki's own names, which is why it has no
    // `langs` table where the other two adapters need one.
    loaded: () => (hl ? hl.getLoadedLanguages() : []),

    render(code, lang) {
      if (!hl) return null
      return hl.codeToHtml(code, {
        lang,
        themes: THEMES,
        // Both themes as custom properties on every token, neither applied. The
        // stylesheet picks one — `prefers-color-scheme` in the core, the host's
        // own dark signal in each adapter — which is the only way one render can
        // serve a reader who has pinned the site against their OS.
        defaultColor: false,
        transformers: STRIP_PRE_STYLE,
      })
    },
  }
}

/**
 * The first call on a grammar compiles its patterns: measured, 161ms for
 * TypeScript against 3.5ms warm. Unwarmed, that lands inside the first frame
 * that contains code — the one moment the reader is watching the answer draw.
 *
 * Over the grammars rather than over everything `getLoadedLanguages()` reports:
 * the aliases share a compiled grammar with their canonical name, so warming
 * `sh`, `zsh` and `shell` after `shellscript` is three no-ops with a try/catch
 * each.
 */
function warmUp(hl) {
  const loaded = new Set(hl.getLoadedLanguages())
  for (const lang of GRAMMARS) {
    if (!loaded.has(lang)) continue
    try {
      hl.codeToHtml('a', { lang, themes: THEMES, defaultColor: false })
    } catch {
      /* a language that did not load is simply not warm */
    }
  }
}
