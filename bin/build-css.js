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
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = path.join(root, 'src/theme/styles/ask-ai.scss')
const outDir = path.join(root, 'dist')
const out = path.join(outDir, 'ask-ai.css')

let sass
try {
  sass = await import('sass')
} catch {
  // A consumer installing from the registry gets `dist/` in the tarball and
  // never reaches this file; `prepare` still runs for them, so it has to be a
  // no-op rather than a failed install.
  console.log('[ask-ai] sass not installed — skipping the stylesheet build (this is normal for a consumer install)')
  process.exit(0)
}

const { css } = sass.compile(src, { style: 'compressed', silenceDeprecations: ['legacy-js-api'] })
mkdirSync(outDir, { recursive: true })
writeFileSync(out, css)
console.log(`[ask-ai] dist/ask-ai.css  ${(css.length / 1024).toFixed(1)} KB`)
