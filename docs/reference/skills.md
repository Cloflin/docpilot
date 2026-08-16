# Skills

`npx docpilot init` copies two skills into `.claude/skills/`. They are the written-down half of running this thing: what to measure, what has already been measured, and what an edit is allowed to break.

## Why they are copied

A skill inside `node_modules` reaches nobody — `.claude/` is discovered in the project, not in a dependency. Copying is the only delivery mechanism there is, which is why it is part of `init` rather than a documented step someone might skip.

They are copied once and never overwritten. Edit them: they are yours, and the numbers in them are about the corpus this package was developed against, not yours.

## `docs-rag`

The measurement and tuning loop. Five modes:

| mode | what it does |
|---|---|
| `eval` | run the golden set, read the report, state a verdict, change nothing |
| `generate` | author golden records — stratified sampling, then a mandatory editing pass |
| `bench` | A/B two retrieval configurations on answer quality, with no API key |
| `tune` | propose edits, each naming a file, a change, and the metric it should move |
| `corpus` | fix the **documentation** when no retrieval constant will help |
| `llms` | make the docs readable by agents that are not this panel |

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
