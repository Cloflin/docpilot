/**
 * The one object every HTML path reads (engine-spec 043, D-06, D-21).
 *
 * `docPilot.html = { content?, exclude?, sources?: { [key]: { content?, exclude? } }, fetcher? }`.
 * `fetcher(url, { signal })` is the owner's renderer for `docpilot import`: it
 * returns a string or `{ html, url?, headers? }` (engine-spec 043, D-09). `content` is one CSS selector for the page
 * body; `exclude` is a selector or a list of them, removed from inside that
 * body. `index --html-dir` reads this object today, and the connectors of
 * Phase 3 pass the same `{ content, exclude }` pair to `extractHtml`.
 *
 * PRECEDENCE: flags, then the longest matching `sources` key, then the project
 * default. `content` and `exclude` are each taken separately from the most
 * specific level that sets it, and a level that sets `exclude` REPLACES the
 * lower level's list: an author who narrows a source expects the list they
 * wrote, not the list they wrote plus one they forgot.
 *
 * The config is read, never fetched: nothing here touches the network or the
 * page, so a build cannot depend on it being reachable.
 */

import path from 'node:path'

import { parseAllowlist, checkSource } from './sources.js'

/** What `extractHtml` takes from this file. */
export interface HtmlOptions {
  content: string
  exclude: string[]
}

/** The flags that sit above every config level (`--html-select`, `--html-exclude`). */
export interface HtmlFlags {
  content?: string
  exclude?: string | string[]
}

/**
 * A selector string or a list of them, as a list of non-empty trimmed strings.
 * An empty or whitespace-only string, or an empty list, is "not set": it falls
 * back to the next level instead of selecting nothing (HTML-01, empty edge).
 */
export function toList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
  }
  return []
}

/** One selector string, trimmed; '' when not set. */
function toSelector(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A target written as a URL (a connector page) rather than a path (a built file). */
const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * How well a `sources` key matches a target, or -1 for no match (D-21).
 *
 * A key that the `sources.allow` parser accepts is a URL key, matched with the
 * allowlist's own segment rule so `https://acme.test/help` never matches
 * `/helpdesk` (T-02-05). Any other key is a directory under the project root,
 * matched at a path-segment boundary. Specificity is the length of what the key
 * pins down, so the longest key wins. A URL key never matches a file target and
 * a directory key never matches a URL target.
 */
function specificity(key: string, target: string, root: string): number {
  const isUrlTarget = URL_TARGET.test(target)
  const { entries } = parseAllowlist({ allow: [key] })
  if (entries.length) {
    if (!isUrlTarget) return -1
    return 'href' in checkSource(target, entries) ? entries[0].origin.length + entries[0].prefix.length : -1
  }
  if (isUrlTarget) return -1
  const dir = path.resolve(root, key)
  const file = path.resolve(root, target)
  return file === dir || file.startsWith(dir + path.sep) ? dir.length : -1
}

/**
 * The `sources` level that applies to `target`: the highest specificity, and on
 * a tie the first key in `Object.keys` order, so two runs agree (HTML-01).
 */
function sourceLevel(html: any, target: string, root: string): { content?: unknown; exclude?: unknown } | null {
  const sources = html?.sources
  if (!sources || typeof sources !== 'object') return null
  let best = -1
  let level = null
  for (const key of Object.keys(sources)) {
    const score = specificity(key, target, root)
    if (score > best) {
      best = score
      level = sources[key]
    }
  }
  return level && typeof level === 'object' ? level : null
}

/**
 * The `content` and `exclude` selectors for one target.
 *
 * `target` is the file or URL the page came from. Levels, most specific first:
 * `flags`, the longest matching `html.sources` key, the project default.
 */
export function htmlOptionsFor(
  html: any,
  target: string,
  { root = process.cwd(), flags = {} }: { root?: string; flags?: HtmlFlags } = {},
): HtmlOptions {
  const levels: { content?: unknown; exclude?: unknown }[] = [flags]
  const source = sourceLevel(html, target, root)
  if (source) levels.push(source)
  if (html && typeof html === 'object') levels.push(html)

  let content = ''
  let exclude: string[] = []
  for (const level of levels) {
    if (!content) content = toSelector(level.content)
    if (!exclude.length) exclude = toList(level.exclude)
  }
  return { content, exclude }
}

const isPlain = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
const isStringList = (v: unknown) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))

/**
 * What is wrong with `docPilot.html`, one line per problem, naming the dotted
 * key. A typo here must not silently change what is indexed, so the builder
 * stops on any problem before it reads a page; this is a config error and not a
 * bad page (D-11 covers pages only).
 */
export function htmlConfigProblems(html: unknown): string[] {
  if (html === undefined || html === null) return []
  if (!isPlain(html)) return ['docPilot.html must be an object']
  const out: string[] = []
  const h = html as Record<string, unknown>

  for (const key of Object.keys(h)) {
    if (!['content', 'exclude', 'sources', 'fetcher'].includes(key)) {
      out.push(`docPilot.html.${key} is not a known key (content, exclude, sources, fetcher)`)
    }
  }
  if ('fetcher' in h && typeof h.fetcher !== 'function') {
    out.push('docPilot.html.fetcher must be a function (url, { signal }) => string | { html, url?, headers? }')
  }
  if ('content' in h && typeof h.content !== 'string') out.push('docPilot.html.content must be a string')
  if ('exclude' in h && !isStringList(h.exclude)) {
    out.push('docPilot.html.exclude must be a string or a list of strings')
  }
  if ('sources' in h) {
    if (!isPlain(h.sources)) {
      out.push('docPilot.html.sources must be an object of { content, exclude } by source')
    } else {
      for (const [key, level] of Object.entries(h.sources as Record<string, unknown>)) {
        const at = `docPilot.html.sources[${JSON.stringify(key)}]`
        // A key written as a URL that the allowlist rules refuse (http, a query) would
        // be read as a directory and match nothing: it is named instead.
        if (URL_TARGET.test(key)) {
          const { errors } = parseAllowlist({ allow: [key] })
          if (errors.length) out.push(`${at} is not a valid source URL (https, no query or fragment)`)
        }
        if (!isPlain(level)) {
          out.push(`${at} must be an object holding content and exclude`)
          continue
        }
        const l = level as Record<string, unknown>
        for (const k of Object.keys(l)) {
          if (k !== 'content' && k !== 'exclude') out.push(`${at}.${k} is not a known key (content, exclude)`)
        }
        if ('content' in l && typeof l.content !== 'string') out.push(`${at}.content must be a string`)
        if ('exclude' in l && !isStringList(l.exclude)) {
          out.push(`${at}.exclude must be a string or a list of strings`)
        }
      }
    }
  }
  return out
}
