---
description: Read what readers actually asked — content gaps, vocabulary misses, pages that are found and never cited — and turn it into documentation edits and eval records.
---

# Improving answers from traffic

The [server runtime](/guide/server) writes one record per turn. `docpilot traffic` reads them and says what to change, in the order a change pays.

```bash
npx docpilot traffic report     --from=docpilot/turns --feedback=./votes.jsonl
npx docpilot traffic candidates --from=docpilot/turns --feedback=./votes.jsonl
```

## The report

Each section ends with the command that acts on it.

| section | what it finds | what to do |
|---|---|---|
| Content gaps | refused, unanswerable and down-voted questions, clustered | write or extend the page; then `index` |
| Vocabulary misses | words readers use that the index never saw | add `vocabulary` aliases; then `index`, `calibrate` |
| Retrieved, not cited | pages found often and cited rarely | split the section or fix its heading |
| Never retrieved | pages no question reached | check their vocabulary, or drop them |
| Language | failure rate per reader language | read [the gate and languages](/concepts/the-gate) |
| Prompt, index and model drift | outcomes and latency per prompt hash, index hash and model | see whether your last change — or another model — helped |

## Candidates for the golden set

`candidates` writes `${evalDir}/traffic-candidates.jsonl`: real failed questions in the golden record's shape, with `needsReview: true`, the failure that selected each one, and a suggested `gold_chunks` from answers readers liked. It never writes `gold_answer` and never touches `golden.jsonl`. A gold answer is written by a person; promote a row by writing one and moving it.

Candidates are capped per cluster, so one broken page cannot fill the set, and questions already in the golden set are skipped.

## llms.txt

Other people's agents read your docs through llms.txt, not through this panel.

```bash
npx docpilot llms lint --site=https://docs.example.com/
npx docpilot llms build --site=https://docs.example.com/ --md
```

`lint` checks the file against [llmstxt.org](https://llmstxt.org/) and against your index: the pages it never links, and the links that reach no indexed page. `build` writes one from the index when your generator does not. See [llms.txt and crawlers](/guide/llms-txt).

## The loop

```
serve (turn log) → traffic report → edit docs → index → calibrate → eval
                 → traffic candidates → review → golden.jsonl → eval
```
