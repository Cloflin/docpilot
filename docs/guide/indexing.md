# Building the index

```bash
npx docpilot index
npx docpilot index --dry        # chunk and report; no embeddings, no network
npx docpilot index --no-embed   # a real index with no vectors in it
```

Output goes to `docs/public/rag/` — a manifest, sharded chunk text, a quantised vector blob, and a document-frequency table. The browser fetches these on first use.

`--no-embed` writes the same set minus the vector blob, for a site that retrieves lexically by declaration. It is the one-off form of [`embed: false`](/reference/config#embed-false), which is what a deployment sets — the flag on its own leaves the config naming an embedder the index does not have, and `readiness` refuses that pairing outright. Read what the mode costs before choosing it.

**Idempotent by construction.** Identical input produces byte-identical output: no timestamp appears in any artefact and the version is a content hash. Commit the result, or build it in CI — either way it diffs cleanly and a rebuild that changes nothing changes nothing.

## What gets indexed

Markdown under your docs directory, plus any OpenAPI YAML in `public/`, plus — when `importDir` is set — a second corpus root outside the site. See [Imported pages](/guide/imported-pages). Chunking follows heading structure: sections split at `##` and `###`, short sections merge, long ones split with overlap, and every chunk carries a context line naming the page and section it came from.

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

## Vectors are quantised

Chunk vectors are stored as int8. The round-trip error is below 0.01 cosine, which is under the noise floor of the ranking it feeds, and it makes the difference between an index a browser downloads and one it does not.

## Scale

In-browser vector search is comfortable to roughly 5,000–10,000 chunks before memory and latency start to show. A typical documentation site is well inside that. Past it, the honest answer is a server, and this plugin is the wrong tool.
