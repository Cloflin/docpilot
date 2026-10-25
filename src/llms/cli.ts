/**
 * `docpilot llms <lint|build>` — the llms.txt beside the index.
 *
 *   lint   reads an llms.txt (a file, or a URL), checks it against the
 *          https://llmstxt.org/ format, and against the index: pages the index
 *          has and the file never links, links the index has no page for.
 *   build  writes an llms.txt from the index manifest, grouped and ordered by
 *          the site's own sidebar.
 *
 * The IO half. Everything worth testing is in parse.ts, lint.ts and build.ts,
 * which touch nothing.
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {FAILED, OK, USAGE} from '../cli-exit.js'
import {indexDirOf} from '../config.js'
import {splitFrontmatter} from '../build/lib/normalise.js'
import {lintLlmsTxt, coverage, renderLint, scoreOf, countOf, type Finding} from './lint.js'
import {buildLlmsTxt} from './build.js'

const MODES = ['lint', 'build']

/** Kept local until the lead moves `llms` into the shared flag table. */
export const FLAGS: Record<string, {kind: 'bool' | 'value'; modes: string[]; help: string}> = {
  file: {kind: 'value', modes: ['lint'], help: 'llms.txt to lint — a path or an http(s) URL (default: <docsDir>/public/llms.txt, then <docsDir>/.vitepress/dist/llms.txt)'},
  site: {kind: 'value', modes: ['lint', 'build'], help: 'published origin and base, e.g. https://docs.example.com/ — makes URLs absolute (build) and maps them to pages (lint)'},
  json: {kind: 'bool', modes: ['lint'], help: 'print findings as JSON'},
  out: {kind: 'value', modes: ['build'], help: 'where to write (default: <docsDir>/public/llms.txt)'},
  title: {kind: 'value', modes: ['build'], help: 'the H1 (default: docPilot.product, else the first page title)'},
  summary: {kind: 'value', modes: ['build'], help: 'the blockquote summary (default: docPilot.description, else the introduction page description)'},
  md: {kind: 'bool', modes: ['build'], help: 'link <page>.md, the markdown copy the spec recommends, instead of the rendered route'},
  force: {kind: 'bool', modes: ['build'], help: 'overwrite an existing file'},
}

export const HELP = `Usage: docpilot llms <lint|build> [options]

  lint    check an llms.txt against https://llmstxt.org/ and against the index
  build   write an llms.txt from the index manifest

lint options
  --file=PATH|URL   ${FLAGS.file.help}
  --site=URL        ${FLAGS.site.help}
  --json            ${FLAGS.json.help}

build options
  --out=PATH        ${FLAGS.out.help}
  --site=URL        ${FLAGS.site.help}
  --title=TEXT      ${FLAGS.title.help}
  --summary=TEXT    ${FLAGS.summary.help}
  --md              ${FLAGS.md.help}
  --force           ${FLAGS.force.help}

Exit: 0 done · 1 lint found an error, or the work failed · 2 bad command line`

interface Args {
  mode: string | null
  help: boolean
  flags: Record<string, string | boolean>
  error?: string
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {mode: null, help: false, flags: {}}
  const rest = [...argv]
  while (rest.length) {
    const a = rest.shift() as string
    if (a === '--help' || a === '-h') {
      args.help = true
      continue
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq)
      const spec = FLAGS[name]
      if (!spec) return {...args, error: `unknown option "${a}"`}
      if (spec.kind === 'bool') {
        if (eq >= 0) return {...args, error: `--${name} takes no value`}
        args.flags[name] = true
      } else {
        const v = eq >= 0 ? a.slice(eq + 1) : rest.shift()
        if (v === undefined || v === '' || (eq < 0 && v.startsWith('--'))) return {...args, error: `--${name} needs a value: --${name}=…`}
        args.flags[name] = v
      }
      continue
    }
    if (!args.mode) args.mode = a
    else return {...args, error: `unexpected argument "${a}"`}
  }
  if (args.mode && MODES.includes(args.mode))
    for (const name of Object.keys(args.flags))
      if (!FLAGS[name].modes.includes(args.mode)) return {...args, error: `--${name} is not an option of "llms ${args.mode}"`}
  return args
}

const isUrl = (s: string) => /^https?:\/\//i.test(s)

/** Relative to cwd when inside it, absolute otherwise. */
const shown = (cwd: string, f: string) => {
  const r = path.relative(cwd, f)
  return !r || r.startsWith('..') ? f : r
}

const docsDirOf = (docPilot: any, cwd: string) => path.resolve(cwd, docPilot?.docsDir || 'docs')

/** Where an llms.txt is looked for when --file is not given. */
export function defaultLlmsFiles(docPilot: any, cwd = process.cwd()): string[] {
  const docs = docsDirOf(docPilot, cwd)
  const dist = docPilot?.outDir ? path.resolve(cwd, docPilot.outDir) : path.join(docs, '.vitepress', 'dist')
  return [path.join(docs, 'public', 'llms.txt'), path.join(dist, 'llms.txt')]
}

function readManifest(docPilot: any, cwd: string): any | null {
  const file = path.resolve(cwd, indexDirOf({docsDir: 'docs', ...docPilot}), 'manifest.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Page path → frontmatter description. Read from the source markdown first —
 * the chunks carry it only as an unmarked second line of the first chunk —
 * and from a chunk's own `description` field when an index has one.
 */
export function collectDescriptions(docPilot: any, manifest: any, cwd = process.cwd()): Record<string, string> {
  const out: Record<string, string> = {}
  const docs = docsDirOf(docPilot, cwd)
  for (const p of manifest?.pages ?? []) {
    if (p.external) continue
    const route = String(p.path).replace(/\/$/, '')
    for (const f of [`${route || '/index'}.md`, `${route}/index.md`]) {
      const file = path.join(docs, f)
      if (!existsSync(file)) continue
      try {
        const d = splitFrontmatter(readFileSync(file, 'utf8')).description
        if (d) out[p.path] = d
      } catch {}
      break
    }
  }
  const dir = path.resolve(cwd, indexDirOf({docsDir: 'docs', ...docPilot}))
  for (const shard of Array.isArray(manifest?.shards) ? manifest.shards : []) {
    try {
      for (const c of JSON.parse(readFileSync(path.join(dir, shard), 'utf8')))
        if (c?.description && c.path && !out[c.path]) out[c.path] = String(c.description)
    } catch {}
  }
  return out
}

/** Does this project generate llms.txt with vitepress-plugin-llms already? */
export function usesVitepressPluginLlms(cwd = process.cwd()): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    return Boolean(pkg.devDependencies?.['vitepress-plugin-llms'] || pkg.dependencies?.['vitepress-plugin-llms'])
  } catch {
    return false
  }
}

const PLUGIN_NOTE =
  `[docpilot] vitepress-plugin-llms is in package.json. Prefer it: it regenerates llms.txt on every\n` +
  `           docs build, plus llms-full.txt and a .md beside every route. This command writes a\n` +
  `           one-off file from the index, and a later docs build may overwrite it.`

/**
 * @param o.docPilot resolved settings
 * @param o.argv everything after `llms`
 * @param o.fetch injectable for tests; defaults to the global
 * @returns exit code
 */
export async function runLlms({
  docPilot = {},
  argv = [],
  env = {},
  cwd = process.cwd(),
  fetch: fetchImpl = globalThis.fetch,
}: {docPilot?: any; argv?: string[]; env?: Record<string, string | undefined>; cwd?: string; fetch?: typeof fetch}): Promise<number> {
  void env
  const args = parseArgs(argv)
  if (args.help) {
    console.log(HELP)
    return OK
  }
  if (args.error) {
    console.error(`[docpilot] ${args.error}\n\n${HELP}`)
    return USAGE
  }
  if (!args.mode) {
    console.log(HELP)
    return USAGE
  }
  if (!MODES.includes(args.mode)) {
    console.error(`[docpilot] unknown mode "${args.mode}". One of: ${MODES.join(', ')}`)
    return USAGE
  }
  const site = (args.flags.site as string) || null
  if (site && !isUrl(site)) {
    console.error(`[docpilot] --site must be an absolute http(s) URL, got "${site}"`)
    return USAGE
  }
  return args.mode === 'lint'
    ? lint({docPilot, flags: args.flags, site, cwd, fetchImpl})
    : build({docPilot, flags: args.flags, site, cwd})
}

async function lint({docPilot, flags, site, cwd, fetchImpl}): Promise<number> {
  let file = flags.file as string | undefined
  let text: string
  let fullPresent: boolean | null = null

  if (file && isUrl(file)) {
    try {
      const res = await fetchImpl(file)
      if (!res.ok) {
        console.error(`[docpilot] ${file} answered ${res.status}`)
        return FAILED
      }
      text = await res.text()
    } catch (e) {
      console.error(`[docpilot] could not fetch ${file} — ${e.message}`)
      return FAILED
    }
    try {
      const full = await fetchImpl(new URL('llms-full.txt', file).href, {method: 'HEAD'})
      fullPresent = full.ok
    } catch {
      fullPresent = null
    }
  } else {
    if (!file) {
      const candidates = defaultLlmsFiles(docPilot, cwd)
      file = candidates.find((c) => existsSync(c))
      if (!file) {
        console.error(
          `[docpilot] no llms.txt found. Looked in:\n` +
            candidates.map((c) => `    ${shown(cwd, c)}`).join('\n') +
            `\n\n  Point at one:   npx docpilot llms lint --file=path/to/llms.txt\n` +
            `  Or a live one:  npx docpilot llms lint --file=https://docs.example.com/llms.txt\n` +
            `  Or write one:   npx docpilot llms build --site=https://docs.example.com`,
        )
        return FAILED
      }
    }
    file = path.resolve(cwd, file)
    if (!existsSync(file)) {
      console.error(`[docpilot] no such file: ${file}`)
      return FAILED
    }
    text = readFileSync(file, 'utf8')
    fullPresent = existsSync(path.join(path.dirname(file), 'llms-full.txt'))
  }

  const {parsed, findings} = lintLlmsTxt(text, {site, fullPresent})
  const manifest = readManifest(docPilot, cwd)
  let cover: ReturnType<typeof coverage> | null = null
  const all: Finding[] = [...findings]
  if (manifest) {
    cover = coverage(parsed, manifest, {site, base: docPilot?.host?.base ?? null})
    all.push(...cover.findings)
  }

  const c = countOf(all)
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          file,
          score: scoreOf(all),
          counts: c,
          coverage: cover && {pages: cover.pages, linked: cover.linked, unlinked: cover.unlinked, notIndexed: cover.notIndexed},
          findings: all,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(renderLint(all, {file: isUrl(file) ? file : shown(cwd, file), cover}))
    if (!manifest) console.log(`\n(no index manifest found — run \`npx docpilot index\` to also check coverage)`)
  }
  return c.error ? FAILED : OK
}

function build({docPilot, flags, site, cwd}): number {
  const manifest = readManifest(docPilot, cwd)
  if (!manifest?.pages?.length) {
    console.error(`[docpilot] no index manifest with pages under ${indexDirOf({docsDir: 'docs', ...docPilot})}. Run \`npx docpilot index\` first.`)
    return FAILED
  }
  const plugin = usesVitepressPluginLlms(cwd)
  if (plugin) console.log(PLUGIN_NOTE)

  const out = path.resolve(cwd, (flags.out as string) || path.join(docPilot?.docsDir || 'docs', 'public', 'llms.txt'))
  if (existsSync(out) && !flags.force) {
    console.error(`[docpilot] ${shown(cwd, out)} exists. Pass --force to overwrite it.`)
    return FAILED
  }

  const text = buildLlmsTxt({
    manifest,
    descriptions: collectDescriptions(docPilot, manifest, cwd),
    title: (flags.title as string) || docPilot?.product || null,
    summary: (flags.summary as string) || docPilot?.description || null,
    site,
    md: Boolean(flags.md),
  })
  mkdirSync(path.dirname(out), {recursive: true})
  writeFileSync(out, text)

  const {parsed, findings} = lintLlmsTxt(text, {site})
  const links = parsed.sections.reduce((s, x) => s + x.items.length, 0)
  console.log(`[docpilot] wrote ${shown(cwd, out)} — ${parsed.sections.length} section(s), ${links} link(s), ${Buffer.byteLength(text)} bytes`)
  const notable = findings.filter((x) => x.severity !== 'info')
  if (notable.length) console.log(renderLint(notable))
  if (!site) console.log(`[docpilot] links are relative — pass --site=https://… so an agent reading the file elsewhere can follow them`)
  if (flags.md) console.log(`[docpilot] --md links <page>.md — make sure the host serves those (vitepress-plugin-llms generates them), as text/markdown`)
  return OK
}
