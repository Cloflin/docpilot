#!/usr/bin/env node
/**
 * The modules, compiled — `src/**` to `dist/**`, plus the components.
 *
 * WHAT CHANGED, AND WHY THE OLD POLICY IS GONE. Until 1.0.0 this file did not
 * exist and could not have: `exports` pointed straight at `./src/*.js`, the
 * package shipped its source unbundled, and a build step for it would have
 * changed the artifact every consumer receives. That reasoning was right for as
 * long as the source was JavaScript. It is TypeScript now, so there is no
 * arrangement in which nothing is compiled — the only question left was who
 * compiles it, and doing it here once beats asking every consumer's bundler to
 * do it, some of which cannot.
 *
 * WHAT IS KEPT. `tsc`, not a bundler. The emitted tree is the source tree file
 * for file: 19 `exports` subpaths depend on that layout, `sideEffects` and the
 * highlighter split depend on it, and — the part that matters to a reader — the
 * comments survive. `erasableSyntaxOnly` in `tsconfig.json` is what makes that
 * claim checkable rather than hopeful: it bans every construct that compiles to
 * something other than itself, so `dist/x.js` is `src/x.ts` minus the
 * annotations, and a diff of the two says so.
 *
 * THE COMPONENTS ARE COPIED, NOT COMPILED. `.vue` is not TypeScript and `tsc`
 * does not see it. They land in `dist/` beside the emitted modules so their own
 * relative imports — `../docpilot/session.js` — resolve to the emitted files
 * rather than back into `src/`, which is the whole reason a copy is needed and
 * not just a convenience. Their `<script setup lang="ts">` is stripped by the
 * consumer's Vue plugin, exactly as it was before this file existed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

/**
 * A missing compiler is a skip; a missing compiler during a RELEASE is not.
 *
 * The same gate `build-css.js` and `build-web.js` carry, for the failure that
 * is now the worst of the three: twenty-two of the twenty-three `exports`
 * subpaths resolve into `dist/` after 1.0.0, so a tarball built without this
 * step is a package that installs and then fails on `import`. `npm_command`
 * is what separates a release from a contributor's install; npm sets it and
 * nothing here does.
 */
const require = createRequire(import.meta.url)
let tscBin
try {
  tscBin = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
} catch (err) {
  const releasing = process.env.npm_command === 'publish' || process.env.npm_command === 'pack'
  if (releasing) {
    console.error(
      `[docpilot] typescript is missing and npm_command=${process.env.npm_command} — refusing to build a release without dist/  (fix: npm install)`,
    )
    throw err
  }
  // Not a consumer path: `prepare` runs for local-directory and git installs
  // and before pack/publish, never for an install from the registry — that one
  // unpacks `dist/` from the tarball and never reaches this file.
  console.log(
    '[docpilot] typescript not installed — skipping the module build (this is normal for a contributor install without devDependencies)',
  )
  process.exit(0)
}

/** Every `.vue` under `src/`, at the path it keeps inside `dist/`. */
const components = () => {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name))
      // The declaration travels with the component: `allowArbitraryExtensions`
      // makes `X.d.vue.ts` the types for `X.vue`, and a consumer resolving a
      // `./theme/components/….vue` subpath finds it beside the file.
      else if (entry.name.endsWith('.vue') || entry.name.endsWith('.d.vue.ts'))
        out.push(path.join(dir, entry.name))
    }
  }
  walk('src')
  return out
}

const copyComponents = () => {
  let copied = 0
  for (const rel of components()) {
    const from = path.join(root, rel)
    const to = path.join(root, rel.replace(/^src[/\\]/, 'dist/'))
    // Byte-identical is not worth a write: `vitepress dev` watches `dist/`
    // under the alias-free build, and a touched file it did not need is a
    // reload it did not need either.
    const next = fs.readFileSync(from)
    if (fs.existsSync(to) && fs.readFileSync(to).equals(next)) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, next)
    copied += 1
  }
  return copied
}

/**
 * What this file wrote once and would not write now, deleted.
 *
 * Neither half above removes anything: tsc writes what it compiles and the copy
 * writes what it finds, so a renamed or deleted source leaves its last output
 * in `dist/` — and `files` publishes `dist/` whole. A fresh clone never has one,
 * so CI's tarball is clean; a publish from a working tree ships whatever that
 * tree ever built — after the components' rename, the five `DocPilot*.vue`
 * beside the files that replaced them.
 *
 * STALE MEANS NO SOURCE, not "not written this run": a file is judged by the one
 * under `src/` that would produce it, so the answer does not depend on what tsc
 * happened to emit. The other two builders write into the same directory and
 * are not this file's to judge — `build-css.js` writes only stylesheets, which
 * `sourcesOf` never matches, and `build-web.js` the two names below.
 */
const NOT_OURS = new Set(['docpilot.web.js', 'web'])

/** The files under `src/` that would produce `dist/<rel>`; none when this file writes nothing like it. */
const sourcesOf = (rel) => {
  if (rel.endsWith('.vue') || rel.endsWith('.d.vue.ts')) return [rel]
  const stem = rel.match(/^(.*)\.(?:js|js\.map|d\.ts)$/)?.[1]
  return stem ? [`${stem}.ts`, `${stem}.js`] : []
}

const pruneStale = () => {
  const dist = path.join(root, 'dist')
  let removed = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(dist, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name)
      if (!dir && NOT_OURS.has(entry.name)) continue
      if (entry.isDirectory()) {
        walk(rel)
        // A source directory deleted whole leaves an empty one here.
        if (!fs.readdirSync(path.join(dist, rel)).length) fs.rmdirSync(path.join(dist, rel))
        continue
      }
      const sources = sourcesOf(rel)
      if (!sources.length || sources.some((s) => fs.existsSync(path.join(root, 'src', s)))) continue
      fs.rmSync(path.join(dist, rel))
      removed += 1
    }
  }
  if (fs.existsSync(dist)) walk('')
  return removed
}

const reportPruned = (n) => {
  if (n) console.log(`[docpilot] removed ${n} stale file${n === 1 ? '' : 's'} from dist/ — their source is gone`)
}

if (watch) {
  // Two watchers, because the two halves are watched by different things: tsc
  // owns the modules and knows their dependency graph, and `fs.watch` is enough
  // for files that import nothing at build time. A module deleted under watch
  // keeps its output until a component changes or the next full build.
  const { spawn } = await import('node:child_process')
  copyComponents()
  reportPruned(pruneStale())
  for (const dir of new Set(components().map((rel) => path.dirname(path.join(root, rel))))) {
    fs.watch(dir, () => {
      const n = copyComponents()
      if (n) console.log(`[docpilot] copied ${n} component${n === 1 ? '' : 's'} to dist/`)
      reportPruned(pruneStale())
    })
  }
  const tsc = spawn(process.execPath, [tscBin, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
    cwd: root,
    stdio: 'inherit',
  })
  tsc.on('exit', (code) => process.exit(code ?? 1))
} else {
  const r = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
  const copied = copyComponents()
  reportPruned(pruneStale())
  console.log(`[docpilot] dist/ built — modules compiled, ${copied} component${copied === 1 ? '' : 's'} copied`)
}
