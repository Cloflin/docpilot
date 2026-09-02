# Engine specs

Sibling of [`ui-specs/`](../ui-specs/README.md), and the split between them is
the only thing that needs stating: `ui-specs/` records changes **a reader can
see**. This directory records changes to the parts a reader never looks at and
every answer depends on — what enters the corpus, how it is chunked, how it is
ranked, and what the agent loop is allowed to do.

**The current state is not here.** It is
[`skills/docs-rag/SKILL.md`](../skills/docs-rag/SKILL.md) — the RAG-SPEC the code
cites by section number in its own comments (`RAG-SPEC 2.3`, `3.4`, `5.6`). That
file is kept true the way `ui-specs/000` is kept true, and it wins over anything
written here.

**Everything numbered in this directory is a record**, not a specification of the
present. Each is written *before* its change, states the problem it solved and
the research behind it, and is left alone afterwards. Where a value in one has
since moved, RAG-SPEC wins.

The rule this directory exists to enforce:

> A change that moves the **corpus**, the **ranking** or the **agent loop** gets
> a spec and a research pass first. A change that moves an **invariant** updates
> RAG-SPEC and `scripts/check-docpilot.sh` in the same commit.

## Index

| spec | what it changed |
|---|---|
| [001](001-index-a-built-site.md) | `index --html-dir` / `--sitemap` — a site that is already built is a corpus |
| [002](002-mdx-and-openapi-by-glob.md) | `.mdx` enters the walk; OpenAPI specs are found by glob, not by one hard-coded directory |
| [003](003-the-block-ir-seam.md) | The block stream inside `html-to-md` becomes a named type, and the chunker takes it directly |
| [004](004-expand-section.md) | `expand_section` — the model can ask for the neighbouring chunk instead of guessing across a boundary |
| [005](005-identifier-aware-tokens.md) | `getUserName` and `docPilot.sources.allow` are searchable by their parts as well as whole |
| [006](006-the-window-grid-has-its-own-floor.md) | the window grid starts at 0.00 — a floor of 0.16 could not describe an embedder whose cosines sit lower |
| [007](007-two-fields-nobody-read.md) | `prev` and `codeLangs` leave the chunk record — 4.1% of the shard bytes every reader downloads |
| [008](008-the-vectors-already-bought.md) | a content-addressed embedding cache — a one-file edit costs one request rather than fifteen |
| [009](009-a-question-the-build-already-answered.md) | `docpilot index` resolves `suggestions.questions` against the corpus, so a reader's first click costs no embedding request |
| [010](010-the-reader-the-table-already-has.md) | one flag reader for every command, four exit codes, and one law for `.env.local` |
| [011](011-a-report-that-names-its-witnesses.md) | an eval report records the host, the date and the golden set it measured, and a rerun stops erasing the last one |
| [012](012-the-vote-that-never-leaves-the-browser.md) | a reader's vote reaches the golden set: a receiver, a storage seam, and the triage rule the RAG-SPEC never carried |
| [013](013-the-evidence-the-last-turn-already-bought.md) | a follow-up is primed with the chunks the last answer cited — it could neither see them nor fetch them |
| [014](014-a-neighbouring-feature-is-not-the-answer.md) | the instruction names the case the gate cannot reach: excerpts about the neighbouring feature |
| [015](015-the-query-the-model-asked-for.md) | the model's own `search_docs` query reaches the dense channel, not just BM25 |
| [016](016-half-the-bytes-the-same-answers.md) | `embed.dimensions` — a matryoshka model can hand back a third of the bytes, and the guard is re-measured for it |

## Shape of a spec

```markdown
# 00N — <Title>

> **Кратко.** <2–4 sentences in Russian: what is wrong, what is done, what it risks.>

## Problem          — what is wrong, cited as `file.ts:line`, read rather than assumed
## Research         — precedent, measurement, why this path
## Decision         — the contract: what appears, what changes, what stays
## Why it fits      — why it lands on the system that exists rather than beside it
## Cost and risk    — price, risk, mitigation, and the condition that reverts it
## Checks           — what vitest or check-docpilot.sh enforces afterwards
## What this does not do
```

The first four sections are the question every entry has to answer before it gets
a number: *what is wrong → what we propose → why it fits the system → what it
costs.* The rest is what makes the answer checkable a year later.

## The loop a corpus change owes

A spec that changes what enters the corpus, or how text is tokenised, is not
finished when the tests pass. It owes the measurement loop the CLI already
documents, with the numbers before and after written into the spec:

```
docpilot index --dry → index → calibrate → lint → eval
```

Skipping it ships a `tau` calibrated against a distribution that no longer
exists.
