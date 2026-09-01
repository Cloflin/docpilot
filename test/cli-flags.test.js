import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  COMMANDS,
  entryFlagError,
  flagErrors,
  flagGiven,
  flagValue,
  helpFor,
  spaceFormWarning,
} from '../src/cli-flags.js'

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
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Did you mean: doctor?')
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
  doctor: ['bin/docpilot.js'],
  init: ['src/cli-init.ts', 'bin/docpilot.js'],
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
