/**
 * Stage A of `eval` — retrieval, the gate and the ranked list, once per record.
 *
 * ONE RANKING ENGINE, shared by `eval`, the baseline capture and the offline
 * replay of a frozen baseline (`src/eval/baseline.ts`). It exists as a module of
 * its own because a baseline that is replayed through a second copy of this
 * code measures the copy: the day the two disagreed, `verify` would report a
 * ranking diff that no change to the product caused, or — worse — stay green
 * while the product moved. `run.ts` could not host it, because `run.ts` parses
 * flags, loads `.env.local` and may `process.exit` the moment it is imported.
 *
 * Everything here is a pure function of (index, guard, records, embed). The
 * embedder arrives as a parameter: `eval` hands in the network one (with its own
 * endpoint diagnosis), a replay hands in a Map over frozen vectors.
 *
 * It NEVER reaches the network, never reads `process.env`, never calls
 * `process.exit`, and imports no provider. A failure of `embed` propagates to
 * the caller, which owns the wording of what it means.
 */
import { createRetrieval } from '../theme/docpilot/retriever.js'
import {
  retrievalF1Loose,
  recallAtK,
  mrr,
  ndcgAtK,
  contextPrecisionAtK,
  scopeContainment,
  pageOf,
  underPath,
} from './metrics.js'
import { resolveChain } from './conversation.js'

const ALL_SCOPE = { kind: 'all', paths: [], label: 'All docs' }

/**
 * Everything here is a pure function of (index, guard, record). It is computed
 * before any model is contacted and reused across the whole matrix.
 *
 * @param embed `(text) => Promise<Float64Array>` in the index's own domain
 *   (L2-normalised, ×127). Never called under `lexical`.
 * @param lexical No embedder at all: BM25 only, the configuration `--lexical`
 *   measures and a vectorless index forces.
 */
export async function rankRecords({ index, guard, records, embed, lexical = false }) {
  const probes = []
  for (const rec of records) {
    const scope = rec.scope || ALL_SCOPE
    // `tuning` is not optional here even though the parameter is. The manifest
    // carries what `docpilot tune` measured on THIS corpus, and it is what the
    // browser bundle resolves its levers from — omitting it would score the
    // package defaults and file the result as this deployment's retrieval
    // quality, which is the one thing a report may never be wrong about.
    const retrieval = createRetrieval({ index, scope, guard, tuning: index.manifest.tuning })

    let vec
    if (!lexical) vec = await embed(rec.question)

    /**
     * THE PRIMING TURNS NEED THEIR OWN GATES, and running them without one is a
     * measurement error rather than an economy.
     *
     * Every question before the scored one is a real turn: in production it runs
     * its own retrieval and is primed with what ITS question found. Here they
     * were handed `probe.g` — the gate of the SCORED question — so a priming
     * turn answered its own question from evidence retrieved for another.
     *
     * Two consequences, and the second is what made this worth an embedding.
     * The answer that becomes history was written from the wrong excerpts, so
     * the window §4.5 exercises is not the window production builds. And
     * anything the scored turn INHERITS from a priming one — spec 013 primes it
     * with the chunks that answer cited — is inherited out of the scored turn's
     * own gate result, lands in `primed` already, and dedupes away to nothing.
     * The feature was structurally unmeasurable: byte-identical prompt tokens on
     * all eight follow-ups, which is what sent us looking.
     *
     * ONLY THE ARITY MOVED. `resolveChain` runs that same argument once per hop
     * — every prior question in order, each gated against the antecedent the
     * turn before it left — because the antecedent the SCORED question inherits
     * is a function of which channel each of those gates won on and not of where
     * a question sits in the array. A `map` over the chain would have to invent
     * each hop's antecedent from its index, which is the position test
     * `chainAntecedent` refuses.
     */
    const { priorGates, priorVecs, antecedent, composedQuery } = await resolveChain({
      rec,
      retrieval,
      embed,
      lexical,
    })

    // A follow-up record's first turn is a real turn: the composed channel only
    // exists when there is an antecedent to compose with. The string arrives
    // from `resolveChain`, which builds it with `composeQuery`, so the vector
    // embedded here and the query `evaluate()` composes internally can never
    // drift apart.
    let composedVec
    if (composedQuery && !lexical) {
      composedVec = await embed(composedQuery)
    }
    // A composed follow-up still has a lexical channel, so the composed run must
    // happen under --lexical too: `undefined` skips it, `null` runs it with no
    // vector. Skipping it would score follow-ups on the raw channel alone and
    // charge the difference to the missing embedder.
    if (lexical && composedQuery) composedVec = null

    const g = retrieval.evaluate({
      question: rec.question,
      previousQuestion: antecedent,
      queryVec: vec,
      composedVec,
      mode: lexical ? 'lexical-only' : 'hybrid',
    })

    const retrievedIds = g.chunks.map((c) => c.id)
    // Recall and MRR need a longer ranked list than the gate's k=5. The
    // retriever clamps k at 8 for the model, and a diagnostic is not a reason to
    // widen the choke point's public contract — so this is recall@8, named as
    // such, rather than the spec's @10 measured through a back door.
    //
    // It must rank on the channel the gate ACTUALLY WON ON, not on the bare
    // question. `evaluate()` runs two channels and keeps the higher-G admissible
    // one; on a follow-up that is normally `composed`, and the chunks the model
    // then sees come from it. Ranking the bare question instead measured a query
    // no turn ever issues: `q-25` scored recall8 = 0 with its gold at rank 1 of
    // `retrievedIds`. Both halves of the channel move together — `evaluate()`
    // composes the lexical query and the vector, so pairing a raw `query` with a
    // `composedVec` would invent a third configuration that production has no
    // path to.
    const ranked =
      g.channel === 'composed' && composedVec
        ? { query: composedQuery, queryVec: composedVec }
        : { query: rec.question, queryVec: vec }
    const rankedIds = retrieval.search({ ...ranked, k: 8 }).map((c) => c.id)

    // RAG-SPEC 5.1: for a scoped record whose gold set does not intersect the
    // scope, the correct outcome is a refusal — scoring it as F1 0 would punish
    // the gate for doing exactly what the scope asked of it.
    //
    // `?? []` because the LINTER, which docs/guide/evaluation.md names as the
    // authority on this schema, does not require the field on a negative record:
    // it errors only on a `refuse:no-evidence` record whose gold list is
    // NON-empty. Every negative in this repository's own set happens to carry
    // `gold_chunks: []`, so the bare read worked by convention rather than by
    // contract — and the first authored record that left the key out took the
    // whole run down with `Cannot read properties of undefined`, after the
    // embedder had already been paid for all 279 queries. A runner that crashes
    // on a record the linter passes is the two of them disagreeing about the
    // schema, and the runner is the one that must yield.
    const gold = rec.gold_chunks ?? []
    const goldInScope =
      scope.kind === 'all' || !scope.paths.length
        ? gold
        : gold.filter((gc) => scope.paths.some((p) => underPath(`/${gc}`, p)))
    const scoredAsNegative = gold.length > 0 && goldInScope.length === 0

    probes.push({
      rec,
      scope,
      retrieval,
      vec,
      composedVec,
      // The composed query `composedVec` belongs to, carried rather than rebuilt
      // at the two places that read it — `ranked` above and the scored turn's
      // own call. A second `composeQuery` here would be a second place for the
      // antecedent to be chosen, and the cascade is the only one entitled to.
      composedQuery,
      g,
      // The gate each PRIOR turn ran under, oldest first — empty for a record
      // with no chain, and never consulted for the scored turn.
      priorGates,
      // And that turn's own query vector, same length and same order. It rides
      // beside the gate because `primingProbe` has to swap the two TOGETHER: the
      // vector `vec` two fields up is `embed(rec.question)`, the question the
      // priming hop has not been asked yet. Bought inside `resolveChain` for the
      // hop's own gate and prefetched by `chainTexts`, so carrying it here costs
      // no request.
      priorVecs,
      // What the index was built with, so a turn can buy a vector for a query
      // the model writes without reaching back for the manifest — spec 015.
      embedModel: index.manifest.embedModel,
      retrievedIds,
      // The ranked eight the two retrieval metrics are read off. It was built
      // here and thrown away, so a report could say recall@8 was 1 and never say
      // WHERE the gold sat — the difference between a ranking problem and a
      // corpus problem, and the two have different fixes.
      rankedIds,
      goldPages: [...new Set(goldInScope.map((g) => pageOf(g)))],
      scoredAsNegative,
      retrieval_f1: goldInScope.length ? retrievalF1Loose(retrievedIds, goldInScope) : null,
      recall8: goldInScope.length ? recallAtK(rankedIds, goldInScope, 8) : null,
      mrr: goldInScope.length ? mrr(rankedIds, goldInScope) : null,
      // The standard lenses beside the two this report always printed — engine-
      // spec 029. Read off the same ranked eight, so every number in one row
      // describes one ranking.
      recall1: goldInScope.length ? recallAtK(rankedIds, goldInScope, 1) : null,
      recall3: goldInScope.length ? recallAtK(rankedIds, goldInScope, 3) : null,
      recall5: goldInScope.length ? recallAtK(rankedIds, goldInScope, 5) : null,
      ndcg8: goldInScope.length ? ndcgAtK(rankedIds, goldInScope, 8) : null,
      contextPrecision5: goldInScope.length ? contextPrecisionAtK(rankedIds, goldInScope, 5) : null,
      scopeContainment: scopeContainment(retrievedIds, scope),
    })
  }
  return probes
}
