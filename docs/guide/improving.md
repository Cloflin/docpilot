---
description: Turn failing eval records and real reader traffic into documentation edits, prove each edit on a held-out split, and keep only what helps — with docpilot improve and docpilot traffic.
---

# Improve answers

Wrong answers usually come from the documentation, not the model: a page that uses other words than the reader does, a heading that does not say what its section answers, an answer split across two sections. This page is the loop that finds those pages, edits them, and proves each edit helped.

Failures come from two places:

- **Your golden set.** `docpilot eval` scores it, and `docpilot improve` turns each failing record into an edit. This is the main loop, and it works before you have any readers.
- **Your readers.** The [server runtime](/guide/server) writes one record per turn, and `docpilot traffic` reads them. See [Improve from traffic](#traffic).

An agent can run the main loop for you: [Tune a site with Claude Code](/guide/tuning-agent).

## The loop {#loop}

```
eval --split=dev ─► improve plan ─► edit one page ─► improve check
        ▲                                                 │
        │                                                 ▼
   keep: next baseline ◄── improve compare ◄── index ◄────┘
                              │
                        revert / neutral ─► undo the edit
                              │
   when no item helps ─► eval --split=test ─► improve compare = the claim
```

1. Score the dev split and keep the report: `npx docpilot eval --split=dev --quiet`. Add `--gate-only` for a free pass that measures retrieval only.
2. Read the plan: `npx docpilot improve`.
3. Make one edit from the plan, or several edits on different pages.
4. Check the edit: `npx docpilot improve check --since=HEAD`.
5. Rebuild and score again: `npx docpilot index --yes`, then `eval --split=dev`.
6. Judge it: `npx docpilot improve compare --before=<old report> --after=<new report>`.
7. If the verdict is **keep**, the new report is your next baseline. If it is **revert** or **neutral**, undo the edit.
8. When no item helps, score the test split once more and compare it with the test baseline you took first. Only that comparison is the claim.

Every command is in the [CLI reference](/reference/cli#improve).

## Split the golden set: dev and test {#split}

A record in `golden.jsonl` may carry `"split": "dev"` or `"split": "test"`. A record without the field is assigned by a hash of its id, the same way on every machine, so a set written before the field existed splits with no edit. `eval --split=dev` scores one half and `eval --split=test` the other. See [the split](/reference/cli#eval-split).

- **Choose edits on dev.** `improve` reads the newest dev report.
- **Prove them on test.** An edit written against the questions it is scored on measures how well the edit was fitted to them. The test split is the only fair judge.
- **Do not edit `golden.jsonl` to move a record between splits.** The loop would then be tuned to its own judge.

## Read the plan {#plan}

```bash
npx docpilot improve
npx docpilot improve plan --report=docpilot/reports/<report>.json
```

`plan` is the default. It never calls a model and never edits a page. It gives **one cause for each failing record**, then groups records into **one item for each cause and page**: five questions that miss a page for want of one word are one edit. The plan is written to `${evalDir}/improve/plan.md` and `plan.json`.

| cause | what it means | the lever |
|---|---|---|
| vocabulary gap | The gold page is not in the ranked eight, and most of the question's words never occur in its text | Rewrite the page's description in `llms.txt` and its frontmatter in the readers' words, or add a [`vocabulary`](/reference/config#vocabulary) alias |
| ranking | The words are on the page, and another page ranks above it | Rename the section's heading to say what it answers, and state the answer in its first sentence |
| not primed | The gold is in the ranked eight and not in the five the model reads | Add one `<llm-only>` summary line at the top of the section. If four or more pages share the cause, run [`docpilot tune`](/reference/cli#tune) to measure a larger `GATE_K` |
| structure | The answer is split across chunks the turn did not all see | Add an `<llm-only>` summary to the first section that states the whole answer |
| generation | The evidence reached the model whole and the answer is still weak | Investigate: the prompt or the model |
| false refusal | The evidence reached the model and it refused | Investigate: the prompt, the model or the guard |
| answered negative | A question the docs cannot answer was answered | Investigate: read the answers for invented facts |

The three **investigate** causes are not corpus edits. `plan` lists them after the corpus items and proposes no change for them.

`plan` never proposes product behaviour the docs do not state. A record whose answer is not in the docs is a content gap. The fix is a person who knows the product writing the page, or the record becoming a negative.

`<llm-only>…</llm-only>` text is indexed, citable and shown to readers. It is documentation, not an instruction to a model.

## Guard the edit {#check}

```bash
npx docpilot improve check --since=HEAD
```

A loop can cheat in two ways, and `check` exits `1` on either:

- **Copied gold.** Text added to the docs since `--since=` that copies a run of eight words from a test-split `gold_answer`.
- **A changed measurement.** Any change to `golden.jsonl`, `calibration.jsonl`, `chains.jsonl` or `adversarial.jsonl`.

Run it after every edit and before you measure.

## Judge the edit {#compare}

```bash
npx docpilot improve compare --before=before.json --after=after.json
```

`compare` pairs two reports of the same records by id and returns one verdict:

| verdict | when |
|---|---|
| **revert** | Any metric fell by more than two points |
| **keep** | Something rose beyond noise — a paired bootstrap interval clear of zero, or McNemar on the per-record outcome — and nothing fell past the line |
| **neutral** | Everything else. Neutral is not a reason to keep an edit nobody can show helped |

It does not refuse a changed index hash, because a corpus edit changes the hash by definition. What must match is the population: the same golden set, level and split. [Measure](/guide/measure) explains the metrics it compares.

## Improve from traffic {#traffic}

The [server runtime](/guide/server) writes one record per turn. `docpilot traffic` reads them and says what to change, in the order a change pays.

```bash
npx docpilot traffic report     --from=docpilot/turns --feedback=./votes.jsonl
npx docpilot traffic candidates --from=docpilot/turns --feedback=./votes.jsonl
```

### The report

Each section ends with the command that acts on it.

| section | what it finds | what to do |
|---|---|---|
| Content gaps | refused, unanswerable and down-voted questions, clustered | write or extend the page; then `index` |
| Vocabulary misses | words readers use that the index never saw | add `vocabulary` aliases; then `index`, `calibrate` |
| Retrieved, not cited | pages found often and cited rarely | split the section or fix its heading |
| Never retrieved | pages no question reached | check their vocabulary, or drop them |
| Language | failure rate per reader language | read [the gate and languages](/concepts/the-gate) |
| Prompt, index and model drift | outcomes and latency per prompt hash, index hash and model | see whether your last change — or another model — helped |

### Candidates for the golden set

`candidates` writes `${evalDir}/traffic-candidates.jsonl`: real failed questions in the golden record's shape, with `needsReview: true`, the failure that selected each one, and a suggested `gold_chunks` from answers readers liked. It never writes `gold_answer` and never touches `golden.jsonl`. A gold answer is written by a person; promote a row by writing one and moving it.

Candidates are capped per cluster, so one broken page cannot fill the set, and questions already in the golden set are skipped.

### The traffic loop

```
serve (turn log) → traffic report → edit docs → index → calibrate → eval
                 → traffic candidates → review → golden.jsonl → eval
```

## llms.txt

Other people's agents read your docs through llms.txt, not through this panel.

```bash
npx docpilot llms lint --site=https://docs.example.com/
npx docpilot llms build --site=https://docs.example.com/ --md
```

`lint` checks the file against [llmstxt.org](https://llmstxt.org/) and against your index: the pages it never links, and the links that reach no indexed page. `build` writes one from the index when your generator does not. See [llms.txt and crawlers](/guide/llms-txt).

**Page notes as descriptions.** With `DOCPILOT_LLMS_FILE=<llms.txt>` set when you run `docpilot index`, the note written for each page in that file becomes the page's description for retrieval. Whether this should be the default is decided by measurement. [The benchmark](/guide/benchmarks) runs it as a separate arm; measure it on your own golden set before you rely on it.

## Next

- [Tune a site with Claude Code](/guide/tuning-agent) — the same loop, run by an agent.
- [Measure](/guide/measure) — what each number means.
- [Calibration and evaluation](/guide/evaluation) — build the golden set.
