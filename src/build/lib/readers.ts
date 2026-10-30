/**
 * File readers — engine-spec 041, D-08.
 *
 * A reader turns files into `ReadDoc`s and does nothing else: no chunking, no
 * embedding, no network. `documentsToChunks` (documents.ts) is the one stage
 * that turns documents into chunks, so a source has exactly one way into the
 * index and a connector (Phase 3) writes snapshot files these same readers read
 * instead of growing a fifth path.
 *
 * Readers emit documents in the order the builder has always indexed them, and
 * the pipeline keeps it: the order is part of the bytes, because a chunk's
 * position decides the shard it lands in.
 */

import fs from 'node:fs'
import path from 'node:path'

import { splitFrontmatter } from './normalise.js'
import { readHtmlDir } from './html-dir.js'
import { htmlOptionsFor } from './html-options.js'
import { specFiles } from './openapi-chunker.js'
import { routeOf } from '../../theme/docpilot/route.js'
import type { ReadDoc } from './source-doc.js'

/**
 * `normaliseMarkdown` drops a leading U+FEFF before it looks for the `---`
 * fence, because the mark hides it. A reader that reads front matter must see
 * the same title and `source:` the chunker sees, so it drops the mark too.
 */
const withoutBom = (src: string) => src.replace(/^\uFEFF/, '')

/**
 * `.md` and `.mdx`.
 *
 * `.mdx` was missing while the Docusaurus adapter shipped — an adapter mounting
 * a panel over a corpus that contained none of the pages it was mounted on,
 * because a Docusaurus project writes `.mdx` and this walk did not look at it.
 * The module syntax MDX adds is removed in `normalise.js`; nothing else about
 * the two extensions differs here.
 */
export function walkMarkdown(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.vitepress' && entry.name !== 'public') walkMarkdown(p, acc)
    } else if (/\.mdx?$/.test(entry.name)) acc.push(p)
  }
  return acc
}

/**
 * The route a page is published at.
 *
 * The mapping itself lives in `route.js` and is shared with the panel, which has
 * to name the SAME route for the current page or the *this page* scope matches
 * nothing. This function is now only the part that is genuinely the builder's:
 * turning an absolute path into one relative to `docsDir`.
 */
export function routeFor(file, docsDir) {
  return routeOf(path.relative(docsDir, file))
}

/**
 * The id of an EXTERNAL page — one that lives under `importDir` and has no route
 * on this site at all.
 *
 * It looks like a route and is not one. Everything downstream keys a page by
 * `path` — `sourceRow`, `closest`, the citation validator, the golden set — so
 * an external page needs a value in that slot, and it needs to be one no real
 * route can collide with. Derived from the directory name rather than fixed, and
 * checked against the indexed routes rather than assumed to be free.
 */
export function externalIdFor(file, kbDir, prefix) {
  const rel = path.relative(kbDir, file).replace(/\\/g, '/').replace(/\.mdx?$/, '')
  return `${prefix}/${rel}`
}

export function kindFor(route) {
  if (route.startsWith('/reference/')) return 'reference'
  if (route.startsWith('/extensions')) return 'extensions'
  return 'guide'
}

/**
 * The docs Markdown, one document per page.
 *
 * `exclude` and `specRoutes` are the routes that are not indexed from here: the
 * home and scratch pages, and the `/reference/` routes an OpenAPI spec is about
 * to claim. A spec claims one route; it does not claim the directory.
 *
 * TWO FILES, ONE ROUTE: `guide.md` beside `guide/index.md`, or `guide.md`
 * beside `guide.mdx`. `routeOf` maps both to `/guide`, and a page row keyed by
 * route kept the second file's entry while the chunks of BOTH stayed in the
 * index — one page row with one file's title and chunk count over two files'
 * text, or, when both had a `## Setup`, a `duplicate chunk id` death far from
 * the cause.
 *
 * The answer `readHtmlDir` gives a built site: warn, keep one. Which one is
 * decided by the path, never by `readdirSync`, whose order is the
 * filesystem's: the first in code-unit order, which puts `guide.md` before
 * `guide.mdx` and `guide/index.md` — and `guide.md` is the page VitePress
 * serves at `/guide`.
 *
 * No front-matter key is new (D-10): `visibility` is `'public'` because nothing
 * in a Markdown file says otherwise today.
 */
export function readMarkdownDocs({
  docsDir,
  root,
  exclude,
  specRoutes,
  warn,
}: {
  docsDir: string
  root: string
  exclude: Set<string>
  specRoutes: Set<string>
  warn: (message: string) => void
}): ReadDoc[] {
  const files = walkMarkdown(docsDir)
  const ownerOf = new Map()
  for (const file of files) {
    const route = routeFor(file, docsDir)
    const prior = ownerOf.get(route)
    if (!prior || path.relative(docsDir, file) < path.relative(docsDir, prior)) ownerOf.set(route, file)
  }

  const docs: ReadDoc[] = []
  for (const file of files) {
    const route = routeFor(file, docsDir)
    if (exclude.has(route)) continue
    if (specRoutes.has(route)) continue
    const owner = ownerOf.get(route)
    if (owner !== file) {
      warn(
        `two files claim ${route}: ${path.relative(root, owner)} and ${path.relative(root, file)} — the second is skipped`,
      )
      continue
    }

    const src = fs.readFileSync(file, 'utf8')
    const fm = splitFrontmatter(withoutBom(src))
    docs.push({
      id: route,
      source: 'markdown',
      // The route is the URL for a docs page (engine-spec 041). A `source:` key
      // on such a page is a citation href the chunker handles, not a document URL.
      url: null,
      title: fm.title ?? null,
      body: { format: 'markdown', markdown: src },
      file,
      visibility: 'public',
      breadcrumb: [],
      tags: [],
    })
  }
  return docs
}

/**
 * A built site (`--html-dir`), one document per page.
 *
 * `readHtmlDir` already does the reading: the main element, the pruning, the
 * conversion to Markdown, the sitemap filter, and the one-file-per-route rule
 * among HTML pages. What it returns is the Markdown it assembled, so the body is
 * `markdown` and the stage chunks it as it chunks a `.md` file. A failure
 * (a missing directory, a sitemap that cannot be read) is thrown, not said: the
 * builder owns how a build stops.
 *
 * `title` is the page's own `<title>` text and may be empty; the stage turns an
 * empty one into the route in the page row, as it always did.
 */
export async function readHtmlDocs({
  dir,
  select,
  exclude = '',
  base,
  sitemap,
  warn,
  html = null,
  root = '',
}: {
  dir: string
  select: string
  exclude?: string
  base: string
  sitemap: string
  warn: (message: string) => void
  /** `docPilot.html`; flags above it, per-source overrides inside it (D-21). */
  html?: any
  root?: string
}): Promise<ReadDoc[]> {
  const optionsFor = (file: string) => htmlOptionsFor(html, file, { root, flags: { content: select, exclude } })
  const found = await readHtmlDir({ dir, select, exclude, base, sitemap, warn, optionsFor })
  return found.map(htmlRecordToDoc)
}

/**
 * One built page as a document. The page's own canonical, `lang` and
 * `dateModified` ride on `url`, `locale` and `updatedAt` (D-12); none of the
 * three is hashed, so no committed byte moves.
 */
export function htmlRecordToDoc({
  route,
  file,
  src,
  title,
  canonical,
  lang,
  dateModified,
}: {
  route: string
  file: string
  src: string
  title: string
  canonical?: string | null
  lang?: string
  dateModified?: string | null
}): ReadDoc {
  return {
    id: route,
    source: 'html-dir',
    url: canonical || null,
    title,
    body: { format: 'markdown', markdown: src },
    file,
    visibility: 'public',
    breadcrumb: [],
    tags: [],
    locale: lang || undefined,
    updatedAt: dateModified || undefined,
  }
}

/**
 * One scalar key of a page's front matter, or '' when absent.
 *
 * `splitFrontmatter` reads the keys the chunker needs and is shared with the
 * Markdown path; `lang` and `dateModified` belong to the document metadata only
 * (D-12), so they are read here and that function is left as it was. A
 * double-quoted value is unquoted through JSON.parse, as `import` writes it.
 */
export function frontmatterValue(src: string, key: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(withoutBom(src))
  const m = block && new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(block[1])
  if (!m) return ''
  const raw = m[1].trim()
  if (raw.startsWith('"')) {
    try {
      return String(JSON.parse(raw))
    } catch {
      // Not JSON after all; fall through to the plain form.
    }
  }
  return raw.replace(/^['"]|['"]$/g, '')
}

/**
 * Imported pages (`importDir`, the `--kb` pages), one document per file in the
 * walk order. The `url` is the page's front-matter `source:`, UNCHECKED: the
 * stage runs it through the allowlist (`originFor`) because the allowlist is a
 * decision about what may become an `href`, and a reader decides nothing.
 */
export function readKbDocs({
  kbDir,
  externalPrefix,
}: {
  kbDir: string
  externalPrefix: string
}): ReadDoc[] {
  return walkMarkdown(kbDir).map((file) => {
    const src = fs.readFileSync(file, 'utf8')
    const fm = splitFrontmatter(withoutBom(src))
    return {
      id: externalIdFor(file, kbDir, externalPrefix),
      source: 'kb',
      url: fm.source ?? null,
      title: fm.title ?? null,
      body: { format: 'markdown', markdown: src },
      file,
      visibility: 'public',
      breadcrumb: [],
      tags: [],
      // `docpilot import` writes these keys (plan 02-06); neither is hashed (D-12).
      locale: frontmatterValue(src, 'lang') || undefined,
      updatedAt: frontmatterValue(src, 'dateModified') || undefined,
    }
  })
}

/**
 * A spec is named by its BASENAME, and the basename is the route.
 */
export const specNameOf = (f) => path.basename(f).replace(/\.ya?ml$/i, '')

/**
 * Which OpenAPI specs there are, and which `/reference/` routes they claim.
 *
 * Discovered before the Markdown is read, because the Markdown pass needs the
 * answer before it decides what to skip. The skip used to be the whole PREFIX —
 * `/reference/` was read as "generated stubs, the YAML is indexed instead" — and
 * that is true only of the stub a spec generates. Every hand-written reference
 * page a project keeps under that path was dropped from its own index in
 * silence. A spec claims one route; it does not claim the directory.
 *
 * That was harmless while every spec lived in one directory, where the
 * filesystem enforced uniqueness for free. `docPilot.openapi` can name two
 * directories, and `v1/api.yaml` beside `v2/api.yaml` then claims
 * `/reference/api` twice — the second silently overwriting the first's page
 * entry while both sets of chunks stay in the index under one id space. Which
 * one should win is not a decision this package can make, so it stops.
 */
export function discoverOpenapiSpecs({
  configured,
  fallbackDir,
  root,
  die,
}: {
  configured: string[] | null | undefined
  fallbackDir: string
  root: string
  die: (message: string) => void
}): { files: string[]; routes: Set<string> } {
  const { files, errors } = specFiles(configured, fallbackDir, root)
  if (errors.length) die(errors.join('\n        '))

  const byName = new Map()
  for (const f of files) {
    const name = specNameOf(f)
    const prior = byName.get(name)
    if (prior) {
      die(
        `two OpenAPI specs claim /reference/${name}:\n` +
          `        ${path.relative(root, prior)}\n        ${path.relative(root, f)}\n` +
          `        Rename one of them — the file name is the route.`,
      )
    }
    byName.set(name, f)
  }
  return { files, routes: new Set([...byName.keys()].map((n) => `/reference/${n}`)) }
}

/**
 * The OpenAPI files themselves, as documents whose body is the YAML text: the
 * chunker for them builds its chunks from the spec, not from Markdown.
 */
export function readOpenapiDocs(files: string[]): ReadDoc[] {
  return files.map((file) => ({
    id: `/reference/${specNameOf(file)}`,
    source: 'openapi',
    url: null,
    title: null,
    body: { format: 'openapi', yaml: fs.readFileSync(file, 'utf8') },
    file,
    visibility: 'public',
    breadcrumb: [],
    tags: [],
  }))
}
