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
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

const COMMANDS = [
  'index',
  'import',
  'calibrate',
  'eval',
  'bench',
  'tune',
  'lint',
  'feedback',
  'doctor',
  'init',
]

const [, , cmd, ...rest] = process.argv

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
  docpilot <command>

    index       build the retrieval index from your docs
    import      turn an allowlisted external page into a page of the corpus
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
                free pool against the provider's live catalogue
    init        scaffold the environment, the eval sets and the authoring skills

  The loop is  index → calibrate → lint → eval → bench,  with tune where it is
  retrieval that has to move — and then index again, because that is the step
  that inlines tuning.json into the manifest a reader downloads. Until it runs,
  a swept lever is a file on disk and nothing more.

  The six tiers are cumulative — --level=medium runs low + medium, no --level
  runs everything — and eval, bench and tune all take one. A smoke-sized
  regression is therefore a regression in the full set too, and two reports are
  comparable only within one tier.

  Every command reads .vitepress/config.mjs — or docpilot.config.mjs — for its
  settings.

  "feedback" sits outside the loop: it reads what your own endpoint collected
  and PROPOSES probes for it. It never writes to the eval sets — a stratum is a
  judgement and a gold answer is written by a person.
`)
  process.exit(0)
}

if (!COMMANDS.includes(cmd)) {
  console.error(
    `[docpilot] unknown command "${cmd}"\n\n` +
      `  One of: ${COMMANDS.join(', ')}\n` +
      '  npx docpilot --help  says what each one does.\n',
  )
  process.exit(1)
}

/**
 * Load the project's config and find the DocPilot settings in it.
 *
 * A named `docPilot` export is the documented contract, because on VitePress the
 * default export is the whole site config and digging the settings back out of
 * it means depending on where the user happened to put them. The same named
 * export is what a `docpilot.config.mjs` carries on a project that has no
 * VitePress at all — one contract, two places.
 */
async function loadSettings() {
  const found = findConfig()
  if (!found) {
    // The cwd is printed because the candidates below are RELATIVE to it, and
    // "looked for docs/.vitepress/config.mjs" is unanswerable until you know
    // where it looked from — which is the actual fault most of the time.
    console.error(
      `[docpilot] no config under ${process.cwd()}. Looked for:\n    ` +
        CONFIG_CANDIDATES.join('\n    ') +
        '\n\n  Run it from your project root. On a site that is not VitePress that\n' +
        '  root is wherever you put docpilot.config.mjs:\n\n' +
        "    export const docPilot = { product: 'Acme', chat: { … }, embed: { … } }\n",
    )
    process.exit(1)
  }
  const mod = await import(pathToFileURL(path.resolve(found)).href)
  if (!mod.docPilot) {
    // Not a naming convention: the CLI and the site build have to read the SAME
    // object, or the index is built with one embedder and queried with another
    // and nothing says so until a reader is refused an answer the docs contain.
    console.error(
      `[docpilot] ${found} has no \`docPilot\` export\n\n` +
        '  Name the settings you pass to defineDocPilot, so this command and the\n' +
        '  build read one object instead of two:\n\n' +
        "    export const docPilot = { chat: { … }, embed: { … } }\n" +
        "    const ai = defineDocPilot(docPilot, loadEnv('', process.cwd(), ''))\n",
    )
    process.exit(1)
  }
  return { settings: mod.docPilot, configPath: found }
}

const {
  resolveDocPilot,
  readiness,
  indexDirOf,
  proxyContract,
  chatModels,
  embedModels,
  poolProviderOf,
} = await import('../src/config.js')
const { CONFIG_CANDIDATES, findConfig, parseUiFlags, validateUi, uiSnippet, UI_QUESTIONS } =
  await import('../src/cli-init.js')

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
if (cmd === 'init') {
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
  const flags = parseUiFlags(rest)
  if (flags.unknown.length) {
    console.error(`[docpilot] unknown option${flags.unknown.length === 1 ? '' : 's'}: ${flags.unknown.join(' ')}`)
    console.error('  init accepts --trigger=nav|fab, --panel=auto|drawer|popup, --yes')
    process.exit(1)
  }

  const configPath = findConfig()
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
    rl.on('SIGINT', () => {
      console.log('\n  Cancelled — nothing was written.')
      rl.close()
      process.exit(0)
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
      console.log('\n  Cancelled — nothing was written.')
      rl.close()
      process.exit(0)
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
  put('.env.example', readFileSync(new URL('../src/templates/env.example', import.meta.url), 'utf8'))

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
    ].join('\n'),
  )

  /**
   * The skills, copied into the project.
   *
   * Not a convenience: `.claude/` inside `node_modules` is not discovered, so a
   * skill that stays in the package reaches nobody. This is the only way they
   * arrive, which is why it is part of `init` rather than a documented step.
   */
  const skillsDir = new URL('../skills/', import.meta.url)
  const copyTree = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, from)
      if (entry.isDirectory()) copyTree(src, `${to}/${entry.name}`)
      else put(`${to}/${entry.name}`, readFileSync(src, 'utf8'))
    }
  }
  if (existsSync(skillsDir)) copyTree(skillsDir, '.claude/skills')

  for (const f of wrote) console.log(`[docpilot] wrote    ${f}`)
  for (const f of skipped) console.log(`[docpilot] kept     ${f}   (already there)`)

  console.log(`\n${uiSnippet(ui, configPath)}\n`)

  console.log(`
  Next:
    1. cp .env.example .env.local  and fill in one key
    2. add the plugin — and the block above — to .vitepress/config.mjs, see the README
    3. npx docpilot index
    4. npx docpilot calibrate
    5. edit docpilot/golden.jsonl for your corpus, then: npx docpilot lint && npx docpilot eval
`)
  process.exit(0)
}

/**
 * One question, answered by number or by name, empty for the default.
 *
 * Garbage is re-asked ONCE and then takes the default rather than looping: a
 * prompt that will not let go is worse than a wrong-but-stated placement, which
 * is two words in a config file to change.
 */
async function askOne(rl, q) {
  const list = q.options
    .map((o, i) => `    ${i + 1}. ${o}${o === q.default ? '  (default)' : ''}  — ${q.hints[o]}`)
    .join('\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = (await rl.question(`\n  ${q.label}\n${list}\n  > `)).trim()
    if (!raw) return q.default
    const byNumber = /^\d+$/.test(raw) ? q.options[Number(raw) - 1] : undefined
    if (byNumber) return byNumber
    if (q.options.includes(raw)) return raw
    console.log(`  "${raw}" is not one of them — ${q.options.join(', ')}.`)
  }
  return q.default
}

/**
 * Read the environment the way the BUILD reads it, not the way a shell does.
 *
 * `doctor` reporting a key as missing because it lives in `.env.local` — where
 * every VitePress project is told to put it, and where the build finds it — is
 * a false alarm from the one command whose entire job is to not raise one.
 * vitepress is a peer dependency, so it resolves from the project this is being
 * run in; a project without it is not a project this CLI has anything to say to.
 */
async function loadEnvironment() {
  try {
    const { loadEnv } = await import('vitepress')
    return { ...process.env, ...loadEnv('', process.cwd(), '') }
  } catch {
    return process.env
  }
}

const { settings, configPath } = await loadSettings()
const env = await loadEnvironment()
const resolved = resolveDocPilot(settings, env)

/**
 * `import` runs HERE rather than through the ENTRY table below, because it is
 * the one command that takes arguments of its own and returns a verdict. The
 * table exists for the four modules that are their own scripts; a fifth that
 * needed a URL, three flags and an exit code would have to parse them twice.
 */
if (cmd === 'import') {
  const { runImport } = await import('../src/build/import.js')
  process.exit(await runImport({ docPilot: resolved, argv: rest, env }))
}

// Same shape, same reason: a mode, four flags and a verdict of its own.
if (cmd === 'feedback') {
  const { runFeedback } = await import('../src/feedback/cli.js')
  process.exit(await runFeedback({ docPilot: resolved, argv: rest, env }))
}

if (cmd === 'doctor') {
  const ready = readiness(resolved, env)

  /**
   * One column for every value, so the block reads as a table rather than as a
   * list of sentences that happen to start alike.
   *
   * `[docpilot] ` plus a ten-wide label lands every value at column 21, which is
   * what `PAD` is — the continuation lines are indented to the column their
   * parent's value starts at, not to a count somebody typed. Held by hand, it
   * drifted: `chat` and `embed` were padded to nine and printed one column short
   * of `config`, `index` and `ready`, which is close enough to read as a
   * rendering fault rather than as two labels of different lengths.
   */
  const say = (label, value) => console.log(`[docpilot] ${label.padEnd(10)}${value}`)
  const PAD = ' '.repeat(21)

  say('config', configPath)
  say('docs', resolved.docsDir)
  say('index', indexDirOf(resolved))

  /**
   * `--proxy` prints the contract a production reverse proxy has to satisfy.
   *
   * The dev server gets `/ai/*` for free from the Vite plugin; a BUILT site does
   * not, and `vitepress preview` has no proxy at all — which is the point in the
   * deployment where the panel stops working and nothing says why. Printing the
   * resolved routes beats shipping one deployment's nginx.conf as a template:
   * the paths, the upstreams and the header name are facts of this
   * configuration, and the TLS termination and the process manager are not.
   *
   * The KEY is never printed. Only the name of the variable carrying it.
   */
  if (rest.includes('--proxy')) {
    const contract = proxyContract(resolved, env)
    console.log('')
    for (const r of contract.routes) {
      say('proxy', r.path)
      console.log(`${PAD}→ ${r.upstream}${r.rewrite}`)
      console.log(`${PAD}${r.header}: ${r.envKey ? `<${r.envKey}>` : 'NO KEY — none set'}`)
    }
    if (contract.routes.length) {
      for (const n of contract.notes) console.log(`  · ${n}`)
    } else {
      // Printing four rules for a proxy that does not exist reads as four things
      // left undone.
      say('proxy', 'none needed — every provider is called directly')
    }
    console.log('')
  }
  /**
   * `--models` is the ONLY thing in this command that touches the network, and
   * it is a flag rather than a default for that reason: `doctor` runs in CI, and
   * a check that fails when a third party is slow is a check that gets removed.
   *
   * What it answers is the one question a baked list cannot answer for itself —
   * whether the free ids this package shipped with are still being served. They
   * are retired weekly. A pool whose members have all been retired fails in the
   * least legible way available: every model 404s in turn and the reader is told
   * the last one's name.
   */
  if (rest.includes('--models')) {
    const { fetchFreePool } = await import('../src/theme/docpilot/openrouter.js')
    console.log('')
    for (const [half, shipped] of [
      ['chat', chatModels(resolved)],
      ['embed', embedModels(resolved)],
    ]) {
      if (!shipped?.length) continue
      // Only where a catalogue exists to be asked. `chatModels` also returns an
      // author's own list on a provider that publishes nothing, and checking a
      // list of OpenAI ids against OpenRouter's catalogue reports every one of
      // them retired.
      const provider = poolProviderOf(resolved, half)
      if (!provider) {
        say(half, `${shipped.length} model(s), no catalogue to check them against`)
        continue
      }
      // `fallback: false`: the merged list contains the baked one by
      // construction, so asking "which of ours is gone" of it always answers
      // "none" — the check would be a check that cannot fail.
      const live = await fetchFreePool(half, { fallback: false })
      if (!live) {
        say(half, `${provider}'s catalogue is unreachable — cannot check`)
        continue
      }
      const gone = shipped.filter((m) => !live.includes(m))
      const fresh = live.filter((m) => !shipped.includes(m))
      say(half, `${shipped.length} in the pool, ${live.length} free upstream`)
      if (gone.length) console.log(`${PAD}RETIRED: ${gone.join(', ')}`)
      if (fresh.length) console.log(`${PAD}new upstream: ${fresh.slice(0, 6).join(', ')}`)
      if (!gone.length && !fresh.length) console.log(`${PAD}the shipped pool matches the catalogue`)
    }
    console.log('')
  }

  if (ready.ok) {
    say('ready', 'yes — the panel will render')
    for (const n of ready.notes) console.log(`  · ${n}`)
    process.exit(0)
  }
  say('ready', `NO — ${ready.missing.length} to fix\n`)
  for (const m of ready.missing) console.log(`  · ${m.what}\n      ${m.fix}`)
  for (const n of ready.notes) console.log(`  · ${n}`)
  // Exit 1 so CI can gate on it. The BUILD never fails for these; `doctor` is
  // the opt-in place to turn the same facts into a failure.
  process.exit(1)
}

const ENTRY = {
  index: '../src/build/build-rag-index.js',
  eval: '../src/eval/run.js',
  calibrate: '../src/eval/calibrate.js',
  bench: '../src/eval/answer-bench.js',
  tune: '../src/eval/tune.js',
  lint: '../src/eval/lint-golden.js',
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
process.argv = [process.argv[0], fileURLToPath(entry), ...rest]
globalThis.__DOCPILOT_SETTINGS__ = resolved
// The file the settings came from, so the indexer reads the sidebar out of THAT
// config rather than re-deriving a path: the search accepts `.js` as readily as
// `.mjs`, and the indexer used to join `.mjs` unconditionally and fail to find a
// config the CLI had just loaded.
globalThis.__DOCPILOT_CONFIG__ = configPath
await import(entry.href)
