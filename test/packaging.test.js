import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
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
  // `dist/` is built by `prepare`, so it may legitimately be absent here.
  const built = (rel) => rel.startsWith('dist/')

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

  it('resolves every export target', () => {
    for (const [name, target] of Object.entries(pkg.exports)) {
      // npm ships the manifest itself whatever `files` says.
      if (name === './package.json') continue
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
  it('declares its side effects', () => {
    expect(pkg.sideEffects).toEqual(['*.css', '*.scss'])
    for (const f of ['src/theme/components/DocPilotTrigger.vue', 'src/theme/components/DocPilotCta.vue']) {
      // Anchored: both components mention `<style>` in the comment that says
      // why they no longer have one.
      expect(/^<style/m.test(fs.readFileSync(abs(f), 'utf8')), f).toBe(false)
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
    const src = fs.readFileSync(abs('src/theme/theme.js'), 'utf8')
    const line = src.match(/const Parent =.*/)?.[0] || ''
    expect(line, 'withDocPilot no longer resolves a parent Layout').toBeTruthy()
    expect(line).toContain('theme.extends?.Layout')
    // Order matters: a theme's own Layout still wins over the one it extends.
    expect(line.indexOf('theme.Layout')).toBeLessThan(line.indexOf('theme.extends'))
  })
})
