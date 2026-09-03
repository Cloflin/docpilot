#!/usr/bin/env node
/**
 * The empirical false-positive floor for `suggestions.matchCos` — engine-specs/017.
 *
 *   node {{SKILL_DIR}}/scripts/opener-cosines.js \
 *     [--rag=docs/public/rag] [--probes=docpilot/calibration.jsonl] [--top=10] [--limit=0]
 *
 * `opener-collisions.js`'s twin, and the pair is the point: that one measures the
 * LEXICAL match and this one measures the DENSE one. They fail on opposite
 * inputs — lexical coverage returns exactly zero for a paraphrase built out of
 * different words, and cosine returns 0.35 for a question about nothing in
 * particular — so the two thresholds cannot be reasoned about from one number.
 *
 * IT COSTS REQUESTS, and that is the whole difference from its twin. One request
 * per probe: `embedQuery` embeds one string, which is also what guarantees the
 * `search_query:` prefix a batch built for documents would get wrong. So the
 * default is `--limit=100` rather than the whole set — a subset is a worse
 * measurement than all 597 and a far better one than a spent allowance.
 *
 * ON A METERED FREE TIER, RUN IT AGAINST THE OTHER INDEX. The second index the
 * indexing guide describes — a local Ollama over the same corpus — is free and
 * is a LOWER BOUND: a weaker embedder separates paraphrase from probe less
 * cleanly, so a `matchCos` that holds there holds on the deployed one.
 *
 *   node {{SKILL_DIR}}/scripts/opener-cosines.js --rag=docs/public/rag-local --limit=0
 *
 * The openers themselves are FREE: their vectors ship in the openers bundle,
 * quantised exactly as the panel reads them, so what is scored here is the vector
 * a reader will actually be compared against — not a fresh embedding of the same
 * string.
 *
 * WHAT IT MEASURES. Every probe against every opener. A probe is not an opener —
 * the calibration set is questions about the corpus, written for another purpose
 * — so **every score it produces is a false positive waiting to happen**, and the
 * highest is the floor `matchCos` has to sit above. Unlike the lexical sweep the
 * distribution matters as much as the maximum: a dense embedder's cosines do not
 * start at zero, so the gap between "unrelated" and "the same question" can be
 * narrower than the numbers look.
 *
 * WHAT IT IS NOT. Not a calibration in the sense `docpilot calibrate` means:
 * nothing here is written into `calibration.json`, and `matchCos` stays a config
 * constant. This prints a number a person decides with.
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
const TOP = Number(arg('top', '10'))
// 0 means all of them, and it is not the default — see the header.
const LIMIT = Number(arg('limit', '100'))

const dist = path.join(ROOT, 'dist')
const { embedQuery } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/embed.js')).href)
const { openerQuestions } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/openers.js')).href)
const { resolveSuggestions } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/switches.js')).href)
const { nodeEmbedTarget } = await import(pathToFileURL(path.join(dist, 'config.js')).href)

const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
if (!manifest.openers) {
  console.error('  This index has no openers bundle. `suggestions.precomputed` is off, or the\n' +
    '  index predates it. There is nothing to compare a query against — run `npx docpilot index`.')
  process.exit(1)
}
const bundle = JSON.parse(fs.readFileSync(path.join(RAG, manifest.openers), 'utf8'))

const settingsPath = ['.vitepress/config.mjs', 'docs/.vitepress/config.mjs', 'docpilot.config.mjs']
  .map((p) => path.join(ROOT, p))
  .find((p) => fs.existsSync(p))
const settings = settingsPath ? (await import(pathToFileURL(settingsPath).href)).docPilot : {}
const suggestions = resolveSuggestions(settings || {}, () => {})
const openers = openerQuestions(suggestions)
const tau = suggestions.matchCos

/**
 * The opener's vector as the PANEL reads it — int8, widened, still scaled by 127.
 *
 * Re-embedding the opener string here would measure a different vector than the
 * one that ships, by the quantisation error, which is the size of the decision
 * this script exists to inform.
 */
const widen = (b64) => {
  const bin = Buffer.from(b64, 'base64')
  const signed = new Int8Array(bin.buffer, bin.byteOffset, bin.length)
  return Float64Array.from(signed)
}
const vecs = bundle.entries.filter((e) => e.vec).map((e) => ({ q: e.q, v: widen(e.vec) }))
if (!vecs.length) {
  console.error('  The openers bundle carries no vectors — this is a lexical-only index, where\n' +
    '  `matchCos` never runs. Nothing to measure.')
  process.exit(1)
}

// Both sides are L2-normalised and multiplied by 127 (`embed.js`), which is what
// makes the dot product a cosine — `retriever.js`'s own `/ 16129`.
const cosine = (a, b) => {
  let s = 0
  for (let i = 0; i < b.length; i++) s += a[i] * b[i]
  return s / 16129
}

const openerKeys = new Set(openers.map((q) => q.toLowerCase()))
let probes = fs
  .readFileSync(PROBES, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.question && !openerKeys.has(String(r.question).toLowerCase()))
if (LIMIT > 0) probes = probes.slice(0, LIMIT)

/**
 * THE EMBEDDER THE INDEX WAS BUILT WITH, and the script refuses to run on any
 * other.
 *
 * A cosine between a query embedded by one model and an opener embedded by
 * another is a number, and it is not a measurement of anything. This is the same
 * check `embedderMatchesIndex` makes in the panel and the same one the build
 * makes before inlining a calibration; it is here because this script's whole
 * output is a threshold somebody will then ship.
 *
 * The config is read the way `index` reads it, so a second index is measured the
 * way it was built — `DOCPILOT_EMBED_LOCAL=1 ... --rag=docs/public/rag-local`.
 * `--model=` and `--base-url=` are the escape hatch for a target the config
 * cannot express.
 */
const target = nodeEmbedTarget(settings || {}, process.env)
const opts = {
  provider: arg('provider', target.provider),
  baseURL: arg('base-url', target.baseURL),
  model: arg('model', target.model || target.models?.[0] || null),
  apiKey: target.apiKey,
}
if (opts.model !== manifest.embedModel) {
  console.error(
    `\n  This index was built with ${JSON.stringify(manifest.embedModel)} and the settings resolve
` +
      `  to ${JSON.stringify(opts.model)}. Scoring a query from one vector space against openers\n` +
      `  from another measures nothing.\n\n` +
      `  Run it the way you build the index — for a second index that is\n` +
      `    DOCPILOT_EMBED_LOCAL=1 node <skill>/scripts/opener-cosines.js --rag=docs/public/rag-local\n` +
      `  or name the target: --model=${manifest.embedModel} --base-url=…\n`,
  )
  process.exit(1)
}

console.log(`\n  openers   ${vecs.length} with vectors, from ${path.relative(ROOT, path.join(RAG, manifest.openers))}`)
console.log(`  embedder  ${opts.provider}/${opts.model}`)
console.log(`  probes    ${probes.length} from ${path.relative(ROOT, PROBES)}`)
console.log(`  cost      ${probes.length} request(s)${LIMIT > 0 ? `  (--limit=${LIMIT}; --limit=0 for all)` : ''}\n`)

const scored = []
let done = 0
for (const p of probes) {
  const v = Float64Array.from(await embedQuery(p.question, opts))
  for (const o of vecs) scored.push({ score: cosine(v, o.v), probe: p, opener: o.q })
  if (++done % 50 === 0) process.stderr.write(`  embedded ${done}/${probes.length}\r`)
}
scored.sort((a, b) => b.score - a.score)

console.log('  THE FLOOR — the highest cosine a probe that is NOT an opener reaches.')
console.log('  matchCos has to sit above this, with room.\n')
for (const s of scored.slice(0, TOP)) {
  console.log(`    ${s.score.toFixed(3)}  ${JSON.stringify(s.probe.question)}`)
  console.log(`           would match ${JSON.stringify(s.opener)}  [${s.probe.id ?? '?'}/${s.probe.stratum ?? '?'}]`)
}

console.log('\n  How many probes each threshold would wrongly capture:\n')
for (const t of [0.5, 0.6, 0.65, 0.7, 0.72, 0.75, 0.8, 0.85, 0.9]) {
  const n = scored.filter((s) => s.score >= t).length
  console.log(`    ${t.toFixed(2)}   ${String(n).padStart(4)} probe(s)${t === tau ? '   <- configured' : ''}`)
}

/**
 * The other half of the decision, and the reason the floor alone is not enough.
 *
 * A threshold above every false positive is trivially reachable by setting it to
 * 1. What makes a number usable is the DISTANCE between that floor and the
 * paraphrases the feature exists to catch — and this script cannot know your
 * paraphrases. What it can do is show the spread it did measure, so the floor is
 * read against something.
 */
const all = scored.map((s) => s.score).sort((a, b) => a - b)
const at = (q) => all[Math.floor((all.length - 1) * q)]
console.log('\n  The spread these probes produced — a dense embedder does not start at zero:\n')
console.log(`    min ${at(0).toFixed(3)}   p50 ${at(0.5).toFixed(3)}   p90 ${at(0.9).toFixed(3)}   max ${at(1).toFixed(3)}`)
console.log('\n  Write four or five paraphrases of your own openers, score them the same way,')
console.log('  and put matchCos between the two groups. If they overlap, the openers are')
console.log('  too close to the corpus to be matched densely — set matchCos: false.\n')

const pairs = []
for (let i = 0; i < vecs.length; i++) {
  for (let j = i + 1; j < vecs.length; j++) {
    pairs.push({ a: vecs[i].q, b: vecs[j].q, score: cosine(vecs[i].v, vecs[j].v) })
  }
}
pairs.sort((a, b) => b.score - a.score)
console.log('  Openers against each other — within 0.05 of one another the panel refuses the tie:\n')
for (const c of pairs) {
  console.log(`    ${c.score.toFixed(3)}  ${JSON.stringify(c.a)}  vs  ${JSON.stringify(c.b)}`)
}
console.log('')
