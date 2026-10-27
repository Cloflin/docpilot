import { describe, it, expect } from 'vitest'
import { srcText } from './helpers/source.js'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * What the published tarball actually contains.
 *
 * This suite exists because of a real failure with no local symptom: `init`
 * read `../.env.example` from the package root, `files` lists directories, and
 * npm drops dotfiles unless they are named — so the command worked from a clone
 * and died of ENOENT on every install from the registry. Nothing in the repo
 * could tell the difference. These checks can.
 */
const root = new URL('../', import.meta.url)
const abs = (rel) => path.join(root.pathname, rel)
const pkg = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8'))

/** A path is shipped if `files` names it or names a directory above it. */
const shipped = (rel) =>
  pkg.files.some((entry) => {
    const e = entry.replace(/\/$/, '')
    return rel === e || rel.startsWith(`${e}/`)
  })

describe('packaging', () => {
  // `dist/` is built by `prepare`, so it may legitimately be absent — but only
  // WHOLESALE. Twenty-two of the twenty-three subpaths resolve into it since
  // 1.0.0, so a blanket skip on every `dist/` path would leave this test
  // asserting almost nothing about the export map; and a dist/ that exists
  // with a hole in it is exactly the shape `scripts/check-publish.js` was
  // written to catch. Since `npm run verify` builds before it tests, the skip
  // is only reachable from a bare `vitest run` on a tree whose `prepare` has
  // never run.
  const distBuilt = fs.existsSync(abs('dist'))
  const built = (rel) => rel.startsWith('dist/') && !distBuilt

  /**
   * Every stylesheet the package ships is in `@layer docpilot` — ui-specs/017 —
   * and asserted, because the failures are silent. A rule that escapes the layer
   * outranks a site that thought it could override the panel with one class; a
   * layer nested in itself still parses; and a bundle that names `docpilot`
   * before VitePress's reset layer loses every button and list to it.
   *
   * What may sit OUTSIDE the layer is stated per file: nothing at all, the order
   * statement the bundle opens with, or the VitePress adapter's patches on
   * VitePress's own components — rules headed `.VPNavBar…` or
   * `html.docpilot-…`, never one on a DocPilot element alone.
   *
   * Skipped when `dist/` is absent, the way every other check here treats a
   * tree whose `prepare` has not run.
   */
  const LAYER = '@layer docpilot{'
  const ORDER = '@layer __vitepress_base,docpilot;'

  /** The text outside every `@layer docpilot{…}` block, and the blocks' bodies. */
  function splitLayer(css) {
    let outside = ''
    const bodies = []
    let at = 0
    for (let open = css.indexOf(LAYER); open !== -1; open = css.indexOf(LAYER, at)) {
      outside += css.slice(at, open)
      let depth = 1
      let i = open + LAYER.length
      for (; depth && i < css.length; i++) {
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
      }
      bodies.push(css.slice(open + LAYER.length, i - 1))
      at = i
    }
    // Comments are not rules — Vite appends a `/*$vite$:1*/` marker of its own.
    return { outside: (outside + css.slice(at)).replace(/\/\*[\s\S]*?\*\//g, ''), bodies }
  }

  const patchHeads = (css) =>
    [...css.matchAll(/(?:^|[{};])\s*([^{};@][^{};]*)\{/g)].map((m) => m[1].trim())

  it.each([
    ['dist/docpilot.css', 'bundle'],
    ['dist/docpilot-core.css', 'none'],
    ['dist/docpilot-vitepress.css', 'patches'],
    ['dist/docpilot-docusaurus.css', 'none'],
    ['dist/docpilot.web.css', 'none'],
  ])('%s is in @layer docpilot', (file, outsideMay) => {
    if (!fs.existsSync(abs(file))) return
    const css = fs.readFileSync(abs(file), 'utf8').replace(/^(\uFEFF|@charset\s+[^;]+;)/, '')
    const { outside, bodies } = splitLayer(css)
    expect(bodies.length, `${file} has no @layer docpilot block`).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body.includes('@layer'), `${file} nests a layer inside docpilot`).toBe(false)
    }
    if (outsideMay === 'none') {
      expect(outside.trim(), `${file} has rules outside the layer`).toBe('')
      return
    }
    let rest = outside
    if (outsideMay === 'bundle') {
      expect(css.startsWith(ORDER), `${file} does not name the reset layer first`).toBe(true)
      rest = outside.slice(ORDER.length)
    }
    const heads = patchHeads(rest)
    expect(heads.length, `${file} lost its VitePress patches`).toBeGreaterThan(0)
    for (const head of heads) {
      expect(head, `${file} styles outside the layer`).toMatch(/^(\.VPNavBar|html\.docpilot-)/)
    }
  })

  it('ships every file the CLI reads at runtime', () => {
    for (const file of fs.readdirSync(abs('bin'))) {
      const src = fs.readFileSync(abs(`bin/${file}`), 'utf8')
      for (const m of src.matchAll(/new URL\(\s*'\.\.\/([^']+)'\s*,\s*import\.meta\.url\s*\)/g)) {
        const rel = m[1]
        expect(fs.existsSync(abs(rel)), `bin/${file} reads ${rel}, which does not exist`).toBe(true)
        expect(shipped(rel), `${rel} is read by bin/${file} but not listed in files[]`).toBe(true)
      }
    }
  })

  /**
   * Every leaf of the exports map, as `[subpath, target]`.
   *
   * A subpath's value is either a string or a CONDITION OBJECT —
   * `{ types: './types/x.d.ts', default: './src/x.js' }` — and the string form
   * is what this test was written against. Left unrecursed, a condition object
   * stringifies to `[object Object]`, `fs.existsSync` says no, and the failure
   * reads as a missing file rather than as a test that cannot see one. Every
   * condition is a real path npm will resolve, so every condition is checked:
   * a `.d.ts` that does not exist is a package that type-errors on import.
   */
  const exportTargets = (map) => {
    const out = []
    const walk = (node, name) => {
      if (typeof node === 'string') out.push([name, node])
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walk(value, `${name} (${key})`)
      }
    }
    for (const [subpath, node] of Object.entries(map)) walk(node, subpath)
    return out
  }

  it('resolves every export target', () => {
    for (const [name, target] of exportTargets(pkg.exports)) {
      // npm ships the manifest itself whatever `files` says.
      if (name.startsWith('./package.json')) continue
      const rel = target.replace('./', '')
      if (built(rel)) {
        expect(shipped(rel), `${name} points into an unshipped directory`).toBe(true)
        continue
      }
      // Wildcard subpaths name a directory pattern, not a file.
      if (rel.includes('*')) {
        expect(fs.existsSync(abs(path.dirname(rel))), `${name} points at a missing directory`).toBe(true)
        continue
      }
      expect(fs.existsSync(abs(rel)), `${name} points at ${rel}, which does not exist`).toBe(true)
      expect(shipped(rel), `${name} points at ${rel}, which files[] does not ship`).toBe(true)
    }
  })

  /**
   * The five components by file, and no part of the panel.
   *
   * A `*` in `exports` matches across `/`, so `./theme/components/*.vue` also
   * exported the nineteen parts under `panel/` — components that read the
   * panel's context and render nothing anywhere else, and that nobody could
   * then rename without breaking an import. Node's own resolver is the witness:
   * it is what a consumer's `import` goes through.
   */
  it('exports the five components by file, under both names, and no part of the panel', () => {
    const require = createRequire(abs('package.json'))
    const resolve = (file) => require.resolve(`${pkg.name}/theme/components/${file}`)
    let refused = null
    try {
      resolve('panel/Turn.vue')
    } catch (e) {
      refused = e.code
    }
    expect(refused, 'panel/Turn.vue is reachable from outside the package').toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
    if (!distBuilt) return
    const NAMES = { Panel: 'DocPilot', Trigger: 'DocPilotTrigger', Cta: 'DocPilotCta', Icons: 'DocPilotIcons', Quote: 'DocPilotQuote' }
    for (const [file, before] of Object.entries(NAMES)) {
      const target = fs.realpathSync(abs(`dist/theme/components/${file}.vue`))
      expect(resolve(`${file}.vue`)).toBe(target)
      expect(resolve(`${before}.vue`), `the name 2.0 published ${file}.vue under`).toBe(target)
    }
  })

  /**
   * Nothing in `dist/` that the current sources no longer build.
   *
   * No builder deleted anything, and `files` publishes `dist/` whole: a renamed
   * or removed source left its last output behind, and 2.0.1 went out with an
   * earlier build's twelve grammar chunks beside the twelve its bundle imports.
   * `build-js.js` and `build-web.js` remove what they no longer write; these two
   * say they still do. CI's tree is always fresh, so the place they can fail is
   * the one that matters — `verify` before a publish from a working tree.
   */
  it('holds no compiled module or copied component whose source is gone', () => {
    if (!distBuilt) return
    const stale = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(abs(`dist/${dir}`), { withFileTypes: true })) {
        const rel = `${dir}${entry.name}`
        // The other two builders' — stylesheets match nothing below.
        if (rel === 'web' || rel === 'docpilot.web.js') continue
        if (entry.isDirectory()) {
          walk(`${rel}/`)
          continue
        }
        const stem = rel.match(/^(.*)\.(?:js|js\.map|d\.ts)$/)?.[1]
        const from = /\.vue$|\.d\.vue\.ts$/.test(rel) ? [rel] : stem ? [`${stem}.ts`, `${stem}.js`] : []
        if (from.length && !from.some((f) => fs.existsSync(abs(`src/${f}`)))) stale.push(`dist/${rel}`)
      }
    }
    walk('')
    expect(stale, 'outputs with no source — `npm run build:js` removes them').toEqual([])
  })

  it('holds no chunk the web bundle does not import', () => {
    if (!fs.existsSync(abs('dist/docpilot.web.mjs'))) return
    const reached = new Set()
    const follow = (file) => {
      for (const m of fs.readFileSync(abs(file), 'utf8').matchAll(/["']\.\/(?:web\/)?([\w-]+\.js)["']/g)) {
        if (reached.has(m[1]) || !fs.existsSync(abs(`dist/web/${m[1]}`))) continue
        reached.add(m[1])
        follow(`dist/web/${m[1]}`)
      }
    }
    follow('dist/docpilot.web.mjs')
    const unreached = fs.readdirSync(abs('dist/web')).filter((f) => !reached.has(f))
    expect(unreached, 'chunks nothing imports — `npm run build:web` removes them').toEqual([])
  })

  /**
   * Every JavaScript entry point is typed.
   *
   * The declarations under `types/` are hand-written and are the package's
   * documented public surface — `Highlighter` in particular is the API this
   * package asks people to implement. An entry point added without one is an
   * entry point nobody can use from TypeScript without `any`, and nothing else
   * would say so.
   */
  it('ships types for every JavaScript entry point', () => {
    for (const [name, target] of Object.entries(pkg.exports)) {
      if (name === './package.json' || name.includes('*')) continue
      const isJs =
        typeof target === 'string'
          ? target.endsWith('.js')
          : Object.values(target).some((t) => typeof t === 'string' && t.endsWith('.js'))
      if (!isJs) continue
      expect(typeof target, `${name} has no types condition`).toBe('object')
      expect(target.types, `${name} has no types condition`).toMatch(/\.d\.ts$/)
    }
  })

  // A `types` condition must come FIRST in the object: Node and TypeScript both
  // resolve conditions in declaration order, so one placed after `default` is
  // one that never wins.
  it('puts the types condition first', () => {
    for (const target of Object.values(pkg.exports)) {
      if (typeof target === 'string' || !target.types) continue
      expect(Object.keys(target)[0]).toBe('types')
    }
  })

  /**
   * The VALUE names a hand-written declaration file promises: what an
   * `import { x }` may name and expect to find at runtime. Types are erased and
   * promise nothing, so `interface`, `type` and `export type …` add no name;
   * `export *` is followed into the file it names. Comments are stripped
   * first — the headers quote import lines.
   */
  function declaredValues(file, seen = new Set()) {
    if (seen.has(file)) return new Set()
    seen.add(file)
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const names = new Set()
    const decl = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum|namespace)\s+([\w$]+)/gm
    for (const m of text.matchAll(decl)) names.add(m[1])
    if (/^export\s+default\b/m.test(text)) names.add('default')
    for (const m of text.matchAll(/^export\s+\{([^}]*)\}/gm)) {
      for (const part of m[1].split(',').map((p) => p.trim())) {
        if (part && !part.startsWith('type ')) names.add(part.split(/\s+as\s+/).pop())
      }
    }
    for (const m of text.matchAll(/^export\s+\*\s+as\s+([\w$]+)/gm)) names.add(m[1])
    for (const m of text.matchAll(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)) {
      const next = path.resolve(path.dirname(file), m[1].replace(/\.js$/, '.d.ts'))
      for (const n of declaredValues(next, seen)) if (n !== 'default') names.add(n)
    }
    return names
  }

  /**
   * Subpaths this runner cannot load, each for a reason outside the package.
   * Checked whenever the import DOES succeed (a full build, an installed peer);
   * a failure to load anything not named here fails the test.
   */
  const UNLOADABLE = {
    './theme': "imports a stylesheet — its own, built by `build:css`, and VitePress's",
    './theme-without-styles': "imports VitePress's default-theme stylesheets",
    './web': 'a bundle `build:web` writes, which `build:js` does not',
    './react': 'needs `react`, which this repository does not install',
    './docusaurus/client': 'imports `./web` by the package name, so it needs the same bundle',
  }

  /**
   * Exported at runtime with no declaration yet. Each is a decision still owed
   * — declare it, or stop exporting it from a public subpath — so the list may
   * only shrink: a new undeclared export fails below.
   */
  const UNDECLARED = {
    './config': ['RUNTIMES', 'assertRuntime', 'assertTools', 'serverTurnConfig'],
    './server': [
      'SERVER_DEFAULTS', 'clientKey', 'createLimiter', 'createMetrics', 'createTurnLog', 'parseTurnInput',
      'readCapped', 'readIndexDir', 'resolveServerOptions', 'runServerTurn', 'shellManifest', 'sourceChunk',
      'startToolProbe',
    ],
    './host': ['__resetHostForTests', 'releaseHost'],
    './highlight': ['__setHighlighterForTests'],
  }

  /**
   * Every subpath's types name exactly what its module exports.
   *
   * `types/index.d.ts` once said `export * from './config.js'` while the `.`
   * entry re-exported twelve names of the forty it declared:
   * `import { DEFAULTS } from '@cloflin/docpilot'` type-checked and died at load
   * with "does not provide an export named". `typings/conformance.d.ts` checks
   * the SHAPE of the names it lists, never that a declared name exists, so
   * nothing caught it.
   */
  it('declares exactly the names each subpath exports at runtime', async () => {
    if (!distBuilt) return
    for (const [name, target] of Object.entries(pkg.exports)) {
      if (typeof target !== 'object' || !target.types || !/\.m?js$/.test(target.default)) continue
      let mod
      try {
        mod = await import(new URL(target.default, root).href)
      } catch (e) {
        expect(Object.hasOwn(UNLOADABLE, name), `${name} does not load: ${e.message}`).toBe(true)
        continue
      }
      const declared = declaredValues(abs(target.types))
      const actual = Object.keys(mod)
      const phantom = [...declared].filter((n) => !actual.includes(n))
      expect(phantom, `${name} declares names its module does not export`).toEqual([])
      const owed = new Set(UNDECLARED[name] ?? [])
      const undeclared = actual.filter((n) => !declared.has(n) && !owed.has(n))
      expect(undeclared, `${name} exports names ${target.types} does not declare`).toEqual([])
    }
  })

  // The three stylesheets are a public contract: a consumer who wants the core
  // without the VitePress mapping has to be able to name it.
  it('exports all three stylesheets and the styleless theme', () => {
    for (const name of ['./style.css', './style/core.css', './style/vitepress.css', './theme-without-styles']) {
      expect(Object.hasOwn(pkg.exports, name), name).toBe(true)
    }
  })

  // Now that the `.vue` files carry no `<style>` block, nothing in this package
  // has a side effect except a stylesheet — and saying so is what lets a
  // consumer's bundler drop what they do not use.
  //
  // The glob halves are not enough on their own. A bundler tests this list
  // against the module it just resolved, not against what that module goes on
  // to import: `src/theme/index.js` matches neither `*.css` nor `*.scss`, so it
  // is marked side-effect-free, and its one statement — the bare
  // `import '../../dist/docpilot.css'` — is dropped with it. The panel then
  // renders with no stylesheet at all, on a build that is green. Every module
  // whose whole purpose is a bare stylesheet import has to be named here, which
  // is what the second half of this test enforces.
  it('declares its side effects', () => {
    expect(pkg.sideEffects).toEqual([
      '*.css',
      '*.scss',
      './dist/theme/index.js',
      './dist/web.js',
    ])
    for (const f of [
      'src/theme/components/Trigger.vue',
      'src/theme/components/Cta.vue',
      'src/theme/components/Quote.vue',
    ]) {
      // Anchored: both components mention `<style>` in the comment that says
      // why they no longer have one.
      expect(/^<style/m.test(fs.readFileSync(abs(f), 'utf8')), f).toBe(false)
    }
  })

  // The list above is a literal, so it only stays right for as long as someone
  // remembers to extend it. This walks src/ instead and fails on the module
  // that grows a stylesheet import without being declared.
  it('names every module that imports a stylesheet for its side effect', () => {
    const declared = new Set(pkg.sideEffects)
    const walk = (dir) =>
      fs.readdirSync(abs(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`)
          : /\.(js|mjs|ts)$/.test(e.name)
            ? [`${dir}/${e.name}`]
            : [],
      )
    for (const f of walk('src')) {
      const src = fs.readFileSync(abs(f), 'utf8')
      // Bare imports only. A default or named import from a stylesheet is not
      // a thing, and quoting one inside a comment or a doc block is — every
      // adapter's header shows the consumer which stylesheet to pull in.
      const bare = src
        .split('\n')
        .some((line) => /^import\s+['"][^'"]+\.(css|scss)['"]/.test(line))
      if (!bare) continue
      // `sideEffects` names what the consumer resolves, which is the emitted
      // module; this walk reads the source that produces it. Map one onto the
      // other rather than declaring both.
      const emitted = f.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')
      expect(declared.has(`./${emitted}`), `${f} imports a stylesheet but is not in sideEffects`).toBe(true)
    }
  })

  /**
   * `withDocPilot` on a theme built as `{ extends: SomeTheme }`.
   *
   * Asserted on the SOURCE rather than by calling it: `theme.js` imports
   * `vitepress/theme`, which does not resolve under vitest's node environment,
   * so there is no way to exercise this in the suite. It is checked anyway,
   * because the failure has no error and no warning attached to it — a theme
   * that supplies its Layout only through `extends` silently renders stock
   * VitePress instead of its own chrome, and the only symptom is that the site
   * looks wrong. This package's own docs site is exactly that shape.
   */
  it('resolves the parent layout through `extends`, not just off the theme', () => {
    const src = srcText('src/theme/theme.js')
    const line = src.match(/const Parent =.*/)?.[0] || ''
    expect(line, 'withDocPilot no longer resolves a parent Layout').toBeTruthy()
    expect(line).toContain('theme.extends?.Layout')
    // Order matters: a theme's own Layout still wins over the one it extends.
    expect(line.indexOf('theme.Layout')).toBeLessThan(line.indexOf('theme.extends'))
  })
})


/**
 * ── APPEND TO test/packaging.test.js ─────────────────────────────────────────
 *
 * Self-contained: paste this `describe` block at the end of the file, after the
 * existing `describe('packaging', ...)`. It re-declares `root`, `abs` and `pkg`
 * under its own names so it can be dropped in without touching what is above it;
 * merge them into the file-level ones if you prefer. No imports are added —
 * `describe`/`it`/`expect`, `fs` and `path` are already imported at the top.
 */

/**
 * The manifest fields that only matter on the day of a release.
 *
 * Every check here is for a defect with no local symptom whatsoever: the package
 * builds, the tests pass, the panel works from a clone, and the failure appears
 * for the first time in the terminal of whoever runs `npm publish` — or, worse,
 * in the terminal of whoever installs the result. The suite above asserts what
 * the tarball CONTAINS; this one asserts what npm is TOLD about it.
 */
describe('publish metadata', () => {
  const pubRoot = new URL('../', import.meta.url)
  const pubAbs = (rel) => path.join(pubRoot.pathname, rel)
  const pubPkg = JSON.parse(fs.readFileSync(pubAbs('package.json'), 'utf8'))

  /**
   * A scoped package with no `access` publishes RESTRICTED, and a restricted
   * publish from a free npm account is rejected with `E402 Payment Required` —
   * after the whole tarball has been uploaded, and with an error that names
   * payment rather than configuration. One line in the manifest is the entire
   * difference between a first publish that works and an afternoon spent
   * reading npm's billing pages.
   */
  it('publishes the scoped package publicly', () => {
    expect(pubPkg.name.startsWith('@'), 'this test is about scoped packages').toBe(true)
    expect(pubPkg.publishConfig?.access, 'a scoped package without this publishes restricted (E402)').toBe('public')
  })

  /**
   * The four fields npm renders on the package page and nothing in a clone
   * needs. Absent, they cost nothing locally and produce a registry listing
   * with no author, no link to the documentation and no way to report a bug —
   * which is a package a stranger has no reason to trust.
   */
  it('names its author, its home, its issues and its repository', () => {
    const nonEmpty = (v) => (typeof v === 'string' ? v.trim().length > 0 : !!v)
    expect(nonEmpty(pubPkg.author), 'author').toBe(true)
    expect(nonEmpty(pubPkg.homepage), 'homepage').toBe(true)
    expect(nonEmpty(pubPkg.bugs?.url || pubPkg.bugs), 'bugs').toBe(true)
    expect(nonEmpty(pubPkg.repository?.url || pubPkg.repository), 'repository').toBe(true)
    // `engines.node` is the one of the five with teeth. Without it an install
    // on an unsupported runtime is silent until something fails at import —
    // `bin/build-css.js` opens with a top-level `await import`, and the CLI is
    // ESM with `node:` specifiers throughout. With it, npm says EBADENGINE and
    // names the version.
    expect(nonEmpty(pubPkg.engines?.node), 'engines.node').toBe(true)
  })

  /**
   * The release gate has to be REACHED, not merely present. `scripts/` is not in
   * `files[]` — deliberately, it is repository-internal — so nothing a consumer
   * runs would notice this script disappearing from the script that calls it.
   */
  it('runs the publish check before publishing', () => {
    expect(pubPkg.scripts?.prepublishOnly, 'no prepublishOnly script').toBeTruthy()
    expect(pubPkg.scripts.prepublishOnly).toContain('check-publish')
    expect(fs.existsSync(pubAbs('scripts/check-publish.js')), 'scripts/check-publish.js is missing').toBe(true)
    // npm's order is prepublishOnly → prepack → prepare → pack, so the check
    // would otherwise grade the PREVIOUS build. The build in the middle of this
    // command is what makes it grade the one being packed.
    expect(pubPkg.scripts.prepublishOnly.indexOf('build')).toBeLessThan(
      pubPkg.scripts.prepublishOnly.indexOf('check-publish'),
    )
  })

  /**
   * The changelog ships and agrees with the version.
   *
   * npm will publish a version no entry describes, and the changelog is the only
   * record of what a version contains — the git history is not in the tarball.
   * `scripts/check-publish.js` makes the same comparison at publish time; this
   * makes it on every test run, which is where a forgotten heading is cheap to
   * fix.
   */
  it('ships a changelog whose first release is this version', () => {
    expect(fs.existsSync(pubAbs('CHANGELOG.md')), 'CHANGELOG.md does not exist').toBe(true)
    expect(
      pubPkg.files.some((entry) => entry.replace(/\/$/, '') === 'CHANGELOG.md'),
      'CHANGELOG.md is not in files[]',
    ).toBe(true)
    const top = fs.readFileSync(pubAbs('CHANGELOG.md'), 'utf8').match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1]
    expect(top, 'CHANGELOG.md has no `## x.y.z` heading').toBeTruthy()
    expect(top, 'CHANGELOG.md leads with a different version than package.json').toBe(pubPkg.version)
  })

  /**
   * NO PEER DEPENDENCIES AT ALL, and that is the conclusion three releases of
   * evidence argued for.
   *
   * Every peer this package ever declared was `optional: true`, which means npm
   * never installs one. So the block had exactly one mechanical effect: it
   * REFUSED TO INSTALL when a consumer already carried a version outside the
   * range it happened to state. Three of eleven ranges did that or came within
   * one release of it —
   *
   *   · `vitepress: '^1.6.4'` pinned a peer this repo's own devDependencies did
   *     not satisfy — ERESOLVE on any host running `npm install` (fixed 0.3.1)
   *   · `@scalar/openapi-parser: '^0.22.0'` was a guessed number against a
   *     package at 0.28, and `^0.x` matches ONE minor — so 0.3.2 could not be
   *     installed beside a current `@scalar/api-reference` at all
   *   · `linkedom: '^0.18.0'` was the same defect waiting on linkedom 0.19
   *
   * — for a block that installed nothing and warned nobody who was not already
   * about to hit a runtime error. The guidance it was supposed to carry lives
   * where people actually meet the requirement: `docpilot import` and the
   * OpenAPI chunker name their install command in the thrown message, and the
   * highlighters are reached through an explicit subpath documented in
   * `/reference/highlighting`.
   *
   * What is lost is real and small: a consumer on a FUTURE major — Vue 4, React
   * 20, Prism 2 — now meets a runtime error rather than an install warning. What
   * is gained is that this package cannot make somebody else's `npm install`
   * fail, which it has now done once for real.
   */
  it('declares no peer dependencies', () => {
    expect(pubPkg.peerDependencies, 'peerDependencies is back').toBeUndefined()
    expect(pubPkg.peerDependenciesMeta, 'peerDependenciesMeta is back').toBeUndefined()
  })

  /**
   * The runtime half of the same decision: with no peer block, a module that is
   * missing has to say so ITSELF. These two are build-time and are the ones a
   * consumer meets by accident — an OpenAPI file appears in `public/`, or
   * somebody runs `docpilot import` or `index --html-dir` — so each names its
   * install command in the error it throws rather than failing on an unresolved
   * import three frames up.
   *
   * `linkedom` moved from `import.js` into `lib/dom.js` when the second HTML
   * reader arrived. The file named here is THE ONE PLACE the import is written,
   * and that is what makes the message a consumer sees a single string rather
   * than one per caller: a third reader that re-implements the try/catch instead
   * of importing this module fails the second half of this test.
   */
  it('names the install command where an optional module is actually needed', () => {
    const cases = [
      ['src/build/lib/openapi-chunker.js', '@scalar/openapi-parser'],
      ['src/build/lib/dom.js', 'linkedom'],
    ]
    for (const [file, mod] of cases) {
      const src = srcText(file)
      expect(src, `${file} does not import ${mod} lazily`).toContain(`await import('${mod}')`)
      expect(src, `${file} does not name an install command for ${mod}`).toMatch(
        new RegExp(`npm i[^\\n]*${mod.replace('/', '\\/')}`),
      )
    }

    // One writer, one message. `test/` is excluded: the suite parses HTML with
    // linkedom directly and always will — it is a devDependency there, which is
    // exactly the situation this rule is protecting a CONSUMER from.
    const strays = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(js|ts)$/.test(e.name) && !p.endsWith(path.join('lib', 'dom.ts'))) {
          if (fs.readFileSync(p, 'utf8').includes("import('linkedom')")) strays.push(p)
        }
      }
    }
    walk(abs('src'))
    expect(strays, 'linkedom is imported outside src/build/lib/dom.ts').toEqual([])
  })

  /**
   * NO CARET ON A `0.x` PEER, and this rule was written by a released defect.
   *
   * `^1.29.0` admits everything up to 2.0. `^0.22.0` admits `0.22.x` and nothing
   * else — npm treats every `0.x` minor as its own major line — so a caret there
   * is not a floor, it is a pin on one minor of somebody else's release train.
   * For an OPTIONAL peer that is worse than useless: the package does not
   * install it, cannot use it unless the consumer has it, and yet refuses to
   * install *at all* beside a newer copy the consumer already has.
   *
   * 0.3.2 shipped `@scalar/openapi-parser: '^0.22.0'` — a number nobody checked,
   * against a package that was at 0.28 — and became uninstallable in any project
   * carrying a current `@scalar/api-reference`:
   *
   *     npm error ERESOLVE could not resolve
   *       peerOptional @scalar/openapi-parser@"^0.22.0" from @cloflin/docpilot@0.3.2
   *       Found: @scalar/openapi-parser@0.28.16
   *
   * `linkedom: '^0.18.0'` was the same defect one release from firing: linkedom
   * is at 0.18.13 today and 0.19 would have done it again.
   *
   * The rule this pins is a FLOOR, not a version: state the oldest release the
   * code was verified against and let the consumer bring anything newer. That is
   * what `>=2` on the four `@shikijs/*` peers already says, for the reason 0.3.1
   * recorded when it widened them.
   */
  it('states a floor rather than a pin, if a peer block ever returns', () => {
    const pinned = Object.entries(pubPkg.peerDependencies || {})
      .filter(([, range]) => /^\^\s*0\./.test(range))
      .map(([name, range]) => `${name}: "${range}" — use ">=0.x" instead`)
    expect(pinned, 'a caret on a 0.x peer pins one minor of somebody else\'s releases').toEqual([])
  })
})

/**
 * The one URL that is written twice.
 *
 * `homepage` in the manifest is what npm renders on the package page; the
 * footnote credit in `panel/Footnote.vue` is what a reader of somebody else's
 * docs site clicks. They are the same address, kept in two files because
 * neither can import the other — the theme is bundled into a browser chunk and
 * has no business reading `package.json`.
 *
 * These two HAVE disagreed. A release went out with a homepage that did not
 * resolve, and nothing failed: a manifest field is not executed, and neither is
 * a link. This is the check that would have caught it.
 */
describe('the credit link and the manifest homepage', () => {
  const linkRoot = new URL('../', import.meta.url)
  const linkAbs = (rel) => path.join(linkRoot.pathname, rel)
  const linkPkg = JSON.parse(fs.readFileSync(linkAbs('package.json'), 'utf8'))

  it('point at the same place', () => {
    const panel = srcText('src/theme/components/panel/Footnote.vue')
    const found = panel.match(/const CREDIT_URL = '([^']+)'/)
    expect(found, 'a `const CREDIT_URL` in Footnote.vue').not.toBe(null)
    expect(found[1], 'the footnote credit disagrees with package.json homepage').toBe(linkPkg.homepage)
  })
})
