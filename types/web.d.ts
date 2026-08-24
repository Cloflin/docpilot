/**
 * `@cloflin/docpilot/web` — the prebuilt bundle: same API as `/mount`, already
 * compiled, with Vue and Shiki inside.
 *
 * For a host whose bundler cannot compile a `.vue` file — webpack, Turbopack,
 * or no bundler at all. `mountDocPilot` here installs Shiki unless `highlighter`
 * says otherwise, because a `<script>` tag on a blog has nowhere to put a setup
 * call.
 */
export * from './mount.js'
export { createShikiHighlighter } from './shiki.js'
