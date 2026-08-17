import { existsSync, readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vitepress'
// `.js` spelled out: the theme ships no `exports` map, so Node's ESM resolver
// will not add the extension the way Vite's does. Without it `npx docpilot
// doctor` — which loads this file with plain Node — dies on a resolution error
// before it can report anything about DocPilot.
import { extendConfig } from '@voidzero-dev/vitepress-theme/config.js'
// By package name, not by relative path: this site is the package's own first
// consumer, so it goes through the `exports` map every other project goes
// through. A subpath that stops resolving fails the docs build here, rather
// than someone else's install.
import { defineDocPilot } from '@cloflin/docpilot'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

const repo = 'https://github.com/cloflin/docpilot'

/**
 * The panel, on the package's own documentation.
 *
 * It used to be deliberately absent, on the grounds that mounting it would make
 * the docs build need a model endpoint and a key — and a docs site a
 * contributor cannot build is a docs site that stops being updated. That
 * reasoning survives; the conclusion does not have to, because the two halves
 * separate cleanly:
 *
 *   · THE BUILD needs nothing. `defineDocPilot` never throws, and an installation
 *     with no key emits `{enabled: false}`, at which point the trigger, the
 *     call-to-action and the hotkey all render nothing. `npm run docs:dev` on a
 *     clone with an empty environment behaves exactly as it did.
 *
 *   · THE PANEL needs the retrieval index, which is a build artifact rather
 *     than a source file — megabytes of quantised vectors, correctly gitignored
 *     — so the mount is gated on that index existing. Without the gate the site
 *     would ship a panel that opens only to say AI answers are off here, which
 *     is a worse first impression than no panel at all.
 *
 * `npm run docs:index` builds it, against a reachable embedder, and the panel
 * appears on the next build.
 */
const ragIndex = new URL('../public/rag/manifest.json', import.meta.url)

/**
 * The contract between this file and the CLI: `docpilot index`, `calibrate` and
 * `doctor` all read THIS named export, so there is no second place stating
 * which model embeds or where the docs live.
 *
 * The providers are the shipped defaults, written out rather than inherited:
 * this is the setup Getting started tells a reader to run, so the site that
 * documents it should be the one running it.
 */
export const docPilot = {
  enabled: existsSync(ragIndex),
  product: 'DocPilot for VitePress',
  chat: { provider: 'ollama', model: 'qwen3:8b' },
  embed: { provider: 'ollama', model: 'bge-m3' },
  /**
   * The floating button, not the navbar one, and not by preference.
   *
   * `@voidzero-dev/vitepress-theme` replaces VitePress's `VPNav` with its own
   * `OSSHeader`, which offers `nav-bar-title-before` and `-after` and nothing
   * else — `nav-bar-content-before`, the slot the navbar trigger lives in, is
   * never rendered on this site, so `trigger: 'nav'` would silently produce no
   * way to open the panel at all. `layout-bottom` IS rendered, by both of the
   * theme's layouts, which is where the floating button goes. `panel` is left
   * at `auto`, and auto follows the trigger: fab opens the popup.
   */
  ui: { trigger: 'fab' },
}

const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))

/**
 * Guide and Understanding-it share one sidebar. They are two halves of the same
 * read — the guide says what to type, the concepts pages say what happens when
 * you do — and splitting them hides the second half from anyone who arrives at
 * the first.
 *
 * Three groups, in the order Vite's own docs use: why it exists, how to run it,
 * what it does underneath. Introduction is short and answerable in one sitting;
 * Guide follows the life of a project rather than the order the pages were
 * written; Understanding it stays last because nobody needs the gate's two
 * channels before their first index has been built.
 *
 * Links are absolute rather than `base`-relative. `/guide/` is a group landing
 * page as well as a link, and a `base` that ends where its link begins reads as
 * a typo every time someone edits this file.
 */
const sidebarForGuide = [
  {
    text: 'Introduction',
    items: [
      { text: 'Getting started', link: '/guide/' },
      { text: 'Philosophy', link: '/guide/philosophy' },
      { text: 'Why DocPilot', link: '/guide/why' },
    ],
  },
  {
    text: 'Guide',
    items: [
      { text: 'Choosing providers', link: '/guide/providers' },
      { text: 'Building the index', link: '/guide/indexing' },
      { text: 'Imported pages', link: '/guide/imported-pages' },
      { text: 'Calibration and evaluation', link: '/guide/evaluation' },
      { text: 'Production', link: '/guide/production' },
      { text: 'Sites that are not VitePress', link: '/guide/other-sites' },
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
      { text: 'CLI', link: 'cli' },
      { text: 'Skills', link: 'skills' },
    ],
  },
]

/**
 * The plugin's own documentation site, running the plugin — see the `docPilot`
 * block above for what that costs a contributor with an empty environment
 * (nothing) and what it takes to actually see the panel (an index).
 *
 * The theme is `@voidzero-dev/vitepress-theme`, the shared theme the Rolldown,
 * Vite and Vitest docs are built on, wired the same way Rolldown wires it:
 * `extendConfig` injects the Tailwind plugin and the theme's path aliases, and
 * `themeConfig.variant` picks which brand layer the CSS applies.
 */
const config = defineConfig({
  // Three jobs, all of them things this site would otherwise have to know
  // about: SSR-externalisation of the package's own `.vue` files, the dev-only
  // `/ai/*` proxy that attaches the key, and the build-time readiness report.
  vite: { plugins: [ai.plugin()] },

  title: 'DocPilot for VitePress',
  description:
    'A grounded AI answer panel for VitePress docs. Browser-side retrieval, a calibrated refusal gate, checked citations.',
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
        content: 'DocPilot for VitePress | Grounded answers in your docs',
      },
    ],
    ['meta', { property: 'og:site_name', content: 'DocPilot for VitePress' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],

  themeConfig: {
    docPilot: ai.themeConfig,
    variant: 'rolldown',

    nav: [
      {
        text: 'Guide',
        activeMatch: '/(guide|concepts)',
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
