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
const ENTRY = read('src/theme/styles/docpilot.scss')
const BREAKS = read('src/theme/styles/_breakpoints.scss')

/**
 * Every host adapter, by name — the mirror of `$ADAPTERS` in
 * `scripts/check-docpilot.sh`, and the only line that changes when a host is
 * added.
 *
 * A list rather than the one file this started as, because the two rules below
 * are the whole of what makes an adapter safe to load, and an adapter nobody
 * checks is one that can introduce a token the core cannot render without, or
 * miss a dark value and paint one light element into a dark panel. Neither
 * failure is visible on the host the author happened to be testing.
 */
const ADAPTERS = [
  ['vitepress.scss', read('src/theme/styles/vitepress.scss')],
  ['docusaurus.scss', read('src/theme/styles/docusaurus.scss')],
]

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
  // Every host, not just the first one this was written for: the core has to
  // render a correct panel with NO adapter loaded, and an Infima token smuggled
  // in breaks that exactly as a VitePress one would.
  it('keeps every host out of the core', () => {
    const code = stripComments(CORE)
    for (const pattern of [/--vp-/, /\.VP/, /html\.dark/, /--ifm-/, /\[data-theme/]) {
      expect(pattern.test(code), `${pattern} in core.scss`).toBe(false)
    }
  })

  it('declares every token it uses, in the core', () => {
    const declared = declarations(stripComments(CORE))
    const used = [
      ...references(stripComments(CORE)),
      ...ADAPTERS.flatMap(([, css]) => [...references(stripComments(css))]),
    ]
    for (const token of used) {
      expect(declared.has(token), `${token} is used but never declared in core.scss`).toBe(true)
    }
  })

  // An adapter OVERRIDES; it must never INTRODUCE. A token that exists only
  // there is a token the core cannot render without it, which is the failure the
  // whole split is meant to make impossible.
  it.each(ADAPTERS)('introduces no token of its own: %s', (name, css) => {
    const core = declarations(stripComments(CORE))
    for (const token of declarations(stripComments(css))) {
      expect(core.has(token), `${token} is declared only in ${name}`).toBe(true)
    }
  })

  /**
   * The load-bearing half of the cascade argument.
   *
   * The core's dark values come from `prefers-color-scheme`. Every host that
   * switches appearance by class or attribute — VitePress's `html.dark`,
   * Docusaurus's `[data-theme]` — lets a reader pin a site against their OS. So
   * every token the core darkens has to be re-declared UNCONDITIONALLY by the
   * adapter: a token left out keeps the OS-driven value and paints one dark
   * element into an otherwise light panel.
   */
  it.each(ADAPTERS)('re-declares every dark-scheme token unconditionally: %s', (name, css) => {
    const dark = declarations(blockAfter(stripComments(CORE), '@media (prefers-color-scheme: dark)'))
    expect(dark.size).toBeGreaterThan(5)
    const mapped = declarations(blockAfter(stripComments(css), ':root'))
    for (const token of dark) {
      expect(mapped.has(token), `${token} darkens in core.scss but ${name} does not map it`).toBe(true)
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
