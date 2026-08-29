# Follow-up: `calibrate --transfer`

Written 2026-08-29 at the end of the session that built the feature. Everything
below is executable cold — no earlier conversation needed.

---

## What exists now

`npx docpilot calibrate --transfer=<file>` carries a gate calibration measured
with one embedder onto an index built with another, by keeping `tau`,
`tauLexical`, `wDense`, `wLexical` and **re-fitting only the cosine window**.

Why that is legal, in one line: `denseFromCosine`
(`src/theme/docpilot/gate.js:83`) maps a raw cosine affinely into `[0,1]`, so
`cosFloor`/`cosCeil` are the only two guard numbers that describe an embedder —
the thresholds and weights are in normalised units and describe the corpus, and
`L` is BM25 over text.

**Measured against ground truth** — bge-m3 (1024d) → `qwen3-embedding` (4096d),
one corpus, 271 anchors of 597, then scored on all 597:

| | window | tau | decision cut at `L=0` | U | S | F | negatives caught |
|---|---|---|---|---|---|---|---|
| transferred | `[0.22, 0.62]` | 0.63 | 0.5560 | 0/169 | 1/128 | 0/60 | 40.0% |
| measured there | `[0.24, 0.64]` | 0.60 | 0.5600 | 0/169 | 2/128 | 0/60 | 40.8% |

`tauLexical` reproduced exactly (0.51), which is the integrity check: BM25 cannot
move under an embedder swap.

### Uncommitted, and nothing is staged

| file | change |
|---|---|
| `src/eval/calibrate.js` | `--transfer` / `--anchors` / `--out`, `loadTransferSource`, `anchorQuota`, `pickAnchors`, `fitWindowAtTau`, the `buildDoc` transfer branch |
| `src/build/build-rag-index.js` | `calibrationPathFor()` — per-index calibration lookup, shared file as fallback |
| `test/docpilot.test.js` | 8 tests in two new `describe` blocks inside the window-sweep suite |
| `docs/reference/cli.md` | the three flags + the transfer semantics under `calibrate` |
| `docs/guide/evaluation.md` | new section "Carrying a calibration across embedders" |
| `skills/docs-rag/SKILL.md` | the binding rule about embedder swaps, sharpened |
| `docs/.vitepress/config.mjs` | `DOCPILOT_EMBED_MODEL` switch, explicit `embed.baseURL` |
| `.env.local` | `OLLAMA_BASE_URL` (backup at `.env.local.bak`) |
| `docs/public/rag-local/` | rebuilt at corpus `345d75e4`; old hash-named files show as deletions |
| `docpilot/` | the authored eval sets — untracked, and **not** gitignored here |

Decide commit vs discard before starting. `docpilot/bench/` (3.1 MB) and
`docpilot/calibration.raw.jsonl` (320 KB) are per-run scratch that `docpilot
init` would gitignore; the rest of `docpilot/` is authored source worth keeping.

---

## Task 1 — `docs/guide/indexing.md` still describes the old world

Section **"A second index, to measure against"** (~line 115) tells the reader to
commit two indexes of one corpus. That advice is now incomplete in one way and
wrong in another:

- it does not mention that a second index can be **calibrated by transfer**
  rather than left provisional — which is the section's obvious use;
- it predates `calibrationPathFor()`, so a reader following it has two indexes
  and, until this session, one `calibration.json` between them.

Add: the per-index name `calibration.<indexDirBasename>.json` is looked up first
and the shared `calibration.json` is the fallback, so a single-index project is
unaffected. Cross-link the new evaluation.md section.

Also check **"When to rebuild"** (~line 109). It currently says "a threshold
measured with one embedding model does not survive a swap to another". Sharpen to
the true version: the *window* does not survive; a normalised `tau` does, if the
window is re-fitted — and `docpilot index` still refuses any calibration whose
`embedModel` does not match, transferred or not.

---

## Task 2 — the paired regression checklist (the real remaining work)

This is the strongest verification available and it was deferred, not rejected.

The source `calibration.json` already carries the source's per-probe verdicts for
free:

- `chosen.byStratum[k].ids` — refused ids for positive strata, escaped ids for
  negative ones;
- `boundingProbes.newlyRefused` — `[{id, stratum}]`;
- `backlog` — the ten positives nearest tau.

**Force all of those into the anchor draw, plus every positive with `L_raw = 0`**
(the probes that can only pass on the dense channel and are therefore pure
functions of the window — the Cyrillic probes in this set are exactly these).
Score them as a **named checklist with ids, as counts, never as a rate**, the way
RAG-SPEC 3.2 keeps lexical-only numbers unpooled. A probe that passed on the
source and is refused on the target is a regression the Wilson bound structurally
cannot catch.

**Hard constraint:** this group must be **disjoint** from the bounded anchor draw
and must never enter `sweepRow`. A difficulty-weighted sample is not i.i.d., and a
UB95 computed over one is not a bound. You can have a valid bound or an
adversarial witness set from one draw — not both.

Entry points: `pickAnchors` and `anchorQuota` in `src/eval/calibrate.js`;
`transferCheck` in `main()` is where the result belongs.

---

## Task 3 — `guard.source` reaches the manifest unvalidated

`guardFor` copies `source` verbatim (`src/build/build-rag-index.js`, the return
projection near the end of the function) into `manifest.guard`. From there
`src/theme/docpilot/session.js:2445` stamps it onto **every feedback record** and
`src/eval/report.js:171` prints it into every eval report. Today any string
whatsoever travels that path: a hand-edited `"calibrated"` in `calibration.json`
silently upgrades a provisional-quality guard to a fully-measured claim across
every artefact the project produces.

Add a **warn-and-pass** allowlist, not a reject — `guardFor`'s contract is that
documentation stays publishable, so refusing would be the wrong severity:

```js
const SOURCE_VOCABULARY = [
  'calibrated',
  'calibrated-reduced',
  'calibrated-reduced-lexical',
  'transferred-window',
]
```

`'provisional'` stays out deliberately — it is this function's own output, never
an input.

**Do not break `test/docpilot.test.js` (~line 2837)**, which pins acceptance of a
legacy `'calibrated'`. Keeping that value in the allowlist satisfies it unchanged.
Add a sibling test that an unknown source still passes but warns.

---

## Task 4 — two pre-existing failures, neither caused by this work

`npx vitest run` → **1531 pass, 3 fail.** Both causes verified independently.

1. **`test/vercel-proxy.test.js` ×2.** Caused by `DOCPILOT_EMBED_LOCAL=1` in
   `.env.local`: the config then names `provider: 'ollama'`, which is not hosted,
   so no `/ai` routes exist and the contract does not match `vercel.json`'s two
   rewrites. Proof: `DOCPILOT_EMBED_LOCAL=0 npx vitest run test/vercel-proxy.test.js`
   → 29/29 pass. Either scope the test to the deployed configuration or have it
   skip under the local flag.

2. **`test/docs-links.test.js` — the freshness gate.** `docs/public/rag` sits at
   hash `87a483e5` / 405 chunks while the corpus now chunks to `345d75e4` / 460.
   Rebuilding it needs `OPENROUTER_API_KEY`, which is set nowhere in this
   checkout. Unfixable without that key.

---

## Verification

```bash
npm run verify                 # check + typecheck + test
npx vitest run test/docpilot.test.js -t "tau inherited"      # 5 pass
npx vitest run test/docpilot.test.js -t "anchor selection"   # 3 pass
```

To re-run the ground-truth comparison end to end (free, needs the ollama at
`OLLAMA_BASE_URL` serving both `bge-m3` and `qwen3-embedding`):

```bash
node bin/docpilot.js index && node bin/docpilot.js calibrate   # source, bge-m3
DOCPILOT_EMBED_MODEL=qwen3-embedding node bin/docpilot.js index
DOCPILOT_EMBED_MODEL=qwen3-embedding node bin/docpilot.js calibrate \
  --transfer=docpilot/calibration.json --out=docpilot/calibration.transferred.json
DOCPILOT_EMBED_MODEL=qwen3-embedding node bin/docpilot.js calibrate \
  --out=docpilot/calibration.truth.json                        # ground truth
```

Then `regate` both windows over `docpilot/calibration.raw.jsonl` and compare the
effective cut `cosFloor + span·(tau/wDense)` — 0.004 apart last time.

---

## Gotchas that cost time this session

- **`manifest.hash` does not move with the embedder.** It is sha256 over chunk id
  and text, so two indexes of one corpus embedded differently carry the **same**
  hash. That is why the corpus check in `loadTransferSource` is an equality to
  assert and never a stamp to write.
- **Pinning tau makes `gatePrecision` a monotone reward for refusing
  everything.** The unfiltered argmax on this corpus is `[0.44, 0.84]` — 100%
  negative-catch at 77.5% over-refusal on `U`. `sweepRow(...).feasible` is kept
  as a hard filter for that reason; do not "simplify" it away.
- **Anchor counts are dictated by the bounds.** `UB95(0,n) ≤ 0.05` needs `n ≥ 52`;
  a 120-probe proportional draw gives `U ≈ 34` and refuses **every** window in the
  grid. `--anchors` takes `bounded` or `full`, never a number.
- **`nodeEmbedTarget` ignores `OLLAMA_BASE_URL` for a named `ollama`** — it reads
  `embed.baseURL || LOCAL_BASE_URL`. Without an explicit `baseURL` in the config,
  every `index` and `calibrate` embeds against `localhost`, which is invisible
  while both hosts serve the same model. Now stated in `config.mjs`.
- **`eval` ignores `docPilot.chat` entirely.** `src/eval/run.js:216` and `:179`
  take `DOCPILOT_PROVIDER` (default literal `'ollama'`) and `DOCPILOT_BASE_URL`
  (default `http://localhost:11434`). A run intended for a remote box goes to
  localhost if one happens to serve the same model name, and the report records
  no base URL to catch it.
- **`--sweep-only` cannot serve a different embedder.** `sigOf` includes
  `embedIdentity = [embedModel, dims, denseMode]`, so every cached row misses by
  design — a transfer must embed its anchors live.
