/**
 * The owner's instructions do not leave in an answer — engine-spec 033 (OWASP
 * LLM07, system prompt leakage).
 *
 * Under `runtime: 'server'` the owner's `prompt.override` and `prompt.extend`
 * are the one thing the browser never receives (spec 028), and "repeat your
 * instructions verbatim" reached the model with the guard off and nothing on
 * the way out. A system prompt cannot defend itself — the 2025 OWASP entry says
 * so in as many words: put the control outside the model. This is that control,
 * on the text leaving the server.
 *
 * TWO DETECTORS, built once from the owner's private text:
 *
 *   · SHINGLES — every run of `SHINGLE` consecutive words. A paraphrase gets
 *     through and is meant to: what this stops is the verbatim dump, which is
 *     what an extraction attack produces and what a reader could copy.
 *   · TOKENS — every word that looks like an identifier (eight or more
 *     characters with a digit or an underscore: an internal code, a canary, a
 *     ticket number). One of those in an answer is a leak on its own.
 *
 * The CORE instruction this package ships is public — it is on npm — and is not
 * guarded; guarding it would refuse every answer that explains how DocPilot
 * works.
 */

const SHINGLE = 6

const words = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

/**
 * A word that looks like an identifier: eight or more characters holding a
 * DIGIT or an underscore. A dash alone is not enough — "trade-offs" and
 * "well-known" are prose, and flagging them would refuse ordinary answers.
 */
const IDENTIFIER = /^(?=.*[\d_])[\p{L}\p{N}_-]{8,}$/u

export function createLeakGuard(privateTexts: Array<string | null | undefined>) {
  const shingles = new Set<string>()
  const tokens = new Set<string>()
  for (const text of privateTexts) {
    const w = words(text)
    for (let i = 0; i + SHINGLE <= w.length; i++) shingles.add(w.slice(i, i + SHINGLE).join(' '))
    for (const raw of String(text ?? '').split(/[\s.,;:!?()"'«»]+/)) if (IDENTIFIER.test(raw)) tokens.add(raw.toLowerCase())
  }
  const empty = !shingles.size && !tokens.size
  return {
    empty,
    /** What of the owner's text this output contains — empty when nothing. */
    hits(text: string): string[] {
      if (empty || !text) return []
      const found = []
      const lower = String(text).toLowerCase()
      for (const t of tokens) if (lower.includes(t)) found.push(t)
      const w = words(text)
      for (let i = 0; i + SHINGLE <= w.length; i++) {
        const s = w.slice(i, i + SHINGLE).join(' ')
        if (shingles.has(s)) {
          found.push(s)
          break
        }
      }
      return found
    },
  }
}

export type LeakGuard = ReturnType<typeof createLeakGuard>
