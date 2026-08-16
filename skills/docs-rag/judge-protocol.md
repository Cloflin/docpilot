# Judge protocol — `answer-bench` blind pairwise

Given verbatim to the judging agent. Checked in for the same reason as
[answerer-protocol.md](./answerer-protocol.md): a rubric that lives in a chat
message is a rubric nobody can reproduce.

**This judge is advisory and may never gate.** ``metrics.js`` is pure and
deterministic by contract, and it alone decides whether a change ships. What the
judge adds is the one thing token-F1 cannot see — whether an answer is actually
supported by the excerpts it cites. A verdict that contradicts the deterministic
metrics is a finding to investigate, not an override.

---

You are comparing two answers to the same documentation question. You do not
know which system produced which; the sides are shuffled per record and the key
is withheld from you. Do not guess at it, and do not let a house style you think
you recognise decide the verdict.

**Input.** `PACKET_FILE` is JSONL. Each line:

- `id` — echo it back.
- `question` — what the reader asked.
- `left` / `right` — each `{answer, citations, excerpts}`. **The two sides were
  given different excerpts**; that difference is the thing under test, so judge
  each answer against **its own** `excerpts` array, never against the other's.

**Output.** Write `OUT_FILE` as JSONL, one line per packet, in input order:

```json
{"id":"q-31","better":"left","reason":"…","left_ungrounded":false,"right_ungrounded":true}
```

- `better` — `"left"`, `"right"` or `"tie"`.
- `reason` — one sentence, concrete. Name the claim or the citation that decided
  it, not a general impression.
- `left_ungrounded` / `right_ungrounded` — `true` when that answer states
  something its own excerpts do not support, or cites an id whose text does not
  contain the claim the marker is attached to.

**How to decide, in priority order.** Stop at the first criterion that separates
the two:

1. **Groundedness.** An answer containing a claim its excerpts do not support
   loses, however well written. A confident invented method name, parameter or
   route is the worst outcome in this system and outweighs everything below.
2. **Citation honesty.** Markers must point at excerpts that actually carry the
   claim. A correct answer with markers stapled on arbitrarily loses to a
   slightly thinner answer whose markers hold up.
3. **Answering the question asked.** Not the adjacent question the excerpts
   happen to be about.
4. **Completeness within the evidence.** Did it use what it was given — the
   parameter list, the required fields, the enum values — or stop at the first
   sentence that looked like an answer?
5. **Usability for an integrator.** Concrete names, correct language, no padding.

**Ties are a real verdict.** Use `"tie"` when the two are equivalent on every
criterion above; a forced preference on noise is worse than an honest tie.

**Length is not quality.** The longer answer wins only if the extra length is
grounded content the question needed.

**Binding rules.**

1. **Only the excerpts in the packet.** Your own knowledge of this product does
   not count and must not decide a verdict.
2. **One line of JSON per packet, and nothing else in the file.**
3. **Do not read any other file** and do not search the repository — in
   particular not `the golden set (`docpilot/golden.jsonl`)` (reference answers) or any `*.key.jsonl`
   (the side assignment). Either would invalidate the run.
4. **Do not skip a packet.**
