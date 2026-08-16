import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

/**
 * The stylesheet split, asserted rather than remembered.
 *
 * `scripts/check-docpilot.sh` covers the design-direction rules; this file covers
 * the two things the SPLIT itself depends on, plus the one number that is
 * duplicated between CSS and JavaScript:
 *
 *   · the core names nothing VitePress-specific — the reason for the split;
 *   · the adapter re-declares the WHOLE colour set — the reason the override
 *     works at all, since it wins by cascade order and not by specificity;
 *   · `$sheet` and the `matchMedia` string in DocPilot.vue are the same width.
 *
 * The bash checks and these overlap on purpose. `grep -P` and awk behave
 * differently across platforms, and the rule that matters most — "no VitePress
 * in the core" — is worth having in the one runner every contributor executes.
 */
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const CORE = read('src/theme/styles/core.scss')
const ADAPTER = read('src/theme/styles/vitepress.scss')
const ENTRY = read('src/theme/styles/docpilot.scss')
const BREAKS = read('src/theme/styles/_breakpoints.scss')

/** Comments state the rules verbatim, so a naive grep would flag the prose. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const declarations = (css) => new Set([...css.matchAll(/^\s*(--dp-[\w-]+)\s*:/gm)].map((m) => m[1]))
const references = (css) => new Set([...css.matchAll(/var\(\s*(--dp-[\w-]+)/g)].map((m) => m[1]))

/** The token names inside the first block that opens with `selector {`. */
function blockAfter(css, marker) {
  const at = css.indexOf(marker)
  if (at < 0) return ''
  let depth = 0
  let i = css.indexOf('{', at)
  const from = i
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(from, i)
  }
  return ''
}

describe('stylesheet split', () => {
  it('keeps VitePress out of the core', () => {
    const code = stripComments(CORE)
    for (const pattern of [/--vp-/, /\.VP/, /html\.dark/]) {
      expect(pattern.test(code), `${pattern} in core.scss`).toBe(false)
    }
  })

  it('declares every token it uses, in the core', () => {
    const declared = declarations(stripComments(CORE))
    for (const used of [...references(stripComments(CORE)), ...references(stripComments(ADAPTER))]) {
      expect(declared.has(used), `${used} is used but never declared in core.scss`).toBe(true)
    }
  })

  // The adapter OVERRIDES; it must never INTRODUCE. A token that exists only
  // here is a token the core cannot render without it, which is the failure the
  // whole split is meant to make impossible.
  it('introduces no token of its own', () => {
    const core = declarations(stripComments(CORE))
    for (const token of declarations(stripComments(ADAPTER))) {
      expect(core.has(token), `${token} is declared only in vitepress.scss`).toBe(true)
    }
  })

  /**
   * The load-bearing half of the cascade argument.
   *
   * The core's dark values come from `prefers-color-scheme`. VitePress switches
   * appearance by class and lets a reader pin a site to light. So every token
   * the core darkens has to be re-declared UNCONDITIONALLY by the adapter — a
   * token left out keeps the OS-driven value and paints one dark element into
   * an otherwise light panel.
   */
  it('re-declares every dark-scheme token unconditionally', () => {
    const dark = declarations(blockAfter(stripComments(CORE), '@media (prefers-color-scheme: dark)'))
    expect(dark.size).toBeGreaterThan(5)
    const rootBlock = blockAfter(stripComments(ADAPTER), ':root')
    const mapped = declarations(rootBlock)
    for (const token of dark) {
      expect(mapped.has(token), `${token} darkens in core.scss but is not mapped`).toBe(true)
    }
  })

  it('leaves the bundle entry with nothing but @use', () => {
    const body = stripComments(ENTRY)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(body).toEqual(["@use './core';", "@use './vitepress';"])
  })

  // Two files disagreeing about this number gives a reader a full-screen sheet
  // that still announces itself as a sidebar — the component's `mobile` flag
  // and the stylesheet's geometry are the same decision written twice.
  it('pins the sheet breakpoint to the one the component watches', () => {
    const sheet = BREAKS.match(/\$sheet:\s*(\d+)px/)?.[1]
    expect(sheet).toBe('960')
    const vue = read('src/theme/components/DocPilot.vue')
    expect(vue).toContain(`matchMedia('(min-width: ${sheet}px)')`)
  })
})
