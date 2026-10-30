/**
 * Markdown prose with its code left alone.
 *
 * Two passes rewrite links in Markdown this tool did not write: the imported
 * page's dead-link degrade (`documents.ts`) and the published `.md` alternate's
 * absolutiser (`markdown-alternate.ts`). A fenced block or an inline code span
 * is a sample, not a link: `handlers[type](event)` is a call, and rewriting it
 * corrupts the very text a developer searches for. Both passes read code through
 * this module, so they cannot disagree about which text is code
 * (engine-spec 043, D-10).
 */

import { closesFence, openFence } from './normalise.js'

/**
 * The inline code spans of `line` as `[start, end)` ranges. A span opens at a
 * backtick run and closes at the next run of the same length (CommonMark); a run
 * that never closes is literal text.
 */
function codeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') {
      i++
      continue
    }
    let n = 0
    while (line[i + n] === '`') n++
    let j = i + n
    let close = -1
    while (j < line.length) {
      if (line[j] !== '`') {
        j++
        continue
      }
      let m = 0
      while (line[j + m] === '`') m++
      if (m === n) {
        close = j
        break
      }
      j += m
    }
    if (close < 0) {
      i += n
      continue
    }
    spans.push([i, close + n])
    i = close + n
  }
  return spans
}

/** One line of prose with its inline code spans copied unchanged. */
export function mapProse(line: string, fn: (prose: string) => string): string {
  let out = ''
  let from = 0
  for (const [start, end] of codeSpans(line)) {
    out += fn(line.slice(from, start)) + line.slice(start, end)
    from = end
  }
  return out + fn(line.slice(from))
}

/**
 * `pattern` replaced in `text`, matched ACROSS code spans: a link whose label is
 * code, ``[`code`](/a)``, is still a link. Each span is masked with a same-length
 * run of `x` before matching, so a bracket or a parenthesis inside code can
 * neither start nor end a match, and the replacer reads the original text by
 * offset. `pattern` must carry the `g` flag.
 */
function replaceAcrossCode(text: string, pattern: RegExp, fn: (...groups: string[]) => string): string {
  let masked = text
  for (const [start, end] of codeSpans(text)) {
    masked = masked.slice(0, start) + 'x'.repeat(end - start) + masked.slice(end)
  }
  const re = new RegExp(pattern.source, pattern.flags.includes('d') ? pattern.flags : `${pattern.flags}d`)
  let out = ''
  let from = 0
  for (const m of masked.matchAll(re)) {
    const ranges = (m as any).indices as Array<[number, number] | undefined>
    const groups = ranges.map((r) => (r ? text.slice(r[0], r[1]) : undefined))
    out += text.slice(from, m.index) + fn(...(groups as string[]))
    from = (m.index as number) + m[0].length
  }
  return out + text.slice(from)
}

/**
 * The document with `fn` applied to each prose paragraph; fenced code is copied
 * as written. `fn` owns the inline code inside a paragraph.
 *
 * `fn` sees a whole paragraph (consecutive prose lines joined by `\n`), not one
 * line, because a link label may wrap across lines and `fn` must still match it.
 * A blank line or a fence ends the paragraph, so a stray backtick in one cannot
 * pair with one in the next. An unclosed fence runs to the end, as in
 * `normalise.ts`.
 */
function mapProseBlocks(md: string, fn: (prose: string) => string): string {
  const out: string[] = []
  let para: string[] = []
  let fence: ReturnType<typeof openFence> = null
  const flush = () => {
    if (para.length) out.push(fn(para.join('\n')))
    para = []
  }
  for (const raw of md.split('\n')) {
    // A CR left on the line would stop the fence pattern matching its end.
    const line = raw.replace(/\r$/, '')
    if (fence) {
      if (closesFence(line, fence)) fence = null
      out.push(raw)
      continue
    }
    const opens = openFence(line)
    if (opens) {
      flush()
      fence = opens
      out.push(raw)
      continue
    }
    if (!line.trim()) {
      flush()
      out.push(raw)
      continue
    }
    para.push(raw)
  }
  flush()
  return out.join('\n')
}

/**
 * `pattern` replaced in the document's prose only. Fenced code and the code
 * spans inside a paragraph are never part of a match's replacement, and a match
 * that lies wholly inside code is not a match. The replacer receives the whole
 * match and then its captures, as `String.replace` passes them.
 */
export function replaceInProse(md: string, pattern: RegExp, fn: (...groups: string[]) => string): string {
  return mapProseBlocks(md, (para) => replaceAcrossCode(para, pattern, fn))
}
