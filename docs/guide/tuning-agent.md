---
title: Tune a site with Claude Code
description: Run the improvement loop with the docpilot-tuner and docpilot-writer Claude Code agents — what each one does, which model and effort each task uses, what it may never touch, and how much it may spend.
---

# Tune a site with Claude Code

`docpilot-tuner` and `docpilot-writer` are two Claude Code subagents that run the [improvement loop](/guide/improving) on your site. The CLI does all the measuring. The agents do only the writing: a page description, an alias, a heading, one summary line. Every edit they keep has passed `docpilot improve compare`, and the final claim is a comparison on the test split.

Use them when you have a golden set with a dev and a test half and you want the loop run without you at the keyboard. If you have no golden set yet, start with [Calibration and evaluation](/guide/evaluation).

## Set up

`npx docpilot init` and `npx docpilot update` install the agents into `.claude/agents/`, and the `docs-tune` skill beside the other skills. Only the Claude Code target gets the agents; the other tools read skills but not this agent format. See [Skills](/reference/skills) and [`init`](/reference/cli#init-targets).

```bash
npx docpilot init --target=claude
```

Then ask Claude Code to use the `docpilot-tuner` agent, for example: "Use the docpilot-tuner agent to improve this site's answers." Nothing runs until you ask.

## What each part does

| part | what it is | what it does |
|---|---|---|
| the CLI | `npx docpilot` | Indexes, scores, plans, checks and compares. It calls no model for `index`, `improve` or `status` |
| `docpilot-tuner` | a Claude Code subagent | Reads the plan, chooses items, runs the loop, writes page descriptions and aliases, writes the final report |
| `docpilot-writer` | a Claude Code subagent | Rewrites one heading or adds one `<llm-only>` summary line, from text already on the page |
| `docs-tune` | a skill | The written loop both agents follow. The tuner reads it first |

## The loop {#loop}

```
status ─► baseline (dev + test) ─► improve plan ─► edit ─► improve check
   ▲                                                         │
   │                 keep ◄── improve compare ◄── index ◄─────┘
   └──────── revert ◄──┘                         + eval dev
                         … until no item helps ─► eval test ─► report
```

1. **State.** `npx docpilot status --json`. The agent stops and says why if there is no config, no golden set, or uncommitted changes under the docs directory or in `llms.txt`. Every revert is a `git checkout` of a file the loop changed, and that is safe only on a clean tree.
2. **Index.** If the index is stale or missing: `npx docpilot index --yes`.
3. **Baseline, once, before any edit.** Retrieval on dev, answers on dev, and answers on test:

   ```bash
   npx docpilot eval --gate-only --split=dev --quiet
   npx docpilot eval --split=dev --quiet
   npx docpilot eval --split=test --quiet
   ```

4. **Plan.** `npx docpilot improve --json`. The agent works the corpus items in order. It lists the `investigate` items in the report and leaves them.
5. **Edit** one item, or several items on different pages.
6. **Guard.** `npx docpilot improve check --since=<baseline commit> --json` must return `ok: true`.
7. **Measure.** `npx docpilot index --yes`, then the retrieval-only dev eval. The answer eval runs only when retrieval moved or the item was about answers.
8. **Decide.** `npx docpilot improve compare --before=<baseline> --after=<new report> --json`. **revert** and **neutral** both undo the edit. **keep** makes the new report the next baseline.
9. **Stop** when the plan has no corpus item left, when two rounds in a row keep nothing, or when the budget is spent.
10. **Prove.** `npx docpilot eval --split=test --quiet` on the final corpus, then `improve compare` against the test baseline. Only this comparison is the claim. Dev numbers chose the edits.
11. **Report** in `<evalDir>/improve/REPORT.md`: before and after on dev and on test for the headline metrics, the edits kept and reverted with their item ids, and the `investigate` items left untouched.

## Model and effort for each task {#models}

The loop spends tokens where judgement is needed and nowhere else.

| task | who | model | effort |
|---|---|---|---|
| index, eval, `improve` plan, check and compare, status | the CLI | none | — |
| read a plan, choose items, run the loop | `docpilot-tuner` | sonnet | medium |
| a page description, an alias | `docpilot-tuner` | sonnet | medium |
| a heading rewrite, an `<llm-only>` summary | `docpilot-writer` | sonnet | high |
| an advisory answer check, if you want one | `claude -p --model haiku --effort low --tools ''` | haiku | low |
| the final report | `docpilot-tuner` | sonnet | low |

Rules that keep the spend down:

- Every measuring command has `--json` or `--quiet`. The agents read those and never open a whole report, the golden set or an index shard.
- The writer receives one page and one plan item. It never sees the plan, a report or a gold answer.
- No subagent reads the golden set.

## The budget {#budget}

Before the first run, the tuner asks how many index rebuilds and answer evals you allow when the embedder or the chat model is metered. `docpilot status --json` says which are configured. A local Ollama costs time, not money, and needs no permission.

The default ceiling is 6 rounds, 12 index rebuilds and 6 answer evals for each split.

## The guardrails {#guardrails}

These rules are never bent. `improve check` enforces the first two in the CLI. The skill and the agent definitions state the rest.

- **Never touch the measurement.** `golden.jsonl`, `calibration.jsonl`, `chains.jsonl`, `adversarial.jsonl` and everything under the reports directory are read-only for the agents. `improve check` fails when one changes.
- **Never copy a gold answer.** `improve check` fails when added text repeats a run of eight words from a test-split gold answer.
- **Keep an edit only when it is shown to help.** `improve compare` returns **keep** only when a metric rose beyond noise and none fell by more than two points, or, for gate-only reports, when some record ranked better and none worse. A gate-only run calls no model, so the same corpus always ranks the same way. A neutral edit is reverted.
- **Prove on test.** The final claim is the test-split comparison.
- **Never invent product behaviour.** An edit restates what the page already says, in other words or in another place. A question the docs cannot answer is a negative, and the report says so. The agent does not write the answer.
- **`<llm-only>` text is documentation.** It is indexed, citable and shown to readers. It is never an instruction to a model.
- **No commits, no pushes, no installs.** The edits are yours to review in `git diff`.
- **Revert only its own files.** A revert is `git checkout -- <file>` of the files the loop changed, and nothing else.

## Read the result

The tuner hands back at most 15 lines: the test-split before and after for the headline metrics, the edits kept and reverted, the content gaps it found, and the path of `REPORT.md`. Review the diff the way you review a pull request. The diff should change only descriptions, aliases, headings and summary lines. If it changes what a page claims about the product, reject it.

The content gaps in the report are for you. A gap is a question the docs cannot answer, and the fix is a page that a person who knows the product writes.

## Next

- [Improve answers](/guide/improving) — the same loop by hand.
- [Measure](/guide/measure) — the metrics in the report.
- [CLI: `improve`](/reference/cli#improve) and [`status`](/reference/cli#status).
