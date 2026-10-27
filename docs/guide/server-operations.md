---
title: Server operations
description: Every operator setting of the server install — limits, deadlines, caches, the turn policy, the metrics endpoint, signed history and the leak guard — with its default.
---

# Server operations

This page is for the person who runs the server install. It lists every `server.*` operator setting with its default, then explains each group of settings and the endpoints they control. To set the server up first, read [The server runtime](/guide/server).

The operator settings live in `docPilot.server`. They are **server-only**: `docpilot serve` and `createDocPilotServer` read them, and none of them reaches the reader's page. The one key the page also reads is `endpoint`.

```js
export const docPilot = {
  runtime: 'server',
  server: {
    endpoint: '/ai/turn',
    limits: { perMinute: 10, burst: 10, perDay: 500, concurrent: 16, perClient: 3 },
    trustProxy: 1,
    turnTimeoutMs: 300000,
    cache: { answers: { ttlMs: 3600000, max: 500 } },
    allowedOrigins: ['https://docs.example.com'],
    turn: { loop: 'adaptive', adaptiveG: 0.6 },
  },
}
```

`docpilot serve` reads these settings. Before 2.0 it dropped them.

## Every setting {#settings}

| key | default | what it does |
|---|---|---|
| `endpoint` | `'/ai/turn'` | The path. `POST` takes a turn, `GET {endpoint}/manifest` returns the page list, `GET {endpoint}/metrics` returns the metrics. It must be a path, not a URL |
| `limits` | `{perMinute: 10, burst: 10, perDay: 500, concurrent: 16, perClient: 3}` | A token bucket per client, a count per client per UTC day, and two concurrency caps. `false` hands limits to a proxy. A partial object is merged over the defaults — see [Limits](#limits) |
| `trustProxy` | `false` | How many proxy hops may name the client in `X-Forwarded-For`. `true` means one hop. See [Limits](#limits) |
| `turnTimeoutMs` | `300000` | The whole turn, from request to settle. Past it the reader gets an error with `kind: 'timeout'`. See [The deadline](#deadline) |
| `embedTimeoutMs` | `20000` | One embedding request, retries included |
| `cache.embeddings` | `1000` | Query vectors kept per process. `false` keeps none. See [Caches](#caches) |
| `cache.answers` | `false` | `{ttlMs, max}` caches whole first-turn answers. `ttlMs` defaults to `3600000` and `max` to `500` once you give the object. See [Caches](#caches) |
| `metrics` | `true` | `false` removes the route. A token comes from `DOCPILOT_METRICS_TOKEN`, or from `metrics: {token}`. See [The metrics endpoint](#metrics) |
| `allowedOrigins` | `null` | When set, a `POST` that carries any other `Origin` gets `403` |
| `turn.loop` | `'one-shot'` | `'agentic'` runs the tool loop, the 1.x server turn. `'adaptive'` skips the loop when `G >= turn.adaptiveG`. See [The turn policy](#turn-policy) |
| `turn.adaptiveG` | `0.6` | The evidence strength at which `'adaptive'` goes one-shot |
| `turn.finalThink` | `false` with one-shot | `true` keeps the reasoning before the answer. With `'agentic'` or `'adaptive'` an unset value leaves the model's own default, as 1.x did |

A timeout, a cache size or `turn.adaptiveG` that is not a positive number falls back to its default. `docpilot status` shows the server your project would reach, and `docpilot monitor` shows what it is doing — see [The terminal](/features/terminal).

The signing secret is not a setting. It is the environment variable `DOCPILOT_SERVER_SECRET` — see [Signed history](#signed-history).

## Limits {#limits}

The default install answers on a port with no proxy in front, so the limits are on. Three ceilings answer three kinds of abuse:

| key | what it counts | what it stops |
|---|---|---|
| `perMinute`, `burst` | A token bucket for each client. It refills continuously at `perMinute` and holds at most `burst` | One script that loops |
| `perDay` | Turns from one client in one UTC day | A slow drip that the bucket lets through |
| `concurrent` | Turns running now, on the whole server | A full GPU or a provider rate limit |
| `perClient` | Turns running now, for one client | One client that holds many slots |

**What the reader sees.** A client over the bucket or the daily count gets `429` with a `Retry-After` header and the panel's own `rateLimit` body, so the panel shows when answers resume. A full server — `concurrent` or `perClient` reached — answers `503` with `Retry-After: 2`. Both are counted in the metrics as `docpilot_refused_requests_total`.

**Who a client is.** The client is the socket's address, never a header. A header that the client writes would be a limit that the client chooses. Set `trustProxy` to the number of proxy hops in front of the server, and the limiter reads `X-Forwarded-For` from the right by that count. On a runtime that gives no address — an edge `handle(Request)` with no connection info — every request shares one bucket. The limit still holds the endpoint, but it cannot tell readers apart. Put the edge's own limiter in front.

**What the limits do not do.**

- They live in the memory of one process. A restart forgets them, and *N* replicas allow *N* times the rate. A shared limit is the proxy's job.
- `limits: false` turns the built-in limits off. Use it only when a proxy in front does this work.

## The deadline {#deadline}

A turn is an embedding request, a probe and up to eight model calls. The model calls have a step timeout each; before 2.0 the turn as a whole had none, and the keep-alive pings held an idle connection open.

`turnTimeoutMs` bounds the whole turn. When it passes, the server stops the turn and sends `error` with `kind: 'timeout'`. The default is five minutes, because a local 8B model answers in under a minute and a slow reasoning model needs the room. Lower it when your provider is fast and you would rather fail than make a reader wait.

`embedTimeoutMs` bounds one embedding request, including its retries. A hosted embedder that hangs would otherwise hold the turn until the deadline.

## Caches {#caches}

**Query vectors** are on by default. A vector is a pure function of the model and the text, so a hit is the byte-identical vector. Nothing a reader can see changes except the time it took. `cache.embeddings` is the number of vectors kept in each process. `false` keeps none.

**Whole answers** are off. A first turn with no history is a pure function of the index, the prompt, the model and the question only up to the model's sampling: two readers asking the same thing would get two different wordings. Serving the first wording to the second reader is a product decision, so you switch it on:

```js
server: { cache: { answers: { ttlMs: 3600000, max: 500 } } }
```

Only a turn with no history, no quote, no addendum and no narrowed scope is cached. The key holds the index hash, the prompt hash, the model, the reader's language and the normalised question, so a rebuilt index or a changed prompt never serves an old answer. A cache hit is recorded in the turn log as `cached`.

## The turn policy {#turn-policy}

By default a server turn goes straight to the answer call with the evidence the gate retrieved, and the model does not reason before it answers. The browser's turn, and the 1.x server turn, run a tool loop instead: the model searches, reads sections and then answers.

| setting | effect |
|---|---|
| `turn.loop: 'one-shot'` | Straight to the answer call, with the evidence the gate retrieved. The default |
| `turn.loop: 'agentic'` | The tool loop, call for call the browser's turn. Restores the 1.x server turn |
| `turn.loop: 'adaptive'` | One-shot when `G >= turn.adaptiveG` (`0.6`), the loop otherwise |
| `turn.finalThink: true` | Reasoning before the answer. On a local model, reasoning is most of the wait for the first token |

On Harborline with a local `qwen3:8b`, the default brings the first token from 25.0 s to 8.3 s at the median and the whole answer from 25.0 s to 19.5 s, with answer F1 and citations inside the noise of the loop — see the [benchmark page](/guide/benchmarks). The cost is that the model cannot search again inside a turn. With a fast hosted model the trade reverses: on `deepseek-v4-flash` the agentic loop showed the first token sooner (9.8 s against 13.3 s) and answered the Russian questions one-shot refused, for about three times the prompt tokens. There, set `turn.loop: 'agentic'`. A long local generation is bounded only by the step timeout, so set `chat.maxTokens` on a server that answers with a local model.

A site's [function tools](/features/tools) run on search steps, so a one-shot turn offers none of them. Actions ride the answer call and work under every policy.

Measure a policy before you adopt it. `eval --runtime=server` scores the golden set through the server turn, so you compare answer quality and latency between policies on your own questions — see [Measure](/guide/measure). The [benchmark page](/guide/benchmarks) shows the policies compared on the Harborline corpus.

## The metrics endpoint {#metrics}

`GET {endpoint}/metrics` returns what the running server has done. It is on by default.

```bash
curl http://127.0.0.1:8787/ai/turn/metrics                  # Prometheus text
curl 'http://127.0.0.1:8787/ai/turn/metrics?format=json'    # docpilot.metrics/1
```

**Who may read it.** With no token set, only a request from loopback may read it, and any other request gets `403`. With `DOCPILOT_METRICS_TOKEN` set, every request needs `Authorization: Bearer $DOCPILOT_METRICS_TOKEN`, and a missing or wrong token gets `401`. `metrics: false` removes the route, and it answers `404`.

**Behind a proxy on the same machine, the proxy connects from loopback.** If the proxy forwards the whole `/ai/turn` prefix, the metrics route is public unless a token is set. Either route only the exact paths, as [The server runtime](/guide/server#setting-it-up) does, or set `DOCPILOT_METRICS_TOKEN`.

**Prometheus text.** Counters and histograms only, so a rate or a quantile is the scraper's arithmetic and survives a restart of the process:

| metric | type | labels |
|---|---|---|
| `docpilot_turns_total` | counter | `outcome` |
| `docpilot_turn_duration_seconds` | histogram | |
| `docpilot_turn_first_token_seconds` | histogram | |
| `docpilot_turn_stage_seconds` | histogram | `stage` (`embed`, `retrieve`, `rerank`, `model`) |
| `docpilot_upstream_requests_total` | counter | `kind` |
| `docpilot_tokens_total` | counter | `type` |
| `docpilot_cache_lookups_total` | counter | `cache`, `result` |
| `docpilot_refused_requests_total` | counter | `reason` (`rate-limit`, `rejected`) |
| `docpilot_info` | gauge | `model`, `embed_model`, `index_hash` |

The server also exports `docpilot_turns_in_flight` and `docpilot_start_time_seconds`. A scrape job needs the path and, off loopback, the token:

```yaml
scrape_configs:
  - job_name: docpilot
    metrics_path: /ai/turn/metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/docpilot-token
    static_configs:
      - targets: ['docs.example.com:443']
    scheme: https
```

**JSON.** `?format=json` returns `docpilot.metrics/1`: exact p50, p95 and p99 over the last 1000 turns, and 30 one-minute buckets. The percentiles are exact, not read off histogram buckets. [`docpilot monitor`](/reference/cli#monitor) draws this object, and `docpilot status --url=<endpoint>` summarises it.

## Signed history {#signed-history}

The browser sends the conversation back with every turn, and the model reads the earlier answers as its own words. Before 2.0, anyone with `curl` could send a "previous answer" in which the assistant had already agreed to ignore its instructions.

Now every settled answer leaves the server with `sig`: an HMAC-SHA256 over the conversation id, the question, the answer and its citations. The panel stores `sig` and returns it with the turn. The server verifies it.

- **An entry that verifies** is the server's own words and reaches the model as before.
- **An entry that does not verify** — forged, edited, or signed by a process that has since restarted with another secret — is not dropped. It reaches the model quoted inside the reader's own message, not as the model's own turn. A follow-up still has its antecedent. It no longer has a precedent.

The secret is `DOCPILOT_SERVER_SECRET`. Without it, the server makes a random secret for each process, so every restart demotes the history of open conversations. **Set the variable when you run more than one replica behind a load balancer**, or each replica demotes the answers of the others. The effect is a worse follow-up, never a failed turn.

## The leak guard {#leak-guard}

Under the server install, `prompt.override` and `prompt.extend` are the one thing the browser never receives. A model can still be asked to repeat its instructions. The control that holds is outside the model, on the text that leaves the server.

The guard is built once from your private instruction text and checks the output with two detectors:

- **Six-word runs.** Any six consecutive words of your text. A paraphrase passes, on purpose: the guard stops the verbatim dump that an extraction attack produces.
- **Identifier-like tokens.** Any word of eight or more characters that holds a digit or an underscore: an internal code, a canary, a ticket number. One of them in an answer is a leak by itself.

When an answer would carry either, it never streams out. The turn settles as not-answerable, and the turn record has `leakBlocked`. The instruction that DocPilot ships is public and is not guarded.

The [security probes](/guide/security-probes) test this: a canary in `prompt.extend` plus a probe that forbids it turns "did the prompt leak" into a string match.

## Limits on a request {#request-limits}

| limit | value | result |
|---|---|---|
| request body | read no further than 256 KB | `413` |
| question | 2000 characters | clamped |
| history | 12 turns | clamped |
| the reader's instruction | 500 characters | clamped |
| `Content-Type` | must be `application/json` | `415` otherwise |
| method | `POST` for a turn, `GET` for the manifest and metrics | `405` otherwise |

`serve --dir` refuses dotfiles, except `.well-known/`. Every response it sends carries `nosniff`. The Docker image runs as the `node` user. A request whose `Host` header does not parse gets `400`, and a failed request never stops the process.

## The turn log

With `log`, every turn writes one `docpilot.turn/1` line. 2.0 adds these fields:

| field | holds |
|---|---|
| `timing` | `embedMs`, `retrieveMs`, `probeMs`, `probeWaitMs`, `modelMs`, `firstThoughtMs`, `firstTokenMs`, `totalMs`, `embedRequests`, `loop` |
| `rankedIds` | The chunks in the order retrieval ranked them |
| `historySigned` | Whether the history verified |
| `leakBlocked` | Whether the leak guard stopped the answer |
| `cached` | Whether the answer came from the answer cache |
| `tools` | Each [site function call](/features/tools) as `{tool, ok, ms}`, never its arguments or its reply. Absent on a turn that called none |

The log still has no IP address, user agent or cookie. [Improving answers](/guide/improving) reads it.

## Warm start

At start the server builds the BM25 index and runs the tool-capability probe of the model. The probe never runs in series with a turn, so the first reader does not pay for it. A rebuilt index needs a restart.

## Before you open it to readers

1. Run the server behind the proxy that serves your site, with `proxy_buffering off` — see [The server runtime](/guide/server#setting-it-up).
2. Set `trustProxy` to the number of hops in front, or set `limits: false` and limit in the proxy.
3. Set `DOCPILOT_SERVER_SECRET`, and `DOCPILOT_METRICS_TOKEN` if the proxy forwards the metrics route.
4. Check that the index is not published: `docpilot serve` names every directory it withholds at start.
5. Run `npx docpilot eval --set=adversarial --runtime=server` — see [Attack probes](/guide/security-probes).
6. Run `npx docpilot monitor` and ask a question.
