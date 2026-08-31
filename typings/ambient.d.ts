/**
 * Repository-internal ambient declarations. NOT SHIPPED.
 *
 * `package.json#files` does not list this directory, deliberately: a
 * `declare module '*.vue'` inside a published package overrides the consumer's
 * own — theirs is the one that knows their components' props, and this one
 * knows nothing about anything. It exists so that `tsc` can read a tree that
 * imports components and stylesheets, and so that the handful of globals this
 * package reads and writes are named once, in a file, rather than cast away at
 * each site.
 *
 * `types/` is the opposite of this file in every respect: hand-written, shipped,
 * and the package's documented public surface.
 *
 * The `declare global` block is not decoration. This file has an `export {}` at
 * the foot, so it is a MODULE, and inside a module a bare `interface Window`
 * declares a local interface that augments nothing — the errors it was written
 * to close stay exactly where they were.
 */

/**
 * The five components, as far as `tsc` is concerned.
 *
 * `vue-tsc` cannot run here — `typescript@7` is the native compiler and exposes
 * no JavaScript API, while `vue-tsc` resolves its compiler through
 * `require.resolve('typescript/lib/tsc')`, which that package no longer
 * exports. So the `<script setup>` blocks are checked by the editor's Vue
 * Language Tools, which is where they were checked before this migration too,
 * and `tsc` sees an opaque component. `types/components.d.ts` is the version of
 * this a consumer gets, and it is deliberately loose for its own reasons.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

/** Bare stylesheet imports — the side effect `sideEffects` protects. */
declare module '*.css' {}
declare module '*.scss' {}

declare global {
  /**
   * `import.meta.env` — read by `host-vitepress.ts` and `session.js` under the
   * bundler, absent under Node. Optional on purpose: this package's Node half
   * runs in a plain `node` process where `import.meta.env` does not exist, so a
   * non-optional declaration would be a lie in exactly the place it is checked.
   */
  interface ImportMetaEnv {
    readonly DEV?: boolean
    readonly PROD?: boolean
    readonly BASE_URL?: string
  }

  interface ImportMeta {
    readonly env?: ImportMetaEnv
  }

  /** Non-standard, and asked for behind a guard — `session.js`'s prefetch budget. */
  interface Navigator {
    connection?: {
      saveData?: boolean
      effectiveType?: string
    }
  }

  interface Window {
    /**
     * The hand-authored global every non-VitePress host sets — the Docusaurus
     * adapter writes it into an inline `<script>`, and `mount.js` documents it
     * as the shape a plain `<script>` tag hands in.
     */
    __DOCPILOT__?: import('../types/config.js').DocPilotThemeConfig & {
      base?: string
      ragBase?: string
      highlighter?: unknown
      selectors?: Record<string, string>
    }
    /** The feedback console helper, installed by `session.js` for a human. */
    __docPilot?: Record<string, (...args: never[]) => unknown>
  }

  /** The CLI's two hand-offs to `cli-context.js`, set by `bin/docpilot.js`. */
  var __DOCPILOT_SETTINGS__: import('../types/config.js').ResolvedDocPilot | undefined
  var __DOCPILOT_CONFIG__: string | undefined

  /** Two highlighters a host may have loaded from a `<script>` tag. */
  var Prism: unknown
  var hljs: unknown
}

/**
 * `app.config.globalProperties.$docPilot`, set by the Vue adapter's `install`.
 * Without this augmentation the assignment is an error and every template that
 * reads `$docPilot` is untyped.
 */
declare module 'vue' {
  interface ComponentCustomProperties {
    $docPilot: import('../types/host.js').HostBinding
  }
}

export {}
