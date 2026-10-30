/**
 * The one object every HTML path reads (engine-spec 043, D-06, D-21).
 *
 * `docPilot.html = { content?, exclude?, sources?: { [key]: { content?, exclude? } }, fetcher? }`
 * (plan 02-06 validates `fetcher`). `content` is one CSS selector for the page
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

/**
 * The `content` and `exclude` selectors for one target.
 *
 * `target` is the file or URL the page came from; Task 2 of plan 02-03 matches
 * it against `html.sources`. The project level and the flags are enough for a
 * run with no `sources`.
 */
export function htmlOptionsFor(
  html: any,
  target: string,
  { root = process.cwd(), flags = {} }: { root?: string; flags?: HtmlFlags } = {},
): HtmlOptions {
  const levels: { content?: unknown; exclude?: unknown }[] = [flags]
  if (html && typeof html === 'object') levels.push(html)

  let content = ''
  let exclude: string[] = []
  for (const level of levels) {
    if (!content) content = toSelector(level.content)
    if (!exclude.length) exclude = toList(level.exclude)
  }
  return { content, exclude }
}
