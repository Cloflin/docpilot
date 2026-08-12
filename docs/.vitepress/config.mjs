import { defineConfig } from 'vitepress'

/**
 * The plugin's own documentation site.
 *
 * It deliberately does NOT run the panel on itself. Doing so would need a model
 * endpoint and a key to build the docs, which is the exact coupling the
 * unconfigured path exists to avoid — and a docs site that cannot be built by a
 * contributor without credentials is a docs site that stops being updated.
 * `npm run docs:dev` works on a clone with an empty environment.
 */
export default defineConfig({
  title: 'Ask AI for VitePress',
  description:
    'A grounded AI answer panel for VitePress docs. Browser-side retrieval, a calibrated refusal gate, checked citations.',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/config' },
      { text: 'npm', link: 'https://www.npmjs.com/package/vitepress-plugin-ask-ai' },
    ],

    sidebar: [
      {
        text: 'Guide',
        base: '/guide/',
        items: [
          { text: 'Getting started', link: 'getting-started' },
          { text: 'Choosing providers', link: 'providers' },
          { text: 'Building the index', link: 'indexing' },
          { text: 'Calibration and evaluation', link: 'evaluation' },
          { text: 'Credentials in questions', link: 'credentials' },
        ],
      },
      {
        text: 'Understanding it',
        base: '/concepts/',
        items: [
          { text: 'How a turn works', link: 'a-turn' },
          { text: 'The refusal gate', link: 'the-gate' },
          { text: 'What it guarantees', link: 'guarantees' },
        ],
      },
      {
        text: 'Reference',
        base: '/reference/',
        items: [
          { text: 'Configuration', link: 'config' },
          { text: 'CLI', link: 'cli' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/stripo/vitepress-plugin-ask-ai' },
    ],

    footer: {
      message: 'Released under the MIT License.',
    },

    search: { provider: 'local' },
  },
})
