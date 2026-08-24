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

import './theme/styles/core.scss'
import { createShikiHighlighter } from './theme/docpilot/highlighters/shiki.js'
import { mountDocPilot as mount } from './mount.js'

export function mountDocPilot(options = {}) {
  return mount({
    // Spread AFTER the default, so `highlighter: false` and any adapter of the
    // caller's own both win. `false` is falsy and `mount` installs nothing.
    highlighter: createShikiHighlighter(),
    ...options,
  })
}

export { createShikiHighlighter }
export { DocPilot, DocPilotTrigger, DocPilotIcons, DocPilotQuote } from './mount.js'
export { setHighlighter, getHighlighter } from './theme/docpilot/highlight.js'
export { setHost, useHost, createStandaloneHost, HOST_KEY, routeOf } from './theme/docpilot/host.js'
