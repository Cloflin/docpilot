# Building the index

```bash
npx docpilot index
npx docpilot index --dry        # chunk and report; no embeddings, no network
npx docpilot index --no-embed   # a real index with no vectors in it
```

**It asks which embedder to build with, and the first answer is the one your config already names** — so pressing Enter changes nothing. The other rows are every provider your environment carries a key for, named by the variable so you can check your own `.env.local`, plus a local Ollama when one is answering, plus lexical-only. A row it cannot run in this environment says so instead of building until it reaches a 401.

The question needs a terminal, which is how it stays out of the way: `npx --yes`, CI and a Dockerfile never see it. Answer it up front instead, and the build is the same build:

```bash
npx docpilot doctor --embed     # the same list, printed rather than asked
npx docpilot index --yes        # take the config as it stands, ask nothing
npx docpilot index --embed-provider=ollama --embed-model=bge-m3 \
  --embed-base-url=http://localhost:11434 \
  --index-dir=docs/public/rag-ollama-bge-m3
```

`--index-dir` is what keeps an override off the index your deployed site is reading — see [When to rebuild](#when-to-rebuild) for what happens when the two disagree. Whichever way you answer, one line names the embedder before the build starts, terminal or not.

Output goes to `docs/public/rag/` — a manifest, sharded chunk text, a quantised vector blob, and a document-frequency table. The browser fetches these on first use.

`--no-embed` writes the same set minus the vector blob, for a site that retrieves lexically by declaration. It is the one-off form of [`embed: false`](/reference/config#embed-false), which is what a deployment sets — the flag on its own leaves the config naming an embedder the index does not have, and `readiness` refuses that pairing unless the config also declared [`embed.fallback: 'lexical'`](/reference/config#embed-fallback). Read what the mode costs before choosing it.

**Idempotent by construction.** Identical input produces byte-identical output: no timestamp appears in any artefact and the version is a content hash. Commit the result, or build it in CI — either way it diffs cleanly and a rebuild that changes nothing changes nothing.

## What gets indexed

Markdown under your docs directory — `.md` and `.mdx` alike — plus your OpenAPI specs, plus — when `importDir` is set — a second corpus root outside the site. See [Imported pages](/guide/imported-pages). Chunking follows heading structure: sections split at `##` and `###`, short sections merge, long ones split with overlap, and every chunk carries a context line naming the page and section it came from.

Two content tags let you steer what the assistant sees without changing what a reader sees:

```md
<llm-only>
Autosaving is controlled by autoSaveInterval, in milliseconds.
</llm-only>

<llm-exclude>
Marketing copy that would otherwise be retrieved as an answer.
</llm-exclude>
```

`llm-only` content is stripped from the rendered page and kept in the index. `llm-exclude` is the reverse. Both are ignored inside fenced code blocks, so documenting the tags does not trigger them.

### The FAQ path is covered by the same tags

A `<FaqAccordion :items="[…]">` island is not prose, and it is not indexed as prose: its question/answer pairs are lifted out and become chunks of their own, `page#faq-1`, `page#faq-2`, so a reader's question can reach an answer that only exists inside an accordion. The pairs are read wherever the page writes them — inline on the tag, or in the `<script setup>` array the tag points at.

That path obeys `<llm-exclude>` like every other. It is worth stating because it is exactly where the promise above used to be false: the FAQ was lifted off the raw page *before* the tag pass ran, so wrapping an island in `<llm-exclude>` excluded nothing. The tag pass never saw the island, the tag itself was then deleted from the prose stream, and the page looked correctly redacted while the Q&A was already on its way to becoming an indexed, citable chunk. Excluding too much is recoverable; publishing something an author marked private is not.

**A fenced sample of the component is documentation, not an island.** A page that shows `<FaqAccordion :items="[{ question: 'Sample question?', … }]" />` inside a fenced `vue` block used to produce a real `#faq-1` chunk asserting a question and an answer the page never gave. A fabricated chunk is worse than a missing one — nothing downstream can tell it from a real one, and it is retrieved, quoted and cited like any other. The sample now stays in the prose chunk verbatim, as the documentation it is.

### `.mdx`, and where the specs live {#mdx-and-specs}

`.mdx` is walked with `.md` and routed the same way: `docs/guide/install.mdx` is `/guide/install`. The module syntax MDX adds — `import`, `export`, the `{/* … *` + `/}` comment — is removed before chunking, because `import Tabs from '@theme/Tabs'` at the top of every page is a sentence that appears everywhere and means nothing. The components themselves keep their text: `<Tabs>` loses its brackets exactly as `<em>` does.

Specs are found through [`openapi`](/reference/config#openapi), which takes a directory, a file, or a `*` in the file name:

```js
openapi: ['api/openapi.yaml']
```

The default is still `docs/public/openapi/`, so a project that already put its spec there needs to write nothing. Each spec claims `/reference/<basename>`, and two specs whose file names collide stop the build rather than quietly sharing a route.

### A site without markdown {#built-site}

If your documentation is not markdown at all — Hugo, Jekyll, MkDocs, Astro, Next, a Blade or Twig template, a help centre on somebody else's platform — build it and point the indexer at the output:

```bash
npx docpilot index --html-dir=dist
```

The pages are extracted with the same rule [`import`](/reference/cli#import) uses, cited by the route they are served at, and skipped wherever a markdown page already claims that route. `--html-select` names the body when the page has no `<main>`; `--sitemap` limits the walk to the routes your site actually publishes. Full flags in [the CLI reference](/reference/cli#html-dir).

## Blocks a chunk is never cut through

Heading structure and the 500-token target are preferences; the 8,000-character ceiling (`MAX_CHUNK_CHARS`) is the law, and a section over it is split whatever its structure. What the splitter guarantees is that the structure survives the cut — because half a table is data with unnamed columns, and half a fence is code that no longer looks like code.

The ceiling applies to the chunk **as it is embedded**, not to the body alone: the `Page — Section` context line prepended to every chunk, and the frontmatter `description` prepended to the page's first one, come out of the same 8,000 characters.

**A fenced code block is never left unterminated.** A fence over the ceiling is closed at the cut and reopened on the next part with the same fence characters, the same indent and the same info string, so `js` is still `js` on the far side of the seam and no chunk ever holds code outside a fence. The room for that repair is reserved on every part, so a repaired part cannot itself exceed the ceiling and get re-cut at an arbitrary offset.

**A table is never left with unlabelled rows.** A table over the ceiling is cut between rows — never through one — and every continuation re-emits the header and the delimiter. Without that, the embedder gets `| ru | 5 | no |` with nothing to attach it to, and so does the model that later reads the chunk as evidence.

Neither is broken at the *preference* boundary either. A fence or a table stays whole there even when it alone is over the 500-token target, and the one block of overlap that carries continuity across a seam is applied only when the trailing block is prose — duplicating a near-ceiling fence or table would double its embedding cost to say the same thing twice.

### What counts as a fence, and what counts as a table

The chunker reads CommonMark fences and GFM tables, and nothing wider:

- **Fences** are three or more backticks or tildes at any indent, closed by the same character, at least as long, with nothing but whitespace after it. The info string is kept. A fence that is never closed runs to the end of the file as one block — it is contained rather than inverting everything after it, so a page that shows one fence style inside another still splits into sections correctly.
- **Tables** are a row line whose *next* line is a delimiter row that agrees with it. Pipes separate cells and `\|` stays inside its cell; the outer pipes are optional, so `| a | b |` and `a | b` are the same two cells. The delimiter carries the whole test: it must hold at least one unescaped pipe, contain nothing but pipes, colons, dashes and whitespace, have every cell match `-`, `:-`, `-:` or `:-:` (any length of dashes), and have exactly as many cells as the header. The table then runs to the first blank line or the first line with no pipe in it.

Those rules have consequences worth knowing when you write. A one-column table is recognised, as long as its delimiter has a pipe (`| Value |` over `| --- |`). A setext heading — `Introduction` over `---` — is not a table, and the pipe requirement in the delimiter is exactly what keeps it from becoming one. Prose with a pipe in it (`Use foo | bar to filter` over a list item) fails on both shape and cell count, and stays prose.

Anything inside a fence is code first: a table drawn inside a fenced `md` sample is never read as a table.

### The three warnings, and what each says about the page

A build prints these as `warn` lines from `npx docpilot index` (and from `--dry`, which chunks without embedding). None of them fails the build, and each one is a structural signal rather than a defect:

| warning | what happened | what it usually means |
|---|---|---|
| `code block split by MAX_CHUNK_CHARS in <path>` | one fenced block was over the ceiling; it was closed and reopened | the sample is longer than any answer will quote. Cut it into named steps, or move the full listing to a repository the docs link to |
| `table split at row boundaries by MAX_CHUNK_CHARS in <path>` | a table was over the ceiling; each part carries the header again | a table that big is usually a section. Rows describing different things retrieve far better as headings with prose under them |
| `table row longer than MAX_CHUNK_CHARS cut mid-row in <path>` | one **row** did not fit even with the header re-emitted, so it was cut mid-row | a single cell is carrying a payload — a base64 blob, a stack trace, a paragraph. Move it out of the table |

The third is the only case where structure could not be preserved, which is why it is worded separately from the second. The `code block split` wording is unchanged from earlier releases: build logs and the corpus checklist in the `docs-rag` authoring skill both match on that string.

### What moves when you upgrade

Block-aware packing repacks pages that used to be cut by line. Measured across the 205 markdown pages this package develops against, with the chunker as the only thing changed: **43 pages pack their text differently, and 20 of them end up with a different list of chunk ids** — a section that produced three parts now produces two, or four.

Chunk ids are `path#anchor`, `path#anchor~2`, `path#anchor~3`, so a continuation pin in a golden set can now name a chunk that no longer exists. `npx docpilot lint` is how you find them: it errors on a `gold_chunks` entry that matches nothing in the index and warns on one that survives only as a prefix. Rebuild the index first, then lint, then repoint what it names.

**The `~` is new, and it is what a continuation part means now.** Those parts used to be spelled `-2`, `-3` — which is also how VitePress disambiguates a heading that appears twice, so the second `### Parameters` on a page is `#parameters-1`. One suffix, two meanings: a page with three `## Parameters`, the first long enough to pack into five parts, emitted `parameters-2` twice and killed the build on `duplicate chunk id` — an id that appears nowhere in the author's source. It also scored a retrieval of one section as a hit on another, because nothing downstream could tell the two suffixes apart. `~` is used because a heading slug can never produce one, so the two namespaces are disjoint by construction; the anchor a citation links to is unaffected, since every part of a section shares the anchor and the suffix lives in the id alone.

So this upgrade renames every continuation id on every page that has one. `gold_chunks` is the only place those ids are written down by hand — run `lint` after the rebuild and repoint what it names.

## Frontmatter that helps

```yaml
---
title: Authentication
description: How to obtain a token and attach it to a request.
---
```

`description` is indexed with the page and is often what makes a paraphrased question find it. It is the strongest dense lever there is, and it lands on the page's **first chunk only** — so write it as the question a reader would ask, not as a topic label. On one measured page it moved that chunk's cosine from 0.426 to 0.556 for the reader's phrasing.

A third key is read, and only matters for imported pages:

```yaml
---
title: Product overview
description: What the product does, in one sentence.
source: https://example.com/product
---
```

`source` names the page this one was imported from. It is read **at column 0 only** — a `source:` nested under some other key belongs to that key — and it is checked against `docPilot.sources.allow` at build time. A page in `docsDir` may carry one too: provenance and routing are independent, and then the citation row opens the original while the page stays part of the site.

## When to rebuild

Whenever the docs change, and always when `embed.model` changes. Rebuilding also re-checks the calibration: a threshold measured with one embedding model does not survive a swap to another, and `docpilot index` refuses a calibration whose `embedModel` does not match rather than inlining it silently.

The corpus hash covers the chunk TEXT. Swap the embedder and every cosine moves while the hash does not — which is why the model name is recorded beside the thresholds. The manifest records which model built it, and the panel compares that against the model the browser embeds with: a mismatch drops retrieval to keyword-only and says so loudly in the console rather than scoring queries against a foreign vector space.

That comparison needs a NAME on both sides. A config that leaves the model to a free pool or to `'auto'` gives it none, so the check passes by having nothing to check and the only thing left is vector width — which two 1024-dimensional models pass identically. This is why building with something other than what your config names writes to a directory of its own by default, and why the block `index` prints for you to paste names the model rather than repeating the shorthand you started from.

## A second index, to measure against

Nothing stops a project committing more than one index of the same corpus, and
there is one good reason to: **a weaker embedder is a floor.** A retrieval
configuration that answers well on 1024 local dimensions answers at least as well
on the 2048 a hosted pool gives you, so a run against the weaker index is a lower
bound rather than a different measurement — and a regression that shows up there
is a real one.

This site does it. `docs/public/rag/` is the deployed index, embedded by
OpenRouter; `docs/public/rag-local/` is the same corpus embedded by a local
`bge-m3`, and both are committed:

```js
// docs/.vitepress/config.mjs
const LOCAL = process.env.DOCPILOT_EMBED_LOCAL === '1'

export const docPilot = {
  ...(LOCAL
    ? { indexDir: 'docs/public/rag-local', embed: { provider: 'ollama', model: 'bge-m3' } }
    : { embed: 'auto' }),
}
```

```bash
DOCPILOT_EMBED_LOCAL=1 npx docpilot index    # costs no API requests
DOCPILOT_EMBED_LOCAL=1 npx docpilot bench    # the floor, measured
```

**`indexDir` is the whole of the separation.** Without it both builds write to
the same directory, and the local one overwrites the deployed index with a
manifest the browser cannot use — on a spent daily quota, with no way to rebuild
it until the limit resets.

**Both are held to the corpus.** The freshness gate walks every `manifest.json`
under `docs/public/` and fails when any of them stops matching what `docs/`
chunks to, which is the only thing that makes the comparison mean anything: two
indexes of two different corpora are not a measurement.

**And the deployed site cannot land on the wrong one by accident.** The manifest
names the model that built it, `readiness()` raises a hard `missing` when the
browser's embedder does not serve that model, and `npx docpilot doctor` exits 1
on it. Serving a `bge-m3` index takes an embedder that serves `bge-m3`; there is
no arrangement where it silently degrades to keyword matching.

What it costs is disk and deploy weight — a second copy of the vectors, about the
size of the first. Readers download neither one they are not using.

## Vectors are quantised

Chunk vectors are stored as **one sign bit per dimension** when the embedder is wide enough to afford it — a thirty-second of float32 and an eighth of int8. On this site's golden set the 1-bit index ranks within noise of the int8 one: the same recall@8, MRR within 0.01. At the widths current embedders produce, the bit is what keeps the blob in kilobytes.

The scheme keeps the half that matters at full precision. Every chunk vector is L2-normalised and reduced to its signs, eight to a byte; the **question's** vector is never quantised. The browser scores `Σ q[i] · sign(d[i])` — an asymmetric product, which keeps far more of the cosine than comparing two sign strings would — and multiplies once by a corpus-wide `cosScale` the build fits by least squares and writes into the manifest. That one number is what keeps the dense score on the cosine scale the [gate](/concepts/the-gate) and its calibrated thresholds are written in.

The blob is a single file, `vectors.<hash>.bin`, exactly `chunkCount × dims / 8` bytes long — the store checks that on load and throws rather than scoring against a truncated download, then unpacks it to ±1 once. The chunk **text** is what gets sharded, 250 chunks per `chunks-NN.<hash>.json`.

**The error is measured, not assumed.** Every build samples up to 200 vector pairs, compares the exact float cosine against the 1-bit score, and prints the mean absolute difference:

```
quantisation err 0.00910 mean |Δcos| (1-bit)
```

Above `0.03` the build **dies** instead of writing the index. That is a hard gate rather than a warning, because a quantisation that has drifted produces a ranking that is subtly wrong everywhere and looks fine.

**The bit is taken only where it holds.** By default (`--quantize=auto`) the build measures the 1-bit error first and writes the bit only when it is at most `0.015`; otherwise it writes **int8** — one signed byte per dimension, `round(v × 127)`, under a `0.01` gate — and says so. The error tracks width: at 4096 dimensions it is about `0.010` and ranking holds; at 1024 (`bge-m3`) it is about `0.023`, and MRR on the golden set falls from 0.57 to 0.54. `--quantize=binary` or `--quantize=int8` overrides the choice. Re-run `calibrate` after the format changes: the scale is fitted, but a threshold calibrated on one format is a measurement of that format.

For scale: this documentation site indexes 777 chunks at 4096 dimensions, so its vector blob is 397,824 bytes — 389 KB, where int8 would have been 3.0 MB and float32 12.1 MB.

### How the format was chosen {#how-the-format-was-chosen}

The format was measured on this site's own corpus before it became the default, with the embedder this site runs (`qwen/qwen3-embedding-8b`, 4096 dimensions). Every variant was built from the same float32 vectors and ranked by the same retriever the panel runs. Two numbers decided it:

- **dense agreement** — of the top 8 chunks that exact float32 cosine returns, how many the variant also returns, averaged over 827 questions (no gold needed);
- **recall@8 and MRR** on the 96-question golden set, with hybrid retrieval.

| variant | vector blob | dense agreement | recall@8 | MRR |
|---|---|---|---|---|
| int8, 4096 dims (the previous format) | 2.3 MB | 0.96 | 0.758 | 0.598 |
| int4, 4096 dims | 1.1 MB | 0.94 | 0.780 | 0.629 |
| **1-bit, 4096 dims (now)** | **290 KB** | **0.83** | **0.758** | **0.599** |
| int8, first 1024 dims | 580 KB | 0.79 | 0.750 | 0.573 |
| int8, first 512 dims | 290 KB | 0.70 | 0.727 | 0.579 |
| 1-bit, first 2048 dims | 145 KB | 0.76 | 0.750 | 0.577 |
| 1-bit, first 1024 dims | 73 KB | 0.68 | 0.712 | 0.550 |

**At equal size, fewer bits beat fewer dimensions.** All 4096 dimensions at one bit agree with float32 on 83 % of the top 8; the first 512 dimensions at one byte, the same 290 KB, agree on 70 %. So the build never truncates. One gold chunk moves recall@8 on 96 questions by about 0.008, so a difference under 0.02 in that column is noise, not ranking.

**The full eval agrees.** `npx docpilot eval --gate-only` on the rebuilt index, against the int8 index it replaced: recall@8 is 0.803 for both, MRR 0.631 → 0.635, retrieval F1 0.328 → 0.335. After re-calibration, `tau` moved from 0.55 to 0.57.

**A narrower embedder cannot afford the bit.** The same comparison on `bge-m3` (1024 dimensions) kept recall@8 at 0.811 but lost MRR, 0.572 → 0.540, and moved the gate's D by 0.06 on average. That is why `auto` reads the measured error instead of always taking the bit, and why this site's `bge-m3` index is still int8.

**Two ideas that sound right measured worse:**

- **Centring before the sign** — subtracting the corpus mean vector, a common fix for anisotropic embeddings — lowered dense agreement from 0.83 to 0.77.
- **Compressing the blob.** Sign bits look random to brotli and gzip: the 1-bit file compresses by under 2 %, where int8 compressed by about 60 %. The download is about three times smaller, not eight.

To measure your own corpus, build each format and run the eval after each build. Both runs share one index hash, so compare the timestamped copies in `${evalDir}/reports/history/`, not `latest.json`:

```bash
npx docpilot index --quantize=int8 && npx docpilot eval --gate-only
npx docpilot index --quantize=binary && npx docpilot eval --gate-only
```

## Scale

In-browser vector search is comfortable to roughly 5,000–10,000 chunks before memory and latency start to show. A typical documentation site is well inside that. Past it, the honest answer is a server, and this plugin is the wrong tool.
