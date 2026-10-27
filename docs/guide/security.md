---
description: The threat model of each DocPilot install — what an attacker can reach, what stops them, and what is left to you. Your model key never reaches the browser in either install.
---

# Security

**The model key is never in anything the reader downloads.** It is not in the JavaScript bundle, not in the search index, and not in the text the model reads. In the static install it exists in one place, an environment variable on the server that already serves your site, and a reverse proxy attaches it. In the server install it exists in the environment of the DocPilot server process.

What else you must protect depends on the install you chose. Read the threat model for yours first. [Choose your install](/install/choose) explains the two.

<SecurityFlow />

## The threat model {#threat-model}

DocPilot has four things worth protecting and four kinds of attacker.

| asset | why it matters |
|---|---|
| the model key and its budget | Every call to the model costs money |
| the corpus | Some owners want pages kept off disk on the reader's side |
| the instruction and the thresholds | They are the owner's work, and a canary or an internal reference may sit in them |
| the integrity of an answer | A reader acts on what the panel says |

| attacker | what they can do |
|---|---|
| an anonymous reader | Open the site, read what the page downloads, ask questions |
| a script | Call the endpoints with no browser, forge any header, send any body |
| a hostile question | Try to override the instruction, extract it, or make the model say something false |
| a hostile page | Put an instruction inside a page that retrieval will hand to the model |

### What each install does about each threat

| threat | static install | server install |
|---|---|---|
| Someone spends your model budget | The `/ai/*` routes are public. The proxy bounds each call: exact paths, a model allowlist, a token clamp, a per-IP limit and a body cap. The credit limit on the key bounds the total | Limits are built in and on: a token bucket and a daily count for each client, a concurrency cap, and a deadline per turn. See [Server operations](/guide/server-operations#limits). The credit limit on the key bounds the total |
| The key is stolen | The key lives in the proxy's environment and is attached on the way out | The key lives in the server process and is attached there |
| The corpus is copied | Public by design: the index is a static file. [Where the key is not](#where-the-key-is-not) lists it | The index is never sent. A reader gets the page list and the passages that answers cite. `serve --dir` refuses to serve an index directory |
| The instruction and thresholds are read | The page downloads both | They stay on the server. The [leak guard](/guide/server-operations#leak-guard) stops the owner's text leaving in an answer |
| A hostile question overrides the instruction | The instruction constrains the model, but it is not a control. [Attack probes](/guide/security-probes) measure the result | The same, and the leak guard is a control outside the model for the owner's text |
| A hostile page injects an instruction | The model reads retrieved text as evidence. Probes of the kind `indirect-injection` test this | The same |
| A hostile page steers a [site tool](/features/tools) | A function tool can only read: the build refuses a write, a navigation or an event on one. An action runs only when the reader presses it, and its button text is yours. See [Site tools and actions](#tools) | The same. Function tools run on the server, with the functions you wrote |
| A forged conversation history | The history is the reader's own browser state. Nothing on your side trusts it | Every answer is signed. A forged or edited entry reaches the model quoted in the reader's message, not as the model's own turn |
| A changed index file | Files are named by their own bytes and `manifest.integrity` holds each digest. The panel fetches with Subresource Integrity, so an altered shard fails the load | Not applicable: the index is not served |
| A key pasted into a question | Caught in the browser before anything is sent — see [Keys readers paste](#keys-readers-paste) | The same |
| A cross-site page uses the endpoint | The proxy allows your own origin | No CORS header is sent, and `allowedOrigins` can name the origins that may post |
| A huge or malformed request | The proxy caps the body | The body is read no further than 256 KB, and its fields are clamped |

Neither install is a defence against the reader's own copy of what they were shown. The guarantees are about the answers — see [What it guarantees](/concepts/guarantees).

## The static install {#static}

### Where the key is not {#where-the-key-is-not}

| What the reader can download | What it holds | Why there is no key |
|---|---|---|
| The JavaScript bundle | the panel, and `themeConfig.docPilot` | The client half of the config is built from an explicit field list that has no key field. Tests serialise it with a key set in the environment and assert the key is absent. |
| The index in `/rag/*` | your page text, sentence vectors, a manifest | The key is used during `npx docpilot index` to call the embedder, then dropped. The manifest names the embedding model, never a host or a credential. |
| The prompt the model reads | the question, the retrieved passages, the instruction | The key is an HTTP header, added by your proxy after the browser has sent the request. The model never sees a header. |
| `localStorage` and `sessionStorage` | past conversations, a draft | Only the reader's own questions and answers — and those are scrubbed of anything that looks like a key first. |

The browser talks to your own origin only: `POST /ai/v1/embeddings` and `POST /ai/v1/chat/completions` (`/ai/v1/messages` for Anthropic). It never calls the provider, and it never calls a DocPilot server — in the static install there is none.

**The index cannot be swapped on the way.** Every index file is named by a hash of its own bytes, and `manifest.integrity` holds the `sha256-…` digest of each. The panel passes the digest to `fetch`, so a shard that changed between your build and the reader fails the load instead of becoming text the model reads as your docs. The manifest is the one file served without a long cache, so it is the root of that chain.

### Where the key is

| Stage | Who attaches the key | Where it is read from |
|---|---|---|
| `vitepress dev` / `vite dev` | the Vite plugin's dev proxy | `process.env`, in Node |
| `npx docpilot index` | the CLI, for the embedding calls | `process.env`, in Node |
| Production | your reverse proxy | the server's environment |

**The dev proxy serves this machine only.** It forwards a request only when it is same-origin, `application/json`, and comes from a loopback address. A cross-site request (`Sec-Fetch-Site` other than `same-origin`/`none`, or an `Origin` whose host is not the `Host` header) and a request from another machine get 403, and the key is not attached. To test the panel from another device with `vitepress dev --host`, or to run the dev server in a container behind port mapping, set `DOCPILOT_DEV_PROXY_LAN=1`. With that set, anyone on your network can spend your key through the dev server.

**A key goes only to the host it belongs to.** In a chat [chain](/reference/config#chat-chain), each member sends its own key (`apiKeyEnv`, or its provider's variable). A member that resolves no key — Ollama, a keyless `custom` or `llamacpp`, or a member whose variable is not exported — sends no `Authorization` header; it never reuses the first member's key. `docpilot eval`, `calibrate`, `tune` and `answer-bench` follow the same rule: see [`eval`](/reference/cli#eval).

The provider decides the variable name — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` and so on. Keep it in `.env.local`, which is in `.gitignore`, or in your host's secret store. Ask the CLI what your configuration needs:

```bash
npx docpilot doctor --proxy
```

It prints each route, its upstream, and the **name** of the variable that holds the key. It never prints the value.

### nginx

Two exact routes, and one shared block that sets the key and the limits:

```nginx
location = /ai/v1/embeddings {
    proxy_pass https://api.openai.com/v1/embeddings;
    include /etc/nginx/docpilot-common.conf;
}

location = /ai/v1/chat/completions {
    proxy_pass https://api.openai.com/v1/chat/completions;
    include /etc/nginx/docpilot-common.conf;
}
```

```nginx
# /etc/nginx/docpilot-common.conf
limit_except POST { deny all; }

proxy_set_header Authorization "Bearer ${OPENAI_API_KEY}";   # filled in at start-up
proxy_set_header Cookie "";                                 # drop what the client sent
proxy_set_header x-api-key "";

proxy_ssl_server_name on;
proxy_http_version 1.1;
proxy_buffering off;                                        # answers stream as SSE

client_max_body_size 32k;
limit_req zone=docpilot burst=10 nodelay;
```

`${OPENAI_API_KEY}` is not nginx syntax: `envsubst` replaces it before nginx starts. The full server block, with caching for the index, is in [Production](/guide/production#nginx).

### Docker

The key goes into the **running container**, never into the image:

```dockerfile
FROM nginx:1.27-alpine
COPY docs/.vitepress/dist /srv/docs
COPY nginx/docpilot-common.conf /etc/nginx/docpilot-common.conf
COPY nginx/docs.conf.template /etc/nginx/templates/docs.conf.template
# envsubst runs over templates/ at start-up; the filter leaves nginx's own $vars alone
ENV NGINX_ENVSUBST_FILTER=OPENAI_API_KEY
```

```yaml
# compose.yaml
services:
  docs:
    build: .
    ports: ['8080:80']
    environment:
      OPENAI_API_KEY: ${OPENAI_API_KEY:?set OPENAI_API_KEY}
```

A key written into a `Dockerfile` is in every layer of the image, readable by anyone who can pull it. If the image also builds the index, pass the key as a BuildKit secret for that one `RUN` — see [Production › Docker](/guide/production#docker).

### Vercel, and other serverless hosts

This site runs on Vercel. Two rewrites send the panel's routes to two functions, and the functions add the key:

```json
{
  "rewrites": [
    { "source": "/ai/v1/chat/completions", "destination": "/api/ai/chat" },
    { "source": "/ai/v1/embeddings", "destination": "/api/ai/embeddings" }
  ]
}
```

The shared handler builds the outgoing headers from nothing — `Authorization: Bearer $OPENROUTER_API_KEY` (this site uses OpenRouter), `content-type`, `accept` — so no client header can ride along. It answers 405 to anything but POST, 403 to another origin **or to a request with no `Origin` header**, 413 above 256 KB, and 429 above 10 requests a minute or 20 a day from one IP. The response goes back as a stream, without `set-cookie` and without any `access-control-allow-*` header.

**The body is rebuilt, not relayed.** The handler parses the request and forwards only the fields the panel sends. The model must be on an allowlist, the output ceiling is clamped, and every routing or billing field — `models`, `plugins`, `transforms`, `route`, `n`, other `provider` keys — is dropped. A body that is not JSON, names a model off the list, has no `messages`, or carries more than 8 embedding inputs gets 400 and is never forwarded.

| Variable | Default | What it sets |
|---|---|---|
| `DOCPILOT_PROXY_CHAT_MODELS` | `deepseek/deepseek-v4-flash` | the chat models the proxy accepts, comma-separated |
| `DOCPILOT_PROXY_EMBED_MODELS` | `qwen/qwen3-embedding-8b` | the embedding models the proxy accepts |
| `DOCPILOT_PROXY_MAX_TOKENS` | `4096` | the clamp for `max_tokens`, `max_completion_tokens` and `reasoning.max_tokens`; a body with none gets this value |

If you change `chat.model` or `embed.model` in the site config, or add fallback models with [`chat.models`](/features/fallback), list every one of them in these variables. A model the proxy refuses gets 400 `model not allowed here`: with no fallback the question fails, and a fallback model off the list never answers, so a 429 on the first model ends in a search answer. A script that calls the deployed proxy must send `Origin: https://<your site>`.

The limiter counts in the memory of one function instance, so a cold start or a parallel instance resets it. **Set a hard credit limit on the key in the OpenRouter dashboard** — that is the only ceiling that holds.

### What every proxy must do

`doctor --proxy` prints these five rules, and each one closes a specific hole:

1. **Match the paths exactly.** A prefix match on `/ai` turns your site into an open proxy, on your key, for every path under it.
2. **Strip the client's `Authorization`, `x-api-key` and `Cookie`.** Your key is the only credential that goes upstream.
3. **Turn off response buffering.** The answer is a stream; a buffering proxy holds it until the end.
4. **Rate-limit by IP and cap the body.** Anyone who can load the page can call this route, and every call costs money.
5. **Allow only your own origin.** The panel calls it same-origin; nothing else should.

## The server install {#server}

The server install moves the turn to a process you run. The page receives a shell manifest and a stream, and there is no model route to proxy. The key is in the environment of that process.

| control | what it does |
|---|---|
| keys stay on the server | The embedding request carries only the embed provider's key and the chat request only the chat provider's. A keyless embedder gets no `Authorization` header |
| same-origin only | No response carries a CORS header. `server.endpoint` must be a path. `allowedOrigins` rejects a `POST` from another `Origin` with `403` |
| limits | A token bucket and a daily count for each client, a server-wide and a per-client concurrency cap, and `429` with `Retry-After` or `503` when they are reached |
| a deadline for the whole turn | `turnTimeoutMs` stops a turn that runs too long, so a stuck model cannot hold a connection open |
| signed history | Each answer carries an HMAC. A history entry that does not verify reaches the model as a quote in the reader's message |
| the leak guard | The owner's `prompt.override` and `prompt.extend` never stream out. Such a turn settles as not-answerable |
| the index stays private | `serve --dir` answers `404` for every file under a directory that holds an index manifest, by real path on every request |
| no dotfiles | `serve --dir` refuses any path with a dot segment, except `.well-known/` |
| metrics are the operator's | `/metrics` answers loopback, or a request with the bearer token. It is never public by default |
| the turn log is redacted | The question is redacted before it is written. No IP address, user agent or cookie is ever stored |
| small attack surface | Bodies are read to 256 KB. Responses send `nosniff`. The Docker image runs as `node`. A bad request never stops the process |

**What you must still do.** Run the server behind the proxy that serves your site, set `trustProxy` to the number of hops in front of it, set `DOCPILOT_SERVER_SECRET` when you run more than one replica, and set `DOCPILOT_METRICS_TOKEN` if the proxy forwards the metrics route. [Server operations](/guide/server-operations) has each setting. Authentication of readers is not included: `createDocPilotServer` takes an `authorize` function for it, and the reader's identity is your proxy's to know.

**What the server install does not do.** The text of the chunks an answer cites reaches the reader, because a source row shows its passage. A reader can still collect passages by asking questions. The limits slow that down. They do not stop it.

## Site tools and actions {#tools}

A site's own [tools](/features/tools) are the one place where a model's choice can lead to code running. The controls are in code, not in the instruction:

| control | what it does |
|---|---|
| function tools only read | The build refuses a function tool (`confirm: false`) whose `run` is a `POST`, a navigation or an event. A handler you register is your own code: keep it read-only |
| an action needs the reader | An action (`confirm: true` or `'form'`) never runs in a turn. It runs when the reader presses its button or sends its form |
| the words on a button are yours | The button text is your `label` and the form's name is your `title`. The model chooses which action to offer and with which values |
| arguments are checked in code | Every argument is checked against your schema before anything runs, the model's and the reader's alike. Values are URL-encoded into a template, so the model controls neither the host nor the path |
| replies are data | A tool's reply reaches the model under the same "data, not instruction" note as a documentation section, cut to 4,000 characters |
| replies go to the model provider | A function tool's reply is sent to your model provider with the next request, as a section is. Return what the answer needs, not a whole account record |
| bounded | At most twelve tools and three actions per answer. A run has 10 seconds in a turn, and 30 when the reader started it |
| nothing kept | Actions are not written to the conversation history. The server's turn log records a function call as `{tool, ok, ms}`, never its arguments or its reply |

A planted instruction can still make the model *offer* an action. That is why an action shows what it will send and waits for the reader: on Harborline, planted instructions succeeded in 23–30 % of [attack probes](/guide/security-probes).

## Keys readers paste {#keys-readers-paste}

Readers paste keys into questions. Before anything leaves the browser — before the embedding call, before the model, before history — DocPilot looks for the common key shapes (`sk-…`, GitHub and Slack tokens, AWS key ids, JWTs, `Bearer …`, long hex strings). On a match the question stops in the browser, the reader is told why, and the value is not kept. See [Pasted keys](/features/credentials).

## A fully local setup

With Ollama for both chat and embeddings there is no key at all, and nothing to proxy: the browser calls the local server directly. With `chat: false` and `embed: false` the panel is a search box over the static index and makes no outbound request after the page loads.

## Test the model's side {#test}

Reading code finds the defect somebody thought to look for. It says nothing about what a model does when a reader, or a page of your corpus, tells it to do something else. `npx docpilot eval --set=adversarial` asks, through the same turn a reader's question takes, and reports an attack success rate. See [Attack probes](/guide/security-probes).

## What this does not protect

Say these out loud to whoever owns the budget:

- **Static install: the `/ai/*` routes are public.** Anyone who can open your site can send questions through them, and a non-browser client can forge the `Origin` header. The model allowlist, the token clamp, the rate limit and the body cap bound the cost of each call; they do not make the route private. The credit limit on the key bounds the total.
- **Server install: the limits are in memory.** A restart forgets them, and *N* replicas allow *N* times the rate. The credit limit on the key bounds the total here too.
- **A key you write into the page yourself is published.** DocPilot never puts one there, but a hand-written `window.__DOCPILOT__` or `themeConfig` with an `apiKey` would be sent from the browser. Do not do that.
- **No prompt is a security boundary.** An instruction to the model lowers the chance of a bad reply. It does not remove it. The controls that hold are outside the model: the proxy, the limits, the leak guard and the credit limit.
- **This is not a defence against the reader.** The corpus is your public website and the panel runs in the reader's browser. The guarantees are about the answers — [What it guarantees](/concepts/guarantees) lists them.
