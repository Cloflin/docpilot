import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vitepress'
import tailwindcss from '@tailwindcss/vite'
import { defineDocPilot } from '@cloflin/docpilot'
import { openers } from './openers.mjs'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

const repo = 'https://github.com/Cloflin/docpilot'

const ragIndex = new URL('../public/rag/manifest.json', import.meta.url)

const env = loadEnv('', process.cwd(), '')

/**
 * The index figures the demos print, read from the committed manifest at build
 * time so a reindex moves them without an edit. The prose pages state the same
 * numbers literally and are held by `test/docs-links.test.js`.
 */
const figures = (() => {
  if (!existsSync(ragIndex)) return null
  const m = JSON.parse(readFileSync(ragIndex, 'utf8'))
  const bytes = m.chunkCount * Math.ceil(m.dims / 8)
  return {
    chunks: m.chunkCount,
    dims: m.dims,
    pages: m.pages.length,
    bytes,
    kb: `${Math.round(bytes / 1024)} KB`,
    int8: `${((m.chunkCount * m.dims) / 1024 / 1024).toFixed(1)} MB`,
    float32: `${((m.chunkCount * m.dims * 4) / 1024 / 1024).toFixed(1)} MB`,
    tau: m.guard?.tau ?? null,
    embedModel: m.embedModel,
  }
})()

const LOCAL_EMBED = env.DOCPILOT_EMBED_LOCAL === '1'

const localRagIndex = new URL(
  '../public/rag-local/manifest.json',
  import.meta.url,
)

export const docPilot = {
  enabled: existsSync(LOCAL_EMBED ? localRagIndex : ragIndex),
  // engine-spec 028 — `DOCPILOT_RUNTIME=server` builds the panel as a thin
  // client and runs the turn in `docpilot serve` (see docker/).
  runtime: env.DOCPILOT_RUNTIME === 'server' ? 'server' : 'browser',
  product: 'DocPilot',
  quote: { fromAnswer: true, fromDocs: true },
  citations: { passage: true, inCopy: true, pagesRead: true },
  /**
   * `DOCPILOT_EMBED_LOCAL=1` buys a SECOND index, at `docs/public/rag-local`:
   * bge-m3 on the Ollama named by `OLLAMA_BASE_URL`, with `qwen3:8b` answering.
   * It exists so `calibrate`, `eval` and `lint` can be run as often as a
   * measurement needs without spending the deployed key's daily allowance, and
   * so a local `docpilot index` writes beside the committed OpenRouter index
   * rather than over it.
   *
   * `chat` and `embed` sit inside the ternary rather than above it because an
   * object literal lets the LAST key win: a spread placed above them would set
   * both halves and then be overwritten by the deployed pair, leaving the flag
   * moving nothing but `enabled` — which is the defect this repairs.
   */
  ...(LOCAL_EMBED
    ? {
        /**
         * `indexDir` IS THE WHOLE OF "it writes somewhere else".
         *
         * The block above promises it and nothing implemented it: `indexDirOf`
         * falls back to `${docsDir}/public/rag`, so a local build wrote over the
         * committed index with a bge-m3 one — the exact outcome the paragraph
         * about a spent quota describes, arrived at by the flag that exists to
         * avoid it.
         */
        /**
         * A THIRD index, and the reason it is a variable rather than an edit:
         * `calibrate --transfer` has to be measured against ground truth, and
         * ground truth means a genuinely different vector space over the SAME
         * corpus. `qwen3-embedding` at 4096 dimensions against `bge-m3` at 1024
         * is that, on one machine, for nothing.
         *
         *   DOCPILOT_EMBED_MODEL=qwen3-embedding npx docpilot index
         *
         * `indexDir` moves with it for the reason the block below states: two
         * builds writing one directory is the local one overwriting the
         * deployed index with a manifest the browser cannot use.
         */
        indexDir: env.DOCPILOT_EMBED_MODEL ? `docs/public/rag-${env.DOCPILOT_EMBED_MODEL.replace(/[^a-z0-9]+/gi, '-')}` : 'docs/public/rag-local',
        /**
         * The BROWSER's half of the same statement, and it has to move with
         * `indexDir` or the two disagree in the one place nobody looks.
         *
         * `hostConfig` derives `ragBase` as `${base}rag`, so without this the
         * panel fetched `/rag/manifest.json` — the OpenRouter index — while the
         * build wrote `rag-local/`. The flag then showed the panel working on
         * exactly the artefact it was supposed to be replacing.
         */
        host: { ragBase: '/rag-local' },
        /**
         * The CHAT half is switchable between the two ways the same server can
         * be reached, so an A/B against a gateway is a variable rather than an
         * edit — `DOCPILOT_CHAT_ADAPTER=custom npx docpilot eval`.
         *
         * `ollama` is the default and stays the default. The native adapter is
         * the only one that maps `numCtx` onto `options.num_ctx`, and the eight
         * excerpts a primed turn carries do not fit the server's own default
         * context. `custom` is `openaiCompatible` with `caps: {unknown: true}`,
         * so that knob has nowhere to go and the window is truncated by the
         * server without a word in any report — which is the failure mode this
         * comment exists to keep out of the numbers.
         *
         * `CUSTOM_BASE_URL` is the BARE host — no `/v1` on the end. Each adapter
         * composes the path itself (`providers.js`): the openai one asks for
         * `${baseURL}/v1/embeddings` and the native one for `${baseURL}/api/embed`,
         * so a suffix here produces `…:11434/v1/v1/embeddings` and a 404 that
         * reads as an unreachable endpoint rather than as a doubled path.
         *
         *   CUSTOM_BASE_URL=http://192.168.50.146:11434
         *
         * Moving the EMBED half across is safe against this index: both routes
         * are the same bge-m3 on the same server, and the two vectors compare at
         * cosine 1.000000 — measured, not assumed.
         */
        chat:
          env.DOCPILOT_CHAT_ADAPTER === 'custom'
            ? { provider: 'custom', model: env.DOCPILOT_CHAT_MODEL || 'qwen3:8b' }
            : {
                provider: 'ollama',
                model: env.DOCPILOT_CHAT_MODEL || 'qwen3:8b',
                // A named Ollama is reached at its own baseURL, never through
                // OLLAMA_BASE_URL alone — inside a container that is the host.
                ...(env.OLLAMA_BASE_URL ? { baseURL: env.OLLAMA_BASE_URL } : {}),
              },
        /**
         * `baseURL` is stated rather than left to the environment, because for a
         * NON-HOSTED provider `nodeEmbedTarget` reads `embed.baseURL ||
         * LOCAL_BASE_URL` and never consults `OLLAMA_BASE_URL` — that variable
         * selects the provider in the chain, it does not relocate one already
         * named here. Left out, every `docpilot index` and `calibrate` silently
         * embeds against `http://localhost:11434` whatever the variable says,
         * which is only invisible while both hosts happen to serve the same
         * model.
         */
        embed: {
          provider: env.DOCPILOT_CHAT_ADAPTER === 'custom' ? 'custom' : 'ollama',
          model: env.DOCPILOT_EMBED_MODEL || 'bge-m3',
          baseURL: env.OLLAMA_BASE_URL || 'http://localhost:11434',
        },
      }
    : {
        chat: {
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash',
          reasoning: true,
        },
        embed: {
          provider: 'openrouter',
          model: 'qwen/qwen3-embedding-8b',
        },
      }),
  budget: { probe: 'never' },
  suggestions: { questions: openers },
  ui: { trigger: 'fab' },
}

const ai = defineDocPilot(docPilot, env)

/**
 * Group icons: Lucide paths, raw SVG, because the theme renders `icon` as markup.
 */
const icons = {
  start: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
  features: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 10l-5 3.9L16.5 20 12 16.6 7.5 20 9 13.9 4 10l6.1-1.2Z"/></svg>',
  guide: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  concepts: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  reference: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
}

const groups = [
  {
    text: 'Get started',
    icon: icons.start,
    items: [
      { text: 'Introduction', link: '/introduction' },
      { text: 'Security', link: '/guide/security', badge: 'new' },
      { text: 'Quick start', link: '/guide/' },
      { text: 'Install', link: '/install/' },
      { text: 'VitePress', link: '/install/vitepress' },
      { text: 'Docusaurus', link: '/install/docusaurus' },
      { text: 'Vue', link: '/install/vue' },
      { text: 'React', link: '/install/react' },
      { text: 'JavaScript', link: '/install/javascript' },
      { text: 'TypeScript', link: '/install/typescript' },
      { text: 'Script tag', link: '/install/web' },
      { text: 'Where it can go', link: '/guide/where-it-goes' },
    ],
  },
  {
    text: 'Features',
    icon: icons.features,
    items: [
      { text: 'Overview', link: '/features/' },
      { text: 'Triggers and layout', link: '/features/triggers' },
      { text: 'Search scope', link: '/features/scope' },
      { text: 'Sources and passages', link: '/features/sources' },
      { text: 'Ask about a selection', link: '/features/quote' },
      { text: 'Copy, retry, edit', link: '/features/actions' },
      { text: 'Conversation history', link: '/features/history' },
      { text: 'Conversation memory', link: '/features/memory', badge: 'new' },
      { text: 'Model fallback', link: '/features/fallback' },
      { text: 'Every language', link: '/features/i18n' },
      { text: 'Suggestions', link: '/features/suggestions' },
      { text: 'Status and reasoning', link: '/features/status' },
      { text: 'Relevance gate', link: '/features/gate' },
      { text: 'Feedback', link: '/features/feedback' },
      { text: 'Pasted keys', link: '/features/credentials' },
      { text: 'How this works', link: '/features/prompt' },
    ],
  },
  {
    text: 'Guide',
    icon: icons.guide,
    items: [
      { text: 'The assistant panel', link: '/guide/panel' },
      { text: 'Choosing providers', link: '/guide/providers' },
      { text: 'What it costs', link: '/guide/what-it-costs' },
      { text: 'Building the index', link: '/guide/indexing' },
      { text: 'Calibration and evaluation', link: '/guide/evaluation' },
      { text: 'Imported pages', link: '/guide/imported-pages' },
      { text: 'Production', link: '/guide/production' },
      { text: 'The server runtime', link: '/guide/server' },
      { text: 'Improving answers from traffic', link: '/guide/improving' },
      { text: 'Fine-tuning', link: '/guide/fine-tuning' },
      { text: 'A host of your own', link: '/guide/other-sites' },
      { text: 'Appearance', link: '/guide/appearance' },
      { text: 'Translating the panel', link: '/guide/i18n' },
      { text: 'Conversation history', link: '/guide/history' },
      { text: 'Social openers', link: '/guide/social-openers' },
      { text: 'Credentials in questions', link: '/guide/credentials' },
      { text: 'llms.txt and crawlers', link: '/guide/llms-txt' },
      { text: 'Troubleshooting', link: '/guide/troubleshooting' },
      { text: 'Frequently asked', link: '/guide/faq' },
    ],
  },
  {
    text: 'Understanding it',
    icon: icons.concepts,
    items: [
      { text: 'How a turn works', link: '/concepts/a-turn' },
      { text: 'The refusal gate', link: '/concepts/the-gate' },
      { text: 'The answer ladder', link: '/concepts/the-ladder' },
      { text: 'What it guarantees', link: '/concepts/guarantees' },
      { text: 'Philosophy', link: '/guide/philosophy' },
      { text: 'Why DocPilot', link: '/guide/why' },
      { text: 'How it compares', link: '/guide/comparison' },
    ],
  },
  {
    text: 'Reference',
    icon: icons.reference,
    items: [
      { text: 'Configuration', link: '/reference/config' },
      { text: 'CLI', link: '/reference/cli' },
      { text: 'Theme tokens', link: '/reference/theme' },
      { text: 'Syntax highlighting', link: '/reference/highlighting' },
      { text: 'Skills', link: '/reference/skills' },
    ],
  },
]

/**
 * Three sidebars, one per top-level section — Docs, Features, Reference — so
 * each nav item opens its own page tree and prev/next stays inside it. Keyed by
 * path prefix; the longest match wins.
 */
const [start, features, guide, concepts, reference] = groups
const releases = {
  text: 'Releases',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>',
  items: [{ text: 'Changelog', link: '/changelog', badge: `v${pkg.version}` }],
}
const docs = [start, releases, guide, concepts]
const sidebar = {
  '/introduction': docs,
  '/changelog': docs,
  '/guide/': docs,
  '/install/': docs,
  '/concepts/': docs,
  '/features/': [features],
  '/reference/': [reference],
}

/**
 * What `@cloflin/vitepress-theme/vite` exports, written out here. That entry
 * ships as TypeScript source, and Node refuses to strip types under
 * node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a `.mjs`
 * config cannot import it. Tailwind compiles the theme's stylesheet; the
 * theme and its Vue dependencies have to be bundled for SSR, and kept out of
 * the dev server's dependency pre-bundling.
 */
const cloflinTheme = () => [
  tailwindcss(),
  {
    name: 'cloflin-vitepress-theme',
    config: () => ({
      ssr: { noExternal: ['@cloflin/vitepress-theme', 'motion-v', 'reka-ui'] },
      // Pre-bundling would hand the theme's stylesheet to esbuild, which does not
      // run Tailwind: the dev server then serves the CSS uncompiled.
      optimizeDeps: { exclude: ['@cloflin/vitepress-theme'] },
      // `@cloflin/docpilot/theme` imports `vitepress/theme` for its default
      // Layout, and that import carries the default theme's global stylesheet,
      // whose unlayered resets beat every Tailwind utility in this theme. The
      // wrapper only uses it as a fallback when the theme has no Layout; this
      // one has, so an empty module stands in.
      resolve: {
        alias: [{ find: /^vitepress\/theme$/, replacement: fileURLToPath(new URL('./theme/no-default-theme.js', import.meta.url)) }],
      },
    }),
  },
]

const devSource = () => ({
  name: 'docpilot:dev-source',
  config(_config, { command }) {
    if (command !== 'serve') return
    return {
      resolve: {
        alias: [
          {
            find: /^@cloflin\/docpilot\/theme-without-styles$/,
            replacement: fileURLToPath(new URL('../../src/theme/no-styles.js', import.meta.url)),
          },
        ],
      },
    }
  },
})

const config = defineConfig({
  vite: { plugins: [cloflinTheme(), ai.plugin(), devSource()] },

  title: 'DocPilot',
  description:
    'A grounded AI assistant for any page of your site — docs, a landing page, a help centre, or an app you already ship. A real chat: scope it, quote a passage, follow up. Retrieval runs in the browser, an opt-in gate can refuse before the model is called, and every citation is checked.',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#476be3' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'en' }],
    [
      'meta',
      {
        property: 'og:title',
        content: 'DocPilot | An AI assistant on every page of your site',
      },
    ],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'An AI chat that mounts on any page of any site and answers from a static index you build. Retrieval runs in the browser; an opt-in gate can refuse before the model is called; every citation is checked against what was retrieved.',
      },
    ],
    ['meta', { property: 'og:site_name', content: 'DocPilot' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],

  themeConfig: {
    docPilot: ai.themeConfig,
    figures,

    // Per appearance, not `logo.svg`: that one switches on the OS setting
    // (prefers-color-scheme), which disagrees with the site's own toggle.
    logo: { light: '/mark-light.svg', dark: '/mark-dark.svg' },
    siteTitle: false,

    nav: [
      { text: 'Docs', link: '/introduction', activeMatch: '^/(introduction|guide/|install/|concepts/)' },
      { text: 'Features', link: '/features/', activeMatch: '^/features/' },
      { text: 'Reference', link: '/reference/config', activeMatch: '^/reference/' },
      { text: `v${pkg.version}`, link: '/changelog', activeMatch: '^/changelog' },
    ],
    navCta: { text: 'Get started', link: '/guide/' },

    sidebar,
    outline: { level: [2, 3] },

    socialLinks: [
      { icon: 'github', link: repo },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@cloflin/docpilot' },
      {
        icon: {
          svg: '<path fill="currentColor" d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z"/>',
        },
        link: 'https://www.linkedin.com/in/oponamarchuk/',
        ariaLabel: 'LinkedIn',
      },
      { icon: 'x', link: 'https://x.com/ponamarchuk_o', ariaLabel: 'X' },
    ],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    lastUpdated: { text: 'Last updated' },

    footer: {
      message: 'Released under the MIT License.',
      copyright: '© 2025-present Cloflin and DocPilot contributors.',
    },

    search: { provider: 'local' },
  },
})

export default config
