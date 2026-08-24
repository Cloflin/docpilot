# Skills

`npx docpilot init` copies two skills into `.claude/skills/`. They are the written-down half of running this thing: what to measure, what has already been measured, and what an edit is allowed to break.

## Why they are copied

A skill inside `node_modules` reaches nobody — `.claude/` is discovered in the project, not in a dependency. Copying is the only delivery mechanism there is, which is why it is part of `init` rather than a documented step someone might skip.

They are yours once copied. Edit them: the numbers in them are about the corpus this package was developed against, not yours.

## Copied once — including across upgrades

`init` writes a file only where nothing is at that path already, and reports every one as `wrote` or `kept … (already there)`. That is what makes running it twice safe, and running it in an existing project honest.

The half of the rule nobody expects is that it holds **across package upgrades too**. A project that ran `init` once keeps its original copies of these skills forever. Upgrade the package and the skill inside `node_modules` may gain a measurement that reverses a recommendation, while `.claude/skills/docs-rag/SKILL.md` still says the old thing — and nothing in the install, the build or `doctor` mentions the difference. The agent goes on following an outdated manual, and it does so confidently.

The only signal is `init`'s own output:

```
[docpilot] kept     .claude/skills/docs-rag/SKILL.md   (already there)
```

After an upgrade that line says exactly this: the file you have is not the one the package you just installed carries.

There is no merge, and there should not be: these files are edited in place by design, and an upgrade that overwrote a local edit would be the worse failure. So the refresh is deliberate:

```bash
# what moved, before deciding anything
diff -ru .claude/skills/docs-rag node_modules/@cloflin/docpilot/skills/docs-rag

rm -rf .claude/skills/docs-rag
npx docpilot init
```

Delete only the skill you mean to refresh — `init` re-copies whatever is missing and leaves the rest alone. If you have edited your copy, that `diff` is the whole decision: reapply your edits on top of the new one.

### What changed in `docs-rag` this release

Enough to be worth the diff. All of it is in **Things already measured**, which is the section an agent quotes at you when it declines to re-derive something:

- **`underPath` had no page pin, and every retrieval number this package printed was about seven points low.** A gold entry written as `path#` — the documented shape for a question a whole page answers — matched the lead chunk and nothing else, so retrieving the right page *and* the right section of it scored a miss. Measured over the 44 answerable development records: recall@8 0.761 → 0.830. Deltas measured with the old matcher are still valid; absolutes are not, and a comparison against the ancestor project's reports is not a baseline.
- **The dense channel carries the system; BM25 is the accessory.** Three configurations measured `--gate-only`, then split by the language of the question. Turning BM25 off costs about four points of recall and refuses nothing extra. Turning the *embedder* off costs twenty-five points and refuses 11 of the 12 Russian positives before a model is ever called, each with lexical coverage of exactly zero. The entry ends in a decision rule for anyone proposing `embed: false`, and in what a query embedding actually costs.
- **The lexical tokenizer is asymmetric on purpose.** The index emits the compound identifier *and* its parts while the query side stays plain, because used symmetrically a bare `initEditor` cannot reach `window.initEditor` at all — 14 hits to 1. With the measured gain, the one metric that pays for it, and an instruction not to "simplify" it to one tokenizer.
- **An exact-identifier retrieval channel was measured and reverted.** Only 7 of 44 positives contain anything the identifier grammar recognises, and six of those are English acronyms — searching them promotes whichever page says "HTML" most.
- The pipeline summary and the embedder rule now cover the third answer to "we have no embedding provider": `embed: false`, retrieving lexically and asking nobody, with the recall numbers above attached to the choice.

## `docs-rag`

The measurement and tuning loop. Six modes:

| mode | what it does |
|---|---|
| `eval` | run the golden set, read the report, state a verdict, change nothing |
| `generate` | author golden records — stratified sampling, then a mandatory editing pass |
| `bench` | A/B two retrieval configurations on answer quality, with no API key |
| `tune` | propose edits, each naming a file, a change, and the metric it should move |
| `corpus` | fix the **documentation** when no retrieval constant will help |
| `llms` | make the docs readable by agents that are not this panel |

The `tune` row is the skill's authoring mode — a list of proposed edits over five levers, in increasing order of risk — and not [`npx docpilot tune`](/guide/evaluation#when-eval-says-retrieval-is-the-problem), which measures two of those levers and writes the answer to a file. The mode reasons about the other three, which no sweep can decide.

Plus two sections that matter more than the modes:

**Binding rules** — the thresholds are not levers, an LLM judge may never gate, a prompt edit lands alone, and anything that regresses a metric by more than two percentage points is reverted.

**Things already measured** — a list of experiments that have been run, with what they cost. MMR diversity, heading ancestors in the chunk context line, excerpt size 1200 → 2400, three-runs-not-one, why `citationPrecision` needs `citationRecall` read beside it. Each entry exists so that the next person does not spend a day re-deriving a negative result.

Two files travel with it. `answerer-protocol.md` and `judge-protocol.md` are given verbatim to the agents the bench spawns — checked in, because a protocol that lives in a chat message is one nobody can reproduce, and a bench whose instruction drifted between runs measured nothing.

`scripts/sample-chunks.js` prints a stratified slice of the index for golden-set authoring. Documentation is never evenly sized, and sampling proportionally to chunk mass produces an eval of whichever corner has the most pages.

## `docs-import`

The contract for [imported pages](/guide/imported-pages). What lives here and not in `docs-rag`:

- **the allowlist**, and that it is a security boundary rather than a preference;
- **the extraction rule** — convert the markup, never index a paraphrase. A fetch tool that "summarises" a page returns sentences nobody at the source wrote, and the assistant then cites them;
- **the page contract** — unique title, `description` written as a question, `source` at column 0, a mandatory attribution block;
- **the annotation pass** — vocabulary gap, structure, dilution, and which of the three has no fix;
- **the gate order** an import has to pass, ending in a re-calibration because the corpus hash moved.

## Using them without Claude Code

They are markdown. The rules hold whoever is reading them, and the "things already measured" list is worth reading before touching a retrieval constant regardless of what is doing the touching.
