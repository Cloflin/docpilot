/**
 * How much of a chunk an observation spells out, and what the model is told when
 * that was not all of it.
 *
 * ONE IMPLEMENTATION, TWO CALLERS. `harness.js` builds the observation that
 * ships and `answer-bench.js` builds the one the bench measures, and until this
 * module existed the second was a hand-copy of the first carrying the comment
 * "harness.js step 1, verbatim in rule". They had already drifted: the harness
 * read its budget through `tune('SEARCH_CHARS', 1200)` and the bench through
 * `Number(process.env.DOCPILOT_SEARCH_CHARS || '') || 1200`. Agreeing by luck is
 * not agreeing, and a bench that stops building what ships stops measuring it.
 *
 * WHY THE CUT IS STILL HEAD-ANCHORED, having been measured otherwise.
 *
 * The obvious improvement is to spend the budget on the part of the chunk the
 * question is about, rather than always on its first 1200 characters — which cut
 * 26.4% of chunks on the development corpus. It was built and measured against
 * the golden positives: 20 gold chunks longer than the budget, 25 gold
 * identifiers inside them. Choosing the window by query-term density RECOVERED
 * ONE identifier and LOST THREE. Restricting it to a rescue — move only when the
 * leading paragraphs touch no term of the question at all — brought that to one
 * recovered and one lost. A wash, for a scoring pass and a fence-aware
 * segmenter.
 *
 * The reason is the corpus rather than the scoring, and it generalises: a chunk
 * begins at its heading, the paragraph under a heading is where the thing is
 * DEFINED, and the identifiers an answer needs sit in that definition. Query
 * terms point at where the subject is DISCUSSED, which is not the same place.
 * Optimising for the second costs the first.
 *
 * If this is revisited, the thing to fix is the objective, not the search: score
 * against what an answer needs, which the retriever cannot know at excerpt time.
 * `fetch_section` is the mechanism that already solves it, at the cost of a step
 * — which is why the note below matters more than the window did.
 */

/**
 * What a truncated excerpt tells the model to do about it.
 *
 * A remedy rather than a fact, and the reason it exists at all: the shipped
 * instruction already says "use fetch_section when an excerpt is cut off"
 * (`prompt.js`), and until now the model had NO WAY TO KNOW that it was. A bare
 * `slice(0, max)` leaves no trace — the text simply stops, mid-sentence if the
 * budget lands there, indistinguishable from a section that ends there. So the
 * rule was unobservable and the escape hatch unreachable except by guess.
 *
 * OWED: what this does to the answer side is not measured. It changes the prompt
 * bytes on every truncated result and it will make some turns spend a step on
 * `fetch_section` that previously answered without one — better grounding against
 * more iterations. That trade needs `docpilot bench`, three runs, before anyone
 * quotes a number for it.
 */
export const TRUNCATED_NOTE =
  'excerpt trimmed to fit — call fetch_section with this id for the full section'

/**
 * @param {string} text  the chunk's own text, context line included
 * @param {{max: number}} opts
 * @returns {{text: string, truncated: boolean}}
 */
export function excerptWindow(text, { max } = {}) {
  const src = String(text || '')
  const limit = Math.max(0, Math.trunc(max))
  if (src.length <= limit) return { text: src, truncated: false }
  return { text: src.slice(0, limit), truncated: true }
}
