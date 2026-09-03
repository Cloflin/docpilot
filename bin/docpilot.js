#!/usr/bin/env node
/**
 * `npx docpilot <command>` — the half of this package that is not a web page.
 *
 * The panel cannot work without an index, and an index cannot be trusted
 * without an evaluation, so both ship in the same package as the panel. Split
 * across two installs they drift: the index gets rebuilt with a different
 * embedding model, or the gate keeps thresholds measured against a corpus that
 * has since doubled, and nothing says so until a reader is told the docs do not
 * cover something they do.
 *
 * Every command resolves its settings the same way the build does — by importing
 * the project's own config — so there is no second place to state which model
 * embeds, where the docs live, or which key to use. On VitePress that config is
 * `.vitepress/config.mjs`; on any other site it is `docpilot.config.mjs`, and
 * both carry the same named `docPilot` export.
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const COMMANDS = [
  'index',
  'import',
  'vocabulary',
  'calibrate',
  'eval',
  'bench',
  'tune',
  'lint',
  'feedback',
  'doctor',
  'init',
  'update',
]

let [, , cmd, ...rest] = process.argv

/**
 * `docpilot help [command]` — the spelling half the world types first.
 *
 * It is rewritten into the flag rather than handled twice: `help eval` becomes
 * `eval --help`, `help` alone becomes the global block below. That keeps ONE
 * renderer and one set of words, and it is why `help` is deliberately NOT in
 * `COMMANDS` — `test/cli-flags.test.js:42` holds that array against the flag
 * table as an exact set, and a "command" with no flags of its own would have to
 * be invented on both sides to satisfy it.
 *
 * Here, above everything: like `--help` it must need no config, no key, no
 * network and no built `dist/`.
 */
if (cmd === 'help') {
  const target = rest.find((a) => !a.startsWith('-'))
  cmd = target ?? undefined
  rest = target ? ['--help'] : []
}

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
  docpilot <command>

  Installed in a project, every runner reaches this bin by the bare name:
  npx docpilot, pnpm exec docpilot, yarn docpilot, bunx docpilot. Run ONCE
  without installing, the name has to be the package's own — the unscoped
  "docpilot" on npm is not this package:

    npx @cloflin/docpilot init

    index       build the retrieval index from your docs
                asks which embedder to build with; the config's own answer is
                the default, so Enter changes nothing
    import      turn an allowlisted external page into a page of the corpus
    vocabulary  propose the names readers use for what your docs call something
                --languages=ru,de  --limit=N  --replace  --dry
    calibrate   measure the refusal thresholds against your corpus
    eval        run the golden set and write a report
                --level=low|medium|high|xhigh|max|ultra scores one tier of it
    bench       compare two retrieval configurations on answer quality
                --level= takes the same six tiers
    tune        sweep the retrieval levers (lambda, k) against the golden set
                into docpilot/tuning.json, with a report of the grid beside it
    lint        check the golden set against the index it measures
    feedback    turn readers' votes into candidates for the eval sets
    doctor      check the configuration without a full build
                --proxy prints the reverse-proxy contract; --models checks a
                free pool against the provider's live catalogue; --embed lists
                every embedder this project could build with, and the command
                that picks each one
    init        scaffold the environment, the eval sets and the authoring skills
                asks which agent tool gets the skills — Claude Code, Codex,
                Cursor, Copilot — and whether they go in this repository or in
                your home directory
    update      refresh those copied skills, and the /docpilot-* slash commands,
                after upgrading the package. A file you edited is replaced and
                kept beside it as .bak; --dry shows the whole report first

  The loop is  index → calibrate → lint → eval → bench,  with tune where it is
  retrieval that has to move — and then index again, because that is the step
  that inlines tuning.json into the manifest a reader downloads. Until it runs,
  a swept lever is a file on disk and nothing more.

  "vocabulary" sits at the FRONT of that loop and reads markdown rather than the
  index, so it runs before there is one. It rewrites how every lexical score is
  computed, which is why calibrate follows it: the manifest carries a vocabHash
  beside the index hash, and index reports a stale guard when the two disagree.

  The six tiers are cumulative — --level=medium runs low + medium, no --level
  runs everything — and eval, bench and tune all take one. A smoke-sized
  regression is therefore a regression in the full set too, and two reports are
  comparable only within one tier.

  Every command reads .vitepress/config.mjs — or docpilot.config.mjs — for its
  settings.

  npx docpilot <command> --help  — or  npx docpilot help <command>  — lists that
  command's flags, what each one does and what it costs. It needs no config, no
  key and no network, which is the point: it used to RUN the command, and on
  four of them that was a purchase order.

  npx docpilot --version  prints the installed version, and nothing else.

  "feedback" sits outside the loop: it reads what your own endpoint collected
  and PROPOSES probes for it, and with "feedback faq" the empty state's three
  openers. It never writes to the eval sets or to your config — a stratum is a
  judgement, a gold answer is written by a person, and the openers are the first
  thing every reader sees.
`)
  process.exit(0)
}

/**
 * `--version`, which did not exist — `docpilot --version` fell past the command
 * check and was reported as an unknown COMMAND, which is a confusing thing to be
 * told about the most standard flag a CLI has.
 *
 * Read from package.json rather than baked in: a constant here is a constant
 * that a release forgets to bump, and this file is two directories from the
 * manifest that already carries the number.
 */
if (cmd === '--version' || cmd === '-v' || cmd === '-V') {
  const pkg = new URL('../package.json', import.meta.url)
  console.log(JSON.parse(readFileSync(pkg, 'utf8')).version)
  process.exit(0)
}

/**
 * THE FOUR EXIT CODES, from the one module that declares them.
 *
 * Imported HERE — below the global help and `--version`, above everything else
 * — for the reason the help block above gives: those two must work with nothing
 * built, no config and no key. `dist/cli-exit.js` has no imports of its own, so
 * this is the cheapest module in the package and every path past this line
 * needs it.
 */
const { FAILED, USAGE, CANCELLED } = await import('../dist/cli-exit.js')

if (!COMMANDS.includes(cmd)) {
  // `docter`, `evals`, `calibrat` — one edit away, and worth naming rather than
  // making somebody diff their typo against a list of eleven.
  const near = COMMANDS.filter((c) => editDistance(c, cmd) <= 2).sort(
    (a, b) => editDistance(a, cmd) - editDistance(b, cmd),
  )
  console.error(
    `[docpilot] unknown command "${cmd}"\n\n` +
      (near.length ? `  Did you mean: ${near.slice(0, 3).join(', ')}?\n\n` : '') +
      `  One of: ${COMMANDS.join(', ')}\n` +
      '  npx docpilot --help  says what each one does.\n',
  )
  // `2`: the command line was wrong. Nothing was attempted, so a script that
  // retries on `1` — a provider that was down — must not retry this.
  process.exit(USAGE)
}

/**
 * `docpilot <cmd> --help` PRINTS HELP. It used to run the command.
 *
 * `--help` was matched in the COMMAND position only, so `rest` never saw it and
 * every command parsed the flags it knew and dropped the rest in silence. On
 * `index`, `eval`, `calibrate` and `vocabulary` that meant a full metered run —
 * the most reflexive thing a person types at an unfamiliar CLI was a purchase
 * order, and this package's own notes record ~20 OpenRouter requests spent on
 * one `calibrate --help`.
 *
 * SO IT IS FIRST, above `loadSettings()`, above `loadEnvironment()` and above
 * the six `await import('../dist/…')` below. Help must not need a config file, a
 * key, a built `dist/`, or a network — a reader asking what a command takes is
 * very often a reader who has none of those yet.
 */
if (rest.includes('--help') || rest.includes('-h')) {
  const { helpFor } = await import('../dist/cli-flags.js')
  console.log(helpFor(cmd))
  process.exit(0)
}

/** Levenshtein, iterative two-row. Eleven command names; no need for more. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

/**
 * Load the project's config and find the DocPilot settings in it.
 *
 * A named `docPilot` export is the documented contract, because on VitePress the
 * default export is the whole site config and digging the settings back out of
 * it means depending on where the user happened to put them. The same named
 * export is what a `docpilot.config.mjs` carries on a project that has no
 * VitePress at all — one contract, two places.
 *
 * WHY IT WARNS RATHER THAN EXITS, which it used to do twice.
 *
 * The named export is a contract about AGREEMENT: the CLI and the site build
 * have to resolve one object, or the index is built with one embedder and
 * queried with another and nothing says so until a reader is refused an answer
 * the docs contain. That argument holds exactly while there IS an object. When
 * there is not — `defineDocPilot()` with no arguments, which is the whole
 * zero-config install — both sides resolve the same empty settings against the
 * same environment and reach the same provider, so there is no second object to
 * disagree with.
 *
 * Exiting there cost the one path this package most wants to work: install,
 * put a key in `.env.local`, run `npx docpilot index`. The warning stays,
 * because a config that exists and names its settings somewhere this cannot see
 * is still a real fault, and a silent fallback to defaults would hide it.
 */
async function loadSettings() {
  const found = findConfig()
  if (!found) {
    // The cwd is printed because the candidates below are RELATIVE to it, and
    // "looked for docs/.vitepress/config.mjs" is unanswerable until you know
    // where it looked from — which is the actual fault most of the time.
    console.warn(
      `[docpilot] no config under ${process.cwd()}. Looked for:\n    ` +
        CONFIG_CANDIDATES.join('\n    ') +
        '\n\n  Continuing on the shipped defaults and your environment. If that is not\n' +
        '  what you meant, run this from your project root — on a site that is not\n' +
        '  VitePress that root is wherever you put docpilot.config.mjs:\n\n' +
        "    export const docPilot = { product: 'Acme', chat: { … }, embed: { … } }\n",
    )
    return { settings: {}, configPath: null }
  }
  /**
   * THE IMPORT THAT RAN BARE.
   *
   * This is a consumer's own config file being evaluated: a syntax error in it,
   * a missing dependency it imports, a `defineConfig` that throws — all of them
   * arrived as a raw stack trace out of the launcher, naming a file inside this
   * package as the top frame. The one thing a reader needs is which file failed
   * and why, and neither was said.
   */
  let mod
  try {
    mod = await import(pathToFileURL(path.resolve(found)).href)
  } catch (e) {
    console.error(
      `[docpilot] ${found} could not be loaded — ${e.message}\n\n` +
        '  Every command reads this file for its settings, so nothing can run until\n' +
        '  it does. DOCPILOT_DEBUG=1 prints the stack.\n',
    )
    if (process.env.DOCPILOT_DEBUG === '1') console.error(e.stack)
    process.exit(FAILED)
  }
  if (!mod.docPilot) {
    console.warn(
      `[docpilot] ${found} has no \`docPilot\` export — continuing on the shipped\n` +
        '  defaults and your environment.\n\n' +
        '  That is correct for a zero-config install:\n\n' +
        '    const ai = defineDocPilot()\n\n' +
        '  If you DO pass settings, name them, so this command and the build read\n' +
        '  one object instead of two:\n\n' +
        '    export const docPilot = { chat: { … }, embed: { … } }\n' +
        "    const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))\n",
    )
    return { settings: {}, configPath: found }
  }
  return { settings: mod.docPilot, configPath: found }
}

/**
 * WHAT THE LAUNCHER ITSELF NEEDS, and no longer what its commands need.
 *
 * This block used to pull fifteen names out of `dist/config.js`, six out of
 * `embed-choices.js` and three whole modules besides, because `doctor` and
 * `init` were written in this file. They are `src/cli-doctor.js` and
 * `src/cli-init.js` now, they import what they use, and what is left here is
 * the one thing every command past this point needs: the resolver, and the
 * search that finds the config to hand it. `dist/config.js` is 212 KB — the
 * file counts them itself — so the four commands whose settings are resolved
 * for them still pay for it, and the ones that reach neither (`--help`,
 * `--version`, `init`) now dispatch above this line and pay nothing.
 */
const { resolveDocPilot } = await import('../dist/config.js')
const { CONFIG_CANDIDATES, findConfig } = await import('../dist/cli-init.js')

/**
 * `init` scaffolds the WHOLE loop, not just a key.
 *
 * The panel is the visible half; the half that keeps it honest is the eval loop
 * — a golden set, a calibration set, and the authoring skills that say how to
 * grow them. Left to a "see the docs" pointer, none of that gets created, the
 * gate ships on provisional thresholds forever, and nobody finds out.
 *
 * Nothing is ever overwritten. Every file is reported as written or skipped, so
 * running it twice is safe and running it in an existing project is honest.
 */
/**
 * `init` is the one command that runs before there is anything to load — no
 * config, no key, no `dist/` of the consumer's own — so it dispatches here,
 * above `loadSettings()`, and takes only the two things it cannot find out for
 * itself: the flags, and where the config is (or that there is none).
 */
if (cmd === 'init') {
  const { findConfig, runInit } = await import('../dist/cli-init.js')
  process.exit(await runInit({ argv: rest, configPath: findConfig() }))
}

/**
 * `update` dispatches beside `init`, and for the same reason: it refreshes the
 * files this package COPIED into a project, so it needs no config, no key and
 * no network. An upgrade has to be refreshable in a checkout nobody has
 * configured yet — which is exactly the checkout somebody has just cloned.
 *
 * It is handed the package root because that is the one thing it cannot work
 * out for itself: `dist/cli-skills.js` knows where IT is, and the skills are
 * two directories above that in a clone and somewhere else again under a
 * package manager that flattens.
 */
if (cmd === 'update') {
  const { runUpdate } = await import('../dist/cli-skills.js')
  process.exit(await runUpdate({ argv: rest, pkgRoot: fileURLToPath(new URL('..', import.meta.url)) }))
}




/**
 * `.env.local`, APPLIED ONCE, HERE, AND NOWHERE ELSE — spec 010, decision 9.
 *
 * `doctor` reporting a key as missing because it lives in `.env.local` — where
 * every VitePress project is told to put it, and where the build finds it — is
 * a false alarm from the one command whose entire job is to not raise one. So
 * the file is read; what changed is who wins and who sees it.
 *
 * WHO WINS: the shell. This function used to return `{ ...process.env,
 * ...loadEnv(…) }`, which put the file on TOP, so a one-off
 * `OPENROUTER_API_KEY=… npx docpilot eval` was silently overruled by a
 * checked-in `.env`. `cli-context.ts:73` had already written the opposite law
 * down and three of the seven readers followed it; this is the launcher joining
 * them rather than a new rule.
 *
 * WHO SEES IT: everything. The old merge went into a local `env` that was
 * passed to the commands that took one — so `bench` and `lint`, which read
 * neither the file nor that object, could not see a key the CLI's own help
 * (`:503`, `:925`) told the reader to put there. Writing the missing keys into
 * `process.env` fixes both without a line changing in either command.
 *
 * vitepress is a convenience, not a dependency: without it there is no file to
 * read and the shell stands alone.
 */
const { applyFileEnv } = await import('../dist/cli-env.js')
await applyFileEnv()
const env = process.env

const { settings, configPath } = await loadSettings()
/**
 * `let`, for the one command that may be told to build with something other than
 * what the config names. An override is REBUILT rather than patched — `embed` is
 * assigned whole by `resolveDocPilot` and not merged, so a half-written object
 * spliced into an already-resolved one would carry fields from both.
 */
let resolved = resolveDocPilot(settings, env)

/**
 * SET HERE, not at the dispatch below — and that placement was a bug.
 *
 * `import`, `feedback`, `vocabulary` and `doctor` all run from their own blocks
 * further down, BEFORE the `ENTRY` dispatch where these two used to be assigned.
 * So for those four `cli-context.js` found no globals and fell back to
 * `resolveDocPilot({}, process.env)` — the SHIPPED defaults. `DOCPILOT_DIR` is
 * `path.resolve(ROOT, settings.evalDir)` and `DOCS` is the same for `docsDir`,
 * so a project that had moved either one got `vocabulary.json` and the feedback
 * reports written to `docpilot/` regardless of its config, and `vocabulary` read
 * its markdown from `docs/` regardless of where the docs actually were — a
 * proposal about the wrong corpus, silently.
 *
 * `resolved` is reassigned once, by the embedder override inside `index`, and
 * that runs before the dispatch it belongs to. So this is re-stated there rather
 * than being merely earlier than it used to be.
 */
globalThis.__DOCPILOT_SETTINGS__ = resolved
// The file the settings came from, so the indexer reads the sidebar out of THAT
// config rather than re-deriving a path: the search accepts `.js` as readily as
// `.mjs`, and the indexer used to join `.mjs` unconditionally and fail to find a
// config the CLI had just loaded.
globalThis.__DOCPILOT_CONFIG__ = configPath

/**
 * `import` runs HERE rather than through the ENTRY table below, because it is
 * the one command that takes arguments of its own and returns a verdict. The
 * table exists for the four modules that are their own scripts; a fifth that
 * needed a URL, three flags and an exit code would have to parse them twice.
 */
if (cmd === 'import') {
  const { runImport } = await import('../dist/build/import.js')
  process.exit(await runImport({ docPilot: resolved, argv: rest, env }))
}

// Same shape, same reason: a mode, four flags and a verdict of its own.
if (cmd === 'feedback') {
  const { runFeedback } = await import('../dist/feedback/cli.js')
  process.exit(await runFeedback({ docPilot: resolved, argv: rest, env }))
}

// And the same again: four flags, and a verdict — a model that would not answer
// is a failed run, not an empty vocabulary.
if (cmd === 'vocabulary') {
  const { runVocabulary } = await import('../dist/build/vocabulary.js')
  process.exit(await runVocabulary({ docPilot: resolved, argv: rest, env }))
}

// The same shape as `import`, `feedback` and `vocabulary`: flags of its own, a
// verdict of its own, and — since it prints the file the settings came from —
// the path the launcher resolved rather than one it goes looking for again.
if (cmd === 'doctor') {
  const { runDoctor } = await import('../dist/cli-doctor.js')
  process.exit(await runDoctor({ docPilot: resolved, settings, argv: rest, env, configPath }))
}

/**
 * THE EMBEDDER QUESTION — asked once, before the indexer is even imported.
 *
 * WHAT WAS WRONG. Every ingredient of "this index will be built with OpenAI,
 * because OPENAI_API_KEY is in your .env.local" was already computed by the time
 * this line ran, and none of it was ever said. A reader who had put a key
 * somewhere was not told it was in use; a reader who had put nothing anywhere
 * was not told that the Ollama on their own machine would do; and a config file
 * naming an embedder was obeyed without ever showing what else was available.
 * The resolution was right and mute, which is the shape of a bug that gets
 * discovered as a bad answer in a panel three weeks later.
 *
 * SO IT ASKS — and the first option is always what the config already says, and
 * always the default, so pressing Enter is a no-op. That is the property that
 * makes asking on EVERY build acceptable rather than obstructive.
 *
 * NON-INTERACTIVE IS THE DEFAULT, NOT THE FALLBACK. The same rule `init`
 * follows and for the same reason: `npx --yes`, a CI job and a Dockerfile all
 * run this with no terminal, and a prompt there is a hang with no output. A flag
 * that already answers the question skips it too, so `--embed-provider=ollama`
 * is a complete instruction.
 *
 * WHY THE OVERRIDE DOES NOT WRITE OVER THE CURRENT INDEX. The index is bound to
 * the embedder that built it, and rebuilding it at the current path leaves the
 * deployed panel reading an index its own config does not describe.
 * `embedderMatchesIndex` in session.js catches that when the config NAMES a
 * model — it logs and drops retrieval to lexical-only — and cannot catch it at
 * all when the config leaves the model to a pool or to `'auto'`, because then
 * there is no name on the config side to compare. What is left is the
 * retriever's vector-width check, which two 1024-dimensional models pass
 * identically. A separate directory is the same move docs/.vitepress/config.mjs
 * already makes for its local builds.
 */
let dispatchArgs = rest

if (cmd === 'index') {
  /**
   * IMPORTED INSIDE THE BRANCH, because only this branch asks the question.
   *
   * The embedder prompt's pure half, the local-server probe and the readline
   * helper are `index`'s alone now that `doctor --embed` reads them from
   * `src/cli-doctor.js`. Three modules and three names off the path of every
   * other command, for no change in what any of them do.
   */
  const { indexDirOf, resolveChain, nodeEmbedTarget } = await import('../dist/config.js')
  const { embedChoices, embedOverrideSnippet, embedQuestion, indexDirQuestion, parseEmbedFlags } =
    await import('../dist/embed-choices.js')
  const { probeLocalEmbedders } = await import('../dist/build/lib/embed-discovery.js')
  const { askOne } = await import('../dist/cli-ask.js')

  const flags = parseEmbedFlags(rest)
  if (flags.unknown.length) {
    console.error(`[docpilot] cannot use: ${flags.unknown.join(' ')}`)
    console.error(
      '  index accepts --embed-provider=<id|none>, --embed-model=<name>,\n' +
        '  --embed-base-url=<url>, --index-dir=<path>, --yes\n' +
        '  npx docpilot doctor --embed  lists the ids this project can use.\n',
    )
    process.exit(USAGE)
  }
  // Our flags do not travel on to the indexer: it has its own, and a flag it
  // does not know is a flag it silently ignores.
  dispatchArgs = flags.rest

  // `false` is an answer here — lexical-only — so "was it given" is asked as
  // `!== null` and never for truthiness.
  const answered = flags.embed !== null || flags.indexDir != null
  const interactive = !answered && !flags.yes && !!process.stdin.isTTY && !!process.stdout.isTTY

  let embed = flags.embed !== null ? flags.embed : undefined
  let indexDir = flags.indexDir
  let source = answered ? '--embed-provider' : null

  if (interactive) {
    const choices = embedChoices(settings, env, { probed: await probeLocalEmbedders(env) })
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Ctrl-C during a question is an answer too, and the whole exchange happens
    // before the indexer is imported — so cancelling leaves the project exactly
    // as it was found, and a cancelled build is not an error.
    // Cancelling is not success. `0` told a script the index had been built.
    rl.on('SIGINT', () => {
      console.error('\n  Cancelled — nothing was written.')
      rl.close()
      process.exit(CANCELLED)
    })
    try {
      const picked = await askOne(rl, embedQuestion(choices))
      const choice = choices.find((c) => c.label === picked) || choices[0]
      if (choice.source !== 'config') {
        embed = choice.embed
        source = 'your answer'
        const current = indexDirOf(resolved)
        const q = indexDirQuestion(choice, current)
        indexDir = (await askOne(rl, q)) === q.options[1] ? current : choice.indexDir
        console.log('\n' + embedOverrideSnippet(choice, configPath, indexDir, current) + '\n')
      }
    } catch {
      // Ctrl-D closes stdin mid-question and readline rejects. Same intent as
      // Ctrl-C, same outcome — and an unhandled rejection here would print a
      // stack trace at somebody who simply changed their mind.
      console.error('\n  Cancelled — nothing was written.')
      rl.close()
      process.exit(CANCELLED)
    } finally {
      rl.close()
    }
  }

  if (embed !== undefined || indexDir != null) {
    resolved = resolveDocPilot(
      {
        ...settings,
        ...(embed !== undefined ? { embed } : null),
        ...(indexDir != null ? { indexDir } : null),
      },
      env,
    )
  }

  /**
   * A FLAG THAT MOVES THE EMBEDDER AND NOT THE PATH, said out loud.
   *
   * `doctor --embed` prints `--index-dir=` alongside every override for exactly
   * this reason, so the common path is already safe; a flag typed by hand is
   * the reader's own call and is obeyed. But it is obeyed with the consequence
   * stated, because nothing downstream states it as plainly: the panel drops to
   * lexical-only where its config names a model, and says nothing at all where
   * the config names a pool.
   */
  if (embed !== undefined && indexDir == null && !interactive) {
    const before = (() => {
      try {
        return nodeEmbedTarget(resolveDocPilot(settings, env), env)
      } catch {
        return null
      }
    })()
    const after = (() => {
      try {
        return nodeEmbedTarget(resolved, env)
      } catch {
        return null
      }
    })()
    if (before && after && (before.id !== after.id || before.model !== after.model)) {
      console.warn(
        `[docpilot] ${'warn'.padEnd(10)}this overwrites ${indexDirOf(resolved)}, built with ` +
          `${before.id} / ${before.model || '(pool)'}, which is still what your config names.\n` +
          `${' '.repeat(21)}Pass --index-dir=<path> to keep both, or change \`embed\` in your config.`,
      )
    }
  }

  /**
   * SAID OUT LOUD, on every build, terminal or not.
   *
   * The half of this that works in CI, in Docker and under `--yes`, where a
   * question cannot be asked but the answer still matters. One line, because the
   * build log below it is long and a reader scanning for "which embedder" should
   * find it without reading a block.
   */
  try {
    const target = nodeEmbedTarget(resolved, env)
    const model = target.model || target.models?.[0] || '(the provider picks)'
    const where =
      source ||
      ('embed' in settings ? configPath || 'your config' : null) ||
      resolveChain(env).tried.find((t) => t.found)?.envKey ||
      'the shipped default'
    console.log(
      `[docpilot] ${'embed'.padEnd(10)}${
        target.lexicalOnly ? 'lexical only — no embedder' : `${target.id} / ${model}`
      }   ← ${where}`,
    )
  } catch {
    // A configuration the resolver refuses is the indexer's to report, with the
    // message it has been writing for that case all along. A line here would be
    // a worse version of it, printed first.
  }
}

const ENTRY = {
  index: '../dist/build/build-rag-index.js',
  eval: '../dist/eval/run.js',
  calibrate: '../dist/eval/calibrate.js',
  bench: '../dist/eval/answer-bench.js',
  tune: '../dist/eval/tune.js',
  lint: '../dist/eval/lint-golden.js',
}
/**
 * `argv[1]` becomes the ENTRY MODULE, not this launcher.
 *
 * Two of the entries only run when invoked directly — `if (import.meta.url ===
 * pathToFileURL(process.argv[1]).href)` — which is what keeps them importable
 * from the test suite without building an index as a side effect. Leaving
 * `argv[1]` pointing at this file made that comparison false forever, so
 * `docpilot index` and `docpilot calibrate` imported their module, ran nothing, and
 * **exited 0**. A build command that succeeds without building is the worst
 * shape a bug can take: CI is green and the index is whatever it was.
 *
 * Pointing it at the module about to run is also simply what `argv[1]` means.
 */
const entry = new URL(ENTRY[cmd], import.meta.url)
process.argv = [process.argv[0], fileURLToPath(entry), ...dispatchArgs]
// RE-STATED, because `index` may have rebuilt `resolved` from an embedder the
// reader chose a few lines ago. Everything else has been reading the assignment
// made up beside `resolveDocPilot` since the four early-dispatch commands
// needed it there.
globalThis.__DOCPILOT_SETTINGS__ = resolved
await import(entry.href)
