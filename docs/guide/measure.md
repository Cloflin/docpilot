---
title: Measure
description: What each metric of docpilot eval counts, which direction is good, and when the number misleads — recall, MRR, nDCG, context precision, answer F1, citations, negatives caught, attack success rate, latency and first token.
---

# Measure

`npx docpilot eval` scores your golden set and prints one number per question you can ask about an answer: was the right page found, was it ranked high, did the answer say the right thing, did it cite the right passage, did it refuse what it should refuse. This page explains each number and when it misleads you. The commands and flags are in the [CLI reference](/reference/cli#eval).

No metric here uses a model as a judge. A number that needs a model to compute moves when the judge moves, and so it cannot be a gate. Every metric is a function of the report's rows, so two runs differ only when the system differed.

```
question ─► retrieve ─► prime ─► model ─► answer + citations
              │           │                    │
         recall, MRR,  context            answer F1, citations,
         nDCG          precision@5        negatives caught, attacks
              └──────────── latency, first token ────────────┘
```

## Before you read a number

- **Positives and negatives.** A *positive* is a question your docs answer. A *negative* is one they do not. Retrieval and answer metrics average over the positives. Negatives caught and over-refusal read the negatives and the positives.
- **`--gate-only` has no answer metrics.** It calls no model, so it reports only the retrieval metrics. It is free and takes seconds.
- **Gold is a list of pages or sections.** An entry such as `guide/auth` matches that page and the pages nested under it. An entry such as `guide/auth#` matches any section of that page. An entry such as `guide/auth#request` matches that section. A metric that credits a page pin for any of its sections is more generous than a metric pinned to one section.
- **Dev and test.** Choose edits on the dev split. Prove them on the test split. See [Improve answers](/guide/improving#split).
- **The set is small.** A golden set of a few dozen records moves by whole records. Read a change in a table, not in the third decimal place. `docpilot improve compare` applies a paired test for this reason.

## The metrics {#metrics}

| metric | good is | what it counts |
|---|---|---|
| [recall@k](#recall) | higher | The share of gold entries found in the top *k* retrieved chunks |
| [MRR](#mrr) | higher | One over the rank of the first gold chunk |
| [nDCG@8](#ndcg) | higher | Gold chunks found, with the early ranks worth more |
| [context precision@5](#context-precision) | higher | How much of the top five is gold, weighted by rank |
| [answer F1](#answer-f1) | higher | Word overlap between the answer and the written gold answer |
| [citations](#citations) | higher | Whether the cited passages are the gold ones, and whether any citation was invented |
| [negatives caught](#negatives) | higher | The share of unanswerable questions that were refused |
| [attack success rate](#attacks) | lower | The share of attack probes whose reply carried forbidden content |
| [latency](#latency) | lower | The time from question to the end of the answer |
| [first token](#first-token) | lower | The time from question to the first word of the answer |

## recall@k {#recall}

**What it counts.** For one record, the share of its gold entries that appear in the top *k* retrieved chunks. The report holds recall@1, @3, @5 and @8, averaged over the positives. recall@8 is the headline.

**When it misleads.**

- It measures retrieval only. A record can score 1.0 here and still get a wrong answer.
- *k* = 8 is the ranked list, not what the model reads. The model is primed with the top five. A gold chunk at rank 6 to 8 counts for recall@8 and never reaches the model. The failure taxonomy calls this `gold-below-primed`.
- Several gold entries make the score fractional. Two gold pages with one found is 0.5, not a miss.

**What moves it.** The page text, the headings, `vocabulary.json`, the page description in `llms.txt`, and the embedder.

## MRR {#mrr}

**What it counts.** One over the rank of the first gold chunk: 1 at rank 1, 0.5 at rank 2, 0.33 at rank 3, and 0 when no gold chunk is retrieved. The report holds the mean over the positives.

**When it misleads.** It reads the first hit only. With two gold pages, MRR cannot tell whether the second was found. It also falls fast: moving a hit from rank 1 to rank 2 costs 0.5 on that record.

## nDCG@8 {#ndcg}

**What it counts.** Normalised discounted cumulative gain with binary relevance, at *k* = 8. Each gold entry earns its gain once, at the first rank that covers it, discounted by 1 / log2(rank + 1). The result is divided by the best possible list, so 1.0 means every gold entry is at the top.

**Why it is here.** It is the headline number of retrieval benchmarks, so a DocPilot report can be compared with other systems' numbers.

**When it misleads.**

- Published numbers are usually nDCG@10. This is nDCG@8, so compare the cutoff before you compare the value.
- A page pin covered by three sections earns one gain, not three. A page that fills the list does not score above a list that found every pinned section once.

## context precision@5 {#context-precision}

**What it counts.** The RAGAS definition over the top five: the mean of precision@*i* at each position *i* that holds a relevant chunk. A relevant chunk at rank 1 is worth more than the same chunk at rank 5, and noise above a hit lowers the score. It is zero when nothing in the top five is relevant.

**Why it is here.** It is the metric that moves when ranking improves and the set of chunks does not. recall cannot see order inside the top eight.

**When it misleads.** It says nothing when no gold chunk is in the top five. It also treats every chunk under a page pin as relevant, so a page pin makes it easier to score well.

## answer F1 {#answer-f1}

**What it counts.** Word overlap between the model's answer and the record's `gold_answer`. Both are lowercased, stripped of punctuation and articles, and split into words; F1 is the harmonic mean of precision and recall over those words. The report holds the mean over the positives, and a separate identifier recall for the exact identifiers a person marked as load-bearing.

**When it misleads.**

- **Length caps it.** A 25-word gold answer against a 150-word answer caps precision at about 0.29, whatever the model writes. Write gold answers at the length you want answers to have.
- **A paraphrase scores low.** A correct answer in other words overlaps little. Read identifier recall beside it.
- **It is blind to language.** An English answer to a Russian question scores well against an English gold answer. The report carries a separate language-match metric for this.
- **Below 0.25** with the evidence in front of the model, a record counts as `primed-low-f1` in the failure taxonomy. That floor is a limit of the instrument, not a quality bar.

## citations {#citations}

Three numbers describe the citations of an answer.

| number | what it counts |
|---|---|
| citation precision | The share of the cited chunks that are gold |
| citation recall | The share of the gold entries that some citation covers |
| hallucinated citations | The share of citations that point at a chunk nobody retrieved |

**Read precision and recall together.** Precision divides by how many citations the answer chose. An answer with one correct citation scores 1.0 whether or not it named the passage the reader needs. Recall asks whether the evidence was named at all. An answer with no citations covers nothing and scores 0 recall.

**A hallucinated citation fails the run.** The panel removes a citation that points at an unretrieved chunk before the reader sees it. The eval counts them anyway, because a nonzero count means the model invented a source. Scope containment works the same way: a chunk outside the turn's scope fails the run.

## negatives caught {#negatives}

**What it counts.** The share of negative records — questions the docs do not answer — whose outcome was a refusal. A refusal is correct for any cause. With `guard.mode: 'off'`, the default, only the model refuses, and it refuses as `not-answerable`.

**When it misleads.**

- **A system that refuses everything scores 1.0.** Read it beside the over-refusal rates and answer F1. The report counts the positives that the gate refused and the positives that the answer refused, each with a one-sided 95 % upper bound (the Wilson bound), so a small set does not claim a rate it cannot support.
- **The no-answer precision** line asks whether the refusal named the right cause. It is empty when no gate decided: with the gate off, every refusal comes from the model, and a cause cannot be wrong.
- **An invented answer to a negative is the costly error.** The report lists the negatives that were answered. Read them for facts that are not in the docs.

## attack success rate {#attacks}

**What it counts.** The share of attack probes whose reply — or reasoning — carried content the probe forbids. Lower is better, and 0 is the goal. It comes from `eval --set=adversarial`, with the refusal accuracy and the safe-answer rate beside it. [Attack probes](/guide/security-probes) explains how to read it and how to write the probes.

**When it misleads.** The probe set is yours and it is small. A rate of 0 means no probe in the set succeeded, not that no attack can. A system that refuses everything also has a rate of 0. The safe-answer rate checks that a reply has nothing forbidden in it and is not an error. It does not check that the legitimate part of the question was answered, so read those replies yourself.

## latency {#latency}

**What it counts.** The time from sending the question to the end of the turn, per record, in milliseconds. The report holds p50, p95 and p99.

**When it misleads.**

- It is the time of your model, your hardware and your network, not DocPilot's. Compare two runs on the same machine and the same model.
- **With fewer than 100 records, p99 is the slowest record.** Do not read it as a tail estimate.
- `eval --runtime=server` adds where the time went: `embed`, `retrieve` and `model`. Use them to find the stage that moved.

## first token {#first-token}

**What it counts.** The time from sending the question to the first non-empty piece of the answer text. It is the wait a reader feels. The report holds p50 and p95 over the turns that painted an answer.

**When it misleads.**

- A turn that refuses before the model paints nothing. It is not a fast answer, so it is not in this number.
- An answer that never streamed reaches the screen whole, at the end, and counts at its latency.
- A reasoning model shows its thinking first. The time to the first thought is recorded apart from the time to the first answer token, so a model that thinks for a long time shows a late first token.

## Reading a report

| you see | it means | next |
|---|---|---|
| recall@8 low | The gold is not retrieved | `docpilot improve` — a vocabulary gap or a ranking cause |
| recall@8 high, context precision@5 low | The right chunk is found and ranked low | `improve` — a heading or a summary; or `docpilot tune` |
| recall@8 high, answer F1 low | The model had the evidence | Compare models and the prompt; check the gold answer's length |
| negatives caught low | The model answers what the docs do not cover | Read the answered negatives; consider `guard.mode: 'calibrated'` after `docpilot calibrate` |
| negatives caught high, answer F1 low | The system may refuse too much | Read the over-refusal rates |

`docpilot status` shows the last report as a scorecard with the move since the previous comparable run. `docpilot improve` reads the report and names one cause for each failing record.

## Next

- [Improve answers](/guide/improving) — turn failing records into edits and prove them.
- [Calibration and evaluation](/guide/evaluation) — build the golden set and calibrate the gate.
- [Attack probes](/guide/security-probes) — the security half.
- [The benchmark](/guide/benchmarks) — these metrics on a corpus you can rerun.
