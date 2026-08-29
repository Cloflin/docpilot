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
  'vocabulary',
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
                free pool against the provider's live catalogue
    init        scaffold the environment, the eval sets and the authoring skills

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
  const mod = await import(pathToFileURL(path.resolve(found)).href)
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

const {
  resolveDocPilot,
  readiness,
  indexDirOf,
  proxyContract,
  chatModels,
  embedModels,
  poolProviderOf,
  resolveChain,
  resolveChatChain,
  nodeChatTarget,
  resolveEmbed,
  resolveTuning,
  capsOf,
} = await import('../src/config.js')
// The catalogue reader `npx docpilot index` uses, so `doctor --models` proposes
// the same candidates the build would.
const { discoverEmbedModels, probeEmbedEndpoint } = await import('../src/build/lib/embed-discovery.js')
// Its answering-half sibling: what a local server has actually loaded, asked
// through the adapters' own paths and reporting `unknown` rather than throwing,
// so a laptop with Ollama switched off never changes what this command exits.
const { inspectChatTarget } = await import('../src/build/lib/chat-preflight.js')
// The adapters, for the ONE thing `doctor --models` needs from them: the path a
// service lists its models at, and the shape of what comes back.
const { providerFor } = await import('../src/theme/docpilot/providers.js')
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
    console.error('  init accepts --trigger=nav|fab|both|none (or a comma list), --panel=auto|drawer|popup, --yes')
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
   * The built index, kept out of the project's history.
   *
   * APPENDED rather than `put`, because the project almost certainly has a
   * `.gitignore` already and `put` skips a file that exists — which is how this
   * ended up being a documented behaviour that nothing implemented. The rule is
   * worth a few lines of special-casing: the index is megabytes of quantised
   * vectors, rewritten in full by every `npx docpilot index`, and a repository
   * that commits it grows by that much per rebuild.
   *
   * A project that DELIBERATELY commits its index — this one does, so its deploy
   * makes zero API requests — deletes the line. Idempotent: the entry is matched
   * before anything is written, so running `init` twice adds it once.
   */
  {
    const rel = '.gitignore'
    const target = path.resolve(rel)
    // The SHIPPED path, not this project's: `init` runs before the config is
    // loaded — it is the command for a project that does not have one yet — so
    // there is no `indexDir` to have been moved. A project that later moves it
    // is a project editing this line anyway.
    const entry = `${indexDirOf(resolveDocPilot({})).replace(/\\/g, '/').replace(/\/*$/, '')}/`
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (current.split('\n').some((l) => l.trim() === entry)) {
      skipped.push(`${rel} — ${entry}`)
    } else {
      const block = [
        '',
        '# DocPilot: the built retrieval index. Megabytes of quantised vectors,',
        '# rewritten whole by every `npx docpilot index`. Delete this line if you',
        '# would rather commit it — a deploy that ships the index makes no API',
        '# requests of its own.',
        entry,
        '',
      ].join('\n')
      writeFileSync(target, current ? `${current.replace(/\n*$/, '\n')}${block}` : block.replace(/^\n/, ''))
      wrote.push(`${rel}   (+ ${entry})`)
    }
  }

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

// And the same again: four flags, and a verdict — a model that would not answer
// is a failed run, not an empty vocabulary.
if (cmd === 'vocabulary') {
  const { runVocabulary } = await import('../src/build/vocabulary.js')
  process.exit(await runVocabulary({ docPilot: resolved, argv: rest, env }))
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

  say('config', configPath || 'none — shipped defaults + your environment')
  say('docs', resolved.docsDir)
  say('index', indexDirOf(resolved))

  /**
   * THE CHAIN, and this is the one command where it is printed unconditionally.
   *
   * The build log stays quiet about it when a provider is named, because a line
   * restating the config file is noise in a block people read at every start.
   * `doctor` is the opposite: it is run precisely when the question is "why is
   * it talking to THAT", and the answer — which variables are set and which
   * member of the chain they select — is not visible anywhere else. The key
   * VALUE is never printed, only the name of the variable.
   */
  {
    const { tried } = resolveChain(env)
    const chosen = resolved.chat.provider
    /**
     * THE ROTATION ORDER, which is the question this command is run to answer
     * once `chat.chain` can name more than one service. `←` becomes an ordinal
     * so the order is readable at a glance; a single-member chain prints the
     * bare arrow it always did, because an ordinal on a list of one is noise.
     */
    const chain = resolveChatChain(resolved, env)
    const at = new Map(chain.map((m, i) => [m.id, i + 1]))
    const many = chain.length > 1
    say(
      'chain',
      many
        ? `${resolved.chat.providerAuto ? 'auto' : chosen} → ${chain.length} will answer, in order`
        : resolved.chat.providerAuto
          ? `auto → ${chosen}`
          : `${chosen} (named in config)`,
    )
    for (const t of tried) {
      const mark = t.found ? '✓' : '·'
      const n = at.get(t.id)
      // `←` on a row that nothing selected would read as a contradiction — the
      // dot says "not set" and the arrow says "this one". Name it instead: that
      // row is where the walk LANDED rather than what it matched.
      const here = !n
        ? ''
        : many
          ? ` ← ${n}`
          : t.found
            ? ' ←'
            : ' ←  nothing matched — fall-through'
      console.log(
        `${PAD}${mark} ${t.id.padEnd(12)}${(t.envKey || 'no key needed').padEnd(22)}${here}`.trimEnd(),
      )
    }
    /**
     * A member a key selected and the chain did not take. `resolveChatChain`
     * drops it because there is nothing to send it, and a silent drop is exactly
     * the "why is it not talking to that" this block exists to answer.
     */
    for (const t of tried) {
      if (t.found && !at.has(t.id)) {
        console.log(`${PAD}  ${''.padEnd(12)}${''.padEnd(22)}skipped — no model and no pool`)
      }
    }
  }

  /**
   * WHAT THIS SERVICE WILL ACTUALLY DO WITH YOUR KNOBS.
   *
   * A capability matrix is worth nothing if reading it means opening the source,
   * and the one fact nobody can get anywhere else is the WIRE NAME each setting
   * turns into — `chat.maxTokens` is `options.num_predict` on Ollama and
   * `max_completion_tokens` on GPT-5, and an author debugging a request they can
   * see in a network tab has no way to connect it back to what they wrote.
   *
   * Read from the same two records the transport translates from — the adapter's
   * `supports` and the brand's `caps` — so this cannot drift from the behaviour
   * it describes. No network, no flag, and it NEVER changes the exit code: a
   * knob this provider ignores is news, not a broken configuration.
   */
  {
    const adapter = providerFor(nodeChatTarget(resolved, env).provider)
    const caps = capsOf(resolved.chat.provider) || {}
    const tuning = resolveTuning(resolved)
    const chat = resolved.chat
    console.log('')
    say('knobs', `${resolved.chat.provider} · ${adapter.id} adapter`)

    const wire = (knob, value, field) => {
      if (value == null) return
      if (field) console.log(`${PAD}✓ ${knob.padEnd(12)}${String(value).padEnd(9)}→ ${field}`)
      else console.log(`${PAD}· ${knob.padEnd(12)}${String(value).padEnd(9)}NOT honoured by ${resolved.chat.provider}`)
    }

    // Reasoning first, and it prints even at its default, because "what does
    // 'auto' do here" is the question this whole feature raises.
    if (tuning.style === 'none') {
      console.log(`${PAD}· reasoning   ${String(chat.reasoning === false ? 'false' : 'auto').padEnd(9)}${caps.mandatory ? `${resolved.chat.provider} cannot turn reasoning off` : 'not offered by this provider'}`)
    } else {
      const asked = chat.reasoning && typeof chat.reasoning === 'object' ? chat.reasoning.effort : null
      const shown = chat.reasoning === false ? 'false' : (asked ?? 'auto')
      const field = {effort: 'reasoning_effort', unified: 'reasoning:{}', thinking: 'thinking', think: 'think'}[tuning.style]
      const moved = asked && tuning.effort && tuning.effort !== asked ? `  CLAMPED to '${tuning.effort}' — ${resolved.chat.provider} has no '${asked}'` : ''
      console.log(`${PAD}✓ ${'reasoning'.padEnd(12)}${String(shown).padEnd(9)}→ ${field}${moved}`)
    }

    wire('temperature', chat.temperature, caps.temperature === false ? null : adapter.supports?.temperature)
    wire('maxTokens', chat.maxTokens, adapter.supports?.maxTokens)
    wire('numCtx', chat.numCtx, adapter.supports?.numCtx)
    wire('verbosity', chat.verbosity, tuning.verbosity != null ? adapter.supports?.verbosity : null)
    wire('topP', chat.topP, tuning.topP != null ? adapter.supports?.topP : null)
    wire('seed', chat.seed, tuning.seed != null ? adapter.supports?.seed : null)

    // The ceiling field is model-resolved, so it is the one line that can differ
    // between two models on the SAME provider — and the one that turns every
    // request into a 400 when it is wrong.
    if (adapter.id !== 'ollama' && adapter.id !== 'anthropic' && chat.model) {
      const field = /(^|\/)(o[1-9](\b|-)|gpt-5|codex-mini)/i.test(chat.model) ? 'max_completion_tokens' : 'max_tokens'
      if (field !== 'max_tokens') console.log(`${PAD}  ${chat.model} takes ${field}, not max_tokens`)
    }

    if (caps.unknown) {
      console.log(`${PAD}! ${resolved.chat.provider} names a host, not a service — DocPilot cannot know what`)
      console.log(`${PAD}  your gateway accepts, so every knob above is sent as written`)
    } else if (caps.modelDependent && tuning.style !== 'none') {
      console.log(`${PAD}! support varies by model here — a level is sent and the service decides`)
    }
    // The interaction nobody would predict, and the one that turns an answerable
    // question into "no provider available" on a thin free pool.
    if (tuning.style === 'unified' && tuning.effort && resolved.chat.extraBody?.provider?.require_parameters !== false) {
      console.log(`${PAD}! reasoning + provider.require_parameters narrows routing a second time`)
    }

    /**
     * THE BLOCK ABOVE IS THE HEAD'S, and on a chain it is one member's answer to
     * a question the reader asked about the deployment. Every member clamps the
     * same neutral vocabulary to its own service, so a knob this one honours can
     * be dropped by the next — and a knob nobody can see dropped is the
     * "documented setting whose only reachable value is its default" defect,
     * arriving one level up.
     *
     * One line per member that differs, and nothing at all when they agree.
     */
    const chain = resolveChatChain(resolved, env)
    if (chain.length > 1) {
      const shown = ['effort', 'verbosity', 'topP', 'seed', 'budgetTokens']
      for (const m of chain.slice(1)) {
        const t = resolveTuning(resolved, m.id)
        const dropped = shown.filter((k) => tuning[k] != null && t[k] == null)
        const off = t.style === 'none' && tuning.style !== 'none'
        if (!dropped.length && !off) continue
        const what = [...dropped, ...(off ? ['reasoning'] : [])].join(', ')
        console.log(`${PAD}  ${m.id.padEnd(12)}drops ${what}`)
      }
    }
  }

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
      const cred = r.keyless ? 'no key needed' : r.envKey ? `<${r.envKey}>` : 'NO KEY — none set'
      console.log(`${PAD}${r.header}: ${cred}`)
      if (r.local) console.log(`${PAD}! LOCAL ADDRESS — a deployed proxy cannot reach it`)
    }
    /**
     * The members with NO route — a local Ollama, which the browser calls at its
     * own address. Printed under their own label because a five-member chain
     * showing four routes and no account of the fifth reads as a bug here.
     */
    for (const d of contract.direct) {
      say('direct', `${d.provider} → ${d.baseURL}`)
      console.log(`${PAD}! the browser calls this itself — no proxy route, and none possible`)
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

    /**
     * THE NAMED MODEL, checked against the service's own list.
     *
     * The pool check above answers "are the free ids we shipped still served",
     * which was the only question worth asking while `chat.model` had one
     * shipped value. Every provider carries its own default now, and a default
     * ages exactly the way a free id does — `gpt-4o-mini` is a name in a table
     * in this package, not a promise from OpenAI. The failure it produces is a
     * 404 naming a model that appears nowhere in the reader's config, which is
     * the same illegible failure the pool check exists to prevent.
     *
     * Asked of `/v1/models` — or Ollama's `/api/tags`, which lists what has been
     * PULLED, the honest local equivalent — through the adapter, so there is no
     * second copy of a path here. Every failure is reported as a failure to
     * check rather than as a verdict: a catalogue that is unreachable, a key
     * that is not set, a provider with no directly-callable base (Gemini serves
     * its compatible surface under a rewrite the browser's `/ai` hides and a
     * Node tool has nothing to hide it with).
     */
    const target = nodeChatTarget(resolved, env)
    if (!target.models?.length && target.model) {
      const adapter = providerFor(target.provider)
      const url = adapter.modelsUrl?.(target.baseURL)
      const hosted = target.id !== 'ollama'
      if (!target.baseURL || !url) {
        say('model', `${target.model} — ${target.id} publishes no list this can read`)
      } else if (hosted && !target.apiKey) {
        say('model', `${target.model} — no key set, cannot ask ${target.id}`)
      } else {
        /**
         * ONE PROBE, IN ONE PLACE. This block used to hold its own `fetch`,
         * its own error handling and its own idea of what a missing model
         * means, and it got local servers wrong in both directions: it judged
         * llama.cpp's placeholder against a catalogue it is not in, and it
         * advised an Ollama user to "upgrade the package" when the thing to do
         * is pull the model. `inspectChatTarget` answers all of it and never
         * throws — see src/build/lib/chat-preflight.js for why it may not.
         */
        const seen = await inspectChatTarget(target)
        const extra = []
        if (seen.capabilities) {
          extra.push(`tools ${seen.capabilities.tools ? 'yes' : 'no'}`)
          extra.push(`thinking ${seen.capabilities.thinking ? 'yes' : 'no'}`)
        }
        if (seen.contextLength) extra.push(`ctx ${seen.contextLength}`)

        if (seen.verdict === 'placeholder') {
          // Not a failure and not a name to fix: this service answers with the
          // weights it was started with, whatever the config says.
          say('model', `${target.id} serves whatever it loaded${seen.loaded ? ` — ${seen.loaded}` : ''}`)
          console.log(`${PAD}chat.model is a placeholder here and is ignored${extra.length ? ` · ${extra.join(' · ')}` : ''}`)
        } else if (seen.verdict === 'served') {
          say('model', `${target.model} — ${hosted ? `served by ${target.id}` : `pulled by ${target.id}`}`)
          if (extra.length) console.log(`${PAD}${extra.join(' · ')}`)
        } else if (seen.verdict === 'not-served') {
          const n = seen.serves.length
          say('model', `${target.model} — NOT ${hosted ? `in ${target.id}'s list of ${n}` : `pulled by ${target.id} (${n} available)`}`)
          // The ACTIONABLE line, and it differs by service. Nothing an author
          // types fixes a local server that has not downloaded the weights.
          if (hosted) console.log(`${PAD}name one in chat.model, or upgrade the package`)
          else if (target.modelAuto) console.log(`${PAD}${target.id} pull ${target.model}   — or name one you have in chat.model`)
          else console.log(`${PAD}${target.id} pull ${target.model}`)
        } else if (seen.serves === null) {
          say('model', `${target.model} — cannot reach ${target.id}`)
        } else {
          say('model', `${target.model} — ${target.id} returned no list`)
        }
      }
    }

    /**
     * DOES THE CHAT PROVIDER EMBED AFTER ALL?
     *
     * `PROVIDERS` carries `embedModel: null` for anthropic, groq, deepseek, xAI
     * and cerebras, and that is a claim rather than a law: the same table
     * asserted for months that OpenRouter ships no embeddings endpoint, which
     * was true when it was written and silently wrong afterwards. The cost of
     * the claim going stale is paid every build — `embed: 'auto'` borrows
     * OpenRouter's free pool, so the deployment needs a SECOND key and posts the
     * text of the whole corpus to a third party.
     *
     * So it is checked, here, where checking is free. It cannot be acted on
     * automatically: the proxy that carries `/ai/v1/embeddings` is written from
     * `resolveEmbed()` at config time, synchronously, with no network — so a
     * build that decided mid-flight to embed somewhere else would leave every
     * reader's query vector posted to the wrong upstream. This reports; the
     * author writes the one line.
     *
     * Silent when the endpoint does not answer, which is the expected case and
     * the one nobody needs told. Skipped outright for an adapter with no
     * embeddings path at all — Anthropic — because there is nowhere to knock.
     */
    const embedNow = resolveEmbed(resolved)
    if (embedNow.borrowed && target.baseURL) {
      const adapter = providerFor(target.provider)
      const url = adapter.embedUrl?.(target.baseURL)
      const probe = adapter.embedUrl && url ? await probeEmbedEndpoint(target) : null
      if (probe) {
        say('embed?', `${target.id} answers ${url.replace(target.baseURL, '')} after all — ${probe}`)
        console.log(`${PAD}embed: {provider: '${target.id}'} drops the borrowed ${embedNow.provider} key`)
      }
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
