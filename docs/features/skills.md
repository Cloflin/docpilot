---
description: npx docpilot init copies the DocPilot skills, the /docpilot-* slash commands and the tuning agents into your agent tool; the agent reads them and runs the CLI; npx docpilot update refreshes them and keeps your edits.
---

# Skills for your agent

DocPilot ships the written half of running it as Agent Skills: what to measure, what has already been measured, and what an edit may not break. `npx docpilot init` copies them into the agent tool you name, so Claude Code, Codex, Cursor or Copilot can run the CLI by the same rules you would. The mock-up plays the three acts: copy, use, refresh.

<Demo>
  <SkillsDemo />
  <template #code>

```bash
npx docpilot init --target=claude --scope=project   # copy skills, commands, agents
npx docpilot update --dry                            # what an upgrade would change
npx docpilot update                                  # refresh, keep your edits as .bak
```

  </template>
</Demo>

## 1. `init` copies them {#init}

A skill inside `node_modules` reaches nobody: every agent tool looks for skills in the project or in your home directory, never in a dependency. So `init` copies them, and asks where:

| question | flag | answers |
|---|---|---|
| Which agent tool? | `--target=` | `claude`, `codex`, `cursor`, `copilot`, `agents` — a comma list works |
| This project, or you on this machine? | `--scope=` | `project` (committed with the repo) or `user` (your home directory) |

Into that tool's directory go three skills, one slash command per CLI command, and — for Claude Code only — two subagents:

| what | for |
|---|---|
| `docs-rag` | the measurement and tuning loop: eval, golden sets, the bench, openers, and the list of things already measured |
| `docs-import` | the contract for pages imported from another site |
| `docs-tune` | the improvement loop the tuning agents follow |
| `/docpilot-index`, `/docpilot-eval`, … | each command with its own flags, generated from the table the CLI validates against |
| `docpilot-tuner`, `docpilot-writer` | the [Claude Code agents](/guide/tuning-agent) that run the loop and write one edit at a time |

## 2. The agent reads them {#use}

Ask for a measurement — `/docpilot-eval`, or "why does the panel miss this question?" — and the agent reads `docs-rag` first. The skill tells it which command to run, how to read the report, and which experiments not to repeat. The binding rules hold whoever is reading: the thresholds are not levers, an LLM judge never gates, and a change that regresses a metric by more than two points is reverted.

The copies are yours. Edit them: the numbers inside are about the corpus this package was developed against, not yours.

## 3. `update` refreshes them {#update}

`init` never overwrites, which makes it safe to re-run and useless for an upgrade. After `npm install @cloflin/docpilot@latest`, run `npx docpilot update`. Beside every skill sits `.docpilot.json` with a hash per file, so:

- a file nobody touched is replaced in silence;
- a file **you edited** is replaced, and your copy is kept beside it as `.bak`, named in the report.

With no flags, `update` finds every install on the machine. `--check` fails a CI job when the copies are behind the package.

More: [Skills](/reference/skills) for what each skill contains, [`init`](/reference/cli#init) and [`update`](/reference/cli#update) in the CLI reference, and [Tune with Claude Code](/guide/tuning-agent) for the agents.
