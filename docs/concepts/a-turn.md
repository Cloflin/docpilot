# How a turn works

A question passes six stages. Four of them can end it, and three of those four end it **before any model is called**.

## 1. The credential check

Synchronous, network-free, first. A question carrying a credential shape settles in the browser. See [Credentials in questions](/guide/credentials).

## 2. Is it a question at all?

"Hello" carries no documented subject, so the gate below would score it at zero and refuse it — a correct verdict that tells the reader, on their very first message, that the assistant is broken.

So a greeting, a thank-you, a farewell and "who are you" are recognised here and answered from a template, with no model call. Only an input that is social **and nothing else** is claimed; "hi, how do I authenticate?" carries a subject and takes the normal path. See [Social openers](/guide/social-openers).

It runs after the credential check, so a greeting with a key pasted into it is still handled as a key.

## 3. Retrieval and the gate

The question is embedded once, scored against every chunk in scope, and fused with a keyword pass. The gate combines two channels into one score and compares it to a calibrated threshold. Below it, the turn ends: no model call, no generated text, and the panel shows the closest pages instead of an answer.

**Retrieval is hybrid, and both halves always run.** A BM25 pass over the chunk text — MiniSearch, over the text, the title and the breadcrumb, with the title weighted — and a cosine pass over the int8 vectors produce two ranked lists, and the two are merged by **Reciprocal Rank Fusion**: each list contributes `1 / (k + rank)` to every id it names, and the sums are sorted. Ranks, not scores, which is what lets two channels with incomparable units vote in the same election. The fused pool is then re-ranked by dense cosine before the gate sees it.

With no embedder configured, or with one that cannot be reached, the dense list is simply empty: BM25 runs alone and the gate switches to its lexical threshold. That is a mode, not a failure — but it is an expensive one, and [what it costs in recall](/guide/providers#no-embedder-at-all) is measured rather than guessed.

::: tip Two numbers that look alike and are not
The fusion weights both channels **equally**. The `wDense: 0.75 / wLexical: 0.25` you will find in the manifest are the **gate's** weights, not the fusion's — a different stage, scoring a different thing. [The refusal gate](/concepts/the-gate) is that stage.
:::

See [The refusal gate](/concepts/the-gate).

## 4. The primed turn

Above the threshold, the host does something most retrieval loops do not: it puts the gate's own excerpts into the first message. The model starts with evidence rather than spending a step asking for it. Most turns therefore need one call, not two.

When that call does not come back, [the answer ladder](/concepts/the-ladder) is what happens next: every other service the environment selected is asked in turn, and a turn where none of them answers settles as the passages retrieval already found rather than as an apology for them.

## 5. Tools, if the model wants more

`search_docs`, `fetch_section`, `expand_section`, `list_pages`, and `answer`. Two properties matter more than the list:

**None of them accepts a path, a page set, or a scope.** There is no argument in which a wider scope could be expressed, so scope is not a rule the model is asked to follow.

`expand_section` is the one that exists for a shape of failure rather than for a capability: an answer that begins at the end of one section and finishes at the start of the next. It takes an id the model already has and returns the section immediately before or after it, on the same page. Two per turn — enough to cross a boundary in either direction, not enough to read a page a chunk at a time — and it always costs a step, because a free one is a walk with nothing to stop it.

**Observations are appended, never rewritten.** Step two's prompt is step one's prompt plus new results at the end. This is what keeps a provider-side prefix cache valid across the steps of a turn; rewriting the head to save tokens trades a small saving here for a much larger loss there.

An excerpt is spelled out once per turn. A chunk two searches both return carries its id and title the second time, without the body the model has already read.

## 6. Validation

The answer is checked before it renders:

- Citations are compared against the set of ids the **host** emitted this turn. An id the model invented is stripped, and its marker with it; surviving markers renumber.
- Links are checked against the page set in the token stream, before rendering. An invented route is de-linked and left as plain text.
- An answer with no surviving citations is not shown. It becomes a refusal — an uncited answer is exactly what the guardrail exists to withhold.

A low-confidence answer that **is** cited is kept and marked tentative. Confidence is the weakest signal in the system: a number the model writes about its own work. Deleting a checkable answer on that basis costs the whole turn and replaces something useful with a claim about the corpus that is not true.

## Conversation memory

Three question–answer pairs travel: the questions verbatim, the answers condensed to their skeleton — the opening sentence, then the leading line of every block after it, never a cut inside a code fence — within a cap of 360 characters rather than the 300 a plain prefix was cut at. Condensing changes which characters travel, not how long the model's own text survives. Earlier questions collapse into one line naming their subjects, and only turns that actually completed are carried — an empty assistant message is not a neutral placeholder, and two refused turns ahead of an answerable one were measured turning it into a refusal.

The summary line is built from prior **questions only**, never from answer text. A memory slot the model authors itself, outliving the window, is a multi-turn injection channel the gate cannot see.

The gate keeps the same rule one step earlier. Its [composed channel](/concepts/the-gate#follow-ups) composes the follow-up against the last question that was **answered**, not the last one that was asked — and, when that turn was itself an ellipsis the composed channel rescued, against the question it followed as well. A refused turn is a question this corpus retrieved nothing for, and putting it in front of the follow-up anchors the one channel that could have recovered the turn to a known dead end. That is the same turn the window above drops, measured for the same reason.

Condensing is why a reader can **quote**: a skeleton names what an answer was about and carries none of its wording, so a passage from the middle of a long answer is still not in context verbatim. Select a passage in an answer and it is attached to the next question as its own field — labelled as quoted text rather than as an instruction, and carried with that question one turn later, clamped shorter. Without it, a question about the fourth paragraph of a long answer arrives with that paragraph nowhere in context.
