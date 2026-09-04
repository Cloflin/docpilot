---
description: What the site owner pays per question and per reader, what the reader gets for it, and which of the two numbers is worth watching.
---

# What it costs

Two people pay for an answer, and they pay in different currencies. You pay
requests, tokens and bandwidth. Your reader pays attention — and gets back
something they can check.

This page is the arithmetic behind both, with every figure read off this site's
own index and this project's own defaults rather than estimated.

## What a reader downloads

Retrieval runs in the reader's browser, so the corpus has to get there. Opening
the panel fetches the index once and caches it:

| | |
| --- | --- |
| the vectors | **870 KB for this site's 580 chunks at 1536 dimensions** |
| the chunk text, titles and breadcrumbs | the rest of the same directory |
| when | on the reader's **first open of the panel**, not on page load |

The vectors are `int8`, one byte per dimension, which is what keeps that number
in kilobytes: at `float32` the same blob would be 3.4 MB. A reader who never
opens the panel downloads none of it at all.

That is the cost nobody budgets for and the one that scales with your corpus
rather than with your traffic. It is worth knowing before you index a thousand
pages.

## What a question costs you

A turn is one embedding request plus one or more model calls:

| | requests |
| --- | --- |
| one-shot turn | 1 embed + **1** model call |
| agentic turn | 1 embed + **2–3** model calls, plus any the pool rotates through |

Measured at the shipped [`maxIterations: 2`](/reference/config#maxiterations)
with an 8192-token context: **5.9k prompt tokens and 0.7k output per turn.**

A follow-up costs no more than a first question. It is scored on two queries —
itself, and itself glued to what it follows — and both texts ride a single
embedding request rather than buying a vector each. The same holds when the
antecedent reaches two turns back, which is what keeps *and on Docusaurus?* from
retrieving nothing.

## Where the money actually goes

At the model, not at the retriever. One query embedding is about ten tokens and
**212 ms**, on the order of a dollar a year at ten thousand questions a day; the
corpus embedding is a build cost paid once, and a
[content-addressed cache](/guide/indexing) means editing one page re-embeds that
page rather than the corpus.

Measured on the rebuild that added this very page: of 580 chunks, 561 vectors
came back from the cache and **19 were bought** — one batched request. The
[empty-state openers](/guide/social-openers) cost nothing at all that build,
because their answers were written by hand and the questions had not changed.

So when you multiply anything by your provider's price list, multiply the 5.9k
and the 0.7k. Everything else on this page is rounding.

## What you are not paying for

There is no server. No vector database, no ingestion queue, no retrieval service,
nothing to keep warm and nothing to page anybody about at three in the morning.
The index is a static directory beside your HTML, and the only backend a
production deployment needs is a proxy that attaches your API key — plus an
endpoint of your own if you want to collect [votes](/guide/evaluation).

That absence is most of the economics. It is why the numbers above are the whole
bill and not the visible part of one.

## What the reader gets for it

**An answer they can check.** Every citation marker resolves to a chunk this host
put in front of the model on that turn, verified against a set the host keeps —
an id the model invented is stripped, a link to a route that is not in the index
is de-linked, and an answer with no surviving citations is not shown at all. See
[what it guarantees](/concepts/guarantees).

**Their own language over your corpus.** The dense channel is not a ranking
refinement, it is the entire cross-language capability: a reader typing Russian
at English documentation has no keyword overlap to fall back on, and
[without an embedder](/guide/providers#no-embedder-at-all) that reader is refused
outright.

**A conversation that stays a conversation.** A follow-up is composed against the
question it follows, and against the one *that* followed when it was itself an
ellipsis — so a chain of *and on React?*, *and on Docusaurus?* keeps its subject.
The turn is primed with the sections the previous answer cited, including in a
thread reopened from the archive. Measured on this site's own corpus, reaching
the second hop moves recall@8 from 0.750 to 0.900 on the questions that need it
and leaves every other question untouched.

**Nothing of theirs leaves the browser.** Conversations live in the reader's own
`localStorage` — twenty of them, capped at 512 KB — and are never sent anywhere.
The one thing that travels is a vote, and only when you have configured an
endpoint for it. See [conversation history](/guide/history).

**Answers, not spinners.** The search itself is local, so the only network the
reader waits on is the embedding and the model.

## What raises the bill

- **`maxIterations`.** Every accumulated observation is re-sent on every step, so
  a turn's cost grows with the square of its steps. At 20 the worst case is
  roughly 138k tokens for one question.
- **A pool that rotates.** A model that refuses, returns nothing, or times out
  costs its request anyway, and the next member is tried.
- **An off-topic question.** [`guard.mode`](/reference/config#guard-mode-guard-supportminidentifiers) ships
  as `'off'`, because no single threshold survives every language a site's
  readers type in — so today an unanswerable question still spends a request
  finding out. Calibrate a threshold for your corpus and set `'calibrated'`, and
  it costs zero model calls instead.

## The one number to watch

On a free tier the constraint is **requests, not tokens**, and the daily
allowance is shared by every reader of your site rather than held per person.
DocPilot rations it for you rather than failing at the end of the day: below
fifteen remaining a turn collapses to a single call, below six the pool stops
rotating, and the reader is told when answers resume rather than shown a generic
error. [Living on the free tier](/guide/free-tier) is the whole of that
arithmetic.

If you take one thing from this page: the bandwidth scales with your corpus, the
token bill scales with your traffic, and the daily cap is the only one of the
three that can stop the panel working for everybody at once.
