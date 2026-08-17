#!/usr/bin/env node
/**
 * The one build step, and the reason there is one.
 *
 * Everything else in this package ships as source: plain ESM the consumer's
 * Vite already handles, and `.vue` files, which are a documented thing to ship
 * unbundled (`vitepress-plugin-llms` does exactly that). Stylesheets are the
 * exception. The panel's styles are SCSS, and a consumer only gets SCSS
 * compiled if `sass` is installed in THEIR project — so shipping the `.scss`
 * would make a peer dependency out of a build tool they have no other reason
 * to want, and the failure when it is absent is a stack trace from inside
 * node_modules.
 *
 * So `sass` stays a devDependency here and the published tarball carries CSS.
 * `prepare` runs this on `npm install` in a clone and again before publish, so
 * neither a contributor nor a consumer ever has to know it happened.
 *
 * THREE OUTPUTS, not one. The bundle is what almost everyone wants and what
 * `"./style.css"` still points at. The other two exist for the two cases the
 * bundle cannot serve: a host that is not VitePress (core alone), and a host
 * that wants the panel's own styling replaced wholesale but the VitePress
 * mapping kept (adapter alone, over their own core).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(root, 'dist')

const ENTRIES = [
  ['src/theme/styles/docpilot.scss', 'docpilot.css'],
  ['src/theme/styles/core.scss', 'docpilot-core.css'],
  ['src/theme/styles/vitepress.scss', 'docpilot-vitepress.css'],
]

let sass
try {
  sass = await import('sass')
} catch (err) {
  // ONLY a missing module is a skip. This is the `prepare` script, so a broken
  // or incompatible sass install — anything that throws on import rather than
  // failing to resolve — would otherwise print "not installed", exit 0, and let
  // `npm publish` build a tarball whose `dist/*.css` is stale or absent while
  // `exports` still points at it. The publish succeeds and the package is broken.
  const missing =
    err?.code === 'ERR_MODULE_NOT_FOUND' && /['"]sass['"]/.test(String(err?.message || ''))
  if (!missing) throw err
  // A consumer installing from the registry gets `dist/` in the tarball and
  // never reaches this file; `prepare` still runs for them, so it has to be a
  // no-op rather than a failed install.
  console.log('[docpilot] sass not installed — skipping the stylesheet build (this is normal for a consumer install)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })

for (const [from, to] of ENTRIES) {
  const { css } = sass.compile(path.join(root, from), {
    style: 'compressed',
    silenceDeprecations: ['legacy-js-api'],
  })
  // An empty output is the failure mode a split invites: a renamed partial, a
  // `@use` that resolves to nothing, and the build still "succeeds" — with a
  // stylesheet that silently ships no rules. Fail here instead of in a release.
  if (!css.trim()) {
    console.error(`[docpilot] ${from} compiled to an empty stylesheet — refusing to write ${to}`)
    process.exit(1)
  }
  writeFileSync(path.join(outDir, to), css)
  console.log(`[docpilot] dist/${to}  ${(css.length / 1024).toFixed(1)} KB`)
}
