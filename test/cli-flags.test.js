import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  COMMANDS,
  DOCS_URL,
  entryFlagError,
  flagErrors,
  flagGiven,
  flagValue,
  helpFor,
  spaceFormWarning,
} from '../src/cli-flags.js'
import { parseEmbedFlags } from '../src/embed-choices.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * The flag table, and the three things that have to stay true about it.
 *
 * It exists because flag handling was per-command folklore: `tune` rejected an
 * unknown flag before it loaded anything, `calibrate` validated nothing at all,
 * and the difference was invisible until `calibrate --limt=3` embedded 597
 * probes in silence. Declaring the flags once is only worth it if the
 * declaration stays true — hence the checks below, which hold it against the
 * modules that read the flags AND against the reference that documents them.
 */
describe('the flag table', () => {
  it('gives every flag a kind, a help line and — where it takes one — an example', () => {
    for (const [command, spec] of Object.entries(COMMANDS)) {
      expect(spec.summary, command).toBeTruthy()
      for (const flag of spec.flags) {
        expect(flag.help, `${command} --${flag.name}`).toBeTruthy()
        expect(['bool', 'value', 'int', 'enum', 'list'], `${command} --${flag.name}`).toContain(flag.kind)
        if (flag.kind !== 'bool') expect(flag.example, `${command} --${flag.name}`).toBeTruthy()
        if (flag.kind === 'enum') expect(flag.values, `${command} --${flag.name}`).toBeTruthy()
      }
    }
  })

  it('covers every command the launcher dispatches', () => {
    const bin = read('bin/docpilot.js')
    const listed = /const COMMANDS = \[([^\]]+)\]/.exec(bin)[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    expect(Object.keys(COMMANDS).sort()).toEqual(listed.sort())
  })
})

/**
 * WHAT IT REFUSES — the four failures that used to be silent, one case each.
 *
 * Every one of these ran to completion before this table existed, and three of
 * the four spent money doing it.
 */
describe('flagErrors', () => {
  it('refuses a flag no command has, rather than dropping it', () => {
    expect(flagErrors('calibrate', ['--sweeponly'])[0]).toMatch(/unknown flag --sweeponly/)
    expect(flagErrors('eval', ['--limt=3'])[0]).toMatch(/unknown flag --limt=3/)
  })

  /**
   * `arg()` matches `--name=` and nothing else, so `--level low` left `low` as a
   * stray positional and the flag read as ABSENT — and absent means the widest
   * pool the command has.
   */
  it('refuses a value flag written without its =, and names the = form', () => {
    expect(flagErrors('eval', ['--level', 'low'])).toEqual(['--level takes a value: --level=low'])
    expect(flagErrors('vocabulary', ['--limit'])[0]).toBe('--limit takes a value: --limit=24')
  })

  /** `Number('abc')` is NaN, NaN is falsy, and falsy read as "no limit". */
  it('refuses a count that is not a positive whole number', () => {
    for (const bad of ['abc', '0', '-3', '2.5']) {
      expect(flagErrors('eval', [`--limit=${bad}`])[0], bad).toMatch(/must be a positive whole number/)
    }
    expect(flagErrors('eval', ['--limit=3'])).toEqual([])
  })

  /** Neither 'on' nor 'off' silently meant 'auto'; not 'full' silently meant 'bounded'. */
  it('refuses a value outside a fixed vocabulary, and prints the vocabulary', () => {
    const [msg] = flagErrors('eval', ['--fallback=grbge'])
    expect(msg).toMatch(/--fallback="grbge" is not one of them/)
    expect(msg).toMatch(/auto, on, off/)
    expect(flagErrors('calibrate', ['--anchors=grbge'])[0]).toMatch(/bounded, full/)
  })

  /**
   * `--level` keeps `parseLevelArg`'s own refusal — declaring the tiers here too
   * would put a second, differently-worded message in front of one that works,
   * for a case that was never failing open.
   */
  it('leaves an unknown --level to the parser that already refuses it', () => {
    expect(flagErrors('eval', ['--level=hgih'])).toEqual([])
    expect(COMMANDS.eval.flags.find((f) => f.name === 'level').kind).toBe('value')
  })

  it('refuses an unknown mode where a command takes one, and names them', () => {
    expect(flagErrors('bench', ['nope'])[0]).toMatch(/unknown mode "nope"/)
    expect(flagErrors('feedback', ['nope'])[0]).toMatch(/pull, report, faq/)
    expect(flagErrors('bench', ['emit', '--config=base'])).toEqual([])
  })

  it('lets a correct command line through untouched', () => {
    expect(flagErrors('tune', ['--level=low', '--limit=10', '--dry'])).toEqual([])
    expect(flagErrors('index', ['--dry', '--html-dir=dist'])).toEqual([])
    expect(flagErrors('doctor', ['--embed'])).toEqual([])
  })

  it('reports one mistake once', () => {
    // `--level low` is a bare flag, not a bare flag AND a stray word.
    expect(flagErrors('eval', ['--level', 'low'])).toHaveLength(1)
  })
})

/**
 * The two commands whose documentation has always shown `--from <value>`. The
 * space form is kept, warned about, and left out of the help.
 */
describe('the space form', () => {
  it('is accepted where it always was, and named as deprecated', () => {
    expect(flagErrors('feedback', ['pull', '--from', './export.jsonl'])).toEqual([])
    expect(spaceFormWarning('feedback', ['pull', '--from', './x.jsonl'])).toMatch(/--from=/)
    expect(flagValue('feedback', ['--from', './x.jsonl'], 'from')).toBe('./x.jsonl')
  })

  it('says nothing when the = form was used', () => {
    expect(spaceFormWarning('feedback', ['pull', '--from=./x.jsonl'])).toBeNull()
    expect(flagValue('feedback', ['--from=./x.jsonl'], 'from')).toBe('./x.jsonl')
  })

  /** `--out --force` used to mean `out === '--force'` AND eat the `--force`. */
  it('will not take the next flag as a value', () => {
    expect(flagErrors('import', ['https://x.dev/a', '--out', '--force'])[0]).toMatch(
      /--out takes a value/,
    )
  })

  it('is refused everywhere else, because everywhere else never took it', () => {
    expect(flagErrors('eval', ['--limit', '5'])[0]).toMatch(/takes a value/)
  })

  /** A value may contain an `=`; only `lint`'s copy of `arg()` used to truncate. */
  it('keeps everything after the first =', () => {
    expect(flagValue('lint', ['--file=a=b.jsonl'], 'file')).toBe('a=b.jsonl')
  })

  it('reads a boolean by its alias', () => {
    expect(flagGiven('import', ['--dry-run'], 'dry')).toBe(true)
    expect(flagGiven('index', ['-y'], 'yes')).toBe(true)
    expect(flagGiven('index', [], 'yes')).toBe(false)
  })
})

/**
 * ONE DASH IS A SHORT OPTION, TWO ARE A LONG ONE.
 *
 * The strip used to be `^--?` in all four places that read a token, so
 * `-level=low` was legal to the table, `flagErrors` returned nothing, and the
 * command's own `arg()` — which matched `--level=` and only that — read the
 * flag as ABSENT and ran the widest tier. The measurement is in spec 010: a
 * direct call on the built module returned `[]` for it.
 */
describe('the dashes', () => {
  it('refuses a long name spelled with one dash, and shows the spelling that works', () => {
    const [msg] = flagErrors('eval', ['-level=low'])
    expect(msg).toMatch(/long flags take two dashes: --level=low/)
    expect(flagErrors('eval', ['-gate-only'])[0]).toMatch(/--gate-only/)
  })

  it('keeps every one-character option, because those are short options', () => {
    expect(flagErrors('index', ['-y'])).toEqual([])
    expect(flagGiven('index', ['-y'], 'yes')).toBe(true)
    expect(flagGiven('init', ['-y'], 'yes')).toBe(true)
  })

  it('does not read a value out of a one-dash long name either', () => {
    expect(flagValue('eval', ['-level=low'], 'level')).toBeNull()
  })
})

/**
 * Every reader in this package finds the first match and stops, so a repeated
 * flag ran the opposite of what the last one on the line asked for — in
 * silence, and `--level=low --level=high` returned `[]` before this.
 */
describe('a flag given twice', () => {
  it('is a message, not a silent first-wins', () => {
    const [msg] = flagErrors('eval', ['--level=low', '--level=high'])
    expect(msg).toMatch(/--level was given twice/)
    expect(msg).toContain('--level=low')
    expect(msg).toContain('--level=high')
  })

  it('counts an alias as the same flag', () => {
    expect(flagErrors('index', ['--yes', '-y'])[0]).toMatch(/--yes was given twice/)
  })

  it('says it once, not once per repeat', () => {
    expect(flagErrors('eval', ['--level=low', '--level=high'])).toHaveLength(1)
  })
})

/**
 * POSIX's option terminator. It used to be reported as `unknown flag --`,
 * which is the one thing it certainly is not.
 */
describe('--', () => {
  it('is not an unknown flag', () => {
    expect(flagErrors('eval', ['--'])).toEqual([])
  })

  it('ends the options, so what follows is judged as an operand', () => {
    const errs = flagErrors('eval', ['--', '--nonsense'])
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatch(/unexpected argument "--nonsense"/)
  })

  it('leaves the flags before it checked as usual', () => {
    expect(flagErrors('eval', ['--limit=abc', '--'])[0]).toMatch(/positive whole number/)
  })
})

/**
 * THE SEVEN COPIES, AND WHAT EACH ONE GOT WRONG.
 *
 * `flagValue`/`flagGiven` had zero production callers: `src/eval/run.ts`,
 * `calibrate.ts`, `tune.ts`, `answer-bench.ts`, `lint-golden.ts`,
 * `build-rag-index.ts` and `vocabulary.ts` each carried their own. These are
 * the three ways they had drifted apart.
 */
describe('the one reader', () => {
  it('keeps everything after the first = for every command, not only lint', () => {
    for (const [command, name] of [
      ['lint', 'file'],
      ['calibrate', 'out'],
      ['bench', 'out'],
      ['tune', 'lambda'],
      ['eval', 'provider'],
      ['index', 'html-base'],
      ['vocabulary', 'out'],
    ]) {
      expect(flagValue(command, [`--${name}=a=b`], name), command).toBe('a=b')
    }
  })

  it('gives back the default it was handed, not an empty string', () => {
    expect(flagValue('eval', [], 'level', 'low')).toBe('low')
    expect(flagValue('index', [], 'html-dir', '')).toBe('')
  })

  it('never returns true where a value was asked for', () => {
    expect(flagValue('vocabulary', ['--out'], 'out')).toBeNull()
    expect(flagErrors('vocabulary', ['--out'])[0]).toMatch(/--out takes a value/)
  })

  /**
   * `index` has two parsers on one command line — this table and
   * `parseEmbedFlags`, which reads the four embedder flags in the launcher —
   * and only one of them ever took the space form.
   */
  it('spells index the way both of its parsers spell it', () => {
    expect(flagErrors('index', ['--html-select', 'main'])[0]).toMatch(/takes a value/)
    expect(flagErrors('index', ['--index-dir', 'foo'])[0]).toMatch(/takes a value/)
    expect(flagValue('index', ['--html-select', 'main'], 'html-select')).toBeNull()
    expect(flagValue('index', ['--html-select=main'], 'html-select')).toBe('main')
    expect(parseEmbedFlags(['--index-dir=foo']).indexDir).toBe('foo')
  })
})

/**
 * `calibrate.js` imports `embeddingsOf` from `build-rag-index.js`, so loading one
 * loads the other. A module-scope guard that did not check whether it WAS the
 * entry made `index`'s flag table refuse `calibrate`'s flags — caught while this
 * was being written, and the reason `entryFlagError` exists at all.
 */
describe('entryFlagError', () => {
  it('says nothing when the module is merely being imported', () => {
    const notEntry = ['node', '/somewhere/else.js', '--dryy']
    expect(entryFlagError('index', 'file:///the/module.js', notEntry)).toBeNull()
  })

  it('checks when the module is the entry', () => {
    const entry = ['node', '/the/module.js', '--dryy']
    expect(entryFlagError('index', 'file:///the/module.js', entry)).toMatch(/unknown flag --dryy/)
  })
})

describe('helpFor', () => {
  it('names every flag of the command, because it is rendered from the same table', () => {
    for (const [command, spec] of Object.entries(COMMANDS)) {
      const help = helpFor(command)
      for (const flag of spec.flags) expect(help, `${command} --${flag.name}`).toContain(`--${flag.name}`)
      expect(help, command).toContain(spec.summary)
      if (spec.positional?.values) {
        for (const v of spec.positional.values) expect(help, `${command} ${v}`).toContain(v)
      }
    }
  })

  /**
   * The defect that made this whole file worth writing. `--help` was matched in
   * the COMMAND position only, so `docpilot calibrate --help` parsed the flags
   * it knew, dropped `--help`, and ran a full metered calibration.
   *
   * Run as PROCESSES, from a directory with no DocPilot project in it: help must
   * not need a config, a key, or a built index, because a reader asking what a
   * command takes very often has none of them.
   */
  it('every command prints help and exits 0, with no project and no network', () => {
    const cwd = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.docpilot-help-'))
    try {
      for (const command of Object.keys(COMMANDS)) {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/docpilot.js'), command, '--help'], {
          cwd,
          encoding: 'utf8',
        })
        expect(r.status, `${command} --help`).toBe(0)
        expect(r.stdout, `${command} --help`).toContain(`docpilot ${command}`)
        // No config was looked for, so no warning about not finding one.
        expect(`${r.stdout}${r.stderr}`, `${command} --help`).not.toContain('no config under')
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('answers -h as readily as --help', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/docpilot.js'), 'eval', '-h'], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('docpilot eval')
  })

  it('prints the version, which used to be reported as an unknown command', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/docpilot.js'), '--version'], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(JSON.parse(read('package.json')).version)
  })

  it('names the nearest command when one is a typo away', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/docpilot.js'), 'docter'], {
      encoding: 'utf8',
    })
    // `2`: an unknown command is a usage error. It was `1`, which is the code a
    // failed RUN returns, so a script could not tell a typo from an outage.
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Did you mean: doctor?')
  })
})

/**
 * THE HELP HAS ONE RENDERER AND ONE ADDRESS — spec 010, decision 7.
 */
describe('help, spelled every way it is spelled', () => {
  const cli = (...args) =>
    spawnSync(process.execPath, [path.join(ROOT, 'bin/docpilot.js'), ...args], { encoding: 'utf8' })

  it('answers `help <command>` with exactly what `<command> --help` answers', () => {
    for (const c of Object.keys(COMMANDS)) {
      const viaWord = cli('help', c)
      const viaFlag = cli(c, '--help')
      expect(viaWord.status, c).toBe(0)
      expect(viaWord.stdout, c).toBe(viaFlag.stdout)
    }
  })

  it('answers a bare `help` with the global block', () => {
    expect(cli('help').stdout).toBe(cli('--help').stdout)
  })

  /**
   * `help` is deliberately NOT a command: `COMMANDS` in bin/docpilot.js is held
   * against the flag table as an exact set a few tests above, and a "command"
   * with no flags of its own would have to be invented on both sides.
   */
  it('is not in the command list, and does not need to be', () => {
    expect(Object.keys(COMMANDS)).not.toContain('help')
  })

  it('names the version flag where somebody looking for it would look', () => {
    expect(cli('--help').stdout).toContain('--version')
    expect(cli('--version').status).toBe(0)
  })

  /**
   * Three flags in this package have a second spelling and the help named none
   * of them. An alias nobody can discover is an alias for the person who wrote
   * it.
   */
  it('shows the alias of a flag that has one', () => {
    expect(helpFor('index')).toContain('--yes, -y')
    expect(helpFor('init')).toContain('--yes, -y')
    // And the dash count follows the alias's own length, the same rule the
    // parser applies — `-y` is a short option, `--dry-run` is a long one.
    expect(helpFor('import')).toContain('--dry, --dry-run')
  })

  /**
   * The footer was the second address in this package written by hand, and
   * `package.json`'s `homepage` is NOT it — that field is the package's page,
   * and a "Full reference" line pointing there sends a reader looking for
   * `--level` to a README.
   */
  it('takes the documentation address from the one constant', () => {
    expect(DOCS_URL).toMatch(/^https:\/\//)
    for (const c of Object.keys(COMMANDS)) {
      expect(helpFor(c), c).toContain(`Full reference: ${DOCS_URL}/reference/cli#${c}`)
    }
    // And the hand-written second copy is gone from the module that had one.
    expect(read('src/feedback/cli.ts')).not.toContain('docpilot feedback <mode> --from <source>')
  })
})

/**
 * `--json` — one object on stdout, the exit code untouched.
 */
describe('the machine-readable half', () => {
  const cli = (...args) =>
    spawnSync(process.execPath, [path.join(ROOT, 'bin/docpilot.js'), ...args], { encoding: 'utf8' })

  it('gives doctor a parsable object, and keeps the prose off stdout', () => {
    const r = cli('doctor', '--json')
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveProperty('ready')
    expect(parsed).toHaveProperty('version')
    expect(parsed.chat).toHaveProperty('provider')
    expect(r.stdout).not.toContain('[docpilot] config')
    // The verdict in the object and the verdict in the code are one answer.
    expect(r.status).toBe(parsed.ready ? 0 : 1)
  })

  it('gives lint one too', () => {
    const r = cli('lint', '--json')
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveProperty('records')
    expect(parsed).toHaveProperty('errors')
    expect(r.stdout).not.toContain('golden lint —')
    expect(r.status).toBe(parsed.ok ? 0 : 1)
  })

  it('never prints a key value into either object', () => {
    const doctor = cli('doctor', '--json').stdout
    // Variable NAMES are facts of a configuration; values are not.
    expect(doctor).not.toMatch(/sk-[A-Za-z0-9]/)
  })
})

/**
 * WHERE EACH COMMAND'S FLAGS ARE ACTUALLY READ.
 *
 * `index`'s embedder flags are the one split: they are consumed by the launcher
 * and `embed-choices.js` and stripped before `build-rag-index.js` ever sees the
 * argv, which is deliberate — the indexer has no opinion about which embedder
 * was chosen, only about the one it was handed.
 */
const READERS = {
  index: ['src/build/build-rag-index.ts', 'src/embed-choices.ts'],
  import: ['src/build/import.ts'],
  vocabulary: ['src/build/vocabulary.ts'],
  calibrate: ['src/eval/calibrate.ts'],
  eval: ['src/eval/run.ts'],
  bench: ['src/eval/answer-bench.ts'],
  tune: ['src/eval/tune.ts'],
  lint: ['src/eval/lint-golden.ts'],
  feedback: ['src/feedback/cli.ts'],
  // Both moved out of `bin/docpilot.js` under the `run*` contract. The launcher
  // still MENTIONS `--proxy`, `--embed` and `--models` in its global help, so
  // leaving this pointing at it would have kept passing on the help text while
  // the reader was somewhere else entirely.
  doctor: ['src/cli-doctor.ts'],
  // `init` reads its placement flags itself and hands the four install flags
  // straight to the module that owns the target table — the same split `index`
  // already makes with its embedder flags, and for the same reason: the thing
  // that knows what `--target=cursor` MEANS is not the thing that scaffolds.
  init: ['src/cli-init.ts', 'src/cli-skills.ts'],
  update: ['src/cli-skills.ts'],
}

/** The `## \`command\`` section of the CLI reference, up to the next `## `. */
function docSection(command) {
  const out = []
  let inside = false
  for (const line of read('docs/reference/cli.md').split('\n')) {
    if (/^## /.test(line)) {
      inside = new RegExp(`^## \`${command}\``).test(line)
      continue
    }
    if (inside) out.push(line)
  }
  return out.join('\n')
}

const spelling = (flag) => [flag.name, ...(flag.alias ? [flag.alias] : [])]

/**
 * The two directions a declaration can go wrong, and both have.
 *
 * A flag in the table that no module reads is a promise the CLI does not keep;
 * a flag a module reads that the table does not carry is a flag with no help and
 * no validation. This pair is what would have caught `doctor --embed` and the
 * four `index --embed-*` flags being added to the CLI and to the guide while the
 * reference that is supposed to list every flag never heard of them.
 */
describe('the table against the code and the reference', () => {
  it('declares nothing its own module does not read', () => {
    for (const [command, spec] of Object.entries(COMMANDS)) {
      const src = READERS[command].map(read).join('\n')
      for (const flag of spec.flags) {
        const found = spelling(flag).some(
          (n) => src.includes(`'${n}'`) || src.includes(`"${n}"`) || src.includes(`--${n}`),
        )
        expect(found, `${command} --${flag.name} is in the table but ${READERS[command]} never reads it`).toBe(true)
      }
    }
  })

  it('is documented, flag for flag, in docs/reference/cli.md', () => {
    for (const [command, spec] of Object.entries(COMMANDS)) {
      const section = docSection(command)
      expect(section, `docs/reference/cli.md has no ## \`${command}\` section`).toBeTruthy()
      for (const flag of spec.flags) {
        const found = spelling(flag).some((n) => section.includes(`--${n}`))
        expect(found, `${command} --${flag.name} is not in docs/reference/cli.md`).toBe(true)
      }
    }
  })

  /**
   * The other direction, narrowed to where it cannot produce a false positive: a
   * `npx docpilot <cmd> …` line in the reference is a line somebody will copy,
   * so every flag on it has to exist. Prose elsewhere in a section legitimately
   * mentions other commands' flags and is not checked.
   */
  it('never shows a runnable command line carrying a flag the CLI does not have', () => {
    for (const [command, spec] of Object.entries(COMMANDS)) {
      const known = new Set(spec.flags.flatMap(spelling).map((n) => `--${n}`))
      for (const line of docSection(command).split('\n')) {
        if (!line.includes(`npx docpilot ${command}`)) continue
        for (const [token] of line.matchAll(/--[a-z][a-z0-9-]*/g)) {
          expect(known.has(token), `docs/reference/cli.md runs \`${line.trim()}\` but ${command} has no ${token}`).toBe(true)
        }
      }
    }
  })
})
