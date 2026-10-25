/**
 * `contamination` — did the training file see the exam? PURE.
 *
 * WHY IT MATTERS HERE. `docpilot dataset` builds training data from real turns,
 * and real readers ask the same questions the golden set asks. A checkpoint
 * trained on a golden question and its answer scores well on `eval` because it
 * memorised the answer key, and `compare` would then certify a regression as
 * an improvement. This check runs before `compare` is believed.
 *
 * THE TEST IS GPT-3's: a 13-gram overlap after normalisation
 * (https://arxiv.org/abs/2005.14165, appendix C). Thirteen tokens is long
 * enough that a shared span is not an accident of common phrasing, and short
 * enough to catch a paraphrase that kept one sentence. A golden text shorter
 * than n tokens has no n-gram at all, so it is matched whole, as a contiguous
 * span of a training text.
 *
 * THE INDEX IS BUILT OVER THE GOLDEN SET, NOT THE TRAINING FILE. The golden set
 * is tens of records; a training file can be gigabytes. Hashing every training
 * n-gram into a set would hold the whole file in memory, so the training text
 * is streamed past a small map of golden n-grams instead.
 */

/**
 * Lowercase, NFKC, punctuation to spaces, whitespace collapsed, split.
 *
 * `\p{L}\p{M}\p{N}` and not `\w`: `\w` is ASCII-only in JavaScript, and would
 * delete every Cyrillic letter as punctuation.
 */
export function normalizeTokens(text: string) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
}

/**
 * Every human-readable string in one training record.
 *
 * Known shapes first — OpenAI chat `{messages}`, TRL `{prompt, completion}`,
 * `{prompt, chosen, rejected}`, plain `{text}` — and each string is its own
 * unit, so an n-gram never spans the seam between two messages. A content field
 * may be a string or an array of `{type: 'text', text}` parts; TRL's
 * conversational form puts message arrays inside `prompt`/`chosen`.
 */
export function extractTrainTexts(record): string[] {
  const out = []
  const content = (c) => {
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) for (const part of c) content(part)
    else if (c && typeof c === 'object') {
      if (typeof c.text === 'string') out.push(c.text)
      else if (c.content !== undefined) content(c.content)
    }
  }
  if (!record || typeof record !== 'object') return out
  for (const k of ['messages', 'prompt', 'completion', 'chosen', 'rejected', 'text', 'input', 'output', 'instruction', 'response']) {
    if (record[k] !== undefined) content(record[k])
  }
  return out
}

/**
 * The golden index and a scanner over training text.
 *
 * @param golden records with `id`, `question`, `gold_answer`
 * @param n the n-gram length, 13 by default
 */
export function createContaminationIndex(golden: any[], n = 13) {
  /** n-gram (or whole short text) → ids that contain it */
  const grams = new Map<string, Set<string>>()
  /** id → the distinct keys that record contributes, for the overlap ratio */
  const own = new Map<string, Set<string>>()
  /** lengths of short texts matched whole; scanned in addition to n */
  const lengths = new Set<number>([n])

  for (const g of golden) {
    const id = String(g.id)
    const keys = own.get(id) ?? new Set<string>()
    for (const text of [g.question, g.gold_answer]) {
      const t = normalizeTokens(text)
      if (!t.length) continue
      if (t.length < n) {
        keys.add(t.join(' '))
        lengths.add(t.length)
      } else for (let i = 0; i + n <= t.length; i++) keys.add(t.slice(i, i + n).join(' '))
    }
    own.set(id, keys)
    for (const k of keys) {
      if (!grams.has(k)) grams.set(k, new Set())
      grams.get(k).add(id)
    }
  }

  const hit = new Map<string, Set<string>>()
  let units = 0
  return {
    /** Feed one training text unit. */
    scan(text: string) {
      units++
      const t = normalizeTokens(text)
      for (const len of lengths) {
        for (let i = 0; i + len <= t.length; i++) {
          const k = t.slice(i, i + len).join(' ')
          const ids = grams.get(k)
          if (!ids) continue
          for (const id of ids) {
            // A short key is only the record's OWN whole text; a 13-gram key
            // can match a longer record through any of its windows.
            if (!hit.has(id)) hit.set(id, new Set())
            hit.get(id).add(k)
          }
        }
      }
    },
    result() {
      const records = [...own.entries()].map(([id, keys]) => {
        const matched = hit.get(id)?.size ?? 0
        return {id, ngrams: keys.size, matched, overlap: keys.size ? matched / keys.size : 0, contaminated: matched > 0}
      })
      const contaminated = records.filter((r) => r.contaminated)
      return {
        n,
        units,
        golden: records.length,
        contaminated: contaminated.map((r) => r.id),
        rate: records.length ? contaminated.length / records.length : 0,
        records,
      }
    },
  }
}

/** One-shot form for tests and small inputs: `texts` is every training text unit. */
export function ngramContamination(golden: any[], texts: Iterable<string>, o: {n?: number} = {}) {
  const idx = createContaminationIndex(golden, o.n ?? 13)
  for (const t of texts) idx.scan(t)
  return idx.result()
}

/** The markdown report. PURE. */
export function renderContamination(r, meta: {train?: string; golden?: string; skipped?: number} = {}) {
  const out = ['# Training-set contamination', '']
  out.push(
    `${meta.train ?? 'train'} (${r.units} text unit(s)${meta.skipped ? `, ${meta.skipped} unparseable line(s) skipped` : ''}) ` +
      `against ${meta.golden ?? 'golden'} (${r.golden} record(s)), ${r.n}-gram overlap after normalisation.`,
  )
  out.push('')
  out.push(`**${r.contaminated.length} of ${r.golden} golden record(s) contaminated (${(r.rate * 100).toFixed(1)}%).**`)
  out.push('')
  if (r.contaminated.length) {
    out.push('| id | matched / n-grams | overlap |')
    out.push('| --- | --- | --- |')
    for (const x of r.records.filter((x) => x.contaminated).sort((a, b) => b.overlap - a.overlap)) {
      out.push(`| ${x.id} | ${x.matched} / ${x.ngrams} | ${(x.overlap * 100).toFixed(1)}% |`)
    }
    out.push('')
    out.push(
      'A checkpoint trained on these rows has seen their questions or answers. Its `eval` score on them measures recall of ' +
        'the answer key, not grounding. Remove the rows from the training file, or drop the records from any `compare`.',
    )
  }
  return out.join('\n') + '\n'
}
