/**
 * WHERE A SKILL CAN GO — the table, and nothing else.
 *
 * `init` used to write the skills to `.claude/skills/` and only there
 * (`src/cli-init.ts`, before this file existed). That was right for exactly as
 * long as Claude Code was the only reader: Agent Skills is now an open standard
 * — a directory per skill, a `SKILL.md` inside it, `name` and `description` in
 * its frontmatter — and Codex, Cursor and Copilot all discover the same shape
 * from their own directories. A package that copies into one of the four
 * reaches a quarter of the people who installed it.
 *
 * SO THE DIRECTORIES BECOME DATA. Every path this package will ever write a
 * skill or a slash command to is in `TARGETS` below, and the two commands that
 * write them — `init` and `update` — read it rather than spelling a path. A
 * tool that moves its directory is one row of a table, not a grep.
 *
 * PURE, AND NOTHING IS RESOLVED AT MODULE SCOPE. `homeDir()` is a function
 * rather than a constant for the same reason `src/cli-ask.ts` resolves nothing
 * at load: a test has to be able to move `HOME` without reloading the module,
 * and a launcher has to be able to import this before it has loaded a config.
 */
import os from 'node:os'
import path from 'node:path'

/**
 * `~`, with a seam.
 *
 * `DOCPILOT_HOME` is not a feature for readers and is not documented as one —
 * it is what lets the test suite exercise `--scope=user` against a temporary
 * directory. Without it every test of the user scope would either write into
 * the machine's real home or not run at all, and the second is what usually
 * happens: the global install path stays untested, and the first bug in it is
 * found by somebody's `~/.claude/` being rewritten.
 */
export function homeDir() {
  return process.env.DOCPILOT_HOME || os.homedir()
}

/**
 * THE TABLE. One row per agent tool.
 *
 * `skills` is where a skill directory goes. `commands` is where a slash command
 * goes, and it is a SEPARATE root on three of the four rows — Copilot reads
 * skills from `.github/skills/` and prompts from `.github/prompts/`, Cursor
 * reads `.cursor/skills/` and `.cursor/commands/`. Only Codex puts both in one
 * place, which is why `layout` exists.
 *
 * `layout: 'skill-dir'` means the tool has no separate command file format: its
 * slash commands ARE skills, so a generated command is written as
 * `<dir>/docpilot-index/SKILL.md` with `user-invocable: true`. Codex is that
 * row. Its `~/.codex/prompts/` directory would also work and is what the
 * documentation used to show, but it is deprecated in favour of skills and a
 * package should not scaffold somebody into a deprecated location.
 *
 * `commands.user: null` on Copilot is not an oversight — VS Code reads personal
 * skills from `~/.copilot/skills/` but has no personal prompt-file directory,
 * so a `--scope=user --target=copilot` install writes skills and says, in the
 * report, that it wrote no commands and why.
 *
 * `agents` is the vendor-neutral spelling of the standard. Cursor and Copilot
 * both read it; Claude Code does not. It is offered for the project that wants
 * one directory rather than four, and it has no commands of its own because
 * there is no vendor-neutral slash command format to write.
 */
export const TARGETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    hint: '.claude/skills/ — and /docpilot-* commands in .claude/commands/',
    skills: { project: '.claude/skills', user: '.claude/skills' },
    commands: {
      project: '.claude/commands',
      user: '.claude/commands',
      layout: 'file',
      ext: '.md',
      frontmatter: 'claude',
      argsToken: '$ARGUMENTS',
    },
  },

  codex: {
    id: 'codex',
    label: 'Codex CLI',
    hint: '.codex/skills/ — where a slash command IS a skill',
    skills: { project: '.codex/skills', user: '.codex/skills' },
    commands: {
      project: '.codex/skills',
      user: '.codex/skills',
      layout: 'skill-dir',
      ext: '.md',
      frontmatter: 'skill',
      argsToken: '$ARGUMENTS',
    },
  },

  cursor: {
    id: 'cursor',
    label: 'Cursor',
    hint: '.cursor/skills/ — and /docpilot-* commands in .cursor/commands/',
    skills: { project: '.cursor/skills', user: '.cursor/skills' },
    commands: {
      project: '.cursor/commands',
      user: '.cursor/commands',
      layout: 'file',
      ext: '.md',
      frontmatter: 'plain',
      argsToken: '$ARGUMENTS',
    },
  },

  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot (VS Code)',
    hint: '.github/skills/ — and prompt files in .github/prompts/',
    // The personal root is NOT `~/.github/`: VS Code reads personal skills from
    // `~/.copilot/skills/`, and the project root from `.github/skills/`. The
    // two halves of this row genuinely disagree, which is why `skills` holds
    // two strings rather than one.
    skills: { project: '.github/skills', user: '.copilot/skills' },
    commands: {
      project: '.github/prompts',
      user: null,
      layout: 'file',
      ext: '.prompt.md',
      frontmatter: 'prompt',
      argsToken: '${input:args}',
    },
  },

  agents: {
    id: 'agents',
    label: 'Any tool that reads the open standard',
    hint: '.agents/skills/ — read by Cursor and Copilot; no slash commands',
    skills: { project: '.agents/skills', user: '.agents/skills' },
    commands: null,
  },
}

/** The ids, in the order the prompt offers them. */
export const TARGET_IDS = Object.keys(TARGETS)

/** The two scopes, named once so a flag and a question cannot disagree. */
export const SCOPES = ['project', 'user']

/**
 * The default, and the reason it is this one.
 *
 * Every install before this file existed went to `.claude/skills/` in the
 * project. `init --yes`, a CI run and a Dockerfile all take the default, so the
 * default has to keep landing exactly there or a package upgrade silently moves
 * somebody's skills out from under a build that was working.
 */
export const DEFAULT_TARGET = 'claude'
export const DEFAULT_SCOPE = 'project'

/**
 * An absolute directory for a row of the table.
 *
 * Project paths hang off `cwd`, user paths off `homeDir()` — the two are never
 * mixed, and `homeDir()` is called here rather than captured at module scope so
 * that a test that moves `DOCPILOT_HOME` between cases is seen.
 */
function rootedAt(rel, scope, cwd) {
  if (!rel) return null
  return scope === 'user' ? path.join(homeDir(), rel) : path.resolve(cwd, rel)
}

/**
 * One target plus one scope, resolved to the two absolute directories.
 *
 * `skillsDir` and `commandsDir` given by hand win over the table entirely —
 * that is `--skills-dir=`, the escape hatch for a tool this table has never
 * heard of. A hand-given skills directory with no hand-given commands
 * directory writes no commands rather than guessing: the whole point of the
 * flag is that we do not know what tool is reading it.
 */
export function resolveSite({
  target = DEFAULT_TARGET,
  scope = DEFAULT_SCOPE,
  skillsDir = null,
  commandsDir = null,
  cwd = process.cwd(),
} = {}) {
  if (skillsDir || commandsDir) {
    return {
      target: 'custom',
      scope,
      skillsDir: skillsDir ? path.resolve(cwd, skillsDir) : null,
      commands: commandsDir
        ? {
            dir: path.resolve(cwd, commandsDir),
            layout: 'file',
            ext: '.md',
            frontmatter: 'plain',
            argsToken: '$ARGUMENTS',
          }
        : null,
    }
  }

  const spec = TARGETS[target]
  if (!spec) return null

  const commandsRel = spec.commands ? spec.commands[scope] : null
  return {
    target: spec.id,
    scope,
    skillsDir: rootedAt(spec.skills[scope], scope, cwd),
    commands: commandsRel
      ? {
          dir: rootedAt(commandsRel, scope, cwd),
          layout: spec.commands.layout,
          ext: spec.commands.ext,
          frontmatter: spec.commands.frontmatter,
          argsToken: spec.commands.argsToken,
        }
      : null,
  }
}

/**
 * Every place an install could already be — the list `update` walks when it was
 * given no target at all.
 *
 * Both scopes of every row, which is what makes `npx docpilot update` in one
 * project refresh a skill installed globally from another. Nothing here is
 * created: `update` reads these paths and works only on the ones that already
 * carry a manifest, so a machine with no Cursor never grows a `.cursor/`.
 */
export function candidateSites(cwd = process.cwd()) {
  const out = []
  for (const id of TARGET_IDS) {
    for (const scope of SCOPES) {
      const site = resolveSite({ target: id, scope, cwd })
      if (site?.skillsDir || site?.commands) out.push(site)
    }
  }
  return out
}

/**
 * A path as a reader would recognise it: relative under the project, `~`-headed
 * under the home directory, absolute otherwise.
 *
 * The report is the whole interface of both commands, and an install that lists
 * eleven absolute paths under `/Users/somebody/` is a report nobody reads.
 */
export function displayPath(abs, cwd = process.cwd()) {
  const rel = path.relative(cwd, abs)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  const home = homeDir()
  const fromHome = path.relative(home, abs)
  if (fromHome && !fromHome.startsWith('..') && !path.isAbsolute(fromHome)) {
    return `~/${fromHome.split(path.sep).join('/')}`
  }
  return abs
}
