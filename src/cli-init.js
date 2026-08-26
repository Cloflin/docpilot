/**
 * The pure half of `npx docpilot init` — everything that can be tested without
 * running a CLI.
 *
 * `init` writes files and, since the panel grew placements to choose between,
 * also asks two questions. The asking is in `bin/docpilot.js` because it owns stdin; the
 * DECISIONS are here: where the config is, what the flags said, and what the
 * snippet the reader has to paste looks like.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  resolveUi,
  UI_PANELS,
  UI_TRIGGERS,
  UI_TRIGGER_WORD_LIST,
  UI_DEFAULTS,
} from './theme/docpilot/ui.js'

export { UI_PANELS, UI_TRIGGERS, UI_TRIGGER_WORD_LIST, UI_DEFAULTS }

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
 *
 * `--trigger` takes a COMMA LIST as well as a word — `--trigger=nav,fab` — because
 * the setting is a list and a flag that could only say one of them would be the
 * one place a project could not express what it wanted. A value with no comma
 * stays a string, so `--trigger=nav` still means the word and still carries the
 * mobile nav-screen row with it.
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
      out.ui[m[1]] =
        m[1] === 'trigger' && m[2].includes(',')
          ? m[2].split(',').map((v) => v.trim()).filter(Boolean)
          : m[2]
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
    /**
     * The SETTING, not the resolution — the same treatment `'auto'` gets below,
     * and for the same reason twice over.
     *
     * `'nav'` resolves to two placements. Writing `['nav','screen']` into
     * somebody's config file would be technically identical and would read as
     * the tool having second-guessed the answer they gave; worse, it pins the
     * expansion, so a later release that gave the word a third placement would
     * silently skip every config this command had ever written.
     *
     * An array survives as the resolved array, which is the array they typed
     * minus anything that was not a placement.
     */
    trigger: UI_TRIGGER_WORD_LIST.includes(raw?.trigger)
      ? raw.trigger
      : Array.isArray(raw?.trigger)
        ? resolved.trigger
        : UI_DEFAULTS.trigger,
    panel: UI_PANELS.includes(raw?.panel) ? raw.panel : UI_DEFAULTS.panel,
  }
}

/** A word is written as a word; a list is written as a list. */
const triggerLiteral = (trigger) =>
  Array.isArray(trigger) ? `[${trigger.map((t) => `'${t}'`).join(', ')}]` : `'${trigger}'`

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
    `      trigger: ${triggerLiteral(ui.trigger)},`,
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
    /**
     * WORDS, not the placement list — `UI_TRIGGERS` is `nav, screen, fab` and
     * `screen` alone is not an answer anybody means: it is the mobile half of
     * the navbar button, and choosing it on its own leaves a desktop reader with
     * nothing to press. A project that wants an unusual combination writes the
     * array in its own config; a prompt is for the four that cover almost
     * everyone. `'all'` is left out for the same reason it exists — it is a
     * synonym of `'both'`, and two spellings of one answer in a numbered list is
     * a worse list.
     */
    options: ['nav', 'fab', 'both', 'none'],
    hints: {
      nav: 'in the navigation bar beside search, and in the mobile menu',
      fab: 'floating, bottom right of every page',
      both: 'all three at once — navbar, mobile menu and floating',
      none: 'no button; the ⌘I hotkey and your own control still open it',
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
