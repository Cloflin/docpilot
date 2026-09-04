import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vitepress'
import { extendConfig } from '@voidzero-dev/vitepress-theme/config.js'
import { defineDocPilot } from '@cloflin/docpilot'
import { openers } from './openers.mjs'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

const repo = 'https://github.com/Cloflin/docpilot'

const ragIndex = new URL('../public/rag/manifest.json', import.meta.url)

const env = loadEnv('', process.cwd(), '')

const LOCAL_EMBED = env.DOCPILOT_EMBED_LOCAL === '1'

const localRagIndex = new URL(
  '../public/rag-local/manifest.json',
  import.meta.url,
)

export const docPilot = {
  enabled: existsSync(LOCAL_EMBED ? localRagIndex : ragIndex),
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
            ? { provider: 'custom', model: 'qwen3:8b' }
            : { provider: 'ollama', model: 'qwen3:8b' },
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
          model: 'openai/gpt-4o-mini',
        },
        embed: {
          provider: 'openrouter',
          model: 'openai/text-embedding-3-small',
        },
      }),
  budget: { probe: 'never' },
  suggestions: { questions: openers },
  ui: { trigger: 'fab' },
}

const ai = defineDocPilot(docPilot, env)

const sidebarForGuide = [
  {
    text: 'Introduction',
    items: [
      { text: 'Getting started', link: '/guide/' },
      { text: 'Where it can go', link: '/guide/where-it-goes' },
      { text: 'Frequently asked', link: '/guide/faq' },
      { text: 'Philosophy', link: '/guide/philosophy' },
      { text: 'Why DocPilot', link: '/guide/why' },
      { text: 'How it compares', link: '/guide/comparison' },
    ],
  },
  {
    text: 'Install',
    base: '/install/',
    items: [
      { text: 'Which entry point', link: '' },
      { text: 'VitePress', link: 'vitepress' },
      { text: 'Docusaurus', link: 'docusaurus' },
      { text: 'Vue', link: 'vue' },
      { text: 'React', link: 'react' },
      { text: 'JavaScript', link: 'javascript' },
      { text: 'TypeScript', link: 'typescript' },
      { text: 'Web', link: 'web' },
    ],
  },
  {
    text: 'Guide',
    items: [
      { text: 'The assistant panel', link: '/guide/panel' },
      { text: 'Choosing providers', link: '/guide/providers' },
      { text: 'Living on the free tier', link: '/guide/free-tier' },
      { text: 'What it costs', link: '/guide/what-it-costs' },
      { text: 'Building the index', link: '/guide/indexing' },
      { text: 'Imported pages', link: '/guide/imported-pages' },
      { text: 'Calibration and evaluation', link: '/guide/evaluation' },
      { text: 'Production', link: '/guide/production' },
      { text: 'A host of your own', link: '/guide/other-sites' },
      { text: 'Appearance', link: '/guide/appearance' },
      { text: 'Translating the panel', link: '/guide/i18n' },
      { text: 'Conversation history', link: '/guide/history' },
      { text: 'Social openers', link: '/guide/social-openers' },
      { text: 'Credentials in questions', link: '/guide/credentials' },
      { text: 'llms.txt and crawlers', link: '/guide/llms-txt' },
      { text: 'Troubleshooting', link: '/guide/troubleshooting' },
    ],
  },
  {
    text: 'Understanding it',
    items: [
      { text: 'How a turn works', link: '/concepts/a-turn' },
      { text: 'The refusal gate', link: '/concepts/the-gate' },
      { text: 'The answer ladder', link: '/concepts/the-ladder' },
      { text: 'What it guarantees', link: '/concepts/guarantees' },
    ],
  },
]

const sidebarForReference = [
  {
    text: 'Reference',
    base: '/reference/',
    items: [
      { text: 'Configuration', link: 'config' },
      { text: 'Theme tokens', link: 'theme' },
      { text: 'Syntax highlighting', link: 'highlighting' },
      { text: 'CLI', link: 'cli' },
      { text: 'Skills', link: 'skills' },
    ],
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
            find: /^@cloflin\/docpilot\/theme$/,
            replacement: fileURLToPath(new URL('../../src/theme/index.js', import.meta.url)),
          },
        ],
      },
    }
  },
})

const config = defineConfig({
  vite: { plugins: [ai.plugin(), devSource()] },

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
    variant: 'rolldown',

    nav: [
      {
        text: 'Guide',
        activeMatch: '/(guide|concepts|install)',
        link: '/guide/',
      },
      {
        text: 'Reference',
        activeMatch: '/reference',
        link: '/reference/config',
      },
      {
        text: `v${pkg.version}`,
        items: [
          { text: 'Releases', link: `${repo}/releases` },
          {
            text: 'npm',
            link: 'https://www.npmjs.com/package/@cloflin/docpilot',
          },
        ],
      },
    ],

    sidebar: {
      '/guide/': sidebarForGuide,
      '/install/': sidebarForGuide,
      '/concepts/': sidebarForGuide,
      '/reference/': sidebarForReference,
    },

    outline: 'deep',

    socialLinks: [{ icon: 'github', link: repo }],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: '© 2025-present Cloflin and DocPilot contributors.',
      nav: [
        {
          title: 'DocPilot',
          items: [
            { text: 'Getting started', link: '/guide/' },
            { text: 'The assistant panel', link: '/guide/panel' },
            { text: 'How it compares', link: '/guide/comparison' },
            { text: 'Why DocPilot', link: '/guide/why' },
            { text: 'Building the index', link: '/guide/indexing' },
            { text: 'Configuration', link: '/reference/config' },
            { text: 'CLI', link: '/reference/cli' },
          ],
        },
        {
          title: 'Understanding it',
          items: [
            { text: 'How a turn works', link: '/concepts/a-turn' },
            { text: 'The refusal gate', link: '/concepts/the-gate' },
            { text: 'The answer ladder', link: '/concepts/the-ladder' },
            { text: 'What it guarantees', link: '/concepts/guarantees' },
          ],
        },
      ],
      social: [{ icon: 'github', link: repo }],
    },

    search: { provider: 'local' },
  },
})

export default extendConfig(config)
