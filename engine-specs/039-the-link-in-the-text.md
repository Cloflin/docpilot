# 039 — The link in the text

> **Кратко.** Модель писала в тексте ответа id секции в скобках вместо маркера
> `[n]`, и у утверждения не было ссылки, хотя список Sources был верным. Причина —
> формулировка правила в промпте. Исправлено тремя частями: правило разбито на два
> пункта (13/16 → 0/24 на повторах одного хода), `finish()` сверяет маркеры со
> списком для любой модели, и `eval` получил третий hard gate — ответ на
> позитивный вопрос с источниками без рабочей ссылки в тексте проваливает прогон.

## Problem

Reported on a production docs site: the question "How do I store images in my
own storage, such as AWS S3 or my own server?" got an answer whose last
paragraph ended in
`[editor-configuration/image-storage#connecting-your-own-server]` — plain text,
no link. The row for that section was in the Sources list, with the right href.

Retrieval was not the cause. The section was rank 5 of the 6 priming chunks on
every run, and 6 of 6 live turns cited it. The citations array was right; the
text was wrong:

- the model wrote section ids where the markers go;
- `linkMarkers` (markdown.ts) links `/\[(\d+)\]/` and nothing else;
- `finish()` passed the text through unchanged.

Every citation metric reads the array, so the eval could not see it either:
citation recall was perfect on answers the reader could not follow.

## Measured, 2026-10-27

Model `gpt-6-luna`, `reasoning: 'low'`, through the site's own `/ai` proxy.

| run | answers with `[id]` in the text | answers whose text links the own-server section |
|---|---|---|
| live turns, the panel's full path headless | 5 of 6 | 1 of 6 |
| replays of the captured final call, old rule | 13 of 16 | 3 of 16 |
| old rule split into two bullets (B) | 0 of 8 | 8 of 8 |
| B + a `description` on the schema's `text` | 0 of 8 | 8 of 8 |
| B + a worked example | 0 of 8 | 8 of 8 |

The old rule was one sentence pair: "Mark every claim with a citation marker
[1], [2] in the order of the citations array. It holds section ids copied
exactly from tool results, never marker numbers." Read as a rule about the
marker, the second sentence asks for exactly what the model wrote. The live
turns showed the same habit on the `answer` tool path, not only on the forced
final call.

A second defect sat under the numeric answers: one of the two numbered its
markers by search-result order, so `[3]` opened another section. Every B, C and
D answer referenced each citation by its array position.

## Decision

1. **The rule is two bullets** (prompt.ts): numbers in the text, `[1]` is
   `citations[0]`; section ids only in `citations`. B is the smallest change
   that measured clean; C and D added nothing n = 8 can see. With it, 10 of 10
   live turns on five of the site's questions linked every claim, and none
   wrote an id.
2. **`finish()` settles the markers with the list** (markers.ts). A rule is a
   request, and the package must work with a model it has not met. It runs
   once, before `sources`, `support`, the server's signature and the turn log —
   a rewrite in the renderer would make the signed text and the shown text two
   strings (engine-spec 033).
   - An id becomes its position; a known id only the text cites is appended.
   - A number is a position in the RAW list, renumbered into the filtered one.
     Review found that without this an appended id took the slot of a dropped
     phantom, and the phantom's `[n]` — deleted at render before — linked an
     invented claim to a real section. It also fixes an older shift: every
     number after a dropped phantom linked one row down.
   - `[1, 2]` becomes `[1][2]` unless a number is past the end (an array).
   - Code, link text and alt text are not markers; an id-shaped bracket nobody
     handed out is deleted like a phantom.
3. **The eval checks the text** (metrics.ts `unlinkedAnswer`), counted by
   `renderAnswer` itself — a regex parser disagreed with markdown-it on six
   shapes in review. It is a hard gate on POSITIVE records only. Swept over 1,240
   real answers it agreed with the renderer on every one; it would have failed 28
   of 36 historical runs, because small models often write no marker
   (`gpt-4o-mini` ~30 %, `qwen3:8b` 35–55 %), and 74 of its harborline hits were
   negatives answered "not covered" with sources. Negatives and authored openers
   are reported beside it. Decided with the maintainer, 2026-10-27.
4. **Authored openers carry markers.** This site's three had none; `index` now
   warns on one that links none of its `cite`.

## What it costs

- `promptHash` moves: eval history restarts, and the next `index` re-bakes the
  opener answers (one request each).
- A prose reply that names known ids now settles as a tentative answer with
  citations instead of being withdrawn. Its ids pass the same membership test
  as the array, and its confidence stays at 0.3 even under a reader
  instruction.
- A small model's eval can fail on its first run under the new gate. That is
  the reader's experience made visible, not a regression.
- Streaming frames still paint the raw text, so an id a model writes is on
  screen until the settle replaces it.

## Not done here

The live runs also showed two costs of the turn, unrelated to the marker: a
repeated `search_docs` of the priming chunks spends one of the two iterations,
and the first turn after a page load spends two requests on 400s (the probe
without `reasoning_effort: 'none'`, the final call with `temperature`). Each is
a separate change.
