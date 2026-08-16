/**
 * The package entry — one call, `defineDocPilot()`, and everything else hangs off
 * what it returns.
 *
 * The alternative shape, three exported functions the host calls in three
 * places, is what this was extracted from, and it had a defect that took a week
 * to find: `themeDocPilot()` silently omitted `suggestions`, so a documented,
 * component-read setting could never reach the client and nothing said so.
 * Resolution happening once, in one object, is what makes that class of bug
 * impossible rather than merely unlikely.
 */

import {
  resolveDocPilot,
  readiness,
  themeDocPilot,
  nodeEmbedTarget,
  devProxy,
  logDocPilot,
} from './config.js'

export {
  PROVIDER_IDS,
  providerKey,
  nodeEmbedTarget,
  resolveEmbed,
  resolveDocPilot,
  resolveSuggestions,
  readiness,
  themeDocPilot,
  devProxy,
  logDocPilot,
} from './config.js'

/** The package's own name, used for the SSR externalisation fix below. */
const PKG = '@cloflin/docpilot'

/**
 * Resolve settings once and hand back the three views a VitePress config needs.
 *
 * ```js
 * import { defineConfig } from 'vitepress'
 * import { defineDocPilot } from '@cloflin/docpilot'
 *
 * const ai = defineDocPilot({
 *   chat:  { provider: 'openai', model: 'gpt-4o' },
 *   embed: { provider: 'ollama', model: 'bge-m3', baseURL: 'http://localhost:11434' },
 * })
 *
 * export default defineConfig({
 *   vite: { plugins: [ai.plugin()] },
 *   themeConfig: { docPilot: ai.themeConfig },
 * })
 * ```
 *
 * `env` defaults to `process.env`. A project that wants `.env.local` read the
 * way Vite reads it passes `loadEnv('', process.cwd(), '')` instead — the
 * package never calls `loadEnv` itself, because doing so would make the plugin
 * decide which env files a project has.
 */
export function defineDocPilot(settings = {}, env = process.env) {
  const resolved = resolveDocPilot(settings, env)
  const ready = readiness(resolved, env)

  return {
    /** The settings after defaults, exactly as every view below sees them. */
    settings: resolved,

    /** `{ ok, missing, notes, hint }` — see readiness() in config.js. */
    readiness: ready,

    /**
     * Safe to compile into the client bundle: no key, no upstream host.
     *
     * `{ enabled: false }` when readiness failed, and that is the whole of the
     * unconfigured behaviour — the theme mounts nothing and the site builds.
     */
    themeConfig: ready.ok ? themeDocPilot(resolved, env) : { enabled: false },

    /** The embed target as the indexer sees it: real host, key in hand. */
    nodeEmbedTarget: () => nodeEmbedTarget(resolved, env),

    /** The Vite plugin. See docPilotPlugin below for what it actually does. */
    plugin: () => docPilotPlugin(resolved, ready, env),
  }
}

/**
 * The Vite plugin — three jobs, none optional, all of them things the host
 * would otherwise have to know about.
 *
 * 1. **SSR externalisation.** This package ships `.vue` and unbundled ESM. Vite
 *    externalises node_modules during SSR by default, so Node would be handed a
 *    single-file component to `import` and the build would fail on the first
 *    `<template>`. `ssr.noExternal` is the documented fix, and the plugin
 *    applying it to itself is the difference between a package that installs
 *    and one that installs plus a paragraph of instructions.
 *
 * 2. **The dev proxy.** The key is attached in Node and never reaches the page.
 *    Without it every reader's browser would need a credential of its own.
 *    Skipped when unconfigured: a proxy to nowhere turns a clear startup
 *    warning into an opaque 502 at the first question.
 *
 * 3. **Saying what was resolved, once, at startup.** Every way the chat model,
 *    the embedder, the index and the key can disagree is otherwise silent until
 *    a reader hits it.
 */
export function docPilotPlugin(settings, ready, env = process.env) {
  return {
    name: '@cloflin/docpilot',
    // `config`, not `configResolved`: the proxy and noExternal have to be
    // merged before Vite finalises, and a mutation afterwards is ignored.
    config() {
      const out = { ssr: { noExternal: [PKG] } }
      if (ready.ok) out.server = { proxy: devProxy(settings, env) }
      return out
    },
    configResolved() {
      logDocPilot(settings, env, ready)
    },
  }
}
