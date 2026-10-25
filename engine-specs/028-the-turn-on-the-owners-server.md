# 028 — The turn on the owner's server

> **Кратко.** Новый ключ `runtime: 'browser' | 'server'`. В `'server'` весь ход —
> opener, embed, gate, tool loop, prompt — выполняется в
> `@cloflin/docpilot/server` на сервере владельца сайта; браузер шлёт вопрос и
> получает SSE-поток. Инструкции, пороги, ключи и корпус не уходят в бандл. Тот же
> сервер пишет turn-лог (JSONL), из которого четыре новые команды делают работу:
> `docpilot traffic` (пробелы корпуса и кандидаты в golden), `docpilot llms`
> (lint и сборка llms.txt), `docpilot dataset` (SFT/KTO/DPO из трафика и голосов),
> `docpilot model` (отпечаток весов, проверка, сравнение чекпоинтов, контаминация).
> `'browser'` остаётся по умолчанию и не меняется ни на байт.

## Problem

Сейчас сервер владельца — это прокси ключа (`/ai/v1/*`). Всё остальное едет в
браузер читателя:

```
browser                                         server
───────────────────────────────────────────     ──────────────
themeConfig: prompt, product, guard, llm.*      /ai/v1/embeddings  → key
index: manifest, shards, vectors, df            /ai/v1/chat/...    → key
retriever + gate + harness + prompt.ts          /ai/feedback       (optional)
```

Три следствия:

1. **Инструкции публичны.** `prompt.override`/`extend` лежат в hydration payload
   каждой страницы. Владелец, который вложил работу в prompt, отдаёт его любому
   `view-source`.
2. **Корпус публичен.** Шарды — это весь текст документации. Внутренняя база
   знаний не может быть корпусом.
3. **Владелец ничего не видит.** Ход происходит в браузере, сервер видит только
   два непрозрачных POST. Единственный путь назад — голос читателя
   (`feedbackEndpoint`), и он есть у малой доли ходов. Улучшать RAG, eval и
   llms.txt не на чем, а тренировать модель тем более.

## Research

Внешние практики, на которые опирается решение (ссылки — в конце):

- **Поток.** SSE поверх `fetch` POST (не `EventSource`, тот не умеет POST) —
  формат Vercel AI SDK data stream и OpenAI Responses API: типизированные
  события `delta`/`status`/`error`/`done`, JSON в `data:`. Отмена — закрытие
  соединения; сервер видит `request.signal`.
- **Телеметрия.** OpenTelemetry GenAI semantic conventions (`gen_ai.*`):
  модель, провайдер, usage, finish reason. Текст запросов — opt-in, с
  редактированием секретов.
- **Eval из трафика.** RAGAS/TruLens разделяют context relevance, groundedness и
  answer relevance; кандидаты из продакшена отбираются по сбоям (отказ, нет
  цитат, низкий support, down-vote) и проходят ревью человека перед golden.
- **Датасеты.** TRL: SFT — chat `messages`; KTO — `prompt`/`completion`/`label`
  (непарный бинарный сигнал — ровно палец вверх/вниз); DPO — `prompt`/`chosen`/
  `rejected`. Вопросы из golden исключаются из обучающих данных, иначе eval
  измеряет память.
- **Чекпоинты.** Сравнение кандидата с базой на одном golden — парный тест
  (McNemar exact для бинарного исхода, paired bootstrap для непрерывных
  метрик); на 50 записях разница < ~10 п.п. обычно не значима, и отчёт обязан
  это сказать. Контаминация — перекрытие 13-грамм (GPT-3/Llama-практика).
- **Веса.** safetensors: 8 байт LE длины + JSON-заголовок (dtype, shape,
  offsets, `__metadata__`). GGUF: magic, версия, KV-метаданные
  (`general.architecture`, `general.name`, `general.file_type`), tensor infos.
  Оба читаются без загрузки весов. Идентичность — sha256 каждого файла.

## Decision

### 1. Два runtime, один выбор

```js
docPilot: {
  runtime: 'server',                 // 'browser' (default) | 'server'
  server: { endpoint: '/ai/turn' },  // где браузер ищет сервер
}
```

`themeDocPilot()` в `'server'` выпускает **оболочку**: `runtime`, `server`, UI-
ключи, `suggestions`, `feedback*`, `i18n`. Ключей `prompt`, `product`-prompt,
`guard`, `llm`, `embed` в ней нет — их нет в бандле вообще. `devProxy()` в
`'server'` монтирует handler в dev-сервер Vite, так что `docs:dev` работает
без отдельного процесса.

### 2. Сервер

```js
import { createDocPilotServer } from '@cloflin/docpilot/server'
const dp = await createDocPilotServer({ settings: docPilot, env: process.env,
  index: './docs/public/rag', log: { dir: './docpilot/turns' } })
// Web-standard: (Request) => Promise<Response>
export default { fetch: dp.handle }
// node:http / express
http.createServer(dp.node).listen(8787)
```

Маршруты (относительно `endpoint`):

| метод | путь | что |
|---|---|---|
| `GET` | `{endpoint}/manifest` | оболочка индекса: `hash`, `pages`, `sections`, `orphanPages`, `chunkCount`. Без `guard`, `tuning`, `vocabulary`, имён шардов. |
| `POST` | `{endpoint}` | ход. Ответ — `text/event-stream`. |

Тело хода (всё ограничено по длине и пересчитано на сервере — браузеру не
верят):

```
{ messageId, conversationId, question, quote, scope: {kind, paths[]},
  history: [{question, answer, summary, quote, citations[], gate: {channel, antecedent}}],
  addendum, lang }
```

События SSE (`event:` + JSON в `data:`):

| event | data | клиент делает |
|---|---|---|
| `phase` | то, что harness отдаёт в `onPhase` | `state.status` |
| `model` | имя модели | `turn.model` |
| `member` | `{provider, index, freePool}` | `turn.ladder` |
| `stream` | `{start}` / `{thinking}` / `{text}` | тот же `onStream` |
| `settle` | итог хода, форма ниже | settle как локальный ход |
| `error` | `{message, kind, rateLimit?}` | тот же catch |

`settle`:

```
{ outcome: 'answer'|'opener'|'refused'|'not-answerable'|'social'|'credential'|'results',
  text, summary, think, citations[], confidence, tentative, notAnswerable?,
  sources: [chunk-shaped rows: id, path, anchor, title, breadcrumb, text],
  results?: [...], closest?: [...], refusal?: {...},
  gate: {pass, channel, antecedent, mode, wouldPassUnscoped},
  iterations, rejectedFetches, support }
```

`sources` несут текст только тех чанков, на которые ответ сослался. Браузер
кладёт их в `byId` оболочки — `passageFor` и строки источников работают без
шардов.

Пайплайн хода на сервере — тот же порядок, что `session.submit`: credential →
social → lexical opener → embed (оба текста одним запросом) → dense opener →
gate (`enforces`) → `runTurn`. Модули те же: `gate.js`, `openers.js`,
`retriever.js`, `harness.js`. Копия *порядка* — третья (после `session.ts` и
`eval/run.ts`) и записана как долг в «What this does not do».

### 3. Turn-лог

Один JSON на строку, файл в день: `{log.dir}/turns-YYYY-MM-DD.jsonl`, или
функция `log.write(record)`. Формат `docpilot.turn/1`:

```
{ "kind": "docpilot.turn", "v": 1,
  "at": ISO-8601, "messageId", "conversationId",
  "question", "quote", "lang", "scope": {kind, paths[]},
  "depth": число предыдущих ходов,
  "outcome": как в settle | "error" | "aborted" | "rate-limited",
  "refusal": cause | null,
  "gate": {pass, G, D, L, channel, antecedent, mode, threshold} | null,
  "retrievedIds": [...], "emitted": [...], "citations": [...],
  "answer", "summary", "confidence", "support", "tentative",
  "iterations", "requests", "latencyMs",
  "usage": {promptTokens, outputTokens, cachedTokens},
  "model", "provider", "embedModel",
  "indexHash", "promptHash",
  "messages": [...]   // только при log.prompts: true
  "error": string | null }
```

Правила:

- `question`, `quote`, `answer` проходят `redactSecrets` на сервере ещё раз.
- IP и user-agent не пишутся. Нет ключа — нет соблазна.
- `messages` (финальный вызов модели целиком) — opt-in: это то, на чём
  учится SFT, и это самая тяжёлая часть записи.
- `messageId` совпадает с `messageId` feedback-записи, поэтому голос
  присоединяется к ходу без эвристик.

### 4. Команды

| команда | режимы | вход → выход |
|---|---|---|
| `docpilot serve` | — | handler + статика `--dir`; dev и простой prod |
| `docpilot traffic` | `report`, `candidates` | turn-лог (+ feedback) → отчёт о пробелах; кандидаты в golden с `needsReview: true` |
| `docpilot llms` | `lint`, `build` | llms.txt ↔ спецификация llmstxt.org и индекс; сборка из manifest |
| `docpilot dataset` | `sft`, `kto`, `dpo` | turn-лог + feedback → JSONL для TRL/OpenAI; golden исключён |
| `docpilot model` | `fingerprint`, `verify`, `compare`, `contamination` | веса → manifest sha256; два eval-отчёта → парный тест; train-файл ↔ golden |

Ни одна команда не пишет в `golden.jsonl` или `calibration.jsonl`. Это правило
`feedback` и оно переносится: стратум и gold-ответ пишет человек.

## Checks

- `test/server.test.js`: handler отвечает на manifest и на ход SSE-потоком;
  тело ограничено; оболочка manifest без `guard`/`tuning`; отмена закрывает ход.
- `test/server-config.test.js`: в `'server'` `themeDocPilot` не выпускает
  `prompt`/`llm`/`embed`/`guard`; в `'browser'` выход байт в байт прежний.
- `test/traffic.test.js`, `test/llms.test.js`, `test/dataset.test.js`,
  `test/model.test.js` — чистые модули на фикстурах.
- `cli-flags.test.js` уже держит таблицу флагов против `cli.md`.

## What this does not do

- Не выносит пайплайн хода в общий модуль. `session.ts`, `eval/run.ts` и
  `server/turn.ts` держат один порядок трижды. Следующий шаг — общий
  `planTurn()` и тест паритета.
- Не делает rate-limit и auth. Есть хук `authorize(request)`; лимит — забота
  reverse proxy, как и сейчас.
- `suggestions.followUps` в `'server'` пуст: он читает чанки, а их в браузере
  нет.
- `docpilot model` не тренирует и не грузит веса. Он читает заголовки, считает
  хеши и сравнивает отчёты `docpilot eval`, прогнанного против endpoint с
  чекпоинтом.

## Sources

- llms.txt — https://llmstxt.org/
- OpenTelemetry GenAI semconv — https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Vercel AI SDK stream protocol — https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
- TRL dataset formats — https://huggingface.co/docs/trl/dataset_formats
- RAGAS metrics — https://docs.ragas.io/
- safetensors format — https://github.com/huggingface/safetensors#format
- GGUF — https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
- GPT-3 contamination (13-gram) — https://arxiv.org/abs/2005.14165
