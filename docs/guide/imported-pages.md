# Imported pages

Some of what your readers ask about is written down somewhere that is not this site — a product page, a status page, a policy. The assistant can answer from it and cite the original, without mirroring it into your navigation.

## What an imported page is

A markdown file in a directory **outside** `docsDir`, indexed as corpus and rendered by nothing:

```js
docPilot = {
  importDir: 'knowledge-base',
  sources: { allow: ['https://example.com'] },
}
```

VitePress never sees that directory. No route is built, nothing enters the sidebar, the sitemap or llms.txt, and the copy cannot compete with the original in search. What the page gets instead is a mandatory `source:`, which is the only address it has.

```md
---
title: Product overview
description: What the product does and which plan includes what.
source: https://example.com/product
importedAt: 2026-08-14
---

# Product overview

::: info
Imported from [Example](https://example.com/product) on 14 August 2026.
The original page is the source of truth.
:::
```

## The allowlist is a security boundary

`docPilot.sources.allow` decides which origins a `source:` may name. It is not a convenience setting.

The value travels from frontmatter into `manifest.pages[].origin`, into the source row, and out as an `href` rendered inside the answer panel. Without a gate, a `javascript:` URL hand-written into any markdown file in the repository would be stored XSS. So:

- **https only**, by allowlist rather than denylist — `javascript:`, `data:` and `vbscript:` are the ones with names, and the next one is the one nobody named;
- **origins are compared as origins**, which is what defeats `https://example.com.evil.test` and `https://example.com@evil.test`;
- **a path prefix narrows at a segment boundary**: `https://example.com/docs` admits `/docs` and `/docs/anything`, and rejects `/docsecret`;
- a `source:` outside the list **fails the build**, with the page named.

Absent is legal and means "no page may declare a source". A malformed list is not legal — it reads as an allowlist that is silently allowing nothing — and `docpilot doctor` reports it before the next build finds out.

## Its path is an id, not a link

An external page has no route, so its `path` in the manifest is an identifier that merely looks like one. Three things follow, and all three are enforced rather than requested:

- `manifest.pages[]` carries `external: true`;
- the source row and the `[n]` citation marker open the **origin**, in a new tab, with `rel="noopener noreferrer"` — the answer is rendered as HTML, and an opened tab that keeps `window.opener` can navigate the panel it came from;
- the id is absent from the set of routes a link may point at, so a model link to it is **de-linked** rather than rendered as an anchor to a 404. The reader still reads the sentence; the only live link to that material is its source row.

A page inside `docsDir` may also carry `source:`. Then it keeps its route — the citation row opens the original, and the page itself stays part of the site.

## Links out of an imported page

`vitepress build` checks dead links for every page it renders, and it never renders this one. `docpilot index` does it instead, and fails on a link to a path that is not a page of this site — after the generated routes are known, so a link into `/reference/…` resolves correctly.

## It is still public

The index under `public/rag/` is served to every browser that opens the panel, and the chunks contain the page verbatim. Having no route hides the page from navigation and from search engines. **It does not make the content private.** Nothing belongs here that could not be published.

## The build tells you

```
  pages            214 (3 imported, 2 of them external)
```

An imported page belongs to no sidebar section, so it is also reported as an orphan page. That is expected: it is retrievable under "All docs" — the default — and invisible to a reader who has narrowed the scope. Worth knowing if the import exists to answer a question a narrowed reader would ask.

## Importing one

```bash
npx docpilot import https://example.com/product --dry-run
npx docpilot import https://example.com/product
```

The command does the whole page: it checks the allowlist **before** it fetches, extracts the documentation from the markup in code, writes the frontmatter and the attribution block, and then runs one model pass that may add `<llm-only>` and `<llm-exclude>` and nothing else. See [`import`](/reference/cli#import) for the flags.

Two things are worth knowing before the first run.

**If the site already publishes markdown, that is what gets imported.** A VitePress site running `vitepress-plugin-llms`, and the Docusaurus and Mintlify equivalents, serve `page.md` beside `page`. That file is not an approximation of the page — it is what the page was built from — so nothing is extracted, nothing is dropped, and the report says where the body came from:

```
  read         https://vitepress.dev/guide/what-is-vitepress.md
               the page's OWN markdown — nothing was converted or dropped
```

It is found from `<link rel="alternate" type="text/markdown">` when the site declares one, and otherwise derived from `<link rel="canonical">` — most sites that publish markdown declare nothing at all. A derived URL crosses the same allowlist as the page, and is only used if the response is 200, non-empty and not HTML. Everything below happens when no such file answers.

**The conversion is code, not a summary.** Asking a model for "the full text" of a page returns a paraphrase — measured, it rewrote prose into reported speech, dropped the sentence that stated a product guarantee, and reorganised the sections. A paraphrase in the corpus is a sentence nobody at the source wrote, which the assistant then cites with a link to a page that does not say it. So the extraction is a rule that runs the same way every time and names every block it dropped:

```
[docpilot] import knowledge-base/product.md
  title        Product overview
  description  What the product does and which plan includes what.
  body         214 lines · 19 links
  read         <main#content> — nothing outside it was read
  dropped      10 blocks:
               class/id ~ "cta"       "Book a call with our team"
               link styled as a button "Start free"
  annotation   1 <llm-only> · 0 <llm-exclude>
               + Throttling and rate limiting are the same limit here.
               ^ shown to readers and cited as documentation — check it.
```

**The annotation pass is verified, not trusted.** What it returns is stripped of the two tags and compared to what went in, character for character. A model that reworded a line, dropped a table row or reordered two sections fails that check and its whole answer is discarded — the page is written exactly as converted, and the report says why. `<llm-only>` text is indexed, citable **and shown to readers**, so the command prints every line it added: that is the one part of an import a person still has to read.

**A page that will not fetch** — behind a bot wall, or built by JavaScript — is not a dead end. Open it in a browser, save the DOM, and pass it with `--html page.html`. Everything after the fetch is the same.

## Authoring one by hand

`npx docpilot init` installs a `docs-import` skill that carries the judgement the command does not make: whether a page is worth importing at all, what to do with the live half of a status page, how to phrase a `description` as the question a reader would ask, and the gate order an import has to pass. See [Skills](/reference/skills).
