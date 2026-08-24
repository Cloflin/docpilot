# Why DocPilot

## The problem

Documentation search returns a list of links and leaves the reading to the
reader. An answer assistant returns a paragraph that reads like an answer — and
when the paragraph is wrong, nothing on screen says so. The two failures are not
symmetric: a search result that misses is an inconvenience, a confident answer
that misses is a support ticket written in your own voice.

What a documentation site needs sits between them. An answer the reader can
check, because every claim in it carries a link to the page it came from. And a
refusal that happens before there is any text to be wrong about.

## Why not a hosted answer service

Because it is another service, another index, and another copy of your corpus,
billed per question — including every question that should never have been
answered. Reader questions leave for a third party, and a threshold you cannot
see is tuned by someone who has not read your docs.

None of that is required by the work. The corpus is a public website; retrieval
against it is arithmetic over an array of floats, and a browser does arithmetic.
The only step that genuinely needs a network is the model call, and that one goes
through a proxy you own.

## Why not a vector database

Because the index is a build artefact, not infrastructure. It is written by
`npx docpilot index`, it is deterministic — identical input, byte-identical
output — and it is served as static files by the host already serving your site.
Vectors are quantised to eight bits and sharded, so a corpus the size of a real
documentation set is a download rather than a deployment; the numbers, and the
scale at which they stop working, are in
[Building the index](./indexing#vectors-are-quantised).

A database would add an availability requirement to a static site. The failure
mode of a missing file is one that every static host already handles.

## Why the gate sits on the retrieval side

A model asked to refuse is a model that has already been paid for, and its
refusal is a sentence it chose to write. Put the same decision in front of the
model and it becomes a number: how far the best in-scope chunk stands out, and
what share of the question's rarest terms actually appear in the retrieved text.

That number can be calibrated against your corpus, swept, reported, and moved
deliberately. A prompt asking for caution can be none of those things. It is also
what makes an off-topic question free — no call, no tokens, no generated text —
and what lets the panel offer the closest pages instead of an apology. See
[The refusal gate](/concepts/the-gate).

## Why citations are checked by the host

A model asked to cite its sources can invent an id, and the answer that results
looks exactly like one that did not. So the host keeps the set of chunk ids it
put in front of the model during that turn, and every citation is checked against
that set — never by searching the text of what the model was sent, which would
accept anything the model happened to echo back.

The same rule covers links: an invented route is de-linked in the markdown-it
token stream and left as plain text, before anything renders. An answer with no
surviving citations is not shown at all. See
[How a turn works](/concepts/a-turn).

## What it costs

It is worth being clear about the price, because there is one.

**You need an embedding model**, unless you declare that you do not. The default
`embed: 'auto'` uses the chat provider's own embedder, and borrows OpenRouter's
free embedding pool when the chat provider has no embeddings endpoint; an object
names a second provider explicitly. The third arm is
[`embed: false`](/reference/config#embed-false) — no embedder, no vectors in the
index, retrieval by BM25 over the chunk text alone.

That third arm has a price, and every build under it prints the price: measured on a 1191-chunk corpus, recall@8 fell from 0.97 to 0.41, retrieval F1
from 0.35 to 0.18, and 11 of 44 answerable questions were refused outright. A
question asked in a language the corpus is not written in scores **zero** on the
lexical channel, because there is no overlap to count.

On the two arms that have an embedder, the model that built the index is the
model every query must be embedded with. A mismatch degrades retrieval to keyword matching,
silently. The index records which embedder it was built for so the mismatch is
caught rather than suffered — see
[Choosing providers](./providers).

**The index is bytes the reader downloads.** Small for a normal documentation
site, and worth measuring before it is not.

**Calibration is not optional.** Thresholds are a statement about one corpus.
Shipping the provisional ones means shipping a gate that was measured somewhere
else.

**It is not a security boundary**, and this documentation will not describe it as
one. What it does guarantee, and what it explicitly does not, is
[written down in full](/concepts/guarantees).

Convinced? [Getting started](./) takes about ten minutes.
