# 048 — One instruction for every turn

> **Кратко.** Системное сообщение собиралось из правил, в которые вклеивались
> название продукта и область поиска, поэтому его начало менялось от сайта к сайту
> и от хода к ходу, и кэш провайдера не мог его переиспользовать; правило отказа
> повторялось трижды, а фрагменты документации шли JSON-строками с экранированным
> кодом. Теперь сообщение открывается одной неизменной константой `CORE` с
> разделами в XML-тегах и рабочим примером цитирования; всё, что относится к
> вопросу, едет в последнем сообщении пользователя в своих тегах, а результаты
> инструментов — блоками `<tool_result>` с `<document id="…">`. A/B на
> golden-наборе (`qwen3:8b`, две пары прогонов): ответов без ссылки в тексте
> стало 2 из 66 вместо 41,5, но answerF1 и citationPrecision упали больше чем на
> одну запись, а треть ходов тратит лишний запрос — гейт релиза 2.2.0 не пройден,
> промпт не принят. Причина лишнего запроса найдена, следующий кандидат назван в
> разделе Measured.
>
> **Решение владельца, 2026-11-02:** несмотря на этот вердикт, промпт входит в 2.2.0;
> см. раздел «Decision for 2.2.0» в конце.

## Problem

Read at `db1e64c`, `src/theme/docpilot/prompt.ts`:

1. **The prefix moved.** The first sentence held `docPilot.product` (`:142`), so
   the system message differed per site. `systemText` placed the scope block
   (`:982`) between the instruction and the host blocks, so a narrowed search
   rewrote the middle of the system message. Both providers cache an exact
   prefix only (Anthropic: `tools → system → messages`, "100 percent identical";
   OpenAI: the whole rendered prefix, 1,024 tokens minimum), so nothing after the
   first changed byte could be reused.
2. **Rules were said more than once.** `confidence 0` closed three separate
   bullets (`:144-146`). The answer language was a core bullet (`:150`) and the
   per-turn directive as well. OpenAI's GPT-5 guide: "contradictory or vague
   instructions can be more damaging to GPT-5 than to other models".
3. **The question had no boundary.** A quote ran into the question with one
   sentence and a blank line between them (`:1155`), and the language line sat in
   front of the question.
4. **Documents were JSON strings** (`:1161`, `:1168`): a code sample reached the
   model as one line of `\n` and `\"`, and an identifier had to be unescaped to be
   copied. The rule that names them said "JSON documents" and "a "text" value"
   (`:439`).
5. **Measured on the shipped prompt.** `qwen3:8b` on `rag-local`
   (`docpilot/baselines/2.1.1.rag-local.answers.json`): 38 of 66 positive answers
   shown with sources had no working `[n]` in the text — `unlinked` 0.576, and the
   039 hard gate fails on every run.

## Research

Looked up on 2026-11-02 (the providers' own pages, and Qwen's and Ollama's docs):

| source | what it says that this spec uses |
|---|---|
| Anthropic, prompting best practices | XML tags "help Claude parse complex prompts unambiguously"; nest documents in `<documents>`/`<document>`; a role in the system prompt; examples are "one of the most reliable ways to steer Claude's output format"; give the reason for a rule — "Claude can generalize from the explanation"; drop "CRITICAL / MUST" language |
| Anthropic, long context | for 20k+ tokens, documents above the query ("up to 30 percent"); each document with its metadata in tags |
| Anthropic, prompt caching | cache order `tools → system → messages`; a change invalidates that level and every later one; minimum 512–4,096 tokens by model |
| OpenAI, GPT-5 guide | structured XML-style specs "improved instruction adherence" (Cursor); resolve instruction-hierarchy conflicts; disambiguate tool instructions |
| OpenAI, GPT-4.1 guide | sections in the order role → instructions → output format → examples → context; for documents, XML and `ID \| TITLE \| CONTENT` "performed well", "JSON performed particularly poorly"; XML-heavy documents weaken an XML delimiter; a later instruction wins a conflict |
| OpenAI, prompt caching | "Put stable developer instructions and shared reference material first"; dynamic content at the end; tool definitions are part of the prefix |
| Qwen3 function calling | Hermes-style tools, results in the `tool` role; "It is not guaranteed that the model generation will always follow the protocol" |
| Ollama structured outputs | "It is ideal to also pass the JSON schema as a string in the prompt to ground the model's response" |

One format serves all three families: XML-style section tags in plain text.
Claude and GPT read them natively, Qwen's own template is built from tags
(`<tools>`, `<tool_call>`, `<tool_response>`), and a tag gives a small model a
boundary it cannot misread.

The long-context rule (documents above the question) is not adopted. A turn is
about 4k tokens, far under the 20k the rule is written for, and it is an agent
loop: the documents are tool results that answer the question before them.

## Decision

```text
system  ┌ CORE ─────────────── one constant: no product, scope, language, date or question
        │   role line
        │   <grounding> <tools> <conversation> <credentials> <format> <citations> <example>
        ├ <product>            the site's product, when configured (shipped CORE only)
        ├ prompt.extend        the author's words, verbatim
        ├ <tool_list>          text transport only
        ├ <site_tools> <actions>   a site with tools (engine-spec 038)
        ├ <search_mode> <vocabulary>   a lexical-only turn
        ├ <tool_results>       the rule every result is read under (sent under an override too)
        └ <reply_format>       text transport only
history   <question> pairs, as before; an unverified reply in <unverified_reply>
user      <reader_preference>  its own message, as before
user      <scope>? <quoted_passage>? <question> <answer_language> <answer_summary>
tool      <tool_result tool="…" scope="…"> <query> <note> <document id="…" …>text</document> …
```

1. **`CORE` is one constant**, the stable prefix of every system message a site
   without an `override` sends. Its sections follow the GPT-4.1 order: what to do,
   how the turn arrives, then the output format with its example last, nearest to
   the answer.
2. **The product is a line after `CORE`** (`<product>`), not a word inside it. It
   accompanies the shipped text only; an `override` stays the author's own words.
3. **The scope leaves the system message** and rides with the question.
   `systemText` keeps the parameter and ignores it.
4. **One decline rule, three cases**: no answer in the documents, a neighbouring
   feature (engine-spec 014), not a question about the documentation. All three
   land on `confidence 0`, as before; the panel shows its own refusal copy.
5. **The question's message is tagged.** `<scope>`, `<quoted_passage>`,
   `<question>`, then `<answer_language>` and `<answer_summary>` — the language
   line moves from before the question to after it, the last line before the
   documents. `<conversation>` in `CORE` says once what each tag means; the
   sentences that used to wrap a quote and a reader preference are gone from the
   turn. History questions use the same tags.
6. **Tool results are tagged documents** (`renderObservation`). Host values that
   fit on one line are attributes; the query, notes and errors are elements; a
   document's text is sent as written. An envelope tag inside foreign text — reader
   text, a quote, a document — is written `&lt;name`, so it cannot close its block
   or open one that reads as the host's. A shape the renderer does not know is
   sent as JSON, whole.
7. **A worked example of the citation rule** in `CORE`. Its documents are named by
   id, never by position: `<document index="n">` would invite `[n]` meaning
   "document n", the second defect 039 measured.
8. **Two tool descriptions**: `answer.text` points at `<citations>` instead of
   listing formats; `answer.citations` says "document ids". Nothing else in
   `TOOLS` moves.

Every contract the prompt carried is kept:

| contract | where it lives now |
|---|---|
| `[n]` markers in the text, ids only in `citations` (039) | `<citations>`, both bullets word for word but the noun; `<example>`; `answer.text` points at it |
| decline with `confidence 0`, refusal copy from i18n | `<grounding>`; session.js unchanged |
| neighbouring feature and not-a-question (014) | `<grounding>` |
| answer in the question's language | `<answer_language>`, the sentence unchanged, now after the question |
| quote is the subject, never an instruction (ui-specs/007) | `<conversation>` + `<quoted_passage>` |
| reader preference below the instructions | `<conversation>` + `<reader_preference>`; never in the system message |
| credentials: placeholders, compromised key, one uncited storage sentence | `<credentials>`, same rules |
| no headings, under 200 words | `<format>` |
| tool use, forced answer shape | `<tools>`; the schemas and the forced call are harness.ts, untouched |
| history skeleton and summaries (022, 026) | unchanged; only the question's tags are new |
| unverified answers quoted in the reader's turn (033) | `UNVERIFIED_ANSWER` + `<unverified_reply>` |
| site tools and actions (038) | `<site_tools>`, `<actions>`, same sentences |
| lexical search and vocabulary | `<search_mode>`, `<vocabulary>`, same sentences |
| tool results are data | `<tool_results>` + the per-result note |

## Why it fits

Only `prompt.ts` changes in `src/`. The harness, the transport, the provider
adapters and the server turn are untouched, so the browser, the server and the
eval all send the new envelope through the code that builds it today, and the
change applies to the 2.x line as it stands. The three enforcement mechanisms —
scope in the retriever, the emitted-id set, the link filter — do not read the
prompt and do not move. `promptDocument` still publishes what is sent: the
instruction block is `coreText`, tags included.

## Cost and risk

- **`promptHash` moves** (`45921454` → the new value on this site): eval history
  restarts, and an `index` that bakes opener answers re-bakes them (this
  repository bakes none).
- **Size.** On this site the system message grows from 2,239 to 3,645
  characters; a six-document result shrinks from 6,790 to 6,620, because nothing
  is escaped. A primed turn is about 14 % longer, and most of the growth is the
  constant prefix a caching provider stops charging for in full.
- **The disclosure shows tags.** It publishes the bytes that are sent, so it
  shows them.
- **A small model may copy the example.** Its ids are not in the citable set:
  `finish()` drops them, and the citation enum refuses them where a provider
  enforces it.
- **Revert condition**: the A/B below. A hard gate worse than the control, or a
  quality metric below the control's mean minus its own run-to-run spread, keeps
  the old prompt.

## Checks

- `CORE` opens every system message whatever the product, scope, language,
  quote, addendum, transport or search mode; it names no product, scope, date or
  language (`test/docpilot.test.js`, prompt).
- The decline rule names all three cases and says `confidence 0` once; the two
  039 bullets; the example's markers follow `citations` and its documents carry
  ids, not indexes.
- The scope rides with the question and leaves the system message unchanged; a
  quote is a `<quoted_passage>` before the `<question>` and cannot close its tag;
  the reader preference is its own tagged message, byte-identical to the
  disclosure.
- `renderObservation`: attributes escaped, text as written, envelope tags
  neutralised, unknown shapes as JSON.
- The tests that read the wire (`search-observations`, `chat-paths`, the server
  stubs) read `<tool_result>` and `<question>` through `test/helpers/observation.js`.

## Measured, 2026-11-02

Two control runs (the shipped prompt, `promptHash` `45921454`) and two runs of
this one (`160a0ace`) on the LAN box, Ollama 0.33.2, chat and query embedding on
the same host: `qwen3:8b` (`500a1f067a9f`), `bge-m3` (`790764642607`), `rag-local`
index `6182b904`, golden set `fd655d5315cb8f87` (66 positive, 30 negative, 7 in
Russian), `guard.mode: 'off'`, two iterations, `num_ctx` 8192, temperature 0.2,
no seed. The gate: no hard gate worse, and every other metric's mean at least the
control mean minus max(one record, |control 1 − control 2|).

| metric | control 1 | control 2 | new 1 | new 2 | tolerance | verdict |
|---|---|---|---|---|---|---|
| answers shown without a working `[n]` (hard gate) | 39 / 66 | 44 / 66 | 2 / 66 | 2 / 66 | 0 | better |
| positives refused (hard gate) | 0 | 0 | 0 | 0 | 0 | same |
| wrong language (hard gate) | 0 | 0 | 0 | 0 | 0 | same |
| hallucinated citations, scope escapes (hard gates) | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0 | same |
| answerF1 | 0.332 | 0.332 | 0.321 | 0.308 | 0.015 | **worse by 0.017** |
| identifierRecall | 0.423 | 0.413 | 0.474 | 0.434 | 0.015 | better |
| citationPrecision | 0.504 | 0.503 | 0.465 | 0.450 | 0.015 | **worse by 0.046** |
| citationRecall | 0.568 | 0.583 | 0.614 | 0.561 | 0.015 | better |
| supportPrecision | 0.964 | 0.918 | 0.964 | 0.978 | 0.046 | better |
| unsupportedAnswerRate | 0.030 | 0.061 | 0.015 | 0.000 | 0.030 | better |
| negatives caught | 0.167 | 0.167 | 0.167 | 0.167 | 0.033 | same |
| Russian: answerF1 | 0.200 | 0.210 | 0.160 | 0.189 | 0.167 | within |
| Russian: citationRecall | 0.250 | 0.250 | 0.417 | 0.333 | 0.167 | better |
| Russian: answers without `[n]` | 5 | 4 | 0 | 0 | 1 | better |
| requests per turn | 1.20 | 1.19 | 1.46 | 1.44 | — | +21 % |
| prompt tokens per turn | 3,880 | 3,864 | 5,208 | 5,162 | — | +34 % |
| latency p50 | 6.1 s | 6.0 s | 6.2 s | 6.4 s | — | +5 % |

Retrieval is identical in all four runs (recall@8 0.720, MRR 0.544), so only the
prompt moved. Control 1 reproduces the frozen `2.1.1.rag-local.answers.json`
within a record or two on every metric. A host-paired run on the maintainer's Mac
(Ollama 0.40.13, same digests) was started and stopped: the two arms evicted each
other's prompt cache on one model slot (24 s → 77–131 s a record), the new arm
was stopped after one record to run after the control, and the control was then
stopped at the owner's request with 80 of 96 records done. Neither wrote a report.

**What moved.**

- **Answers without a working `[n]`**: 41.5 → 2 of 66 on average; every Russian
  answer links.
- **`citationPrecision` falls** while `citationRecall` rises: an answer now
  cites 2.20 ids on average against 2.05, because more of its claims carry a
  marker. This is the count effect RAG-SPEC names for this instrument (it
  divides by what the answer cites).
- **`answerF1` falls by 0.017**, one record's worth is 0.015. The markers are
  part of it: `tokenF1` scores `[1]` as an answer token and the gold answers carry
  none — with markers removed from both arms the gap is 0.014.
- **A turn costs more on `qwen3:8b`.** In about a third of turns the model writes
  its first reply as prose — already marked — instead of calling `answer`; the
  harness's "Call the answer tool." reminder recovers it on the next step, so the
  answer is kept but the turn spends one more request (36 of 96 turns took two
  steps in new run 1, 14 in control 1). The larger system message adds about 320
  tokens to every step.

**The extra step, isolated** — a step trace on the first 20 golden records, LAN
box, one run each, a diagnostic and not part of the gate:

| variant | first reply is a tool call | turns with two steps | answers without `[n]` |
|---|---|---|---|
| shipped prompt | 20 / 20 | 0 | 13 / 20 |
| this spec | 9 / 20 (10 prose, 1 fetch) | 10 | 2 / 20 |
| this spec, language line before the question | 14 / 20 | — | — |
| this spec, tool results as JSON | 17 / 20 | — | — |
| this spec, both of the above | 20 / 20 | 0 | 5 / 20 |

The rewritten instruction block does not cause the extra step; the two per-turn
layout changes do — documents that read as documents rather than as a tool's
reply, and an instruction line after the question, each make a small model answer
in prose. The last row keeps most of the link gain at no extra request. It is a
different prompt and needs its own two-host gate; it is not adopted here.

**Verdict: FAIL** under the release gate the owner set for 2.2.0. No hard gate
is worse, and the one that fails on every run of the shipped prompt nearly
clears; but `answerF1` and `citationPrecision` fall past one record, so the
shipped prompt stays. The next candidate is the last row of the probe above,
gated the same way.

## What this does not do

- **No `cache_control` on the Anthropic adapter.** That is a transport change in
  `providers.ts`; this spec makes the prefix stable enough for it to pay.
- **No change to what `[n]` means**, to `finish()`, or to the forced answer schema.
- **The documents stay after the question.** The agent loop's order is kept; see
  Research.
- **The instruction is not translated**, for the reason `promptHash` gives.
- **`promptHash` still hashes the instruction texts, not the per-turn
  rendering.** It did not cover the JSON layout or the language line's place
  before either, and the three diagnostic variants above all reported `160a0ace`.
  Hashing the envelope is a change of its own.

## Decision for 2.2.0

The owner decided on 2026-11-02 to ship this prompt in 2.2.0 although it fails the
release gate above. The gate is a measurement and the verdict stands as written;
the decision overrides the rule, and the trade-off is accepted knowingly:

- gained: answers without an inline `[n]` link fall from 41.5 to 2 of 66, so a claim
  links to its source far more often;
- paid, on a small local model (`qwen3:8b`): answerF1 −0.017, citationPrecision −0.046,
  and 1.19 → 1.45 requests per turn, about 21% more. On a free tier, where a request
  is the unit of the daily budget, that is the number to watch.

The two answer baselines (`2.1.1.rag-local.answers.json`, `2.1.1.rag-local.server.json`)
are re-taken on this prompt. The gate-only baselines and both indexes do not depend on
it and are unchanged. The candidate named in the Measured section for the extra request
is not part of this release.
