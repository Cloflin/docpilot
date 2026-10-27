/**
 * The answer's citation markers, settled against the list that survived
 * validation — engine-spec 039.
 *
 * The instruction asks for `[1]`, `[2]` in `text` and for section ids in
 * `citations`. A model mixes the two and writes the id itself inside the
 * brackets: `[editor-configuration/image-storage#connecting-your-own-server]`.
 * Measured on a production docs site with gpt-6-luna at reasoning 'low',
 * before the instruction was split: 13 of 16 replays of one turn, 5 of 6 live
 * turns. `linkMarkers` links `[n]` and nothing else, so every one of those
 * reached the reader as plain text — the Sources row was right and the claim
 * had no link.
 *
 * REWRITTEN HERE, ONCE, BEFORE ANYTHING READS THE ANSWER. `finish()` is what the
 * panel, the server runtime and the eval all settle, and the server SIGNS what
 * it returns (engine-spec 033). A rewrite in the renderer would leave the signed
 * text and the shown text two different strings, and the turn log, the cache
 * and a training export would keep the id.
 *
 * A NUMBER IS A POSITION IN THE LIST THE MODEL SENT. `finish()` drops phantoms
 * from that list, so the model's `[2]` after a dropped `[1]` is the validated
 * list's first entry, and it is renumbered here. A number whose entry was a
 * phantom, or that is past the end of the list, is DELETED — `linkMarkers`
 * deleted it at render time before, and left in the text it would point at
 * whatever an id the text cites is appended as.
 *
 * APPEND, NEVER REORDER. An id the text cites and the list forgot takes the next
 * free position. It is appended only when `known` accepts it — the predicate
 * `finish()` filters the list with — so the text is not a second way in.
 */

// One bracket on one line, no nesting, with the one space before it so that a
// deleted marker does not leave "claim ." behind. `[a#x][b#y]` is two matches.
const BRACKET = /( ?)\[([^[\]\n]+)\]/g
// A code span: a backtick run, the shortest body that does not cross a blank
// line, and a closing run of the SAME length — CommonMark's pairing rule.
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)/g
// A fence opens on three backticks with no backtick after them — "```npm i```"
// is an inline span — or on three tildes; it closes on a run of the same
// character, at least as long, and nothing but whitespace after it.
const FENCE_OPEN = /^ {0,3}(`{3,})[^`]*$|^ {0,3}(~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
// What a model puts between two citations in one bracket.
const PARTS = /\s*[,;]\s*|\s+/
// `#anchor~2` is a continuation of `#anchor` (chunker.ts) and opens the same href.
const PART_SUFFIX = /~\d+$/
const DIGITS = /^\d+$/
// An id nobody handed out, by its shape: a path, a `#`, no spaces. Its marker
// goes, as a phantom's does — forty characters of broken id is not a citation.
const ID_SHAPED = /^[^\s#]*\/[^\s#]*#\S*$/

export interface Marked {
  text: string
  citations: string[]
  /** How many brackets were rewritten or deleted. For the tests, never a decision. */
  rewritten: number
}

/**
 * @param text   the answer as the model wrote it
 * @param raw    the citations array as the model sent it, phantoms included
 * @param known  `finish()`'s own predicate: emitted ids and site-tool ids
 */
export function idMarkers(text: string, raw: string[], known: (id: string) => boolean): Marked {
  const out = raw.filter(known)
  let rewritten = 0

  // The model's number, as a position in `out`: 0 when its entry was dropped
  // or never existed.
  const numbered = (n: number) => {
    const id = raw[n - 1]
    return id !== undefined && known(id) ? out.indexOf(id) + 1 : 0
  }

  // The position an id answers to, null when it is not a citation at all, 0
  // when its marker goes. `adds` collects appends, committed only once every
  // part of the bracket has resolved.
  const positionOf = (part: string, adds: string[], exactOnly: boolean): number | null => {
    const id = part.replace(/^\//, '')
    const cited = [...out, ...adds]
    if (cited.includes(id)) return cited.indexOf(id) + 1
    if (!exactOnly) {
      // `#anchor~2` written where `#anchor` was cited, or the reverse: one href,
      // one source row, so the cited part answers for both.
      const base = id.replace(PART_SUFFIX, '')
      const sibling = cited.findIndex((c) => c.replace(PART_SUFFIX, '') === base)
      if (base.includes('#') && sibling >= 0) return sibling + 1
      // A page's lead section has the EMPTY anchor, so its id is `page#`, and a
      // model drops the bare `#`. Matched only against what is cited, because
      // `[introduction]` is as likely to be a word in brackets.
      if (!id.includes('#') && cited.includes(`${id}#`)) return cited.indexOf(`${id}#`) + 1
    }
    if (known(id)) return out.length + adds.push(id)
    if (raw.includes(id) || ID_SHAPED.test(id)) return 0
    return null
  }

  const bracket = (whole: string, space: string, inner: string, at: number, s: string) => {
    const before = s[at + space.length - 1]
    const after = s[at + whole.length]
    // Image alt text is never a marker.
    if (before === '!') return whole
    // Link text, `[text](url)` or `[text][ref]`, is a marker only when it names
    // a citation exactly — `[install](/install)` is a link, not a citation.
    const exactOnly = after === '(' || after === '['
    const parts = inner.trim().split(PARTS).filter(Boolean)
    // `[ ]` is a task-list box.
    if (!parts.length) return whole
    const marks: number[] = []
    const adds: string[] = []
    if (parts.every((p) => DIGITS.test(p))) {
      // `[1, 2]` past the end of the list is an array literal, not two markers.
      if (parts.length > 1 && parts.some((p) => Number(p) < 1 || Number(p) > raw.length)) return whole
      for (const p of parts) marks.push(numbered(Number(p)))
    } else {
      for (const p of parts) {
        const n = DIGITS.test(p) ? numbered(Number(p)) : positionOf(p, adds, exactOnly)
        // One part that is not a citation makes the whole bracket prose: the
        // model's `[see the AWS section]` is not half a marker.
        if (n === null) return whole
        marks.push(n)
      }
    }
    out.push(...adds)
    const kept = marks.filter((n, i) => n > 0 && marks.indexOf(n) === i)
    const next = kept.map((n) => `[${n}]`).join('')
    if (next !== `[${inner.trim()}]`) rewritten++
    return kept.length ? `${space}${next}` : ''
  }

  // Prose only. Code is what the reader copies, and `arr[a#x]` there is code.
  // `[1][1]` — a number beside the id it names — is one marker.
  const prose = (s: string) => {
    const rewrite = (part: string) => part.replace(BRACKET, bracket).replace(/(\[(\d+)\])(?:\[\2\])+/g, '$1')
    let res = ''
    let last = 0
    for (const m of s.matchAll(CODE_SPAN)) {
      res += rewrite(s.slice(last, m.index)) + m[0]
      last = m.index + m[0].length
    }
    return res + rewrite(s.slice(last))
  }

  const kept: string[] = []
  let fence: string | null = null
  let run: string[] = []
  const flush = () => {
    if (run.length) kept.push(prose(run.join('\n')))
    run = []
  }
  for (const line of String(text || '').split('\n')) {
    if (fence) {
      kept.push(line)
      const c = FENCE_CLOSE.exec(line)
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null
      continue
    }
    const f = FENCE_OPEN.exec(line)
    if (f) {
      flush()
      fence = f[1] || f[2]
      kept.push(line)
      continue
    }
    run.push(line)
  }
  flush()

  return { text: kept.join('\n'), citations: out, rewritten }
}
