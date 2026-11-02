# 048 — One instruction for every turn

> **Кратко.** Системное сообщение собиралось из правил, в которые вклеивались
> название продукта и область поиска, поэтому его начало менялось от сайта к сайту
> и от хода к ходу, и кэш провайдера не мог его переиспользовать; правило отказа
> повторялось трижды, а фрагменты документации шли JSON-строками с экранированным
> кодом. Теперь сообщение открывается одной неизменной константой `CORE` с
> разделами в XML-тегах и рабочим примером цитирования; всё, что относится к
> вопросу, едет в последнем сообщении пользователя в своих тегах, а результаты
> инструментов — блоками `<tool_result>` с `<document id="…">`. Риск — качество
> ответов малой модели, поэтому изменение принято только через A/B на
> golden-наборе (раздел Measured).

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

## Measured

To be written from the A/B runs: control (the shipped prompt) against this one,
`qwen3:8b` on the LAN Ollama, `rag-local`, the golden set with answers, at least
two runs per arm.

## What this does not do

- **No `cache_control` on the Anthropic adapter.** That is a transport change in
  `providers.ts`; this spec makes the prefix stable enough for it to pay.
- **No change to what `[n]` means**, to `finish()`, or to the forced answer schema.
- **The documents stay after the question.** The agent loop's order is kept; see
  Research.
- **The instruction is not translated**, for the reason `promptHash` gives.
