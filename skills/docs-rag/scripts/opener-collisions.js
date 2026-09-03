#!/usr/bin/env node
/**
 * The empirical false-positive floor for `suggestions.matchTau` — engine-specs/009.
 *
 *   node {{SKILL_DIR}}/scripts/opener-collisions.js \
 *     [--rag=docs/public/rag] [--probes=docpilot/calibration.jsonl] [--top=10]
 *
 * `matchTau` decides when a TYPED question is treated as one of the openers the
 * build already resolved. Too high and the feature only fires on an exact match;
 * too low and a reader asking about one thing is handed the answer to another,
 * cited correctly, about the other thing. The second failure is silent, so the
 * threshold wants a measurement rather than a taste.
 *
 * This is that measurement, and it costs NOTHING: the scorer is
 * `lexicalCoverage` in both directions, which is pure, local and already the
 * number the gate is expressed in. No embedder, no model, seconds.
 *
 * WHAT IT MEASURES. Every probe in the calibration set is scored against every
 * configured opener. A probe is not an opener — the calibration set is questions
 * about the corpus, written for a different purpose — so **every score it
 * produces is a false positive waiting to happen**. The highest of them is the
 * floor `matchTau` has to sit above, and the distribution around it says by how
 * much.
 *
 * It also scores the openers against each other, which is the same check
 * `docpilot index` prints as `COLLIDES`. Two openers within `matchTau` of one
 * another cannot both be matched, and the panel refuses the tie.
 *
 * WHAT IT IS NOT. Not a calibration in the sense `docpilot calibrate` means:
 * nothing here is written into `calibration.json` or `tuning.json`, and
 * `matchTau` stays a config constant. This prints a number a person decides
 * with.
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

const dist = path.join(ROOT, 'dist')
const { setTokenizer, setVocabulary } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/text.js')).href)
const { similarity, openerQuestions } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/openers.js')).href)
const { resolveSuggestions } = await import(pathToFileURL(path.join(dist, 'theme/docpilot/switches.js')).href)

const manifest = JSON.parse(fs.readFileSync(path.join(RAG, 'manifest.json'), 'utf8'))
const { df } = JSON.parse(fs.readFileSync(path.join(RAG, manifest.df), 'utf8'))

// The tokenizer the INDEX was built with, or the scores are of a different
// vocabulary than the one the panel will use.
setTokenizer(manifest.tokenizer || null)
setVocabulary(manifest.vocabulary || null)

const settingsPath = ['.vitepress/config.mjs', 'docs/.vitepress/config.mjs', 'docpilot.config.mjs']
  .map((p) => path.join(ROOT, p))
  .find((p) => fs.existsSync(p))
const settings = settingsPath ? (await import(pathToFileURL(settingsPath).href)).docPilot : {}
const openers = openerQuestions(resolveSuggestions(settings || {}, () => {}))
const tau = resolveSuggestions(settings || {}, () => {}).matchTau

const probes = fs
  .readFileSync(PROBES, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.question)

const openerKeys = new Set(openers.map((q) => q.toLowerCase()))
const scored = []
for (const p of probes) {
  if (openerKeys.has(String(p.question).toLowerCase())) continue
  for (const o of openers) scored.push({ score: similarity(p.question, o, df), probe: p, opener: o })
}
scored.sort((a, b) => b.score - a.score)

const at = (t) => scored.filter((s) => s.score >= t).length

console.log(`\n  openers   ${openers.length}`)
for (const o of openers) console.log(`            ${JSON.stringify(o)}`)
console.log(`  probes    ${probes.length} from ${path.relative(ROOT, PROBES)}`)
console.log(`  pairs     ${scored.length} scored, 0 requests\n`)

console.log('  THE FLOOR — the highest score a probe that is NOT an opener reaches.')
console.log('  matchTau has to sit above this, with room.\n')
for (const s of scored.slice(0, TOP)) {
  console.log(`    ${s.score.toFixed(3)}  ${JSON.stringify(s.probe.question)}`)
  console.log(`           would match ${JSON.stringify(s.opener)}  [${s.probe.id ?? '?'}/${s.probe.stratum ?? '?'}]`)
}

console.log('\n  How many probes each threshold would wrongly capture:\n')
for (const t of [0.5, 0.6, 0.667, 0.7, 0.75, 0.8, 0.9, 1]) {
  const n = at(t)
  console.log(`    ${t.toFixed(3)}   ${String(n).padStart(4)} probe(s)${t === tau ? '   <- configured' : ''}`)
}

const collisions = []
for (let i = 0; i < openers.length; i++) {
  for (let j = i + 1; j < openers.length; j++) {
    collisions.push({ a: openers[i], b: openers[j], score: similarity(openers[i], openers[j], df) })
  }
}
collisions.sort((a, b) => b.score - a.score)
console.log('\n  Openers against each other — a pair at or above matchTau refuses the tie:\n')
for (const c of collisions) {
  console.log(`    ${c.score.toFixed(3)}  ${JSON.stringify(c.a)}  vs  ${JSON.stringify(c.b)}`)
}
console.log('')
