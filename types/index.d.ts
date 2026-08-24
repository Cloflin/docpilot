/**
 * `@cloflin/docpilot` — the build half.
 *
 * One call, `defineDocPilot()`, and everything else hangs off what it returns.
 */
import type { DocPilotSettings, DocPilotThemeConfig, Readiness, ProviderId } from './config.js'

export * from './config.js'

/** Whatever the host's bundler calls a plugin. Vite's shape, structurally. */
export interface DocPilotVitePlugin {
  name: string
  config(): Record<string, unknown>
  configResolved(): void
}

export interface DocPilotResult {
  /** The settings after defaults, exactly as every view below sees them. */
  settings: Required<DocPilotSettings>
  readiness: Readiness
  /**
   * Safe to compile into the client bundle: no key, no upstream host.
   * `{enabled: false}` when readiness failed, which is the whole of the
   * unconfigured behaviour — the theme mounts nothing and the site builds.
   */
  themeConfig: DocPilotThemeConfig
  /**
   * The embed target as the indexer sees it: real host, key in hand.
   *
   * `embed: false` returns the second arm — every field null, and `lexicalOnly`
   * true beside them. Nulls rather than an omitted object because the caller
   * destructures this without checking, and a `baseURL` there would name
   * somewhere the indexer COULD post when the point of the mode is that there
   * is nothing it should.
   */
  nodeEmbedTarget():
    | {
        lexicalOnly?: undefined
        id: ProviderId
        provider: ProviderId
        baseURL: string | null
        model: string | null
        models: string[] | null
        apiKey: string | null
      }
    | {
        lexicalOnly: true
        id: null
        provider: null
        baseURL: null
        model: null
        models: null
        apiKey: null
      }
  plugin(): DocPilotVitePlugin
}

export declare function defineDocPilot(
  settings?: DocPilotSettings,
  env?: Record<string, string | undefined>,
): DocPilotResult

export declare function docPilotPlugin(
  settings: Required<DocPilotSettings>,
  ready: Readiness,
  env?: Record<string, string | undefined>,
): DocPilotVitePlugin
