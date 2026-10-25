# 036 — The agent that tunes a site

> **Кратко.** У владельца сайта были команды измерения, но не было того, кто
> проходит цикл целиком: базовый замер на dev и test, план, правка, проверка,
> переиндексация, сравнение, откат или сохранение, итоговое доказательство на
> test. 2.0 поставляет его: Claude Code агентов `docpilot-tuner` (sonnet,
> medium) и `docpilot-writer` (sonnet, high) и skill `docs-tune` с процедурой и
> таблицей «задача → модель → усилие». Всё измеримое делает CLI бесплатно;
> модель только пишет правки. `init`/`update` ставят агентов в `.claude/agents/`.

## Problem

The loop in `docs-tune` is ten commands long and every step has a way to go
wrong: tuning on the test questions, keeping an edit nobody showed helped,
reverting by hand the wrong file, re-reading a 200 KB report into a context
window, paying a strong model to run `npx`. The skills that existed (`docs-rag`,
`docs-import`) describe the modes; nothing executed the loop, and nothing said
which model should do which part of it.

## Research

- `stripo-docs/.claude/doc-agent-eval` (the doc-editor agent's harness): a
  deterministic score decides and a model judge only advises; held-out cases by
  date; an 8-gram check against truth leakage; a sandbox with no truth mounted.
  Its agent definition shows the frontmatter Claude Code reads: `model`,
  `effort`, `maxTurns`, `tools`.
- The 2026 guidance for agent cost: route by task — the expensive model only
  where judgement is needed, and nothing at all where a program can do the work.

## Decision

1. **`skills/docs-tune/SKILL.md`** — the loop as a procedure: state → index →
   baseline on dev and test → `improve plan` → one edit (or several on different
   pages) → `improve check` → index → gate-only eval, then answers when needed →
   `improve compare` → keep, or `git checkout` the item's files → stop when two
   rounds keep nothing → the test-split comparison as the only claim →
   `improve/REPORT.md`.
2. **Model and effort per task:**

   | task | who | model | effort |
   |---|---|---|---|
   | index, eval, improve, status | the CLI | none | — |
   | run the loop, choose items, write descriptions and aliases | docpilot-tuner | sonnet | medium |
   | heading rewrites, `<llm-only>` summaries | docpilot-writer | sonnet | high |
   | an optional advisory answer check | `claude -p` | haiku | low |
   | the final report | docpilot-tuner | sonnet | low |

   The tuner reads `--json` and `--quiet` output only (`eval --quiet` was added
   for it); the writer sees one page and one item, never the plan or a gold
   answer.
3. **`agents/docpilot-tuner.md`, `agents/docpilot-writer.md`** — Claude Code
   subagents, installed by `init` and `update` into `.claude/agents/` (claude
   target only; other tools get the skill) with `{{SKILLS_DIR}}` filled in, a
   manifest, and a skill's keep/backup rule.
4. **Guardrails, in both the skill and the agent:** a clean git tree for the docs
   before the first edit; never edit an eval set; never copy gold; never invent
   behaviour; no commits, pushes or installs; ask before a metered embedder or
   chat model is spent on.

## Measured

A copy of DocPilot's own docs, headless (`claude -p --agent docpilot-tuner`),
gate-only, local bge-m3: 3 rounds, 59 turns, 13 minutes, $1.45 at API prices.
The agent kept nothing, and its rule was the reason. Its best candidate (one
`<llm-only>` line on each of two pages) moved q-14 from a miss to rank 1 and
q-16 from rank 7 to 3 and made no record worse — dev nDCG@8 0.534 → 0.569,
MRR 0.523 → 0.559; test nDCG@8 0.584 → 0.586. With 33 positives a split, two
fixed records leave the bootstrap lower bound at exactly zero, so `compare`
said `neutral` three rounds running. A gate-only pair calls no model and is
deterministic; `compare` now also keeps a Pareto move on it (spec 035,
Decision 2), and the same candidate is `keep` on dev and on test.

## Why it fits

Every step the agent takes is a command this package already tests, so the
agent adds judgement and no new measurement. The keep/revert rule is RAG-SPEC's
2-point rule, now executed by `improve compare` rather than remembered.

## Cost and risk

- A local model makes the answer evals slow (minutes per round); the agent runs
  gate-only first and answer evals only when retrieval moved.
- An edit can be true and still fitted to dev; the test split is the guard, and
  the report states both halves.

## Checks

`test/agents-install.test.js` — init installs both agents with the skills path,
update backs up an edited agent, a non-Claude target gets none.

## What this does not do

- It does not run itself: the user invokes the agent.
- It does not judge answers with a model by default — deterministic metrics
  decide (RAG-SPEC 5).
