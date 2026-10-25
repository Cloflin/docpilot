# 035 — The edit a report asks for

> **Кратко.** Отчёт eval говорил, ЧТО запись провалилась, но не какую правку
> делать; llms.txt вообще не влиял на ответы («is not read by DocPilot and never
> will be»). 2.0: `docpilot improve plan` по строкам отчёта и индексу называет
> одну причину каждого провала (словарный разрыв, ранжирование, не попало в
> праймер, структура, генерация, ложный отказ, отвеченный негатив) и сводит их в
> правки по (причина, страница) с файлами и записями-доказательствами;
> `improve compare` судит правку по правилу «−2 п.п. — откат»; `improve check`
> ловит скопированный в доки gold-ответ теста и правку eval-наборов. llms.txt
> становится описанием страницы для поиска (за `DOCPILOT_LLMS_FILE`, пока замер
> не решит, включать ли по умолчанию).

## Problem

- `eval` names a failure class (`retrieval-miss`, `gold-below-primed`) but not
  the page, the words, or the lever; the corpus mode of the docs-rag skill left
  the diagnosis to whoever read the rows.
- "Revert anything that regresses a metric by more than 2 points" was a rule
  with no instrument: `docpilot model compare` pairs two CHECKPOINTS and refuses
  a changed index hash — which a corpus edit always produces.
- llms.txt was the agents' surface and nothing else: an author improving its
  descriptions moved no metric, so there was no reason to improve them.
- Nothing stopped an edit from pasting a gold answer into a page.

## Decision

1. **`improve plan`** reads the newest dev-split report (or `--report=`), the
   golden records and the index, and assigns one cause per failing positive in
   the order a turn spends evidence: not in the ranked eight → **vocabulary gap**
   when half or more of the question's terms (the index's own tokenizer) never
   occur in the gold text, else **ranking**; in the eight but not the primed five
   → **not primed**; primed and weak, with gold chunks the turn never saw →
   **structure**, else **generation**; primed and refused → **false refusal**;
   a negative answered → **answered negative**. Items group by (cause, page) with
   a lever — `describe-page`, `alias`, `retitle-section`, `summarise-section`,
   `tune`, `investigate` — the files to edit and the records that prove it;
   `improve/plan.md` and `plan.json`.
2. **`improve compare --before --after`** pairs by record id; `revert` when any
   metric's mean falls more than 2 points, `keep` when a paired-bootstrap interval
   clears zero or McNemar favours the after, `neutral` otherwise. A negative
   refused for ANY cause is right (the exact-cause rule in `model/compare.ts`
   marked every guard-off negative wrong).
3. **`improve check --since=<ref>`** exits 1 when text added to the docs shares
   an 8-word run with a test-split gold answer, or an eval set changed.
4. **llms.txt as page descriptions.** `DOCPILOT_LLMS_FILE=<path>` at index time:
   a page with no frontmatter description takes its llms.txt note as the first
   chunk's lead, and every chunk of the page gains an `about` field for BM25 at
   boost 0.5 (`BOOST_ABOUT`). Links resolve the way `llms lint` resolves them.
   An index built without the file is byte-identical to before.

## Why it fits

The diagnosis reads only what the report and the index already hold (`rankedIds`,
`retrievedIds`, `gold_chunks`, chunk text); the tokenizer is the index's own,
installed by `assembleIndex`. The levers are the ones RAG-SPEC's corpus mode
already names. The writing is left to a person or to the tuning agent (spec 036),
because writing is the only step that is not deterministic.

## Cost and risk

- The vocabulary test is a heuristic; a question in another language always
  reads as a gap, which is why its lever is `docpilot vocabulary --languages=`.
- Descriptions on every chunk of a page can flatten a page's sections against
  each other; the boost is below the title's for that reason, and the measurement
  decides the default.

## Checks

`test/improve.test.js` — each cause, the grouping and order, the verdicts, the
any-cause negative rule, the leak check.

## What this does not do

- It never writes a page or calls a model.
- It never proposes product behaviour: a question the docs cannot answer is a
  content gap, reported, not filled.
