# Where it can go

The panel is a Vue app that mounts into a `<div>`. Anything that can load a
stylesheet and a script can carry it — a docs site, a landing page, a pricing
page, a help centre, a blog, an app you already ship. That is not a claim about
frameworks. It is a claim about the page, and the condition is exactly as small
as it sounds.

What it will **not** do is answer about the page it is sitting on. That is the
one thing about DocPilot that surprises people, so it is worth saying plainly:
the panel answers from **the corpus you built** and from nothing else. Mounted on
a pricing page it will answer a question about your API and refuse a question
about your pricing — unless your pricing is in the corpus.

## The two halves, again

[Installing](/install/) opens with them, and between them they are the whole of
what "anywhere" means.

**The index does not need a site.** `npx docpilot index` reads a
`docpilot.config.mjs` and walks the markdown under `docsDir`. It has no opinion
about what serves those pages, or about whether anything serves them at all.

**The panel needs a page.** One `mountDocPilot()` call, or a `<script>` tag, or
one of the framework adapters. Everything else it works out for itself:

| what | where it comes from when you say nothing |
|---|---|
| the route | `location.pathname` |
| the language | `<html lang>` |
| navigation | a full page load, unless you pass a `router` |
| the article element | `main` |
| the focus target when the panel closes | `main` |

So the smallest real installation on a page that is not a documentation site is
two tags and one call — [Web](/install/web) has both, and
[JavaScript](/install/javascript) has the bundler version.

## The one thing with no default

[`host.search`](/reference/config#host) — your site's own search button, which
the panel offers as the thing to do instead when it degrades or errors. There is
no selector every site agrees on, so **without one the affordance is simply not
rendered**. A button that clicks nothing is worse than no button. Pass a selector
if your page has a search control, and leave it out if it does not; nothing else
about the panel changes either way.

## Getting the page's own content into the corpus

The honest answer to "can it answer about my pricing page" is: only if the
pricing page is in the corpus. There are two ways in.

**Write it as markdown.** `docsDir` is a directory of markdown files and nothing
requires those files to be pages of a documentation site. A `content/pricing.md`
that your marketing site renders is a page of the corpus like any other — as long
as the route the indexer derives from its path is the URL you actually serve.
That rule, and the way it breaks, is in
[Building the index](/guide/indexing).

**Import it.** `npx docpilot import <url>` turns an allowlisted URL into a page
of the corpus, and `importDir` can point outside your docs entirely — so the
assistant answers from pages that have no markdown anywhere in your repository
and cites the original. See [Imported pages](/guide/imported-pages).

## Set `product`

On a site that is not a documentation site, set it. Left unset, the assistant
introduces itself as the assistant for "this documentation", and the same phrase
appears in the composer placeholder and in its own system instruction. That is
correct on a docs site and wrong on a pricing page. One string, three places:
[`product`](/reference/config#product).

## Where to go next

- One page, no bundler — [Web](/install/web).
- A bundler you already have — [JavaScript](/install/javascript).
- A framework with an adapter — [Which entry point](/install/).
- A host nothing here covers — [A host of your own](/guide/other-sites).
- What the panel promises wherever it is —
  [What it guarantees](/concepts/guarantees).
