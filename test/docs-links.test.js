/**
 * Two gates nothing else in this repository can provide.
 *
 * 1. ANCHORS. `vitepress build` checks dead links, and it checks PATHS ONLY:
 *    before resolving a link it runs `url.replace(/[?#].*$/, '')`, so the
 *    fragment is gone by the time anything looks at it (vitepress bundles this
 *    in `dist/node/chunk-*.js`, in the `resolveDeadLinks` pass — the line reads
 *    `url = url.replace(/[?#].*$/, "").replace(/\.(html|md)$/, "")`). A green
 *    build therefore says nothing about `#…`. That is how three links kept
 *    pointing at `/reference/config#feedbackendpoint-and-feedback` after that
 *    heading was split into `## feedbackEndpoint` and `## feedback`: the pages
 *    still existed, the anchors landed nowhere, and the reader was dropped at
 *    the top of a 1000-line reference page instead of the setting they clicked.
 *
 * 2. INDEX FRESHNESS. This project commits `docs/public/rag/` to git, which buys
 *    a deploy with zero API calls at the price of one risk: forgetting to
 *    rebuild after editing the docs. A stale index cites text that has since
 *    moved — silently, and worse with every further edit. The risk is cheap to
 *    remove because the index version is a pure function of the corpus:
 *    `sha256(JSON.stringify(chunks.map(c => c.id + c.text))).slice(0, 8)`
 *    (build-rag-index.js), with no embeddings in it. So the corpus can be
 *    re-chunked here, offline, and the hash compared.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { openFence, closesFence } from '../src/build/lib/normalise.js'
import { chunkMarkdown } from '../src/build/lib/chunker.js'
import { routeOf } from '../src/theme/docpilot/route.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DOCS = path.join(ROOT, 'docs')
const RAG = path.join(DOCS, 'public', 'rag')

/**
 * VitePress's heading slug, REPRODUCED rather than imported.
 *
 * It comes from `@mdit-vue/shared`, which is not a resolvable package here:
 * vitepress ships it inlined into its own bundle, so there is no module to
 * import and a `node_modules/vitepress/dist/node/chunk-*.js` deep import would
 * be a path that changes on every vitepress release. Copied verbatim from that
 * bundle's `src/slugify.ts` region instead, and it must stay verbatim — the
 * approximation is what makes this gate lie in either direction.
 *
 * Specifically NOT `slug()` from the chunker: that one deletes every character
 * outside `\p{L}\p{N}\s-`, so `### budget.dailyLimit` slugs to
 * `budgetdailylimit`, while VitePress folds `.` into `-` and publishes
 * `budget-dailylimit` — the anchor three real links in `free-tier.md` and
 * `config.md` use. Using the chunker's slug here would have failed all three.
 */
const rControl = /[\u0000-\u001f]/g
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const rCombining = /[\u0300-\u036F]/g
const slugify = (str) =>
  str
    .normalize('NFKD')
    .replace(rCombining, '')
    .replace(rControl, '')
    .replace(rSpecial, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()

/**
 * Every page of the site. `.vitepress/dist` and `.vitepress/cache` are build
 * output — a stale `dist/` from a previous run would otherwise be checked as if
 * it were source and report failures nobody can fix by editing anything.
 */
function walkDocs(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (p === path.join(DOCS, '.vitepress', 'dist')) continue
      if (p === path.join(DOCS, '.vitepress', 'cache')) continue
      walkDocs(p, acc)
    } else if (entry.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

/**
 * The lines markdown-it will actually parse: frontmatter dropped, fenced code
 * dropped.
 *
 * Both exclusions are load-bearing. `production.md` shows an nginx config whose
 * comments start with `#`, and `# http {} — the zones…` inside a fence is not a
 * heading; a YAML comment in frontmatter is not one either. In the other
 * direction, a page documenting markdown syntax shows links that are samples,
 * not links. `openFence`/`closesFence` are imported rather than re-derived for
 * the reason stated on them: one fence scanner is the only version that stays
 * true, and a second one here would disagree on the first `~~~` shown inside a
 * ``` block.
 */
function* proseLines(src) {
  const lines = src.split('\n')
  let i = 0
  if (lines[0] === '---') {
    i = 1
    while (i < lines.length && lines[i] !== '---') i++
    i++
  }
  let open = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (open) {
      if (closesFence(line, open)) open = null
      continue
    }
    const fence = openFence(line)
    if (fence) {
      open = fence
      continue
    }
    yield [i + 1, line]
  }
}

/**
 * Heading text as the anchor plugin sees it.
 *
 * VitePress hands markdown-it-anchor a `getTokensText` that joins TOKEN CONTENT,
 * so inline markup never reaches `slugify` — `## \`bench\`` is slugged from
 * `bench`, not from `` `bench` ``. Stripping the markers here is the same
 * operation done on text.
 */
const inlineText = (s) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/(\*\*|__|~~|\*|_)/g, '')

/**
 * Every anchor a page publishes, in document order.
 *
 * All six heading levels: markdown-it-anchor defaults to `level: 1` and
 * VitePress does not override it, so `#` through `######` all get ids.
 *
 * A custom `{#id}` is used VERBATIM — that is what VitePress puts in the DOM,
 * and slugging it would invent an anchor nobody can link to. A repeat of an
 * already-taken slug gets `-1`, `-2`, … exactly as markdown-it-anchor's
 * uniqueness pass does (`uniqueSlugStartIndex` is 1), which is the same rule the
 * chunker reproduces for its own chunk anchors.
 */
function headingIds(src) {
  const ids = []
  const taken = new Map()
  for (const [, line] of proseLines(src)) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (!m) continue
    const custom = /\{#([^}]+)\}\s*$/.exec(m[2])
    let id = custom ? custom[1] : slugify(inlineText(m[2].replace(/\{#[^}]+\}\s*$/, '')))
    if (taken.has(id)) {
      let n = taken.get(id)
      let candidate = `${id}-${n}`
      while (taken.has(candidate)) candidate = `${id}-${++n}`
      taken.set(id, n + 1)
      id = candidate
    }
    taken.set(id, 1)
    ids.push(id)
  }
  return ids
}

/**
 * Where a link points, as a path on disk.
 *
 * `/guide/x` → `docs/guide/x.md`, `/guide/` → `docs/guide/index.md`,
 * `./providers` → the sibling page, and an empty path (a bare `#anchor`) → the
 * page the link is written on. A `.md` or `.html` suffix is stripped, because
 * both spellings resolve to the same route.
 */
function targetOf(fromFile, rawPath) {
  if (!rawPath) return fromFile
  let p = rawPath.replace(/\.(md|html)$/, '')
  if (p.endsWith('/')) p += 'index'
  let resolved = p.startsWith('/') ? path.join(DOCS, p) : path.resolve(path.dirname(fromFile), p)
  // A directory route without the trailing slash — `/install` is `install/index.md`.
  if (!fs.existsSync(`${resolved}.md`) && fs.existsSync(path.join(resolved, 'index.md'))) {
    resolved = path.join(resolved, 'index')
  }
  return `${resolved}.md`
}

describe('docs — anchor links', () => {
  const files = walkDocs(DOCS)
  const idsByFile = new Map(files.map((f) => [f, headingIds(fs.readFileSync(f, 'utf8'))]))

  it('points every #anchor at a heading that exists', () => {
    const broken = []
    let checked = 0
    for (const file of files) {
      const from = path.relative(ROOT, file)
      for (const [line, text] of proseLines(fs.readFileSync(file, 'utf8'))) {
        for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
          const href = m[1]
          // Off the site: nothing here can say whether a remote `#section` exists.
          if (/^(https?:|mailto:)/i.test(href)) continue
          const hash = href.indexOf('#')
          if (hash < 0) continue
          const anchor = decodeURIComponent(href.slice(hash + 1))
          if (!anchor) continue
          checked++
          const target = targetOf(file, href.slice(0, hash))
          const ids = idsByFile.get(target)
          if (!ids) {
            broken.push(`${from}:${line} → ${href} — no such page: ${path.relative(ROOT, target)}`)
          } else if (!ids.includes(anchor)) {
            broken.push(
              `${from}:${line} → ${href} — ${path.relative(ROOT, target)} has no heading "#${anchor}"`,
            )
          }
        }
      }
    }
    // A gate that checks nothing passes quietly forever. The link syntax could
    // change, `proseLines` could swallow a file, and the assertion below would
    // still be green on an empty list.
    expect(checked).toBeGreaterThan(20)
    expect(broken).toEqual([])
  })

  it('folds a dot into a dash, the way VitePress does and the chunker does not', () => {
    // `### budget.dailyLimit` in reference/config.md, linked from free-tier.md
    // as `#budget-dailylimit`. The chunker's `slug()` deletes the dot instead.
    expect(headingIds('### budget.dailyLimit')).toEqual(['budget-dailylimit'])
    expect(headingIds('## `--level=` {#level}')).toEqual(['level'])
    expect(headingIds('## Two tabs {#two-tabs}')).toEqual(['two-tabs'])
  })

  it('sees the split that produced the three broken links', () => {
    // The heading that WAS, and the two that replaced it. Nothing slugs to the
    // old anchor any more, which is precisely what the walk above must notice.
    expect(headingIds('## feedbackEndpoint and feedback')).toEqual(['feedbackendpoint-and-feedback'])
    expect(headingIds('## feedbackEndpoint\n\n## feedback')).not.toContain(
      'feedbackendpoint-and-feedback',
    )
  })

  it('gives a repeated heading the suffix markdown-it-anchor gives it', () => {
    expect(headingIds('## Use cases\n\n## Use cases\n\n## Use cases')).toEqual([
      'use-cases',
      'use-cases-1',
      'use-cases-2',
    ])
  })

  it('reads no heading and no link out of fenced code', () => {
    const src = ['```nginx', '# http {} — declared outside the server block', '```'].join('\n')
    expect(headingIds(src)).toEqual([])
  })
})

/**
 * The corpus the real build reads, rebuilt here with the same enumeration.
 *
 * The hash is order-sensitive, so this must match `build-rag-index.js` step for
 * step: `walkMarkdown` skipping `.vitepress` and `public`, in `readdirSync`
 * order (the build does not sort, so neither does this), `EXCLUDE` dropping
 * `/index` and `/new-file`, `kindFor` deciding the kind, and a page that
 * produces no chunk contributing nothing.
 */
const EXCLUDE = new Set(['/index', '/new-file'])
const kindFor = (route) => {
  if (route.startsWith('/reference/')) return 'reference'
  if (route.startsWith('/extensions')) return 'extensions'
  return 'guide'
}

function walkCorpus(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.vitepress' && entry.name !== 'public') walkCorpus(p, acc)
    } else if (entry.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

const SPEC_DIR = path.join(DOCS, 'public', 'openapi')
const CONFIG_SRC = fs.readFileSync(path.join(DOCS, '.vitepress', 'config.mjs'), 'utf8')
/**
 * Two sources this rebuild does NOT reproduce, because this site has neither:
 * `importDir` pages and OpenAPI specs. Both push chunks into the same array, so
 * either one appearing would move the hash and this file would report a stale
 * index that is perfectly fresh. Asserted below rather than assumed, and the
 * comparison skips itself rather than lying.
 */
const EXTRA_SOURCES = fs.existsSync(SPEC_DIR) || /importDir/.test(CONFIG_SRC)

/**
 * EVERY COMMITTED INDEX, not the one this file used to know about.
 *
 * `docs/public/rag/` is what the deploy serves and was the only manifest held to
 * the corpus. `docs/public/rag-local/` is a second one — the same corpus
 * embedded by a local bge-m3, published so that a measurement against a weaker
 * embedder can be reproduced and compared — and the argument for gating it is
 * word for word the argument the .gitignore made for the first: an index nobody
 * checks is an index that silently stops describing the docs beside it.
 *
 * Discovered rather than listed, so a third one is covered the day it appears.
 * The corpus hash is a fact about `docs/`, not about any embedder, so ONE hash
 * holds all of them.
 */
const PUBLIC = path.join(DOCS, 'public')
/** The DEPLOYED index, for the figures gate below — those numbers are the site's. */
const MANIFEST = path.join(RAG, 'manifest.json')
const MANIFESTS = (fs.existsSync(PUBLIC) ? fs.readdirSync(PUBLIC, { withFileTypes: true }) : [])
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(PUBLIC, e.name, 'manifest.json')))
  .map((e) => ({ dir: `docs/public/${e.name}`, file: path.join(PUBLIC, e.name, 'manifest.json') }))

describe('docs — the committed index cannot go stale', () => {
  it('has no corpus source this rebuild does not read', () => {
    // If this fails the fix is in THIS file: teach the rebuild below about the
    // new source (openapi chunks, or pages under `importDir`) before trusting
    // the hash again.
    expect(
      EXTRA_SOURCES ? ['docs/ grew a corpus source test/docs-links.test.js does not chunk'] : [],
    ).toEqual([])
  })

  // A fresh clone that has never run `docpilot index` is not a broken
  // repository, and everything under `docs/public/*/` is build output.
  it.skipIf(!MANIFESTS.length || EXTRA_SOURCES)(
    'matches the hash in every committed manifest.json',
    () => {
      const chunks = []
      for (const file of walkCorpus(DOCS)) {
        const route = routeOf(path.relative(DOCS, file))
        if (EXCLUDE.has(route)) continue
        const { chunks: c } = chunkMarkdown({
          src: fs.readFileSync(file, 'utf8'),
          path: route,
          kind: kindFor(route),
        })
        if (!c.length) continue
        chunks.push(...c)
      }

      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(chunks.map((c) => c.id + c.text)))
        .digest('hex')
        .slice(0, 8)

      /**
       * The rebuild command names the DIRECTORY, because the two are not built
       * the same way: `docs/public/rag/` is the OpenRouter build and
       * `docs/public/rag-local/` takes `DOCPILOT_EMBED_LOCAL=1`. Printing one
       * command for both would send somebody to overwrite the wrong one.
       */
      const rebuild = (dir) =>
        dir.endsWith('/rag')
          ? 'npx docpilot index'
          : 'DOCPILOT_EMBED_LOCAL=1 npx docpilot index'

      expect(
        MANIFESTS.flatMap(({ dir, file }) => {
          const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
          return hash === manifest.hash
            ? []
            : [
                `the committed index at ${dir} is stale — run \`${rebuild(dir)}\` and commit it. ` +
                  `manifest.json is index ${manifest.hash} (${manifest.chunkCount} chunks); ` +
                  `docs/ now chunks to ${hash} (${chunks.length} chunks).`,
              ]
        }),
      ).toEqual([])
    },
  )
})

/**
 * THE THIRD GATE, and the one the other two cannot cover.
 *
 * The marketing page and three docs pages print CONCRETE MEASUREMENTS of the
 * committed index — "405 chunks", "810 KB", "829,440 bytes", "3.2 MB as
 * float32" — because a claim a reader can check with `ls -l` is worth more than
 * a claim they have to take. The whole point is that they are checkable.
 *
 * Which makes them the most perishable sentences in the repository. Every one
 * of them is a statement about a file that `docpilot index` rewrites, and the
 * gate above deliberately says nothing about them: it compares the corpus hash,
 * so a rebuild that moves the chunk count from 405 to 409 turns that gate GREEN
 * and every figure below into a lie on the same commit. That has already
 * happened once between two sessions editing docs/ in parallel.
 *
 * So the figures are derived here from the manifest and the vector blob and
 * asserted verbatim in the files that print them. The failure message names the
 * replacement, because the fix is mechanical and the point of the test is that
 * nobody has to go and measure anything.
 *
 * WHERE THE NUMBERS COME FROM, so a future reader can check the test itself:
 *   chunks       manifest.chunkCount
 *   bytes        chunkCount × dims, which is the blob's size on disk because
 *                the quantisation is one signed byte per dimension with no
 *                per-vector scale (src/build/lib/quantize.js). Asserted against
 *                the real file rather than trusted.
 *   KB           bytes / 1024, rounded — what `ls -lh` prints
 *   float32 MB   bytes × 4, the same array unquantised
 */
describe('docs — the printed index figures match the committed index', () => {
  const VECTORS = (m) => path.join(RAG, m.vectors ?? '')

  it.skipIf(!fs.existsSync(MANIFEST))('the blob is one byte per dimension', () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    // If this ever fails, every figure below is derived from a false premise
    // and the templates in the next test need rewriting, not just re-running.
    expect(fs.statSync(VECTORS(m)).size).toBe(m.chunkCount * m.dims)
  })

  it.skipIf(!fs.existsSync(MANIFEST))('every page printing a figure prints the current one', () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    const bytes = fs.statSync(VECTORS(m)).size
    const n = m.chunkCount
    const kb = `${Math.round(bytes / 1024)} KB`
    const mb = `${((bytes * 4) / 1024 / 1024).toFixed(1)} MB`
    const grouped = bytes.toLocaleString('en-US')

    /**
     * One entry per sentence that carries a measurement, spelled as the exact
     * substring the file must contain. Deliberately not a regex sweep for
     * `\d+ chunks`: the docs say "1191-chunk corpus" about somebody else's
     * measurement and "5,000–10,000 chunks" about the scale ceiling, and a
     * sweep would either rewrite those or need exceptions for them.
     */
    const claims = [
      ['docs/.vitepress/theme/FeatureGrid.vue', `${n} chunks × ${m.dims} dims × 1 byte = ${grouped} bytes`],
      ['docs/.vitepress/theme/FeatureGrid.vue', `{ label: 'float32', bytes: '${mb}'`],
      ['docs/.vitepress/theme/FeatureGrid.vue', `{ label: 'int8', bytes: '${kb}'`],
      ['docs/.vitepress/theme/FeatureGrid.vue', `${n} chunks at ${m.dims} dimensions`],
      ['docs/.vitepress/theme/Comparison.vue', `${kb} for ${n} chunks`],
      ['docs/guide/comparison.md', `${kb} for this site's ${n} chunks at ${m.dims} dimensions`],
      ['docs/guide/comparison.md', `${n} chunks, ${m.dims} dimensions`],
      // The same sentence carries a third measurement the two claims above do
      // not reach: "405 chunks, 2048 dimensions," ends one line and "810 KB of
      // int8 vectors" begins the next, so the KB token sits outside both spans
      // and a rebuild would have left it stale with this gate green.
      ['docs/guide/comparison.md', `${kb} of int8 vectors`],
      ['docs/guide/indexing.md', `indexes ${n} chunks at ${m.dims} dimensions`],
      ['docs/guide/indexing.md', `${grouped} bytes — ${kb}, where float32 would have been ${mb}`],
      ['README.md', `${kb} for this project's own ${n}-chunk index, where float32 would be ${mb}`],
      ['README.md', `${kb} for this site's ${n} chunks`],
    ]

    const stale = claims
      .filter(([file, claim]) => !fs.readFileSync(path.join(ROOT, file), 'utf8').includes(claim))
      .map(([file, claim]) => `${file} no longer says "${claim}"`)

    expect(
      stale.length
        ? [
            `the index was rebuilt and the printed figures were not updated. ` +
              `The committed index is ${n} chunks × ${m.dims} dims = ${grouped} bytes ` +
              `(${kb}; ${mb} as float32). Update:`,
            ...stale,
          ]
        : [],
    ).toEqual([])
  })
})
