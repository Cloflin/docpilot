/**
 * A site that is already built is a corpus — RAG-SPEC 2.1.
 *
 * `docpilot index` walks markdown, and markdown is what a VitePress or
 * Docusaurus project has. Every other static generator — Hugo, Jekyll, MkDocs,
 * Astro, Next, Nuxt — and every server-rendered help centre has something else:
 * a directory of HTML it just produced. Until this file, the only way any of
 * that reached the corpus was `docpilot import <url>`, one page at a time,
 * through the network, past an allowlist, with a model annotating the result.
 *
 * NOTHING HERE PARSES HTML. The extractor (`html-extract.js`), the serialiser
 * (`html-to-md.js`) and the parser loader (`dom.js`) were written for `import`
 * and are used verbatim. What is genuinely new is two things: walking a
 * directory, and turning a file path into the route the page is served at. Both
 * are small, and both are the parts that would otherwise be written a second
 * time inside the indexer.
 *
 * A PAGE FOUND HERE IS A PAGE OF THIS SITE. It is cited by its route, exactly
 * like a markdown page, and carries no `origin` — the file came out of the
 * consumer's own build, so there is no external source for a citation to point
 * at and no allowlist question to answer. That is the whole reason the local
 * path needs no `sources.allow` entry while `import` does.
 */

import fs from 'node:fs'
import path from 'node:path'

import { parseDocument } from './dom.js'
import { pickMain, prune, metadata } from './html-extract.js'
import { toMarkdown } from './html-to-md.js'
import { routeOf } from '../../theme/docpilot/route.js'

/**
 * Directories a built site puts beside its pages that are never pages.
 *
 * Named rather than scored, because the cost of the two mistakes is not
 * symmetric: a missed asset directory costs a slow walk, and an asset directory
 * read as pages costs chunks of minified nothing sitting in the index at full
 * weight.
 */
const SKIP_DIRS = new Set(['assets', 'static', '_next', '_astro', 'node_modules', '.git'])

/** The default sink for a warning nobody passed a reporter for. */
const NO_WARN = (_message: string) => {}

/** Every `.html` under `dir`, in a stable order so two builds agree. */
export function walkHtml(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkHtml(p, acc)
    } else if (/\.html?$/.test(entry.name)) {
      acc.push(p)
    }
  }
  return acc
}

/**
 * The route a built file is served at.
 *
 * `routeOf` is the shared rule and knows `.html` for exactly this caller —
 * see the comment on it for why the extension list lives there rather than here.
 */
export function routeForHtml(dir, file) {
  return routeOf(path.relative(dir, file))
}

/**
 * The routes a `sitemap.xml` declares, as paths.
 *
 * Read as a FILTER, never as a source of URLs to fetch. A built directory holds
 * more than the site publishes — 404 pages, drafts a generator left behind,
 * per-tag listing pages — and the sitemap is the file that already states which
 * of them are real. Using it this way needs no network and no allowlist, which
 * is the only reason it can be a flag rather than a subcommand.
 *
 * Deliberately a regex and not an XML parser: `<loc>` is the one element that
 * matters, sitemaps are machine-written, and a second optional dependency for
 * one tag is a worse trade than a missed exotic encoding.
 */
export function sitemapRoutes(xml) {
  const out = new Set()
  for (const m of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    let p = m[1]
    try {
      p = new URL(p).pathname
    } catch {
      // A relative <loc> is not legal, but it is written, and it is already the
      // shape this function wants.
    }
    // `routeOf` takes a path RELATIVE to a root and prepends the slash itself,
    // which is why the leading one is stripped here rather than passed through:
    // handing it `/guide` produced `//guide`, an id no page in the manifest has,
    // and a sitemap filter that silently matched nothing at all.
    out.add(routeOf(p.replace(/^\/+/, '').replace(/\/+$/, '')))
  }
  return out
}

/**
 * The page body of one file, as markdown, or null if there is nothing in it.
 *
 * `--html-select` overrides `pickMain` and does NOT fall back to it silently: a
 * selector that matches nothing is a typo in a flag the consumer typed, and
 * quietly indexing whatever the scorer picked instead would answer a different
 * question than the one they asked. It warns, and skips the page.
 */
export async function pageFromHtml(html, { select = '', base = '', warn = NO_WARN, id = '' } = {}) {
  const document = await parseDocument(html)
  const meta = metadata(document)

  let root
  if (select) {
    root = document.querySelector(select)
    if (!root) {
      warn(`--html-select "${select}" matched nothing in ${id}`)
      return null
    }
  } else {
    root = pickMain(document)
  }

  prune(root)
  const { markdown } = toMarkdown(root, { origin: base })
  if (!markdown.trim()) return null

  const title = meta.title || ''
  // Assembled the way an imported page is: one `#` title, the page's own
  // description under it, then the body at `##` and below. The description is
  // not decoration — it is the strongest dense signal a page has about itself,
  // and it belongs in the chunk that carries the title.
  const src = [title ? `# ${title}` : '', meta.description || '', markdown]
    .filter(Boolean)
    .join('\n\n')

  return { src, title }
}

/**
 * Every page of a built directory, ready for the chunker.
 *
 * Returns records rather than chunks: what `kind` a route gets, which routes are
 * excluded and what happens on a collision are the indexer's decisions, and this
 * file has no business holding a second copy of any of them.
 *
 * @returns {Promise<Array<{ route: string, file: string, src: string, title: string }>>}
 */
export async function readHtmlDir({ dir, select = '', base = '', sitemap = '', warn = NO_WARN }) {
  if (!fs.existsSync(dir)) {
    throw new Error(`--html-dir "${dir}" does not exist`)
  }

  const only = sitemap ? sitemapRoutes(fs.readFileSync(sitemap, 'utf8')) : null
  if (only && !only.size) warn(`sitemap ${sitemap} declares no <loc> — nothing will be indexed from ${dir}`)

  const out = []
  const seen = new Map()

  for (const file of walkHtml(dir)) {
    const route = routeForHtml(dir, file)
    if (only && !only.has(route)) continue

    // `/guide/index.html` and `/guide.html` are both `/guide`, and a generator
    // that writes both — several do, for trailing-slash compatibility — would
    // otherwise index the same page twice under one id and kill the build on a
    // duplicate chunk id, several hundred lines away from the cause.
    const first = seen.get(route)
    if (first) {
      warn(`two files claim ${route}: ${path.relative(dir, first)} and ${path.relative(dir, file)} — the second is skipped`)
      continue
    }
    seen.set(route, file)

    const page = await pageFromHtml(fs.readFileSync(file, 'utf8'), {
      select,
      base,
      warn,
      id: path.relative(dir, file),
    })
    if (!page) continue

    out.push({ route, file, src: page.src, title: page.title })
  }

  return out
}
