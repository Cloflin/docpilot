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
  UI_TRIGGERS,
} from '../src/cli-init.js'

/**
 * `init` is the one command that runs before anything is configured, so its
 * decisions are the ones with the least context to fall back on. They are here
 * rather than inside `bin/docpilot.js` precisely so they can be run without a
 * terminal, a project, or a scaffolding pass over someone's disk.
 */
describe('init helpers', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-init-'))

  it('finds a config in any of the four documented places, and returns null otherwise', () => {
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

  it('parses the three flags and hands back anything else', () => {
    expect(parseUiFlags(['--trigger=fab', '--panel=popup', '--yes'])).toEqual({
      ui: { trigger: 'fab', panel: 'popup' },
      yes: true,
      unknown: [],
    })
    expect(parseUiFlags(['-y'])).toEqual({ ui: {}, yes: true, unknown: [] })
    expect(parseUiFlags([])).toEqual({ ui: {}, yes: false, unknown: [] })
    // Not silently ignored — the CLI stops on it, because a misspelled flag
    // that scaffolds anyway is a placement the author thinks they chose.
    expect(parseUiFlags(['--colour=red']).unknown).toEqual(['--colour=red'])
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
      trigger: 'nav',
      panel: 'auto',
    })
    expect(said).toHaveLength(2)
  })

  it('writes a pasteable block for every combination', () => {
    for (const trigger of UI_TRIGGERS) {
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
    const out = uiSnippet({ trigger: 'nav', panel: 'auto' }, 'docs/.vitepress/config.mjs')
    expect(out).toContain('the shipped default')
    expect(out).toContain("trigger: 'nav',")
    expect(uiSnippet({ trigger: 'fab', panel: 'auto' }, null)).toContain('your `docPilot` settings')
  })

  it('offers exactly the values the resolver accepts', () => {
    const byKey = Object.fromEntries(UI_QUESTIONS.map((q) => [q.key, q]))
    expect(byKey.trigger.options).toEqual(UI_TRIGGERS)
    expect(byKey.panel.options).toEqual(UI_PANELS)
    // A question with an option nobody explained is a question nobody can
    // answer; the defaults have to be offerable too.
    for (const q of UI_QUESTIONS) {
      expect(q.options).toContain(q.default)
      for (const o of q.options) expect(q.hints[o], `${q.key}.${o}`).toBeTruthy()
    }
  })
})
