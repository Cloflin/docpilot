import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
import { openers } from './openers.mjs'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

const repo = 'https://github.com/Cloflin/docpilot'

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
 * THE SECOND INDEX — `DOCPILOT_EMBED_LOCAL=1`.
 *
 * It began as an escape hatch and is now an artefact with a job. Two of them,
 * and they pull in the same direction:
 *
 * ── ITERATION ─────────────────────────────────────────────────────────────────
 * OpenRouter's free tier meters REQUESTS, not tokens, and rebuilding this index
 * costs about fifteen of the fifty a day. Three rebuilds in an afternoon of
 * editing docs and the next one is an HTTP 429 — a bad afternoon, because
 * `test/docs-links.test.js` fails while a committed index is stale and there is
 * nothing to do but wait for midnight UTC. A local Ollama costs none of them.
 *
 * ── A FLOOR TO MEASURE AGAINST ────────────────────────────────────────────────
 * bge-m3 at 1024 dimensions is a weaker embedder than the 2048-dimension pool
 * the deploy uses, and that is what makes it useful: a retrieval configuration
 * that answers well HERE answers at least as well there, so a run against this
 * index is a lower bound rather than a different measurement. `npx docpilot
 * bench` is the tool, and the comparison only means something because both
 * indexes are the same corpus — which is what committing them both enforces.
 *
 * IT WRITES SOMEWHERE ELSE, and that is still the important part. A local build
 * into `docs/public/rag/` would overwrite the deployed index with one the
 * browser cannot use, and on a spent quota it could not be rebuilt. `indexDir`
 * below is the whole of that guarantee.
 *
 * ── WHY COMMITTING IT IS SAFE ─────────────────────────────────────────────────
 * The old answer was that `rag-local/` was gitignored, so the disagreement could
 * not reach a commit. That was hiding the file rather than closing the failure.
 * What actually closes it is that the deployed site is never pointed here by
 * accident: `readiness()` raises "the index was built with bge-m3, which is not
 * in openrouter's free embedding pool" as a hard `missing`, and
 * `scripts/vercel-build.sh` runs `doctor`, which exits 1 on it. Serving this
 * index takes an embedder that serves bge-m3 and nothing else gets past that.
 *
 *   DOCPILOT_EMBED_LOCAL=1 node bin/docpilot.js index   # ~0 API requests
 *   DOCPILOT_EMBED_LOCAL=1 npm run docs:dev             # panel reads rag-local
 *   DOCPILOT_EMBED_LOCAL=1 node bin/docpilot.js eval    # the floor, measured
 *
 * `ollama pull bge-m3` and `ollama pull qwen3:8b` are the whole of the setup.
 */
const env = loadEnv('', process.cwd(), '')

const LOCAL_EMBED = env.DOCPILOT_EMBED_LOCAL === '1'

const localRagIndex = new URL(
  '../public/rag-local/manifest.json',
  import.meta.url,
)

/**
 * The contract between this file and the CLI: `docpilot index`, `calibrate` and
 * `doctor` all read THIS named export, so there is no second place stating
 * which model embeds or where the docs live.
 *
 * The providers are OpenRouter on BOTH halves, and the models are NAMED. They
 * were left unnamed until now, which resolved to the free pools in
 * `openrouter.js` — and the reasoning behind that shape has not gone away, it
 * has moved to `chat.models`: a 429 on a shared free tier is a statement about
 * other people's traffic rather than about the model, so a list tried in order
 * still beats any single id. What changed is only WHERE the list is written, and
 * that the embed half now states the one model this site's index was built with
 * instead of recording it after the fact. The two blocks below carry the rest.
 *
 * OpenRouter serves `/v1/embeddings` too, so the second provider a docs site
 * usually needs is not needed here — the embed half names the same provider
 * rather than borrowing it through `'auto'`.
 *
 * The key is `OPENROUTER_API_KEY`, read from `.env.local` by `loadEnv` below.
 * It never reaches the page: in dev the plugin's `/ai/*` proxy attaches it
 * server-side, and a production deploy needs the same proxy in front —
 * `npx docpilot doctor --proxy` prints that contract.
 */
export const docPilot = {
  enabled: existsSync(LOCAL_EMBED ? localRagIndex : ragIndex),
  product: 'DocPilot',
  quote: { fromAnswer: true, fromDocs: true },
  citations: { passage: true, inCopy: true, pagesRead: true },
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
        /**
         * THE POOL, WRITTEN DOWN. This is the list `chatModels(docPilot)`
         * returned while the half was unnamed, copied rather than imported
         * because `openrouter.js` is not on the package's `exports` map — and
         * copied on purpose besides, since a deployment that wants to drop a
         * model or reorder them should be able to do it in the file it already
         * edits.
         *
         * `chat.models` KEEPS the rotation the unnamed form had: it is walked on
         * a 429, a retired id or an empty answer, and the model that answered is
         * tried first next time. The order is `openrouter.js`'s and it is not
         * alphabetical — the final step pins its shape with a strict
         * `response_format: json_schema`, so ids carrying `structured_outputs`
         * lead, `response_format`-only ones follow, and the rest are the tail
         * rotation reaches when nothing better is free. `openrouter/free` stays
         * at the head: it is a router, so it sees the pool closer than this file
         * can, and the explicit ids behind it are what runs when it will not.
         *
         * THE COST OF WRITING IT DOWN, stated because it is the whole trade: this
         * list no longer tracks the shipped pool. When OpenRouter's free lineup
         * moves, `openrouter.js` follows it on the next release and this file
         * does not. That is the point of a pin, and it is also the reason these
         * ids are worth a glance whenever the package is upgraded.
         */
        chat: {
          provider: 'openrouter',
          models: [
            'openai/gpt-4o-mini',
            'nvidia/nemotron-3-ultra-550b-a55b:free',
            'minimax/minimax-m3:free',
            'poolside/laguna-s-2.1:free',
            'nvidia/nemotron-3.5-lightning:free',
            'inclusionai/ling-3.0-flash-fin:free',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'minimax/minimax-m2.7:free',
          ],
          reasoning: false,
        },
        /**
         * ONE id, and a list here would be a mistake rather than a safeguard:
         * the embed half never rotates, because the index and every query have
         * to land in ONE vector space. A second embedder is a second index, not
         * a fallback.
         *
         * This is the model `docs/public/rag` was actually built with —
         * `manifest.embedModel` says so — and naming it is what turns that from
         * a fact about which of the two free embedders answered first that
         * morning into something a rebuild reproduces. The other one,
         * `nvidia/llama-nemotron-embed-vl-1b-v2:free`, is a vision-language
         * model; both are 2048-dimensional, which makes them look
         * interchangeable and is exactly why the width check alone would not
         * catch a swap.
         *
         * If this id and `manifest.embedModel` ever disagree, the panel says so
         * in the console once and drops to lexical-only rather than scoring a
         * query against a foreign space — `embedderMatchesIndex` in
         * `session.js`. Changing this id means rebuilding the index in the same
         * commit.
         */
        embed: {
          provider: 'openrouter',
          models: [
            'nvidia/nemotron-3-embed-1b:free',
            'nvidia/llama-nemotron-embed-vl-1b-v2:free',
            'liquid/lfm-2.5-embedding-350m:free',
          ],
        },
      }),
  /**
   * THE EMPTY STATE, ANSWERED IN ADVANCE — engine-specs/017.
   *
   * The built-in three were generic by necessity (`What is this documentation
   * about?`), and this site has three questions it is actually opened for. Each
   * carries its own answer, so the click that costs the most on any docs site —
   * the first one, made by a reader who has not typed anything — costs no
   * embedding request and no model call.
   *
   * `docs/.vitepress/openers.mjs` holds the prose and the ids it stands on.
   */
  suggestions: { questions: openers },
  ui: { trigger: 'fab' },
}

const ai = defineDocPilot(docPilot, env)

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
      /**
       * Second, not last. "Getting started" is a VitePress quickstart, and the
       * very next link a reader needs is the one that says the panel is not
       * only for VitePress and not only for docs. Buried under Install it
       * arrives after the decision it is supposed to inform.
       */
      { text: 'Where it can go', link: '/guide/where-it-goes' },
      { text: 'Philosophy', link: '/guide/philosophy' },
      { text: 'Why DocPilot', link: '/guide/why' },
      { text: 'How it compares', link: '/guide/comparison' },
    ],
  },
  {
    /**
     * Install is its own group, and it is ordered by BUNDLER rather than by
     * framework — which is the order the decision actually has, however odd it
     * looks in a list. VitePress and Docusaurus come first because they are one
     * import and one plugin; the rest are ordered from most machinery to least.
     */
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

/**
 * `vitepress dev`, reading the package's SOURCE instead of its build.
 *
 * `exports` names `dist/` since 1.0.0, and going through it is the whole point
 * of importing this package by name here — a subpath that stops resolving must
 * fail this site's build rather than someone else's install. But `dist/` is
 * emitted, so under `dev` that same virtue means an edit to `src/` is invisible
 * until something rebuilds, which is not a loop anybody can work in.
 *
 * So: on `serve` only, the theme entry points back at the source. `tsc` and
 * Vite both try `.ts` before `.js` for a `.js` specifier, so the alias needs no
 * maintenance as modules convert. `build` — and therefore `docs:build`,
 * `scripts/vercel-build.sh` and every consumer-shaped check — is untouched and
 * still goes through `exports`, which is where the guarantee was worth having.
 */
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
  vite: { plugins: [ai.plugin(), devSource()] },

  title: 'DocPilot',
  description:
    'A grounded AI assistant for any page of your site — docs, a landing page, a help centre, or an app you already ship. A real chat: scope it, quote a passage, follow up. Retrieval runs in the browser, the gate refuses before the model is called, and every citation is checked.',
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
    // VitePress emits `<meta name="description">` from `description` above but
    // never an og:description — `isDescriptionOverridden` only looks at
    // `name === "description"`. Without this, every shared link renders a card
    // with a title and no body.
    [
      'meta',
      {
        property: 'og:description',
        content:
          'An AI chat that mounts on any page of any site and answers from a static index you build. Retrieval runs in the browser; the gate refuses before the model is called; every citation is checked against what was retrieved.',
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
