# Production

`vitepress dev` proxies `/ai/*` for you. **A built site does not**, and `vitepress preview` has no proxy at all — so the panel works throughout development and stops working on the day it ships, at exactly the point nobody is watching.

Closing that gap is one reverse-proxy rule. This page states the contract and then shows one complete implementation of it — an nginx server block and a container that runs it. The contract is the part this package knows; the implementation is an example, and it will be wrong about your TLS termination, your resolver and your process manager. Read the contract first; copy the example second.

## What the browser asks for

Three surfaces, all of them same-origin:

| surface | what it is | what a reader sees when it is missing |
|---|---|---|
| the site | HTML, CSS and JS — the panel is part of the bundle | no trigger, no panel |
| `/rag/*` | the retrieval index: `manifest.json`, `chunks-NN.<hash>.json`, `vectors.<hash>.bin`, `df.<hash>.json` | the panel opens and says *AI answers are off in this environment* |
| `/ai/…` | two POST endpoints, forwarded upstream with your key attached | every question fails after the gate has already passed it |

A site configured [`embed: false`](/reference/config#embed-false) ships one file fewer and one endpoint fewer: there is no `vectors.<hash>.bin`, and `/ai/` carries the chat route alone. `npx docpilot doctor --proxy` prints the contract for the configuration you actually have, so use its output rather than this table when the two disagree.

Only the third needs a program in front of the files. The first two are static, and the index is fetched **lazily** — nothing under `/rag/` is requested until a reader opens the panel for the first time, so a reader who never asks a question pays nothing.

The index paths above are absolute from the origin root, which is what a site served from `/` fetches. A site under a prefix fetches from under that prefix instead — see [a site under a base path](#a-site-under-a-base-path).

## Ask what the contract is

```bash
npx docpilot doctor --proxy
```

```
[docpilot] proxy     /ai/v1/embeddings
                     → https://api.openai.com/v1/embeddings
                     authorization: <OPENAI_API_KEY>
[docpilot] proxy     /ai/v1/chat/completions
                     → https://api.openai.com/v1/chat/completions
                     authorization: <OPENAI_API_KEY>
  · match these paths EXACTLY — a prefix match on /ai would proxy anything under it
  · strip any client Authorization, x-api-key and Cookie before forwarding
  · disable response buffering: the answer is streamed as server-sent events
  · rate-limit by IP and set a request body ceiling — this endpoint spends money
  · allow only your own origin: the browser calls this same-origin
```

The key value is never printed — only the name of the variable it comes from.

The paths come from the **adapter the browser will use**, not from a list in the printer, so they are right for your configuration rather than for the common one: an Anthropic chat provider prints `/ai/v1/messages`, because `/v1/messages` is what that API serves and what the panel posts to. Run the command for your own config and copy what it says.

A fully local setup (Ollama for both halves) prints `none needed`: the browser calls it directly and there is nothing to proxy.

### Re-read it when the environment changes

`chat.provider` ships as `'auto'`, so **which upstream these routes point at can be decided by a key in your environment** rather than by a line in your config. That resolution happens once, at build time, and the proxy above is written from its answer — which means a deployment that adds, removes or swaps a provider key has changed its proxy contract and does not know it yet.

Two rules follow, and they are the same rule:

- **Run `npx docpilot doctor --proxy` on the machine that builds**, with the environment that build will have. A contract printed from your laptop describes your laptop.
- **Rebuild the index after the key changes.** The embedder is resolved from the same decision, and an index in one vector space queried through a proxy pointing at another is not a worse answer — it is no answer, and the calibrated gate starts refusing questions your docs can answer.

`npx docpilot doctor` names the chosen provider and, when the environment was what chose it, prints the whole chain with the member that answered marked. Pin the provider in your config if you would rather the environment had no say:

```js
chat: { provider: 'openai', model: 'gpt-4o-mini' }
```

## Why each rule is there

**Exact paths.** A `location /ai` prefix match turns your docs host into an open proxy for every path under it, on a credential you attached. Two exact matches, embeddings first.

**Strip client credentials.** A reader can send any header they like. Forwarding a client-supplied `Authorization` alongside yours is at best confusing and at worst a way to use your upstream account with someone else's key handling.

**No response buffering.** The answer streams as server-sent events. A buffering proxy turns a panel that types into a panel that hangs for twenty seconds and then dumps a wall of text.

**Rate limit and body ceiling.** This endpoint spends money per request, and it is reachable by anyone who can load the page. A per-IP rate and a small body cap are the difference between a docs feature and a bill.

**Origin allowlist.** The browser calls this same-origin. Anything else calling it is not your panel.

## nginx

The whole site, including the two rules above, in two files you write. The second block is everything both endpoints share, pulled out so a fix lands in one place; this page calls it `docpilot-common.conf` and the `include` path is whatever you name it.

```nginx
# http {} — the zones have to be declared outside the server block
limit_req_zone  $binary_remote_addr zone=docpilot:10m rate=20r/m;
limit_conn_zone $binary_remote_addr zone=docpilot_conn:10m;

server {
    listen 443 ssl;
    http2 on;
    server_name docs.example.com;

    root /srv/docs;                       # the VitePress build output
    error_page 404 /404.html;

    gzip on;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/json text/plain text/markdown image/svg+xml;

    # `cleanUrls: true` — /guide/install is served from guide/install.html
    location / {
        try_files $uri $uri.html $uri/index.html =404;
    }

    # Hashed asset names: safe to keep forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # ── the index ────────────────────────────────────────────────────────────
    # manifest.json is the ONLY unhashed file, and it names the others. Cache it
    # and a returning reader keeps asking for the shards the last deploy deleted:
    # every one 404s and the panel degrades to "AI answers are off here".
    location = /rag/manifest.json {
        add_header Cache-Control "no-cache";
    }
    location /rag/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # ── the two AI endpoints ─────────────────────────────────────────────────
    location = /ai/v1/embeddings {
        proxy_pass https://api.openai.com/v1/embeddings;
        include /etc/nginx/docpilot-common.conf;
    }

    location = /ai/v1/chat/completions {
        proxy_pass https://api.openai.com/v1/chat/completions;
        include /etc/nginx/docpilot-common.conf;
    }
}
```

```nginx
# /etc/nginx/docpilot-common.conf
limit_except POST { deny all; }           # nothing else has any business here

proxy_set_header Authorization "Bearer ${OPENAI_API_KEY}";
proxy_set_header Cookie "";
proxy_set_header x-api-key "";

proxy_ssl_server_name on;                 # SNI — without it the TLS handshake fails
proxy_http_version 1.1;
proxy_set_header Connection "";

proxy_buffering off;                      # the answer is server-sent events
proxy_cache off;
proxy_read_timeout 300s;

client_max_body_size 32k;
limit_req  zone=docpilot burst=10 nodelay;
limit_conn docpilot_conn 4;
```

Four things that are easy to get wrong here:

**`${OPENAI_API_KEY}` is not nginx syntax.** nginx does not read the environment. That placeholder is substituted before nginx starts — by `envsubst` in the container below, by your configuration management, or by hand. A literal `${…}` reaches the upstream as a literal and returns 401.

**`proxy_ssl_server_name on`.** It is off by default, so nginx sends no SNI, and an API behind a CDN closes the connection during the handshake. The symptom is a 502 with no upstream status, which reads like an outage rather than a config line.

**The `Host` header.** With a literal host in `proxy_pass` the default is right — nginx sends `Host: api.openai.com`. A `proxy_set_header Host $host` inherited from a parent block overrides that default and sends your docs domain upstream, which 404s.

**Where the zones live.** `limit_req_zone` and `limit_conn_zone` are `http`-context directives. In the container image below, a file dropped in `conf.d/` is already inside `http`, so they go at the top of that file.

The upstream host needs a `resolver` only if it is resolved at runtime — that is, if `proxy_pass` contains a variable. The block above uses literals, which nginx resolves once at startup.

## Serving the index

`npx docpilot index` writes four kinds of file into `docs/public/rag` — three of them on a [vectorless index](/reference/config#embed-false) — and VitePress copies `public/` to the site root:

| file | cache | notes |
|---|---|---|
| `manifest.json` | `no-cache` | unhashed, names every other file, 64 KB at most — the indexer refuses to write a larger one |
| `chunks-NN.<hash>.json` | `immutable` | the text, 250 chunks per shard; compresses well with gzip |
| `df.<hash>.json` | `immutable` | document frequencies for the lexical half |
| `vectors.<hash>.bin` | `immutable` | `chunkCount × dims` bytes, Int8 — absent on an index built `--no-embed` |

`vectors.bin` is quantised already — 2,000 chunks at 1,024 dimensions is 2 MB — and compressing it again buys a few percent for real CPU. Leave it out of `gzip_types`, and make sure nothing in front of your host *transforms* it: a CDN "optimisation" that rewrites a response body corrupts the vectors, and the panel reports a buffer-length mismatch rather than a bad byte.

Everything but `manifest.json` carries a content hash, so a deploy that overwrites the directory is atomic from a browser's point of view: new names, new fetches, no half-updated index. That property is what makes the `no-cache` on the manifest necessary and sufficient.

## Docker

Two stages: build the site with Node, serve it with nginx. **Nothing here is copied out of this package** — the two files the second stage needs are the two nginx blocks above, saved into your own build context. The `COPY` lines below expect them in a `nginx/` directory beside the `Dockerfile`; any layout works as long as the source paths match what you wrote.

- `nginx/docs.conf.template` — the server block above with its two `limit_*_zone` lines moved to the top. A file dropped in `conf.d/` is already inside `http`, which is the context those two directives require.
- `nginx/docpilot-common.conf` — the shared block above, verbatim.

The interesting half is the index: `docpilot index` calls an embedding endpoint, so the build stage needs one reachable and a key that must not end up in a layer.

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# BuildKit secret: mounted for this one RUN, never written to a layer.
#   docker build --secret id=openai_key,env=OPENAI_API_KEY -t docs .
RUN --mount=type=secret,id=openai_key \
    OPENAI_API_KEY="$(cat /run/secrets/openai_key)" npx docpilot index
RUN npm run docs:build

FROM nginx:1.27-alpine
COPY --from=build /app/docs/.vitepress/dist /srv/docs
COPY nginx/docpilot-common.conf /etc/nginx/docpilot-common.conf
COPY nginx/docs.conf.template /etc/nginx/templates/docs.conf.template
# The nginx image runs envsubst over /etc/nginx/templates/*.template at startup
# and writes the result into conf.d/. The filter limits substitution to this one
# variable, so nginx's own $host and $binary_remote_addr survive it.
ENV NGINX_ENVSUBST_FILTER=OPENAI_API_KEY
EXPOSE 80
```

`ENV OPENAI_API_KEY=…` is not on that list on purpose. A key in a `Dockerfile` is a key in the image, readable by anyone who can pull it. It arrives at **run** time:

```yaml
# compose.yaml
services:
  docs:
    build: .
    ports: ['8080:80']
    environment:
      OPENAI_API_KEY: ${OPENAI_API_KEY:?set OPENAI_API_KEY in .env or the shell}
```

Two consequences worth knowing rather than discovering:

- The rendered config inside the running container contains the key in plain text, and so does `docker inspect` of the container's environment. That is the same trust boundary as any server holding an API credential — it is not the same as the image.
- If the container is where you build the index, the embedder has to be reachable **from the build**. A local Ollama on the host is not, by default: either build the index in CI and `COPY` the `docs/public/rag` directory in, or point `embed.baseURL` at a host the builder can reach.

Building the index outside the image is the simpler half of that choice:

```dockerfile
COPY docs/public/rag /srv/docs/rag
```

## CI: where the index gets built

The index is a build artifact, not a source file — it is megabytes of quantised vectors and it belongs in `.gitignore`. Whatever builds the site builds it first:

```yaml
- run: npm ci
- run: npx docpilot index
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
- run: npx docpilot doctor        # non-zero exit when the panel would ship off
- run: npm run docs:build
```

`doctor` between the two is the point of the sequence: it fails the job when the index is missing or the key is not set, instead of shipping a site whose panel quietly does not mount.

## A site under a base path

A site served at `https://example.com/docs/` fetches its index from under that
prefix, not from the origin root:

```js
export const docPilot = {
  host: { base: '/docs/' },
}
```

That is the whole of it. `base` is applied at exactly two points — the index fetch
and following a citation — so `/rag/manifest.json` becomes `/docs/rag/manifest.json`
and a citation click lands on `/docs/guide/install`. On VitePress the theme reads
the base from your build and you set nothing at all.

If the index lives somewhere else entirely — a CDN, a separate origin — name it
outright and the base is not consulted:

```js
host: { ragBase: 'https://cdn.example.com/rag' }
```

`indexDir` still moves only where the index is **written**. `host.ragBase` is where
it is **read**.

The `/ai/…` endpoints are a different question: those are same-origin paths your
proxy owns, and they can sit wherever you put them — `llm.baseURL` in the client
config is whatever path your `location` block matches.

::: info This used to need a reverse-proxy workaround
The panel fetched the literal `/rag/`, so a site under a base path had to mount
that directory at the root of its origin with an nginx `alias` — and if the origin
root was not yours to configure, the panel could not load its index at all. Both
paths are configurable now.
:::

## Content Security Policy

DocPilot adds exactly one directive's worth of requirement, and only because the browser is the client:

```
connect-src 'self'
```

That covers both endpoints and the index in a proxied setup, because all three are same-origin — and a same-origin [`feedbackEndpoint`](#collecting-feedback) with it. A cross-origin one has to be named; see [what that costs](#cross-origin-feedback). A configuration that calls a local Ollama directly — `chat.provider: 'ollama'` — needs that origin named instead:

```
connect-src 'self' http://localhost:11434
```

Nothing in the panel evaluates strings: markdown is rendered by markdown-it, and no `unsafe-eval` is required. The rest of the policy is your site's business, not this package's.

## Caddy

```text
handle /ai/v1/embeddings {
    rewrite * /v1/embeddings
    reverse_proxy https://api.openai.com {
        header_up Authorization "Bearer {env.OPENAI_API_KEY}"
        header_up -Cookie
        flush_interval -1
    }
}
```

`flush_interval -1` is the streaming rule; without it the answer arrives all at once.

## An edge function

Any platform with a request handler in front of the static site works: match the two paths, attach the header from a secret, forward the body, and return the upstream response **as a stream**. The whole handler is about fifteen lines. The one thing to get right is not awaiting the full body before returning it.

```js
export default async function handler(request) {
  const { pathname } = new URL(request.url)
  const upstream = { '/ai/v1/embeddings': '/v1/embeddings', '/ai/v1/chat/completions': '/v1/chat/completions' }[pathname]
  if (!upstream || request.method !== 'POST') return new Response('Not found', { status: 404 })

  const res = await fetch(`https://api.openai.com${upstream}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: request.body,          // not awaited
    duplex: 'half',
  })
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
}
```

The rate limit still has to come from somewhere — the platform's own, or a counter in front of this.

## Collecting feedback {#collecting-feedback}

Set [`feedbackEndpoint`](/reference/config#feedbackendpoint) and every vote is POSTed to it as JSON. **This package ships no database driver and no receiver** — the endpoint is yours, the storage is yours, and what you keep is your decision. What follows is the contract, not a component.

### Make it same-origin

```js
export const docPilot = { feedbackEndpoint: '/feedback' }
```

A same-origin path sends **no preflight at all**, and the `connect-src 'self'` policy above already covers it with no change. It is one more `location` block on the reverse proxy that is already carrying `/ai`. Cross-origin works and costs you four things — see [below](#cross-origin-feedback).

### The body

One JSON object, `content-type: application/json`, sent with `keepalive` so a vote cast on the way out of the page still lands. **No authorization header, and there cannot be one**: the panel runs in the reader's browser, where a secret is a published secret. This handler is your trust boundary — validate the shape, cap the comment again, and rate-limit in front of it.

```
ts, sessionId, conversationId, messageId, revision,
question, quote, answer, citations[], retrievedIds[],
retrieval, model, iterations, rejectedFetches, latencyMs,
verdict ('up' | 'down' | null), reasons[], comment,
refusal ('no-evidence' | 'out-of-scope' | 'not-answerable' | 'credential' | 'social' | null),
gate: { G, tau, mode, n, channel, antecedent, source, wouldPassUnscoped } | null,
support, scope: { kind, label, pages, paths[], truncated },
promptHash, promptStock, addendumHash, addendumChars, restored?
```

`quote` is the passage the reader selected in an earlier answer before asking — `null` on the great majority of turns, and the whole subject of the question on the rest. `gate.antecedent` says what a `channel: 'composed'` score was composed **with**: `'question'` for an ordinary follow-up — the last question that was answered, not merely the last one asked — `'quote'` for a quoted one, `null` for a first turn. The two travel together: a composed score with no previous question behind it is not a threshold probe, and `docpilot feedback` uses this to keep quoted turns out of the calibration set.

**Three keys are absent rather than null, and each one looks like a bug to whoever writes the schema:**

- `answer` — omitted when `promptStock` is `false`. The reader added their own instruction, and an answer to "restate my instruction, then answer" is a copy of the thing being protected. **`quote` is omitted with it**, and for the same reason: it is a slice of that answer.
- `retrievedIds` — omitted when the vote was cast on a turn restored from the reader's archive. The retrieved chunk ids are deliberately not kept on disk, so the panel cannot re-derive them. `restored: true` is set on those records, so you can tell "nothing was retrieved" from "this was not recorded".
- `gate` — `null` on a `credential` or `social` refusal, because those settle in the browser before the gate runs.

### Upsert on `messageId`

A report arrives as **two** POSTs: the thumb immediately, then the form with `revision` raised. Both carry the same `messageId`.

```sql
insert into docpilot_feedback (
  message_id, revision, ts, session_id, conversation_id, question, answer,
  verdict, reasons, comment, refusal, gate, scope, model, prompt_hash,
  retrieved_ids, latency_ms)
values ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
on conflict (message_id) do update set
  revision      = excluded.revision,
  ts            = excluded.ts,
  verdict       = excluded.verdict,
  reasons       = excluded.reasons,
  comment       = coalesce(excluded.comment,       docpilot_feedback.comment),
  answer        = coalesce(excluded.answer,        docpilot_feedback.answer),
  retrieved_ids = coalesce(excluded.retrieved_ids, docpilot_feedback.retrieved_ids),
  gate          = coalesce(excluded.gate,          docpilot_feedback.gate)
where excluded.revision >= docpilot_feedback.revision;
```

**Both halves are load-bearing, and both are easy to leave out:**

- `where excluded.revision >= …` — `keepalive` POSTs can arrive out of order. Without the guard a slow revision 0 landing after revision 1 **erases the sentence the reader just wrote**.
- `coalesce(…)` on `answer`, `retrieved_ids` and `gate` — this is what makes an amendment from a restored turn non-destructive. Without it, an absent key becomes a null that overwrites a good value.

A withdrawn vote arrives as `verdict: null` under a raised revision. Treat it as a retraction, not as a row to ignore: it is the reader taking back what they said, including their own words.

### A receiver

```js
const CORS = {
  'access-control-allow-origin': 'https://docs.example.com',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST',
  'access-control-max-age': '86400',
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (request.method !== 'POST') return new Response('Not found', { status: 404 })

  const row = await request.json().catch(() => null)
  if (!row?.messageId || typeof row.question !== 'string') {
    return new Response('Bad request', { status: 400, headers: CORS })
  }

  await db.query(UPSERT, [
    row.messageId, row.revision ?? 0, row.ts, row.sessionId, row.conversationId ?? null,
    row.question, row.answer ?? null, row.verdict, JSON.stringify(row.reasons ?? []),
    row.comment ?? null, row.refusal ?? null, JSON.stringify(row.gate), JSON.stringify(row.scope),
    row.model, row.promptHash, row.retrievedIds ? JSON.stringify(row.retrievedIds) : null, row.latencyMs,
  ])

  // The panel never reads the body, and a body is a byte the reader pays for.
  return new Response(null, { status: 204, headers: CORS })
}
```

The `CORS` block is dead weight on a same-origin path, and required the moment the endpoint is on another host.

### Cross-origin, and what it costs {#cross-origin-feedback}

1. **The shipped CSP blocks it outright.** `connect-src 'self'` means zero deliveries, and you will not see an error — the panel keeps working and the table stays empty. The policy has to name the host: `connect-src 'self' https://feedback.example.com`.
2. `content-type: application/json` makes the POST non-simple, so the browser sends an `OPTIONS` preflight first. Answer it or every POST fails.
3. `keepalive` applies to the POST, **not to the preflight**. A vote cast as the reader navigates away can be dropped cross-origin where same-origin delivers it.
4. **Every failure is silent by design** — a failed vote is not the reader's problem and they cannot fix it. Load any page with `?dpdebug=1` and the failure is printed to the console; that is the only thread you get.

### Reading it back

`npx docpilot feedback pull --from ./export.jsonl` turns what you collected into candidates for the eval sets — see the [CLI reference](/reference/cli#feedback). Export from your own storage however you like; the command reads JSONL or a JSON array, and never talks to your database itself.

## The other surface: `.md`, `llms.txt`

If your site publishes per-route markdown or `llms.txt`, they are only useful when they are served as text:

```nginx
location = /llms.txt      { default_type text/plain;    charset utf-8; add_header Access-Control-Allow-Origin *; }
location = /llms-full.txt { default_type text/plain;    charset utf-8; add_header Access-Control-Allow-Origin *; }
location ~ \.md$          { default_type text/markdown; charset utf-8; add_header Access-Control-Allow-Origin *; }
```

A host that serves `.md` as `application/octet-stream` makes an agent download the file instead of reading it. This is unrelated to DocPilot — it reads its own index — and it is the same layer, so it belongs on the same page. The `docs-rag` skill covers how those files get generated in the first place.

## Verifying

```bash
curl -sS -X POST https://your-docs/ai/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"text-embedding-3-small","input":"ping"}' | head -c 200
```

A 401 means the header is not being attached. A 404 means the path did not match exactly. An empty body that arrives all at once means buffering is still on.

The index is one request away too, and it is the half people forget:

```bash
curl -sSI https://your-docs/rag/manifest.json | head -3
curl -sS  https://your-docs/rag/manifest.json | head -c 120
```

A 404 there is the whole panel: the drawer opens, says AI answers are off in this environment, and never calls anything.

## When it does not work

| symptom | cause |
|---|---|
| panel opens, *AI answers are off in this environment* | `/rag/*` 404s, or the manifest is cached from an older deploy |
| gate passes, then the turn fails | `/ai/…` 404s — usually a path that does not match exactly, or an Anthropic setup pointed at `/v1/chat/completions` |
| 401 from the upstream | the header is not attached; a literal `${OPENAI_API_KEY}` reached nginx unsubstituted |
| 502 with no upstream status | `proxy_ssl_server_name` is off, or `Host` was overridden by a parent block |
| answer arrives in one lump after a long wait | response buffering is still on |
| CORS error in the console | the panel is served from a different origin than `/ai` — it calls same-origin, by design |
| *vector buffer does not match chunkCount × dims* | something in front of the host rewrote `vectors.bin`, or the manifest and the shards are from different builds |
| 429s under normal use | the rate limit is per IP and your readers share one — raise `rate`, keep the ceiling |
