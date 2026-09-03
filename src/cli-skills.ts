/**
 * INSTALLING THE SKILLS, AND — the part that did not exist — REFRESHING THEM.
 *
 * `init` copied the skills with the same helper it copies `golden.jsonl` with:
 * write where nothing is, keep what is there, report both. That is the right
 * rule for an eval set, which is the reader's own work, and it is the wrong
 * rule for a skill, which is documentation shipped by this package. The
 * difference had a cost the docs already admitted: a project that ran `init`
 * once kept its copy of the skills across every upgrade that rewrote them, file
 * by file, so a skill directory could end up half of one release and half of
 * another with nothing on screen to say so. The agent went on quoting a
 * measurement that had been superseded, confidently.
 *
 * WHAT MAKES THE REFRESH SAFE IS THE MANIFEST. Beside every installed skill
 * sits `.docpilot.json`, holding the package version that wrote it and a
 * sha256 per file. That turns "you edited this" from a guess into a fact:
 *
 *   · the hash matches what is on disk  → we wrote it, nobody has touched it,
 *     overwriting loses nothing, so it is overwritten in silence.
 *   · the hash does not match, or is null → somebody edited it, or `init` kept
 *     a file it found and never knew what was in it. The old bytes are copied
 *     to `<file>.bak` BEFORE the write, and the report names the backup.
 *
 * `null` is the load-bearing half of that. `init` skips a file that already
 * exists, and recording the package's own hash for a file it did not write
 * would let a later `update` decide the reader's copy was ours and replace it
 * with no backup. Unknown provenance is written down as unknown.
 *
 * NOTHING IS EVER DELETED without being read first, and no `.bak` is ever
 * clobbered — `SKILL.md.bak`, then `.bak.2`. A local edit is usually a local
 * reason, and the whole policy is only defensible because the edit survives.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { askOne, askPath } from './cli-ask.js'
import { FAILED, OK, USAGE } from './cli-exit.js'
import { slashDocs } from './cli-slash.js'
import {
  candidateSites,
  DEFAULT_SCOPE,
  DEFAULT_TARGET,
  displayPath,
  resolveSite,
  SCOPES,
  TARGET_IDS,
  TARGETS,
} from './cli-targets.js'

/** The manifest beside a skill, and the one beside a directory of commands. */
export const SKILL_MANIFEST = '.docpilot.json'
export const COMMANDS_MANIFEST = '.docpilot-commands.json'

/**
 * The token the skill sources carry where a path to themselves used to be.
 *
 * `node .claude/skills/docs-rag/scripts/opener-candidates.js` was correct for
 * one of the five places a skill can now live and wrong for the other four, in
 * a line an agent copies and runs. The sources say `{{SKILL_DIR}}` and the
 * installer substitutes the directory it is writing to, as the reader would
 * type it — relative in a project, `~`-headed in a home directory.
 */
export const SKILL_DIR_TOKEN = '{{SKILL_DIR}}'

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** Every file under `dir`, as paths relative to it, depth first and sorted. */
function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs, base))
    else out.push(path.relative(base, abs).split(path.sep).join('/'))
  }
  return out
}

/** The package's own `skills/` directory, or null when it was not shipped. */
function skillsSource(pkgRoot) {
  const dir = path.join(pkgRoot, 'skills')
  return existsSync(dir) ? dir : null
}

/** `['docs-import', 'docs-rag']` — the skills this package carries. */
export function skillNames(pkgRoot) {
  const src = skillsSource(pkgRoot)
  if (!src) return []
  return readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** The installed version, read from the package this file was loaded from. */
export function packageVersion(pkgRoot) {
  try {
    return JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

/**
 * One skill's files, rendered for the directory they are about to live in.
 *
 * Rendering happens HERE and not at write time so that the hash written into
 * the manifest is the hash of the bytes that reached the disk. A manifest that
 * recorded the package's unrendered bytes would mark every file of every
 * non-default install as modified, and the first `update` would back up all of
 * them for nothing.
 */
export function renderSkill(pkgRoot, skill, skillDirDisplay) {
  const src = path.join(skillsSource(pkgRoot), skill)
  return walk(src).map((rel) => ({
    rel,
    contents: readFileSync(path.join(src, rel), 'utf8').split(SKILL_DIR_TOKEN).join(skillDirDisplay),
  }))
}

/**
 * WHAT TO DO WITH ONE FILE. The whole conflict policy, and no filesystem.
 *
 * Pure on purpose: this is the decision that can destroy somebody's work, and a
 * decision that needs a temporary directory to test is a decision that gets
 * tested once.
 *
 * @param recorded the manifest's hash for this file — `null` means we do not
 *   know what wrote it, which is treated exactly like a mismatch.
 * @param keepExisting `init`'s rule: never replace a file that is already
 *   there, whatever it says.
 */
export function planFile({ onDisk = null, recorded = null, incoming, keepExisting = false }) {
  if (onDisk === null) return 'wrote'
  if (onDisk === incoming) return 'kept'
  if (keepExisting) return 'kept'
  return recorded && recorded === sha256(onDisk) ? 'updated' : 'overwrote'
}

/**
 * `SKILL.md.bak`, then `.bak.2`, then `.bak.3`.
 *
 * A second `update` that overwrote the first one's backup would turn a policy
 * that preserves an edit into one that preserves only the most recent
 * overwrite, which is the failure this whole mechanism exists to avoid.
 */
export function backupPath(target, exists = existsSync) {
  const first = `${target}.bak`
  if (!exists(first)) return first
  for (let n = 2; n < 1000; n++) {
    const next = `${target}.bak.${n}`
    if (!exists(next)) return next
  }
  return `${target}.bak.${Date.now()}`
}

/** The manifest at `file`, or an empty one. Unreadable is the same as absent. */
function readManifest(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Apply one set of rendered files to one directory.
 *
 * @returns `{ rows, hashes }` — a report row per file, and the hashes the new
 *   manifest should carry. A file that was `kept` because it differs from ours
 *   gets `null`: we still do not know what is in it.
 */
function applyFiles({ dir, files, recorded, keepExisting, dry }) {
  const rows = []
  const hashes = {}

  for (const { rel, contents } of files) {
    const abs = path.join(dir, rel)
    const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    const action = planFile({ onDisk, recorded: recorded[rel] ?? null, incoming: contents, keepExisting })

    const row = { rel, path: abs, action, backup: null }
    hashes[rel] = action === 'kept' && onDisk !== contents ? null : sha256(contents)

    if (action !== 'kept' && !dry) {
      mkdirSync(path.dirname(abs), { recursive: true })
      if (action === 'overwrote') {
        row.backup = backupPath(abs)
        copyFileSync(abs, row.backup)
      }
      writeFileSync(abs, contents)
    } else if (action === 'overwrote' && dry) {
      row.backup = backupPath(abs)
    }

    rows.push(row)
  }

  return { rows, hashes }
}

/**
 * Files the manifest remembers writing that this release no longer ships.
 *
 * Removed when they are still exactly as we left them, and reported rather than
 * removed when they are not — a file somebody edited is a file somebody wanted,
 * even if the package has stopped shipping it.
 */
function retire({ dir, recorded, shipped, dry }) {
  const rows = []
  for (const [rel, hash] of Object.entries(recorded)) {
    if (shipped.has(rel)) continue
    const abs = path.join(dir, rel)
    if (!existsSync(abs)) continue
    const ours = hash && hash === sha256(readFileSync(abs, 'utf8'))
    if (ours && !dry) rmSync(abs)
    rows.push({ rel, path: abs, action: ours ? 'removed' : 'orphan', backup: null })
  }
  return rows
}

/**
 * One site — a skills directory, and the commands directory beside it.
 *
 * @param keepExisting `init`'s rule. `update` passes false.
 * @returns a `SiteOutcome`: what was found, what was done, and to what.
 */
export function installSite({
  site,
  pkgRoot,
  cwd = process.cwd(),
  commands = true,
  keepExisting = false,
  dry = false,
}) {
  const version = packageVersion(pkgRoot)
  const outcome = {
    target: site.target,
    scope: site.scope,
    skillsDir: site.skillsDir,
    commandsDir: site.commands?.dir ?? null,
    from: null,
    files: [],
  }

  if (site.skillsDir) {
    for (const skill of skillNames(pkgRoot)) {
      const dir = path.join(site.skillsDir, skill)
      const manifestPath = path.join(dir, SKILL_MANIFEST)
      const manifest = readManifest(manifestPath)
      if (manifest.docpilot && !outcome.from) outcome.from = manifest.docpilot

      const files = renderSkill(pkgRoot, skill, displayPath(dir, cwd))
      const { rows, hashes } = applyFiles({
        dir,
        files,
        recorded: manifest.files || {},
        keepExisting,
        dry,
      })
      const gone = retire({
        dir,
        recorded: manifest.files || {},
        shipped: new Set(files.map((f) => f.rel)),
        dry,
      })

      outcome.files.push(...rows, ...gone)
      if (!dry) {
        writeFileSync(
          manifestPath,
          `${JSON.stringify(
            {
              kind: 'skill',
              name: skill,
              docpilot: version,
              target: site.target,
              scope: site.scope,
              installedAt: new Date().toISOString(),
              files: hashes,
            },
            null,
            2,
          )}\n`,
        )
      }
    }
  }

  if (commands && site.commands) {
    const dir = site.commands.dir
    const manifestPath = path.join(dir, COMMANDS_MANIFEST)
    const manifest = readManifest(manifestPath)
    if (manifest.docpilot && !outcome.from) outcome.from = manifest.docpilot

    const files = slashDocs(site.commands).map((d) => ({ rel: d.rel, contents: d.body }))
    // Slash commands are generated in full from the flag table every time, so
    // `keepExisting` does not apply to them the way it applies to a skill: a
    // command file left at the previous release describes flags the CLI has
    // stopped taking, and an agent runs what it reads.
    const { rows, hashes } = applyFiles({ dir, files, recorded: manifest.files || {}, keepExisting: false, dry })
    const gone = retire({ dir, recorded: manifest.files || {}, shipped: new Set(files.map((f) => f.rel)), dry })

    outcome.files.push(...rows, ...gone)
    if (!dry) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            kind: 'commands',
            docpilot: version,
            target: site.target,
            scope: site.scope,
            installedAt: new Date().toISOString(),
            files: hashes,
          },
          null,
          2,
        )}\n`,
      )
    }
  }

  return outcome
}

/**
 * Every install already on this machine that we could refresh.
 *
 * A directory counts when it carries one of our manifests — or, for the
 * installs written before manifests existed, when it holds a skill of ours with
 * a `SKILL.md` in it. That second clause is the whole upgrade path for every
 * project that ran `init` before this release: without it, the first `update`
 * after upgrading would find nothing and say so.
 *
 * NOTHING IS CREATED HERE. A machine with no Cursor does not grow a `.cursor/`
 * because somebody ran `update` — only an explicit `--target=` does that.
 */
export function discover({ pkgRoot, cwd = process.cwd() }) {
  const known = skillNames(pkgRoot)
  const found = []

  for (const site of candidateSites(cwd)) {
    const hasSkills =
      site.skillsDir &&
      known.some((s) => {
        const dir = path.join(site.skillsDir, s)
        return existsSync(path.join(dir, SKILL_MANIFEST)) || existsSync(path.join(dir, 'SKILL.md'))
      })
    const hasCommands = site.commands && existsSync(path.join(site.commands.dir, COMMANDS_MANIFEST))
    if (!hasSkills && !hasCommands) continue

    found.push({
      ...site,
      skillsDir: hasSkills ? site.skillsDir : null,
      commands: hasCommands ? site.commands : null,
    })
  }

  // Codex writes its skills and its commands to ONE directory, so the same
  // physical path can be reached by two rows of the table. Deduplicate on what
  // is actually written rather than on the row that produced it.
  const seen = new Set()
  return found.filter((s) => {
    const key = `${s.skillsDir} ${s.commands?.dir ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * `--target=claude,cursor` — the ids, or a message naming the ones that are not.
 *
 * The comma list is why this is not an `enum` in the flag table: a project may
 * genuinely want two tools, and `enum` cannot say so. The cost is that the
 * typo check lives here instead, which is the same trade `--trigger` makes.
 */
export function parseTargets(raw) {
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const bad = ids.filter((id) => !TARGET_IDS.includes(id))
  if (bad.length) {
    return {
      error: `unknown target${bad.length === 1 ? '' : 's'}: ${bad.join(', ')} — one of: ${TARGET_IDS.join(', ')}`,
    }
  }
  return { ids }
}

/** The two questions, asked in that order. Shared by `init` and `update`. */
export const INSTALL_QUESTIONS = [
  {
    key: 'target',
    label: 'Which agent tool should get the DocPilot skills and /docpilot-* commands?',
    options: [...TARGET_IDS, 'other', 'none'],
    hints: {
      ...Object.fromEntries(TARGET_IDS.map((id) => [id, `${TARGETS[id].label} — ${TARGETS[id].hint}`])),
      other: 'a directory of your own; it will ask which',
      none: 'no skills, no commands — `npx docpilot update --target=…` installs them later',
    },
    default: DEFAULT_TARGET,
  },
  {
    key: 'scope',
    label: 'For this project, or for you on this machine?',
    options: [...SCOPES],
    hints: {
      project: 'in the repository, committed, so everyone who clones it gets them',
      user: 'in your home directory, so every project you open has them',
    },
    default: DEFAULT_SCOPE,
  },
]

/**
 * Ask the two questions, plus the directory when the answer was `other`.
 *
 * Takes an open readline rather than opening one: `init` already has one for
 * the placement questions, and two interfaces over one stdin is a prompt that
 * eats the answer to the other.
 */
export async function askInstall(rl, cwd = process.cwd()) {
  const target = await askOne(rl, INSTALL_QUESTIONS[0])
  if (target === 'none') return { target: null, scope: DEFAULT_SCOPE, skillsDir: null }

  if (target === 'other') {
    const dir = await askPath(rl, {
      label: 'Which directory? (one directory per skill is written inside it)',
      default: '.agents/skills',
    })
    return { target: null, scope: DEFAULT_SCOPE, skillsDir: path.resolve(cwd, dir) }
  }

  const scope = await askOne(rl, INSTALL_QUESTIONS[1])
  return { target, scope, skillsDir: null }
}

/** `[docpilot] updated  .claude/skills/docs-rag/SKILL.md` — one row. */
const VERB = {
  wrote: 'wrote   ',
  updated: 'updated ',
  kept: 'kept    ',
  overwrote: 'REPLACED',
  removed: 'removed ',
  orphan: 'left    ',
}

/**
 * The report. It is the entire interface of this command, so it says what
 * happened to every file and then, separately, the one thing a reader has to
 * act on: which of their edits were replaced and where those edits now are.
 */
export function report(outcomes, cwd = process.cwd()) {
  const lines = []
  const backups = []

  for (const site of outcomes) {
    const where = [site.skillsDir && displayPath(site.skillsDir, cwd), site.commandsDir && displayPath(site.commandsDir, cwd)]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join('  and  ')
    lines.push(`\n  ${site.target} (${site.scope})${site.from ? `  ${site.from} → ` : '  '}${where}`)

    for (const f of site.files) {
      const note =
        f.action === 'overwrote'
          ? `   (your copy kept as ${path.basename(f.backup)})`
          : f.action === 'orphan'
            ? '   (no longer shipped; you had edited it, so it stays)'
            : ''
      lines.push(`[docpilot] ${VERB[f.action]} ${displayPath(f.path, cwd)}${note}`)
      if (f.backup) backups.push(displayPath(f.backup, cwd))
    }
  }

  if (backups.length) {
    lines.push(
      '',
      `  ${backups.length} file${backups.length === 1 ? '' : 's'} you had edited ${backups.length === 1 ? 'was' : 'were'} replaced. Your version${backups.length === 1 ? ' is' : 's are'} beside ${backups.length === 1 ? 'it' : 'them'}:`,
      '',
      ...backups.map((b) => `    ${b}`),
      '',
      '  Diff them before deleting them — a local edit is usually a local reason.',
    )
  }

  return lines.join('\n')
}

/** True when anything would change on disk. What `--check` reports. */
const stale = (outcomes) =>
  outcomes.some((s) => s.files.some((f) => f.action !== 'kept' && f.action !== 'orphan'))

/**
 * `npx docpilot update` — refresh what is installed, from the installed package.
 *
 * Dispatched beside `init` rather than with the commands below it, because like
 * `init` it needs no config, no key and no network: an upgrade should be
 * refreshable in a checkout that has not been configured yet.
 */
export async function runUpdate({ argv = [], cwd = process.cwd(), pkgRoot = null } = {}) {
  const flags = parseUpdateFlags(argv)
  if (flags.unknown.length) {
    console.error(`[docpilot] unknown option${flags.unknown.length === 1 ? '' : 's'}: ${flags.unknown.join(' ')}`)
    console.error('  npx docpilot update --help  lists what it takes')
    return USAGE
  }
  if (flags.scope && !SCOPES.includes(flags.scope)) {
    console.error(`[docpilot] --scope=${flags.scope} is not one of: ${SCOPES.join(', ')}`)
    return USAGE
  }

  const dry = flags.dry || flags.check
  let sites = []

  if (flags.target || flags.skillsDir || flags.commandsDir) {
    if (flags.target) {
      const parsed = parseTargets(flags.target)
      if (parsed.error) {
        console.error(`[docpilot] ${parsed.error}`)
        return USAGE
      }
      sites = parsed.ids.map((id) => resolveSite({ target: id, scope: flags.scope || DEFAULT_SCOPE, cwd }))
    } else {
      sites = [
        resolveSite({
          scope: flags.scope || DEFAULT_SCOPE,
          skillsDir: flags.skillsDir,
          commandsDir: flags.commandsDir,
          cwd,
        }),
      ]
    }
  } else {
    sites = discover({ pkgRoot, cwd })
    if (flags.scope) sites = sites.filter((s) => s.scope === flags.scope)
  }

  if (!sites.length) {
    console.log('[docpilot] nothing installed here yet.')
    console.log('  npx docpilot init                 scaffolds a project and asks where the skills go')
    console.log(`  npx docpilot update --target=${DEFAULT_TARGET}  installs them without asking`)
    return OK
  }

  let outcomes
  try {
    outcomes = sites.map((site) =>
      installSite({ site, pkgRoot, cwd, commands: !flags.noCommands, keepExisting: false, dry }),
    )
  } catch (err) {
    console.error(`[docpilot] ${err?.message || err}`)
    return FAILED
  }

  console.log(report(outcomes, cwd))

  if (flags.check) {
    const out = stale(outcomes)
    console.log(out ? '\n  Out of date. `npx docpilot update` writes it.' : '\n  Up to date.')
    return out ? FAILED : OK
  }
  if (dry) console.log('\n  --dry: nothing was written.')
  return OK
}

/**
 * `update`'s flags, parsed here rather than by `flagErrors`.
 *
 * The same split `init` makes: the table in `src/cli-flags.ts` owns the help
 * and the documentation gate, and the command owns the reading, because
 * `--target` is a comma list whose members this module is the only one that
 * knows.
 */
export function parseUpdateFlags(argv = []) {
  const out = {
    target: null,
    scope: null,
    skillsDir: null,
    commandsDir: null,
    noCommands: false,
    dry: false,
    check: false,
    unknown: [],
  }
  for (const arg of argv) {
    // No `--yes` here, unlike `init`: `update` never asks a question, so there
    // is nothing for it to answer. A flag that exists only to be symmetrical is
    // a flag somebody passes and then wonders what it did.
    if (arg === '--dry') out.dry = true
    else if (arg === '--check') out.check = true
    else if (arg === '--no-commands') out.noCommands = true
    else {
      const m = /^--(target|scope|skills-dir|commands-dir)=(.*)$/.exec(arg)
      if (!m) out.unknown.push(arg)
      else if (m[1] === 'skills-dir') out.skillsDir = m[2]
      else if (m[1] === 'commands-dir') out.commandsDir = m[2]
      else out[m[1]] = m[2]
    }
  }
  return out
}
