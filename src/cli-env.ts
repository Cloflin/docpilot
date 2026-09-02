/**
 * `.env` and `.env.local`, read the way the VitePress build reads them, and the
 * one law about who wins.
 *
 * WHY IT IS A MODULE OF ITS OWN. This function used to live in
 * `src/cli-context.ts`, which resolves `settings` at MODULE SCOPE out of
 * `globalThis.__DOCPILOT_SETTINGS__` — a global the launcher writes AFTER it
 * has loaded the config. Importing that file for this one function would run
 * that resolution early, against an empty config, and cache the result: every
 * path in the package would then point at the shipped defaults rather than at
 * the project's own. `cli-context.ts:22` exists to explain that ordering; this
 * file exists so nothing has to break it.
 *
 * THE LAW: THE EXISTING ENVIRONMENT WINS. It was already written down —
 * `cli-context.ts:73`, "The existing environment wins at every call site" — and
 * followed by three of the seven readers. `bin/docpilot.js` inverted it with
 * `{ ...process.env, ...loadEnv(…) }`, and so did `vocabulary.ts`; a fourth put
 * the file into a private object that never reached `process.env`; and `bench`
 * and `lint` did not read the file at all, while the CLI's own help told
 * readers to put their key in it.
 *
 * 12-factor CLI is where the law comes from, and the case it protects is the
 * ordinary one: a checked-in `.env` naming a shared endpoint, and a one-off
 * `OPENROUTER_API_KEY=… npx docpilot eval` that has to beat it.
 */

/**
 * The file's contents, or `{}` when VitePress is not installed at all.
 *
 * Every command used to import `loadEnv` from `vitepress` at module scope,
 * which made a hard dependency out of a convenience: the indexer, the
 * calibrator and the eval runner all died on a resolution error in a project
 * whose docs are not a VitePress site, before printing anything about what they
 * were being asked to do. The corpus is markdown either way.
 */
export async function fileEnv(root = process.cwd()) {
  try {
    const { loadEnv } = await import('vitepress')
    return loadEnv('', root, '')
  } catch {
    return {}
  }
}

/**
 * Apply it, once, filling only what is not already set.
 *
 * The launcher calls this before it dispatches, so `bench` and `lint` — which
 * never read the file — see the key without a line changing in either of them,
 * and the five modules that each carried their own copy of this loop can stop.
 *
 * @returns the names of the keys it added, so a caller can say what it did.
 */
export async function applyFileEnv(env = process.env, root = process.cwd()) {
  const added = []
  for (const [k, v] of Object.entries(await fileEnv(root))) {
    if (env[k] === undefined) {
      env[k] = v
      added.push(k)
    }
  }
  return added
}
