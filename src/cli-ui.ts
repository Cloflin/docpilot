/**
 * The terminal, drawn — engine-spec 030.
 *
 * WHY THIS FILE EXISTS. Every command printed correct, carefully worded text,
 * and none of it was easy to read at a glance: no colour anywhere, verdicts
 * carried by upper-case words inside paragraphs, progress as a bare counter,
 * and no picture of the project at all. This is the set of primitives the CLI
 * draws with — colour, symbols, tables, bars, sparklines, a live region, a
 * spinner, a progress bar and an arrow-key menu — and it has no dependency:
 * the package keeps its two.
 *
 * EVERY WRITER ASKS `colorEnabled` FIRST. Escapes in a log are the classic
 * failure of a CLI that learned colour, so nothing here colours by default:
 * a palette built with `false` returns its input unchanged, and the only
 * thing that builds one with `true` is a stream that is a terminal and an
 * environment that did not say otherwise. Piped, the output of every command
 * is the 1.x output.
 *
 * PURE WHERE IT CAN BE. Every renderer takes its width, its colour switch and
 * its symbol set as arguments and returns text; only `live`, `spinner`,
 * `progress`, `keys` and `select` touch a stream, and each takes the stream it
 * writes to, so a test hands it a fake one.
 *
 * `util.styleText` would have been the obvious tool and is not available:
 * it exists from Node 20.12 / 21.7, and `engines.node` is `>=20`. The escapes
 * are written by hand, and there are only a dozen of them.
 */
import { emitKeypressEvents } from 'node:readline'

import { CANCELLED, redraws, tick, tock } from './cli-exit.js'

type Env = Record<string, string | undefined>

// ── colour ───────────────────────────────────────────────────────────────────

/**
 * May this stream be coloured?
 *
 * The order is the spec's, and the first rule is no-color.org's: `NO_COLOR`
 * present and non-empty switches colour off, whatever else is set. Then
 * `FORCE_COLOR`, read the way Node reads it (`lib/internal/tty.js`): `''`,
 * `1`, `2`, `3` and `true` force it on — the way to keep colour through a
 * pager or a CI log that renders it — and any other value, `0` and `false`
 * among them, forces it off. Otherwise a terminal that is not `TERM=dumb`.
 */
export function colorEnabled(stream: any = process.stdout, env: Env = process.env): boolean {
  if (env.NO_COLOR) return false
  const force = env.FORCE_COLOR
  if (force !== undefined) return ['', '1', '2', '3', 'true'].includes(force.toLowerCase())
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb'
}

/** The SGR pair each name opens and closes with. */
const SGR = {
  bold: [1, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
}

/**
 * Colour by MEANING, never by hue — so a verdict reads the same in every
 * command, and changing what "warn" looks like is one line.
 *
 * Built with `false` every function is the identity (after `String()`), which
 * is what lets a renderer be written once and tested twice.
 */
export function palette(on: boolean) {
  const wrap =
    ([open, close]: number[]) =>
    (s: unknown) =>
      on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s)
  return {
    on,
    ok: wrap(SGR.green),
    warn: wrap(SGR.yellow),
    fail: wrap(SGR.red),
    info: wrap(SGR.cyan),
    muted: wrap(SGR.gray),
    accent: wrap(SGR.magenta),
    bold: wrap(SGR.bold),
  }
}

export type Palette = ReturnType<typeof palette>

// ── symbols ──────────────────────────────────────────────────────────────────

/**
 * Can this terminal be trusted with Unicode?
 *
 * Two that cannot: the Linux virtual console (`TERM=linux`), whose font has no
 * `✔`, and the legacy Windows console host, which renders it as a box. Windows
 * Terminal announces itself with `WT_SESSION`; VS Code's terminal with
 * `TERM_PROGRAM`.
 */
export function unicodeEnabled(env: Env = process.env, platform: string = process.platform): boolean {
  if (env.TERM === 'linux') return false
  if (platform === 'win32') return Boolean(env.WT_SESSION || env.TERM_PROGRAM === 'vscode')
  return true
}

const UNICODE_SYMBOLS = { ok: '✔', fail: '✖', up: '▲', down: '▼', dot: '●', diamond: '◆', pointer: '❯' }
const ASCII_SYMBOLS = { ok: '+', fail: 'x', up: '^', down: 'v', dot: '*', diamond: '#', pointer: '>' }

export function symbols(unicode: boolean = unicodeEnabled()) {
  return unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS
}

/**
 * Everything a renderer needs to know about where it is printing, read once.
 *
 * The run* functions call this with the real stream; tests build the same
 * object by hand at a fixed width.
 */
export function ui(stream: any = process.stdout, env: Env = process.env) {
  const color = colorEnabled(stream, env)
  const unicode = unicodeEnabled(env)
  return { color, unicode, width: stream?.columns || 80, c: palette(color), sym: symbols(unicode) }
}

export type Ui = ReturnType<typeof ui>

// ── width ────────────────────────────────────────────────────────────────────

/** CSI sequences (colour, cursor) and OSC strings (hyperlinks, titles). */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export const stripAnsi = (s: unknown) => String(s ?? '').replace(ANSI, '')

/**
 * How many columns one code point takes: 0 for control characters, combining
 * marks and zero-width joiners, 2 for East Asian wide and emoji, 1 otherwise.
 *
 * A table of ranges, not the full Unicode width database — enough for the
 * labels, page titles and model names this CLI prints, which are what decide
 * whether a column lines up.
 */
function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x20e3
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** The columns a string takes on screen — escapes cost nothing. */
export function visibleWidth(s: unknown): number {
  let w = 0
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0))
  return w
}

/** `padEnd`/`padStart` by visible width, so a coloured cell still lines up. */
export function pad(s: unknown, width: number, align: 'left' | 'right' = 'left'): string {
  const text = String(s ?? '')
  const gap = ' '.repeat(Math.max(0, width - visibleWidth(text)))
  return align === 'right' ? gap + text : text + gap
}

/**
 * At most `width` columns, with an ellipsis where it was cut.
 *
 * Escapes are copied through rather than counted, and a cut inside a coloured
 * span closes it — otherwise one long model name turns the rest of the screen
 * magenta.
 */
export function truncate(s: unknown, width: number, ellipsis = '…'): string {
  const text = String(s ?? '')
  if (visibleWidth(text) <= width) return text
  const room = Math.max(0, width - visibleWidth(ellipsis))
  let out = ''
  let w = 0
  let styled = false
  for (const part of text.split(/(\x1b\[[0-?]*[ -/]*[@-~])/)) {
    if (part.startsWith('\x1b[')) {
      out += part
      styled = true
      continue
    }
    for (const ch of part) {
      const cw = charWidth(ch.codePointAt(0))
      if (w + cw > room) return out + (styled ? '\x1b[0m' : '') + ellipsis
      out += ch
      w += cw
    }
  }
  return out
}

// ── layout ───────────────────────────────────────────────────────────────────

/**
 * Rows in columns, padded by visible width.
 *
 * LINES, not one string: every renderer in this CLI builds a list of lines and
 * joins it once, so a table is something to splice into a block. The last
 * column is not padded when it is left-aligned — trailing spaces are invisible
 * on a terminal and noise in a log.
 */
export function table(
  rows: unknown[][],
  { head = null, align = [], gap = 2, indent = 2 }: { head?: unknown[] | null; align?: Array<'left' | 'right'>; gap?: number; indent?: number } = {},
): string[] {
  const all = head ? [head, ...rows] : rows
  const cols = Math.max(0, ...all.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, i) => Math.max(0, ...all.map((r) => visibleWidth(r[i] ?? ''))))
  return all.map((r) => {
    const cells = Array.from({ length: cols }, (_, i) => {
      const cell = String(r[i] ?? '')
      const last = i === cols - 1
      return last && align[i] !== 'right' ? cell : pad(cell, widths[i], align[i] ?? 'left')
    })
    return (' '.repeat(indent) + cells.join(' '.repeat(gap))).replace(/\s+$/, '')
  })
}

/**
 * `key  value` pairs with the values in one column — the shape `doctor` and
 * the eval summary already print, as a primitive.
 *
 * A value with newlines in it continues under its own first line, and a
 * missing value prints `—` rather than `undefined`.
 */
export function kv(
  pairs: Array<[unknown, unknown] | null | false>,
  { indent = 2, gap = 2, keyWidth = null, key = (s: string) => s }: { indent?: number; gap?: number; keyWidth?: number | null; key?: (s: string) => string } = {},
): string[] {
  const rows = pairs.filter(Boolean) as Array<[unknown, unknown]>
  const w = keyWidth ?? Math.max(0, ...rows.map(([k]) => visibleWidth(k)))
  const lead = ' '.repeat(indent)
  const hang = ' '.repeat(indent + w + gap)
  const out = []
  for (const [k, v] of rows) {
    const [first, ...more] = String(v ?? '—').split('\n')
    out.push(`${lead}${key(pad(k, w))}${' '.repeat(gap)}${first}`.replace(/\s+$/, ''))
    for (const line of more) out.push(`${hang}${line}`.replace(/\s+$/, ''))
  }
  return out
}

/** `── title ─────` — the separator `eval` has always drawn by hand. */
export function rule(title = '', width = 60, { unicode = true }: { unicode?: boolean } = {}): string {
  const h = unicode ? '─' : '-'
  if (!title) return h.repeat(width)
  return `${h}${h} ${title} ${h.repeat(Math.max(2, width - visibleWidth(title) - 4))}`
}

/** Lines in a frame, with an optional title set into the top edge. */
export function box(
  lines: string[],
  { title = '', width = null, unicode = true }: { title?: string; width?: number | null; unicode?: boolean } = {},
): string[] {
  const ch = unicode
    ? { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' }
  const inner = width ? Math.max(1, width - 4) : Math.max(visibleWidth(title) + 2, ...lines.map(visibleWidth))
  const top = title
    ? `${ch.tl}${ch.h} ${title} ${ch.h.repeat(Math.max(0, inner - visibleWidth(title) - 1))}${ch.tr}`
    : `${ch.tl}${ch.h.repeat(inner + 2)}${ch.tr}`
  return [
    top,
    ...lines.map((l) => `${ch.v} ${pad(truncate(l, inner), inner)} ${ch.v}`),
    `${ch.bl}${ch.h.repeat(inner + 2)}${ch.br}`,
  ]
}

// ── marks ────────────────────────────────────────────────────────────────────

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/**
 * A horizontal bar, exactly `width` columns, in eighths of a block.
 *
 * Eighths rather than whole blocks because the bars this CLI draws are short
 * — an outcome share in twenty columns — and a whole-block bar rounds 2% and
 * 4% to the same nothing. The ASCII form has no partial glyph and rounds.
 */
export function bar(fraction: number, width: number, { unicode = true, track = ' ' }: { unicode?: boolean; track?: string } = {}): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const w = Math.max(0, Math.floor(width))
  if (!unicode) {
    const n = Math.round(f * w)
    return '#'.repeat(n) + track.repeat(w - n)
  }
  const eighths = Math.round(f * w * 8)
  const full = Math.floor(eighths / 8)
  const part = full < w ? EIGHTHS[eighths % 8] : ''
  return '█'.repeat(full) + part + track.repeat(Math.max(0, w - full - (part ? 1 : 0)))
}

const SPARKS = '▁▂▃▄▅▆▇█'
const ASCII_SPARKS = '_.-~=+*#'

/**
 * One character per value, scaled between the smallest and the largest.
 *
 * A missing value is a space, so a run that did not measure a metric leaves a
 * gap in its history rather than a zero it never scored. A series that never
 * moved draws a flat line — on the floor when it is all zeros, at mid height
 * otherwise, so "always 0.803" does not read as "always nothing".
 */
export function sparkline(
  values: Array<number | null | undefined>,
  { min = null, max = null, unicode = true }: { min?: number | null; max?: number | null; unicode?: boolean } = {},
): string {
  const levels = unicode ? SPARKS : ASCII_SPARKS
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!nums.length) return ' '.repeat(values.length)
  const lo = min ?? Math.min(...nums)
  const hi = max ?? Math.max(...nums)
  return values
    .map((v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return ' '
      if (hi === lo) return levels[v === 0 ? 0 : Math.floor((levels.length - 1) / 2)]
      const i = Math.round(((v - lo) / (hi - lo)) * (levels.length - 1))
      return levels[Math.min(levels.length - 1, Math.max(0, i))]
    })
    .join('')
}

/**
 * `▲ +0.031`, coloured by whether the move is GOOD — not by its sign.
 *
 * A latency that went up is red and an F1 that went up is green, and that
 * judgement is made in one place: `better` comes from `HIGHER_IS_BETTER` and
 * `LOWER_IS_BETTER` in `src/eval/report.ts`. `null` is a number with no good
 * direction, and prints muted.
 */
export function delta(
  value: number | null | undefined,
  better: 'higher' | 'lower' | null,
  {
    digits = 3,
    unicode = true,
    color = false,
    format = null,
  }: { digits?: number; unicode?: boolean; color?: boolean; format?: ((abs: number) => string) | null } = {},
): string {
  const c = palette(color)
  if (value == null || !Number.isFinite(value)) return c.muted('—')
  const shown = format ? format(Math.abs(value)) : Math.abs(value).toFixed(digits)
  if (value === 0) return c.muted(`= ${shown}`)
  const up = value > 0
  const s = symbols(unicode)
  const text = `${up ? s.up : s.down} ${up ? '+' : '-'}${shown}`
  const good = better === 'higher' ? up : better === 'lower' ? !up : null
  return good == null ? c.muted(text) : good ? c.ok(text) : c.fail(text)
}

// ── numbers ──────────────────────────────────────────────────────────────────

/** `850ms`, `4.2s`, `42s`, `3m 05s`, `2h 03m`, `1d 04h`. */
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`
}

/** `512 B`, `1.2 KB`, `336 KB`, `1.3 MB` — in 1024s, as the build log prints them. */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`
}

/** A fraction as a percentage: `0.674` → `67.4%`. */
export function pct(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—'
  return `${(fraction * 100).toFixed(digits)}%`
}

/** `1,204` — a count, grouped. */
export function count(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

/** `950`, `12.3k`, `2.1M` — a token count, short. */
export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(a < 10_000_000 ? 1 : 0)}M`
}

// ── live output ──────────────────────────────────────────────────────────────

const toLines = (lines: string | string[] | null | undefined) =>
  lines == null ? [] : Array.isArray(lines) ? lines : String(lines).split('\n')

/**
 * A block of lines redrawn in place — the ceiling of what this CLI draws.
 *
 * On a terminal every `render` moves the cursor up over the lines it drew last
 * time, erases to the end of the screen and draws again. Each line is cut to
 * the terminal's width first, because a line that wraps takes two rows and
 * the next cursor-up would land one row short; the block is cut to its
 * height for the same reason.
 *
 * ON ANYTHING ELSE IT WRITES NOTHING until `done()`, which writes the final
 * lines once. A log gets the result, not three hundred frames of it.
 *
 * THE CURSOR IS LEFT VISIBLE. Hiding it would read better, and a process killed
 * by a signal does not run its `exit` handlers — so the one escape that cannot
 * be guaranteed a matching one is the one not written.
 */
export function live(stream: any = process.stderr, { tty = null }: { tty?: boolean | null } = {}) {
  const isTTY = tty ?? Boolean(stream?.isTTY)
  let drawn = 0
  let last: string[] = []
  const fit = (lines: string[]) => {
    const width = Math.max(10, (stream?.columns || 80) - 1)
    const height = stream?.rows ? Math.max(1, stream.rows - 1) : Infinity
    return lines.slice(0, height).map((l) => truncate(l, width))
  }
  const erase = () => {
    if (drawn) stream.write(`\x1b[${drawn}A\r\x1b[J`)
    drawn = 0
  }
  return {
    tty: isTTY,
    render(lines: string | string[]) {
      last = toLines(lines)
      if (!isTTY) return
      const out = fit(last)
      stream.write((drawn ? `\x1b[${drawn}A\r\x1b[J` : '') + out.map((l) => `${l}\n`).join(''))
      drawn = out.length
    },
    /** Take the block off the screen and leave the cursor where it started. */
    clear() {
      if (isTTY) erase()
    },
    /** The block's last word: drawn once, and left on the screen or in the log. */
    done(lines: string | string[] | null = last) {
      const final = toLines(lines)
      if (isTTY) {
        erase()
        if (final.length) stream.write(fit(final).map((l) => `${l}\n`).join(''))
      } else if (final.length) {
        stream.write(final.map((l) => `${l}\n`).join(''))
      }
      last = []
    },
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const ASCII_SPINNER = ['-', '\\', '|', '/']

/**
 * Something is happening and there is no count to show for it.
 *
 * The timer is `unref`'d: a spinner nobody stopped must not be what keeps the
 * process alive after the work it was spinning for has failed.
 */
export function spinner(
  text: string,
  { stream = process.stderr, interval = 80, color = colorEnabled(stream), unicode = unicodeEnabled() }: { stream?: any; interval?: number; color?: boolean; unicode?: boolean } = {},
) {
  const c = palette(color)
  const s = symbols(unicode)
  const frames = unicode ? SPINNER_FRAMES : ASCII_SPINNER
  const region = live(stream)
  let label = text
  let i = 0
  const draw = () => region.render([`  ${c.info(frames[i++ % frames.length])} ${label}`])
  const timer = region.tty ? setInterval(draw, interval) : null
  timer?.unref?.()
  if (region.tty) draw()
  const stop = (final: string | null) => {
    if (timer) clearInterval(timer)
    region.done(final ? [final] : [])
  }
  return {
    update(t: string) {
      label = t
      if (region.tty) draw()
    },
    succeed(t = label) {
      stop(`  ${c.ok(s.ok)} ${t}`)
    },
    fail(t = label) {
      stop(`  ${c.fail(s.fail)} ${t}`)
    },
    stop() {
      stop(null)
    },
  }
}

/**
 * A count with a bar, the time it has taken, and the time it will take.
 *
 * The rate is measured from the FIRST update, not from creation: the first
 * callback of a batched embed arrives after a whole batch, and a rate taken
 * from zero would promise the rest at the speed of nothing. Redraws are
 * throttled — a record loop can tick faster than a terminal is worth
 * repainting — except the last one, which always lands.
 */
export function progress({
  label = '',
  total = 0,
  stream = process.stderr,
  width = 20,
  now = Date.now,
  started = null,
  color = colorEnabled(stream),
  unicode = unicodeEnabled(),
  throttleMs = 60,
}: {
  label?: string
  total?: number
  stream?: any
  width?: number
  now?: () => number
  started?: number | null
  color?: boolean
  unicode?: boolean
  throttleMs?: number
} = {}) {
  const c = palette(color)
  const region = live(stream)
  const t0 = started ?? now()
  let done = 0
  let base: { t: number; n: number } | null = null
  let lastDraw = -Infinity

  const line = () => {
    const t = now()
    const f = total > 0 ? Math.min(1, done / total) : 0
    const parts = [
      `  ${label ? `${label}  ` : ''}${c.accent(bar(f, width, { unicode, track: unicode ? '·' : '.' }))}`,
      `${count(done)}/${count(total)}`,
      pct(f, 0),
      duration(t - t0),
    ]
    if (base && done > base.n && done < total) {
      const rate = (done - base.n) / Math.max(1, t - base.t)
      parts.push(c.muted(`ETA ${duration((total - done) / rate)}`))
    }
    return parts.join('  ')
  }
  const draw = (force = false) => {
    const t = now()
    if (!force && t - lastDraw < throttleMs) return
    lastDraw = t
    region.render([line()])
  }

  return {
    get tty() {
      return region.tty
    },
    get done() {
      return done
    },
    update(n: number, of: number = total) {
      done = n
      total = of
      if (!base) base = { t: now(), n }
      draw(n >= total)
    },
    advance(k = 1) {
      this.update(done + k)
    },
    /**
     * Print above the bar: take it down, let `fn` write, put it back. How a
     * record loop keeps one line per record AND a bar under them.
     *
     * `advance` counts the work the line reports BEFORE the bar comes back, so
     * the bar under "q-07 ok" already says seven — a redraw after it would be
     * throttled away and leave the count one record behind its own lines.
     */
    above(fn: () => void, { advance = 0 }: { advance?: number } = {}) {
      region.clear()
      try {
        fn()
      } finally {
        done += advance
        if (!base) base = { t: now(), n: done }
        if (region.tty) {
          lastDraw = now()
          region.render([line()])
        }
      }
    },
    clear() {
      region.clear()
    },
    /** Leave the final bar (default), a line of your own, or — with `null` — nothing. */
    finish(final?: string | null) {
      region.done(final === undefined ? (base ? [line()] : []) : final === null ? [] : [final])
    },
    line,
  }
}

/**
 * `tick()` that knows its count: a bar with an ETA on a terminal, and on
 * anything else exactly the line `tick()` has always written.
 *
 * The call sites in `index`, `eval`, `calibrate` and `tune` already had the
 * numbers and a sentence; this keeps the sentence for the log and draws the
 * numbers for the person watching. `redraws()` decides, as it decides for
 * `tick()` itself — progress is diagnostics, so the question is about stderr.
 */
export function meter(label: string, opts: { now?: () => number; stream?: any } = {}) {
  const started = (opts.now ?? Date.now)()
  let shown: ReturnType<typeof progress> | null = null
  return {
    tick(done: number, total: number, text: string, at = true) {
      if (!redraws()) return tick(text, at)
      shown ??= progress({ label, total, started, ...opts })
      shown.update(done, total)
    },
    /** The line that stays: it replaces the bar, or stands alone in a log. */
    tock(text: string) {
      if (shown) {
        shown.clear()
        shown = null
      }
      tock(text)
    },
    /** Print above the bar, if there is one. */
    above(fn: () => void) {
      if (shown) shown.above(fn)
      else fn()
    },
    /** Close the bar: keep its last frame on the screen, or take it away. */
    end({ keep = true }: { keep?: boolean } = {}) {
      if (!shown) return
      shown.finish(keep ? undefined : null)
      shown = null
    },
  }
}

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * Raw keypresses from a terminal, and the one function that gives the terminal
 * back.
 *
 * RAW MODE LEFT ON AFTER A CRASH LEAVES THE READER'S TERMINAL BROKEN — no
 * echo, no line editing, until they type `reset` blind. So the restore is
 * idempotent and wired to every way out this process has: the caller's own
 * `finally`, the `exit` event, and the two signals a terminal sends a job it
 * is closing. A signal handler replaces Node's default of dying, so it exits
 * itself, with the shell's own code for that signal.
 */
export function keys(stdin: any, onKey: (str: string, key: any) => void) {
  emitKeypressEvents(stdin)
  const wasRaw = Boolean(stdin.isRaw)
  stdin.setRawMode?.(true)
  stdin.resume?.()
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    stdin.off('keypress', handler)
    process.off('exit', restore)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    try {
      stdin.setRawMode?.(wasRaw)
    } catch {
      // A stream that closed underneath us has no mode left to restore.
    }
    stdin.pause?.()
  }
  const onSignal = (signal: string) => {
    restore()
    process.exit(signal === 'SIGHUP' ? 129 : 143)
  }
  const handler = (str: string, key: any) => {
    try {
      onKey(str ?? '', key ?? {})
    } catch (e) {
      restore()
      throw e
    }
  }
  stdin.on('keypress', handler)
  process.once('exit', restore)
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  return restore
}

/**
 * An arrow-key menu: ↑/↓ or j/k to move, a digit to pick, Enter to run.
 *
 * Esc and `q` BACK OUT and resolve `null` — the reader is still here, and the
 * caller decides what that means. Ctrl-C and Ctrl-D are the two ways a reader
 * declines to answer at all, and the CLI's code for that is `130`
 * (`src/cli-exit.ts`); `exit` is injectable so a test can watch it happen.
 *
 * OFF A TERMINAL it falls back to `askOne`, the numbered prompt `init` and
 * `index` have always asked through, because a menu nobody can see is a hang.
 *
 * @param choices `{ label, value, hint? }` — `value` is what resolves.
 */
export async function select({
  message,
  choices,
  initial = 0,
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  exit = (code: number) => process.exit(code),
}: {
  message: string
  choices: Array<{ label: string; value: any; hint?: string }>
  initial?: number
  stdin?: any
  stdout?: any
  env?: Env
  exit?: (code: number) => void
}): Promise<any> {
  if (!choices.length) return null
  if (!stdin?.isTTY || !stdout?.isTTY) return selectByNumber({ message, choices, initial, stdin, stdout, exit })

  const c = palette(colorEnabled(stdout, env))
  const s = symbols(unicodeEnabled(env))
  const region = live(stdout)
  let cursor = Math.min(Math.max(0, initial), choices.length - 1)
  const labelWidth = Math.max(...choices.map((ch) => visibleWidth(ch.label)))

  const frame = () => [
    `  ${c.bold(message)}`,
    ...choices.map((ch, i) => {
      const n = i < 9 ? `${i + 1}.` : '  '
      const hint = ch.hint ? `  ${c.muted(ch.hint)}` : ''
      const label = ch.hint ? pad(ch.label, labelWidth) : ch.label
      return i === cursor
        ? `  ${c.accent(s.pointer)} ${c.accent(`${n} ${label}`)}${hint}`
        : `    ${n} ${label}${hint}`
    }),
    c.muted('  ↑/↓ move · 1-9 pick · Enter run · q back'),
  ]

  return new Promise((resolve) => {
    let restore = () => {}
    let settled = false
    // A terminal that goes away mid-question is a reader who did not answer.
    const onEnd = () => {
      finish(null)
      exit(CANCELLED)
    }
    const finish = (value: any, final: string[] = []) => {
      if (settled) return
      settled = true
      stdin.off?.('end', onEnd)
      restore()
      region.done(final)
      resolve(value)
    }
    const pick = (i: number) => finish(choices[i].value, [`  ${c.bold(message)} ${c.accent(choices[i].label)}`])
    restore = keys(stdin, (str, key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish(null)
        exit(CANCELLED)
        return
      }
      if (key.name === 'escape' || str === 'q') return finish(null)
      if (key.name === 'return' || key.name === 'enter') return pick(cursor)
      if (/^[1-9]$/.test(str) && Number(str) <= choices.length) return pick(Number(str) - 1)
      if (key.name === 'up' || str === 'k') cursor = (cursor - 1 + choices.length) % choices.length
      else if (key.name === 'down' || str === 'j') cursor = (cursor + 1) % choices.length
      else return
      region.render(frame())
    })
    stdin.once?.('end', onEnd)
    region.render(frame())
  })
}

/** The fallback: the numbered list `askOne` draws, read a line at a time. */
async function selectByNumber({ message, choices, initial, stdin, stdout, exit }) {
  const { createInterface } = await import('node:readline/promises')
  const { askOne } = await import('./cli-ask.js')
  const rl = createInterface({ input: stdin, output: stdout })
  rl.on('SIGINT', () => {
    rl.close()
    exit(CANCELLED)
  })
  const labels = choices.map((ch) => ch.label)
  try {
    const picked = await askOne(rl, {
      label: message,
      options: labels,
      default: labels[Math.min(Math.max(0, initial), labels.length - 1)],
      hints: Object.fromEntries(choices.map((ch) => [ch.label, ch.hint ?? ''])),
    })
    return choices.find((ch) => ch.label === picked)?.value ?? null
  } catch {
    // Ctrl-D closes stdin mid-question and readline rejects: the same intent
    // as Ctrl-C, and the same code.
    exit(CANCELLED)
    return null
  } finally {
    rl.close()
  }
}
