/**
 * The vite `build()` options for the self-contained bundle — ONE definition.
 *
 * `build-web.js` is a top-level-await program: it builds the moment it is
 * imported, so its options cannot be imported from it. The bundle report
 * (`scripts/bundle-report.mjs`) has to measure the artefact that is PUBLISHED,
 * and a copy of the options would drift the first time somebody changed the
 * define, the plugin list or the chunk naming. So the options live here and
 * both programs call this function; the publish build passes the defaults and
 * the report passes `write: false, sourcemap: true`.
 *
 * THE `vue` PLUGIN FACTORY IS PASSED IN. This module imports nothing optional:
 * `build-web.js` owns the "only a missing module is a skip" guard around the
 * `vite` and `@vitejs/plugin-vue` imports, and that stays the one place that
 * handles a contributor install without devDependencies.
 *
 * Nothing here changes a byte of `dist/docpilot.web.*`: the extraction is
 * proven by the sha256 of the IIFE before and after (see 01-03-SUMMARY).
 */
import path from 'node:path'

/**
 * @param {object} opts
 * @param {string} opts.root      repository root
 * @param {string} opts.outDir    where a written build lands (ignored by `write: false`)
 * @param {Function} opts.vue     the `@vitejs/plugin-vue` default export
 * @param {string[]} [opts.formats]   library formats; the publish build makes both
 * @param {boolean} [opts.write]      false keeps the output in memory
 * @param {boolean} [opts.sourcemap]  the publish build ships none (see below)
 */
export function webBuildOptions({
  root,
  outDir,
  vue,
  formats = ['es', 'iife'],
  write = true,
  sourcemap = false,
}) {
  return {
    // The repo has no vite config and must not acquire one by accident: this
    // build is a library, and a config written for the documentation site would
    // apply its base, its aliases and its plugins to the published artifact.
    configFile: false,
    root,
    logLevel: 'warn',
    plugins: [vue()],
    define: {
      // Vue reads it at module scope and ships its whole dev-warning apparatus
      // without it. Not `import.meta.env` — this artifact runs in hosts that
      // never see a Vite transform.
      'process.env.NODE_ENV': '"production"',
    },
    build: {
      outDir,
      write,
      // `build-css.js` has already written three files here.
      emptyOutDir: false,
      cssCodeSplit: false,
      /**
       * No source maps in the PUBLISHED build, and the trade is explicit: they
       * came to 4.5 MB against a 1.5 MB artifact, inside a tarball that `files`
       * publishes whole. The source ships anyway — `src/` is in `files[]` — so
       * anyone who needs to step through this code can install
       * `@cloflin/docpilot/mount` and get the unbundled original, which is a
       * better debugging experience than a map over minified output. The bundle
       * report turns them on, in memory, because attribution needs them.
       */
      sourcemap,
      lib: {
        entry: path.join(root, 'src/web.ts'),
        name: 'DocPilot',
        formats,
        fileName: (format) => (format === 'es' ? 'docpilot.web.mjs' : 'docpilot.web.js'),
        cssFileName: 'docpilot.web',
      },
      rollupOptions: {
        // Deliberately empty. See the header of build-web.js: every host this
        // artifact exists for is one that does not have Vue.
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
  }
}
