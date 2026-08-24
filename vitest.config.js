/**
 * The test runner had no config for as long as nothing under test was a `.vue`
 * file — every suite read source text or exercised a plain ESM module, and Node
 * resolution was enough.
 *
 * `mountDocPilot` is the exception and cannot be anything else: it exists to
 * create a Vue app out of the package's single-file components, so testing that
 * it does means compiling them. Hence one plugin.
 *
 * The environment stays `node`. Only the mount suite needs a DOM, and it asks
 * for one per file with `@vitest-environment happy-dom` — a global browser
 * environment would let a module that quietly depends on `window` pass here and
 * fail during a consumer's SSR pass, which is the failure the guards in
 * `history.js`, `feedback.js` and `scope.js` were all written for.
 */
import vue from '@vitejs/plugin-vue'

export default {
  plugins: [vue()],
  test: {
    environment: 'node',
  },
}
