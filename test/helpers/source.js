/**
 * Reading a source file as TEXT, without naming its extension.
 *
 * A large part of this suite asserts over source rather than over behaviour —
 * that a listener is passive, that a selector is asked for rather than known,
 * that the panel imports the binding instead of the store. Those assertions are
 * the reason several rules in `ui-specs/` can be checked at all, and they are
 * worth keeping. What they must NOT be is a reason the tree cannot move.
 *
 * `src/` is migrating from JavaScript to TypeScript one layer at a time, so for
 * the length of that migration every one of those reads has to work whether the
 * file it names is still `.js` or already `.ts`. The path stays spelled `.js` at
 * the call site — the same spelling the imports use, for the same reason: a
 * `.js` specifier is what TypeScript's own NodeNext resolution expects, and both
 * tsc and Vite try `.ts` before `.js` when they see one. This helper is the text
 * half of that convention.
 *
 * Every path here is repo-relative — `src/theme/docpilot/session.js`, not
 * `../src/...`. The suites used to spell it both ways, once per `describe`.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../../', import.meta.url)

/**
 * Source text by repo-relative path, spelled `.js` whether the file is `.js`
 * or `.ts`. Throws when neither exists, because a silently empty string here
 * turns every `toContain` below it into a passing assertion about nothing.
 */
export function srcText(rel) {
  for (const candidate of [rel, rel.replace(/\.js$/, '.ts')]) {
    try {
      return fs.readFileSync(new URL(candidate, ROOT), 'utf8')
    } catch {
      /* try the next extension */
    }
  }
  throw new Error(`no source at ${rel} (tried .js and .ts)`)
}

/**
 * The path to hand a spawned `node`, for the four tests that run an eval
 * command as a child process.
 *
 * They must run the BUILT file, not the source: `engines.node` is `>= 20`, and
 * Node only strips TypeScript types from 22.18 onward. A child process spawned
 * on `src/eval/tune.ts` would pass on a maintainer's Node 24 and fail on the
 * floor the package promises to support — which is the whole class of failure
 * a test that spawns a real process exists to catch.
 *
 * Falls back to the source when `dist/` has not been built. That is not a
 * loophole: `npm run verify` builds before it tests, so the fallback is only
 * reachable from a bare `vitest run` — and it can only ever hand back a `.js`
 * file, because a `.ts` one would not be there to find.
 */
export function distEntry(rel) {
  const built = new URL(rel.replace(/^src\//, 'dist/'), ROOT)
  if (fs.existsSync(built)) return fileURLToPath(built)
  const source = new URL(rel, ROOT)
  if (fs.existsSync(source)) return fileURLToPath(source)
  throw new Error(`no entry for ${rel} — dist/ is not built and the source is not JavaScript`)
}

/** Is this directory entry a module — in either language, or a component? */
export const isSource = (name) => /\.(js|mjs|ts|vue)$/.test(name)
