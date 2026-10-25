/**
 * The two ways an improvement loop cheats, caught before its numbers are read —
 * engine-spec 035.
 *
 *   · TEACHING TO THE TEST. A corpus edit that pastes a gold answer into the
 *     page scores perfectly on that record and proves nothing. The edit is
 *     compared with the TEST split's gold answers by word 8-grams — the overlap
 *     unit contamination checks use — and any shared run is named.
 *   · MOVING THE GOALPOSTS. The golden set, the calibration probes, the chains
 *     and the security probes are the measurement; an edit to any of them in
 *     the same change as a corpus edit makes before and after incomparable.
 *
 * Read off `git`, against a ref: what was ADDED to the docs since then.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const NGRAM = 8

const words = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

export function ngrams(text: string, n = NGRAM) {
  const w = words(text)
  const out = new Set<string>()
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

/** Added text per file under `dir` since `ref` — tracked diffs and new files. */
export function addedSince(root: string, dir: string, ref = 'HEAD') {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = new Map<string, string>()
  const diff = git(['diff', '--unified=0', '--no-color', ref, '--', dir])
  let file = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '')
    else if (file && line.startsWith('+') && !line.startsWith('+++')) out.set(file, `${out.get(file) || ''}${line.slice(1)}\n`)
  }
  for (const f of git(['ls-files', '--others', '--exclude-standard', '--', dir]).split('\n').filter(Boolean)) {
    if (/\.(md|mdx|txt)$/i.test(f)) out.set(f, fs.readFileSync(path.join(root, f), 'utf8'))
  }
  return out
}

/** Eval-set files changed since `ref` — the measurement moving with the thing measured. */
export function measurementTouched(root: string, evalDir: string, ref = 'HEAD') {
  const files = ['golden.jsonl', 'calibration.jsonl', 'chains.jsonl', 'adversarial.jsonl'].map((f) => path.join(evalDir, f))
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const changed = git(['diff', '--name-only', ref, '--', ...files]).split('\n').filter(Boolean)
  return changed
}

export function leaks(added: Map<string, string>, records: any[], { split = 'test' } = {}) {
  const gold = records.filter((r) => r.gold_answer && (!split || r.split === split || !r.split))
  const index = new Map<string, string[]>()
  for (const r of gold) for (const g of ngrams(r.gold_answer)) index.set(g, [...(index.get(g) || []), r.id])
  const found = []
  for (const [file, text] of added) {
    for (const g of ngrams(text)) {
      const ids = index.get(g)
      if (ids) found.push({ file, ngram: g, records: ids })
    }
  }
  return found
}
