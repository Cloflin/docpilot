/**
 * `.env` and `.env.local`, read the way Vite reads them for the VitePress build,
 * and the one law about who wins.
 *
 * WHY IT IS A MODULE OF ITS OWN. This function used to live in
 * `src/cli-context.ts`, which resolves `settings` at MODULE SCOPE out of
 * `globalThis.__DOCPILOT_SETTINGS__` — a global the launcher writes AFTER it
 * has loaded the config. Importing that file for this one function would run
 * that resolution early, against an empty config, and cache the result: every
 * path in the package would then point at the shipped defaults rather than at
 * the project's own. `cli-context.ts:22` exists to explain that ordering; this
 * file exists so nothing has to break it.
 *
 * THE LAW: THE EXISTING ENVIRONMENT WINS. It was already written down —
 * `cli-context.ts:73`, "The existing environment wins at every call site" — and
 * followed by three of the seven readers. `bin/docpilot.js` inverted it with
 * `{ ...process.env, ...loadEnv(…) }`, and so did `vocabulary.ts`; a fourth put
 * the file into a private object that never reached `process.env`; and `bench`
 * and `lint` did not read the file at all, while the CLI's own help told
 * readers to put their key in it.
 *
 * 12-factor CLI is where the law comes from, and the case it protects is the
 * ordinary one: a checked-in `.env` naming a shared endpoint, and a one-off
 * `OPENROUTER_API_KEY=… npx docpilot eval` that has to beat it.
 */

import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'

/**
 * Vite's list, in Vite's order — a later file overrides an earlier one:
 * `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`. What this replaced
 * was `loadEnv('', root, '')`, so mode is '' and the last two are `.env.` and
 * `.env..local` — names nobody writes, kept so that no file changes meaning.
 */
const MODE = ''
const FILES = ['.env', '.env.local', `.env.${MODE}`, `.env.${MODE}.local`]

/**
 * The file's contents, read the way Vite's `loadEnv` reads them, without Vite.
 *
 * It was `await import('vitepress')`, which resolved from THIS package's
 * location, not the project's: a Docusaurus or plain-script site, and a strict
 * pnpm layout that hides the project's own `vitepress`, got `{}` behind a bare
 * `catch` — while `init` had just told the reader to put their key in
 * `.env.local`. It also cost about 100 ms of every command's startup.
 *
 * Same files, same order, the same parser Vite 8 calls (`util.parseEnv`) and
 * the same `$VAR` expansion, so a file that worked keeps its values.
 */
export async function fileEnv(root = process.cwd(), env = process.env) {
  const parse = typeof util.parseEnv === 'function' ? util.parseEnv : parseDotenv
  const parsed: Record<string, string> = {}
  for (const name of FILES) {
    const file = path.join(root, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (!stat.isFile() && !stat.isFIFO()) continue
    Object.assign(parsed, parse(fs.readFileSync(file, 'utf8')))
  }
  return expand(parsed, env)
}

/**
 * The parser for a Node below 20.12, which has no `util.parseEnv` — `engines`
 * says `>=20`. It follows Node's own rules for everything a key file holds:
 * `KEY=value`, an `export ` prefix, `#` comments on their own line or after an
 * unquoted value, single, double and backtick quotes (a quoted value may span
 * lines), and `\n` inside double quotes as a newline.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lineAfter = (s, from = 0) => {
    const nl = s.indexOf('\n', from)
    return nl === -1 ? '' : s.slice(nl + 1)
  }
  let s = trimSpaces(String(text).replace(/\r/g, ''))
  while (s) {
    if (s[0] === '\n' || s[0] === '#') {
      s = lineAfter(s)
      continue
    }
    const at = s.search(/[=\n]/)
    if (at === -1 || s[at] === '\n') {
      s = trimSpaces(lineAfter(s))
      continue
    }
    let key = trimSpaces(s.slice(0, at))
    s = s.slice(at + 1)
    // Node stores an empty value before it looks at the key, so `export A=`
    // keeps its prefix there, and here.
    if (!s || s[0] === '\n') {
      out[key] = ''
      continue
    }
    s = trimSpaces(s)
    // An empty key drops the `=` alone; scanning resumes right after it.
    if (!key) continue
    if (key.startsWith('export ')) key = trimSpaces(key.slice(7))
    const quoted = s[0] === '"' || s[0] === "'" || s[0] === '`'
    const close = quoted ? s.indexOf(s[0], 1) : -1
    const nl = s.indexOf('\n')
    if (close !== -1) {
      const value = s.slice(1, close)
      out[key] = s[0] === '"' ? value.replace(/\\n/g, '\n') : value
      s = lineAfter(s, close + 1)
    } else if (quoted) {
      // An unclosed quote keeps the rest of the line, quote and `#` included.
      out[key] = nl === -1 ? s : s.slice(0, nl)
      s = nl === -1 ? '' : s.slice(nl + 1)
    } else {
      const line = nl === -1 ? s : s.slice(0, nl)
      const hash = line.indexOf('#')
      out[key] = trimSpaces(hash === -1 ? line : line.slice(0, hash))
      s = nl === -1 ? '' : s.slice(nl + 1)
    }
    s = trimSpaces(s)
  }
  return out
}

// Node's `trim_spaces` takes tabs and newlines too — so `A=   ` swallows the
// next line as its value there, and has to here.
const trimSpaces = (s) => s.replace(/^[ \t\n]+|[ \t\n]+$/g, '')

/**
 * `$VAR` and `${VAR}` expansion, ported line for line from the dotenv-expand
 * copy inside Vite 8's `loadEnv` — `${A:-x}`, `${A-x}`, `${A:+x}`, `${A+x}`, a
 * `\$` that stays literal — because the files this reads were written against
 * it. A value the environment already holds is the environment's: the law
 * below, which `applyFileEnv` enforces again by never overwriting.
 */
function expand(parsed: Record<string, string>, processEnv): Record<string, string> {
  for (const key in parsed) {
    let value = parsed[key]
    if (processEnv[key] && processEnv[key] !== value) value = processEnv[key]
    else value = expandValue(value, processEnv, parsed)
    parsed[key] = value.replace(/\\\$/g, '$')
  }
  return parsed
}

function expandValue(value, processEnv, runningParsed) {
  const env = { ...runningParsed, ...processEnv }
  const regex = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g
  let result = value
  let match
  const seen = new Set()
  while ((match = regex.exec(result)) !== null) {
    seen.add(result)
    const [template, braced, unbraced] = match
    const expression = braced || unbraced
    const splitter = expression.match(/(:\+|\+|:-|-)/)?.[0] ?? null
    const parts = expression.split(splitter)
    const name = parts.shift()
    let fallback
    let found
    if (splitter === ':+' || splitter === '+') {
      fallback = env[name] ? parts.join(splitter) : ''
      found = null
    } else {
      fallback = parts.join(splitter)
      found = env[name]
    }
    result = result.replace(template, found && !seen.has(found) ? found : fallback)
    if (result === runningParsed[name]) break
    regex.lastIndex = 0
  }
  return result
}

/**
 * Apply it, once, filling only what is not already set.
 *
 * The launcher calls this before it dispatches, so `bench` and `lint` — which
 * never read the file — see the key without a line changing in either of them,
 * and the five modules that each carried their own copy of this loop can stop.
 *
 * @returns the names of the keys it added, so a caller can say what it did.
 */
export async function applyFileEnv(env = process.env, root = process.cwd()) {
  const added = []
  for (const [k, v] of Object.entries(await fileEnv(root, env))) {
    if (env[k] === undefined) {
      env[k] = v
      added.push(k)
    }
  }
  return added
}
