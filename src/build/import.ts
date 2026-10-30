/**
 * `docpilot import <url>` — an external page, turned into a page of this corpus.
 *
 * The order is the whole design: the ALLOWLIST runs before the network does, the
 * conversion runs in code, and the model runs last and may only annotate. Each
 * step is refusable on its own, and the two that can put text into the corpus —
 * the converter and the annotation pass — are the two that are tested.
 *
 *   allowlist → fetch (or a pasted DOM) → extract → markdown → frontmatter
 *             → annotate → write
 *
 * WHAT THIS REPLACES is a 200-line contract carried out by reading the page,
 * which is fine for one page and unrepeatable across forty. What it does NOT
 * replace is the judgement at the end — see annotate.js — or the gates after it:
 * `index --dry`, `lint`, `eval --gate-only`, `calibrate`. An import changes the
 * corpus hash, and the eval is what says whether it changed it for the better.
 */

import fs from 'node:fs'
import path from 'node:path'

import { parseAllowlist, checkSource } from './lib/sources.js'
import { fetchWithin } from './lib/redirects.js'
import { DeadlineExceeded, FETCH_TIMEOUT_MS, readBodyCapped, withDeadline } from './lib/fetch-bounds.js'
import { printable, printableLines } from './lib/terminal.js'
import { metadata, robotsNoindex } from './lib/html-extract.js'
import { extractDocument, EXTRACTOR_VERSION, MAX_HTML_BYTES } from './lib/extract-html.js'
import { formatExtractionReport, rowFromResults } from './lib/extraction-report.js'
import { parseDocument } from './lib/dom.js'
import { annotate } from './lib/annotate.js'
import type { Annotation } from './lib/annotate.js'
import { htmlConfigProblems, htmlOptionsFor } from './lib/html-options.js'
import { flagErrors, spaceFormWarning } from '../cli-flags.js'
import { USAGE } from '../cli-exit.js'
import {
  canonicalOf,
  declaredAlternates,
  derivedCandidates,
  findMarkdown,
  prepareMarkdown,
} from './lib/markdown-alternate.js'

/**
 * A user agent that says what this is.
 *
 * Not a browser string. A site that would rather not be read by a tool is
 * entitled to say so, and it can only do that if the tool identifies itself.
 */
const UA = 'docpilot-import (+https://github.com/cloflin/docpilot)'

/** `https://example.com/help/rate-limits?x=1` → `rate-limits`. */
export function slugFor(url) {
  const { pathname, hostname } = new URL(url)
  const last = pathname.split('/').filter(Boolean).pop() || hostname
  return (
    last
      .replace(/\.(html?|php|aspx?)$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'imported-page'
  )
}

/**
 * English month names, spelled out here. `toLocaleDateString` formats through
 * the runtime's ICU data, which differs between Node builds, so the attribution
 * text could differ with the machine that ran the import (engine-spec 043, F-14).
 */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `2026-08-15` and `15 August 2026` from one clock reading. */
export function dates(now) {
  const when = new Date(now)
  const iso = when.toISOString().slice(0, 10)
  // Both readings are UTC. `toISOString` always is, and so are the `getUTC*`
  // reads below; a local-zone read would print the same instant as two
  // different days depending on who ran the import — and the attribution line
  // could disagree with the `importedAt` key three lines above it.
  const human = `${when.getUTCDate()} ${MONTH_NAMES[when.getUTCMonth()]} ${when.getUTCFullYear()}`
  return { iso, human }
}

/**
 * One frontmatter value, safe to put after a `key:`.
 *
 * `title` and `description` come off the imported page — `og:title`, `<h1>`, a
 * meta tag — and were being written raw. A newline in either one opens a new
 * frontmatter line, which is enough to inject any key at all: a forged `source:`
 * wins, because the provenance parser takes the first `^source:` it finds, and
 * the page then claims to have come from somewhere it did not. A bare `---`
 * closes the block early, and an ordinary colon in a title is enough to make the
 * YAML unparseable without anyone attacking anything.
 *
 * Quoted rather than stripped, so titles keep their punctuation.
 */
const yamlValue = (v) =>
  JSON.stringify(
    String(v ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
  )

/**
 * The page contract from `skills/docs-import/SKILL.md`, assembled.
 *
 * The attribution block is not decoration and is not optional. Nobody browses to
 * this file, but `unwrapContainers` keeps container contents in the chunk text,
 * so the provenance travels with the evidence the model reads — and the date is
 * what stops a price copied today from being cited as current in a year.
 */
export function composePage({
  title,
  description,
  source,
  markdown,
  now = Date.now(),
  lang = '',
  dateModified = '',
}) {
  const { iso, human } = dates(now)
  const host = new URL(source).hostname.replace(/^www\./, '')
  // The same collapsed title goes into the `#` heading below: a newline there
  // would end the heading and turn the rest of the title into body text.
  const oneLineTitle = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const front = [
    '---',
    `title: ${yamlValue(oneLineTitle)}`,
    `description: ${yamlValue(description)}`,
    `source: ${yamlValue(source)}`,
    `importedAt: ${iso}`,
    // The stamp is what `index` and `doctor` read to name an import made by an
    // older extractor (engine-spec 043, D-05). It is an integer constant, so it
    // needs no quoting, and it is front matter, not body: the corpus hash of an
    // import changes only when the Markdown does (D-26).
    `extractor: ${EXTRACTOR_VERSION}`,
    // The page's own words about itself, quoted like the title (T-02-15).
    ...(lang ? [`lang: ${yamlValue(lang)}`] : []),
    ...(dateModified ? [`dateModified: ${yamlValue(dateModified)}`] : []),
    '---',
  ].join('\n')

  const attribution = [
    '::: info',
    `Imported from [${host}](${source}) on ${human}.`,
    'The original page is the source of truth.',
    ':::',
  ].join('\n')

  return `${front}\n\n# ${oneLineTitle}\n\n${attribution}\n\n${markdown}\n`
}

/** Re-exported: the deadline lives with the other fetch bounds. */
export { FETCH_TIMEOUT_MS }

/** The refusal shared by a redirect and a fetcher result outside the allowlist. */
const OUTSIDE_ALLOWLIST_HINT =
  '      Add that origin deliberately, or import the final URL directly.'

/** Header names lowercased, so `X-Robots-Tag` and `x-robots-tag` are one key. */
const lowerKeys = (headers) =>
  Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]))

/**
 * `work` under the shared deadline (`withDeadline`), with the sentence an owner
 * can act on when it passes: the page is behind a wall, and the way round it is
 * `--html` or a fetcher.
 */
async function withTimeout(url, timeoutMs, work): Promise<any> {
  try {
    return await withDeadline(timeoutMs, work)
  } catch (e) {
    if (e instanceof DeadlineExceeded) {
      throw new Error(
        `${url} did not answer within ${timeoutMs} ms. A page behind a bot wall or built by ` +
          'JavaScript will not fetch — open it in a browser, copy the DOM, and pass it ' +
          'with --html <file>, or give docPilot.html.fetcher.',
      )
    }
    throw e
  }
}

/**
 * The page's HTML, from a file, from the owner's fetcher or from the network.
 *
 * Returns `{ html, url, headers }`: `url` is where the body came from and
 * `headers` the response headers that matter to the extractor (lowercased keys),
 * or null for a file or stdin. The order is `--html`, then `docPilot.html.fetcher`
 * (D-09: a renderer for a page that only exists in a browser), then the built-in
 * fetch.
 *
 * `accept-language` is sent and defaults to English, because a marketing site
 * negotiates on it and will happily answer in the language of whoever is
 * running the command — measured: the first live run of this pipeline imported
 * a Ukrainian page into an English corpus, where its every chunk retrieves for
 * nothing. `--lang` sets it for a corpus in another language.
 */
export async function readHtml({
  url,
  htmlFile,
  lang = 'en',
  allow = null,
  fetchImpl = fetch,
  fetcher = null,
  stdin = process.stdin,
  timeoutMs = FETCH_TIMEOUT_MS,
}: {
  url: string
  htmlFile?: string
  lang?: string
  allow?: ((u: string) => any) | null
  fetchImpl?: any
  fetcher?: ((url: string, init: { signal: AbortSignal }) => any) | null
  stdin?: any
  timeoutMs?: number
}): Promise<{ html: string; url: string; headers: Record<string, string> | null }> {
  if (htmlFile === '-') {
    const chunks = []
    for await (const chunk of stdin) chunks.push(chunk)
    return { html: Buffer.concat(chunks).toString('utf8'), url, headers: null }
  }
  if (htmlFile) return { html: fs.readFileSync(htmlFile, 'utf8'), url, headers: null }

  if (fetcher) {
    const result = await withTimeout(url, timeoutMs, (signal) => fetcher(url, { signal }))
    let got
    if (typeof result === 'string') {
      got = { html: result, url, headers: null }
    } else if (result && typeof result === 'object' && typeof result.html === 'string') {
      got = {
        html: result.html,
        url: typeof result.url === 'string' && result.url ? result.url : url,
        headers: result.headers ? lowerKeys(result.headers) : null,
      }
    } else {
      throw new Error(`the fetcher returned neither a string nor { html } for ${url}`)
    }
    // The owner's code ran, but the page and the URL it names came off a
    // network. The returned URL passes the same boundary a redirect does
    // (D-29, T-02-11); `source:` stays the URL the user asked for.
    if (allow && got.url !== url && 'error' in allow(got.url)) {
      throw new Error(
        `${url}: the fetcher returned ${got.url}, which is outside docPilot.sources.allow.\n${OUTSIDE_ALLOWLIST_HINT}`,
      )
    }
    return got
  }

  // The allowlist checked the URL the user typed. An allowed origin that
  // redirects — to plain http, to another host, or to something on the internal
  // network of whatever machine is running the import — must not get that
  // request sent at all, so every hop is checked BEFORE it is requested, not
  // after the runtime has followed it.
  return await withTimeout(url, timeoutMs, async (signal) => {
    const { res, refused } = await fetchWithin(url, {
      allow,
      fetchImpl,
      init: {
        signal,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': `${lang};q=1.0, *;q=0.1`,
        },
      },
    })
    if (refused) {
      throw new Error(`${url} redirected to ${refused}, which is outside docPilot.sources.allow.\n${OUTSIDE_ALLOWLIST_HINT}`)
    }
    if (!res.ok) {
      throw new Error(
        `${url} answered ${res.status}. A page behind a bot wall or built by ` +
          'JavaScript will not fetch — open it in a browser, copy the DOM, and ' +
          'pass it with --html <file>.',
      )
    }
    const robots = res.headers?.get?.('x-robots-tag')
    // Counted while it is read: `res.text()` would hold a data dump in memory
    // before `buildPage` could call it too large.
    const body = await readBodyCapped(res)
    if ('tooLarge' in body) {
      throw new Error(
        `${url} is too large: more than ${MAX_HTML_BYTES} bytes. A page that size is a data dump, ` +
          'not documentation — import a smaller page, or pass the part you want with --html <file>.',
      )
    }
    return {
      html: body.text,
      url,
      headers: robots ? { 'x-robots-tag': String(robots) } : {},
    }
  })
}

/**
 * The whole pipeline, minus the filesystem and the network.
 *
 * Split out so the suite can drive it end to end: HTML in, the finished file and
 * a report of every decision out. `annotateFn` is injected for the same reason.
 *
 * The HTML branch is `extractDocument`, the one extractor `index --html-dir`
 * runs too (engine-spec 043, D-06): this file holds no rule list of its own. A
 * page that gives nothing (noindex, near-empty, too large, a selector that
 * matches nothing) comes back as `{ skipped, extraction }` with no `file`.
 *
 * @param {{html: string, source: string, title?: string, now?: number,
 *   annotateFn?: ((o: {markdown: string, target: any}) => Promise<any>)|null,
 *   target?: any, expectLang?: string,
 *   findMarkdownFn?: ((o: {document: any, source: string}) => Promise<any>)|null,
 *   content?: string, exclude?: string|string[], robots?: string}} o
 */
export async function buildPage({
  html,
  source,
  title: titleOverride = '',
  now = Date.now(),
  annotateFn = null,
  target = null,
  expectLang = 'en',
  findMarkdownFn = null,
  content = '',
  exclude = [],
  robots = '',
}): Promise<any> {
  const from = { kind: 'html', url: source, tried: [] as any[] }
  const skip = (reason: string, extraction: any = null, meta: any = {}) => ({
    skipped: reason,
    extraction: extraction || { ok: false, reason, report: emptyReport() },
    title: meta.title || '',
    description: meta.description || '',
    from,
  })

  // Counted before the parse, because the parse is what a huge page would cost.
  const bytes = Buffer.byteLength(String(html), 'utf8')
  if (bytes > MAX_HTML_BYTES) return skip(`too large (${bytes} bytes)`)

  const document = await parseDocument(html)
  const meta = metadata(document)

  /**
   * The published markdown wins, when there is one.
   *
   * It is not a better conversion of the page — it is the file the page was
   * built from, so there is nothing to reconstruct and nothing to lose to a
   * theme. Everything below this branch exists for the sites that publish none.
   *
   * A page that asked not to be indexed never gets this far: whatever else it
   * publishes, it said no, and `extractDocument` below reports it (D-27).
   */
  const noindex = meta.noindex || robotsNoindex(robots)
  const published = findMarkdownFn && !noindex ? await findMarkdownFn({ document, source }) : null
  if (published?.url) {
    let degraded = 0
    const prepared = prepareMarkdown(published.body, {
      base: published.url,
      onDegrade: () => degraded++,
    })
    const title = (titleOverride || prepared.title || meta.title || slugFor(source)).trim()
    const description = (prepared.description || meta.description).trim()
    const pageLang = meta.lang

    let body = prepared.markdown
    let annotation: Annotation = { only: 0, exclude: 0, added: [], rejected: 'not run' }
    if (annotateFn) {
      annotation = await annotateFn({ markdown: body, target })
      body = annotation.markdown
    }
    const kept = [...String(body).replace(/\s+/g, ' ').trim()].length
    const extraction = {
      ok: true,
      reason: '',
      // Nothing was dropped because nothing was decided: this is the author's
      // own file, not a subtree somebody chose out of a rendered document.
      report: { ...emptyReport(), totalChars: kept, keptChars: kept, linksDegraded: degraded },
    }
    if (degraded) {
      extraction.report.warnings.push(
        `${degraded} link(s) in ${published.url} could not be made absolute and became text`,
      )
    }
    return {
      file: composePage({
        title,
        description,
        source,
        markdown: body,
        now,
        lang: pageLang,
        dateModified: meta.dateModified || '',
      }),
      title,
      description,
      scope: 'the page\'s own markdown',
      pageLang,
      langMismatch: mismatched(pageLang, expectLang),
      dropped: [],
      links: [...String(body).matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
      annotation,
      extraction,
      from: { kind: 'markdown', url: published.url, tried: published.tried },
    }
  }

  const result = extractDocument(document, { content, exclude, base: source, id: source, robots })
  if (!result.ok) return skip(result.reason, result, result)

  /**
   * The language the page came back in, which is not always the one asked for.
   *
   * Measured on the first live run: `accept-language: en` was sent and the site
   * answered in Ukrainian anyway, because it negotiates on geography rather than
   * on the header. Importing that into an English corpus is a silent failure —
   * every chunk of it retrieves for nothing and the page looks fine in the file
   * — so the mismatch is reported rather than assumed away.
   */
  const pageLang = result.lang

  const title = (titleOverride || result.title || slugFor(source)).trim()
  const description = result.description.trim()

  let body = result.markdown
  let annotation: Annotation = { only: 0, exclude: 0, added: [], rejected: 'not run' }
  if (annotateFn) {
    annotation = await annotateFn({ markdown: body, target })
    body = annotation.markdown
  }

  return {
    file: composePage({
      title,
      description,
      source,
      markdown: body,
      now,
      lang: pageLang,
      dateModified: result.dateModified || '',
    }),
    title,
    description,
    scope: result.scope,
    pageLang,
    langMismatch: mismatched(pageLang, expectLang),
    dropped: result.report.dropped,
    links: result.links,
    annotation,
    extraction: result,
    from: { kind: 'html', url: source, tried: published?.tried || [] },
  }
}

/** A report with nothing in it, for a page skipped before it was read. */
const emptyReport = () => ({
  totalChars: 0,
  keptChars: 0,
  droppedChars: 0,
  dropped: [],
  linksResolved: 0,
  linksDegraded: 0,
  warnings: [] as string[],
})

const mismatched = (pageLang, expectLang) =>
  !!pageLang && !!expectLang && pageLang !== expectLang.toLowerCase().split('-')[0]

/** Options as the CLI spells them. Unknown flags are an error, never a shrug. */
export function parseImportFlags(argv) {
  const out = { url: '', htmlFile: '', htmlSelect: '', htmlExclude: '', out: '', lang: 'en', annotate: true, alternate: true, dryRun: false, force: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-annotate') out.annotate = false
    else if (a === '--no-alternate') out.alternate = false
    else if (a === '--dry-run' || a === '--dry') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '--html') out.htmlFile = argv[++i] || ''
    else if (a === '--html-select') out.htmlSelect = argv[++i] || ''
    else if (a === '--html-exclude') out.htmlExclude = argv[++i] || ''
    else if (a.startsWith('--html-select=')) out.htmlSelect = a.slice(14)
    else if (a.startsWith('--html-exclude=')) out.htmlExclude = a.slice(15)
    else if (a === '--out') out.out = argv[++i] || ''
    else if (a === '--lang') out.lang = argv[++i] || 'en'
    else if (a.startsWith('--lang=')) out.lang = a.slice(7)
    else if (a.startsWith('--html=')) out.htmlFile = a.slice(7)
    else if (a.startsWith('--out=')) out.out = a.slice(6)
    else if (a.startsWith('-')) out.unknown.push(a)
    else if (!out.url) out.url = a
    else out.unknown.push(a)
  }
  return out
}

/**
 * The command. Returns an exit code rather than calling `process.exit`, so the
 * suite can run it and the CLI stays the only place that decides to die.
 *
 * @param {object} o
 * @param {any} o.docPilot resolved settings
 * @param {string[]} o.argv everything after `import`
 * @param {object} [o.env]
 * @param {Console} [o.log]
 */
export async function runImport({ docPilot, argv, env = process.env, log = console }) {
  // First, and before the URL is fetched or the model is called: a typo in a
  // flag used to be dropped in silence, and `--out --force` used to mean
  // `out === '--force'` while eating the `--force`.
  const [bad] = flagErrors('import', argv)
  if (bad) {
    log.error(`[docpilot] ${bad}`)
    return USAGE
  }
  const spaceForm = spaceFormWarning('import', argv)
  if (spaceForm) log.error(`[docpilot] ${spaceForm}`)

  const flags = parseImportFlags(argv)
  if (flags.unknown.length) {
    log.error(`[docpilot] unknown option: ${flags.unknown.join(', ')}`)
    return USAGE
  }
  if (!flags.url) {
    log.error(
      '[docpilot] usage: docpilot import <url> [--html <file|->] [--out <slug>]\n' +
        '                              [--html-select <css>] [--html-exclude <css>]\n' +
        '                              [--lang <tag>] [--no-alternate] [--no-annotate]\n' +
        '                              [--dry-run] [--force]',
    )
    return 1
  }

  // A typo in docPilot.html must not quietly change what an import keeps, so the
  // config is checked before the allowlist and long before any request.
  const htmlProblems = htmlConfigProblems(docPilot.html)
  if (htmlProblems.length) {
    for (const problem of htmlProblems) log.error(`[docpilot] ${problem}`)
    return 1
  }

  if (!docPilot.importDir) {
    log.error(
      '[docpilot] importDir is not set, so this project imports nothing.\n\n' +
        '  An imported page is corpus, not a page of your site, so it lives in a\n' +
        '  directory OUTSIDE docsDir:\n\n' +
        "    export const docPilot = { importDir: 'knowledge-base', sources: { allow: [...] } }\n",
    )
    return 1
  }

  // The allowlist runs BEFORE the network. Fetching a page and then refusing it
  // has already done the thing the list exists to control.
  const { entries, errors } = parseAllowlist(docPilot.sources)
  for (const e of errors) log.error(`[docpilot] sources.allow: ${e}`)
  const verdict = checkSource(flags.url, entries)
  if ('error' in verdict) {
    log.error(
      `[docpilot] ${flags.url} is not importable: ${verdict.error}\n\n` +
        '  The allowlist is a security boundary, not a preference — its value\n' +
        '  becomes an href rendered inside the answer panel. To import this page,\n' +
        '  add its origin deliberately:\n\n' +
        `    sources: { allow: ['${originOf(flags.url)}'] }\n`,
    )
    return 1
  }

  let fetched
  try {
    fetched = await readHtml({
      url: flags.url,
      htmlFile: flags.htmlFile,
      lang: flags.lang,
      allow: (u) => checkSource(u, entries),
      fetcher: docPilot.html?.fetcher ?? null,
    })
  } catch (e) {
    log.error(`[docpilot] ${printableLines(e.message)}`)
    return 1
  }

  const annotateFn = flags.annotate ? ({ markdown, target }) => annotate({ markdown, target }) : null
  let built
  // The selectors this run resolved (flags, then config), kept for the report.
  let selectors: { content: string; exclude: string[] } = { content: '', exclude: [] }
  try {
    const { nodeChatTarget } = await import('../config.js')
    const { content, exclude } = htmlOptionsFor(docPilot.html, verdict.href, {
      root: process.cwd(),
      flags: { content: flags.htmlSelect, exclude: flags.htmlExclude },
    })
    selectors = { content, exclude }
    built = await buildPage({
      html: fetched.html,
      source: verdict.href,
      content,
      exclude,
      // The header the page was served with applies like its robots meta (D-27).
      robots: fetched.headers?.['x-robots-tag'] ?? '',
      /**
       * A candidate `.md` is a URL this tool decided to request, so it crosses
       * the same boundary the one the user typed did. The allowlist is checked
       * per candidate, not once for the page.
       */
      findMarkdownFn: flags.alternate
        ? ({ document, source }) => {
            const canonical = canonicalOf(document, source)
            const urls = [...declaredAlternates(document, source), ...derivedCandidates(canonical)]
            return findMarkdown({
              urls: [...new Set(urls)],
              allow: (u) => checkSource(u, entries),
              fetchImpl: fetch,
              headers: { 'user-agent': UA, accept: 'text/markdown, text/plain' },
            })
          }
        : null,
      annotateFn,
      target: flags.annotate ? nodeChatTarget(docPilot, env) : null,
      expectLang: flags.lang,
    })
  } catch (e) {
    log.error(`[docpilot] ${printableLines(e.message)}`)
    return 1
  }

  const slug = flags.out ? flags.out.replace(/\.md$/, '') : slugFor(verdict.href)
  const file = path.join(docPilot.importDir, `${slug}.md`)

  if (built.skipped) {
    // D-11: no page was extracted, so there is nothing to write and the exit is
    // non-zero. The table still prints, with its row of 0 pages and the reason.
    printExtraction(log, verdict.href, built.extraction)
    log.error(`[docpilot] nothing to import: ${printable(built.skipped)}`)
    return 1
  }

  report(log, { built, file, flags, source: verdict.href, selectors })

  if (flags.dryRun) {
    log.log('\n  --dry-run: nothing was written.\n')
    return 0
  }
  if (fs.existsSync(file) && !flags.force) {
    log.error(`[docpilot] ${file} already exists. Pass --force to replace it, or --out <slug>.`)
    return 1
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, built.file)
  log.log(`\n  wrote ${file}\n`)
  log.log(
    '  Then, in this order:\n' +
      '    npx docpilot index --dry    chunking, duplicate titles, dead internal links\n' +
      '    npx docpilot index\n' +
      '    npx docpilot lint && npx docpilot eval --gate-only\n' +
      '    npx docpilot calibrate      the index hash moved\n',
  )
  return 0
}

const originOf = (url) => {
  try {
    return new URL(url).origin
  } catch {
    return 'https://example.com'
  }
}

/** The extraction table, then the page's warnings (D-13). */
function printExtraction(log, source, extraction) {
  for (const line of formatExtractionReport([rowFromResults(source, [{ id: source, result: extraction }])])) {
    log.log(`  ${line}`)
  }
  for (const w of extraction.report.warnings) log.error(`[docpilot] ${printableLines(w)}`)
}

/**
 * What the run decided, printed.
 *
 * A silent extraction reads as "it took everything", which is the impression the
 * skill's own rule about silent caps exists to prevent. So the drops are named —
 * the five largest, with the count of the rest — and so is every annotation the
 * model added, because that text is going into the corpus as documentation and
 * a reader is meant to check it.
 */
function report(log, { built, file, flags, source, selectors }) {
  const { dropped, annotation } = built
  // Every field below except the counts came off the remote page or out of the
  // model, so each one goes through `printable` — see lib/terminal.ts.
  const p = printable
  log.log(`\n[docpilot] import ${file}`)
  log.log(`  title        ${p(built.title)}`)
  log.log(
    `  description  ${p(built.description) || 'NONE — the page publishes no meta description. Write one: it is the strongest dense lever the corpus has.'}`,
  )
  log.log(`  body         ${built.file.split('\n').length} lines · ${built.links.length} links`)
  if (built.from.kind === 'markdown') {
    log.log(`  read         ${p(built.from.url)}`)
    log.log('               the page\'s OWN markdown — nothing was converted or dropped')
    // A selector picks a subtree of rendered HTML, and there is no HTML here. Said
    // once, so an owner who passed one is not left reading "nothing dropped" as
    // "the selector matched everything" (engine-spec 043, IN-01).
    const set = [
      selectors?.content ? `content selector "${p(selectors.content)}"` : '',
      selectors?.exclude?.length ? `exclude selector "${p(selectors.exclude.join(', '))}"` : '',
    ].filter(Boolean)
    if (set.length) {
      log.error(
        `[docpilot] ${set.join(' and ')} not applied: the page's own markdown was used, and a selector reads HTML. ` +
          'Pass --no-alternate to extract the HTML with it.',
      )
    }
  } else {
    log.log(`  read         <${built.scope}> — nothing outside it was read`)
    for (const t of built.from.tried || []) log.log(`               no .md at ${p(t.url)} (${p(t.why)})`)
  }
  if (built.langMismatch) {
    log.log(
      `  LANGUAGE     the page came back in "${p(built.pageLang)}", not "${p(flags.lang)}".\n` +
        '               Many sites negotiate on geography, not on the header. A page in\n' +
        "               the wrong language retrieves for nothing — open the site's own\n" +
        '               URL for your language, or pass the DOM with --html <file>.',
    )
  }

  if (dropped.length) {
    log.log(`  dropped      ${dropped.length} blocks:`)
    for (const d of dropped.slice(0, 5)) {
      log.log(`               ${p(d.reason).padEnd(22)} "${p(d.text.slice(0, 60))}${d.text.length > 60 ? '…' : ''}"`)
    }
    if (dropped.length > 5) log.log(`               …and ${dropped.length - 5} more`)
  }

  printExtraction(log, source, built.extraction)

  if (!flags.annotate) {
    log.log('  annotation   skipped (--no-annotate)')
    return
  }
  if (annotation.rejected) {
    log.log(`  annotation   REJECTED — ${printableLines(annotation.rejected)}`)
    if (annotation.detail?.was) {
      log.log(`               line ${annotation.detail.line}: "${p(annotation.detail.was)}"`)
      log.log(`               became  "${p(annotation.detail.now)}"`)
    }
    log.log('               the page was written exactly as converted.')
    return
  }
  log.log(`  annotation   ${annotation.only} <llm-only> · ${annotation.exclude} <llm-exclude>`)
  for (const added of annotation.added) {
    log.log(`               + ${p(added.replace(/\s+/g, ' ').slice(0, 90))}`)
  }
  if (annotation.added.length) {
    log.log('               ^ shown to readers and cited as documentation — check it.')
  }
}
