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

// Node 22+ ships a global `localStorage` that shadows happy-dom's in the mount
// suite. The flag that turns it off does not exist on Node 20, where putting it
// in NODE_OPTIONS stops node before a test runs — so it is passed to the test
// workers only where this node knows it.
const WEBSTORAGE_OFF = '--no-experimental-webstorage'

export default {
  plugins: [vue()],
  test: {
    environment: 'node',
    // A git worktree Claude Code (or anybody) keeps under `.claude/worktrees/`
    // is a second checkout of this repository INSIDE it, and the default glob
    // ran its test suite too: every file twice, and a half-finished branch's
    // failures reported as this one's.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/dist/**'],
    execArgv: process.allowedNodeEnvironmentFlags.has(WEBSTORAGE_OFF) ? [WEBSTORAGE_OFF] : [],
  },
}
