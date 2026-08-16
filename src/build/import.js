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
import { pickMain, prune, metadata } from './lib/html-extract.js'
import { toMarkdown } from './lib/html-to-md.js'
import { annotate } from './lib/annotate.js'
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

/** `2026-08-15` and `15 August 2026` from one clock reading. */
export function dates(now) {
  const iso = new Date(now).toISOString().slice(0, 10)
  const human = new Date(now).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  return { iso, human }
}

/**
 * The page contract from `skills/docs-import/SKILL.md`, assembled.
 *
 * The attribution block is not decoration and is not optional. Nobody browses to
 * this file, but `unwrapContainers` keeps container contents in the chunk text,
 * so the provenance travels with the evidence the model reads — and the date is
 * what stops a price copied today from being cited as current in a year.
 */
export function composePage({ title, description, source, markdown, now = Date.now() }) {
  const { iso, human } = dates(now)
  const host = new URL(source).hostname.replace(/^www\./, '')
  const front = [
    '---',
    `title: ${title}`,
    `description: ${description}`,
    `source: ${source}`,
    `importedAt: ${iso}`,
    '---',
  ].join('\n')

  const attribution = [
    '::: info',
    `Imported from [${host}](${source}) on ${human}.`,
    'The original page is the source of truth.',
    ':::',
  ].join('\n')

  return `${front}\n\n# ${title}\n\n${attribution}\n\n${markdown}\n`
}

/**
 * Parse HTML without making linkedom a dependency of every consumer.
 *
 * This package is a docs plugin: the overwhelming majority of installs never run
 * this command, and a DOM implementation in their tree to support one they do
 * not use is exactly the kind of weight that gets a dependency removed. So it is
 * an OPTIONAL peer, imported at the moment it is needed, with the install line
 * in the error rather than in a stack trace.
 */
async function parseDocument(html) {
  let parseHTML
  try {
    ;({ parseHTML } = await import('linkedom'))
  } catch {
    throw new Error(
      'docpilot import needs an HTML parser, which is an optional dependency:\n' +
        '      npm i -D linkedom',
    )
  }
  return parseHTML(html).document
}

/**
 * The page's HTML, from the network or from a file the user already has.
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
  fetchImpl = fetch,
  stdin = process.stdin,
}) {
  if (htmlFile === '-') {
    const chunks = []
    for await (const chunk of stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  if (htmlFile) return fs.readFileSync(htmlFile, 'utf8')

  const res = await fetchImpl(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': `${lang};q=1.0, *;q=0.1`,
    },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(
      `${url} answered ${res.status}. A page behind a bot wall or built by ` +
        'JavaScript will not fetch — open it in a browser, copy the DOM, and ' +
        'pass it with --html <file>.',
    )
  }
  return await res.text()
}

/**
 * The whole pipeline, minus the filesystem and the network.
 *
 * Split out so the suite can drive it end to end: HTML in, the finished file and
 * a report of every decision out. `annotateFn` is injected for the same reason.
 *
 * @param {{html: string, source: string, title?: string, now?: number,
 *   annotateFn?: ((o: {markdown: string, target: any}) => Promise<any>)|null,
 *   target?: any, expectLang?: string,
 *   findMarkdownFn?: ((o: {document: any, source: string}) => Promise<any>)|null}} o
 * @returns {Promise<{file: string, title: string, description: string, scope: string,
 *   pageLang: string, langMismatch: boolean, dropped: {reason: string, text: string}[],
 *   links: string[], annotation: any, from: {kind: string, url: string, tried?: any[]}}>}
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
}) {
  const document = await parseDocument(html)
  const meta = metadata(document)

  /**
   * The published markdown wins, when there is one.
   *
   * It is not a better conversion of the page — it is the file the page was
   * built from, so there is nothing to reconstruct and nothing to lose to a
   * theme. Everything below this branch exists for the sites that publish none.
   */
  const published = findMarkdownFn ? await findMarkdownFn({ document, source }) : null
  if (published?.url) {
    const prepared = prepareMarkdown(published.body, { base: published.url })
    const title = (titleOverride || prepared.title || meta.title || slugFor(source)).trim()
    const description = (prepared.description || meta.description).trim()
    const pageLang = langOf(document)

    let body = prepared.markdown
    let annotation = { only: 0, exclude: 0, added: [], rejected: 'not run' }
    if (annotateFn) {
      annotation = await annotateFn({ markdown: body, target })
      body = annotation.markdown
    }
    return {
      file: composePage({ title, description, source, markdown: body, now }),
      title,
      description,
      scope: 'the page\'s own markdown',
      pageLang,
      langMismatch: mismatched(pageLang, expectLang),
      // Nothing was dropped because nothing was decided: this is the author's
      // own file, not a subtree somebody chose out of a rendered document.
      dropped: [],
      links: [...String(body).matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
      annotation,
      from: { kind: 'markdown', url: published.url, tried: published.tried },
    }
  }

  const root = pickMain(document)
  const dropped = prune(root)
  // Naming the subtree matters as much as naming the drops. Choosing `<main>`
  // silently discards the entire rest of the document, and a report that lists
  // three dropped blocks while a whole column went unread is a report that
  // reads as "it took everything".
  const scope = [
    String(root.tagName || 'body').toLowerCase(),
    root.getAttribute?.('id') ? `#${root.getAttribute('id')}` : '',
  ].join('')
  const { markdown, links } = toMarkdown(root, { origin: source })

  /**
   * The language the page came back in, which is not always the one asked for.
   *
   * Measured on the first live run: `accept-language: en` was sent and the site
   * answered in Ukrainian anyway, because it negotiates on geography rather than
   * on the header. Importing that into an English corpus is a silent failure —
   * every chunk of it retrieves for nothing and the page looks fine in the file
   * — so the mismatch is reported rather than assumed away.
   */
  const pageLang = langOf(document)

  const title = (titleOverride || meta.title || slugFor(source)).trim()
  const description = meta.description.trim()

  let body = markdown
  let annotation = { only: 0, exclude: 0, added: [], rejected: 'not run' }
  if (annotateFn) {
    annotation = await annotateFn({ markdown: body, target })
    body = annotation.markdown
  }

  return {
    file: composePage({ title, description, source, markdown: body, now }),
    title,
    description,
    scope,
    pageLang,
    langMismatch: mismatched(pageLang, expectLang),
    dropped,
    links,
    annotation,
    from: { kind: 'html', url: source, tried: published?.tried || [] },
  }
}

/** `<html lang>`, as a bare subtag. */
const langOf = (document) =>
  String(document.documentElement?.getAttribute?.('lang') || '')
    .toLowerCase()
    .split('-')[0]

const mismatched = (pageLang, expectLang) =>
  !!pageLang && !!expectLang && pageLang !== expectLang.toLowerCase().split('-')[0]

/** Options as the CLI spells them. Unknown flags are an error, never a shrug. */
export function parseImportFlags(argv) {
  const out = { url: '', htmlFile: '', out: '', lang: 'en', annotate: true, alternate: true, dryRun: false, force: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-annotate') out.annotate = false
    else if (a === '--no-alternate') out.alternate = false
    else if (a === '--dry-run' || a === '--dry') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '--html') out.htmlFile = argv[++i] || ''
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
  const flags = parseImportFlags(argv)
  if (flags.unknown.length) {
    log.error(`[docpilot] unknown option: ${flags.unknown.join(', ')}`)
    return 1
  }
  if (!flags.url) {
    log.error(
      '[docpilot] usage: docpilot import <url> [--html <file|->] [--out <slug>]\n' +
        '                              [--lang <tag>] [--no-alternate] [--no-annotate]\n' +
        '                              [--dry-run] [--force]',
    )
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

  let html
  try {
    html = await readHtml({ url: flags.url, htmlFile: flags.htmlFile, lang: flags.lang })
  } catch (e) {
    log.error(`[docpilot] ${e.message}`)
    return 1
  }

  const annotateFn = flags.annotate ? ({ markdown, target }) => annotate({ markdown, target }) : null
  let built
  try {
    const { nodeChatTarget } = await import('../config.js')
    built = await buildPage({
      html,
      source: verdict.href,
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
    log.error(`[docpilot] ${e.message}`)
    return 1
  }

  const slug = flags.out ? flags.out.replace(/\.md$/, '') : slugFor(verdict.href)
  const file = path.join(docPilot.importDir, `${slug}.md`)

  report(log, { built, file, flags })

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

/**
 * What the run decided, printed.
 *
 * A silent extraction reads as "it took everything", which is the impression the
 * skill's own rule about silent caps exists to prevent. So the drops are named —
 * the five largest, with the count of the rest — and so is every annotation the
 * model added, because that text is going into the corpus as documentation and
 * a reader is meant to check it.
 */
function report(log, { built, file, flags }) {
  const { dropped, annotation } = built
  log.log(`\n[docpilot] import ${file}`)
  log.log(`  title        ${built.title}`)
  log.log(
    `  description  ${built.description || 'NONE — the page publishes no meta description. Write one: it is the strongest dense lever the corpus has.'}`,
  )
  log.log(`  body         ${built.file.split('\n').length} lines · ${built.links.length} links`)
  if (built.from.kind === 'markdown') {
    log.log(`  read         ${built.from.url}`)
    log.log('               the page\'s OWN markdown — nothing was converted or dropped')
  } else {
    log.log(`  read         <${built.scope}> — nothing outside it was read`)
    for (const t of built.from.tried || []) log.log(`               no .md at ${t.url} (${t.why})`)
  }
  if (built.langMismatch) {
    log.log(
      `  LANGUAGE     the page came back in "${built.pageLang}", not "${flags.lang}".\n` +
        '               Many sites negotiate on geography, not on the header. A page in\n' +
        "               the wrong language retrieves for nothing — open the site's own\n" +
        '               URL for your language, or pass the DOM with --html <file>.',
    )
  }

  if (dropped.length) {
    log.log(`  dropped      ${dropped.length} blocks:`)
    for (const d of dropped.slice(0, 5)) {
      log.log(`               ${d.reason.padEnd(22)} "${d.text.slice(0, 60)}${d.text.length > 60 ? '…' : ''}"`)
    }
    if (dropped.length > 5) log.log(`               …and ${dropped.length - 5} more`)
  }

  if (!flags.annotate) {
    log.log('  annotation   skipped (--no-annotate)')
    return
  }
  if (annotation.rejected) {
    log.log(`  annotation   REJECTED — ${annotation.rejected}`)
    if (annotation.detail?.was) {
      log.log(`               line ${annotation.detail.line}: "${annotation.detail.was}"`)
      log.log(`               became  "${annotation.detail.now}"`)
    }
    log.log('               the page was written exactly as converted.')
    return
  }
  log.log(`  annotation   ${annotation.only} <llm-only> · ${annotation.exclude} <llm-exclude>`)
  for (const added of annotation.added) {
    log.log(`               + ${added.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  if (annotation.added.length) {
    log.log('               ^ shown to readers and cited as documentation — check it.')
  }
}
