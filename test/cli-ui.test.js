import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'

import {
  bar,
  box,
  bytes,
  colorEnabled,
  compact,
  count,
  delta,
  duration,
  keys,
  kv,
  live,
  meter,
  pad,
  palette,
  pct,
  progress,
  rule,
  select,
  sparkline,
  spinner,
  stripAnsi,
  symbols,
  table,
  truncate,
  ui,
  unicodeEnabled,
  visibleWidth,
} from '../src/cli-ui.js'

/**
 * The terminal primitives — engine-spec 030.
 *
 * Every renderer is pure: it takes its width, its colour switch and its symbol
 * set and returns text, so each one is held here at a fixed width with colour
 * on AND off. The two halves must agree on everything but the escapes, which
 * is what "the output is the same piped or not, colour aside" means in code.
 */

const tty = { isTTY: true }
const pipe = { isTTY: false }

describe('colorEnabled — who decides, in which order', () => {
  it('colours a terminal and nothing else when the environment is silent', () => {
    expect(colorEnabled(tty, {})).toBe(true)
    expect(colorEnabled(pipe, {})).toBe(false)
    expect(colorEnabled(undefined, {})).toBe(false)
  })

  it('never colours TERM=dumb', () => {
    expect(colorEnabled(tty, { TERM: 'dumb' })).toBe(false)
  })

  /** no-color.org: present AND non-empty. An empty NO_COLOR says nothing. */
  it('lets a non-empty NO_COLOR win over everything, FORCE_COLOR included', () => {
    expect(colorEnabled(tty, { NO_COLOR: '1' })).toBe(false)
    expect(colorEnabled(tty, { NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false)
    expect(colorEnabled(tty, { NO_COLOR: '' })).toBe(true)
  })

  /** Node's own reading of FORCE_COLOR, `lib/internal/tty.js`. */
  it('reads FORCE_COLOR the way Node does, on a pipe as well as a terminal', () => {
    for (const on of ['', '1', '2', '3', 'true', 'TRUE']) {
      expect(colorEnabled(pipe, { FORCE_COLOR: on }), on).toBe(true)
    }
    for (const off of ['0', 'false', 'nonsense']) {
      expect(colorEnabled(tty, { FORCE_COLOR: off }), off).toBe(false)
    }
  })
})

describe('palette', () => {
  it('is the identity when colour is off', () => {
    const c = palette(false)
    for (const name of ['ok', 'warn', 'fail', 'info', 'muted', 'accent', 'bold']) {
      expect(c[name]('x'), name).toBe('x')
    }
    expect(c.ok(3)).toBe('3')
  })

  it('names meanings, and every one strips back to its text', () => {
    const c = palette(true)
    expect(c.ok('x')).toBe('\x1b[32mx\x1b[39m')
    expect(c.fail('x')).toBe('\x1b[31mx\x1b[39m')
    expect(c.warn('x')).toBe('\x1b[33mx\x1b[39m')
    expect(c.bold('x')).toBe('\x1b[1mx\x1b[22m')
    for (const name of ['ok', 'warn', 'fail', 'info', 'muted', 'accent', 'bold']) {
      expect(stripAnsi(c[name]('text')), name).toBe('text')
    }
  })
})

describe('symbols and their ASCII fallback', () => {
  it('maps the seven glyphs one for one', () => {
    const u = symbols(true)
    const a = symbols(false)
    expect(Object.values(u).join(' ')).toBe('✔ ✖ ▲ ▼ ● ◆ ❯')
    expect(Object.values(a).join(' ')).toBe('+ x ^ v * # >')
    expect(Object.keys(u)).toEqual(Object.keys(a))
  })

  it('distrusts the Linux console and the legacy Windows console only', () => {
    expect(unicodeEnabled({}, 'darwin')).toBe(true)
    expect(unicodeEnabled({}, 'linux')).toBe(true)
    expect(unicodeEnabled({ TERM: 'linux' }, 'linux')).toBe(false)
    expect(unicodeEnabled({}, 'win32')).toBe(false)
    expect(unicodeEnabled({ WT_SESSION: 'x' }, 'win32')).toBe(true)
    expect(unicodeEnabled({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(true)
  })

  it('reads both switches into one view', () => {
    const view = ui({ isTTY: true, columns: 100 }, { TERM: 'xterm' })
    expect(view.color).toBe(true)
    expect(view.width).toBe(100)
    expect(view.c.ok('x')).not.toBe('x')
    expect(ui(pipe, {}).c.ok('x')).toBe('x')
  })
})

describe('visible width', () => {
  const c = palette(true)

  it('costs an escape nothing', () => {
    expect(visibleWidth(c.ok('abc'))).toBe(3)
    expect(visibleWidth(`${c.bold('a')}${c.fail('bc')}`)).toBe(3)
    expect(stripAnsi(`${c.bold('a')}b`)).toBe('ab')
  })

  it('counts wide characters twice and combining marks not at all', () => {
    expect(visibleWidth('日本')).toBe(4)
    expect(visibleWidth('é')).toBe(1)
    expect(visibleWidth('█▏')).toBe(2)
  })

  it('pads by what is seen, so a coloured cell lines up with a plain one', () => {
    expect(visibleWidth(pad(c.ok('ab'), 5))).toBe(5)
    expect(pad('ab', 5, 'right')).toBe('   ab')
    expect(pad('abcdef', 3)).toBe('abcdef')
  })

  it('cuts at a width, keeps the escapes, and closes a span it cut through', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
    const cut = truncate(c.accent('abcdefgh'), 5)
    expect(stripAnsi(cut)).toBe('abcd…')
    expect(cut).toContain('\x1b[0m')
    expect(visibleWidth(cut)).toBe(5)
  })
})

describe('table, kv, rule and box — at a fixed width', () => {
  it('lines up columns, right-aligns where asked, and leaves no trailing space', () => {
    const lines = table(
      [
        ['recall@8', '0.803', 'x'],
        ['MRR', '0.6', ''],
      ],
      { head: ['metric', 'value', 'Δ'], align: ['left', 'right', 'left'] },
    )
    expect(lines).toEqual(['  metric    value  Δ', '  recall@8  0.803  x', '  MRR         0.6'])
  })

  it('lines up the same with colour on — the escapes do not move a column', () => {
    const c = palette(true)
    const plain = table([['a', 'bb'], ['ccc', 'd']])
    const coloured = table([[c.ok('a'), 'bb'], ['ccc', c.fail('d')]])
    expect(coloured.map(stripAnsi)).toEqual(plain)
  })

  it('writes key-value rows with the values in one column, and hangs a second line', () => {
    expect(kv([['index', 'fresh'], ['guard', 'provisional\nmode off'], null, ['x', null]])).toEqual([
      '  index  fresh',
      '  guard  provisional',
      '         mode off',
      '  x      —',
    ])
  })

  it('draws the separator eval has always drawn by hand', () => {
    expect(rule('summary', 20)).toBe('── summary ─────────')
    expect(rule('summary', 20, { unicode: false })).toBe('-- summary ---------')
    expect(visibleWidth(rule('summary', 20))).toBe(20)
  })

  it('frames lines, with a title in the top edge, in both glyph sets', () => {
    expect(box(['one', 'three'], { title: 'T' })).toEqual(['┌─ T ───┐', '│ one   │', '│ three │', '└───────┘'])
    expect(box(['ab'], { unicode: false })).toEqual(['+----+', '| ab |', '+----+'])
  })
})

describe('marks', () => {
  it('fills a bar in eighths, at exactly its width', () => {
    expect(bar(0.5, 4)).toBe('██  ')
    expect(bar(1, 3)).toBe('███')
    expect(bar(0, 3)).toBe('   ')
    expect(bar(1 / 16, 2)).toBe('▏ ')
    expect(bar(0.5, 4, { track: '·' })).toBe('██··')
    for (let f = 0; f <= 1; f += 0.037) expect(visibleWidth(bar(f, 20)), String(f)).toBe(20)
  })

  it('rounds to whole cells in ASCII, and clamps what is out of range', () => {
    expect(bar(0.5, 4, { unicode: false })).toBe('##  ')
    expect(bar(2, 3)).toBe('███')
    expect(bar(-1, 3)).toBe('   ')
    expect(bar(NaN, 2)).toBe('  ')
  })

  it('draws a sparkline between the smallest and the largest value', () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe('▁▂▃▄▅▆▇█')
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], { unicode: false })).toBe('_.-~=+*#')
    expect(sparkline([0, 10], { min: 0, max: 20 })).toBe('▁▅')
  })

  it('leaves a gap where a run measured nothing, and draws a flat line flat', () => {
    expect(sparkline([1, null, 3])).toBe('▁ █')
    expect(sparkline([0.8, 0.8, 0.8])).toBe('▄▄▄')
    expect(sparkline([0, 0])).toBe('▁▁')
    expect(sparkline([null, undefined])).toBe('  ')
  })
})

describe('delta — coloured by whether the move is good', () => {
  const ok = '\x1b[32m'
  const fail = '\x1b[31m'

  it('prints the arrow and the sign, and nothing else, with colour off', () => {
    expect(delta(0.031, 'higher')).toBe('▲ +0.031')
    expect(delta(-0.012, 'lower')).toBe('▼ -0.012')
    expect(delta(0.031, 'higher', { unicode: false })).toBe('^ +0.031')
    expect(delta(0, 'higher')).toBe('= 0.000')
    expect(delta(null, 'higher')).toBe('—')
    expect(delta(2, 'lower', { format: (a) => `${a}ms` })).toBe('▲ +2ms')
  })

  it('greens a rise in a metric where higher is better and reds it where lower is', () => {
    expect(delta(0.031, 'higher', { color: true })).toContain(ok)
    expect(delta(0.031, 'lower', { color: true })).toContain(fail)
    expect(delta(-0.031, 'lower', { color: true })).toContain(ok)
    expect(delta(-0.031, 'higher', { color: true })).toContain(fail)
    // A number with no good direction is neither.
    const neutral = delta(5, null, { color: true })
    expect(neutral).not.toContain(ok)
    expect(neutral).not.toContain(fail)
    expect(stripAnsi(neutral)).toBe('▲ +5.000')
  })
})

describe('numbers', () => {
  it('writes durations the way a person reads them', () => {
    expect(duration(850)).toBe('850ms')
    expect(duration(4200)).toBe('4.2s')
    expect(duration(42_000)).toBe('42s')
    expect(duration(185_000)).toBe('3m 05s')
    expect(duration(119_600)).toBe('2m 00s')
    expect(duration(7_384_000)).toBe('2h 03m')
    expect(duration(100_800_000)).toBe('1d 04h')
    expect(duration(null)).toBe('—')
  })

  it('writes sizes in 1024s, as the build log does', () => {
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1229)).toBe('1.2 KB')
    expect(bytes(344_064)).toBe('336 KB')
    expect(bytes(1_330_296)).toBe('1.3 MB')
    expect(bytes(undefined)).toBe('—')
  })

  it('writes shares, counts and token counts', () => {
    expect(pct(0.674)).toBe('67.4%')
    expect(pct(1, 0)).toBe('100%')
    expect(pct(null)).toBe('—')
    expect(count(1204)).toBe('1,204')
    expect(count(null)).toBe('—')
    expect(compact(950)).toBe('950')
    expect(compact(12_345)).toBe('12k')
    expect(compact(6300)).toBe('6.3k')
    expect(compact(2_100_000)).toBe('2.1M')
  })
})

/** A stand-in for a stream: what was written, and whether it is a terminal. */
function fakeStream({ isTTY = true, columns = 40, rows = 0 } = {}) {
  const out = { isTTY, columns, rows, text: '', write(s) {
    out.text += s
    return true
  } }
  return out
}

describe('live — redrawn in place on a terminal, written once anywhere else', () => {
  it('writes nothing to a pipe until done, and then the final lines once', () => {
    const stream = fakeStream({ isTTY: false })
    const region = live(stream)
    region.render(['frame 1'])
    region.render(['frame 2'])
    expect(stream.text).toBe('')
    region.done()
    expect(stream.text).toBe('frame 2\n')
  })

  it('moves up over what it drew last time, erases, and draws again', () => {
    const stream = fakeStream()
    const region = live(stream)
    region.render(['a', 'b'])
    expect(stream.text).toBe('a\nb\n')
    region.render(['c'])
    expect(stream.text).toBe('a\nb\n\x1b[2A\r\x1b[Jc\n')
    region.clear()
    expect(stream.text.endsWith('\x1b[1A\r\x1b[J')).toBe(true)
  })

  it('cuts every line to the terminal, so a wrapped line cannot throw the count off', () => {
    const stream = fakeStream({ columns: 12 })
    live(stream).render(['0123456789abcdef'])
    expect(stream.text).toBe('0123456789…\n')
  })

  it('cuts the block to the terminal height for the same reason', () => {
    const stream = fakeStream({ rows: 3 })
    live(stream).render(['1', '2', '3', '4'])
    expect(stream.text).toBe('1\n2\n')
  })
})

describe('progress', () => {
  it('draws a count, a share, the time taken and an ETA measured from the first update', () => {
    let t = 1000
    const stream = fakeStream({ columns: 120 })
    const p = progress({ label: 'records', total: 10, stream, now: () => t, color: false, width: 10, throttleMs: 0 })
    p.update(0)
    t = 4000
    p.update(3)
    // The last frame, minus the cursor-up-and-erase that brought it back.
    const last = stripAnsi(stream.text.split('\n').filter(Boolean).at(-1)).replace(/\r/g, '')
    expect(last).toBe('  records  ███·······  3/10  30%  3.0s  ETA 7.0s')
  })

  it('prints a line above the bar and counts it before the bar comes back', () => {
    let t = 0
    const stream = fakeStream({ columns: 120 })
    const p = progress({ total: 2, stream, now: () => t, color: false, width: 4, throttleMs: 1000 })
    p.update(0)
    t = 10
    p.above(() => stream.write('ok q-01\n'), { advance: 1 })
    expect(stream.text).toContain('ok q-01\n')
    expect(stripAnsi(stream.text.split('\n').filter(Boolean).at(-1))).toContain('1/2')
  })

  it('leaves its last frame, a line of its own, or nothing', () => {
    const plain = fakeStream({ isTTY: false })
    const p = progress({ total: 2, stream: plain, color: false })
    p.update(2)
    expect(plain.text).toBe('')
    p.finish('done')
    expect(plain.text).toBe('done\n')

    const term = fakeStream()
    const q = progress({ total: 2, stream: term, color: false })
    q.update(1)
    q.finish(null)
    expect(term.text.endsWith('\x1b[1A\r\x1b[J')).toBe(true)
  })
})

describe('spinner', () => {
  it('spins on a terminal and settles on one line', () => {
    const term = fakeStream()
    const s = spinner('reading', { stream: term, color: false, interval: 1000 })
    expect(term.text).toBe('  ⠋ reading\n')
    s.succeed('read')
    expect(term.text.endsWith('\x1b[1A\r\x1b[J  ✔ read\n')).toBe(true)
  })

  it('writes only its verdict to a pipe, in ASCII where Unicode is not trusted', () => {
    const plain = fakeStream({ isTTY: false })
    const s = spinner('reading', { stream: plain, color: false, unicode: false })
    s.update('still reading')
    expect(plain.text).toBe('')
    s.fail('could not read')
    expect(plain.text).toBe('  x could not read\n')
  })
})

describe('meter — tick() that knows its count', () => {
  afterEach(() => vi.restoreAllMocks())

  /**
   * The test runner's stderr is not a terminal, so this is the log path: the
   * exact lines `tick()` and `tock()` have always written, and no escape.
   */
  it('writes the lines tick() always wrote when stderr is not a terminal', () => {
    const lines = []
    vi.spyOn(console, 'error').mockImplementation((s) => lines.push(s))
    const m = meter('embedding')
    m.tick(1, 10, 'embedding 1/10', false)
    m.tick(5, 10, 'embedding 5/10')
    m.tock('embedded 10 in 1 request(s)')
    m.end()
    expect(lines).toEqual(['  embedding 5/10', '  embedded 10 in 1 request(s)'])
    expect(lines.join('')).not.toContain('\x1b')
  })
})

/**
 * A terminal's input, faked: a stream that is a TTY and records every
 * `setRawMode` it is asked for.
 */
function fakeStdin() {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.modes = []
  stdin.setRawMode = (on) => {
    stdin.isRaw = on
    stdin.modes.push(on)
    return stdin
  }
  return stdin
}

const CHOICES = [
  { label: 'eval --gate-only', value: ['eval', '--gate-only'], hint: 'free' },
  { label: 'index', value: ['index'], hint: 'rebuild' },
  { label: 'quit', value: null },
]

describe('keys — and the terminal given back', () => {
  it('restores raw mode once, however many times it is asked to', () => {
    const stdin = fakeStdin()
    const restore = keys(stdin, () => {})
    expect(stdin.isRaw).toBe(true)
    restore()
    restore()
    expect(stdin.modes).toEqual([true, false])
  })

  it('takes its listeners off the process when it is done', () => {
    const before = process.listenerCount('exit')
    const restore = keys(fakeStdin(), () => {})
    expect(process.listenerCount('exit')).toBe(before + 1)
    restore()
    expect(process.listenerCount('exit')).toBe(before)
  })
})

describe('select — the arrow-key menu', () => {
  const run = (keysToSend, opts = {}) => {
    const stdin = fakeStdin()
    const stdout = fakeStream({ columns: 80 })
    const exit = vi.fn()
    const picked = select({ message: 'Run', choices: CHOICES, stdin, stdout, env: {}, exit, ...opts })
    setTimeout(() => stdin.write(keysToSend), 10)
    return { picked, stdin, stdout, exit }
  }

  it('moves with the arrows and runs with Enter, and gives the terminal back', async () => {
    const { picked, stdin, stdout } = run('\x1b[B\r')
    expect(await picked).toEqual(['index'])
    expect(stdin.modes).toEqual([true, false])
    expect(stripAnsi(stdout.text)).toContain('Run index')
  })

  it('moves with j and k too, and wraps', async () => {
    const { picked } = run('kk\r')
    expect(await picked).toEqual(['index'])
  })

  it('picks by digit', async () => {
    const { picked } = run('1')
    expect(await picked).toEqual(['eval', '--gate-only'])
  })

  it('backs out on q, without exiting, and restores the mode', async () => {
    const { picked, stdin, exit } = run('q')
    expect(await picked).toBeNull()
    expect(exit).not.toHaveBeenCalled()
    expect(stdin.isRaw).toBe(false)
  })

  /** Ctrl-C and Ctrl-D are the reader declining to answer: 130, the CLI's code for it. */
  it('exits 130 on Ctrl-C and on Ctrl-D, with raw mode already off', async () => {
    for (const key of ['\x03', '\x04']) {
      const { picked, stdin, exit } = run(key)
      expect(await picked).toBeNull()
      expect(exit).toHaveBeenCalledWith(130)
      expect(stdin.isRaw).toBe(false)
    }
  })

  it('treats a terminal that went away as a reader who did not answer', async () => {
    const stdin = fakeStdin()
    const exit = vi.fn()
    const picked = select({ message: 'Run', choices: CHOICES, stdin, stdout: fakeStream(), env: {}, exit })
    setTimeout(() => stdin.end(), 10)
    expect(await picked).toBeNull()
    expect(exit).toHaveBeenCalledWith(130)
    expect(stdin.isRaw).toBe(false)
  })

  it('draws the cursor on the first entry, with every entry numbered', async () => {
    const { picked, stdout } = run('q')
    await picked
    const frame = stripAnsi(stdout.text)
    expect(frame).toContain('❯ 1. eval --gate-only')
    expect(frame).toContain('    2. index')
    expect(frame).toContain('    3. quit\n')
  })

  /** Off a terminal a menu is a hang: it asks through askOne, by number. */
  it('falls back to the numbered prompt when stdin is not a terminal', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let shown = ''
    stdout.on('data', (d) => (shown += d))
    const picked = select({ message: 'Run', choices: CHOICES, stdin, stdout, env: {}, exit: vi.fn() })
    setTimeout(() => stdin.write('2\n'), 10)
    expect(await picked).toEqual(['index'])
    expect(shown).toContain('1. eval --gate-only  (default)')
  })
})
