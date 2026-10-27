# 040 — What the first question pays for

> **Кратко.** Первый вопрос после загрузки страницы платил за то, что пакет мог
> знать заранее. С reasoning-моделями OpenAI это были два отказа 400: проба и шаги
> поиска без `reasoning_effort: 'none'`, финальный вызов с `temperature`. Ещё один
> шаг из двух часто уходил на поиск, который возвращал уже выданные фрагменты.
> Теперь строка `openai` в таблице сервисов задаёт оба правила из руководства
> OpenAI. Новая ступень обучения отличает отказ от слова `none` от отказа от поля.
> Затравочный результат называет свой запрос, а поиск без нового отвечает одной
> строкой. На десяти живых ходах было 34 запроса и 8 отказов, стало 27 и 0.

## Problem

The panel learns from a refusal that names its cause (2.0.1): it asks the same
model again with the one change the refusal asks for, and keeps the change until
the page reloads. On `gpt-6-luna` that is two refusals on the first question of
every page load — and for a docs site, where most readers ask one question, that
is nearly every question:

| request | sent | answer |
|---|---|---|
| probe | tools, no `reasoning_effort` | 400 — function tools need `reasoning_effort: 'none'` |
| final | `reasoning_effort: 'low'`, `temperature: 0.2` | 400 — `temperature` only the default (1) |

Each 400 measured 0.34–0.47 s and one charged request. The two retries succeed,
so nothing is lost but the time and the requests — which is why it ran unseen.

A second cost sat in the loop. On the 2.1.0 prompt, every live turn spent one of
its two steps on a `search_docs` that returned exactly the six excerpts the host
had primed it with, all marked "shown in an earlier result". The priming result
carried no query, so it read as a search nobody had made.

## Research

OpenAI's migration guide for the GPT-6 family states both rules for every
reasoning model rather than for one:

- "When reasoning effort is not `none`, remove `temperature`, `top_p`, and
  `top_logprobs`."
- Since GPT-5.4, Chat Completions takes function tools only at
  `reasoning_effort: 'none'`; GPT-6 Sol and Luna say so on their model pages.

And an omitted `reasoning_effort` is not off: it is the model's default,
`medium`. Two kinds of OpenAI model do not fit the rules: a model with no
reasoning at all (`gpt-4.1`) refuses the field as an unsupported PARAMETER, and
models with no `none` (`gpt-5`, the o-series, GPT-6.1 Sol, Astra) refuse it as an
unsupported VALUE. The 400 says which in `error.code`.

## Measured, 2026-10-27

The stripo-docs site, `gpt-6-luna`, `reasoning: 'low'`, through its own `/ai`
proxy, headless through the panel's session code; five suggested questions, two
turns each, a fresh page per question.

| | requests | refusals | per first turn | per later turn | linked answers |
|---|---|---|---|---|---|
| before | 34 | 8 | 3.4–6 | 1–4 | 10 / 10 |
| after | 27 | 0 | 3–4 | 2–3 | 10 / 10 |

The default configuration (`reasoning` unset), two questions after the fix: 7
requests, 0 refusals; the answer went without an effort and without
`temperature`, and the API took it.

## Decision

1. **The `openai` row states the rules** (config.ts): `explicitOff` — a step that
   asks for no thinking writes `'none'`, whatever `chat.reasoning` says, since
   `'auto'` promises "never on a search step"; `samplingWithEffort: false` —
   `temperature` and `top_p` stay off a body that carries an effort other than
   `'none'`, or carries none where silence is the model's default effort.
   Applied in `concede()` (providers.ts), the function that applies the learned
   concessions, so a stated rule and a learned one are the same code.
2. **A refusal of the word is not a refusal of reasoning** (llm.ts). A new rung,
   `offWord`: the value `'none'` refused on a request that carried it. The word
   stops being written and the answer keeps its effort. It is checked first,
   because the same sentence also matches `WANTS_OFF`, and the `reasoning` rung
   would have dropped the author's effort from every answer of the session. A
   refusal of the field is still the `reasoning` rung, and a model that refused
   the field keeps its sampling.
3. **A search says what it searched** (harness.ts). The priming observation
   carries `query` — the composed text where that channel won, the question
   otherwise — and so does every search after it. The priming query and the
   empty query seed the search cache: asked again, it is a repeated call,
   answered and refunded as one always was.
4. **A search that finds nothing new is one line**: the query, the note and the
   ids, in place of a row per repeat that was re-sent on every later step. It is
   still charged. A refund would give the model one more step, and one more
   request, for a search that was a fair thing to try.

## What it costs

- A model the up-front word does not fit pays one refusal where it paid none:
  `gpt-4.1` on the field, `gpt-5` and the o-series on the value. On the current
  family, which the row's default model belongs to, the first question pays
  nothing.
- `chat.temperature` and `chat.topP` reach an OpenAI reasoning model on search
  steps only, and on an answer set to `reasoning: false`. That is the service's
  own rule; the providers guide marks the cells.
- The answer bench's priming observation carries `query` too, so its envelope
  stays the shipped turn's.

## Not done here

- **The probe itself** still costs one request and about 1.1 s per page load on a
  single hosted model. `budget.probe: 'auto'` skips it only for pools, on the
  argument that a hosted OpenAI-compatible service is tool-capable by
  construction; the same argument covers one hosted model. A behaviour change of
  its own, with its own measurement.
- **The learned concessions live until a reload.** Persisting them would spare a
  returning reader the probe and any rung a model still needs; nothing in this
  spec needs it any more for the default model.
