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
