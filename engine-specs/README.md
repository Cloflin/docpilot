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
| [017](017-the-answer-the-author-wrote.md) | `{q, answer, cite}` — an opener's answer can be written by the author and shipped verbatim, never asked of the model |
| [018](018-the-evidence-a-paraphrase-already-bought.md) | a dense-matched opener that cannot serve its own text still hands the turn its evidence — a paraphrase in another language stops working from a weaker signal |
| [019](019-the-gate-cannot-read-the-readers-language.md) | `guard.mode` defaults to `'off'` — no threshold survives every language a site's readers use, so the model decides instead |
| [020](020-a-turn-that-cost-twelve-requests.md) | a refusal's body is read and classified, so a parameter 404 retries the same model with less in it instead of buying the identical refusal once per pool member |
| [021](021-a-model-nobody-wrote-down.md) | silence stops resolving to a ten-id pool — `openrouter` gets `openrouter/free` as its default, `chat.chain` ships `false`, and a list is something you write down |
| [022](022-the-turn-that-forgot-what-it-was-following.md) | three defects between one turn and the next: the cited ids come back with a restored turn, a prior answer reaches the model as its skeleton rather than its first 300 characters, and `search_docs` searches the query the gate won on — both halves of it |
| [023](023-an-antecedent-one-hop-short.md) | an ellipsis chains two questions back when the turn it follows was itself composed — and the eval sets learn to hold a conversation longer than one pair |
| [024](024-the-code-the-last-answer-showed.md) | measured, not adopted: a host-built summary of the previous turn (its code, its sources) lost or tied against the control in two A/B runs — 013 and 022 already carry what a follow-up needs |
| [025](025-the-word-the-embedder-never-saw.md) | the embedder reads the corpus's own terms beside the reader's: `embedQuery` appends the canonicals a question's vocabulary aliases name, so a Russian question stops losing to dense ordering the section lexical already ranked first |
| [026](026-the-last-answer-and-the-summaries.md) | the last answer travels whole and each older one as the model's own one-line `summary` — five transcript shapes A/B-tested on five-turn chains; none beat the skeleton outright, this one wins on clarifications and loses on rewrites |
| [027](027-one-bit-a-dimension.md) | chunk vectors as one sign bit per dimension against a float question, scaled back onto the cosine by one fitted number — 2.3 MB → 291 KB on a 4096-dimension embedder with recall@8 unchanged; `auto` keeps int8 where the bit's error says it cannot afford it |
| [028](028-the-turn-on-the-owners-server.md) | `runtime: 'server'` — the turn runs in `@cloflin/docpilot/server` and streams to the panel; a turn log, and `traffic`, `dataset`, `llms` and `model` that read it |
| [029](029-the-corpus-every-claim-is-measured-on.md) | Harborline, a documentation site for a product that does not exist, and an `eval` that runs the server turn, a dev/test split, security probes, nDCG, context precision and first-token latency |
| [030](030-the-terminal-shows-the-numbers.md) | terminal primitives with no dependency; the home screen, `docpilot status` and `docpilot monitor`; progress bars and the eval scorecard |
| [031](031-the-server-turn-fast-and-watched.md) | stage timings and the ranking in the turn log, `GET {endpoint}/metrics`, warm boot, caches, and `server.turn` — one-shot without reasoning brings the first token from 46.6 s to 10.5 s locally |
| [033](033-the-server-turn-guarded.md) | limits on by default, a turn deadline, a capped body, signed history (F11), a leak guard on the owner's instructions, no dotfiles from `serve --dir` |
| [034](034-the-static-index-verified.md) | every index file named by its own bytes with its SRI in the manifest; four retrieval and compression levers measured on two corpora, none adopted as a default |
| [035](035-the-edit-a-report-asks-for.md) | `docpilot improve plan\|compare\|check`; llms.txt as page descriptions measured and not adopted — a vocabulary gap is fixed in the section that answers |
| [036](036-the-agent-that-tunes-a-site.md) | the `docpilot-tuner` and `docpilot-writer` agents and the `docs-tune` skill, with a model and an effort per task |
| [037](037-two-installs.md) | the install is the first question: `init --runtime=browser\|server`, the docs open with the choice, and 2.0's breaking defaults are listed with the setting that restores 1.x |

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
