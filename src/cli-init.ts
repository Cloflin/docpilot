/**
 * The pure half of `npx docpilot init` — everything that can be tested without
 * running a CLI.
 *
 * `init` writes files and, since the panel grew placements to choose between,
 * also asks two questions. Both halves live here now — the decisions (where the
 * config is, what the flags said, what the snippet the reader pastes looks
 * like) and `runInit` at the foot of the file, which writes.
 */
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { resolveDocPilot, indexDirOf } from './config.js'
import { askOne, CANCELLED } from './cli-ask.js'

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

/**
 * `npx docpilot init` — the scaffolding half, under the `run*` contract.
 *
 * It used to be 242 lines of `bin/docpilot.js`, which is where the asking had
 * to be because that file owned stdin. The decisions were already here; now the
 * writing is too, so the whole command is one typed function that returns a
 * code instead of ending the process — the same contract `import.ts:328-330`
 * writes down and for the same reason.
 *
 * `configPath` comes IN rather than being looked up: the launcher has already
 * found the config, and a command that went looking a second time would be free
 * to answer differently from the launcher that loaded it. `init` is exactly the
 * command where that matters, because "there is no config yet" is a normal
 * answer it prints a line about.
 *
 * @param {{argv: string[], configPath: string|null}} opts
 * @returns {Promise<number>} an exit code
 */
export async function runInit({ argv = [], configPath = null } = {}) {
  /**
   * The package root, from a module that is one level below it either way:
   * `dist/cli-init.js` when the CLI runs it and `src/cli-init.ts` when vitest
   * imports it. `../src/templates/…` was right from `bin/docpilot.js` and would
   * have been `src/src/…` from here under the test runner.
   */
  const PKG = new URL('../', import.meta.url)
  const wrote = []
  const skipped = []

  /**
   * Two questions, and every way of not asking them.
   *
   * Non-interactive is the DEFAULT, not the fallback: `npx --yes`, a CI job and
   * a Dockerfile all run this with no terminal, and a prompt there is a hang
   * with no output. So it asks only when both streams are a TTY and no flag has
   * already answered — which is the same rule `vitepress init` follows.
   *
   * A project with no config file gets one honest line instead: the two
   * settings live in a file that does not exist yet, and inventing one is the
   * kind of "help" that overwrites somebody's work later.
   */
  const flags = parseUiFlags(argv)
  if (flags.unknown.length) {
    /**
     * `2`, not `1`. A command line this package cannot parse is a USAGE error,
     * and the shell convention every other CLI here now follows keeps that
     * separate from `1`, which means the work was attempted and failed. The
     * distinction is the whole reason a script can tell a typo from an outage.
     */
    console.error(`[docpilot] unknown option${flags.unknown.length === 1 ? '' : 's'}: ${flags.unknown.join(' ')}`)
    console.error('  init accepts --trigger=nav|fab|both|none (or a comma list), --panel=auto|drawer|popup, --yes')
    return 2
  }

  const answered = Object.keys(flags.ui).length > 0
  const interactive =
    !answered && !flags.yes && !!configPath && !!process.stdin.isTTY && !!process.stdout.isTTY

  let ui = validateUi(flags.ui)

  if (!configPath) {
    console.log('[docpilot] no config file here yet — skipping the placement questions.\n')
  } else if (interactive) {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Ctrl-C during a question is an answer too: leave, with the files already
    // written still written, and a zero exit — cancelling is not an error.
    // Asked BEFORE anything is written, so cancelling leaves the project exactly
    // as it was found.
    // Ctrl-C is not success. It used to exit `0`, which told a script that the
    // scaffolding it asked for had been written.
    rl.on('SIGINT', () => {
      console.error('\n  Cancelled — nothing was written.')
      rl.close()
      process.exit(CANCELLED)
    })
    try {
      const picked = {}
      for (const q of UI_QUESTIONS) {
        picked[q.key] = await askOne(rl, q)
      }
      ui = validateUi(picked)
    } catch {
      // Ctrl-D closes stdin mid-question and readline rejects. Same intent as
      // Ctrl-C, same outcome — and an unhandled rejection here would print a
      // stack trace at someone who simply changed their mind.
      console.error('\n  Cancelled — nothing was written.')
      rl.close()
      return CANCELLED
    } finally {
      rl.close()
    }
  }

  const put = (rel, contents) => {
    const target = path.resolve(rel)
    if (existsSync(target)) return skipped.push(rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
    wrote.push(rel)
  }

  // Read from `src/templates/`, written as `.env.example`. The source cannot be
  // a dotfile at the package root: npm excludes dotfiles from the tarball unless
  // they are named outright, and `files` lists directories — so the published
  // package shipped without it and `npx docpilot init` died of ENOENT on every
  // real install while working perfectly from a clone.
  put('.env.example', readFileSync(new URL('src/templates/env.example', PKG), 'utf8'))

  // Three starter records, one of which must be REFUSED. A golden set with no
  // negative measures how often the model answers, not how often it is right to.
  //
  // `level` is the pool a record ENTERS at, and the pools nest: `--level=low`
  // scores q-01 and n-01, `--level=medium` scores all three, and no flag scores
  // everything. The negative is in the smallest pool on purpose — a smoke pool
  // that can only pass measures how often the model answers, again.
  put(
    'docpilot/golden.jsonl',
    [
      {
        id: 'q-01',
        question: 'How do I get started?',
        expect: 'answer',
        level: 'low',
        gold_chunks: ['guide/getting-started#'],
        // A chunk id carries NO leading slash and ends at its anchor; `path#`
        // prefix-matches every anchor of that page and nothing else.
        gold_answer: 'Replace this with the answer your docs actually give, at the length the panel produces.',
        identifiers: [],
        promptStock: true,
      },
      {
        id: 'q-02',
        question: 'How do I authenticate a request?',
        expect: 'answer',
        level: 'medium',
        gold_chunks: ['guide/authentication#'],
        gold_answer: 'Replace this too. Anchored chunk ids, verified by running the retriever.',
        identifiers: [],
        promptStock: true,
      },
      {
        id: 'n-01',
        question: 'What is the capital of France?',
        expect: 'refuse:no-evidence',
        level: 'low',
        gold_chunks: [],
        promptStock: true,
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )

  // Six probes, half of them answerable. `calibrate` measures the threshold
  // between the two halves, so a set that is all positives has nothing to
  // separate and fails with `no-feasible-tau`.
  put(
    'docpilot/calibration.jsonl',
    [
      { id: 'u-01', question: 'How do I get started?', stratum: 'U' },
      { id: 'u-02', question: 'Where do I put my API key?', stratum: 'U' },
      { id: 'u-03', question: 'How do I configure the editor?', stratum: 'U' },
      { id: 'n4-01', question: 'What is the capital of France?', stratum: 'N4' },
      { id: 'n4-02', question: 'How do I bake sourdough?', stratum: 'N4' },
      { id: 'n2-01', question: 'How do I enable the quantum billing endpoint?', stratum: 'N2' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )

  put(
    'docpilot/.gitignore',
    [
      '# Re-derivable from the probe set and the index; large, and rewritten every run.',
      'calibration.raw.jsonl',
      '',
      '# Bench artefacts are per-run scratch — see the docs-rag skill on why the',
      '# stable filenames must not be committed.',
      'bench/',
      '',
      '# Vectors `npx docpilot index` has already bought, keyed by model and text.',
      'embed-cache/',
      '',
      '# The previous eval report, kept aside so a rerun does not erase it — the',
      '# report name is a pure function of the inputs, so a rerun with nothing',
      '# changed writes over the file it is being compared against. Long-term',
      '# history is git; this protects the last run inside one working cycle.',
      'reports/history/',
      '',
    ].join('\n'),
  )

  /**
   * One entry into one `.gitignore`, appended rather than `put`.
   *
   * `put` skips a file that exists, and every project that has run `init` once
   * has these files — which is how the index rule ended up being a documented
   * behaviour that nothing implemented for the projects that needed it most.
   * Appending is the only form that reaches them.
   *
   * Idempotent: the entry is matched before anything is written, so running
   * `init` twice adds it once. One helper rather than two copies, because two
   * copies of an idempotence check is one check that silently stops matching.
   */
  const ignore = (rel, entry, why) => {
    const target = path.resolve(rel)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (current.split('\n').some((l) => l.trim() === entry)) {
      skipped.push(`${rel} — ${entry}`)
      return
    }
    const block = ['', ...why.map((l) => `# ${l}`), entry, ''].join('\n')
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, current ? `${current.replace(/\n*$/, '\n')}${block}` : block.replace(/^\n/, ''))
    wrote.push(`${rel}   (+ ${entry})`)
  }

  // The SHIPPED path, not this project's: `init` runs before the config is
  // loaded — it is the command for a project that does not have one yet — so
  // there is no `indexDir` to have been moved. A project that later moves it is
  // a project editing this line anyway.
  //
  // A project that DELIBERATELY commits its index — this one does, so its deploy
  // makes zero API requests — deletes the line.
  ignore('.gitignore', `${indexDirOf(resolveDocPilot({})).replace(/\\/g, '/').replace(/\/*$/, '')}/`, [
    'DocPilot: the built retrieval index. Megabytes of quantised vectors,',
    'rewritten whole by every `npx docpilot index`. Delete this line if you',
    'would rather commit it — a deploy that ships the index makes no API',
    'requests of its own.',
  ])

  // The build cache. Same three properties as `calibration.raw.jsonl` directly
  // above it in that file — re-derivable, large, rewritten every run — and one
  // more that decides it: it holds float32 vectors of the whole corpus, so
  // committing it is committing the index twice at four times the width.
  ignore('docpilot/.gitignore', 'embed-cache/', [
    'Vectors `npx docpilot index` has already bought, keyed by model and text.',
    'Re-derivable at the cost of one embedding request per 32 chunks; large.',
  ])

  /**
   * The skills, copied into the project.
   *
   * Not a convenience: `.claude/` inside `node_modules` is not discovered, so a
   * skill that stays in the package reaches nobody. This is the only way they
   * arrive, which is why it is part of `init` rather than a documented step.
   */
  const skillsDir = new URL('skills/', PKG)
  const copyTree = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, from)
      if (entry.isDirectory()) copyTree(src, `${to}/${entry.name}`)
      else put(`${to}/${entry.name}`, readFileSync(src, 'utf8'))
    }
  }
  if (existsSync(skillsDir)) copyTree(skillsDir, '.claude/skills')

  /**
   * The feedback receiver, copied for the same reason and with more force.
   *
   * `feedbackEndpoint` makes the panel POST one object per vote, fire and
   * forget: a receiver that 404s looks, from the reader's side, exactly like one
   * that works. So the endpoint is worth nothing without something listening,
   * and the something has to run in the CONSUMER's deployment — a file sitting
   * unpublished in this package's repository reaches that pod never
   * (engine-spec 013's sibling, 012 FB-5).
   *
   * A reference rather than a dependency: it is copied, not imported, because a
   * deployment edits it — its store is a seam, and which of the three it picks
   * is a decision about their infrastructure and not about this package.
   */
  const receiver = new URL('lib/feedback-receiver.mjs', PKG)
  if (existsSync(receiver)) put('docpilot/feedback-receiver.mjs', readFileSync(receiver, 'utf8'))

  for (const f of wrote) console.log(`[docpilot] wrote    ${f}`)
  for (const f of skipped) console.log(`[docpilot] kept     ${f}   (already there)`)

  console.log(`\n${uiSnippet(ui, configPath)}\n`)

  console.log(`
  Next:
    1. cp .env.example .env.local  and fill in ONE key — any one. The provider
       chain reads it and picks the service; nothing else has to be configured.
    2. add the plugin to .vitepress/config.mjs, and the theme to
       .vitepress/theme/index.js — see the README. The settings argument is
       optional:

         const ai = defineDocPilot({}, loadEnv('', process.cwd(), ''))

    3. npx docpilot index
    4. npx docpilot calibrate
    5. edit docpilot/golden.jsonl for your corpus, then: npx docpilot lint && npx docpilot eval

  npx docpilot doctor  says which provider your environment selected.
`)
  return 0
}
