---
pageClass: wide-table
---

# How it compares

There are good hosted answer services for documentation, and this page is not
going to pretend otherwise. What it is going to do is name the **one
architectural difference** the rest of the differences fall out of, put the
products side by side on it, and then say plainly where the hosted services are
the better buy.

::: warning Checked August 2026 — verify before you quote it
Every column but the first describes somebody else's product, and products
move. Each is sourced at the [bottom of this page](#sources). Where a vendor
does not document something, this page says **not documented** rather than
guessing, and **not documented is not the same as "no"**.

**Prices are quoted from the vendor's own pricing page**, or marked
`not published` when there is nothing on it to quote. Exactly one figure on this
page comes from third parties and it is labelled where it appears — Mintlify's
Pro monthly price, because their pricing page renders the number as an animated
counter rather than as text.
:::

## The one difference

**DocPilot does retrieval in the reader's browser, against a static file you
built.** Every other product on this page does retrieval on a server — theirs,
or one you run for them.

That is not a small implementation detail, because six things follow from it:

- there is no index to keep in sync with a vendor, because the index is a file
  in your `public/` directory;
- an off-topic question can be settled for free, because the decision is
  arithmetic in the browser rather than a request somebody bills;
- reader questions reach exactly one third party — the model provider whose key
  you configured — instead of two;
- the thing you deploy is a static asset, so its failure mode is a 404 rather
  than an outage;
- the gate's thresholds can be measured against **your** corpus, because the
  gate is code you run;
- and it is MIT, so the answer to "what if you disappear" is that the file is
  still in your repository.

The cost side of that trade is real too, and it is in
[What DocPilot is worse at](#what-docpilot-is-worse-at).

## Price {#price}

### What each of them publishes

Quoted from the vendor's own pricing page, and where a vendor publishes no
figure this says **not published** rather than repeating one from a review site.

| | published price | what that figure is |
|---|---|---|
| **DocPilot** | **$0** | MIT. No vendor, no plan, no seat, no per-answer fee, and nothing in this project bills anything. The bill you do get is your model provider's — see [below](#and-what-0-does-not-cover). |
| **Algolia Ask AI** | **$0.50 per additional 1K search requests** (Grow) · **$1.75** (Grow Plus) · **$0.40 per additional 1K records** | The Algolia plan's overage rate, with 10K search requests and 50K–100K records included depending on plan; Elevate is contact-sales. **Ask AI is not line-itemed on the pricing page at all** — it rides on the plan those requests are metered against, plus an LLM key of your own, because it is bring-your-own-model. DocSearch stays free for qualifying public technical documentation, in exchange for keeping the "Search by Algolia" logo beside the results. |
| **kapa.ai** | **not published** | A 14-day trial on one index; Growth and Enterprise are both "Talk to us". Third parties report a platform fee plus answer volume, which is a shape rather than a price, so it is not repeated here as one. |
| **Inkeep** | **free, self-hosted** | The open-source core is "free forever" with community support. The managed Enterprise plan is not published — the page offers a demo booking instead. |
| **Mintlify AI** | **≈$0.23 an answer** past the included allowance | Two published numbers multiplied: an assistant response averages **23 credits**, and overage is **$0.01 per credit**. Pro includes **10,000 credits a month**; add-on bundles are 15,000/$145, 40,000/$370 and 90,000/$800. Starter is free and has **no AI features**. The Pro plan's own monthly figure is *reported* at $450 billed annually or $540 billed monthly — that one is third-party, because Mintlify's pricing page renders the number as an animated counter rather than as text. |
| **Orama** | **free, self-hosted** | OramaJS is Apache 2.0 and runs in the browser, on a server, or at the edge. Orama Cloud Pro is described as "a flat monthly price" with the amount not published; Zetta is contact-sales. |

### And what $0 does not cover {#and-what-0-does-not-cover}

DocPilot bills nothing and has no hosted half to bill from: no account, no
service, no telemetry — the only URL the panel fetches that this project
controls is your own index file. But the line is **free software**, not free
answers, and the project's own documentation opens its cost section with
[*"It is worth being clear about the price, because there is one."*](./why#what-it-costs)

- **A model provider key.** One key is the whole configuration, and it is yours,
  billed by them, at their rate. [Choosing providers](./providers).
- **Or the free tier, which is a real ceiling.** With nothing set, the chain
  falls through to OpenRouter's free tier: one key, no card — and **50 requests
  a day** under 10 credits bought. That meters **requests, not tokens**, and one
  turn is an embedding request plus two or three model calls, so fifty is a
  dozen-odd questions. [Living on the free tier](./free-tier).
- **Rebuilding the index draws on the same allowance.** A day spent answering
  questions is a day the index cannot be rebuilt.
- **The proxy route spends money per request** and is reachable by anyone who
  can load the page. A per-IP rate limit and a body cap are
  [part of shipping it](./production).
- **No support contract and no SLA.** It is an MIT package, and
  [that cuts both ways](#what-docpilot-is-worse-at).

### How the money is arranged

| | DocPilot | Algolia Ask AI | kapa.ai | Inkeep | Mintlify AI | Orama Cloud |
|---|---|---|---|---|---|---|
| **Paid to the vendor** | nothing — there is no vendor | your Algolia plan, metered on search requests and records indexed | platform fee plus answer volume, quoted | quoted; the self-hosted core is free | your Mintlify plan, plus AI credits per answer | your Orama plan; the OSS core is free |
| **Paid to a model provider** | yours, directly | yours, directly — Ask AI is bring-your-own-LLM | included in the platform fee | yours, directly | included in the credits | yours, directly |
| **Whose API key** | yours | yours | kapa's | yours | Mintlify's | yours, via Secure Proxy |
| **An off-topic question costs** | zero model calls and zero tokens — the gate refuses first | not documented | not documented | not documented | not documented | not documented |
| **Free path to a running panel** | yes — the provider chain falls through to OpenRouter's free tier, one key, no card | Algolia has a free plan; DocSearch is free for qualifying public technical docs | 14-day trial | free if you self-host | no — Starter has no AI | free with the OSS library and your own key |

**The row nobody else fills in is the off-topic one.** A support-deflection
widget answers a great many questions that were never about your product, and on
a per-answer contract you pay for each of them — at Mintlify's published rate,
roughly 23 cents each. [The refusal gate](/concepts/the-gate) is where that
decision is made, and `npx docpilot calibrate` is what measures it against your
corpus rather than someone else's.

## Architecture

| | DocPilot | Algolia Ask AI | kapa.ai | Inkeep | Mintlify AI | Orama Cloud |
|---|---|---|---|---|---|---|
| **Where retrieval runs** | the reader's browser | Algolia's cloud | kapa's cloud | their cloud, or your infra | Mintlify's cloud | Orama's cloud — or the browser, with the OSS library |
| **Index the reader downloads** | int8 vectors, one byte per dimension — 920 KB for this site's 460 chunks at 2048 dimensions | n/a — the index is theirs | n/a — the index is theirs | n/a — the index is theirs | n/a — the index is theirs | n/a, unless you ship an OSS bundle |
| **Retrieval model** | hybrid — BM25 over the chunk text and cosine over the vectors, fused by Reciprocal Rank Fusion | keyword; NeuralSearch is listed on Elevate | not documented | not documented | not documented | full-text, vector and hybrid |
| **Where the index lives** | a static file on the host already serving your site | an Algolia index | kapa's platform | their platform, or self-hosted | the Mintlify platform | Orama Cloud, or a bundle you ship |
| **Server you must run** | one reverse-proxy route that attaches the model key | none | none | none, unless you self-host | none | none — Secure Proxy fronts the model call |
| **Self-hostable** | there is nothing to host | no | no | yes — source-available, fair-code | no | yes — the OSS core is Apache 2.0 |
| **License** | MIT | proprietary SaaS | proprietary SaaS | fair-code core + managed plan | proprietary platform | Apache 2.0 core + managed cloud |
| **Works on a page that is not a docs site** | yes — a script tag is the whole requirement | yes — the DocSearch snippet is a script tag | yes — one JS snippet | yes | no — the assistant is part of the Mintlify docs platform | yes |
| **Index is a diffable build artefact** | yes — identical input, byte-identical output | no | no | not documented | no | ships as a bundle if you use the OSS library |

## What reaches the reader

This is the half that decides whether an answer is trustworthy, and it is the
half that is hardest to compare, because most vendors describe the *feature*
("grounded", "with citations") rather than the *mechanism*.

| | DocPilot | Algolia Ask AI | kapa.ai | Inkeep | Mintlify AI | Orama Cloud |
|---|---|---|---|---|---|---|
| **Refusal decided before the model is called** | yes — a calibrated relevance floor on the retrieval side | not documented | not documented | not documented | not documented | not documented |
| **Refusal threshold measured against your corpus** | yes — `npx docpilot calibrate`, and until it runs every record says the values are provisional | not documented | not documented | not documented | not documented | not documented |
| **Sources shown with the answer** | yes | yes | yes | yes | yes | yes |
| **Every citation checked against what the host retrieved that turn** | yes, by host code no message can reach | not documented | not documented | not documented | not documented | not documented |
| **Invented links removed before render** | yes — de-linked in the markdown-it token stream | not documented | not documented | not documented | not documented | not documented |
| **A/B two retrieval configurations offline** | yes — `npx docpilot bench`, no API key needed | not documented | not documented | not documented | not documented | not documented |
| **Sweep the retrieval levers against a golden set** | yes — `npx docpilot tune` | not documented | not documented | not documented | not documented | not documented |

The four guarantees, in the exact words the README and the reference also use,
are in [What it guarantees](/concepts/guarantees) — including the paragraph
saying what they are **not**, which is a security boundary.

## The chat itself

Every product here renders a chat. What differs is how much of it is yours.

| | DocPilot | hosted answer services |
|---|---|---|
| **Scope the question to a page or a section** | yes — a picker in the composer, with a filterable page list | not documented |
| **Select a passage on the page and ask about it** | yes | not documented |
| **Show the model's own instruction to the reader** | yes — `prompt.show`, including the tool definitions | no |
| **Let the reader add their own instruction for a turn** | yes — `prompt.allowAppend`, never merged into the system prompt | no |
| **Conversation history** | in the reader's own `localStorage`; nothing is sent anywhere | typically vendor-side, and therefore also an analytics surface |
| **Reader feedback** | posted to an endpoint **you** own, or kept on the device | vendor dashboard |
| **Reader-facing strings replaceable** | all 171 of them, one at a time, in 25 groups | vendor's locales |
| **Question containing an API key** | redacted in the browser, before the embedding call | not documented |

Everything in that first column is described, one feature at a time, in
[The assistant panel](/guide/panel).

## What DocPilot is worse at

A comparison page that ends with the author winning every row is a comparison
page nobody should believe. These are the reasons to buy one of the others.

**It indexes what you can put in a directory.** Markdown, OpenAPI, and
[imported pages](/guide/imported-pages) you allowlist one URL at a time. kapa.ai
connects to fifty-odd source types — GitHub, Slack, Discord, Zendesk,
Confluence, PDFs, YouTube — and that is a genuinely different product. If your
answers need to come from three years of support tickets, this is not the tool.

**The reader downloads the index.** Small for a documentation site, and worth
measuring before it is not; a server-side index costs the reader nothing but the
question. The numbers, and the scale at which they stop working, are in
[Building the index](/guide/indexing#vectors-are-quantised).

**Nobody is tuning it for you.** Calibration, the golden set, the evals — that
loop is yours to run, and it is the half that gets skipped. A hosted service
does it as part of the fee, and for a team with no time for it, being tuned by
someone who has not read your docs beats not being tuned at all.

**There is no analytics dashboard.** DocPilot collects nothing, which is the
same sentence as: DocPilot shows you nothing. What readers asked, and what got
refused, reaches you only if you stand up a `feedbackEndpoint` and read it
yourself.

**No support contract, no SLA, no roadmap you can buy into.** It is an MIT
package. That cuts both ways and this page will not pretend it only cuts one.

**It will not answer about the page it is mounted on** unless that page is in
the corpus. This surprises people, so it is stated on its own page:
[Where it can go](/guide/where-it-goes).

## Choosing

- **Your docs are markdown in a repository, and you want the answer machinery to
  be auditable and free.** DocPilot.
- **You already pay Algolia and DocSearch is already on the site.** Ask AI is a
  snippet away, it is bring-your-own-LLM, and the index it answers from is the
  one you already maintain. That is a very short path.
- **Your corpus is Slack, Zendesk, GitHub issues and four wikis.** kapa.ai or
  Inkeep. The connector inventory is the product.
- **Your docs are on Mintlify.** The assistant is already there.
- **You want the search and the answers from one open-source engine and are
  happy to build the panel around it.** Orama.
- **You need something none of the above does, and have a team for it.**
  Roll your own — and read [Why DocPilot](/guide/why), which is a list of the
  decisions you are about to make.

## Sources {#sources}

Checked August 2026.

- Algolia — [Ask AI](https://www.algolia.com/doc/guides/algolia-ai/askai),
  [product page](https://www.algolia.com/products/ai/ask-ai),
  [pricing](https://www.algolia.com/pricing),
  [DocSearch](https://docsearch.algolia.com/),
  [who can apply](https://docsearch.algolia.com/docs/who-can-apply/)
- kapa.ai — [pricing](https://www.kapa.ai/pricing),
  [documentation](https://docs.kapa.ai/)
- Inkeep — [pricing](https://docs.inkeep.com/pricing),
  [overview](https://docs.inkeep.com/overview),
  [source](https://github.com/inkeep/agents)
- Mintlify — [pricing](https://mintlify.com/pricing),
  [credit pricing](https://www.mintlify.com/docs/credits) — the 23-credit
  average and the $0.01 overage both come from this page
- Orama — [pricing](https://orama.com/pricing),
  [answer engine](https://docs.orama.com/cloud/answer-engine/),
  [source](https://github.com/oramasearch/orama)

DocPilot's own column is not sourced to a marketing page; every claim in it is
either a documented setting, a measured artefact of this site's own index, or
one of the four [guarantees](/concepts/guarantees), each of which is covered by
a test in this repository. The index figures — 460 chunks, 2048 dimensions,
920 KB of int8 vectors, under 0.003 mean |Δcos| — describe the files this page
is served alongside and can be checked with `ls -l docs/public/rag/`.
