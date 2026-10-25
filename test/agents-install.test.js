/**
 * The tuning agents ship with the skills — engine-spec 036. `init` writes them
 * into `.claude/agents/` with the skills path filled in, `update` refreshes them
 * and backs up an edited one, and no other target grows the directory.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve('bin/docpilot.js')

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-agents-'))
  fs.writeFileSync(path.join(root, 'docpilot.config.mjs'), "export const docPilot = { product: 'Acme' }\nexport default {}\n")
  return root
}
const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, DOCPILOT_HOME: cwd } })

describe('the tuning agents', () => {
  it('init installs both, pointing at the installed docs-tune skill', () => {
    const root = project()
    expect(run(root, 'init', '--yes').status).toBe(0)
    const tuner = fs.readFileSync(path.join(root, '.claude', 'agents', 'docpilot-tuner.md'), 'utf8')
    expect(tuner).toMatch(/^---\nname: docpilot-tuner\n/)
    expect(tuner).toContain('.claude/skills/docs-tune/SKILL.md')
    expect(tuner).not.toContain('{{SKILLS_DIR}}')
    expect(fs.existsSync(path.join(root, '.claude', 'agents', 'docpilot-writer.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'docs-tune', 'SKILL.md'))).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'agents', '.docpilot-agents.json'), 'utf8'))
    expect(Object.keys(manifest.files).sort()).toEqual(['docpilot-tuner.md', 'docpilot-writer.md'])
  })

  it('update backs up an agent the reader edited before replacing it', () => {
    const root = project()
    run(root, 'init', '--yes')
    const file = path.join(root, '.claude', 'agents', 'docpilot-tuner.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('effort: medium', 'effort: low'))
    expect(run(root, 'update').status).toBe(0)
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toContain('effort: low')
    expect(fs.readFileSync(file, 'utf8')).toContain('effort: medium')
  })

  it('a target that does not read subagents gets none', () => {
    const root = project()
    expect(run(root, 'init', '--yes', '--target=cursor').status).toBe(0)
    expect(fs.existsSync(path.join(root, '.claude', 'agents'))).toBe(false)
    expect(fs.existsSync(path.join(root, '.cursor', 'skills', 'docs-tune', 'SKILL.md'))).toBe(true)
  })
})
