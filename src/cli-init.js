/**
 * The pure half of `npx docpilot init` — everything that can be tested without
 * running a CLI.
 *
 * `init` writes files and, since the panel grew two placements, also asks two
 * questions. The asking is in `bin/docpilot.js` because it owns stdin; the
 * DECISIONS are here: where the config is, what the flags said, and what the
 * snippet the reader has to paste looks like.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { resolveUi, UI_PANELS, UI_TRIGGERS, UI_DEFAULTS } from './theme/docpilot/ui.js'

export { UI_PANELS, UI_TRIGGERS, UI_DEFAULTS }

/**
 * Where the settings live, in the order they are looked for.
 *
 * The first four are VitePress's own config, and they come first because that is
 * where an existing project already keeps the `docPilot` export — the CLI reads
 * the SAME object the site is built with, which is what stops the index and the
 * runtime from drifting onto different embedders.
 *
 * The last two are for a project that has no VitePress and never will. Every
 * command except `init` needs this file, so without them `npx docpilot index`
 * simply exited on a Docusaurus or React site — and the documented workaround
 * was to create a `.vitepress/` directory for a generator the project does not
 * use. APPENDED rather than inserted: the four paths above are a tested contract
 * and a project that has one must keep resolving to it.
 */
export const CONFIG_CANDIDATES = [
  'docs/.vitepress/config.mjs',
  'docs/.vitepress/config.js',
  '.vitepress/config.mjs',
  '.vitepress/config.js',
  'docpilot.config.mjs',
  'docpilot.config.js',
]

/**
 * The config's path, or null — and NEVER an exit.
 *
 * Every other command needs the config and stops without it; `init` runs in a
 * project that may not have one yet, and scaffolding an eval set is still worth
 * doing there. So the search and the failure are separated: this returns, and
 * `loadSettings` in the CLI is what turns "not found" into an exit.
 */
export function findConfig(root = process.cwd()) {
  return CONFIG_CANDIDATES.find((c) => existsSync(path.resolve(root, c))) || null
}

/**
 * `--trigger=fab --panel=popup --yes`. Anything else is handed back untouched
 * so the caller can complain about it in its own words.
 */
export function parseUiFlags(argv = []) {
  const out = { ui: {}, yes: false, unknown: [] }
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') {
      out.yes = true
      continue
    }
    const m = /^--(trigger|panel)=(.*)$/.exec(arg)
    if (m) {
      out.ui[m[1]] = m[2]
      continue
    }
    out.unknown.push(arg)
  }
  return out
}

/**
 * The one validator, reused.
 *
 * `resolveUi` is what the build and the browser run, so a value this CLI
 * accepts is a value the panel accepts, and the complaint about a bad one is
 * worded once. The only thing added here is keeping `'auto'` as `'auto'`:
 * the resolver's job is to settle it, and a config file wants the word the
 * reader chose rather than what it happens to mean today.
 */
export function validateUi(raw, err = console.error) {
  const resolved = resolveUi({ ui: raw }, err)
  return {
    trigger: resolved.trigger,
    panel: UI_PANELS.includes(raw?.panel) ? raw.panel : UI_DEFAULTS.panel,
  }
}

const isDefault = (ui) => ui.trigger === UI_DEFAULTS.trigger && ui.panel === UI_DEFAULTS.panel

/**
 * What the reader has to paste, with their answer already in it.
 *
 * `init` has never edited a file it did not create, and this does not change
 * that: a VitePress config is code, it may be generated, and a tool that
 * rewrites one is a tool that eventually loses somebody's comments. So the
 * result of the two questions arrives as text on stdout, and the last line says
 * whose job the paste is.
 *
 * Printed even when both answers are the shipped defaults — with the note that
 * it can be left out. Someone who just chose "the default" deserves to see what
 * they chose, and the block is three lines.
 */
export function uiSnippet(ui, configPath) {
  const where = configPath ? `the \`docPilot\` settings in ${configPath}` : 'your `docPilot` settings'
  const head = isDefault(ui)
    ? `  Placement — the shipped default, so leaving it out of ${where} does the same:`
    : `  Placement — add this to ${where}:`
  return [
    head,
    '',
    '    ui: {',
    `      trigger: '${ui.trigger}',`,
    `      panel: '${ui.panel}',`,
    '    },',
    '',
    '  docpilot does not edit your config, so this one is yours to paste.',
  ].join('\n')
}

/**
 * The two questions, in the order they are asked. `hint` is one line, because
 * a prompt that needs a paragraph is a prompt with the wrong options.
 */
export const UI_QUESTIONS = [
  {
    key: 'trigger',
    label: 'Where should the button live?',
    options: UI_TRIGGERS,
    hints: {
      nav: 'in the navigation bar, beside search',
      fab: 'floating, bottom right of every page',
    },
    default: UI_DEFAULTS.trigger,
  },
  {
    key: 'panel',
    label: 'What shape should the panel be?',
    options: UI_PANELS,
    hints: {
      auto: 'follow the button — nav opens the drawer, floating opens the popup',
      drawer: 'full height, docked to the right edge',
      popup: 'floating, bottom right, above the button',
    },
    default: UI_DEFAULTS.panel,
  },
]
