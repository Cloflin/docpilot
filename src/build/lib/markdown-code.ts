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

/**
 * `pattern` replaced in `text`, matched ACROSS code spans: a link whose label is
 * code, ``[`code`](/a)``, is still a link. Each span is masked with a same-length
 * run of `x` before matching, so a bracket or a parenthesis inside code can
 * neither start nor end a match, and the replacer reads the original text by
 * offset. A backslash-escaped pair is masked the same way (WR-12). `pattern`
 * must carry the `g` flag.
 */
function replaceAcrossCode(text: string, pattern: RegExp, fn: (...groups: string[]) => string): string {
  let masked = text
  for (const [start, end] of codeSpans(text)) {
    masked = masked.slice(0, start) + 'x'.repeat(end - start) + masked.slice(end)
  }
  // A backslash and the character it escapes are text, never syntax: the
  // extractor writes page text that looks like a link as `\[a\](/b)`, and a
  // pattern that starts at the bracket would read that as a link. Masked after
  // the code spans, so a backslash inside a span is not read twice (WR-12).
  masked = masked.replace(/\\[\s\S]/g, (pair) => 'x'.repeat(pair.length))
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

/** A fence opener may sit in a list item, ``- ```js``, or after a quote marker, ``> ```js``. */
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/
const QUOTE_MARKER = /^\s*(?:>\s?)+/
/** Four spaces or a tab: an indented code block, when nothing opens a list above it. */
const INDENTED = /^(?: {4}|\t)/
/** A list item starts at an indent below four, with a marker. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/

/** The fence a line opens, looking through a quote marker and a list marker. */
function openFenceIn(line: string): ReturnType<typeof openFence> {
  const quoted = line.replace(QUOTE_MARKER, '')
  return openFence(quoted) || openFence(quoted.replace(LIST_MARKER, ''))
}

/**
 * The document with `fn` applied to each prose paragraph; fenced code and
 * indented code blocks are copied as written. `fn` owns the inline code inside a
 * paragraph.
 *
 * `fn` sees a whole paragraph (consecutive prose lines joined by `\n`), not one
 * line, because a link label may wrap across lines and `fn` must still match it.
 * A blank line or a fence ends the paragraph, so a stray backtick in one cannot
 * pair with one in the next. An unclosed fence runs to the end, as in
 * `normalise.ts`.
 *
 * A fence inside a list item or a block quote is code (WR-03): the sample shown
 * under a step is the commonest place for one. An indented code block starts at
 * a line indented four spaces after a blank line, unless a list item opened
 * above it, where that indent is a continuation paragraph and still prose. The
 * list rule errs towards prose: a link in a sample that sits in a list is then
 * read as a link, which is the 2.x behaviour for every sample.
 */
function mapProseBlocks(md: string, fn: (prose: string) => string): string {
  const out: string[] = []
  let para: string[] = []
  let fence: ReturnType<typeof openFence> = null
  let indented = false
  let inList = false
  let prevBlank = true
  const flush = () => {
    if (para.length) out.push(fn(para.join('\n')))
    para = []
  }
  for (const raw of md.split('\n')) {
    // A CR left on the line would stop the fence pattern matching its end.
    const line = raw.replace(/\r$/, '')
    const blank = !line.trim()
    if (fence) {
      if (closesFence(line.replace(QUOTE_MARKER, ''), fence)) fence = null
      out.push(raw)
      continue
    }
    if (indented) {
      if (blank || INDENTED.test(line)) {
        out.push(raw)
        prevBlank = blank
        continue
      }
      indented = false
    }
    const opens = openFenceIn(line)
    if (opens) {
      flush()
      fence = opens
      out.push(raw)
      continue
    }
    if (blank) {
      flush()
      out.push(raw)
      prevBlank = true
      continue
    }
    if (prevBlank && !inList && INDENTED.test(line)) {
      flush()
      indented = true
      out.push(raw)
      prevBlank = false
      continue
    }
    if (LIST_ITEM.test(line)) inList = true
    else if (prevBlank && !/^\s/.test(line)) inList = false
    para.push(raw)
    prevBlank = false
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
