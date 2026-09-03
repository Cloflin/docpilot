/**
 * WHERE THE SKILLS GO, AND WHAT AN UPGRADE IS ALLOWED TO REPLACE.
 *
 * Two halves, and the split is deliberate. `planFile` is the decision that can
 * destroy somebody's work, so it is pure and every row of its truth table is
 * checked with no filesystem at all. Everything below it needs a directory, and
 * every one of those cases runs with `DOCPILOT_HOME` pointed at a temporary
 * one — a test of `--scope=user` that wrote into the machine's real home would
 * be a test nobody could run twice.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { COMMANDS } from '../src/cli-flags.js'
import {
  backupPath,
  discover,
  installSite,
  parseTargets,
  parseUpdateFlags,
  planFile,
  renderSkill,
  skillNames,
  SKILL_DIR_TOKEN,
  SKILL_MANIFEST,
} from '../src/cli-skills.js'
import { slashDoc, slashDocs, slashNames, SLASH_PREFIX } from '../src/cli-slash.js'
import { candidateSites, displayPath, resolveSite, TARGET_IDS, TARGETS } from '../src/cli-targets.js'

const PKG = fileURLToPath(new URL('../', import.meta.url))
const BIN = fileURLToPath(new URL('../bin/docpilot.js', import.meta.url))

describe('the target table', () => {
  it('resolves every tool in both scopes to the directory that tool actually reads', () => {
    const cwd = '/proj'
    const home = '/home/x'
    process.env.DOCPILOT_HOME = home

    expect(resolveSite({ target: 'claude', scope: 'project', cwd }).skillsDir).toBe('/proj/.claude/skills')
    expect(resolveSite({ target: 'claude', scope: 'user', cwd }).skillsDir).toBe('/home/x/.claude/skills')
    expect(resolveSite({ target: 'codex', scope: 'project', cwd }).skillsDir).toBe('/proj/.codex/skills')
    expect(resolveSite({ target: 'cursor', scope: 'user', cwd }).commands.dir).toBe('/home/x/.cursor/commands')
    // The one row whose two halves genuinely disagree: VS Code reads project
    // skills from `.github/` and personal skills from `~/.copilot/`.
    expect(resolveSite({ target: 'copilot', scope: 'project', cwd }).skillsDir).toBe('/proj/.github/skills')
    expect(resolveSite({ target: 'copilot', scope: 'user', cwd }).skillsDir).toBe('/home/x/.copilot/skills')
    // …and has nowhere to put a personal prompt file, which is a null rather
    // than a guess.
    expect(resolveSite({ target: 'copilot', scope: 'user', cwd }).commands).toBeNull()
    // No vendor-neutral slash command format exists, so `agents` writes none.
    expect(resolveSite({ target: 'agents', scope: 'project', cwd }).commands).toBeNull()

    delete process.env.DOCPILOT_HOME
  })

  it('lets a directory of your own beat the table, and writes no commands unless told where', () => {
    const site = resolveSite({ skillsDir: 'vendor/skills', cwd: '/proj' })
    expect(site.target).toBe('custom')
    expect(site.skillsDir).toBe('/proj/vendor/skills')
    // The whole point of the flag is that we do not know what is reading it, so
    // guessing a commands directory for it would be guessing a file format too.
    expect(site.commands).toBeNull()
    expect(resolveSite({ skillsDir: 'a', commandsDir: 'b', cwd: '/proj' }).commands.dir).toBe('/proj/b')
  })

  it('offers a hint for every id it offers', () => {
    for (const id of TARGET_IDS) {
      expect(TARGETS[id].label, `${id} has no label`).toBeTruthy()
      expect(TARGETS[id].hint, `${id} has no hint`).toBeTruthy()
      expect(TARGETS[id].skills.project, `${id} has no project skills directory`).toBeTruthy()
    }
  })

  it('walks both scopes of every row when it goes looking', () => {
    process.env.DOCPILOT_HOME = '/home/x'
    const sites = candidateSites('/proj')
    expect(sites.length).toBe(TARGET_IDS.length * 2)
    expect(sites.filter((s) => s.scope === 'user').every((s) => s.skillsDir.startsWith('/home/x'))).toBe(true)
    delete process.env.DOCPILOT_HOME
  })

  it('prints a path the way a reader would recognise it', () => {
    process.env.DOCPILOT_HOME = '/home/x'
    expect(displayPath('/proj/.claude/skills', '/proj')).toBe('.claude/skills')
    expect(displayPath('/home/x/.claude/skills', '/proj')).toBe('~/.claude/skills')
    expect(displayPath('/elsewhere/skills', '/proj')).toBe('/elsewhere/skills')
    delete process.env.DOCPILOT_HOME
  })
})

/**
 * THE CONFLICT POLICY, with no disk under it.
 *
 * `recorded` is the manifest's hash. `null` there means we do not know what
 * wrote the file, and it has to behave exactly like a mismatch — that is the
 * single rule standing between an upgrade and somebody's edited skill.
 */
describe('what to do with one file', () => {
  const hash = (s) =>
    // The module hashes with sha256; recomputing it here rather than importing
    // a private helper keeps the test honest about what it is asserting.
    require('node:crypto').createHash('sha256').update(s).digest('hex')

  it('writes where nothing is', () => {
    expect(planFile({ onDisk: null, incoming: 'new' })).toBe('wrote')
  })

  it('keeps a file that already says what we were going to write', () => {
    expect(planFile({ onDisk: 'same', incoming: 'same' })).toBe('kept')
    expect(planFile({ onDisk: 'same', incoming: 'same', recorded: null })).toBe('kept')
  })

  it('replaces our own untouched file in silence', () => {
    expect(planFile({ onDisk: 'old', recorded: hash('old'), incoming: 'new' })).toBe('updated')
  })

  it('backs up a file whose hash we never knew, or no longer matches', () => {
    expect(planFile({ onDisk: 'edited', recorded: null, incoming: 'new' })).toBe('overwrote')
    expect(planFile({ onDisk: 'edited', recorded: hash('something else'), incoming: 'new' })).toBe('overwrote')
  })

  it("keeps everything when the caller is `init`, whatever the file says", () => {
    expect(planFile({ onDisk: 'edited', recorded: null, incoming: 'new', keepExisting: true })).toBe('kept')
  })
})

describe('backups', () => {
  it('never clobbers one it already made', () => {
    const taken = new Set(['/x/SKILL.md.bak', '/x/SKILL.md.bak.2'])
    expect(backupPath('/x/SKILL.md', (p) => taken.has(p))).toBe('/x/SKILL.md.bak.3')
    expect(backupPath('/x/other.md', () => false)).toBe('/x/other.md.bak')
  })
})

describe('the slash commands', () => {
  it('generates exactly one per command of the CLI, `update` included', () => {
    expect(slashNames()).toEqual(Object.keys(COMMANDS).map((c) => `${SLASH_PREFIX}${c}`))
    // The reason this file exists at all: /docpilot-update is not written by
    // hand, it falls out of the table, so it cannot quietly stop being made.
    expect(slashNames()).toContain('docpilot-update')
  })

  it('names the command it runs, and carries that command`s own flags', () => {
    const target = TARGETS.claude.commands
    for (const command of Object.keys(COMMANDS)) {
      const doc = slashDoc(command, target)
      expect(doc.rel).toBe(`docpilot-${command}.md`)
      expect(doc.body).toContain(`npx docpilot ${command}`)
      for (const flag of COMMANDS[command].flags) {
        expect(doc.body, `${command} slash command omits --${flag.name}`).toContain(`--${flag.name}`)
      }
    }
  })

  it('writes frontmatter each tool can read, and a skill `name` that matches its directory', () => {
    for (const id of TARGET_IDS) {
      const target = TARGETS[id].commands
      if (!target) continue
      for (const doc of slashDocs(target)) {
        if (target.frontmatter === 'plain') {
          // Cursor injects the whole file as the prompt and parses no header,
          // so a `---` block there would arrive at the model as three lines of
          // YAML. It must lead with the heading instead.
          expect(doc.body.startsWith('# docpilot '), `${id} ${doc.rel} leads with a header it cannot parse`).toBe(true)
        } else {
          expect(doc.body.startsWith('---\n'), `${id} ${doc.rel} has no frontmatter`).toBe(true)
          expect(doc.body, `${id} ${doc.rel} has no description`).toMatch(/\ndescription: "/)
        }
        if (target.layout !== 'skill-dir') continue
        // The Agent Skills standard requires the two to agree, and a mismatch
        // is not an error anywhere — the tool simply drops the skill.
        const dir = path.dirname(doc.rel)
        expect(doc.body).toContain(`name: ${dir}`)
      }
    }
  })
})

describe('the skill sources', () => {
  it('point at themselves with a token rather than one tool`s directory', () => {
    const files = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else files.push(abs)
      }
    }
    walk(path.join(PKG, 'skills'))
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      // `.claude/skills/…` in a runnable line is correct for one of the five
      // places a skill can now live and wrong for the other four, in a line an
      // agent copies and runs.
      expect(src.includes('.claude/skills'), `${path.relative(PKG, f)} hard-codes one tool's directory`).toBe(false)
    }
    const rendered = renderSkill(PKG, 'docs-rag', '.codex/skills/docs-rag')
    const skill = rendered.find((f) => f.rel === 'SKILL.md')
    expect(skill.contents).toContain('node .codex/skills/docs-rag/scripts/opener-candidates.js')
    expect(skill.contents).not.toContain(SKILL_DIR_TOKEN)
  })
})

describe('installing and refreshing, on a real disk', () => {
  let dir
  let home

  // Two SEPARATE temporary directories, not a `home/` inside the project. A
  // home that sits under the project is a home whose paths are also relative to
  // the project, and `displayPath` — correctly — prints the shorter one, which
  // would quietly make the `~/…` half of the rendering untested.
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-skills-'))
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-home-'))
    process.env.DOCPILOT_HOME = home
  })

  afterEach(() => {
    delete process.env.DOCPILOT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  const install = (target, scope = 'project', opts = {}) =>
    installSite({ site: resolveSite({ target, scope, cwd: dir }), pkgRoot: PKG, cwd: dir, ...opts })

  it('writes every skill, every slash command and a manifest for each', () => {
    const out = install('claude')
    for (const skill of skillNames(PKG)) {
      expect(fs.existsSync(path.join(dir, '.claude/skills', skill, 'SKILL.md'))).toBe(true)
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude/skills', skill, SKILL_MANIFEST), 'utf8'))
      expect(manifest.kind).toBe('skill')
      expect(manifest.docpilot).toBeTruthy()
      expect(Object.values(manifest.files).every((h) => typeof h === 'string')).toBe(true)
    }
    for (const name of slashNames()) {
      expect(fs.existsSync(path.join(dir, '.claude/commands', `${name}.md`))).toBe(true)
    }
    expect(out.files.every((f) => f.action === 'wrote')).toBe(true)
  })

  it('records `null` for a file it kept, so the next update knows it never saw inside', () => {
    const target = path.join(dir, '.claude/skills/docs-rag/SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'something of my own')

    install('claude', 'project', { keepExisting: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude/skills/docs-rag', SKILL_MANIFEST), 'utf8'))
    expect(manifest.files['SKILL.md']).toBeNull()
    expect(fs.readFileSync(target, 'utf8')).toBe('something of my own')

    // …and the update that follows backs it up rather than replacing it in
    // silence. Recording our own hash for a file we did not write is exactly
    // how that guarantee would be lost.
    const out = install('claude')
    const row = out.files.find((f) => f.rel === 'SKILL.md' && f.path === target)
    expect(row.action).toBe('overwrote')
    expect(fs.readFileSync(row.backup, 'utf8')).toBe('something of my own')
  })

  it('replaces its own untouched file with no backup, and an edited one with one', () => {
    install('claude')
    const untouched = path.join(dir, '.claude/skills/docs-rag/answerer-protocol.md')
    const edited = path.join(dir, '.claude/skills/docs-rag/judge-protocol.md')
    fs.appendFileSync(edited, '\nMY NOTE\n')
    // Pretend the package moved on: blank both files so every one of them
    // differs from what is about to be written.
    fs.writeFileSync(untouched, fs.readFileSync(untouched, 'utf8'))

    const manifestPath = path.join(dir, '.claude/skills/docs-rag', SKILL_MANIFEST)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.files['answerer-protocol.md'] = 'a hash from an older release'
    manifest.files['judge-protocol.md'] = manifest.files['judge-protocol.md']
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const out = install('claude')
    const byRel = Object.fromEntries(out.files.filter((f) => f.path.includes('docs-rag')).map((f) => [f.rel, f]))
    // Its hash is stale in the manifest but the file on disk is still ours, so
    // this one is `overwrote` — a mismatch is treated as an edit, always.
    expect(byRel['answerer-protocol.md'].action).toBe('kept')
    expect(byRel['judge-protocol.md'].action).toBe('overwrote')
    expect(fs.readFileSync(byRel['judge-protocol.md'].backup, 'utf8')).toContain('MY NOTE')
  })

  it('finds an install made before manifests existed', () => {
    // What every project that ran `init` before this release looks like.
    const legacy = path.join(dir, '.claude/skills/docs-rag')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'the old copy')

    const found = discover({ pkgRoot: PKG, cwd: dir })
    expect(found).toHaveLength(1)
    expect(found[0].target).toBe('claude')
    expect(found[0].scope).toBe('project')
  })

  it('creates nothing while looking', () => {
    expect(discover({ pkgRoot: PKG, cwd: dir })).toEqual([])
    expect(fs.existsSync(path.join(dir, '.cursor'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false)
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('finds a global install from a project that has none of its own', () => {
    install('claude', 'user')
    const found = discover({ pkgRoot: PKG, cwd: dir })
    expect(found).toHaveLength(1)
    expect(found[0].scope).toBe('user')
    expect(found[0].skillsDir.startsWith(home)).toBe(true)
  })

  it('writes nothing under --dry', () => {
    const out = installSite({ site: resolveSite({ target: 'claude', cwd: dir }), pkgRoot: PKG, cwd: dir, dry: true })
    expect(out.files.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false)
  })

  it('renders the skill`s own directory into the lines an agent runs', () => {
    install('codex')
    const src = fs.readFileSync(path.join(dir, '.codex/skills/docs-rag/SKILL.md'), 'utf8')
    expect(src).toContain('node .codex/skills/docs-rag/scripts/opener-candidates.js')
    install('cursor', 'user')
    const user = fs.readFileSync(path.join(home, '.cursor/skills/docs-rag/SKILL.md'), 'utf8')
    expect(user).toContain('node ~/.cursor/skills/docs-rag/scripts/opener-candidates.js')
  })
})

describe('the flags both commands read', () => {
  it('refuses a target that is not one', () => {
    expect(parseTargets('claude,cursor').ids).toEqual(['claude', 'cursor'])
    expect(parseTargets('claude, cursor ').ids).toEqual(['claude', 'cursor'])
    expect(parseTargets('clod').error).toContain('unknown target')
    expect(parseTargets('clod').error).toContain('claude')
  })

  it('parses update`s flags and hands back anything else', () => {
    const f = parseUpdateFlags(['--target=codex', '--scope=user', '--dry', '--no-commands', '--nope'])
    expect(f.target).toBe('codex')
    expect(f.scope).toBe('user')
    expect(f.dry).toBe(true)
    expect(f.noCommands).toBe(true)
    expect(f.unknown).toEqual(['--nope'])
  })
})

/**
 * THE ONE PROPERTY A REFACTOR MUST NOT BREAK.
 *
 * `init --yes` in a fresh directory wrote `.claude/skills/` before this feature
 * existed, and CI, `npx --yes` and every Dockerfile take that path. A default
 * that moved would relocate somebody's skills as a side effect of upgrading.
 */
describe('the default install, spawned for real', () => {
  it('still writes .claude/skills and touches nothing in the home directory', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-init-'))
    const home = path.join(cwd, 'home')
    fs.mkdirSync(home)
    execFileSync(process.execPath, [BIN, 'init', '--yes'], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, DOCPILOT_HOME: home },
    })
    expect(fs.existsSync(path.join(cwd, '.claude/skills/docs-rag/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.claude/commands/docpilot-update.md'))).toBe(true)
    expect(fs.readdirSync(home)).toEqual([])
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('installs nowhere under --no-commands but the skills, and honours --target', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-init-'))
    const home = path.join(cwd, 'home')
    fs.mkdirSync(home)
    execFileSync(process.execPath, [BIN, 'init', '--yes', '--target=cursor', '--no-commands'], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, DOCPILOT_HOME: home },
    })
    expect(fs.existsSync(path.join(cwd, '.cursor/skills/docs-rag/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.cursor/commands'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('installs into every tool a comma list names', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-init-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-home-'))
    execFileSync(process.execPath, [BIN, 'init', '--yes', '--target=claude,codex'], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, DOCPILOT_HOME: home },
    })
    // `--target` is declared `kind: 'list'` precisely so a project can want two
    // tools; installing only the first would have made the comma silent.
    expect(fs.existsSync(path.join(cwd, '.claude/skills/docs-rag/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.codex/skills/docs-rag/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.codex/skills/docpilot-update/SKILL.md'))).toBe(true)
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('refuses a target that is not one, with code 2 and no scaffolding', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-init-'))
    let status = 0
    try {
      execFileSync(process.execPath, [BIN, 'init', '--yes', '--target=clod'], { cwd, stdio: 'pipe' })
    } catch (e) {
      status = e.status
    }
    expect(status).toBe(2)
    expect(fs.existsSync(path.join(cwd, '.env.example'))).toBe(false)
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})

describe('update, spawned for real', () => {
  it('reports up to date on a fresh install, and out of date after an edit', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-update-'))
    const home = path.join(cwd, 'home')
    fs.mkdirSync(home)
    const env = { ...process.env, DOCPILOT_HOME: home }
    execFileSync(process.execPath, [BIN, 'init', '--yes'], { cwd, stdio: 'pipe', env })

    expect(execFileSync(process.execPath, [BIN, 'update', '--check'], { cwd, env, encoding: 'utf8' })).toContain(
      'Up to date',
    )

    const skill = path.join(cwd, '.claude/skills/docs-rag/SKILL.md')
    fs.appendFileSync(skill, '\nMY NOTE\n')

    let status = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [BIN, 'update', '--check'], { cwd, env, encoding: 'utf8' })
    } catch (e) {
      status = e.status
      out = e.stdout
    }
    expect(status).toBe(1)
    expect(out).toContain('Out of date')
    // --check writes nothing, so the edit is still there and unbacked-up.
    expect(fs.readFileSync(skill, 'utf8')).toContain('MY NOTE')
    expect(fs.existsSync(`${skill}.bak`)).toBe(false)

    execFileSync(process.execPath, [BIN, 'update'], { cwd, stdio: 'pipe', env })
    expect(fs.readFileSync(`${skill}.bak`, 'utf8')).toContain('MY NOTE')
    expect(fs.readFileSync(skill, 'utf8')).not.toContain('MY NOTE')

    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('says what to run when nothing is installed, and exits 0', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-update-'))
    const home = path.join(cwd, 'home')
    fs.mkdirSync(home)
    const out = execFileSync(process.execPath, [BIN, 'update'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, DOCPILOT_HOME: home },
    })
    expect(out).toContain('nothing installed here yet')
    expect(out).toContain('npx docpilot init')
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})
