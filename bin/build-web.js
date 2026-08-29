#!/usr/bin/env node
/**
 * The self-contained build — the panel for a host that cannot compile a `.vue`
 * file.
 *
 * That is the real dividing line in this package's install matrix, and it is not
 * the one people expect. `@cloflin/docpilot/mount` ships source, so it works
 * wherever the bundler has the Vue SFC plugin: Vite, Rollup, Nuxt, most Astro
 * setups. Webpack hosts — Docusaurus, Create React App, Next — have no `.vue`
 * loader and exclude `node_modules` from Babel besides, so for them the package
 * has to arrive already compiled. So do blogs with no bundler at all.
 *
 * TWO FORMATS FROM ONE ENTRY:
 *
 *   dist/docpilot.web.mjs   ESM, imported by /react, /docusaurus and /web
 *   dist/docpilot.web.js    IIFE, `window.DocPilot`, for a <script> tag
 *   dist/docpilot.web.css   the core stylesheet, extracted
 *
 * VUE AND SHIKI ARE BUNDLED IN. Neither is a dependency the hosts above have —
 * a Docusaurus site has React, and a blog has nothing — so "external" would mean
 * an unresolvable bare specifier at runtime. IIFE cannot code-split, so it is
 * all or nothing; the panel is still loaded lazily by whoever includes it, and a
 * reader who never opens it pays for the download and no more.
 *
 * WHY VITE AND NOT ESBUILD. The entry imports single-file components, and
 * esbuild has no official Vue plugin — the community ones are unmaintained and
 * lag `@vue/compiler-sfc`, which is not a dependency to put under a published
 * artifact. Vite's library mode gives both formats, CSS extraction, minification
 * and the `process.env.NODE_ENV` define that Vue requires, from one config.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(root, 'dist')

/**
 * Resolved before anything is written, and skipped the way `build-css.js` skips
 * a missing `sass` — for the same reason and with the same narrow test.
 *
 * ONLY a missing module is a skip. This runs from `prepare`, so a broken or
 * incompatible install — anything that throws on import rather than failing to
 * resolve — must not print "not installed", exit 0, and let `npm publish` build
 * a tarball whose `dist/docpilot.web.*` is stale or absent while `exports`
 * points at it.
 */
let build
let vue
try {
  ;({ build } = await import('vite'))
  vue = (await import('@vitejs/plugin-vue')).default
} catch (err) {
  const missing =
    err?.code === 'ERR_MODULE_NOT_FOUND' &&
    /['"](vite|@vitejs\/plugin-vue)['"]/.test(String(err?.message || ''))
  // A RELEASE MAY NOT SKIP — the same gate `build-css.js` carries, for the
  // failure that is worse here. `prepare` runs again during `npm publish` and
  // `npm pack`; on a machine where `vite` cannot resolve, the skip below would
  // exit 0 and publish a tarball with no `dist/docpilot.web.*`, which is what
  // `./web`, `./react` and `./docusaurus` all resolve to. Those three hosts
  // have no other entry point, so the package would install and then fail to
  // import. `npm_command` is what separates a release from a contributor's
  // install; it is set by npm and by nothing else here.
  const releasing = process.env.npm_command === 'publish' || process.env.npm_command === 'pack'
  // One line before Node's stack trace: the trace names a specifier, not the
  // reason a release stopped.
  if (missing && releasing) {
    console.error(
      `[docpilot] vite is missing and npm_command=${process.env.npm_command} — refusing to build a release without dist/docpilot.web.*  (fix: npm install)`,
    )
  }
  if (!missing || releasing) throw err
  // Not a consumer path: `prepare` runs for local-directory and git installs
  // and before pack/publish, never for an install from the registry — that one
  // unpacks `dist/` from the tarball and never reaches this file.
  console.log(
    '[docpilot] vite not installed — skipping the self-contained build (this is normal for a contributor install without devDependencies)',
  )
  process.exit(0)
}

/**
 * `@layer docpilot` — and ONLY on this artifact.
 *
 * The four stylesheets `build-css.js` writes go to hosts that opted into a
 * framework — VitePress, Docusaurus — whose own CSS the panel is mapped onto.
 * This one goes to a `<script>` tag on a site nobody here has seen, and that is
 * the case a cascade layer is for: everything below is declared in `docpilot`,
 * so the site's own rules win over the panel's without a specificity fight and
 * without `!important` (this package writes none — see core.scss rule 1).
 *
 * THE TRADE IS REAL AND IT POINTS THE OTHER WAY TOO. An unlayered rule beats
 * every layered one whatever its specificity, so a host reset now outranks the
 * panel. The two that bite in practice: Tailwind v3's preflight sets
 * `border: 0 solid` on `*`, which erases the hairline the design system is
 * built on, and a bare `a`/`button`/`ul` rule repaints the answer body. A site
 * that hits either restores it by declaring the same properties itself — which
 * is exactly the control the layer exists to hand over.
 *
 * Written here rather than over the file afterwards so the size this script
 * reports is the size that ships.
 */
const LAYER_OPEN = '@layer docpilot{'

const cssLayer = {
  name: 'docpilot:css-layer',
  // `vite:css-post` is the plugin that emits the stylesheet, and it sits after
  // the normal plugins in Vite's pipeline — a plugin without this runs its
  // `generateBundle` before the asset it means to rewrite exists, finds
  // nothing, and silently ships an unlayered file.
  enforce: 'post',
  generateBundle: { order: 'post', handler: wrapCssAssets },
}

function wrapCssAssets(_options, bundle) {
  for (const asset of Object.values(bundle)) {
    if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue
    const css = String(asset.source)
    // Two formats come out of one rollup build and each output bundle carries
    // its own entry for the same emitted stylesheet — which may be the same
    // object seen twice. Wrapping it twice nests `docpilot` inside itself and
    // still parses, so nothing would fail; it would just be wrong.
    if (css.startsWith(LAYER_OPEN)) continue
    // `@charset` is the one rule that may not move inside the block, and the
    // minifier emits it the moment a declaration carries a non-ASCII byte —
    // a `content: "→"` added to a component a year from now. Lift it back
    // out rather than produce a stylesheet whose first rule is ignored.
    const charset = css.match(/^@charset\s+[^;]+;/)
    const body = charset ? css.slice(charset[0].length) : css
    // `@import` inside a layer block is invalid and drops silently. Vite
    // inlines every import in library mode, so reaching this is a change in
    // how the bundle is built, not a stylesheet someone wrote — fail loudly.
    if (/^\s*@import\b/.test(body)) {
      this.error(`${asset.fileName} starts with @import — it cannot be wrapped in @layer`)
    }
    asset.source = `${charset ? charset[0] : ''}${LAYER_OPEN}${body}}`
  }
}

mkdirSync(outDir, { recursive: true })

const output = await build({
  // The repo has no vite config and must not acquire one by accident: this
  // build is a library, and a config written for the documentation site would
  // apply its base, its aliases and its plugins to the published artifact.
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [vue(), cssLayer],
  define: {
    // Vue reads it at module scope and ships its whole dev-warning apparatus
    // without it. Not `import.meta.env` — this artifact runs in hosts that
    // never see a Vite transform.
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    outDir,
    // `build-css.js` has already written three files here.
    emptyOutDir: false,
    cssCodeSplit: false,
    /**
     * No source maps, and the trade is explicit: they came to 4.5 MB against a
     * 1.5 MB artifact, inside a tarball that `files` publishes whole. The source
     * ships anyway — `src/` is in `files[]` — so anyone who needs to step
     * through this code can install `@cloflin/docpilot/mount` and get the
     * unbundled original, which is a better debugging experience than a map
     * over minified output.
     */
    sourcemap: false,
    lib: {
      entry: path.join(root, 'src/web.js'),
      name: 'DocPilot',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'docpilot.web.mjs' : 'docpilot.web.js'),
      cssFileName: 'docpilot.web',
    },
    rollupOptions: {
      // Deliberately empty. See the header: every host this artifact exists for
      // is one that does not have Vue.
      external: [],
      output: {
        // The ESM build code-splits — one chunk per grammar, so a reader who
        // never sees a shell snippet never downloads the shell grammar. They go
        // in a subdirectory because `dist/` also holds four stylesheets and two
        // entry points, and a dozen hashed siblings beside them make it
        // impossible to see at a glance what this package publishes.
        chunkFileNames: 'web/[name]-[hash].js',
      },
    },
  },
})

/**
 * An empty or missing output is the failure a bundler invites — a plugin that
 * silently produced nothing, an entry that tree-shook to a comment — and it
 * would ship as a package whose `exports` point at a file that does nothing.
 * The same check `build-css.js` makes, for the same reason.
 */
const bundles = [].concat(output).flatMap((o) => o.output || [])
const written = new Map()
for (const chunk of bundles) {
  const size = (chunk.code ?? chunk.source ?? '').length
  if (chunk.fileName.endsWith('.map')) continue
  written.set(chunk.fileName, Math.max(written.get(chunk.fileName) || 0, size))
}

const REQUIRED = ['docpilot.web.mjs', 'docpilot.web.js', 'docpilot.web.css']
for (const name of REQUIRED) {
  const size = written.get(name)
  if (!size) {
    console.error(`[docpilot] ${name} was not produced — refusing to ship a broken bundle`)
    process.exit(1)
  }
  console.log(`[docpilot] dist/${name}  ${(size / 1024).toFixed(1)} KB`)
}
