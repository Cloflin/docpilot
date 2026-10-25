---
name: docs-tune
description: Tune a DocPilot documentation site to its golden set, locally — measure retrieval and answers, edit llms.txt descriptions, vocabulary aliases and section structure from dev-split failures, prove each edit on the test split, and revert what does not help. Use when asked to improve DocPilot's answers or eval metrics, or to run the docpilot-tuner agent's loop by hand.
---

# docs-tune

The improvement loop for a site that uses `@cloflin/docpilot`, with the
deterministic work done by the CLI and only the WRITING done by a model. Every
number here comes from `npx docpilot` — nothing is estimated, and nothing is
claimed that a report does not show.

## The loop

```
status ─► baseline (dev + test) ─► improve plan ─► edit ─► improve check
   ▲                                                         │
   │                 keep ◄── improve compare ◄── index ◄─────┘
   └──────── revert ◄──┘                         + eval dev
                         ... until no item helps ─► eval test ─► report
```

1. **State.** `npx docpilot status --json` (or `npx docpilot doctor --json` on
   an older CLI). Stop and say why if there is no config, no golden set, or
   uncommitted changes under the docs directory or in `llms.txt` — every revert
   below is a `git checkout` of a file this loop changed, and that is only safe
   on a clean tree.
2. **Index.** If the index is stale or missing: `npx docpilot index --yes`.
3. **Baseline, once.** Run both halves before any edit, and keep both report
   paths (the last line of each run names it):
   ```bash
   npx docpilot eval --gate-only --split=dev --quiet     # free: retrieval only
   npx docpilot eval --split=dev --quiet                 # answers, on the configured model
   npx docpilot eval --split=test --quiet                # the proof's "before"
   ```
   Records without a `split` field are assigned by a hash of their id — never
   edit `golden.jsonl` to add one.
4. **Plan.** `npx docpilot improve --json` reads the newest dev report and
   returns items: `{id, lever, page, records, terms, action, files}`. Work the
   corpus items (`describe-page`, `alias`, `retitle-section`,
   `summarise-section`) in order; `investigate` items are not corpus edits —
   list them in the report and leave them.
5. **Edit one item** (or a few items on DIFFERENT pages, which do not interact).
   - `describe-page` — the readers' words (`terms`) go into the SECTION that
     answers: hand it to the writer as a `summarise-section` (one `<llm-only>`
     line naming what the section is, in the readers' words) or a
     `retitle-section`. A page description alone does not do it: measured on
     the Harborline benchmark, a description on the page's first chunk lifted
     the intro above the answering section and LOWERED nDCG@8 on exactly these
     records. Updating `llms.txt` too is fine — it is for other people's agents
     and does not move DocPilot's retrieval. For `languages` other than English,
     run `npx docpilot vocabulary --languages=<langs>` instead.
   - `alias` — add `reader term → page term` to `vocabulary.json` only where the
     page term is on the page.
   - `retitle-section` / `summarise-section` — hand the page and the item to
     the **docpilot-writer** agent (see the table below); it rewrites the
     heading or adds one `<llm-only>` line stating what the section already
     says.
6. **Guard.** `npx docpilot improve check --since=<baseline commit> --json`
   must return `ok: true`. If it names copied text, undo that text.
7. **Measure.** `npx docpilot index --yes`, then the gate-only dev eval; run
   the answer eval only when retrieval moved or the item was about answers.
8. **Decide.** `npx docpilot improve compare --before=<dev baseline> --after=<new dev report> --json`.
   `revert` → `git checkout -- <the files this item changed>` and re-index.
   `neutral` → revert too: an edit nobody can show helped is not kept.
   `keep` → the new report is the next baseline. On two gate-only reports
   `keep` also means a Pareto move — some record ranked better, none worse:
   a gate-only run calls no model, so the same corpus ranks the same way
   every time and a targeted fix needs no interval to be real.
9. **Stop** when the plan has no corpus item left, two rounds in a row keep
   nothing, or the budget below is spent.
10. **Prove.** `npx docpilot eval --split=test --quiet` on the final corpus, then
    `improve compare` against the test baseline. Only this comparison is the
    claim; dev numbers were used to choose the edits.
11. **Report** in `<evalDir>/improve/REPORT.md`: before → after on dev and on
    test for recall@8, MRR, nDCG@8, context precision@5, answer F1, citation
    precision and recall, negatives caught, latency p50/p95; the edits kept and
    reverted, each with its item id; the `investigate` items untouched.

## Models and effort, per task

Spend tokens where judgement is needed and nowhere else.

| task | who | model | effort |
|---|---|---|---|
| index, eval, improve plan/check/compare, status | the CLI | none | — |
| read a plan, choose items, run the loop | docpilot-tuner | sonnet | medium |
| an alias, an llms.txt line | docpilot-tuner | sonnet | medium |
| a heading rewrite, an `<llm-only>` summary | docpilot-writer | sonnet | high |
| an advisory answer check, if one is wanted | `claude -p --model haiku --effort low --tools ''` | haiku | low |
| the final report | docpilot-tuner | sonnet | low |

- Read JSON, not logs: every command above has `--json` or `--quiet`. Never
  read a whole eval report file; read the summary the run prints.
- The writer gets the ONE page and the ONE item, never the plan or the report.
- No subagent reads the golden set. The writer must never see a gold answer.

## Budget

- Ask before the first run how many index rebuilds and answer evals are
  allowed when the embedder or the chat model is metered (`status` names
  both). A local Ollama costs time, not money.
- Default ceiling: 6 rounds, 12 index rebuilds, 6 answer evals per split.

## Rules that are never bent

- **Never invent product behaviour.** An edit restates what the page already
  says, in other words or in another place. A question the docs cannot answer
  is a negative — say so in the report; do not write the answer.
- **Never touch the measurement:** `golden.jsonl`, `calibration.jsonl`,
  `chains.jsonl`, `adversarial.jsonl`, the reports.
- **Never copy a gold answer** into the docs; `improve check` enforces it.
- `<llm-only>` text is indexed, citable and shown to readers: it is
  documentation, never an instruction to a model.
- No commits and no pushes; the edits are the user's to review.
