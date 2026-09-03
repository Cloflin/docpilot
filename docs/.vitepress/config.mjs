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
   * The model that answers, and ONE understudy behind it.
   *
   * `model` is the primary and `models` is the ordered pool the transport walks
   * when it cannot be reached — a named model on its own yields no pool at all
   * (`chatModels` in src/config.js returns null for one), so a single refusal
   * would end the turn on a transport error with nothing to fall back to.
   *
   * The understudy is chosen for the ONE call that is fussy about its body: the
   * forced final answer pins its shape with a strict `response_format`, and a
   * model that does not publish `structured_outputs` refuses it. Free ids are
   * ordered structured-outputs-first in `openrouter.js` and this is the head of
   * that list.
   *
   * NO `reasoning` KEY. `gpt-4o-mini` publishes no reasoning parameter, and
   * beside OpenRouter's `provider.require_parameters` — on by default, because
   * it is what stops a strict schema being silently dropped — naming one narrows
   * routing to endpoints that publish it and answers `404 No endpoints found
   * that can handle the requested parameters`. Writing `reasoning: false` did
   * that too: it is a request for `{enabled: false}`, which is a parameter, not
   * the absence of one. Left unset, no reasoning field is written at all.
   *
   * A pool also skips the capability probe (`budget.probe: 'auto'`), which is
   * one model request per page load on a single named model.
   */
  chat: {
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'nvidia/nemotron-3-super-120b-a12b:free'],
  },
  embed: {
    provider: 'openrouter',
    model: 'openai/text-embedding-3-small',
  },
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
