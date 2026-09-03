/**
 * EVERY COMMAND OF THIS CLI, AS A SLASH COMMAND — generated, never authored.
 *
 * A reader working in Claude Code, Codex, Cursor or Copilot types `/` and gets
 * a list. Until this file existed, nothing this package can do was on that
 * list: every one of its eleven commands had to be remembered, spelled and
 * typed at a terminal, flags and all, by somebody who had read
 * `docs/reference/cli.md`. The commands that matter most are the ones nobody
 * runs — `lint` before `eval`, `update` after an upgrade — and a command you
 * have to remember is a command that does not run.
 *
 * THE BODIES COME OUT OF THE FLAG TABLE. `src/cli-flags.ts` already declares
 * every flag of every command once, and already renders the help from that
 * declaration rather than from a second list beside it. This file takes the
 * same table one step further out: a flag added there appears in eleven files
 * across four tools with nobody remembering to add it, and a flag removed
 * disappears from them the same way. Hand-authoring forty-four markdown files
 * would have been forty-four places to drift.
 *
 * WHICH IS ALSO WHY `/docpilot-update` EXISTS BY CONSTRUCTION. It is not a
 * special case written by hand; it is `COMMANDS.update` rendered by the same
 * loop as the other ten, and `test/cli-slash.test.js` holds the generated set
 * equal to `Object.keys(COMMANDS)` so it cannot quietly stop being generated.
 *
 * PURE. Nothing here touches a disk — it returns `{ rel, body }` pairs and lets
 * `src/cli-skills.ts` decide what to do with them, which is what makes the
 * whole rendering testable without a filesystem.
 */
import { COMMANDS, DOCS_URL, exampleOf, helpFor } from './cli-flags.js'

/** Every generated file is `docpilot-<command>`. One prefix, named once. */
export const SLASH_PREFIX = 'docpilot-'

/** `['docpilot-index', …, 'docpilot-update']`, in the table's own order. */
export function slashNames() {
  return Object.keys(COMMANDS).map((c) => `${SLASH_PREFIX}${c}`)
}

/**
 * The three flags worth showing in a one-line hint, as the tool shows them.
 *
 * `argument-hint` is rendered inline beside the command in Claude Code's
 * picker, so it is a hint and not a manual — the manual is two lines below it
 * in the body. Three is what fits.
 */
function argumentHint(spec) {
  return spec.flags
    .slice(0, 3)
    .map((f) => `[${exampleOf(f)}]`)
    .join(' ')
}

/**
 * YAML that survives a summary with a colon in it.
 *
 * None of the eleven summaries has one today. One will, eventually, and a
 * frontmatter block that stops parsing is a skill the tool drops in silence —
 * no error, it simply is not in the list. Quoting costs nothing.
 */
const yamlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * What each tool wants at the top of the file.
 *
 * `skill` is the Agent Skills shape, and its `name` MUST equal the directory
 * the file sits in — the standard says so, and a mismatch is another silent
 * drop. `user-invocable` with `disable-model-invocation` is what makes a
 * generated command behave like a command rather than like a skill the model
 * reaches for on its own: these are eleven ways to spend money and time, and a
 * model should run one because a person typed it.
 */
function frontmatter(command, spec, target) {
  /**
   * `plain` gets NO frontmatter block, and that is the whole reason the kind
   * exists. Cursor injects the entire file as the prompt, so a `---` header it
   * does not parse is three lines of YAML arriving at the model as text. The
   * description is not lost — it is the sentence under the heading, where every
   * one of these files carries it anyway.
   */
  if (target.frontmatter === 'plain') return null

  const description = `${spec.summary} — runs \`npx docpilot ${command}\``
  const lines = ['---']
  if (target.frontmatter === 'skill') lines.push(`name: ${SLASH_PREFIX}${command}`)
  lines.push(`description: ${yamlString(description)}`)
  if (target.frontmatter === 'claude') lines.push(`argument-hint: ${yamlString(argumentHint(spec))}`)
  if (target.frontmatter === 'prompt') lines.push('mode: agent')
  if (target.frontmatter === 'skill') lines.push('user-invocable: true', 'disable-model-invocation: true')
  lines.push('---')
  return lines.join('\n')
}

/**
 * The three commands that behave differently under an agent than under a person.
 *
 * Two of them ask a question at a terminal and an agent has no terminal to
 * answer it at; the third rewrites the very file the agent is reading. All
 * three are surprises, and a surprise an agent has not been warned about is
 * reported to the reader as a fault.
 */
const NOTES = {
  index:
    'It asks which embedder to build with when it has a terminal. Under an agent it does not, ' +
    'so it takes what the config names — pass `--yes` to make that explicit.',
  init: 'It asks where the skills go and what the panel looks like. Pass `--yes` to take the defaults and ask nothing.',
  update:
    'It rewrites this file, and every other `docpilot-*` command beside it, from the installed package. ' +
    'Seeing this file change during the run is the command working, not damage.',
}

/**
 * One command, for one tool.
 *
 * @returns `{ rel, body }` — `rel` relative to the tool's commands directory.
 */
export function slashDoc(command, target) {
  const spec = COMMANDS[command]
  if (!spec) return null

  const rel =
    target.layout === 'skill-dir'
      ? `${SLASH_PREFIX}${command}/SKILL.md`
      : `${SLASH_PREFIX}${command}${target.ext}`

  const arg = spec.positional ? ` <${spec.positional.name}>` : ''
  const head = frontmatter(command, spec, target)
  const body = [
    head,
    head ? '' : null,
    `# docpilot ${command}`,
    '',
    `${spec.summary[0].toUpperCase()}${spec.summary.slice(1)}.`,
    '',
    'Run it from the project root and report what it printed:',
    '',
    '```bash',
    `npx docpilot ${command}${arg} ${target.argsToken}`.trim(),
    '```',
    '',
    '## What it takes',
    '',
    '```',
    helpFor(command).replace(/^\n+|\n+$/g, ''),
    '```',
    '',
    '## Rules',
    '',
    '- Report the exit code and the last lines of output. `0` is success, `2` is a bad flag, `1` is a real failure.',
    '- Do not edit files the command did not write, and do not re-run it to "fix" a non-zero exit before reporting it.',
    '- Every command except `init` and `update` reads `.vitepress/config.mjs` or `docpilot.config.mjs`.',
    NOTES[command] ? `- ${NOTES[command]}` : null,
    '',
    `Generated by \`npx docpilot update\` from the installed package — edit the package, not this file.`,
    '',
    `Full reference: ${DOCS_URL}/reference/cli#${command}`,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n')

  return { rel, body }
}

/** Every command of the CLI, for one tool. */
export function slashDocs(target) {
  return Object.keys(COMMANDS)
    .map((c) => slashDoc(c, target))
    .filter(Boolean)
}
