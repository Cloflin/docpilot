---
name: docs-import
description: >-
  Import a page from an allowlisted external site into the docs corpus so DocPilot
  can answer from it and cite the original. Use when asked to "add this page to
  the assistant", "the assistant should know about X from our marketing site",
  "pull this article into the docs", "refresh the imported pages", or when a
  question the assistant refuses is answered by a page that lives outside this
  repository. Covers the allowlist, the frontmatter provenance contract, the
  text-only extraction rule, `<llm-only>` / `<llm-exclude>` annotation, and the
  build and eval gates an import must pass.
---

# docs-import

Turns an external page into a page of this corpus: text only, provenance
attached, indexed by `npx docpilot index`, cited by DocPilot with a link that opens
the original in a new tab.

Retrieval and eval mechanics are **not** restated here — that is
[docs-rag](../docs-rag/SKILL.md), and its rules bind this skill too, in
particular the `<llm-only>` content rule and the two-percentage-point revert
rule. What lives here is the import contract.

## What an import actually is

An imported page is **corpus, not a page of this site**. It is written to
`docPilot.importDir` — a directory deliberately OUTSIDE `docsDir` — so VitePress
never renders it: no route, no sidebar entry, no sitemap, no llms.txt, and no
mirror competing with the original in search.

The indexer walks that directory as a second corpus root. The chunker, the gate
and retrieval treat the result exactly like any other page. Two things follow
from having no route, and both are enforced at build time:

- **`source:` is mandatory.** It is the only address the page has. A file under
  `importDir` without one fails the build.
- **Its `path` is an id, never a link.** `manifest.pages[]` carries
  `external: true`; the source row and the `[n]` marker open the origin in a new
  tab with `rel="noopener noreferrer"`, and `knownPaths` omits the id, so a model
  link to it is de-linked rather than rendered as an anchor to a 404.

A consequence worth stating plainly: the text is still **public**. The index
under `public/rag/` is served to every browser that opens the panel, and the
chunks contain the page verbatim. Not having a route hides the page from
navigation and from search engines. It does not make the content private, so
nothing may be imported here that could not be published.

A page that *should* have a route belongs in `docsDir` instead. It may carry
`source:` too — provenance and routing are independent — and then its row opens
the original while the page itself stays part of the site.

If `docPilot.importDir` is not set, this repository imports nothing. Setting it is
the user's decision, not this skill's; say what it would be for and ask.

## The allowlist

`docPilot.sources.allow` in the VitePress config — an array of https origins,
optionally narrowed by path prefix:

```js
sources: {
  allow: [
    'https://example.com',
    'https://example.com/blog',   // that prefix and nothing else on the host
  ],
}
```

**Both halves are enforced.** This skill refuses to fetch a URL outside the list;
`npx docpilot index` refuses to build a `source:` outside it, non-https, or
malformed, and fails with the route named. The build check is the one that
matters — it is what stops a `javascript:` URL hand-written into a markdown file
from becoming an `href` in the answer panel.

A prefix is matched at a SEGMENT boundary, so `https://example.com/docs` admits
`/docs` and `/docs/anything` and rejects `/docsecret`. To add an origin, edit the
list — and say out loud that it is being widened, because it is a security
boundary, not a preference.

## Extraction rule: headings and text, nothing else

**Convert the markup. Never index a summary of it.**

`WebFetch` answers a prompt about a page using a small fast model, so asking it
for "the full text" returns a *paraphrase*. Measured: it rewrote prose into
reported speech, dropped a sentence that was the only statement of a product
guarantee, dropped the whole tooltip layer, and silently reorganised the section
order. A paraphrase is not documentation: it puts sentences into the corpus that
nobody at the source wrote, and the assistant then cites them.

**`npx docpilot import <url>` does this part.** It is not a convenience wrapper —
it is the extraction rule as code, so that the same page produces the same
markdown on every run and every dropped block is named on stdout:

```bash
npx docpilot import https://example.com/product --dry-run   # report only
npx docpilot import https://example.com/product             # writes the file
```

**It prefers the markdown the site already publishes.** `page.md` beside `page`
— what every VitePress site running `vitepress-plugin-llms` serves — is the file
the page was built from, so it is imported as-is: nothing extracted, nothing
dropped. It is found from `<link rel="alternate" type="text/markdown">` or
derived from `<link rel="canonical">`, crosses the same allowlist as the page,
and is only accepted if the response is not HTML. The report names the URL the
body came from. `--no-alternate` forces the conversion path.

When there is none, it checks `sources.allow` **before** it fetches, keeps headings, prose, lists,
data tables, code samples and tooltips, drops navigation, footers, banners,
share rails and anything whose meaning is a button, writes the frontmatter and
the attribution block, and then runs ONE model pass that may add `<llm-only>` and
`<llm-exclude>` and nothing else — verified by stripping those tags and comparing
the result to the input character for character. See `docs/reference/cli.md`.

So the work here is no longer transcription. It is:

- deciding whether the page is worth importing at all;
- reading the report — the blocks it dropped, the subtree it read, and every
  `<llm-only>` line it added, because that text is indexed, citable AND shown to
  readers;
- the judgement calls below, which no rule settles;
- the gates.

**When the fetch will not work** — a bot wall, or a page built by JavaScript —
get the real markup and pass it in with `--html <file>` or `--html -`. In order
of preference: a browser tool that returns the DOM as it renders
(`get_page_text` / `read_page`), the user pasting the `<main>` markup, or
`tavily-extract`. `WebFetch` is acceptable only to *check whether a page is worth
importing*; asking it for "the full text" returns a paraphrase, and its output
must never become the body of the file.

**Check the language.** A site that negotiates on geography answers in the
reader's language whatever `accept-language` says — measured on the first live
run, which fetched a Ukrainian page for an English corpus. The command reports a
mismatch; the fix is the site's own URL for that language, or `--html`.


Two page families need a judgement call rather than a copy:

- **Anything live** — status pages, current incidents, uptime numbers — is true
  for hours. Import the stable half (what each component is, the SLA, the
  escalation path); wrap the live half in `<llm-exclude>` or leave it out. A
  snapshot of "all systems operational" cited three weeks later is a wrong answer
  with a citation on it.
- **Prices, quotas and per-plan feature marks** are copied verbatim when the page
  carries them, because a plan comparison with the numbers removed answers
  nothing. What makes that safe is the attribution block: it states the import
  date and that the figures are not maintained here. They are the first thing to
  re-check on a refresh, and the reason a refresh is worth scheduling.

## The page contract

`<importDir>/<slug>.md`:

```md
---
title: Unique Page Title
description: One sentence, phrased as the task a reader came to do.
source: https://example.com/some-page
importedAt: 2026-08-14
---

# Unique Page Title

::: info
Imported from [Example](https://example.com/some-page) on 14 August 2026.
The original page is the source of truth.
:::

## …
```

Four rules the build enforces or the corpus depends on:

- **`title` must be unique across the corpus.** The indexer fails the build on
  two pages sharing a `(title, tail)` pair — the source list would otherwise
  render two identical rows.
- **`description` is the strongest dense lever there is**, and it lands on the
  page's first chunk only. Write it as the question a reader would ask, not as a
  topic label.
- **`source` is read at column 0 only** and must be a bare https URL — no
  nesting, no quotes needed. A `source:` indented under some other key belongs to
  that key and is ignored. `importedAt` is for humans and the refresh pass;
  nothing reads it at build time.
- **The attribution block stays even though nobody browses to the page.**
  `unwrapContainers` keeps it in the chunk text, so the provenance travels with
  the evidence the model reads, and the lines that say what was deliberately left
  out stop a later reader from treating the import as complete.

Internal links: rewrite to this site's routes without `.md` where an equivalent
page exists here, otherwise keep the absolute external URL. `vitepress build`
cannot check these — VitePress does not see the file — so `docpilot index` does it
instead and fails on a link to a path that is not a page of this site.

## Annotation pass

`docpilot import` runs this pass automatically, with the model `chat` points at,
and prints every line it added. It is allowed to add `<llm-only>` and
`<llm-exclude>` and NOTHING else — its answer is stripped of those two tags and
compared to the input character for character, and a model that reworded,
reordered or dropped anything has its whole answer discarded and the page
written exactly as converted. `--no-annotate` skips it.

What is left for a person is to READ what it added, and to add what it missed.
Read the page once as the retriever will:

- **vocabulary gap** — the words a reader would use never appear. Add them to
  `description`, or state them in an `<llm-only>` line.
- **structure** — the answer exists but is split across sections so no single
  chunk carries it. Add an `<llm-only>` summary at the top of the section.
- **dilution** — marketing prose or navigation left in the middle of a real
  section. Wrap it in `<llm-exclude>`.

`<llm-only>` text is indexed, citable and shown to readers. It must be true,
publishable documentation, and it must **never address the model or contain an
instruction** — see docs-rag's hard content rule. The command refuses a block
that addresses the model, which catches the obvious shape and not the subtle
one: a sentence that is merely UNTRUE passes every mechanical check there is.

## Scope

An imported page has no route, so it cannot appear in the sidebar, and
`docpilot index` reports it as an **orphan page**. That is expected and is not a
defect to fix: it is retrievable under "All docs" — the default — and invisible
to a reader who has narrowed the scope to one section. Say so when the import is
meant to answer a question a narrowed reader would ask.

## Gates, in this order

```bash
npx docpilot index --dry    # chunking, duplicate ids, missing source:, dead internal links
npx vitepress build docs  # the site; it never sees the import directory
npx docpilot index          # writes the index
npx docpilot lint           # the golden set against the index it now measures
npx docpilot eval --gate-only
npx docpilot calibrate      # the index hash moved; the old calibration is stale
```

`eval` and `calibrate` embed with whatever `docPilot.embed` resolves to, so they
need the same key the build does — `.env.local` is where it goes, and both read
it through `loadEnv` exactly as the build does.

`eval --gate-only` is compared against the previous report. **A regression over
two percentage points on any metric is reverted** — the import is not special. If
the new page is meant to answer something, add two or three golden records for it
and run `npx docpilot lint`.

## Refresh

An imported page is a snapshot and drifts. To re-check one, re-fetch its
`source`, diff against the current file, and either update the text and
`importedAt` or leave it. The same gates apply — a refresh changes the corpus
hash exactly as an import does.

## Refusals

- A URL outside `docPilot.sources.allow` is not fetched. Say which origin would have
  to be added, and let the user decide.
- Third-party content is not mirrored onto this domain on the strength of "it is
  useful". The allowlist exists so that this question is answered once, in the
  config, rather than per page.
- Product behaviour is never invented to fill a gap in an imported page. That is
  docs-rag's `content gap`: no edit.
