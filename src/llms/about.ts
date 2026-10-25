/**
 * llms.txt as a description of each page, for RETRIEVAL — engine-spec 035.
 *
 * Until 2.0 the RAG-SPEC said llms.txt "is not read by DocPilot and never will
 * be": it was the surface for OTHER agents, and editing it moved no metric in
 * any report. But the one-line note beside each link is exactly what a
 * frontmatter `description` is — what the page is for, in the words somebody
 * looking for it would use — and the description is the lever the corpus mode
 * already measured (one page's first-chunk cosine 0.426 → 0.556). So the file
 * an author writes for agents now also tells this index what each page is
 * about, and an edit to it is an edit `eval` can see.
 *
 * Pure: text in, a map of route → note out. The links are resolved the way
 * `docpilot llms lint` resolves them — against the file's own dominant origin
 * and the site's base — so the two commands agree about which page a line
 * describes.
 */

import { parseLlmsTxt } from './parse.js'
import { dominantOrigin, toPagePath } from './lint.js'

export function descriptionsFromLlms(text: string, { base = null as string | null } = {}) {
  const parsed = parseLlmsTxt(text)
  const origin = dominantOrigin(parsed)
  const out = new Map<string, string>()
  for (const section of parsed.sections) {
    for (const item of section.items) {
      const note = String(item.notes || '').replace(/^\s*:\s*/, '').replace(/\s+/g, ' ').trim()
      if (!note) continue
      const page = toPagePath(item.url, { origin, base })
      if (page && !out.has(page)) out.set(page, note)
    }
  }
  return out
}
