/**
 * llms.txt → a structure with a line number on everything.
 *
 * THE FORMAT (https://llmstxt.org/), in the order the file must hold it:
 *
 *   1. an optional byte-order mark;
 *   2. an H1 with the project or site name — the ONLY required section;
 *   3. a blockquote with a short summary of the project;
 *   4. zero or more markdown sections of any type EXCEPT headings — paragraphs,
 *      lists — about the project and how to read the files;
 *   5. zero or more H2-headed "file lists": markdown lists whose items are a
 *      required `[name](url)`, optionally followed by `:` and notes.
 *
 * An H2 called `Optional` has a meaning of its own: its URLs may be skipped when
 * a shorter context is needed.
 *
 * Pure: this does not decide what is WRONG, it only records what is there, so
 * the lint rules in lint.ts read one structure and a rule can be added without
 * touching the parser. Fenced code is skipped — a `#` inside a code sample in
 * the body is not a heading.
 */

export interface LlmsItem {
  name: string
  url: string
  notes: string | null
  line: number
  raw: string
}

export interface LlmsSection {
  name: string
  line: number
  items: LlmsItem[]
  /** List items that do not start with `[name](url)`. */
  badItems: {line: number; raw: string}[]
  /** Items whose link is fine but whose notes are not introduced by `:`. */
  badSeparators: {line: number; raw: string}[]
  /** Non-list text inside a file-list section. */
  prose: {line: number; text: string}[]
  /** H3 and deeper headings inside this section. */
  subheadings: {level: number; text: string; line: number}[]
}

export interface ParsedLlms {
  bom: boolean
  lines: number
  bytes: number
  h1s: {text: string; line: number}[]
  /** Non-blank lines found before the first H1. */
  preamble: {line: number; text: string}[]
  summary: {text: string; line: number} | null
  /** A blockquote that came after body text — the summary in the wrong place. */
  lateQuote: {text: string; line: number} | null
  /** Free text between the H1 (or summary) and the first H2. */
  body: {line: number; text: string}[]
  /** H3+ headings outside any H2 section. */
  bodyHeadings: {level: number; text: string; line: number}[]
  sections: LlmsSection[]
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/
const LIST = /^(\s*)[-*+]\s+(.*)$/
/** `[name](url "title"?)` then optional `: notes`. Name may hold escaped `]`. */
const LINK = /^\[((?:\\.|[^\]\\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)(.*)$/

export function parseLlmsTxt(text: string): ParsedLlms {
  const src = String(text ?? '')
  const bom = src.charCodeAt(0) === 0xfeff
  const body = bom ? src.slice(1) : src
  const rows = body.split(/\r?\n/)
  const out: ParsedLlms = {
    bom,
    lines: rows.length,
    bytes: new TextEncoder().encode(src).length,
    h1s: [],
    preamble: [],
    summary: null,
    lateQuote: null,
    body: [],
    bodyHeadings: [],
    sections: [],
  }

  let fenced = false
  let section: LlmsSection | null = null
  let lastItem: LlmsItem | null = null
  let quote: {text: string; line: number} | null = null
  let quoteOpen = false

  const closeQuote = () => {
    if (!quote) return
    if (!out.summary && out.body.length === 0 && !section) out.summary = quote
    else if (!out.lateQuote) out.lateQuote = quote
    quote = null
    quoteOpen = false
  }

  rows.forEach((raw, i) => {
    const line = i + 1
    const t = raw.trimEnd()

    if (FENCE.test(t)) {
      fenced = !fenced
      if (!fenced) return
    }
    if (fenced) {
      if (!out.h1s.length) out.preamble.push({line, text: t})
      else if (section) section.prose.push({line, text: t})
      else out.body.push({line, text: t})
      return
    }

    if (quoteOpen && !/^\s*>/.test(t)) closeQuote()

    const h = HEADING.exec(t)
    if (h) {
      lastItem = null
      const level = h[1].length
      const text = h[2].trim()
      if (level === 1) {
        out.h1s.push({text, line})
      } else if (level === 2) {
        section = {name: text, line, items: [], badItems: [], badSeparators: [], prose: [], subheadings: []}
        out.sections.push(section)
      } else if (section) {
        section.subheadings.push({level, text, line})
      } else {
        out.bodyHeadings.push({level, text, line})
      }
      return
    }

    if (!t.trim()) {
      lastItem = null
      return
    }

    if (!out.h1s.length) {
      out.preamble.push({line, text: t})
      return
    }

    if (/^\s*>/.test(t)) {
      const piece = t.replace(/^\s*>\s?/, '')
      if (quoteOpen && quote) quote.text = `${quote.text} ${piece}`.trim()
      else {
        quote = {text: piece.trim(), line}
        quoteOpen = true
      }
      if (section) section.prose.push({line, text: t})
      return
    }

    if (!section) {
      out.body.push({line, text: t})
      return
    }

    const li = LIST.exec(t)
    if (li) {
      const content = li[2].trim()
      const m = LINK.exec(content)
      if (!m) {
        section.badItems.push({line, raw: t})
        lastItem = null
        return
      }
      const rest = m[3].trim()
      let notes: string | null = null
      if (rest.startsWith(':')) notes = rest.slice(1).trim() || null
      else if (rest) section.badSeparators.push({line, raw: t})
      lastItem = {name: m[1].replace(/\\(.)/g, '$1'), url: m[2], notes, line, raw: t}
      section.items.push(lastItem)
      return
    }

    // An indented line straight after an item continues its notes.
    if (lastItem && /^\s+\S/.test(raw)) {
      lastItem.notes = `${lastItem.notes ?? ''} ${t.trim()}`.trim()
      return
    }
    section.prose.push({line, text: t})
  })
  closeQuote()
  return out
}
