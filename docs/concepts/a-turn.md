# How a turn works

A question passes five stages. Three of them can end it, and two of those three end it **before any model is called**.

## 1. The credential check

Synchronous, network-free, first. A question carrying a credential shape settles in the browser. See [Credentials in questions](/guide/credentials).

## 2. Retrieval and the gate

The question is embedded once, scored against every chunk in scope, and fused with a keyword pass. The gate combines two channels into one score and compares it to a calibrated threshold. Below it, the turn ends: no model call, no generated text, and the panel shows the closest pages instead of an answer.

See [The refusal gate](/concepts/the-gate).

## 3. The primed turn

Above the threshold, the host does something most retrieval loops do not: it puts the gate's own excerpts into the first message. The model starts with evidence rather than spending a step asking for it. Most turns therefore need one call, not two.

## 4. Tools, if the model wants more

`search_docs`, `fetch_section`, `list_pages`, and `answer`. Two properties matter more than the list:

**None of them accepts a path, a page set, or a scope.** There is no argument in which a wider scope could be expressed, so scope is not a rule the model is asked to follow.

**Observations are appended, never rewritten.** Step two's prompt is step one's prompt plus new results at the end. This is what keeps a provider-side prefix cache valid across the steps of a turn; rewriting the head to save tokens trades a small saving here for a much larger loss there.

An excerpt is spelled out once per turn. A chunk two searches both return carries its id and title the second time, without the body the model has already read.

## 5. Validation

The answer is checked before it renders:

- Citations are compared against the set of ids the **host** emitted this turn. An id the model invented is stripped, and its marker with it; surviving markers renumber.
- Links are checked against the page set in the token stream, before rendering. An invented route is de-linked and left as plain text.
- An answer with no surviving citations is not shown. It becomes a refusal — an uncited answer is exactly what the guardrail exists to withhold.

A low-confidence answer that **is** cited is kept and marked tentative. Confidence is the weakest signal in the system: a number the model writes about its own work. Deleting a checkable answer on that basis costs the whole turn and replaces something useful with a claim about the corpus that is not true.

## Conversation memory

Three question–answer pairs travel verbatim; earlier questions collapse into one line naming their subjects. Answers are truncated, and only turns that actually completed are carried — an empty assistant message is not a neutral placeholder, and two refused turns ahead of an answerable one were measured turning it into a refusal.

The summary line is built from prior **questions only**, never from answer text. A memory slot the model authors itself, outliving the window, is a multi-turn injection channel the gate cannot see.
