# Skills

`npx docpilot init` copies two skills into whichever agent tool you told it to. They are the written-down half of running this thing: what to measure, what has already been measured, and what an edit is allowed to break.

## Why they are copied

A skill inside `node_modules` reaches nobody. Every tool that reads Agent Skills — Claude Code, Codex, Cursor, Copilot — discovers them in the project or in your home directory and never in a dependency. Copying is the only delivery mechanism there is, which is why it is part of `init` rather than a documented step someone might skip.

They are yours once copied. Edit them: the numbers in them are about the corpus this package was developed against, not yours.

## Where they go

`init` asks. `--target` and `--scope` answer it without asking, and the full table is in the [CLI reference](/reference/cli#init-targets):

| `--target=` | `--scope=project` | `--scope=user` |
|---|---|---|
| `claude` | `.claude/skills/` | `~/.claude/skills/` |
| `codex` | `.codex/skills/` | `~/.codex/skills/` |
| `cursor` | `.cursor/skills/` | `~/.cursor/skills/` |
| `copilot` | `.github/skills/` | `~/.copilot/skills/` |
| `agents` | `.agents/skills/` | `~/.agents/skills/` |

`--target=claude --scope=project` is the default, which is where every install before this feature existed put them. `--skills-dir=DIR` covers a tool the table has not heard of.

## Every command, as a slash command

`init` also generates one slash command per CLI command into the same tool — `/docpilot-index`, `/docpilot-eval`, `/docpilot-lint`, `/docpilot-update`, all eleven. Each carries that command's own flags, rendered from the table the CLI validates against, so they cannot describe a flag the CLI does not have.

They are generated rather than authored, and `npx docpilot update` rewrites them from the installed package. `--no-commands` turns them off if a picker with eleven more entries in it is not what you want.

## Refreshing them after an upgrade

```bash
npx docpilot update --dry     # what would change, and to which files
npx docpilot update           # do it
```

`init` writes a file only where nothing is, which is what makes it safe to re-run — and useless for an upgrade. A project that ran it once kept its copy of the skills across every release that rewrote them, file by file, so a skill directory could end up half of one release and half of another with nothing on screen to say so. The agent went on quoting a superseded measurement, confidently.

`update` is the answer to that, and it knows what it is allowed to replace. Beside every installed skill sits `.docpilot.json` with the release that wrote it and a hash per file, so a file we wrote and nobody touched is replaced in silence, and a file **you edited** is replaced with your version kept beside it:

```
[docpilot] REPLACED .claude/skills/docs-rag/judge-protocol.md   (your copy kept as judge-protocol.md.bak)
```

There is still no merge, and there should not be — these files are edited in place by design. What changed is that the edit no longer has to be found by hand before an upgrade can be applied: it survives the upgrade, on disk, named in the report. Diff the `.bak` and reapply what you meant.

With no flags, `update` finds every install on the machine rather than being told where to look, so it refreshes a `~/.claude/skills/` copy from any project. It creates nothing new — only `--target=` installs somewhere it has not been. Full behaviour, including `--check` for CI, is under [`update`](/reference/cli#update).

## What changed in `docs-rag` this release

One new mode, and the rest is in **Things already measured**, which is the section an agent quotes at you when it declines to re-derive something.

`index` is the new one, and it is a rule about asking rather than a measurement: the embedder was always resolved silently from `.env.local` and the config file, so a build never said which one it had picked. It says so now, and `npx docpilot doctor --embed` lists every one this project could use. The measured entries:

- **`underPath` had no page pin, and every retrieval number this package printed was about seven points low.** A gold entry written as `path#` — the documented shape for a question a whole page answers — matched the lead chunk and nothing else, so retrieving the right page *and* the right section of it scored a miss. Measured over the 44 answerable development records: recall@8 0.761 → 0.830. Deltas measured with the old matcher are still valid; absolutes are not, and a comparison against the ancestor project's reports is not a baseline.
- **The dense channel carries the system; BM25 is the accessory.** Three configurations measured `--gate-only`, then split by the language of the question. Turning BM25 off costs about four points of recall and refuses nothing extra. Turning the *embedder* off costs twenty-five points and leaves 11 of the 12 Russian positives with lexical coverage of exactly zero — `--gate-only` scores every verdict regardless of `guard.mode`, so this is what those 11 turns would have had refuse them pre-model under `'calibrated'`/`'dense-only'`; under the shipped `'off'` (since 1.3) that same zero-coverage verdict reaches the model instead. The entry ends in a decision rule for anyone proposing `embed: false`, and in what a query embedding actually costs.
- **The lexical tokenizer is asymmetric on purpose.** The index emits the compound identifier *and* its parts while the query side stays plain, because used symmetrically a bare `initEditor` cannot reach `window.initEditor` at all — 14 hits to 1. With the measured gain, the one metric that pays for it, and an instruction not to "simplify" it to one tokenizer.
- **An exact-identifier retrieval channel was measured and reverted.** Only 7 of 44 positives contain anything the identifier grammar recognises, and six of those are English acronyms — searching them promotes whichever page says "HTML" most.
- The pipeline summary and the embedder rule now cover the third answer to "we have no embedding provider": `embed: false`, retrieving lexically and asking nobody, with the recall numbers above attached to the choice.

## `docs-rag`

The measurement and tuning loop. Eight modes:

| mode | what it does |
|---|---|
| `index` | show the user every embedder this project could build with, ask which, then build — and never overwrite an index built by a different one |
| `eval` | run the golden set, read the report, state a verdict, change nothing |
| `generate` | author golden records — stratified sampling, then a mandatory editing pass |
| `bench` | A/B two retrieval configurations on answer quality, with no API key |
| `tune` | propose edits, each naming a file, a change, and the metric it should move |
| `faq` | choose the three to five openers the empty state shows — from reader votes, or from the corpus when there are none — and read what `index` says about them |
| `corpus` | fix the **documentation** when no retrieval constant will help |
| `llms` | make the docs readable by agents that are not this panel |

The `tune` row is the skill's authoring mode — a list of proposed edits over five levers, in increasing order of risk — and not [`npx docpilot tune`](/guide/evaluation#when-eval-says-retrieval-is-the-problem), which measures two of those levers and writes the answer to a file. The mode reasons about the other three, which no sweep can decide.

Plus two sections that matter more than the modes:

**Binding rules** — the thresholds are not levers, an LLM judge may never gate, a prompt edit lands alone, and anything that regresses a metric by more than two percentage points is reverted.

**Things already measured** — a list of experiments that have been run, with what they cost. MMR diversity, heading ancestors in the chunk context line, excerpt size 1200 → 2400, three-runs-not-one, why `citationPrecision` needs `citationRecall` read beside it. Each entry exists so that the next person does not spend a day re-deriving a negative result.

Two files travel with it. `answerer-protocol.md` and `judge-protocol.md` are given verbatim to the agents the bench spawns — checked in, because a protocol that lives in a chat message is one nobody can reproduce, and a bench whose instruction drifted between runs measured nothing.

`scripts/sample-chunks.js` prints a stratified slice of the index for golden-set authoring. Documentation is never evenly sized, and sampling proportionally to chunk mass produces an eval of whichever corner has the most pages.

`scripts/opener-candidates.js` proposes the empty state's questions from the corpus, for a site that has no reader votes to cluster yet. It harvests what the docs already phrase as a question — an `<FaqAccordion>` entry, an interrogative heading — and falls back to the one template the panel already ships for follow-ups over a page title, then ranks, keeps one per section, and refuses a pair the panel would refuse to match. It runs the real retriever in its lexical-only mode, so every candidate carries a real gate score for zero requests; that score is a floor rather than a pass, because the panel's gate is hybrid. It proposes and never writes, and the verdict is still the `openers` block of `npx docpilot index`.

`scripts/opener-collisions.js` measures the false-positive floor for [`suggestions.matchTau`](/reference/config#suggestions-matchtau) by scoring every calibration probe against every configured opener. A probe is not an opener, so every score it produces is a false positive waiting to happen.

`scripts/opener-cosines.js` is its twin for [`suggestions.matchCos`](/reference/config#suggestions-matchcos), and the pair is the point: the lexical test returns exactly zero for a paraphrase built out of different words, which no threshold rescues, and the dense one returns 0.35 for a question about nothing in particular. It scores the same probes against the openers' own shipped vectors, refuses to run against an index it was not built for, and costs one request per probe — so it defaults to a subset and documents the free way to run it, against the second index.

## `docs-import`

The contract for [imported pages](/guide/imported-pages). What lives here and not in `docs-rag`:

- **the allowlist**, and that it is a security boundary rather than a preference;
- **the extraction rule** — convert the markup, never index a paraphrase. A fetch tool that "summarises" a page returns sentences nobody at the source wrote, and the assistant then cites them;
- **the page contract** — unique title, `description` written as a question, `source` at column 0, a mandatory attribution block;
- **the annotation pass** — vocabulary gap, structure, dilution, and which of the three has no fix;
- **the gate order** an import has to pass, ending in a re-calibration because the corpus hash moved.

## Using them without an agent tool at all

They are markdown. The rules hold whoever is reading them, and the "things already measured" list is worth reading before touching a retrieval constant regardless of what is doing the touching.

The three scripts under `docs-rag/scripts/` are plain Node and run from anywhere; the invocation lines in the skill are written with the directory it was installed into, so they are copy-pasteable wherever it landed.
