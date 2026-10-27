/**
 * The entry the self-contained build is made from — never imported directly.
 *
 * Consumers reach the OUTPUT of this file, as `@cloflin/docpilot/web` or as
 * `dist/docpilot.web.js` in a `<script>` tag. It differs from `./mount.js` in
 * exactly two ways, and both are about the artifact rather than the API:
 *
 *   · IT CARRIES THE STYLESHEET. `core.scss` is the panel on real values, with
 *     its own `prefers-color-scheme` dark branch and no host mapping — which is
 *     the right half for a site that has no `--vp-*` or `--ifm-*` to translate
 *     into. The build extracts it to `docpilot.web.css`.
 *
 *   · IT CARRIES SHIKI, chosen and installed here rather than left to the
 *     caller. A `<script>` tag on a blog is the one case with nowhere to put a
 *     setup call, and a drop-in whose code blocks arrive grey is a drop-in
 *     nobody keeps. Passing `highlighter` still overrides it, and `false`
 *     removes it.
 */

// @ts-ignore — a bare stylesheet import; the side effect IS the statement.
import './theme/styles/core.scss'
import { createShikiHighlighter } from './theme/docpilot/highlighters/shiki.js'
import { mountDocPilot as mount } from './mount.js'
import type { MountOptions } from '../types/mount.js'

export function mountDocPilot(options: MountOptions = {}) {
  return mount({
    ...options,
    // `??`, not a spread over the default: a spread copies an explicit
    // `highlighter: undefined` — which the Docusaurus client passed on every
    // page — and that switched Shiki off as surely as `false`. Only `false` and
    // an adapter of the caller's own replace it; `false` is falsy and `mount`
    // installs nothing.
    highlighter: options.highlighter ?? createShikiHighlighter(),
  })
}

export { createShikiHighlighter }
export { DocPilot, DocPilotTrigger, DocPilotIcons, DocPilotQuote } from './mount.js'
export { setHighlighter, getHighlighter } from './theme/docpilot/highlight.js'
// engine-spec 038 — and `window.DocPilot.registerTool` from the IIFE build.
export { registerTool } from './theme/docpilot/tools.js'
export { setHost, useHost, createStandaloneHost, HOST_KEY, routeOf } from './theme/docpilot/host.js'
