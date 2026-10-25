/**
 * A small flag parser for `traffic` and `dataset`, until the lead moves both
 * into the shared table in `cli-flags.ts`.
 *
 * `--name=value` and `--name value` both work; a boolean flag takes no value.
 * An unknown flag, a missing value or a bad integer is a usage error naming
 * the flag — never a silently ignored word.
 */

export type FlagKind = 'bool' | 'value' | 'int' | 'number'

export interface FlagSpec {
  kind: FlagKind
  help: string
}

export function parseFlags(
  argv: string[],
  spec: Record<string, FlagSpec>,
): {mode: string | null; flags: Record<string, any>; error: string | null; help: boolean} {
  const flags: Record<string, any> = {}
  let mode: string | null = null
  let help = false
  const rest = [...argv]
  while (rest.length) {
    const a = rest.shift()
    if (a === '--help' || a === '-h') {
      help = true
      continue
    }
    if (!a.startsWith('--')) {
      if (mode) return {mode, flags, help, error: `unexpected argument "${a}"`}
      mode = a
      continue
    }
    const eq = a.indexOf('=')
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
    const s = spec[name]
    if (!s) return {mode, flags, help, error: `unknown option "--${name}"`}
    if (s.kind === 'bool') {
      if (eq >= 0) return {mode, flags, help, error: `--${name} takes no value`}
      flags[name] = true
      continue
    }
    let v = eq >= 0 ? a.slice(eq + 1) : rest[0]
    if (eq < 0) {
      if (v == null || v.startsWith('--')) return {mode, flags, help, error: `--${name} needs a value`}
      rest.shift()
    }
    if (s.kind === 'int') {
      if (!/^\d+$/.test(v)) return {mode, flags, help, error: `--${name} must be a non-negative integer, got "${v}"`}
      flags[name] = Number(v)
    } else if (s.kind === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n)) return {mode, flags, help, error: `--${name} must be a number, got "${v}"`}
      flags[name] = n
    } else flags[name] = v
  }
  return {mode, flags, help, error: null}
}

export function renderHelp(usage: string, spec: Record<string, FlagSpec>, extra = ''): string {
  const w = Math.max(...Object.keys(spec).map((k) => k.length + (spec[k].kind === 'bool' ? 0 : 6))) + 4
  const lines = Object.entries(spec).map(([k, s]) => {
    const left = `--${k}${s.kind === 'bool' ? '' : s.kind === 'int' ? '=<n>' : '=<v>'}`
    return `  ${left.padEnd(w)}${s.help}`
  })
  return `${usage}\n\nOptions:\n${lines.join('\n')}${extra ? `\n\n${extra}` : ''}`
}

export const SINCE = /^\d{4}-\d{2}-\d{2}$/
