/**
 * Identifier support — RAG-SPEC 5.3.
 *
 * RECORDED, NEVER ENFORCED. It changes no pixel and no state. It was specified
 * as a blocking check and three facts killed that: its input is undefined at
 * runtime while the golden set gets it from a human; a check that disappears
 * whenever chunk text is not resident is not a check; and the metric over it
 * would have read 0.00 forever if a blocking check made its condition
 * unreachable.
 */

const IDENTIFIER = [
  ['fenced', /`([^`\n]{2,80})`/g],
  ['dotted', /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g],
  ['camel', /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g],
  ['constant', /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*\b/g],
  ['route', /(?:^|\s)(\/[a-z0-9][\w./-]*)/g],
  ['header', /\b[A-Z][a-z]+(?:-[A-Z][a-z]+)+\b/g],
]

const HTTP_CODE = /^[1-5]\d\d$/
const VERSION = /^v?\d+(\.\d+)*$/

/** Applied in order, first match wins, deduplicated case-sensitively. */
export function identifiers(text, question = '') {
  const src = String(text || '')
  const taken = []
  const out = new Set()
  const fromQuestion = new Set(extractRaw(String(question)))

  for (const [, re] of IDENTIFIER) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      const value = (m[1] ?? m[0]).trim()
      const start = m.index
      const end = start + m[0].length
      if (taken.some(([s, e]) => start < e && end > s)) continue
      taken.push([start, end])
      if (value.length < 3) continue
      if (HTTP_CODE.test(value) || VERSION.test(value)) continue
      if (fromQuestion.has(value)) continue
      out.add(value)
    }
  }
  return [...out]
}

function extractRaw(text) {
  const out = []
  for (const [, re] of IDENTIFIER) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) out.push((m[1] ?? m[0]).trim())
  }
  return out
}

/**
 * @returns {number|null} 1 when there are fewer than `min` identifiers,
 *                        null when the cited chunk text is not in memory.
 */
export function computeSupport(answerText, sources, question, min = 3) {
  const ids = identifiers(answerText, question)
  if (ids.length < min) return 1
  if (!sources?.length || sources.some((s) => typeof s?.text !== 'string')) return null
  const haystack = sources.map((s) => s.text).join('\n')
  const present = ids.filter((id) => haystack.includes(id)).length
  return present / ids.length
}
