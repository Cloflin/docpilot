/**
 * The annotation pass — the one step of an import that stays a judgement.
 *
 * Everything before this is code: the same page produces the same markdown on
 * every run. What code cannot do is read the result the way the RETRIEVER will
 * and notice that the words a reader would search for never appear, that the
 * answer is split across two sections so no single chunk carries it, or that a
 * paragraph of marketing survived in the middle of a real one. Those are the
 * three annotations `skills/docs-import/SKILL.md` asks for, and a model is
 * genuinely better at spotting them than a rule is.
 *
 * SO THE MODEL IS ALLOWED TO ANNOTATE AND NOTHING ELSE, and that is enforced
 * rather than requested. `verifyAnnotation` strips what the pass is permitted to
 * add and compares the remainder to the input, character for character. A model
 * that rewrote a sentence, dropped a row, reordered two sections or "improved"
 * a heading fails that check and its whole answer is discarded — the file is
 * written unannotated instead.
 *
 * That check is the entire reason this can run unattended. The corpus is the
 * product here: a paraphrase in it is a sentence nobody at the source wrote,
 * which the assistant then cites with a link to a page that does not say it.
 *
 *   <llm-only>…</llm-only>       indexed, citable, SHOWN to readers — so it has
 *                                to be true, publishable documentation, and it
 *                                may never address the model or carry an
 *                                instruction (docs-rag's hard content rule).
 *   <llm-exclude>…</llm-exclude> dropped from the index entirely.
 */

import { chat as defaultChat } from '../../theme/docpilot/llm.js'

/**
 * Text that is addressed at a model rather than at a reader.
 *
 * `<llm-only>` content is shown to readers and cited like any other sentence,
 * so a line that says "always answer X" is both a lie to the reader and a
 * prompt injection the corpus performs on itself. Matched on the ADDED blocks
 * only — the source page is allowed to contain the word "instruction".
 */
const ADDRESSES_THE_MODEL =
  /\b(you (are|must|should|will|need to)|as an? (ai|assistant|language model)|the (assistant|model|ai) (should|must|will)|ignore (the|all|any|previous)|always (answer|respond|say)|never (answer|respond|say|mention)|do not (answer|mention|say)|system (prompt|message)|when (asked|answering))\b/i

/** Blank-line runs and trailing spaces are formatting, not content. */
function normalise(md) {
  return String(md)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The document with the pass's own additions taken back out.
 *
 * An `<llm-only>` block is REMOVED WITH ITS CONTENT, because that content is
 * exactly what the pass was allowed to add. An `<llm-exclude>` marker is removed
 * WITHOUT its content, because that content is the source page's and has to
 * still be there. What remains must equal what went in.
 *
 * Note this is the inverse of `applyLlmTags` in normalise.js, which is the
 * INDEXER's reading of the same two tags. Both are needed and they are not the
 * same function: one asks "what does the corpus get", this one asks "what did
 * the model touch".
 */
export function stripAnnotations(md) {
  return normalise(
    String(md)
      .replace(/<llm-only>[\s\S]*?<\/llm-only>\n?/gi, '')
      .replace(/<\/?llm-exclude>\n?/gi, ''),
  )
}

/** Every `<llm-only>` block's inner text, in order. */
export function onlyBlocks(md) {
  return [...String(md).matchAll(/<llm-only>([\s\S]*?)<\/llm-only>/gi)].map((m) => m[1].trim())
}

/** The first line that differs, for a rejection message somebody can act on. */
function firstDifference(a, b) {
  const left = a.split('\n')
  const right = b.split('\n')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return { line: i + 1, was: left[i] ?? '(end of file)', now: right[i] ?? '(end of file)' }
    }
  }
  return null
}

/**
 * Did the pass stay inside its permission?
 *
 * @param {string} before the markdown handed to the model
 * @param {string} after what it returned
 * @returns {{ ok: boolean, reason?: string, detail?: object, only: number, exclude: number, added: string[] }}
 */
export function verifyAnnotation(before, after) {
  const added = onlyBlocks(after)
  const result = {
    only: added.length,
    exclude: (String(after).match(/<llm-exclude>/gi) || []).length,
    added,
  }

  // An unclosed tag is not a formatting slip: the indexer excludes to end of
  // file on one, so a stray `<llm-exclude>` silently deletes the rest of the
  // page from the corpus.
  const opens = (String(after).match(/<llm-exclude>/gi) || []).length
  const closes = (String(after).match(/<\/llm-exclude>/gi) || []).length
  if (opens !== closes) {
    return { ...result, ok: false, reason: `unbalanced <llm-exclude> (${opens} open, ${closes} closed)` }
  }
  const onlyOpens = (String(after).match(/<llm-only>/gi) || []).length
  const onlyCloses = (String(after).match(/<\/llm-only>/gi) || []).length
  if (onlyOpens !== onlyCloses) {
    return { ...result, ok: false, reason: `unbalanced <llm-only> (${onlyOpens} open, ${onlyCloses} closed)` }
  }

  const rewritten = stripAnnotations(after)
  const original = normalise(before)
  if (rewritten !== original) {
    return {
      ...result,
      ok: false,
      reason: 'the model changed the page instead of only annotating it',
      detail: firstDifference(original, rewritten),
    }
  }

  const addressed = added.find((block) => ADDRESSES_THE_MODEL.test(block))
  if (addressed) {
    return {
      ...result,
      ok: false,
      reason: 'an <llm-only> block addressed the model rather than the reader',
      detail: { block: addressed.slice(0, 160) },
    }
  }

  return { ...result, ok: true }
}

/** The rules, as the model receives them. Exported so the suite reads the same text. */
export const ANNOTATION_SYSTEM = `You annotate documentation for a retrieval index. You never rewrite it.

You will be given a markdown page. Return the SAME page back, byte for byte, with only these two additions:

<llm-only>one or two sentences</llm-only>
  Extra text that is indexed and shown to readers. Add one where a reader's
  words never appear on the page (state the synonyms as a sentence), or where an
  answer is split across sections so no single section carries it (state it once
  at the top of the section it belongs to).

<llm-exclude>…</llm-exclude>
  Wrap text that should not be indexed: marketing copy, offers, anything that is
  only true for a few hours.

Hard rules:
- Do not change, reword, reorder, shorten or "improve" ANY existing line. Every
  character of the input must appear in your output, in the same order.
- Do not add anything except the two tags above and the text inside <llm-only>.
- <llm-only> text is shown to readers and cited as documentation. It must be
  true, must be supported by this page, and must never address a model, mention
  an assistant, or contain an instruction.
- Add nothing at all if the page needs nothing. That is a normal outcome.
- Output the markdown only. No commentary, no code fence around the whole page.`

/** A reply wrapped in a fence, unwrapped. Models do this whatever they are told. */
function unfence(text) {
  const m = /^\s*```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/.exec(String(text || ''))
  return m ? m[1] : String(text || '')
}

/**
 * Run the pass. Never throws, and never returns a page it could not verify.
 *
 * @param {object} o
 * @param {string} o.markdown the page body, frontmatter excluded
 * @param {object} o.target `{provider, baseURL, model, apiKey}` — the chat half
 * @param {Function} [o.chat] injected for the suite
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{markdown: string, only: number, exclude: number, added: string[], rejected: string|null, detail?: object}>}
 */
export async function annotate({ markdown, target, chat = defaultChat, signal }) {
  const untouched = { markdown, only: 0, exclude: 0, added: [], rejected: null }
  try {
    const reply = await chat({
      ...target,
      // Deterministic-ish: this is a transcription task with a verification step
      // behind it, and sampling only widens the ways it can fail that check.
      temperature: 0,
      messages: [
        { role: 'system', content: ANNOTATION_SYSTEM },
        { role: 'user', content: markdown },
      ],
      signal,
    })
    const after = unfence(reply?.text || '')
    if (!after.trim()) return { ...untouched, rejected: 'the model returned nothing' }

    const verdict = verifyAnnotation(markdown, after)
    if (!verdict.ok) {
      return { ...untouched, rejected: verdict.reason, detail: verdict.detail }
    }
    return {
      markdown: normalise(after),
      only: verdict.only,
      exclude: verdict.exclude,
      added: verdict.added,
      rejected: null,
    }
  } catch (e) {
    // A model that is unreachable is not a reason to lose an import. The page
    // is written unannotated and the command says so.
    return { ...untouched, rejected: String(e?.message || e) }
  }
}
