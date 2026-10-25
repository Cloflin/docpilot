# 034 — The static index, verified

> **Кратко.** Статическая установка отдаёт читателю индекс целиком, и в 1.5
> файлы назывались по хешу текста корпуса — смена эмбеддера, токенизатора или
> конфига переписывала байты под тем же «immutable» именем, а целостность
> шардов никто не проверял. 2.0: каждый файл назван по своим байтам, манифест
> несёт SRI каждого, панель качает с `integrity`, `index` печатает размер «на
> проводе». Измерено четыре рычага точности и сжатия на двух корпусах: ни один
> не улучшил точность на обоих, бинарные векторы для bge-m3 вдвое уменьшают
> загрузку ценой незначимого падения MRR — оставлены опцией, не умолчанием.

## Problem

- **Immutable names that were not content addresses.** Shards, `df`, vectors and
  openers were `*.<corpus hash>.*`, and the corpus hash covers chunk ids and text
  only. A rebuild with another embedder, quantisation, tokenizer flag or opener
  config wrote different bytes under the same name; `vercel.json` serves them
  `immutable`, so a returning reader kept the old file beside a new manifest.
- **No integrity check.** Only counts and lengths were checked on load; an
  altered shard — a poisoned CDN cache — became text the model read as the docs.
- **The size that matters was not printed.** `index` reported bytes on disk; a
  reader downloads brotli, and sign-bit vectors barely compress while JSON
  compresses about 3×.

## Research

- Subresource Integrity (W3C): `fetch(url, {integrity: 'sha256-…'})` makes the
  browser refuse bytes that do not hash to the value; with content-addressed
  names and a `no-cache` manifest it is the standard immutable-asset pattern.
- Binary quantisation with float queries (asymmetric) is the 2025–26 practice
  for byte budgets; reported costs range from under 2 points with rescoring to
  5–30 points without, and depend on the embedder's anisotropy — so it is
  measured here per embedder rather than assumed.
- Contextual chunk headers (Anthropic, 2024): context prepended to each chunk
  before embedding cut retrieval failures 35–49% on their corpora.

## Decision

1. Every file is named `prefix.<sha256 of its bytes>.ext`; `manifest.integrity`
   maps each name to `sha256-<base64>`; `loadIndex` passes it to `fetch`. An index
   without the map loads as before.
2. `index` prints `N KB on the wire (brotli)`; `docpilot status` shows it too.
3. The openers bundle gets the immutable cache rule the other files had.
4. **Measured, not adopted as defaults** (the knobs stay for experiments):

| lever (bge-m3) | Harborline test (52 positives) ΔnDCG@8 · ΔMRR | DocPilot docs (66 positives) ΔnDCG@8 · ΔMRR | bytes on the wire |
|---|---|---|---|
| `--quantize=binary` | −0.021 [−0.051, 0.009] · −0.033 [−0.079, 0.011] | +0.002 · −0.010 (n.s.) | Harborline 199 → 99 KB; docs 575 → 318 KB |
| `DOCPILOT_EMBED_CONTEXT=path` | +0.005 [−0.000, 0.012] · +0.005 [0.001, 0.010] | +0.004 · −0.001; CP@5 −0.025 (n.s.) | unchanged |
| `DOCPILOT_EMBED_CONTEXT=path+desc` | +0.026 [−0.017, 0.070] · +0.012 (n.s.) | +0.008 · +0.004; CP@5 −0.025 [−0.053, −0.001] | unchanged |
| `DOCPILOT_LLMS_FILE` (spec 035) | −0.008 · −0.017 (n.s.) | — | +3 KB |

Intervals are paired 95% bootstrap over records. No lever improves both corpora
beyond noise; binary is the one with a clear win (half the download) and a cost
inside the noise on both — the author's choice for a byte-bound site, printed by
the docs with these numbers, not the default.

## Why it fits

The manifest was already the one `no-cache` file and the root of every load; the
names it lists simply became the hashes they always should have been.

## Cost and risk

- A host that rewrites JSON in flight (minifies, re-encodes) now fails the load;
  that is the point of SRI, and the error names the file.
- Content names change on every rebuild that changes bytes — which is what an
  immutable cache needs.

## Checks

`test/static-index.test.js` (names by bytes, SRI matching the files, stable
rebuild, `loadIndex` passing `integrity`); `test/no-embed.test.js`.

## What this does not do

- No Web Worker: measured cold load is ~20 ms and a question 1.5–4.7 ms at this
  scale (672 chunks), below anything a worker would buy back.
- No in-browser query embedding: the model download would dwarf the index.
