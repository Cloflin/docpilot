#!/usr/bin/env node
/**
 * The last thing that runs before a tarball leaves this machine.
 *
 *   node scripts/check-publish.js
 *
 * REPOSITORY-INTERNAL, and deliberately not shipped: `package.json#files` does
 * not list `scripts/` (see the header of `check-docpilot.sh`, which says why for
 * the whole directory). This is a release gate, not a consumer artifact.
 *
 * WHAT IT IS FOR. The package's `exports` map names six files inside `dist/`,
 * and `dist/` is not in git — it is written by `prepare`. Every failure mode
 * that ends with a published, installable, broken package goes through the same
 * shape: `dist/` is absent, stale or truncated while `exports` still points at
 * it, and npm has no opinion about that. `npm publish` exits 0 and the defect
 * surfaces in somebody else's build.
 *
 * WHERE IT IS WIRED, AND WHY THAT ORDER. npm runs `prepublishOnly` → `prepack` →
 * `prepare` → pack. So `prepublishOnly` fires BEFORE the build it is meant to
 * inspect, and a bare check there would grade the PREVIOUS build — green on a
 * `dist/` that is about to be overwritten, or on one left over from a branch.
 * Hence the script does its own build first:
 *
 *   "prepublishOnly": "npm run verify && npm run build && node scripts/check-publish.js"
 *
 * `prepare` then runs a second time on npm's own schedule; it is idempotent, so
 * the cost is seconds and the benefit is that this file always reads artifacts
 * from the build that is being packed.
 *
 * WHAT IT DOES NOT DEFEND AGAINST. `npm publish --ignore-scripts` skips every
 * hook, this one included — nothing in package.json can gate a publish that
 * refuses to run package.json's scripts. The layer that covers that case is in
 * `bin/build-css.js` and `bin/build-web.js`: both refuse to skip a missing
 * `sass`/`vite` when `npm_command` says a release is in progress, so the build
 * itself fails loudly instead of producing an empty `dist/` quietly.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const abs = (rel) => path.join(root, rel)
const pkg = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8'))

const problems = []
const fail = (what, fix) => problems.push(`${what}\n           fix: ${fix}`)

/**
 * Size floors, not existence checks.
 *
 * An existence check passes on a zero-byte file, and a zero-byte file is exactly
 * what a half-written build leaves behind. The numbers are floors under the
 * smallest artifact this repo actually produces, measured at 0.2.0:
 * `dist/docpilot-docusaurus.css` is the smallest stylesheet at 931 bytes — which
 * is why the CSS floor is 500 and not the round 1 KB it looks like it should be
 * — and the two web bundles are 476 KB (ESM) and 1.07 MB (IIFE), so 100 KB is
 * far below a real build and far above a truncated one. They exist to catch
 * "nothing was written", not to police size drift; a floor tight enough to do
 * the second job would fail on every legitimate refactor.
 */
const CSS_FLOOR = 500
const WEB_FLOOR = 100_000
const floorFor = (rel) => {
  if (/\.web\.(mjs|js)$/.test(rel)) return WEB_FLOOR
  if (rel.endsWith('.css')) return CSS_FLOOR
  return 1
}

/** Every leaf of the exports map — condition objects included, as in packaging.test.js. */
const leaves = []
const walk = (node, name) => {
  if (typeof node === 'string') leaves.push([name, node])
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walk(value, `${name} (${key})`)
  }
}
for (const [subpath, node] of Object.entries(pkg.exports)) walk(node, subpath)

const checkArtifact = (rel, named) => {
  let size
  try {
    size = fs.statSync(abs(rel)).size
  } catch {
    fail(`${rel} does not exist — ${named} resolves to nothing`, 'npm run build')
    return
  }
  const floor = floorFor(rel)
  if (size < floor) {
    fail(`${rel} is ${size} bytes, under the ${floor}-byte floor — the build was truncated`, 'npm run build')
  }
}

/**
 * A wildcard subpath names a PATTERN, so there is no single file to stat. It
 * became checkable here at 0.6.0, when `./theme/components/*.vue` moved from
 * `src/` — which this loop skips — into the emitted tree. Expanded rather than
 * skipped, because an empty `dist/theme/components/` is precisely the shape of
 * failure this file exists to stop: every subpath still resolves, `npm publish`
 * is green, and the theme imports five components that are not there.
 */
const expand = (rel) => {
  const [dir, tail] = rel.split('*')
  let entries = []
  try {
    entries = fs.readdirSync(abs(dir))
  } catch {
    return null
  }
  return entries.filter((e) => e.endsWith(tail)).map((e) => `${dir}${e}`)
}

for (const [name, target] of leaves) {
  if (!target.startsWith('./dist/')) continue
  const rel = target.slice(2)
  if (!rel.includes('*')) {
    checkArtifact(rel, `exports["${name}"]`)
    continue
  }
  const matches = expand(rel)
  if (!matches?.length) {
    fail(`${rel} matches no file — exports["${name}"] resolves to nothing`, 'npm run build')
    continue
  }
  for (const match of matches) checkArtifact(match, `exports["${name}"]`)
}

/**
 * The IIFE bundle is checked even though no `exports` subpath names it: the
 * `<script>` tag install has no subpath to go through — the reader points a tag
 * at `dist/docpilot.web.js` inside the tarball — so it is the one shipped entry
 * point the loop above cannot see.
 */
checkArtifact('dist/docpilot.web.js', 'the <script> tag install')

/**
 * `dist/web/` is the ESM build's code-split grammars, referenced by hashed name
 * from inside `docpilot.web.mjs`. A present-but-empty directory is a bundle
 * whose dynamic imports 404 at runtime, and nothing else in this file would see
 * it: the entry point itself is full-size and passes every check above.
 */
let chunks = []
try {
  chunks = fs.readdirSync(abs('dist/web'))
} catch {
  /* reported below as empty */
}
if (!chunks.length) {
  fail('dist/web/ is empty — the code-split chunks docpilot.web.mjs imports are missing', 'npm run build')
}

/**
 * A scoped package with no `access` defaults to `restricted`, and a restricted
 * publish on a free npm account is rejected with `E402 Payment Required` after
 * the whole tarball has been uploaded. Cheap to assert, and the error npm gives
 * names payment rather than configuration.
 */
if (pkg.publishConfig?.access !== 'public') {
  fail(
    `package.json publishConfig.access is ${JSON.stringify(pkg.publishConfig?.access)} — a scoped package publishes restricted without it (E402)`,
    'set "publishConfig": { "access": "public" } in package.json',
  )
}

/**
 * The version and the changelog have to agree, because the changelog is the only
 * record of what a version contains and npm will happily publish a version no
 * entry describes. Matched against the FIRST `## x.y.z` heading — Keep a
 * Changelog puts the newest release at the top, so the first heading is the one
 * being released.
 */
let changelog
try {
  changelog = fs.readFileSync(abs('CHANGELOG.md'), 'utf8')
} catch {
  fail('CHANGELOG.md does not exist', 'write CHANGELOG.md with a `## x.y.z — YYYY-MM-DD` heading for this release')
}
if (changelog) {
  const top = changelog.match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1]
  if (!top) {
    fail(
      'CHANGELOG.md has no `## x.y.z` heading',
      `add a heading of the form "## ${pkg.version} — YYYY-MM-DD" to CHANGELOG.md`,
    )
  } else if (top !== pkg.version) {
    fail(
      `CHANGELOG.md leads with ${top} but package.json says ${pkg.version}`,
      `add a "## ${pkg.version} — YYYY-MM-DD" section to CHANGELOG.md, or correct the version in package.json`,
    )
  }
}

if (problems.length) {
  for (const p of problems) console.error(`[docpilot] ${p}`)
  console.error(`[docpilot] ${problems.length} problem(s) — refusing to publish`)
  process.exit(1)
}

console.log(`[docpilot] publish check ok — ${pkg.name}@${pkg.version}`)
