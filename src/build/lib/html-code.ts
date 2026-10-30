import type { Block } from './ir.js'

/**
 * The code half of the HTML serialiser (engine-spec 043).
 *
 * Split out of `html-to-md.ts` because code is where extraction most often
 * loses meaning: a sample built from `<br>` lines used to become one line, a
 * language written on a wrapper was lost, and a highlighter's line-number
 * gutter landed inside the fence as a column of digits (F-01, F-02, P-05). A
 * fence the reader trusts as code has to hold the lines the page wrote and
 * nothing the highlighter added.
 *
 * It reads nodes and returns a `Block`. It builds no DOM and imports no parser,
 * so `src/build/lib/dom.ts` stays the one place linkedom is reached from.
 */

/**
 * `language-<name>` and nothing looser (engine-spec 043, research sketch 2).
 *
 * `highlight-source-js` and `lang-x` name something else as often as they name
 * a language, so they give no info string. The first token in one class
 * attribute wins, because `exec` on a non-global expression stops at it.
 */
const LANG_TOKEN = /(?:^|\s)language-([a-z0-9+#.-]+)/i

/** The value a `data-lang` or `data-language` attribute may hold as an info string. */
const LANG_VALUE = /^[a-z0-9+#.-]+$/i

/**
 * How many ancestors of the `pre` may name its language (engine-spec 043).
 *
 * A generator puts the language on the `pre`, on its wrapper, or on the
 * wrapper's wrapper. Further up is the page itself, and its classes are not
 * about this block.
 */
export const LANG_ANCESTOR_DEPTH = 3

/**
 * Class tokens that mark a line-number gutter (engine-spec 043, P-05): the
 * gutters of highlight.js, Chroma, Rouge, Pygments and Prism.
 *
 * Matched as a whole class token or as the head of a hyphenated one, never as a
 * raw substring, so `client` never matches `lnt` and Chroma's `lntd`, which
 * marks both of its cells, is not a gutter.
 */
export const LINE_NUMBER_HINTS: string[] = []

/**
 * A wrapper's own text outside its `pre` is chrome when it is this short
 * (engine-spec 043): a language label, a "Copy" word, a file name. More text
 * than this means the wrapper holds prose, and it is not a code block.
 */
export const CODE_LABEL_MAX = 40

/** Elements that are never code, wherever they sit inside a sample. */
const CHROME_TAGS = new Set(['button', 'img', 'svg'])

const tagOf = (node): string => String(node?.tagName || '').toLowerCase()

const classTokens = (el): string[] =>
  String(el?.getAttribute?.('class') || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

/** Does this element carry a line-number class? */
function hasHint(el): boolean {
  return classTokens(el).some((t) => LINE_NUMBER_HINTS.some((h) => t === h || t.startsWith(`${h}-`)))
}

/** The language a `pre`, a `code` or a block-level `code` names, or ''. */
export function fenceLanguage(pre): string {
  const code = tagOf(pre) === 'code' ? pre : pre.querySelector?.('code')
  const chain = [code, pre].filter(Boolean)
  let up = pre.parentElement
  for (let depth = 0; up && depth < LANG_ANCESTOR_DEPTH; depth++, up = up.parentElement) chain.push(up)

  for (const el of chain) {
    const m = LANG_TOKEN.exec(String(el.getAttribute?.('class') || ''))
    if (m) return m[1].toLowerCase()
  }
  for (const el of chain) {
    for (const attr of ['data-lang', 'data-language']) {
      const value = String(el.getAttribute?.(attr) || '').trim()
      if (LANG_VALUE.test(value)) return value.toLowerCase()
    }
  }
  return ''
}

/** The raw text of a sample: text nodes verbatim, `br` as a newline, chrome skipped. */
function collect(node, out: string[]): void {
  for (const child of [...(node.childNodes || [])]) {
    if (child.nodeType === 3) {
      out.push(String(child.data || ''))
      continue
    }
    if (child.nodeType !== 1) continue

    const tag = tagOf(child)
    if (tag === 'br') {
      out.push('\n')
      continue
    }
    if (CHROME_TAGS.has(tag) || hasHint(child)) continue

    collect(child, out)
    // A row-per-line table (highlight.js with the line-numbers plugin) ends a
    // line at the end of a row.
    if (tag === 'tr') out.push('\n')
  }
}

/**
 * The text of a code element, as the source wrote it.
 *
 * Only these things change: CRLF and CR become LF; U+00A0 becomes U+0020; one
 * LF is dropped when it is the first character after a `<pre>` start tag (the
 * HTML parsing rule, which linkedom does not apply); the trailing run of LF is
 * removed. No other character is touched, so an interior blank line stays and
 * a one-line sample stays one line.
 */
export function codeText(el): string {
  const out: string[] = []
  collect(el, out)
  let text = out.join('').replace(/\r\n?/g, '\n').replace(/ /g, ' ')

  const first = el.firstChild
  if (tagOf(el) === 'pre' && first?.nodeType === 3 && /^[\r\n]/.test(String(first.data || ''))) {
    text = text.replace(/^\n/, '')
  }
  return text.replace(/\n+$/, '')
}

/** The text of a wrapper outside one descendant, whitespace collapsed. */
function textOutside(el, skip): string {
  const out: string[] = []
  const walk = (node) => {
    for (const child of [...(node.childNodes || [])]) {
      if (child === skip) continue
      if (child.nodeType === 3) out.push(String(child.data || ''))
      else if (child.nodeType === 1) walk(child)
    }
  }
  walk(el)
  return out.join('').replace(/\s+/g, ' ').trim()
}

/** A wrapper with a `language-` class around exactly one `pre` and a short label. */
function isWrappedPre(el): boolean {
  if (!LANG_TOKEN.test(String(el.getAttribute?.('class') || ''))) return false
  const pres = el.querySelectorAll?.('pre') || []
  if (pres.length !== 1) return false
  return textOutside(el, pres[0]).length <= CODE_LABEL_MAX
}

/** Does this element read as one code block? */
export function isCodeBlock(node): boolean {
  return tagOf(node) === 'pre' || isWrappedPre(node)
}

/** The code block an element stands for, or null when it holds no code. */
export function codeBlock(node): Block | null {
  const pre = tagOf(node) === 'pre' ? node : node.querySelector('pre')
  const text = codeText(pre)
  return text.trim() ? { kind: 'code', lang: fenceLanguage(pre), text } : null
}
