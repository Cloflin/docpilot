/**
 * Every flag every command takes, declared once — and the two things that fall
 * out of the declaration: the check, and the help.
 *
 * WHY THIS FILE EXISTS. Flag handling was per-command folklore. Five separate
 * parsers, no shared helper, and a quality that ranged from `tune.ts` — which
 * rejects an unknown flag, a value flag written without its `=`, and a `--limit`
 * that is not a positive integer, all before anything is loaded or embedded — to
 * `calibrate.ts`, which validated nothing at all. The commands with no checks
 * are exactly the commands that spend money:
 *
 *   · `docpilot calibrate --help` ran a full calibration. So did `eval --help`,
 *     `index --help` and `vocabulary --help`. `--help` is the most reflexive
 *     thing a person types at an unfamiliar CLI, and on four commands it was a
 *     purchase order.
 *   · `eval --limit=abc` is `Number('abc')` — NaN, which is falsy, which
 *     `slice(0, LIMIT || undefined)` reads as "no limit". The full pool ran and
 *     the report header printed the count as though it had been asked for.
 *   · `calibrate --limt=3` named no flag this package has, so it was dropped in
 *     silence and all 597 probes were embedded.
 *   · `vocabulary --limit` with no value took `value()`'s `true`, and
 *     `Number(true)` is 1 — a limit of one term, which is neither the default
 *     nor anything anybody typed.
 *
 * THE HELP COMES FROM THE SAME OBJECT AS THE CHECK, and that is the point of
 * declaring rather than hand-writing. A usage block maintained beside a parser
 * is a usage block that drifts from it; one rendered out of the parser's own
 * table cannot. `helpFor()` below has no list of its own.
 *
 * PURE, AND IT DOES NOT EXIT. `flagErrors()` returns strings because the callers
 * disagree about what to do with them — `eval` and `tune` `die()`, while
 * `import`, `feedback` and `vocabulary` return an exit code up to the launcher —
 * and because a check that ends the process is a check no unit test can run.
 */

import { pathToFileURL } from 'node:url'

import { PROVIDER_IDS } from './config.js'
import { UI_PANELS, UI_TRIGGER_WORD_LIST } from './theme/docpilot/ui.js'

/**
 * What a flag's value may be.
 *
 * `bool` takes none. `value` takes any string. `int` is the kind `tune` added by
 * hand after `--limit=abc` swept a whole pool and shipped the answer — a flag
 * that decides how much work happens may not fail open. `enum` is the same
 * argument for a fixed vocabulary: `--fallback=grbge` silently meant `auto`, and
 * `--anchors=grbge` silently meant `bounded`, because both were read with a
 * `!== 'other'` test that anything unrecognised passes on the wrong side.
 *
 * `list` is `value` with a comma in it, kept separate only so the help can say
 * so.
 */
/**
 * `--level` is `value`, not `enum`, and that is deliberate.
 *
 * `parseLevelArg` already refuses an unknown tier — "An unknown tier is refused
 * rather than defaulted, by every command that takes the flag", says cli.md, and
 * three commands' tests hold it to that. Declaring the vocabulary here too would
 * put a second, differently-worded refusal in front of the one that exists, for
 * a case that was never failing open. The only half that WAS failing open is the
 * bare `--level low`, and that is a kind-independent check.
 */
const BENCH_MODES = ['emit', 'shard', 'score', 'runs', 'judge-emit', 'judge-score']
const FEEDBACK_MODES = ['pull', 'report', 'faq']

/**
 * THE TABLE. One entry per command in `bin/docpilot.js`'s `COMMANDS`.
 *
 * `grammar: 'both'` marks the two commands that have always read `--flag value`
 * with a space — `import` and `feedback`. The space form is not removed, because
 * it is the only form their documentation ever showed; it is deprecated, warned
 * about once, and absent from the help. See `spaceFormWarning`.
 *
 * `help` on a flag is one line. A flag that needs a paragraph is documented in
 * `docs/reference/cli.md`, which the help points at, and `test/cli-flags.test.js`
 * holds the two in agreement in both directions.
 */
/**
 * THE DOCUMENTATION SITE, NAMED ONCE.
 *
 * It was written by hand in the footer of every command's help, and `homepage`
 * in `package.json` is NOT this address — that field is the package's page, and
 * pointing a "Full reference" line at it would send a reader looking for
 * `--level` to a README. So the address gets a name, here, beside the table
 * whose help prints it, and `test/cli-flags.test.js` reads the same constant
 * rather than a second copy of the string.
 */
export const DOCS_URL = 'https://docpilot.dev'

export const COMMANDS = {
  index: {
    summary: 'build the retrieval index from your docs',
    // `equals`, and the two halves of this command now agree. `argValue` in
    // build-rag-index.js used to take `--html-select main` as readily as
    // `--html-select=main` — but `parseEmbedFlags`, which reads the OTHER four
    // flags of the same command line, has only ever taken `=`, and no line of
    // documentation shows the space form for either half. One command that
    // spells its flags two ways depending on which flag you picked is worse
    // than one spelling; `import` and `feedback` keep the space form because
    // their pages have always shown it.
    flags: [
      { name: 'dry', kind: 'bool', help: 'chunk and report; no embeddings, no network, no cost' },
      { name: 'no-embed', kind: 'bool', help: 'a real index with no vectors in it' },
      { name: 'refresh-embeddings', kind: 'bool', help: 'ignore the embed cache and buy the corpus again' },
      { name: 'html-dir', kind: 'value', example: 'dist', help: 'also index a site that is already built — any generator, no markdown needed' },
      { name: 'html-select', kind: 'value', example: 'main', help: 'the CSS selector naming the body of a built page' },
      { name: 'html-base', kind: 'value', example: 'https://example.com', help: 'the origin those built pages are served from' },
      { name: 'sitemap', kind: 'value', example: 'dist/sitemap.xml', help: 'limit --html-dir to the published routes' },
      { name: 'embed-provider', kind: 'enum', values: [...PROVIDER_IDS, 'none'], example: 'ollama', help: 'build with this embedder instead of the one your config names' },
      { name: 'embed-model', kind: 'value', example: 'bge-m3', help: 'the model, when the provider serves more than one' },
      { name: 'embed-base-url', kind: 'value', example: 'http://localhost:11434', help: 'where a local server is; required when it is not on this machine' },
      { name: 'index-dir', kind: 'value', example: 'docs/public/rag-ollama', help: 'write here instead of over the index your site reads' },
      { name: 'yes', kind: 'bool', alias: 'y', help: 'take the config as it stands and ask nothing' },
    ],
    epilogue:
      'It asks which embedder to build with; the first answer is what your config\n' +
      'already names, so Enter changes nothing. The question needs a terminal, so\n' +
      'CI and Docker never see it. `doctor --embed` prints the same list.',
  },

  import: {
    summary: 'turn an allowlisted external page into a page of the corpus',
    grammar: 'both',
    positional: { name: 'url', help: 'the page to import; must be allowlisted by `sources`' },
    flags: [
      { name: 'dry', kind: 'bool', alias: 'dry-run', help: 'print the report and write nothing' },
      { name: 'html', kind: 'value', example: './page.html', help: 'read HTML from a file or `-` for stdin instead of fetching' },
      { name: 'out', kind: 'value', example: 'their-guide', help: "the file name under `importDir`; defaults to the URL's last segment" },
      { name: 'lang', kind: 'value', example: 'en', help: 'the `accept-language` to ask for' },
      { name: 'no-alternate', kind: 'bool', help: 'do not look for a published `.md`; convert the HTML' },
      { name: 'no-annotate', kind: 'bool', help: 'skip the model pass' },
      { name: 'force', kind: 'bool', help: 'replace a file that already exists' },
    ],
  },

  vocabulary: {
    summary: 'propose the names readers use for what your docs call something',
    flags: [
      { name: 'languages', kind: 'list', example: 'ru,de', help: 'the languages to translate into; defaults to `en` plus your `i18n.locales`' },
      { name: 'limit', kind: 'int', min: 1, example: '24', help: 'how many terms to keep; default 24' },
      { name: 'replace', kind: 'bool', help: "take the model's list whole instead of merging the file into it" },
      { name: 'dry', kind: 'bool', help: 'print the proposal and write nothing' },
      { name: 'out', kind: 'value', example: 'docpilot/vocabulary.json', help: 'somewhere other than `${evalDir}/vocabulary.json`' },
    ],
  },

  calibrate: {
    summary: 'measure the refusal thresholds against your corpus',
    flags: [
      { name: 'sweep-only', kind: 'bool', help: 'sweep the cached probe scores, embed nothing' },
      { name: 'refresh', kind: 'bool', help: 'ignore that cache and re-embed every probe' },
      { name: 'limit', kind: 'int', min: 1, example: '50', help: 'the first N probes of the set; default all' },
      { name: 'transfer', kind: 'value', example: 'docpilot/calibration.json', help: "carry another embedder's calibration onto this index" },
      { name: 'anchors', kind: 'enum', values: ['bounded', 'full'], example: 'bounded', help: 'how much of the probe set a transfer measures' },
      { name: 'out', kind: 'value', example: 'docpilot/calibration.rag.json', help: 'where to write; required for a transfer' },
    ],
  },

  eval: {
    summary: 'run the golden set and write a report',
    flags: [
      { name: 'level', kind: 'value', example: 'low', help: 'which pool to score; default `ultra`, the whole set' },
      { name: 'limit', kind: 'int', min: 1, example: '3', help: 'the first N records of the selected tier — a head-slice, not a sample' },
      { name: 'models', kind: 'list', example: 'qwen3:8b,phi4:14b', help: 'the matrix, one report per model' },
      { name: 'model', kind: 'value', example: 'qwen3:8b', help: 'the one-model alias of --models' },
      { name: 'gate-only', kind: 'bool', help: 'retrieval and the gate only, no model called — seconds, and free' },
      { name: 'lexical', kind: 'bool', help: 'additionally disable the dense channel' },
      { name: 'resume', kind: 'bool', help: 'reuse a report already on disk for that model' },
      { name: 'provider', kind: 'value', example: 'ollama', help: 'the wire adapter: `ollama`, `openai` or `anthropic`' },
      { name: 'fallback', kind: 'enum', values: ['auto', 'on', 'off'], example: 'auto', help: 'which transport the answering half runs on' },
      { name: 'max-iterations', kind: 'int', min: 1, example: '2', help: "the agent loop's ceiling" },
      { name: 'num-ctx', kind: 'int', min: 1, example: '8192', help: 'the context window pinned per request; Ollama only' },
    ],
  },

  bench: {
    summary: 'compare two retrieval configurations on answer quality',
    positional: { name: 'mode', values: BENCH_MODES, help: 'which stage of the bench to run' },
    flags: [
      { name: 'config', kind: 'value', example: 'base', help: 'names the configuration and the default output file' },
      { name: 'level', kind: 'value', example: 'low', help: 'which pool to emit; default `ultra`' },
      { name: 'out', kind: 'value', example: 'docpilot/bench/base.tasks.jsonl', help: 'where to write' },
      { name: 'history', kind: 'value', example: 'docpilot/bench/base.answers.jsonl', help: 'ONE file holding EVERY earlier pass\'s answers — append to it between passes; a chain of depth D takes D+1 of them' },
      { name: 'tasks', kind: 'list', example: 'a.tasks.jsonl,b.tasks.jsonl', help: 'one file for `shard`; two for `runs` and `judge-emit`' },
      { name: 'answers', kind: 'list', example: 'a.answers.jsonl,b.answers.jsonl', help: 'the answering runs, one per task file and in the same order' },
      { name: 'shards', kind: 'int', min: 1, example: '10', help: 'how many files to split into; capped at the task count' },
      { name: 'dir', kind: 'value', example: 'docpilot/bench', help: "where the shards go; default the task file's own directory" },
      { name: 'stage', kind: 'int', min: 1, example: '2', help: 'emit only tasks of that stage; default all' },
      { name: 'runs-a', kind: 'list', example: 'a1.jsonl,a2.jsonl', help: "config A's answer files, one per run" },
      { name: 'runs-b', kind: 'list', example: 'b1.jsonl,b2.jsonl', help: "config B's, and the same count" },
      { name: 'key', kind: 'value', example: 'id', help: 'the field two files are joined on' },
      { name: 'verdicts', kind: 'value', example: 'docpilot/bench/judge.answers.jsonl', help: "the judge's own answer file" },
    ],
  },

  tune: {
    summary: 'sweep the retrieval levers against the golden set',
    flags: [
      { name: 'level', kind: 'value', example: 'low', help: 'which pool to sweep; default `high`' },
      { name: 'lambda', kind: 'value', example: '0.5:1.0:0.05', help: 'the MMR lambda axis, as from:to:step' },
      { name: 'k', kind: 'value', example: '4:12', help: 'the topK axis, as from:to' },
      { name: 'limit', kind: 'int', min: 1, example: '10', help: 'the first N records; a narrowed run will not write tuning.json' },
      { name: 'dry', kind: 'bool', help: 'print the grid and write nothing' },
    ],
    epilogue:
      'It writes docpilot/tuning.json and stops. `index` is the step that inlines a\n' +
      'swept lever into the manifest a reader downloads — until it runs, a tuned\n' +
      'lever is a file on disk and nothing more.',
  },

  lint: {
    summary: 'check the golden set against the index it measures',
    flags: [
      { name: 'file', kind: 'value', example: 'docpilot/golden.jsonl', help: 'lint this file instead of ${evalDir}/golden.jsonl' },
      { name: 'json', kind: 'bool', help: 'one object on stdout instead of the report; the exit code is unchanged' },
    ],
  },

  feedback: {
    summary: "turn readers' votes into candidates for the eval sets",
    grammar: 'both',
    positional: { name: 'mode', values: FEEDBACK_MODES, help: 'pull aggregates, report summarises, faq ranks the openers' },
    flags: [
      { name: 'from', kind: 'value', example: './export.jsonl', help: 'a JSONL/JSON export of your own storage, or a GET endpoint' },
      { name: 'since', kind: 'value', example: '2026-01-01', help: 'passed through to a URL source as ?since=' },
      { name: 'max-pages', kind: 'int', min: 1, example: '50', help: 'stop after n pages of a paginated URL source' },
      { name: 'out', kind: 'value', example: 'docpilot/candidates.jsonl', help: 'override the output path' },
    ],
    epilogue:
      'This package ships no database driver: the panel POSTs to an endpoint you\n' +
      'run, into storage you chose, and you export from it. It never writes to the\n' +
      'eval sets — a stratum is a judgement and a gold answer is written by a person.\n' +
      '\n' +
      // Carried over from the hand-written usage block this help replaced: it is
      // the one fact about `--from` that neither the flag's own line nor the
      // reference page states, and a URL source is unauthenticated without it.
      'A URL source sends `Authorization: Bearer $DOCPILOT_FEEDBACK_TOKEN` when\n' +
      'that variable is set.',
  },

  doctor: {
    summary: 'check the configuration without a full build',
    flags: [
      { name: 'json', kind: 'bool', help: 'one object on stdout instead of the report; the exit code is unchanged' },
      { name: 'proxy', kind: 'bool', help: 'print the contract a production reverse proxy has to satisfy' },
      { name: 'embed', kind: 'bool', help: 'list every embedder this project could build with, and the command that picks each' },
      { name: 'models', kind: 'bool', help: "check a free pool against the provider's live catalogue — the only flag here that reaches a third party" },
    ],
  },

  init: {
    summary: 'scaffold the environment, the eval sets and the authoring skills',
    flags: [
      { name: 'trigger', kind: 'enum', values: [...UI_TRIGGER_WORD_LIST, 'nav,fab'], example: 'fab', help: 'where the button lives; takes a comma list too' },
      { name: 'panel', kind: 'enum', values: UI_PANELS, example: 'drawer', help: 'the shape of the panel' },
      // `list`, not `enum`, for the same reason `--trigger` is: a project may
      // want Claude Code AND Cursor, and an enum cannot say so. The typo check
      // moves into `src/cli-skills.ts`, which owns the ids.
      { name: 'target', kind: 'list', example: 'claude,cursor', help: 'which agent tools get the skills and the /docpilot-* commands' },
      { name: 'scope', kind: 'enum', values: ['project', 'user'], example: 'user', help: 'into this repository, or into your home directory' },
      { name: 'skills-dir', kind: 'value', example: '.agents/skills', help: 'a directory of your own, instead of a tool the table knows' },
      { name: 'commands-dir', kind: 'value', example: '.cursor/commands', help: 'where the /docpilot-* slash commands go' },
      { name: 'no-commands', kind: 'bool', help: 'install the skills and generate no slash commands' },
      { name: 'yes', kind: 'bool', alias: 'y', help: 'take the defaults and ask nothing' },
    ],
  },

  /**
   * The command that did not exist, and the gap it fills is named in the
   * reference it replaces: `init` writes a file only where nothing is, so a
   * project that ran it once kept its skills across every upgrade that rewrote
   * them. The documented workaround was `rm -rf` and re-run.
   *
   * `--check` is the CI form of `--dry` — same report, and an exit code instead
   * of a reading. It is the only way a repository can hold itself to shipping
   * the skills its installed DocPilot actually carries.
   */
  update: {
    summary: 'refresh the installed skills and the /docpilot-* slash commands',
    flags: [
      { name: 'target', kind: 'list', example: 'claude,cursor', help: 'also install into these, rather than only refreshing what is here' },
      { name: 'scope', kind: 'enum', values: ['project', 'user'], example: 'user', help: 'work on the project copies, or the ones in your home directory' },
      { name: 'skills-dir', kind: 'value', example: '.agents/skills', help: 'refresh or install at a directory of your own' },
      { name: 'commands-dir', kind: 'value', example: '.cursor/commands', help: 'where the /docpilot-* slash commands go' },
      { name: 'no-commands', kind: 'bool', help: 'refresh the skills and leave the slash commands alone' },
      { name: 'dry', kind: 'bool', help: 'print the whole report and write nothing' },
      { name: 'check', kind: 'bool', help: 'write nothing; exit 1 when anything is out of date' },
    ],
    epilogue:
      'It updates the files this package COPIED into your project — not the package\n' +
      'itself; that is `npm install @cloflin/docpilot@latest`, and this is what you\n' +
      'run after it. With no flags it finds every install on this machine and\n' +
      'refreshes each one.\n' +
      '\n' +
      'A file you edited is replaced and your version is kept beside it as `.bak`,\n' +
      'named in the report. A file you did not edit is replaced in silence.',
  },
}

/** Every spelling that names this flag — its own, plus an alias if it has one. */
const namesOf = (flag) => (flag.alias ? [flag.name, flag.alias] : [flag.name])

/**
 * The name a token spells, or null when its dashes do not spell one.
 *
 * WHY THE DASHES ARE COUNTED AT ALL. Every strip in this file used to be
 * `^--?`, so one dash on a long name was legal all the way through: the table
 * matched `-level=low`, `flagErrors` returned nothing, and the command's own
 * `arg()` — which matched `--level=` and only that — read the flag as ABSENT
 * and took the widest default. Silent, and destructive on the one flag that
 * decides how much of the pool runs.
 *
 * POSIX draws the line this draws: one dash introduces a SHORT option, two a
 * long one. So the check is against the NAME's length rather than against the
 * dash — `-y`, `-h` and `-v` are short options, they are spelled that way in
 * the table and in the help, and they stay.
 */
function bareOf(token) {
  if (token.startsWith('--')) return token.slice(2)
  if (!token.startsWith('-')) return null
  const bare = token.slice(1)
  return bare.split('=')[0].length === 1 ? bare : null
}

/** The flag a token names, or undefined. `--limit=5` and `--limit` both hit. */
function flagFor(spec, token) {
  const bare = bareOf(token)
  if (bare == null) return undefined
  const name = bare.split('=')[0]
  return spec.flags.find((f) => namesOf(f).includes(name))
}

/**
 * `-level=low` — one dash on a long name — respelled with two, or null.
 *
 * Worth its own message rather than falling into `unknown flag`: the flag IS
 * this command's, the reader typed its name correctly, and a list of every
 * flag the command takes answers a question they did not ask.
 */
function longFormOf(spec, token) {
  if (token.startsWith('--') || !token.startsWith('-')) return null
  const bare = token.slice(1)
  const name = bare.split('=')[0]
  if (name.length <= 1) return null
  return spec.flags.some((f) => namesOf(f).includes(name)) ? `--${bare}` : null
}

/**
 * `--level=low`, as the message shows it.
 *
 * EXPORTED for `src/cli-slash.ts`, which renders the same spelling into the
 * `argument-hint` of every generated slash command. A second copy of this one
 * line would be a second place for `--flag=value` to be spelled, in a file
 * whose entire argument is that there is only ever one.
 */
export const exampleOf = (flag) =>
  flag.kind === 'bool' ? `--${flag.name}` : `--${flag.name}=${flag.example ?? 'value'}`

/**
 * The same, plus the alias — for the HELP only.
 *
 * Three flags in this package have a second spelling and the help named none of
 * them: `-y` for `--yes` on `index` and `init`, `--dry-run` for `--dry` on
 * `import`. A documented alias nobody can discover is an alias that exists only
 * for the person who wrote it. Error messages keep `exampleOf` — a reader who
 * mistyped a flag wants the one spelling to use, not two.
 */
const helpExampleOf = (flag) =>
  // The alias gets the dash count its own LENGTH earns, the same rule the
  // parser applies: `-y` is a short option, `--dry-run` is a long one.
  flag.alias
    ? `${exampleOf(flag)}, ${flag.alias.length === 1 ? '-' : '--'}${flag.alias}`
    : exampleOf(flag)

/**
 * The value a flag was given, or null when it was not given.
 *
 * `slice(1).join('=')`, never `split('=')[1]` — a value may itself contain an
 * `=`, and `lint-golden.js` was the one copy of this helper that truncated at
 * the first one while the other four did not.
 */
function valueIn(argv, flag, grammar) {
  for (const [i, token] of argv.entries()) {
    const bare = bareOf(token)
    if (bare == null) continue
    for (const name of namesOf(flag)) {
      if (bare.startsWith(`${name}=`)) return bare.slice(name.length + 1)
      // The space form, and ONLY where a command has always accepted it. The
      // next token is refused when it is itself a flag: `--out --force` used to
      // mean `out === '--force'` AND silently eat the `--force`.
      if (bare === name && grammar === 'both') {
        const next = argv[i + 1]
        return next != null && !next.startsWith('-') ? next : null
      }
    }
  }
  return null
}

/**
 * THE CHECK — everything `assertKnownFlags` in tune.js did, for every command.
 *
 * Returns messages rather than exiting, because the callers disagree about how
 * to fail and because a check that ends the process cannot be unit-tested. The
 * WORDING is tune's and run's, unchanged: a reader who meets this in `eval` and
 * again in `tune` should read one sentence, not two dialects of one.
 *
 * @param command one of the keys of `COMMANDS`
 * @param argv    the flags only — `process.argv.slice(2)` after the launcher has
 *                rewritten argv[1], so the subcommand is already gone
 */
export function flagErrors(command, argv = []) {
  const spec = COMMANDS[command]
  if (!spec) return []
  const out = []
  const grammar = spec.grammar ?? 'equals'
  const taken = new Set()
  // Which flags have been named already, so the SECOND `--level` is a message
  // rather than a token nobody reads: every reader in this package finds the
  // first match and stops, so `--level=low --level=high` ran the high tier's
  // opposite in silence.
  const named = new Map()
  // POSIX's option terminator. It used to be reported as `unknown flag --`,
  // which is the one thing it certainly is not; after it every token is an
  // operand, and this command's rules for operands are the ones below.
  const end = argv.indexOf('--')
  const opts = end === -1 ? argv : argv.slice(0, end)
  const operands = end === -1 ? [] : argv.slice(end + 1)
  // Counted rather than read off the index, because `--` moves everything after
  // it and the mode of `bench` is still the first operand either way.
  let positionals = 0

  const operand = (token) => {
    // A positional. `bench` and `feedback` take a mode, `import` takes a URL;
    // anything else has no place for one, and a stray word there is almost
    // always a value that lost its `=`.
    if (!spec.positional) out.push(strayPositional(token, spec, command))
    else if (spec.positional.values && !spec.positional.values.includes(token) && positionals === 0) {
      out.push(
        `unknown ${spec.positional.name} "${token}"\n` +
          `        one of: ${spec.positional.values.join(', ')}`,
      )
    }
    positionals++
  }

  for (const [i, token] of opts.entries()) {
    if (taken.has(i)) continue
    if (!token.startsWith('-')) {
      operand(token)
      continue
    }

    const flag = flagFor(spec, token)
    if (!flag) {
      const long = longFormOf(spec, token)
      out.push(long ? oneDashFlag(token, long) : unknownFlag(token, spec, command))
      continue
    }

    if (named.has(flag.name)) {
      out.push(repeatedFlag(flag, named.get(flag.name), token))
      // The repeat's own value is not re-checked: one mistake, one message.
      if (!token.includes('=') && grammar === 'both') {
        const next = opts[i + 1]
        if (next != null && !next.startsWith('-')) taken.add(i + 1)
      }
      continue
    }
    named.set(flag.name, token)

    const hasEquals = token.includes('=')
    if (flag.kind === 'bool') {
      if (hasEquals) out.push(`--${flag.name} takes no value: ${token}`)
      continue
    }

    if (!hasEquals) {
      if (grammar !== 'both') {
        // `arg()` matches `--name=` and nothing else, so `--level low` left
        // `low` as a stray positional and the flag read as ABSENT — and absent
        // means the widest possible default. A flag that silently means its
        // opposite is worse than one that throws.
        out.push(`--${flag.name} takes a value: ${exampleOf(flag)}`)
        // Swallow what it was reaching for, so the one mistake is reported once:
        // `--level low` is a bare flag, not a bare flag AND a stray word.
        if (opts[i + 1] != null && !opts[i + 1].startsWith('-')) taken.add(i + 1)
        continue
      }
      const next = opts[i + 1]
      if (next == null || next.startsWith('-')) {
        out.push(`--${flag.name} takes a value: ${exampleOf(flag)}`)
        continue
      }
      taken.add(i + 1)
    }

    const value = hasEquals ? token.slice(token.indexOf('=') + 1) : opts[i + 1]
    const bad = badValue(flag, value)
    if (bad) out.push(bad)
  }

  for (const token of operands) operand(token)

  return out
}

/**
 * `int` and `enum` are the two kinds that used to fail open, and they failed
 * open in the same shape: an unrecognised value passed the test on the side that
 * means "the widest thing this command can do".
 */
function badValue(flag, value) {
  if (flag.kind === 'int') {
    const n = Number(value)
    if (!(Number.isInteger(n) && n >= (flag.min ?? 1))) {
      // tune.js's sentence, word for word. A reader who meets this in `eval` and
      // again in `tune` should read one dialect, and this one was already
      // written, already tested, and already right.
      return `--${flag.name}="${value}" must be a positive whole number, e.g. ${exampleOf(flag)}`
    }
  }
  if (flag.kind === 'enum' && !flag.values.includes(value)) {
    return (
      `--${flag.name}="${value}" is not one of them\n` +
      `        one of: ${flag.values.join(', ')}`
    )
  }
  if (flag.kind !== 'bool' && value === '') {
    return `--${flag.name}= was given no value: ${exampleOf(flag)}`
  }
  return null
}

/**
 * The list, or a pointer to it.
 *
 * `tune` printed all five of its flags in the message and that was right for
 * five. `index` has twelve and `bench` thirteen, and a wall of them under a
 * one-word typo buries the typo. Past six, the help is one keystroke away and
 * says the same thing better.
 */
const takesLine = (spec, command) =>
  spec.flags.length <= 6
    ? `        takes: ${spec.flags.map(exampleOf).join('  ')}`
    : `        docpilot ${command} --help  lists what it takes.`

const unknownFlag = (token, spec, command) =>
  `unknown flag ${token}\n${takesLine(spec, command)}`

const oneDashFlag = (token, long) =>
  `unknown flag ${token}\n        long flags take two dashes: ${long}`

const repeatedFlag = (flag, first, again) =>
  `--${flag.name} was given twice: ${first} then ${again}\n` +
  '        every reader in this package takes the first and ignores the rest, so ' +
  'name it once.'

const strayPositional = (token, spec, command) =>
  `unexpected argument "${token}"\n${takesLine(spec, command)}`

/**
 * Said once, and only by the two commands that have always taken the space form.
 *
 * Not an error: `--from ./export.jsonl` is the spelling their documentation has
 * always shown, and breaking it would break every script anybody wrote from that
 * page. `=` is what the help prints and what everything else in this CLI
 * accepts, so the warning names it and moves on.
 */
export function spaceFormWarning(command, argv = []) {
  const spec = COMMANDS[command]
  if (spec?.grammar !== 'both') return null
  const used = spec.flags.find(
    (f) => f.kind !== 'bool' && argv.some((t) => namesOf(f).includes(bareOf(t) ?? '\u0000')),
  )
  return used
    ? `--${used.name} <value> still works, but ${exampleOf(used)} is the spelling ` +
        'every other docpilot command takes.'
    : null
}

/** Read a flag's value the way its command spells it. Null when absent. */
export function flagValue(command, argv, name, dflt = null) {
  const spec = COMMANDS[command]
  const flag = spec?.flags.find((f) => f.name === name)
  if (!flag) return dflt
  return valueIn(argv, flag, spec.grammar ?? 'equals') ?? dflt
}

/** Was a boolean flag given? Honours its alias. */
export function flagGiven(command, argv, name) {
  const spec = COMMANDS[command]
  const flag = spec?.flags.find((f) => f.name === name)
  if (!flag) return false
  return argv.some((t) => namesOf(flag).includes(bareOf(t) ?? '\u0000'))
}

/**
 * THE HELP — rendered from the table above and from nothing else.
 *
 * There is no second list here to fall out of step with the parser, which is the
 * whole reason the table exists. A flag added to `COMMANDS` appears in the help
 * of its command without anybody remembering to add it, and a flag removed
 * disappears from it the same way.
 */
export function helpFor(command) {
  const spec = COMMANDS[command]
  if (!spec) return null
  const arg = spec.positional ? ` <${spec.positional.name}>` : ''
  const lines = ['', `  docpilot ${command}${arg}`, '', `    ${spec.summary}`, '']

  if (spec.positional?.values) {
    lines.push(`  <${spec.positional.name}>  one of: ${spec.positional.values.join(', ')}`, '')
  }

  const width = Math.max(...spec.flags.map((f) => helpExampleOf(f).length))
  for (const flag of spec.flags) {
    lines.push(`  ${helpExampleOf(flag).padEnd(width)}  ${flag.help}`)
  }

  if (spec.epilogue) lines.push('', ...spec.epilogue.split('\n').map((l) => `  ${l}`))
  lines.push('', `  Full reference: ${DOCS_URL}/reference/cli#${command}`, '')
  return lines.join('\n')
}

/**
 * The check, but only when this module IS the command being run.
 *
 * A module-scope guard that ignored that was a real regression while this was
 * being written: `calibrate.js` imports `embeddingsOf` from
 * `build-rag-index.js`, so loading one loaded the other, and `index`'s guard
 * then read `calibrate`'s argv and refused a flag that was never meant for it.
 * Half of `src/` is importable for a helper as well as runnable as a script.
 *
 * The entry test is the one `build-rag-index.js`, `calibrate.js`, `run.js` and
 * `lint-golden.js` already use to decide whether to call `main()` — `argv[1]` is
 * rewritten to the module by bin/docpilot.js, so it names the script that is
 * actually running and not the launcher.
 *
 * @returns the first message, or null — null both when the flags are fine and
 *   when this module is merely being imported.
 */
export function entryFlagError(command, entryUrl, argv = process.argv) {
  if (!argv[1] || entryUrl !== pathToFileURL(argv[1]).href) return null
  return flagErrors(command, argv.slice(2))[0] ?? null
}
