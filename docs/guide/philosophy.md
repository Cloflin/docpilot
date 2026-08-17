# Project philosophy

## Nothing new to run

Retrieval happens in the reader's browser, against a static index built at deploy
time. There is no vector database, no search service, and no server beyond the
one already serving your site. The index is a build artefact rather than
infrastructure: identical input produces byte-identical output, so it diffs
cleanly, caches like every other asset, and can be committed or rebuilt in CI as
you prefer — see [Building the index](./indexing).

One server-side piece remains, and only one: a reverse proxy that attaches the
model key, because a key in a client bundle is a key you have published.
`npx docpilot doctor --proxy` prints its whole contract, and
[Production](./production) explains each rule.

## Refuse before the model is called

The gate is a relevance floor on the **retrieval** side. A question with no
support in the corpus costs zero model calls and produces zero generated text —
there is nothing to be wrong. Of the four stages that can end a turn, three end
it before any model is reached: the credential check, the social opener, and the
gate itself. See [How a turn works](/concepts/a-turn) for the order and
[The refusal gate](/concepts/the-gate) for the two channels it scores.

A refusal placed after generation is a refusal you have already paid for, in
tokens and in text that existed for a moment. Placing it first is what makes it
measurable.

## The host checks, not the prompt

Four properties hold for every answer, for every model, under every prompt —
including a prompt you have edited — because they are enforced by host code that
no message can reach: source links resolve to pages in the index, an empty
retrieval never reaches a model, the assistant is shown only chunks from the
active scope, and every citation shown corresponds to a chunk the host put in
front of the model during that turn.

The instruction is not one of these mechanisms. It is a request, and a model can
decline it. That is why the shipped prompt, the tool descriptions and the active
scope are all visible to the reader: what a prompt asks for should be legible,
and what the host guarantees should not depend on it. See
[What it guarantees](/concepts/guarantees).

## Measured, not chosen

The refusal thresholds are written by `npx docpilot calibrate` against your own
corpus and inlined into the manifest by `npx docpilot index`. **They do not
transfer between projects.** Until calibration has run, the gate uses provisional
values and every record says so, so a site shipping on someone else's numbers is
visible in a report rather than invisible in behaviour.

Defaults are held to the same standard. `maxIterations` is 2 because the cost of
a turn grows with the square of its steps, measured at 5.9k prompt tokens and
0.7k output against an 8192-token context. The full loop —
`index → calibrate → lint → eval → bench` — exists so that a claim about answer
quality has a number behind it. See
[Calibration and evaluation](./evaluation).

## Nothing dropped in silence

Extra suggestions, a `ui` value outside its enum, an `i18n` key that does not
exist, a sidebar link with no indexed content: each is applied or discarded, and
each is named on stdout when it is discarded. A silent cap reads as "covered
everything" when it did not, and the report that would have corrected the author
is the one that was never printed.

## A dependency must not be able to break your build

An empty environment produces a site that builds. The panel switches itself off,
one block names what is missing, and every other feature is untouched — a
dependency that can fail someone else's docs build on the day it lands is a
dependency they remove. Turning the same facts into a non-zero exit is opt-in and
lives in one command: `npx docpilot doctor`.

## Say plainly what it is not

It is a control against a weak, badly-behaved or injected **model**. It is not a
security boundary and cannot be one: everything runs in the reader's browser, the
corpus is a public website, and the model is one the reader could talk to
directly. Scope is focus, not containment.

The claims this project refuses to make are written down rather than left
implied — it does not "only answer from the documentation", citation is
provenance rather than entailment, and the gate cannot prevent an off-topic
answer. They are listed, with what is true instead, in
[What it guarantees](/concepts/guarantees#claims-this-documentation-will-not-make).
