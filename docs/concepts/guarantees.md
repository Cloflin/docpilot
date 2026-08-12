# What it guarantees

Four things are true of every answer, for every model, under every prompt — including a prompt you have edited. They are enforced by host code that no message can reach, and each is covered by a test.

**Every source link points at a page that exists in the index.** Enforced in the markdown-it token stream, on a normalised path compared by set membership, before anything is rendered. An invented route is de-linked and left as plain text.

**When retrieval finds nothing above the threshold, no answer is generated, because the model is never called.** There is no text to be wrong.

**The assistant is shown only chunks from the active scope** — through priming, search, fetch, listing and section expansion alike. The tools carry no argument in which a wider scope could be expressed, and an id enters the citable set only after the scope filter has run.

**Every citation shown corresponds to a chunk the host itself put in front of the model during that turn**, checked against a set the host maintains — never by searching the text of what the model was sent.

Three further things are true of the product rather than of an answer: the instruction, the tool descriptions and the active scope are visible to the reader; a reader's own added instruction is delivered as a separate user message and can reach none of the four mechanisms above; and a hallucinated-citation rate of zero is a hard gate on every evaluation run.

## What this is not

It is a control against a weak, badly-behaved or injected **model** — a small model inventing an id, emitting malformed arguments, or drifting after four steps.

**It is not a security boundary and cannot be one.** Everything runs in the reader's browser, the corpus is a public website, the model is the reader's own, and no answer triggers any server-side action. A reader who wants an out-of-scope answer gets one faster by talking to the model directly than by attacking anything here. The scope has a one-click widen affordance precisely because a fence the reader can open is honest, while one they cannot is a support ticket.

**Scope is focus, not containment.**

## Claims this documentation will not make

**"It only answers from the documentation."** It answers **with** documentation in context. The generated text can contain anything the model knows.

**"Answers are grounded in their cited sources."** Citation is provenance, not entailment. An answer can cite a genuinely retrieved chunk that does not support the claim, and that passes every mechanism above.

**"It cannot be taken off-topic."** The gate is a relevance floor, not an entailment check.

**"Scope limits what the assistant knows."** It limits what the assistant is **shown**. The model's parameters do not shrink.

**"Prompt injection is prevented."** Text arriving inside your documentation reaches the model as data, and neither the gate nor the validator inspects it. The durable control is review of the pull request that would introduce it.

**"The thresholds are tuned."** Until `npx ask-ai calibrate` has run against your own index, they are provisional and every record says so.

Nothing here may be phrased as protection **against the reader**, because it cannot be kept — and stating it invites the one attack that has no defence and no victim.

Everything above is written so that it never contradicts the one claim that is unconditionally true, and rendered under the composer: **AI-generated. Check the linked pages.**
