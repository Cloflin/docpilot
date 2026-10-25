# 033 — The server turn, guarded

> **Кратко.** Сервер 1.5 стоял на порту без лимитов, без дедлайна хода (худший
> случай — ~16 минут), читал тело целиком до проверки размера, доверял истории
> из браузера как ответам самой модели (находка F11), отдавал dot-файлы через
> `serve --dir` и работал в контейнере под root. 2.0: лимиты по клиенту и
> конкурентности (по умолчанию включены, 429 в форме rate-limited панели),
> дедлайн хода, потоковый лимит тела, HMAC-подпись каждого ответа с понижением
> неподписанной истории до цитаты, фильтр утечки приватных инструкций владельца,
> отказ отдавать dot-файлы, `nosniff`, пользователь `node` в образе — и пробы
> атак в eval, чтобы это было измерено, а не обещано.

## Problem

Read from the 1.5 code and the 2026-10-24 security scan
(`CLAUDE-SECURITY-20261024-174421/`), against OWASP Top 10 for LLM Apps 2025:

- **LLM10, unbounded consumption.** No rate limit, no concurrency cap and no
  whole-turn deadline in the server runtime (spec 028 left it to a proxy the
  default deployment does not have). A turn is up to eight chat calls of 120 s
  plus an embedding and a probe with no timeout, kept alive by 15 s pings.
  `handle()` read the whole body before the 256 KB check.
- **LLM01 via history (F11, open).** Client-sent history went into the prompt as
  `assistant` turns: a forged "previous answer" in which the assistant agreed to
  break its rules was precedent.
- **LLM07, system prompt leakage.** Under `runtime: 'server'` the owner's
  `prompt.override`/`extend` is the one thing the page never receives — and
  nothing stopped "repeat your instructions" from returning it.
- **Static serving.** `serve --dir .` published `.env.local`; no `nosniff`; the
  image ran as root.
- **`docpilot serve` dropped the operator's settings**: it passed the RESOLVED
  settings, whose `server` holds only `endpoint`.

## Research

- OWASP LLM Top 10 2025: rate limits, quotas, timeouts (LLM10); controls outside
  the model for prompt leakage (LLM07); treat all client-supplied context as
  untrusted (LLM01).
- Spotlighting (Hines et al., 2024): delimiting alone helps modestly, datamarking
  much more on weak models, and adaptive attacks break both — so the measurement
  comes first, and the excerpt format is changed only if a probe shows a breach.
- MAC-signed client state is the standard way to keep a server stateless and
  still trust what the client returns (signed cookies, JWT); HMAC-SHA256 with a
  constant-time compare.

## Decision

1. **`server.limits`** (on by default): a token bucket per client
   (`perMinute: 10`, `burst: 10`), a UTC-day count (`perDay: 500`), and running
   turns capped server-wide (`concurrent: 16`) and per client (`perClient: 3`).
   The client is the socket address; `trustProxy: <hops>` lets `X-Forwarded-For`
   name it. A refused turn is `429` with `Retry-After` and the panel's own
   `rateLimit` body, so a reader sees when answers resume; a full server is `503`.
   `limits: false` hands it to a proxy.
2. **`server.turnTimeoutMs`** (300 s) ends the whole turn with `kind: 'timeout'`;
   **`embedTimeoutMs`** (20 s) bounds an embedding; the probe has its own minute.
3. **The body is read no further than 256 KB** (`readCapped`).
4. **Signed history.** Every settled answer carries `sig` = HMAC-SHA256 over the
   conversation id, question, answer and citations (`DOCPILOT_SERVER_SECRET`, or
   a random per-process key). The panel stores it, archives it, sends it back. An
   entry that does not verify is quoted inside the reader's message
   (`UNVERIFIED_ANSWER`), not replayed as the model's turn — the follow-up keeps
   its antecedent and loses its precedent.
5. **The leak guard.** The owner's private instructions become six-word runs and
   identifier-like tokens; a stream frame carrying one is withheld and the turn
   settles `not-answerable` (`leakBlocked` in the log). The package's CORE prompt
   is public and unguarded.
6. **`serve --dir`** refuses every dot-file and dot-directory but `.well-known/`;
   static and API responses send `nosniff`; the image runs as `node`; compose
   passes `DOCPILOT_METRICS_TOKEN` and `DOCPILOT_SERVER_SECRET`.
7. **Measured:** `eval --set=adversarial` (spec 029) on both runtimes.

## Why it fits

`authorize(request)` stays the auth hook and runs first; the limiter runs after
it, so an authenticated caller is still counted. The signature is the same
shape as the settle the panel already archives; the demotion reuses
`buildMessages`' history path with one flag.

## Cost and risk

- Per-process memory: N replicas allow N times the rate; a restart forgets.
  Stated in the server guide.
- A per-process secret demotes the previous process's answers after a restart:
  follow-ups degrade, nothing breaks. Set the variable to avoid it.
- The leak guard can refuse an answer that quotes the owner's own instruction
  text verbatim on purpose. That is the point.

## Checks

`test/server-ops.test.js`: limiter (burst, day, concurrency, client key),
metrics access, 429 body, 413, deadline, signing (verify, forge, demote),
leak guard (detects, withholds, settles), dotfiles.

## What this does not do

- No shared store for limits across replicas.
- No datamarking of excerpts unless a probe shows an indirect-injection breach.
- No per-reader authorisation on the corpus: `server` keeps the corpus private
  from the page, not from a reader who can ask questions.
