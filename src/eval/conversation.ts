/**
 * A record's conversation, RUN — the one place in src/eval that walks it.
 *
 * `record.js` answers which questions precede the scored one. This answers what
 * happens when they are ASKED: every prior question is a real turn, it retrieves
 * for itself, it wins or loses its own gate, and which question the next turn
 * composes against is decided by that result rather than by position in the
 * array. Five runners each held a private copy of that walk and not one of them
 * got past the first hop — `rec.prev_question` read straight off the record in
 * run.js, calibrate.js, tune.js, answer-bench.js and lint-golden.js — and two of
 * the five spelled the composition by hand as well: `${rec.prev_question}\n${rec
 * .question}` at calibrate.js:650, :766 and :1254, and again at
 * answer-bench.js:310 and :401 where the string is what gets a vector bought for
 * it. Each of those agreed with `composeQuery` by inspection and by nothing
 * else; the day one stopped agreeing, the report would have named a query the
 * panel never sends and there is no assertion anywhere that would have caught
 * it. That is the drift `record.js`'s header names, and closing it is why the
 * composition is IMPORTED here and may never be restated — the eval's
 * composition and the panel's have to be one expression.
 *
 * NOT IN `record.js`, and that file says so itself: it is scoped to the
 * record's SHAPE and forbids itself the rule — "Which of those questions becomes
 * the antecedent is a RULE, it depends on how the prior turn won its gate".
 * Depending on how a turn won its gate means running the turn, which means an
 * index, a retriever and an embedder; a shape accessor that pure callers rely on
 * cannot acquire those. The split is the dependency.
 *
 * Pure by contract in the same sense levels.js and record.js are: no fs, no
 * process, no env, no provider. The retriever and the embedder arrive as
 * parameters, so a caller that has already resolved its endpoint keeps its own
 * diagnosis of a dead one — the wording `run.js` does better than this file
 * could.
 */
import { chainAntecedent, composeQuery } from '../theme/docpilot/gate.js'
import { priorQuestions } from './record.js'

/**
 * Every text a run of this record may need to embed, for the batched prefetch.
 *
 * The prefetch has to name its texts BEFORE the cascade runs, and the cascade's
 * antecedents are not known until it has: turn i's antecedent depends on how
 * turn i-1 won. Enumerating is what breaks that circularity, and it is finite
 * for a reason that belongs to `chainAntecedent` rather than to this file — it
 * reads exactly one flag, `composed` on the LAST element of the prior it is
 * handed, so enumerating that one flag's two values enumerates every antecedent
 * a chain of a given length can produce. Guessing instead, by running the
 * cascade twice or by predicting the channel from the question, is how a probe
 * gets somebody else's vector or a run silently drops back to buying one text
 * per request against a tier that meters requests.
 *
 * NO EXISTING RUN CHANGES ITS REQUEST COUNT. For depth 0 the result is
 * `[rec.question]` and for depth 1 it is `[prev, question, prev\nquestion]` —
 * the second and third of those coincide because `chainAntecedent` cannot chain
 * with one prior turn (`older` is null, so both values of the flag return
 * `last.question`) — and that is exactly the set `run.js:495` buys today. Only a
 * depth >= 2 record, which no set could express before now, adds a text.
 * `prefetchEmbeddings` dedupes through a `Set` and drops falsy entries, so the
 * duplicate and the composition of a first turn both cost nothing.
 */
export function chainTexts(rec) {
  const all = [...priorQuestions(rec), rec.question]
  const out = []
  for (let i = 0; i < all.length; i++) {
    out.push(all[i])
    const prior = all.slice(0, i)
    if (!prior.length) continue
    for (const composed of [false, true]) {
      const turns = prior.map((question, j) => ({ question, composed: j === prior.length - 1 && composed }))
      out.push(composeQuery(all[i], chainAntecedent(turns).text))
    }
  }
  return out
}

/**
 * The cascade — every prior turn asked in order, then the antecedent the SCORED
 * question inherits from them.
 *
 * SEQUENTIAL, WHICH IS WHY IT IS A LOOP AND NOT A `map`. Turn i is gated against
 * turn i-1's antecedent, and turn i-1's antecedent is a function of turn i-2's
 * channel; nothing here is a function of the record alone. A `map` over
 * `priorQuestions(rec)` would have to invent each turn's antecedent from its
 * index, which is the length test `chainAntecedent`'s docblock already refuses
 * one screen further down: the decision is a measurement of the previous turn,
 * not of this one.
 *
 * `composed` IS READ OFF THAT TURN'S OWN EVALUATED GATE AND OFF NOTHING ELSE.
 * `chainAntecedent` documents the flag as "the caller's reading of that turn's
 * own gate record", and `session.js:1710` reads it as `gate.channel ===
 * 'composed' && gate.antecedent === 'question'`. The second conjunct
 * distinguishes a composed win over the reader's QUOTE from one over the
 * previous question — `antecedent: selected ? 'quote' : previous ? 'question' :
 * null` at session.js:2382 — and no eval passes a quote, so over this population
 * it is vacuous and `channel === 'composed'` alone is the faithful reading of
 * the same rule.
 *
 * Neither constant is available instead. Hard-coding `false` pins every turn to
 * the single hop and makes the second hop structurally unmeasurable: the chain
 * records exist precisely to exercise it, and a run that always declines it
 * would report the pre-023 behaviour under the new records' names. Hard-coding
 * `true` composes two hops for every ordinary chain, where production composes
 * one, and the report then measures a query the panel never sends — the same
 * defect as a hand-written join, arrived at from the other side.
 *
 * @param embed `(text) => Promise<vector>`, the caller's. `lexical` means no
 *   vector is bought at all, and the two slots are then exactly what that mode
 *   is today: `queryVec` undefined, `composedVec` null where there is a composed
 *   query — `evaluate()` reads the difference, and undefined would score the
 *   follow-up on the raw channel alone against a `tauLexical` measured on both.
 * @returns `priors`, `priorGates` and `priorVecs` are the same length and the
 *   same order, oldest first; `priors` is `chainAntecedent`'s argument shape
 *   verbatim, so a caller may hand it straight on.
 *
 *   `priorVecs` COSTS NOTHING AND IS RETURNED BECAUSE THE ALTERNATIVE IS WRONG.
 *   The vector is already bought one line down, for that hop's own gate, and
 *   `chainTexts` already named every prior question to the batcher — so this is
 *   the value the prefetch paid for handed back, not a second purchase. What
 *   made it worth returning is what a caller does without it: a priming turn
 *   swapped only its gate keeps the SCORED question's vector, and a `search_docs`
 *   inside that turn then fuses BM25 over the hop's question with cosine over a
 *   question nobody has asked yet. The hop's answer becomes the scored turn's
 *   history and its spec-013 priming, so the wrong vector moves the measured row
 *   rather than only the hop. Under `lexical` every entry is `undefined`, which
 *   is exactly what that mode's single vector slot already is.
 */
export async function resolveChain({ rec, retrieval, embed, lexical = false }) {
  const priors = []
  const priorGates = []
  const priorVecs = []

  for (const question of priorQuestions(rec)) {
    // `chainAntecedent` returns `{text: null}` for an empty prior by its own
    // contract, so the first turn needs no branch here: it runs as the plain
    // turn it is, with no composed channel to score.
    const antecedent = chainAntecedent(priors).text
    const composedText = composeQuery(question, antecedent)

    let queryVec
    if (!lexical) queryVec = await embed(question)
    let composedVec
    if (composedText) composedVec = lexical ? null : await embed(composedText)

    const gate = retrieval.evaluate({
      question,
      previousQuestion: antecedent,
      queryVec,
      composedVec,
      mode: lexical ? 'lexical-only' : 'hybrid',
    })

    priorGates.push(gate)
    // Pushed in the same statement group as the gate, and deliberately so: the
    // two lists are indexed together by every caller, and a hop that reads a
    // gate at `i` and a vector at anything else is the defect this list exists
    // to close.
    priorVecs.push(queryVec)
    priors.push({ question, composed: gate.channel === 'composed' })
  }

  const antecedent = chainAntecedent(priors).text
  return {
    priors,
    priorGates,
    priorVecs,
    antecedent,
    composedQuery: composeQuery(rec.question, antecedent),
  }
}
