/**
 * The bundle composition report (BNDL-01) — its INVARIANTS, never a size.
 *
 * `scripts/bundle-report.mjs` attributes every byte of the self-contained IIFE
 * to a contributor by decoding the bundle's own source map. What can go wrong
 * silently is the arithmetic: a decoder off by one segment, a multi-byte
 * character cut in half, a group the table forgot. Each of those leaves a report
 * that looks plausible and does not add up, so the thing worth holding is that
 * it does:
 *
 *   · contributor bytes + unmapped == the byte length of the output
 *   · every group the baseline names is present, a non-negative integer
 *   · the report is deterministic — no timestamp, two runs identical
 *
 * NO SIZE CEILING IS ASSERTED, here or anywhere in verify. Phase 8 will move
 * features out of this bundle and the number will fall; a budget is a decision
 * for that phase, taken with the table in front of it. A bundle that grew would
 * fail `npm run verify` for a reason that is not a defect.
 *
 * The build is in memory (`write: false`): this test touches nothing under dist/.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attribute, buildIife, contributorOf, GROUP_KEYS, groupOf, reportFor, UNMAPPED } from '../scripts/bundle-report.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('bundle report — the decoder', () => {
  it('partitions a hand-made map exactly, multi-byte characters included', () => {
    // line 0: "ab" — `a` from src a, `b` from src b; newline; line 1: "cd" from src b
    const map = { sources: ['a.js', 'b.js'], mappings: 'AAAA,CCAC;AAEA' }
    const bytes = attribute('ab\ncd', map)
    expect(Object.fromEntries(bytes)).toEqual({ 'a.js': 1, 'b.js': 3, [UNMAPPED]: 1 })

    // "€" is three bytes in UTF-8 and one UTF-16 unit; a surrogate pair is four bytes and two.
    const wide = attribute('€😀x', { sources: ['w.js'], mappings: 'AAAA' })
    expect(wide.get('w.js')).toBe(Buffer.byteLength('€😀x'))
    // A cut between the two halves of the pair still loses nothing.
    const cut = attribute('€😀x', { sources: ['w.js', 'v.js'], mappings: 'AAAA,ECAA' })
    expect([...cut.values()].reduce((a, b) => a + b, 0)).toBe(Buffer.byteLength('€😀x'))
  })

  it('names a contributor by package or by repo path', () => {
    expect(contributorOf('../node_modules/@shikijs/langs/dist/a.mjs')).toBe('@shikijs/langs')
    expect(contributorOf('../node_modules/.pnpm/x/node_modules/markdown-it/lib/index.mjs')).toBe('markdown-it')
    expect(contributorOf('../src/theme/components/Panel.vue?vue&type=script')).toBe('src/theme/components/Panel.vue')
  })

  it('files a module under the first group that claims it', () => {
    expect(groupOf('@vue/runtime-core')).toBe('vue')
    expect(groupOf('@shikijs/langs')).toBe('shiki')
    expect(groupOf('entities')).toBe('markdownIt')
    expect(groupOf('character-entities-html4')).toBe('shiki')
    expect(groupOf('minisearch')).toBe('minisearch')
    expect(groupOf('src/theme/docpilot/scope.ts')).toBe('optionalFeatures')
    expect(groupOf('src/theme/docpilot/session.ts')).toBe('panelRuntime')
    expect(groupOf('src/theme/components/Panel.vue')).toBe('panelComponents')
    expect(groupOf('src/mount.ts')).toBe('other')
    expect(groupOf(UNMAPPED)).toBe('unmapped')
  })
})

describe('bundle report — the real IIFE, built in memory', () => {
  let built
  let report

  beforeAll(async () => {
    built = await buildIife()
    report = reportFor({ ...built, meta: { builtFrom: { package: 'test', commit: null } } })
  }, 120000)

  it('attributes every byte: contributors plus unmapped equal the output length', () => {
    const length = Buffer.byteLength(built.code)
    const contributors = report.contributors.reduce((a, c) => a + c.bytes, 0)
    expect(report.totals.raw).toBe(length)
    expect(contributors + report.groups.unmapped).toBe(length)
    expect(Object.values(report.groups).reduce((a, b) => a + b, 0)).toBe(length)
  })

  it('has every group, each a non-negative integer, and the ones the bundle must contain are not empty', () => {
    expect(Object.keys(report.groups)).toEqual(GROUP_KEYS)
    for (const key of GROUP_KEYS) {
      expect(Number.isInteger(report.groups[key]), key).toBe(true)
      expect(report.groups[key], key).toBeGreaterThanOrEqual(0)
    }
    // A group that reads 0 here means the table stopped matching, not that the
    // feature is gone: the entry imports all of these unconditionally.
    for (const key of ['vue', 'shiki', 'markdownIt', 'minisearch', 'panelRuntime', 'panelComponents', 'optionalFeatures']) {
      expect(report.groups[key], key).toBeGreaterThan(0)
    }
  })

  it('reports compressed totals that are positive and smaller than the raw size', () => {
    for (const key of ['gzip', 'brotli']) {
      expect(Number.isInteger(report.totals[key]), key).toBe(true)
      expect(report.totals[key], key).toBeGreaterThan(0)
      expect(report.totals[key], key).toBeLessThan(report.totals.raw)
    }
  })

  it('has a stable schema and no timestamp', () => {
    expect(Object.keys(report)).toEqual(['schema', 'builtFrom', 'file', 'totals', 'groups', 'contributors', 'files', 'esm'])
    expect(report.schema).toBe(1)
    expect(Object.keys(report.totals)).toEqual(['raw', 'gzip', 'brotli'])
    for (const c of report.contributors) expect(Object.keys(c)).toEqual(['id', 'group', 'bytes', 'share'])
    expect(report.contributors.length).toBeGreaterThan(20)
    expect(report.files.length).toBeLessThanOrEqual(15)
    expect(JSON.stringify(report)).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('is deterministic: the same build gives the same report', () => {
    expect(reportFor({ ...built, meta: { builtFrom: { package: 'test', commit: null } } })).toEqual(report)
  })

  /**
   * THE READER'S BUNDLE CARRIES NO HTML PARSER (engine-spec 043, D-04).
   *
   * linkedom is a regular dependency since 3.0, installed on every consumer
   * machine, and that is exactly why the browser bundle needs a gate: the day a
   * build-side module reaches the entry, the parser and its closure ship to every
   * reader. `entities` is deliberately absent from the list: markdown-it ships its
   * own copy into the bundle, and scripts/bundle-report.mjs files it under
   * markdownIt. A contributor id for a repository file reads `src/<path>`.
   */
  it('carries no HTML parser module (D-04)', () => {
    const PARSER_MODULES = [
      'linkedom',
      'htmlparser2',
      'css-select',
      'css-what',
      'domhandler',
      'domutils',
      'dom-serializer',
      'domelementtype',
      'boolbase',
      'nth-check',
      '@acemir/cssom',
      'uhyphen',
      'html-escaper',
      'parse5',
    ]
    const ids = report.contributors.map((c) => c.id)
    expect(ids.filter((id) => PARSER_MODULES.includes(id)), 'a parser module is in the IIFE').toEqual([])
    expect(ids.filter((id) => id.includes('src/build/')), 'a build-side file is in the IIFE').toEqual([])
  })
})

describe('bundle report — the frozen 2.1.1 composition', () => {
  const file = path.join(ROOT, 'docpilot', 'baselines', 'bundle-2.1.1.json')

  it('is internally consistent', () => {
    const frozen = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(frozen.schema).toBe(1)
    expect(Object.keys(frozen.groups)).toEqual(GROUP_KEYS)
    expect(Object.values(frozen.groups).reduce((a, b) => a + b, 0)).toBe(frozen.totals.raw)
    const contributors = frozen.contributors.reduce((a, c) => a + c.bytes, 0)
    expect(contributors + frozen.groups.unmapped).toBe(frozen.totals.raw)
    expect(frozen.esm.length).toBeGreaterThan(1)
  })
})
