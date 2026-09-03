import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CONFIG_CANDIDATES,
  findConfig,
  parseUiFlags,
  validateUi,
  uiSnippet,
  UI_QUESTIONS,
  UI_PANELS,
  UI_TRIGGER_WORD_LIST,
} from '../src/cli-init.js'

/**
 * `init` is the one command that runs before anything is configured, so its
 * decisions are the ones with the least context to fall back on. They are here
 * rather than inside `bin/docpilot.js` precisely so they can be run without a
 * terminal, a project, or a scaffolding pass over someone's disk.
 */
describe('init helpers', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-init-'))

  /**
   * Six places now, not four: `docpilot.config.mjs` and its `.js` sibling were
   * appended so that `npx docpilot index` works on a project with no VitePress —
   * until then every command exited there, and the documented workaround was to
   * create a `.vitepress/` directory for a generator the project does not use.
   */
  it('finds a config in any of the documented places, and returns null otherwise', () => {
    for (const candidate of CONFIG_CANDIDATES) {
      const dir = tmp()
      fs.mkdirSync(path.join(dir, path.dirname(candidate)), { recursive: true })
      fs.writeFileSync(path.join(dir, candidate), 'export const docPilot = {}\n')
      expect(findConfig(dir), candidate).toBe(candidate)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // Null, NOT an exit: `init` in a fresh directory still has an eval set and
    // two skills to scaffold, and the placement questions are the only part
    // that needs a config to be worth asking.
    const empty = tmp()
    expect(findConfig(empty)).toBe(null)
    fs.rmSync(empty, { recursive: true, force: true })
  })

  /**
   * ORDER IS A CONTRACT. A VitePress project must keep resolving to its own
   * config, because that file is where the `docPilot` export already lives and
   * where the site build reads it from — the CLI and the build reading the same
   * object is what stops the index and the runtime drifting onto different
   * embedders. A `docpilot.config.mjs` sitting beside it must not win.
   */
  it('prefers the VitePress config when a project has both', () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'docs/.vitepress'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs/.vitepress/config.mjs'), 'export const docPilot = {}\n')
    fs.writeFileSync(path.join(dir, 'docpilot.config.mjs'), 'export const docPilot = {}\n')
    expect(findConfig(dir)).toBe('docs/.vitepress/config.mjs')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('parses the placement flags, the install flags, and hands back anything else', () => {
    expect(parseUiFlags(['--trigger=fab', '--panel=popup', '--yes'])).toEqual({
      ui: { trigger: 'fab', panel: 'popup' },
      install: {},
      yes: true,
      unknown: [],
    })
    expect(parseUiFlags(['-y'])).toEqual({ ui: {}, install: {}, yes: true, unknown: [] })
    expect(parseUiFlags([])).toEqual({ ui: {}, install: {}, yes: false, unknown: [] })
    /**
     * WHERE the skills go is a separate bag from WHAT the panel looks like.
     *
     * `ui` is handed whole to `validateUi`, which is the resolver the browser
     * itself runs; a `--scope` in that object would reach the panel's validator
     * as a setting the panel has never heard of.
     */
    expect(
      parseUiFlags(['--target=claude,cursor', '--scope=user', '--skills-dir=x', '--commands-dir=y', '--no-commands'])
        .install,
    ).toEqual({ target: 'claude,cursor', scope: 'user', skillsDir: 'x', commandsDir: 'y', commands: false })
    // Not silently ignored — the CLI stops on it, because a misspelled flag
    // that scaffolds anyway is a placement the author thinks they chose.
    expect(parseUiFlags(['--colour=red']).unknown).toEqual(['--colour=red'])
    // `trigger` is a LIST, so the flag can say one — otherwise it would be the
    // one place a project could not express what the setting supports.
    expect(parseUiFlags(['--trigger=nav,fab']).ui).toEqual({ trigger: ['nav', 'fab'] })
    expect(parseUiFlags(['--trigger=nav, fab ']).ui).toEqual({ trigger: ['nav', 'fab'] })
    // No comma is still a WORD, so `--trigger=nav` keeps carrying the mobile
    // nav-screen row with it the way the word always has.
    expect(parseUiFlags(['--trigger=nav']).ui).toEqual({ trigger: 'nav' })
  })

  it('validates through resolveUi and keeps `auto` as `auto`', () => {
    const said = []
    expect(validateUi({ trigger: 'fab', panel: 'auto' }, (m) => said.push(m))).toEqual({
      trigger: 'fab',
      panel: 'auto',
    })
    expect(said).toEqual([])
    // One validator for the whole codebase: the CLI complains in the resolver's
    // words, and falls back to the same defaults the build would.
    expect(validateUi({ trigger: 'sidebar', panel: 'sheet' }, (m) => said.push(m))).toEqual({
      trigger: 'fab',
      panel: 'auto',
    })
    expect(said).toHaveLength(2)
  })

  /**
   * The WORD survives; the LIST is written back resolved.
   *
   * `'nav'` resolves to two placements, and writing `['nav','screen']` into
   * somebody's config would read as the tool second-guessing the answer they
   * gave — and would pin the expansion, so a later release that gave the word a
   * third placement would skip every config this command had ever written.
   */
  it('keeps the word a word and the list a list', () => {
    const said = []
    const v = (raw) => validateUi(raw, (m) => said.push(m))
    expect(v({ trigger: 'nav' }).trigger).toBe('nav')
    expect(v({ trigger: 'both' }).trigger).toBe('both')
    expect(v({ trigger: 'none' }).trigger).toBe('none')
    // Sorted and filtered by the resolver — the list they typed, minus anything
    // that was not a placement.
    expect(v({ trigger: ['fab', 'nav'] }).trigger).toEqual(['nav', 'fab'])
    expect(said).toEqual([])
    expect(v({ trigger: ['fab', 'sidebar'] }).trigger).toEqual(['fab'])
    expect(said).toHaveLength(1)
  })

  it('writes a pasteable block for every combination', () => {
    for (const trigger of UI_TRIGGER_WORD_LIST) {
      for (const panel of UI_PANELS) {
        const out = uiSnippet({ trigger, panel }, 'docs/.vitepress/config.mjs')
        expect(out).toContain(`trigger: '${trigger}',`)
        expect(out).toContain(`panel: '${panel}',`)
        expect(out).toContain('docs/.vitepress/config.mjs')
        // The last line is the promise `init` has always kept.
        expect(out).toContain('does not edit your config')
      }
    }
  })

  it('says so when the answer is the default, and still shows it', () => {
    const out = uiSnippet({ trigger: 'fab', panel: 'auto' }, 'docs/.vitepress/config.mjs')
    expect(out).toContain('the shipped default')
    expect(out).toContain("trigger: 'fab',")
    // And the other branch: an answer that is NOT the shipped pair says where
    // to put it instead.
    const chosen = uiSnippet({ trigger: 'nav', panel: 'auto' }, null)
    expect(chosen).toContain('your `docPilot` settings')
    expect(chosen).not.toContain('the shipped default')
  })

  // A list is written as a list — valid JavaScript in the block the reader
  // pastes, which is the only thing the snippet has ever promised.
  it('writes a list as an array literal', () => {
    const out = uiSnippet({ trigger: ['nav', 'fab'], panel: 'popup' }, null)
    expect(out).toContain("trigger: ['nav', 'fab'],")
    expect(out).not.toContain('the shipped default')
  })

  it('offers exactly the values the resolver accepts', () => {
    const byKey = Object.fromEntries(UI_QUESTIONS.map((q) => [q.key, q]))
    /**
     * WORDS, and a subset of them — `UI_TRIGGERS` is the placement list, and
     * `'screen'` alone is not an answer anybody means: it is the mobile half of
     * the navbar button, and choosing it on its own leaves a desktop reader with
     * nothing to press. `'all'` is left out as a synonym of `'both'`.
     *
     * What IS asserted is that every option offered is a word the resolver
     * accepts, which is the property the question actually depends on.
     */
    expect(byKey.trigger.options).toEqual(['nav', 'fab', 'both', 'none'])
    for (const o of byKey.trigger.options) expect(UI_TRIGGER_WORD_LIST).toContain(o)
    expect(byKey.panel.options).toEqual(UI_PANELS)
    // A question with an option nobody explained is a question nobody can
    // answer; the defaults have to be offerable too.
    for (const q of UI_QUESTIONS) {
      expect(q.options).toContain(q.default)
      for (const o of q.options) expect(q.hints[o], `${q.key}.${o}`).toBeTruthy()
    }
  })
})
/**
 * The scaffold `init` writes, checked by RUNNING it.
 *
 * The three golden records live inline in `bin/docpilot.js` and are not
 * importable, so the only honest way to assert anything about them is to
 * scaffold a throwaway project and read the file back. That also covers the two
 * things that break silently: `JSON.stringify` per line is the whole of what
 * makes the file JSONL, and a `level` typo costs nothing until somebody runs
 * `docpilot lint` on a project they created ten seconds earlier.
 *
 * Everything is imported dynamically so the block stands on its own.
 */
describe('docpilot CLI: scaffolded levels and the command tables', () => {
  const scaffold = async () => {
    const { execFileSync } = await import('node:child_process')
    const fs = (await import('node:fs')).default
    const os = (await import('node:os')).default
    const path = (await import('node:path')).default
    const { fileURLToPath } = await import('node:url')

    const bin = fileURLToPath(new URL('../bin/docpilot.js', import.meta.url))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-scaffold-'))
    // A fresh directory has no config, so `init` skips the placement questions
    // and never reads stdin; `--yes` holds that even if one ever appears.
    execFileSync(process.execPath, [bin, 'init', '--yes'], { cwd: dir, stdio: 'pipe' })
    const raw = fs.readFileSync(path.join(dir, 'docpilot/golden.jsonl'), 'utf8')
    fs.rmSync(dir, { recursive: true, force: true })
    return raw
  }

  const records = async () =>
    (await scaffold())
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))

  /**
   * JSONL, not "a JSON file with newlines in it". run.js, lint-golden.js and
   * answer-bench.js all read this file one line at a time, so a record that
   * pretty-printed itself across three lines is three parse failures in a
   * project whose author has not written a record of their own yet.
   */
  it('scaffolds a golden file that parses line by line, and ends with a newline', async () => {
    const raw = await scaffold()
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['q-01', 'q-02', 'n-01'])
  })

  /**
   * `hasOwn` before `LEVELS.includes`, and deliberately NOT through
   * `recordLevel`: an absent field reads as `high` there, so a record that lost
   * its `level` would satisfy every membership check ever written while quietly
   * dropping out of the smoke pool it was scaffolded into.
   */
  it('gives every scaffolded record a level that is one of the six', async () => {
    const { LEVELS } = await import('../src/eval/levels.js')
    const recs = await records()
    for (const r of recs) {
      expect(Object.hasOwn(r, 'level'), r.id).toBe(true)
      expect(LEVELS, r.id).toContain(r.level)
    }
    expect(recs.map((r) => r.level)).toEqual(['low', 'medium', 'low'])
  })

  /**
   * The negative is in the SMALLEST pool on purpose. A smoke set of two
   * answerable questions measures how often the model answers, which is the one
   * number a broken gate also improves — so `--level=low` on a fresh project has
   * to be able to fail for the right reason on day one.
   */
  it('puts a refusal in the smoke pool, so the fastest tier can fail', async () => {
    const { filterByLevel } = await import('../src/eval/levels.js')
    const smoke = filterByLevel(await records(), 'low')
    expect(smoke.some((r) => String(r.expect).startsWith('refuse:'))).toBe(true)
    expect(smoke.some((r) => r.expect === 'answer')).toBe(true)
  })

  /**
   * The tiers nest, and the scaffold is the first thing anyone points `--level`
   * at — the cheapest place for a broken subset relation to surface. `ultra` and
   * no flag at all must both be the whole file.
   */
  it('scaffolds pools that nest, low inside medium inside ultra', async () => {
    const { filterByLevel, LEVELS } = await import('../src/eval/levels.js')
    const recs = await records()
    const idsAt = (level) => filterByLevel(recs, level).map((r) => r.id)

    expect(idsAt('low')).toEqual(['q-01', 'n-01'])
    expect(idsAt('medium')).toEqual(['q-01', 'q-02', 'n-01'])
    // Nothing is scaffolded at `high` or above, so every tier from `medium` up
    // is the same three records — and no pool may LOSE one as it grows.
    for (const level of LEVELS.slice(LEVELS.indexOf('medium'))) {
      expect(idsAt(level), level).toEqual(['q-01', 'q-02', 'n-01'])
    }
    expect(filterByLevel(recs, undefined)).toHaveLength(3)
  })

  /**
   * `docpilot lint` is the gate these records have to pass: it errors on an
   * unknown `level` and warns on an absent one. A scaffold that trips the
   * project's own linter on the first run is the worst first impression the tool
   * can make, so both of lint's rules are asserted here rather than left to a
   * consumer who happens to run `init && lint`.
   */
  it('scaffolds records docpilot lint has nothing to say about', async () => {
    const { levelRank } = await import('../src/eval/levels.js')
    for (const r of await records()) {
      expect(r.level == null, r.id).toBe(false)
      expect(levelRank(r.level), r.id).toBeGreaterThanOrEqual(0)
    }
  })

  /**
   * The launcher's two tables have to agree, or a command is either listed and
   * unrunnable or runnable and undocumented. Read as source text rather than
   * imported, because `bin/docpilot.js` loads a project config and exits at
   * module scope — importing it from a test would end the test run.
   */
  const launcher = async () => {
    const fs = (await import('node:fs')).default
    const { fileURLToPath } = await import('node:url')
    return fs.readFileSync(fileURLToPath(new URL('../bin/docpilot.js', import.meta.url)), 'utf8')
  }

  it('lists tune in COMMANDS and routes it in ENTRY', async () => {
    const src = await launcher()
    // Listed: the unknown-command error prints COMMANDS verbatim, so a command
    // missing here is one the error swears does not exist while it runs fine.
    expect(src).toMatch(/const COMMANDS = \[[^\]]*'tune',[^\]]*\]/s)
    // Routed: without this line `docpilot tune` dies of ERR_MODULE_NOT_FOUND on
    // `undefined` instead of saying anything a reader can act on.
    expect(src).toMatch(/tune: '\.\.\/dist\/eval\/tune\.js'/)
  })

  it('spells the six tiers out in the help, in levels.js order', async () => {
    const { LEVELS } = await import('../src/eval/levels.js')
    // The help is the only documentation most readers see, and a tier list that
    // has drifted from levels.js sends them to a `--level` the parser rejects.
    expect(await launcher()).toContain(`--level=${LEVELS.join('|')}`)
  })
})

