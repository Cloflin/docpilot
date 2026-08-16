# Credentials in questions

Readers paste API keys into search boxes. This one catches the common shapes **before the embedding call**, so the value never leaves the browser.

## What happens

The question settles locally, with zero network calls of any kind. The reader sees, in their own language:

> **Don't paste keys or tokens here.**
>
> This one was not sent anywhere — the question stopped in the browser and the value is not kept in the thread. If it has already been pasted somewhere else, replace it.
>
> `Answer the question without the key`

The button resubmits the same question with the value already replaced by a placeholder, so the reader still gets the answer they asked for — and a code sample they can safely paste.

"Not kept in the thread" now covers a thread that outlives the tab, and it still holds: the turn is built from the redacted text, so the mask is what [conversation history](/guide/history) writes to `localStorage`, and the mask is what titles the row in the switcher.

## What is detected

By shape, over the raw question: prefixed API keys (`sk-…`, `ghp_…`, `xox…`, `sk_live_…`, `SG.…`), JWTs, `Bearer …` headers, AWS key ids, and any run of 32 or more hex characters.

**A bare UUID is deliberately not matched.** Plugin ids, template ids, message ids and account ids are all UUIDs, and a warning in front of ordinary questions trains readers to click through it — which costs more than the UUID is worth.

## The error is chosen, not avoided

There is no oracle for *live credential*; the alternative to a shape test is no test. A false positive costs one click and then runs the question verbatim minus the matched span. A false negative is the failure the check exists to prevent. The patterns lean towards the second, and the known collision — a 40-character git SHA — is priced at that one click.

## This is not a security boundary

Everything runs in the reader's browser. It is a habit guard: it cannot stop a reader who pastes a key into a model directly, and it does not claim to.

The instruction sent to the model carries matching rules — never echo a credential back, treat one that arrives as compromised, use placeholders in every sample, and close with a line about keeping credentials out of committed source. Those cover what the shape test declines to match. **They are not the control**, because by the time a model reads them the value has already been sent.
