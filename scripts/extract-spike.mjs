#!/usr/bin/env node
/**
 * The two HTML-extraction decisions of engine-spec 043, measured, not argued.
 *
 *   1. PARSER (D-02, D-19). Does the HTML parser change the Markdown? The
 *      `rules` arm runs the extractor over linkedom's tree. The `parse5` arm
 *      runs THE SAME rule code over a tree parse5 built (parse, serialise,
 *      read back by linkedom), so only the tree builder differs.
 *   2. FALLBACK (D-08, HTML-11). Does a Readability-class content selector
 *      beat the rule list on pages that have no landmark? `readability` and
 *      `defuddle` pick the content HTML, and the SAME serialiser turns it into
 *      Markdown (`extractDocument`, one serialiser: research Pattern 3).
 *
 * WHY OFFLINE. Every arm reads local files. No network, no hosted embedder and
 * no model is called, so the numbers cost nothing and a rerun on the same tree
 * prints the same table. The candidate packages are third-party code; they
 * live in a scratch directory outside the repository (installed with
 * --ignore-scripts), are imported by absolute path, and never enter
 * package.json unless the decision rule adopts one.
 *
 * THE LABELLED SET (D-03). (a) Every built docs page that has a Markdown
 * source under docs/ and is not `layout: home`: the source, rendered and read
 * as text, is the ground truth, its fenced blocks are the ground-truth code,
 * and the VitePress chrome strings are the noise. (b) The six synthetic
 * fixtures: truth.txt, the `pre` text of input.html, and noise.txt.
 *
 * THE LANDMARK-FREE SUBSET (P-09). Every built page has <main>, so the
 * landmark branch of `pickMain` runs and a fallback is never reached. The
 * subset is a copy of every page with `main`, `article` and `[role="main"]`
 * unwrapped into their children. Only that subset decides the fallback.
 *
 * METRICS (research Pattern 7), per page, then the median and win counts:
 *   token F1       multiset F1 over NFC-lowercased [\p{L}\p{N}]+ tokens of the
 *                  output read as text, against the ground-truth text read the
 *                  same way
 *   code retention the share of ground-truth code blocks found verbatim
 *                  (trailing whitespace trimmed) inside an output fence, pooled
 *                  over pages
 *   noise leakage  the count of noise strings present in the output and absent
 *                  from the page's own ground truth (a docs page about a
 *                  "Skip to content" link is not leaking)
 *   parser diff    the number of non-whitespace lines that one arm's Markdown
 *                  has and the other's lacks
 *
 * DECISION. A median of an even count is the mean of the two middle values.
 * Pages are scored in id order, so two runs print identical numbers. A tie is
 * not a win.
 *
 *   node scripts/extract-spike.mjs [--candidates=<dir>] [--out=<file>]
 *
 * `--candidates` is the directory whose node_modules holds parse5,
 * @mozilla/readability and defuddle; without it only the `rules` arm runs.
 * `--out` writes the numbers as JSON (schema 1, no timestamp, pages sorted by
 * id) and refuses a path inside the repository. Needs `npm run build:js` and
 * `npm run docs:build` first.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

import MarkdownIt from 'markdown-it'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST_SITE = path.join(ROOT, 'docs', '.vitepress', 'dist')
const DOCS = path.join(ROOT, 'docs')
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'html-extract')

/**
 * A candidate is adopted only when its median token F1 on the landmark-free
 * subset beats the rule list by at least this much. Two points of F1 is inside
 * the page-to-page difference of a set this size, so a smaller gain is noise
 * and a tie is not a win.
 */
export const ADOPT_MIN_F1_GAIN = 0.02

/**
 * Fewer landmark-free pages than this and a median says nothing about a site
 * the harness has not seen: the fallback is recorded as "not measurable" and
 * nothing is adopted.
 */
export const MIN_SPIKE_PAGES = 6

/** The base a docs page resolves its relative links against; it has no canonical. */
const DOCS_BASE = 'https://docs.example.test'

/** The base of a fixture with no canonical link. */
const FIXTURE_BASE = 'https://help.acme.test/'

const CANDIDATE_PACKAGES = ['parse5', '@mozilla/readability', 'defuddle']

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}

/* ------------------------------------------------------------------ loading */

const dist = (rel) => import(pathToFileURL(path.join(ROOT, 'dist', 'build', 'lib', rel)).href)

/** The `import` entry of a package, read from its exports map (never required). */
function entryOf(dir, name, sub = '.') {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'))
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  let target = pkg.exports ? pkg.exports[sub] : pkg.main
  const pick = (t) => {
    if (typeof t === 'string') return t
    if (Array.isArray(t)) return t.map(pick).find(Boolean)
    if (t && typeof t === 'object') {
      for (const key of ['import', 'node', 'default']) if (t[key]) return pick(t[key])
    }
    return undefined
  }
  target = pick(target) || pkg.module || pkg.main || 'index.js'
  return path.join(pkgDir, target)
}

const loadFile = (file) => import(pathToFileURL(file).href)

/* ------------------------------------------------------------- text metrics */

const TOKEN = /[\p{L}\p{N}]+/gu

const tokens = (text) => String(text).normalize('NFC').toLowerCase().match(TOKEN) || []

const counts = (list) => {
  const m = new Map()
  for (const t of list) m.set(t, (m.get(t) || 0) + 1)
  return m
}

/** Multiset F1 between two token lists. Empty on either side is 0. */
function f1(truth, got) {
  if (!truth.length || !got.length) return 0
  const a = counts(truth)
  const b = counts(got)
  let hit = 0
  for (const [t, n] of a) hit += Math.min(n, b.get(t) || 0)
  if (!hit) return 0
  const precision = hit / got.length
  const recall = hit / truth.length
  return (2 * precision * recall) / (precision + recall)
}

const collapse = (text) => String(text).replace(/\s+/g, ' ').trim()

const round = (x) => Math.round(x * 1e4) / 1e4

/** Mean of the two middle values for an even count. */
function median(values) {
  if (!values.length) return 0
  const s = [...values].sort((x, y) => x - y)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const md = new MarkdownIt({ html: true })

/** Markdown read as plain text: rendered, then the text of the result. */
function markdownText(parseDocument) {
  return async (source) => {
    // A full document: linkedom nests a bare <body> fragment inside itself and reads no text.
    const document = await parseDocument(`<!doctype html><html><body>${md.render(source)}</body></html>`)
    return document.body.textContent || ''
  }
}

/** Fenced blocks of Markdown, content only, trailing whitespace trimmed. */
function fences(markdown) {
  const out = []
  let open = null
  let buf = []
  for (const line of String(markdown).split('\n')) {
    if (open === null) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (m) {
        open = m[1]
        buf = []
      }
    } else if (new RegExp(`^ {0,3}${open[0]}{${open.length},}\\s*$`).test(line)) {
      out.push(buf.join('\n').trimEnd())
      open = null
    } else {
      buf.push(line)
    }
  }
  return out
}

/** Highlighter markers in a source block that never reach the rendered page. */
const CODE_MARKER = /\s*(?:\/\/|#|\/\*|<!--)\s*\[!code[^\]]*\]\s*(?:\*\/|-->)?/g

/* ---------------------------------------------------------- the labelled set */

const VOID_CONTAINER = /^:{3,}.*$/gm

/** A docs source, as the ground truth reads it: no front matter, no containers. */
function sourceTruth(raw) {
  let src = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  src = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  src = src.replace(VOID_CONTAINER, '')
  const blocks = md
    .parse(src, {})
    .filter((t) => t.type === 'fence')
    .map((t) => t.content.replace(CODE_MARKER, '').trimEnd())
    .filter(Boolean)
  return { src, blocks }
}

function sourceFor(route) {
  const rel = route === '/' ? '' : route.replace(/^\//, '')
  const candidates = rel ? [`${rel}.md`, path.join(rel, 'index.md')] : ['index.md']
  for (const c of candidates) {
    const file = path.join(DOCS, c)
    if (fs.existsSync(file)) return file
  }
  return ''
}

const DOCS_NOISE = [
  'Skip to content',
  'On this page',
  'Previous page',
  'Next page',
  'Edit this page',
  'Return to top',
  'Last updated',
]

/** Unwrap the landmarks, so `pickMain` has no landmark to find (P-09). */
function landmarkFree(document) {
  for (const el of [...document.querySelectorAll('main, article, [role="main"]')]) {
    const parent = el.parentNode
    if (!parent) continue
    while (el.firstChild) parent.insertBefore(el.firstChild, el)
    el.remove()
  }
  return document.toString()
}

async function labelled({ parseDocument, walkHtml, routeForHtml, codeText, readText }) {
  const pages = []
  for (const file of walkHtml(DIST_SITE)) {
    const route = routeForHtml(DIST_SITE, file)
    const source = sourceFor(route)
    if (!source) continue
    const raw = fs.readFileSync(source, 'utf8')
    if (/^---\r?\n(?:[\s\S]*?\r?\n)?layout:\s*home\s*\r?\n/.test(raw)) continue
    const { src, blocks } = sourceTruth(raw)
    const truthText = await readText(src)
    if (!tokens(truthText).length) continue
    pages.push({
      id: `docs:${route}`,
      html: fs.readFileSync(file, 'utf8'),
      base: `${DOCS_BASE}${route === '/' ? '/' : route}`,
      truthText,
      code: blocks,
      noise: DOCS_NOISE,
    })
  }
  for (const name of fs.readdirSync(FIXTURES).sort()) {
    const dir = path.join(FIXTURES, name)
    if (!fs.statSync(dir).isDirectory()) continue
    const html = fs.readFileSync(path.join(dir, 'input.html'), 'utf8')
    const lines = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim())
    const document = await parseDocument(html)
    const canonical = /<link\s+rel="canonical"\s+href="([^"]+)"/.exec(html)
    pages.push({
      id: `fixture:${name}`,
      html,
      base: canonical ? canonical[1] : FIXTURE_BASE,
      truthText: lines('truth.txt').join('\n'),
      code: [...document.querySelectorAll('pre')].map((pre) => codeText(pre)).filter(Boolean),
      noise: lines('noise.txt'),
    })
  }
  pages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return pages
}

/* --------------------------------------------------------------------- arms */

const WRAP = (content) =>
  `<!doctype html><html><head><title>x</title></head><body><main>${content}</main></body></html>`

async function buildArms({ parseDocument, extractDocument, candidates }) {
  const arms = {}
  const stats = { readabilityHappyDom: 0 }

  arms.rules = async (page) =>
    extractDocument(await parseDocument(page.html), { base: page.base, id: page.id })

  if (!candidates) return { arms, stats }

  const parse5 = await loadFile(entryOf(candidates, 'parse5'))
  arms.parse5 = async (page) => {
    // The same rule code; only the tree builder differs.
    const tree = parse5.parse(page.html)
    const document = await parseDocument(parse5.serialize(tree))
    return extractDocument(document, { base: page.base, id: page.id })
  }

  const readabilityModule = await loadFile(entryOf(candidates, '@mozilla/readability'))
  const Readability = readabilityModule.Readability || readabilityModule.default?.Readability
  const { Window } = await import('happy-dom')
  arms.readability = async (page) => {
    const run = (doc) => new Readability(doc, { charThreshold: 100 }).parse()
    let article
    try {
      article = run((await parseDocument(page.html)).cloneNode(true))
    } catch {
      // Readability rejected the linkedom document: build the DOM with happy-dom (research A-07).
      stats.readabilityHappyDom += 1
      const window = new Window({ url: page.base })
      window.document.write(page.html)
      article = run(window.document)
      await window.happyDOM.close()
    }
    if (!article?.content) return null
    return extractDocument(await parseDocument(WRAP(article.content)), { base: page.base, id: page.id })
  }

  const { Defuddle } = await loadFile(entryOf(candidates, 'defuddle', './node'))
  arms.defuddle = async (page) => {
    // Its content HTML only; its own Markdown is never used (one serialiser).
    const result = await Defuddle((await parseDocument(page.html)).cloneNode(true), page.base, {
      markdown: false,
    })
    if (!result?.content) return null
    return extractDocument(await parseDocument(WRAP(result.content)), { base: page.base, id: page.id })
  }
  return { arms, stats }
}

/* ------------------------------------------------------------------ scoring */

const lineBag = (markdown) =>
  counts(String(markdown).split('\n').map((l) => l.trim()).filter(Boolean))

/** Lines that one Markdown has and the other lacks, counted in both directions. */
function parserDiff(a, b) {
  const x = lineBag(a)
  const y = lineBag(b)
  let diff = 0
  for (const [line, n] of x) diff += Math.max(0, n - (y.get(line) || 0))
  for (const [line, n] of y) diff += Math.max(0, n - (x.get(line) || 0))
  return diff
}

async function score(pages, arms, readText) {
  const results = []
  for (const page of pages) {
    const truthTokens = tokens(page.truthText)
    const truthFlat = collapse(page.truthText)
    const row = { id: page.id, truthTokens: truthTokens.length, codeBlocks: page.code.length, arms: {} }
    const markdowns = {}
    for (const [name, run] of Object.entries(arms)) {
      let outcome = { ok: false, markdown: '', reason: '' }
      try {
        const result = await run(page)
        if (!result) outcome = { ok: false, markdown: '', reason: 'no content' }
        else outcome = { ok: result.ok, markdown: result.markdown, reason: result.reason }
      } catch (e) {
        outcome = { ok: false, markdown: '', reason: `threw: ${e?.message || e}`.slice(0, 80) }
      }
      markdowns[name] = outcome.markdown
      const text = outcome.markdown ? await readText(outcome.markdown.replace(/ \{#[^}]*\}/g, '')) : ''
      const found = fences(outcome.markdown)
      const flat = collapse(outcome.markdown)
      row.arms[name] = {
        ok: outcome.ok,
        reason: outcome.ok ? '' : outcome.reason,
        f1: round(f1(truthTokens, tokens(text))),
        codeFound: page.code.filter((g) => found.some((f) => f.includes(g))).length,
        noise: page.noise.filter((n) => flat.includes(collapse(n)) && !truthFlat.includes(collapse(n))).length,
        chars: [...outcome.markdown].length,
      }
    }
    if (markdowns.rules !== undefined && markdowns.parse5 !== undefined) {
      row.parserDiff = parserDiff(markdowns.rules, markdowns.parse5)
    }
    results.push(row)
  }
  return results
}

function summarise(results, armName) {
  const rows = results.filter((r) => r.arms[armName])
  const f1s = rows.map((r) => r.arms[armName].f1)
  const base = rows.map((r) => r.arms.rules.f1)
  let wins = 0
  let losses = 0
  let ties = 0
  rows.forEach((r, i) => {
    if (f1s[i] > base[i]) wins += 1
    else if (f1s[i] < base[i]) losses += 1
    else ties += 1
  })
  const blocks = rows.reduce((n, r) => n + r.codeBlocks, 0)
  const found = rows.reduce((n, r) => n + r.arms[armName].codeFound, 0)
  return {
    pages: rows.length,
    medianF1: round(median(f1s)),
    meanF1: round(f1s.reduce((a, b) => a + b, 0) / (f1s.length || 1)),
    winsVsRules: wins,
    lossesVsRules: losses,
    tiesVsRules: ties,
    codeBlocks: blocks,
    codeFound: found,
    codeRetention: blocks ? round(found / blocks) : null,
    noiseLeakage: rows.reduce((n, r) => n + r.arms[armName].noise, 0),
    failures: rows.filter((r) => !r.arms[armName].ok).length,
  }
}

/** D-02, D-19: switch only when a differing page scores higher under parse5. */
function parserDecision(results) {
  const differing = results.filter((r) => (r.parserDiff || 0) > 0)
  const better = differing.filter((r) => {
    const a = r.arms.rules
    const b = r.arms.parse5
    return b.f1 > a.f1 || b.codeFound > a.codeFound
  })
  return {
    pagesWithDiff: differing.map((r) => ({
      id: r.id,
      lines: r.parserDiff,
      rulesF1: r.arms.rules.f1,
      parse5F1: r.arms.parse5.f1,
      rulesCode: r.arms.rules.codeFound,
      parse5Code: r.arms.parse5.codeFound,
    })),
    pagesWhereParse5Scores: better.map((r) => r.id),
    switchParser: better.length > 0,
  }
}

/** D-08: a candidate wins only by the margin, with no loss on code or noise. */
function fallbackDecision(results, names) {
  const measurable = results.length >= MIN_SPIKE_PAGES
  const rules = summarise(results, 'rules')
  const out = {}
  for (const name of names) {
    const s = summarise(results, name)
    const gain = round(s.medianF1 - rules.medianF1)
    const codeOk = (s.codeRetention ?? 0) >= (rules.codeRetention ?? 0)
    const noiseOk = s.noiseLeakage <= rules.noiseLeakage
    out[name] = {
      medianF1Gain: gain,
      gainMeetsMinimum: gain >= ADOPT_MIN_F1_GAIN,
      codeRetentionNotLower: codeOk,
      noiseLeakageNotHigher: noiseOk,
      adopted: measurable && gain >= ADOPT_MIN_F1_GAIN && codeOk && noiseOk,
    }
  }
  return { measurable, minPages: MIN_SPIKE_PAGES, minGain: ADOPT_MIN_F1_GAIN, candidates: out }
}

/* ------------------------------------------------------------------- output */

const pad = (v, n) => String(v).padEnd(n)

function table(title, results, names) {
  const lines = [`\n${title} — ${results.length} pages`]
  lines.push(
    [pad('arm', 12), pad('medianF1', 10), pad('meanF1', 8), pad('win/loss/tie', 14), pad('code', 12), pad('noise', 6), 'failed'].join(' '),
  )
  for (const name of names) {
    const s = summarise(results, name)
    const code = s.codeRetention === null ? 'n/a' : `${s.codeFound}/${s.codeBlocks}=${s.codeRetention}`
    lines.push(
      [
        pad(name, 12),
        pad(s.medianF1, 10),
        pad(s.meanF1, 8),
        pad(`${s.winsVsRules}/${s.lossesVsRules}/${s.tiesVsRules}`, 14),
        pad(code, 12),
        pad(s.noiseLeakage, 6),
        s.failures,
      ].join(' '),
    )
  }
  return lines.join('\n')
}

async function main() {
  const candidates = arg('candidates') ? path.resolve(arg('candidates')) : ''
  const out = arg('out') ? path.resolve(arg('out')) : ''
  if (out && (out === ROOT || out.startsWith(ROOT + path.sep))) {
    console.error(`[docpilot] extract-spike: --out must be outside the repository (${ROOT})`)
    process.exit(2)
  }
  if (!fs.existsSync(DIST_SITE)) {
    console.error('[docpilot] extract-spike: docs/.vitepress/dist is missing — run `npm run docs:build` first')
    process.exit(2)
  }
  if (candidates) {
    for (const name of CANDIDATE_PACKAGES) {
      if (!fs.existsSync(path.join(candidates, 'node_modules', ...name.split('/'), 'package.json'))) {
        console.error(`[docpilot] extract-spike: ${name} is not installed under ${candidates}`)
        process.exit(2)
      }
    }
  }

  const { parseDocument } = await dist('dom.js')
  const { extractDocument } = await dist('extract-html.js')
  const { codeText } = await dist('html-code.js')
  const { walkHtml, routeForHtml } = await dist('html-dir.js')
  const readText = markdownText(parseDocument)

  const full = await labelled({ parseDocument, walkHtml, routeForHtml, codeText, readText })
  const free = []
  for (const page of full) free.push({ ...page, html: landmarkFree(await parseDocument(page.html)) })

  const { arms, stats } = await buildArms({ parseDocument, extractDocument, candidates })
  const names = Object.keys(arms)

  const fullResults = await score(full, arms, readText)
  const freeResults = await score(free, arms, readText)

  console.log(table('With landmarks (the built pages as they are)', fullResults, names))
  console.log(table('Landmark-free subset (main, article, [role=main] unwrapped)', freeResults, names))

  const report = {
    schema: 1,
    constants: { ADOPT_MIN_F1_GAIN, MIN_SPIKE_PAGES },
    sets: {
      withLandmarks: {
        pages: fullResults.length,
        docs: fullResults.filter((r) => r.id.startsWith('docs:')).length,
        fixtures: fullResults.filter((r) => r.id.startsWith('fixture:')).length,
      },
      landmarkFree: { pages: freeResults.length },
    },
    arms: names,
    summary: {
      withLandmarks: Object.fromEntries(names.map((n) => [n, summarise(fullResults, n)])),
      landmarkFree: Object.fromEntries(names.map((n) => [n, summarise(freeResults, n)])),
    },
    readabilityHappyDomFallbacks: stats.readabilityHappyDom,
  }
  if (arms.parse5) {
    report.parser = {
      withLandmarks: parserDecision(fullResults),
      landmarkFree: parserDecision(freeResults),
    }
    report.parser.switchParser = report.parser.withLandmarks.switchParser || report.parser.landmarkFree.switchParser
    console.log(
      `\nparser: ${report.parser.withLandmarks.pagesWithDiff.length} page(s) differ with landmarks, ` +
        `${report.parser.landmarkFree.pagesWithDiff.length} landmark-free; switch parser: ${report.parser.switchParser}`,
    )
  }
  const contenders = names.filter((n) => n === 'readability' || n === 'defuddle')
  if (contenders.length) {
    report.fallback = fallbackDecision(freeResults, contenders)
    for (const [name, d] of Object.entries(report.fallback.candidates)) {
      console.log(
        `fallback ${name}: gain ${d.medianF1Gain} (min ${ADOPT_MIN_F1_GAIN}), code not lower ${d.codeRetentionNotLower}, ` +
          `noise not higher ${d.noiseLeakageNotHigher} -> ${d.adopted ? 'adopted' : 'not adopted'}`,
      )
    }
    if (!report.fallback.measurable) console.log(`fallback: not measurable (fewer than ${MIN_SPIKE_PAGES} pages)`)
  }
  report.pages = { withLandmarks: fullResults, landmarkFree: freeResults }

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
    console.log(`\nwrote ${out}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
