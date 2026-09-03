#!/usr/bin/env node
/**
 * The openers a corpus with no readers would ask for — the cold-start half of
 * the `faq` mode.
 *
 *   node {{SKILL_DIR}}/scripts/opener-candidates.js \
 *     [--rag=docs/public/rag] [--n=5] [--per-section=1] [--pool=20] \
 *     [--probes=docpilot/calibration.jsonl] [--tiers=faq,heading,template] \
 *     [--min-terms=40]
 *
 * `docpilot feedback faq` needs an export of real votes. A site that has not
 * shipped yet has none, and the questions on its empty state are guesses — which
 * is the state this package's own docs site was in when this was written. So
 * this reads the INDEX instead: what the corpus already phrases as a question,
 * and what it has enough text to answer.
 *
 * IT PROPOSES AND NEVER WRITES, on the same terms as `docpilot feedback faq`
 * and with MORE force rather than less. That command's sample is biased — only
 * readers who pressed a thumb are in it. This one has no sample at all: every
 * candidate below is derived from the corpus, and a corpus does not know what
 * anybody wants to ask it. What it knows is what it can ANSWER, which is a
 * different question and the only one the ranking here is entitled to.
 *
 * ZERO REQUESTS, AND THE GATE VERDICT IS REAL. `assembleIndex` reads
 * `manifest.vectors === null` as "this index has no dense channel"
 * (store.js), so handing it a manifest with that key nulled and no vector
 * buffer produces the same lexical-only index an `embed: false` site runs —
 * over this corpus, with this corpus's df table and tuning. `evaluate()` then
 * forces `mode: 'lexical-only'` itself, and `verdict()` returns `G = L` against
 * `guard.tauLexical`. That is the shipped retriever, the shipped BM25 weights
 * and the shipped gate, not an approximation of them. Reimplementing the
 * scoring here was the alternative, and a second ranker is a ranker that
 * silently stops agreeing with the one readers use.
 *
 * WHAT THAT NUMBER IS NOT, and this is load-bearing. The panel's gate is
 * hybrid — `wDense·D + wLexical·L` against `guard.tau` — and `assertWeights`
 * guarantees `wLexical < tau`, so the lexical channel CANNOT clear it alone. A
 * `✓` here is a FLOOR: the corpus contains this question's rare wording. A `✗`
 * is a warning and not a refusal prediction, because the dense channel carries
 * most of the score and a well-phrased paraphrase with poor term overlap is the
 * ordinary passing case. The verdict is the `openers` block of
 * `npx docpilot index`. This is a screen; the build is the gate.
 *
 * DETERMINISTIC WITH NO SEED, which is stronger than `sample-chunks.js` rather
 * than weaker. That script SAMPLES, so it needs a pinned PRNG or a regenerated
 * golden set is a new file instead of a diff. This one RANKS, exhaustively:
 * every candidate is scored and ties break on the chunk id, which is a total
 * order that stays stable when a page is added. A `--seed` flag here would be a
 * flag that changes no output.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const ROOT = process.cwd()
const RAG = path.resolve(ROOT, arg('rag', 'docs/public/rag'))
const PROBES = path.resolve(ROOT, arg('probes', 'docpilot/calibration.jsonl'))
const N = Number(arg('n', '5'))
const PER_SECTION = Number(arg('per-section', '1'))
const POOL = Number(arg('pool', '20'))
const TIERS = new Set(arg('tiers', 'faq,heading,template').split(',').filter(Boolean))
/** A chunk under this many content terms cannot ground a question. */
const MIN_TERMS = Number(arg('min-terms', '40'))

/**
 * WHERE `dist/` IS, from a consumer's directory rather than from this package's.
 *
 * `path.join(ROOT, 'dist')` is the package repository's own layout, and the
 * skill is COPIED into consumer projects — `npx docpilot init` writes it to
 * whichever skills directory the reader picked, because a skill inside
 * `node_modules` is discovered by nobody. There it resolved `<their project>/dist`, which either
 * does not exist or is their build, and the script died on an import before
 * printing a line.
 *
 * This file always sits at `<package>/skills/docs-rag/scripts/`, so the built
 * modules are two directories up from here whichever tree it was copied into.
 * The cwd form is kept as a fallback for the package's own checkout, where the
 * two paths agree anyway.
 */
const HERE = path.dirname(new URL(import.meta.url).pathname)
const CANDIDATE_DISTS = [path.resolve(HERE, '../../../dist'), path.join(ROOT, 'dist')]
const dist = CANDIDATE_DISTS.find((d) => fs.existsSync(path.join(d, 'theme/docpilot/store.js')))
if (!dist) {
  console.error(
    `[docpilot] no built modules found. Looked in:\n` +
      CANDIDATE_DISTS.map((d) => `  ${d}`).join('\n') +
      `\n  In the package repository, run \`npm run build:js\` first.`,
  )
  process.exit(1)
}
const { assembleIndex } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/store.js')).href)
const { createRetrieval } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/retriever.js')).href)
const { similarity, openerQuestions } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/openers.js')).href)
const { resolveSuggestions } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/switches.js')).href)
const { normalise, terms } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/text.js')).href)
const { t, resolveI18n } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/i18n.js')).href)

const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
const dfDoc = JSON.parse(fs.readFileSync(path.join(RAG, manifest.df), 'utf8'))
const shards = manifest.shards.map((s) => JSON.parse(fs.readFileSync(path.join(RAG, s), 'utf8')))

/**
 * The lexical twin of this index — see the header.
 *
 * `vectors: null` is the whole trick, and the vector blob is never read off
 * disk: `assembleIndex` short-circuits before touching `vectorBuffer`.
 */
const index = assembleIndex({
  manifest: { ...manifest, vectors: null },
  shards,
  vectorBuffer: null,
  dfDoc,
})

/**
 * NOTHING ABOVE THIS LINE MAY TOKENISE, and the sibling script's shape invites
 * exactly that mistake. `opener-collisions.js` calls `setTokenizer` and
 * `setVocabulary` itself because it never assembles an index; `assembleIndex`
 * installs both from the manifest and is the only place they can be installed.
 * A `terms()` or `normalise()` call before this point runs under the default
 * vocabulary and scores against a df table built with another one.
 */
const retrieval = createRetrieval({
  index,
  scope: { kind: 'all', paths: [], label: 'All docs' },
  guard: manifest.guard,
  tuning: manifest.tuning,
})

const settingsPath = ['.vitepress/config.mjs', 'docs/.vitepress/config.mjs', 'docpilot.config.mjs']
  .map((p) => path.join(ROOT, p))
  .find((p) => fs.existsSync(p))
const settings = settingsPath ? (await import(pathToFileURL(settingsPath).href)).docPilot : {}
const suggestions = resolveSuggestions(settings || {}, () => {})
const matchTau = suggestions.matchTau
const configured = (settings?.suggestions?.questions ?? settings?.suggestions ?? null) ? openerQuestions(suggestions) : []

const df = dfDoc.df
const pageByPath = new Map(manifest.pages.map((p) => [p.path, p]))

/**
 * How much text each PAGE carries, in the tokenizer the index was built with.
 *
 * `sample-chunks.js` measures this per chunk, because there a chunk is what has
 * to ground two drafted questions. A page-level opener is grounded by the page,
 * and the lead chunk of a page is its introduction — measured on this corpus,
 * only 17 of 35 lead chunks reach `MIN_TERMS` while all 37 pages do, so gating
 * on the lead chunk would have thrown away half the site for being well
 * introduced.
 */
const pageTerms = new Map()
for (const c of index.chunks) pageTerms.set(c.path, (pageTerms.get(c.path) || 0) + terms(c.text).length)
const orphan = new Set(manifest.orphanPages || [])
const maxChunks = Math.max(...manifest.pages.map((p) => p.chunks || 0), 1)

/** Which section a page sits in, and where in its sidebar order. */
const place = new Map()
for (const s of manifest.sections) {
  s.pageIdx.forEach((pi, i) => {
    const p = manifest.pages[pi]
    if (p && !place.has(p.path)) place.set(p.path, { label: s.label, idx: i, len: s.pageIdx.length })
  })
}

/**
 * Three tiers, in descending order of "a human already wrote this".
 *
 * Tier 3 emits a SUBJECT, not a sentence — `Tell me about What it guarantees`
 * is what a heading-shaped corpus produces — and it is marked so the author
 * rewrites it. `followUps` gets away with the same wording because the reader
 * is mid-conversation and just saw the page; an empty state is a first
 * impression and does not. A second template was considered and rejected:
 * `How do I {heading}?` is ungrammatical against "What it guarantees",
 * `What is {heading}?` against "How a turn works", and most corpora carry both
 * shapes. Inventing grammar per heading is the step from "nothing invented" to
 * a generated question naming a section the corpus does not have, which is the
 * failure engine-specs/009 and ui-specs/009 refused for the default-on case.
 */
const i18n = resolveI18n({})
const template = (heading) => t(i18n, 'en', 'empty.followUp', { heading })
const TIER = { faq: 1.0, heading: 0.85, template: 0.6 }

const ordinal = /^\d+[.)]\s*/
const harvest = { faq: 0, heading: 0, template: 0 }
const raw = []

for (const c of index.chunks) {
  if (!c.title) continue
  // A continuation of a hard-split chunk carries its parent's title, so keeping
  // both is the same heading proposed twice.
  if (/~\d+$/.test(c.id)) continue
  if (orphan.has(c.path)) continue

  const title = String(c.title).replace(ordinal, '').trim()

  let tier = null
  let question = null
  if (c.kind === 'faq' || /\?\s*$/.test(title)) {
    /**
     * A QUESTION SOMEBODY ALREADY WROTE, and the only floor it gets is a word
     * count. `terms()` is content terms — it drops the stop list — so
     * "Is it a question at all?" tokenises to `["question"]`, and a
     * three-content-term floor deletes the best opener this corpus has for
     * being written in plain English. Whether the corpus can ANSWER it is the
     * gate's question, and the gate is run below.
     */
    if (title.split(/\s+/).filter(Boolean).length < 3) continue
    tier = c.kind === 'faq' ? 'faq' : 'heading'
    question = title
  } else {
    /**
     * TEMPLATES COME OFF PAGES, NOT OFF SUB-HEADINGS, and the first draft of
     * this script did the opposite and was worse for it: ranking every heading
     * on a 119-chunk reference page put "Tell me about An unnamed embedder, and
     * why it does not rotate" on the empty state, because page mass rewarded
     * every heading the page had. A page title is written to stand alone; a
     * sub-heading is written to sit under one, and only the first of those can
     * be read cold. `anchor === ''` is the page's lead chunk.
     *
     * `MIN_TERMS` GATES THIS TIER ONLY. `sample-chunks.js` uses it to ask
     * whether a chunk can GROUND a drafted question, which is the job here for
     * a template and not the job for the other two: a faq entry and an
     * interrogative heading are questions somebody already wrote, and whether
     * the corpus answers them is what the gate below measures. Applying it to
     * all three cost this corpus its one interrogative heading — a 654-byte
     * chunk whose title is a better opener than anything the template tier
     * produced.
     */
    if (c.anchor !== '') continue
    if ((pageTerms.get(c.path) || 0) < MIN_TERMS) continue
    const pageTitle = pageByPath.get(c.path)?.title || title
    if (!pageTitle || pageTitle.split(/\s+/).filter(Boolean).length < 2) continue
    tier = 'template'
    question = template(pageTitle)
  }
  harvest[tier]++
  if (!TIERS.has(tier)) continue

  raw.push({ tier, question, chunk: c })
}

/** The real gate, lexical-only — see the header for what the number is not. */
const scored = []
for (const cand of raw) {
  const g = retrieval.evaluate({ question: cand.question, previousQuestion: null, queryVec: null })
  const page = pageByPath.get(cand.chunk.path)
  const where = place.get(cand.chunk.path) || { label: '(no section)', idx: 0, len: 1 }
  const mass = (page?.chunks || 1) / maxChunks
  const prominence = where.len > 1 ? 1 - where.idx / (where.len - 1) : 1
  const spread = new Set(g.chunks.map((x) => x.path)).size / Math.max(g.chunks.length, 1)
  const score = TIER[cand.tier] * (0.45 * g.G + 0.25 * mass + 0.2 * prominence + 0.1 * spread)
  scored.push({ ...cand, G: g.G, pass: g.pass, mass, prominence, spread, score, section: where.label, page, where })
}

/**
 * A refused candidate does not get a lower score — it goes below every passing
 * one wholesale. Ranking a refusal down still leaves it able to win a thin
 * field, and the one thing this proposal must never do is put a refusal where
 * the first click lands.
 */
scored.sort(
  (a, b) =>
    Number(b.pass) - Number(a.pass) ||
    b.score - a.score ||
    (a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0),
)

const rejected = []

// Already chosen: `feedback faq` reports these and this has nothing to add.
const configuredKeys = new Set(configured.map(normalise))

/**
 * ONE PER PAGE, APPLIED AFTER THE SORT AND NOT DURING THE HARVEST.
 *
 * A page that answers two openers is a page advertised twice, and
 * `sample-chunks.js` already records that one question per page teaches more
 * than three questions about one page. But taking the FIRST candidate a page
 * offers rather than its BEST is how this corpus lost its one interrogative
 * heading: the page's lead chunk claimed the page before the loop reached the
 * heading four chunks later.
 */
const seenPage = new Set()
const seenKey = new Set()
const eligible = scored.filter((c) => {
  const key = normalise(c.question)
  if (configuredKeys.has(key)) return false
  // The same key `matchOpener` looks an entry up by — two candidates that
  // normalise alike are one candidate.
  if (seenKey.has(key)) return false
  if (seenPage.has(c.chunk.path)) return false
  seenKey.add(key)
  seenPage.add(c.chunk.path)
  return true
})

/**
 * Two passes. Round one takes the best of each section, sections visited in the
 * order their best candidate ranks; round two fills what is left from the
 * runners-up. A hard one-per-section rule on a two-section site produces two
 * chips, and a rule that cannot produce `--n` is a rule that silently redefines
 * it. The precedent is `sample-chunks.js`: one section there held 916 of 1191
 * chunks, so ranking without a per-section allowance would put four of five
 * chips in one part of the site and advertise a quarter of it.
 */
const takenPerSection = new Map()
const chosen = []
const collidesWith = (q) => {
  if (matchTau > 1) return null
  for (const p of chosen) if (similarity(p.question, q, df) >= matchTau) return p
  for (const o of configured) if (similarity(o, q, df) >= matchTau) return { question: o, configuredOpener: true }
  return null
}
const probes = fs.existsSync(PROBES)
  ? fs
      .readFileSync(PROBES, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.question)
  : null

/**
 * `opener-collisions.js`'s measurement, applied to the PROPOSAL rather than to
 * the config: a probe is not an opener, so a candidate within `matchTau` of one
 * is a chip that will swallow a different question and answer it — correctly
 * cited, about the other thing. Rejecting here is what makes the two scripts
 * agree by construction, so the author does not have to run the second one to
 * discover the first proposed a trap.
 */
const probeHit = (q) => {
  if (!probes || matchTau > 1) return null
  let worst = null
  for (const p of probes) {
    if (normalise(p.question) === normalise(q)) continue
    const s = similarity(q, p.question, df)
    if (!worst || s > worst.score) worst = { score: s, probe: p }
  }
  return worst
}

const consider = (cand, allowance) => {
  const taken = takenPerSection.get(cand.section) || 0
  if (taken >= allowance) return false
  const hit = collidesWith(cand.question)
  if (hit) {
    rejected.push({ cand, why: 'COLLIDES', with: hit })
    return false
  }
  const pr = probeHit(cand.question)
  if (pr && pr.score >= matchTau) {
    rejected.push({ cand, why: 'PROBE', probe: pr })
    return false
  }
  cand.probe = pr
  chosen.push(cand)
  takenPerSection.set(cand.section, taken + 1)
  return true
}

for (const cand of eligible) {
  if (chosen.length >= N) break
  consider(cand, PER_SECTION)
}
for (const cand of eligible) {
  if (chosen.length >= N) break
  if (chosen.includes(cand)) continue
  if (rejected.some((r) => r.cand === cand)) continue
  consider(cand, Infinity)
}

/**
 * Printed by score, not by the order the two passes filled the slots.
 *
 * The selection is per-section and therefore not monotonic in score — round two
 * adds a second candidate from a section round one already served, and it can
 * outrank a round-one pick from a thinner section. A table whose score column
 * goes down and then up reads as a bug in the ranking rather than as the
 * diversity rule working, so the sort happens here, after selection is done.
 */
chosen.sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1))

const pad = (s, n) => String(s).padEnd(n)
const f2 = (x) => x.toFixed(2)
const rel = (p) => path.relative(ROOT, p)

console.log(
  `\n  corpus     ${manifest.chunkCount} chunks · ${manifest.pages.length} pages · ` +
    `${manifest.sections.length} sections · index ${manifest.hash}`,
)
console.log(
  `  harvest    ${harvest.faq} faq · ${harvest.heading} interrogative · ${harvest.template} template` +
    `  (${eligible.length} candidates after exclusions)`,
)
console.log(
  `  gate       lexical-only through the real retriever · tauLexical ${manifest.guard.tauLexical} · 0 requests`,
)
console.log(`  matchTau   ${matchTau}${settingsPath ? `  (${rel(settingsPath)})` : '  (no site config found)'}`)
console.log(`  configured ${configured.length ? configured.map((q) => JSON.stringify(q)).join(', ') : 'none — the built-in three are in force'}`)
console.log(`  probes     ${probes ? `${probes.length} from ${rel(PROBES)}` : `none at ${rel(PROBES)} — the probe column is omitted`}`)

console.log(`\n  PROPOSED — ${chosen.length} of ${eligible.length}, at most ${PER_SECTION} per section, no pair within matchTau\n`)
console.log('     score  tier      G        mass  prom  sprd  probe  section')
chosen.forEach((c, i) => {
  console.log(
    `  ${pad(i + 1, 2)} ${f2(c.score)}   ${pad(c.tier, 9)}${f2(c.G)} ${c.pass ? '✓' : '✗'}  ` +
      `${f2(c.mass)}  ${f2(c.prominence)}  ${f2(c.spread)}  ${c.probe ? f2(c.probe.score) : '  — '}  ${c.section}`,
  )
  console.log(`     ${JSON.stringify(c.question)}${c.tier === 'template' ? '   ← EDIT THIS' : ''}`)
  console.log(
    `     ${c.chunk.id} · page ${c.page?.chunks ?? '?'} chunk(s) · ${c.where.idx + 1} of ${c.where.len} in section`,
  )
})

const runners = eligible.filter((c) => !chosen.includes(c) && !rejected.some((r) => r.cand === c)).slice(0, POOL)
if (runners.length) {
  console.log(`\n  RUNNERS-UP — the next ${runners.length}, in score order, to substitute from\n`)
  for (const c of runners) {
    console.log(`    ${f2(c.score)}  ${pad(c.tier, 9)}${c.pass ? '✓' : '✗'}  ${JSON.stringify(c.question)}  [${c.section}]`)
  }
}

if (rejected.length) {
  console.log('\n  REJECTED — and why\n')
  for (const r of rejected) {
    if (r.why === 'COLLIDES') {
      console.log(
        `    COLLIDES  ${JSON.stringify(r.cand.question)}\n` +
          `              with ${JSON.stringify(r.with.question)}` +
          `${r.with.configuredOpener ? ' (already configured)' : ''} at or above matchTau ${matchTau}`,
      )
    } else {
      console.log(
        `    PROBE     ${JSON.stringify(r.cand.question)}\n` +
          `              scores ${f2(r.probe.score)} against ${r.probe.probe.id ?? '?'} ` +
          `${JSON.stringify(r.probe.probe.question)} — it would swallow it`,
      )
    }
  }
}

const refused = chosen.filter((c) => !c.pass)
if (refused.length) {
  console.log(
    `\n  ${refused.length} of the proposals ${refused.length === 1 ? 'is' : 'are'} below ` +
      `tauLexical ${manifest.guard.tauLexical}, marked ✗ above.`,
  )
  console.log('  That is a warning, not a refusal — see the note below.')
}

console.log('\n  ───────────────────────────────────────────────────────────────────')

/**
 * An empty paste block is worse than no paste block: it looks like a result.
 * Reachable on a narrow `--tiers=`, on a corpus of one-word page titles, and on
 * a site whose openers are all configured already — three different states that
 * all mean "there is nothing here to propose".
 */
if (!chosen.length) {
  console.log('  NOTHING TO PROPOSE. The harvest above says which tier came up empty;')
  console.log('  widen `--tiers=`, lower `--min-terms=`, or write the questions yourself —')
  console.log('  this reads the corpus and the corpus has not phrased one.\n')
  process.exit(0)
}

console.log('  A PROPOSAL. Every line is a draft; a `template` row is a SUBJECT,')
console.log('  not a sentence, and reads as one until you rewrite it.\n')
console.log('```js')
console.log('suggestions: {')
console.log('  questions: [')
for (const c of chosen) console.log(`    ${JSON.stringify(c.question)},`)
console.log('  ],')
console.log('}')
console.log('```\n')
console.log('  Then `npx docpilot index` and read its `openers` block — THAT is the')
console.log(`  verdict. This scored the LEXICAL channel against tauLexical ${manifest.guard.tauLexical}; the`)
console.log(`  panel's gate is hybrid at tau ${manifest.guard.tau} and the dense channel carries`)
console.log(`  ${manifest.guard.wDense} of it, so a ✓ above is a floor and a ✗ is a warning.\n`)
console.log(`  ${chosen.length} openers with suggestions.answers on cost ${chosen.length} embedding +`)
console.log(`  ${chosen.length} model requests on the next build, and again whenever you edit ONE`)
console.log('  of them — the bundle is fingerprinted over the whole list.\n')
