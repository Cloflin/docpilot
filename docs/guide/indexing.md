# Building the index

```bash
npx docpilot index
npx docpilot index --dry   # chunk and report; no embeddings, no network
```

Output goes to `docs/public/rag/` — a manifest, sharded chunk text, a quantised vector blob, and a document-frequency table. The browser fetches these on first use.

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
