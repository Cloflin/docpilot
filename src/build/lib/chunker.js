/**
 * Chunking — RAG-SPEC 2.3.
 *
 * Rules 1-6 are structural preferences. Rule 7 (MAX_CHUNK_CHARS) is a ceiling
 * and cannot be satisfied by preference; rule 8 (embed context) fails the build,
 * because a chunk whose vector represents its first 1% fails silently at every
 * later stage.
 */

import { normaliseMarkdown, MAX_CHUNK_CHARS } from './normalise.js'
import { estTokens } from '../../theme/docpilot/text.js'

export const TARGET_MIN_TOKENS = 350
export const TARGET_MAX_TOKENS = 500
export const MERGE_BELOW_TOKENS = 120
export const EMBED_CONTEXT_TOKENS = 8192

/** GitHub-style heading slug, matching VitePress anchors closely enough to link to. */
export function slug(s) {
  return s
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** Split into sections at ## and ###. `#` sets the document title, never a boundary. */
function toSections(text, fallbackTitle) {
  const lines = text.split('\n')
  const sections = []
  let h1 = fallbackTitle || null
  let cur = { title: null, level: 0, lines: [] }
  let fenced = false

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const h = !fenced && /^(#{1,3})\s+(.+)$/.exec(line)
    if (h) {
      const level = h[1].length
      const title = h[2].trim()
      if (level === 1) {
        h1 = h1 || title
        continue
      }
      if (cur.lines.join('\n').trim() || cur.title) sections.push(cur)
      cur = { title, level, lines: [] }
      continue
    }
    cur.lines.push(line)
  }
  if (cur.lines.join('\n').trim() || cur.title) sections.push(cur)
  return { h1, sections }
}

/**
 * Rule 7. A section over the ceiling is split unconditionally: at table-row
 * boundaries inside a table, at line boundaries otherwise, ignoring paragraph
 * structure — a table with no blank lines is one paragraph and rule 3 is a no-op
 * on it. Rule 5 (never split a code block) yields here, and the caller warns.
 */
function hardSplit(text, limit, onCodeSplit) {
  if (text.length <= limit) return [text]
  const units = text.split('\n')
  const out = []
  let buf = ''
  let sawFence = false
  for (const unit of units) {
    if (/^\s*(```|~~~)/.test(unit)) sawFence = !sawFence
    const next = buf ? `${buf}\n${unit}` : unit
    if (next.length > limit && buf) {
      if (sawFence && onCodeSplit) onCodeSplit()
      out.push(buf)
      buf = unit
    } else {
      buf = next
    }
  }
  if (buf) out.push(buf)
  // A single line longer than the limit cannot be split at a line boundary.
  return out.flatMap((p) =>
    p.length <= limit ? [p] : p.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) || [],
  )
}

/** Rule 3: split at paragraph boundaries with one paragraph of overlap. */
function paragraphSplit(text) {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim())
  if (paras.length <= 1) return [text]
  const out = []
  let buf = []
  let bufLen = 0
  for (const p of paras) {
    const t = estTokens(p)
    if (bufLen && bufLen + t > TARGET_MAX_TOKENS) {
      out.push(buf.join('\n\n'))
      const overlap = buf[buf.length - 1]
      buf = [overlap, p]
      bufLen = estTokens(overlap) + t
    } else {
      buf.push(p)
      bufLen += t
    }
  }
  if (buf.length) out.push(buf.join('\n\n'))
  return out
}

/** Code languages mentioned in a chunk, for the record rather than for retrieval. */
function codeLangs(text) {
  return [...new Set([...text.matchAll(/^\s*```(\w+)/gm)].map((m) => m[1].toLowerCase()))]
}

/**
 * @returns {{ chunks: Array, warnings: string[] }}
 */
export function chunkMarkdown({ src, path, kind, sidebarTitle }) {
  const { title: fmTitle, description, layout, source, faq, text, warnings: normWarnings } =
    normaliseMarkdown(src)
  const warnings = normWarnings.map((w) => `${w} in ${path}`)
  if (layout === 'home')
    return { chunks: [], warnings, title: fmTitle || sidebarTitle, faq: [], source }

  const { h1, sections } = toSections(text, fmTitle || sidebarTitle)
  const pageTitle = fmTitle || sidebarTitle || h1 || path

  // Rule 4: a section under MERGE_BELOW_TOKENS joins the next one at its level.
  const merged = []
  for (const s of sections) {
    const body = s.lines.join('\n').trim()
    const prev = merged[merged.length - 1]
    if (prev && estTokens(body) < MERGE_BELOW_TOKENS && prev.level === s.level) {
      prev.body += `\n\n${s.title ? `${s.title}\n` : ''}${body}`
      continue
    }
    merged.push({ title: s.title, level: s.level, body })
  }

  const chunks = []
  // Repeated headings on one page produce the same slug. VitePress disambiguates
  // with a `-1`, `-2` suffix, and matching that rule keeps our anchors equal to
  // the anchors a source link actually has to point at.
  const anchorSeen = new Map()
  for (const s of merged) {
    const breadcrumb = [h1 && h1 !== s.title ? h1 : null].filter(Boolean).join(' › ') || pageTitle
    const heading = s.title || pageTitle
    const context = `${breadcrumb} — ${heading}`
    let anchor = s.title ? slug(s.title) : ''
    if (anchor) {
      const n = anchorSeen.get(anchor) || 0
      anchorSeen.set(anchor, n + 1)
      if (n) anchor = `${anchor}-${n}`
    }

    // The context line is prepended to every part, so the ceiling applies to
    // body + context, not to body alone.
    const budget = MAX_CHUNK_CHARS - context.length - 1
    let parts = estTokens(s.body) > TARGET_MAX_TOKENS ? paragraphSplit(s.body) : [s.body]
    parts = parts.flatMap((p) =>
      hardSplit(p, budget, () => warnings.push(`code block split by MAX_CHUNK_CHARS in ${path}`)),
    )

    parts.forEach((body, i) => {
      // The frontmatter description rides on the page's FIRST chunk only. It
      // states what the page is for, in the words a reader would use to ask —
      // and a question is phrased as a task, while every heading on the page is
      // phrased as a topic. Repeating it on every chunk would just add the same
      // vector to all of them and flatten the ranking it is meant to sharpen.
      const lead = description && chunks.length === 0 && i === 0 ? `\n${description}` : ''
      const full = `${context}${lead}\n${body}`.trim()
      if (!body.trim()) return
      chunks.push({
        id: `${path.replace(/^\//, '')}#${anchor}${i ? `-${i + 1}` : ''}`,
        path,
        anchor,
        title: heading,
        breadcrumb,
        kind,
        codeLangs: codeLangs(body),
        text: full,
      })
    })
  }

  // FAQ islands become their own chunks of kind `faq`.
  faq.forEach((f, i) => {
    chunks.push({
      id: `${path.replace(/^\//, '')}#faq-${i + 1}`,
      path,
      anchor: `faq-${i + 1}`,
      title: f.question,
      breadcrumb: pageTitle,
      kind: 'faq',
      codeLangs: [],
      text: `${pageTitle} — ${f.question}\n${f.answer}`,
    })
  })

  // prev/next are SAME PAGE ONLY and null at the ends, so section expansion can
  // never cross a page boundary. RAG-SPEC 3.1.
  chunks.forEach((c, i) => {
    c.prev = i > 0 ? chunks[i - 1].id : null
    c.next = i < chunks.length - 1 ? chunks[i + 1].id : null
  })

  for (const c of chunks) {
    if (c.text.length > MAX_CHUNK_CHARS) {
      throw new Error(`chunk exceeds MAX_CHUNK_CHARS after rule 7: ${c.id} (${c.text.length})`)
    }
    if (estTokens(c.text) > EMBED_CONTEXT_TOKENS) {
      throw new Error(`chunk exceeds the embed context: ${c.id} (${estTokens(c.text)} tokens)`)
    }
  }

  // `source` rides out unvalidated and unattached to any chunk: provenance is a
  // property of the PAGE, and the manifest is where a page's properties live.
  // The caller checks it against the allowlist — this module has no I/O and no
  // configuration, which is what lets the linter re-chunk from source on a PR.
  return { chunks, warnings, title: pageTitle, faq, source }
}
