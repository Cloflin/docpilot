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
import { routeOf } from '../../theme/docpilot/route.js'
import type { ReadDoc } from './source-doc.js'

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
    const fm = splitFrontmatter(src)
    docs.push({
      id: route,
      source: 'markdown',
      url: fm.source ?? null,
      title: fm.title ?? null,
      body: { format: 'markdown', markdown: src },
      visibility: 'public',
      breadcrumb: [],
      tags: [],
    })
  }
  return docs
}
