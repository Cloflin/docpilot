---
description: Your model key never reaches the browser, the index or the prompt. It lives in one environment variable on your server, and a reverse proxy attaches it.
---

# Security

**The model key is never in anything the reader downloads.** It is not in the JavaScript bundle, not in the search index, and not in the text the model reads. It exists in one place: an environment variable on the server that already serves your site. A reverse proxy — nginx, a Docker container, a Vercel function — reads it and attaches it to each model request on the way out.

<SecurityFlow />

## Where the key is not

| What the reader can download | What it holds | Why there is no key |
|---|---|---|
| The JavaScript bundle | the panel, and `themeConfig.docPilot` | The client half of the config is built from an explicit field list that has no key field. Tests serialise it with a key set in the environment and assert the key is absent. |
| The index in `/rag/*` | your page text, sentence vectors, a manifest | The key is used during `npx docpilot index` to call the embedder, then dropped. The manifest names the embedding model, never a host or a credential. |
| The prompt the model reads | the question, the retrieved passages, the instruction | The key is an HTTP header, added by your proxy after the browser has sent the request. The model never sees a header. |
| `localStorage` and `sessionStorage` | past conversations, a draft | Only the reader's own questions and answers — and those are scrubbed of anything that looks like a key first. |

The browser talks to your own origin only: `POST /ai/v1/embeddings` and `POST /ai/v1/chat/completions` (`/ai/v1/messages` for Anthropic). It never calls the provider, and it never calls a DocPilot server — there is none.

## Where the key is

| Stage | Who attaches the key | Where it is read from |
|---|---|---|
| `vitepress dev` / `vite dev` | the Vite plugin's dev proxy | `process.env`, in Node |
| `npx docpilot index` | the CLI, for the embedding calls | `process.env`, in Node |
| Production | your reverse proxy | the server's environment |

The provider decides the variable name — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` and so on. Keep it in `.env.local`, which is in `.gitignore`, or in your host's secret store. Ask the CLI what your configuration needs:

```bash
npx docpilot doctor --proxy
```

It prints each route, its upstream, and the **name** of the variable that holds the key. It never prints the value.

## nginx

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

## Docker

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

## Vercel, and other serverless hosts

This site runs on Vercel. Two rewrites send the panel's routes to two functions, and the functions add the key:

```json
{
  "rewrites": [
    { "source": "/ai/v1/chat/completions", "destination": "/api/ai/chat" },
    { "source": "/ai/v1/embeddings", "destination": "/api/ai/embeddings" }
  ]
}
```

The shared handler builds the outgoing headers from nothing — `Authorization: Bearer $OPENROUTER_API_KEY` (this site uses OpenRouter), `content-type`, `accept` — so no client header can ride along. It answers 405 to anything but POST, 403 to another origin, 413 above 256 KB, and 429 above 10 requests a minute or 20 a day from one IP. The response goes back as a stream, without `set-cookie` and without any `access-control-allow-*` header.

## What every proxy must do

`doctor --proxy` prints these five rules, and each one closes a specific hole:

1. **Match the paths exactly.** A prefix match on `/ai` turns your site into an open proxy, on your key, for every path under it.
2. **Strip the client's `Authorization`, `x-api-key` and `Cookie`.** Your key is the only credential that goes upstream.
3. **Turn off response buffering.** The answer is a stream; a buffering proxy holds it until the end.
4. **Rate-limit by IP and cap the body.** Anyone who can load the page can call this route, and every call costs money.
5. **Allow only your own origin.** The panel calls it same-origin; nothing else should.

## Keys readers paste

Readers paste keys into questions. Before anything leaves the browser — before the embedding call, before the model, before history — DocPilot looks for the common key shapes (`sk-…`, GitHub and Slack tokens, AWS key ids, JWTs, `Bearer …`, long hex strings). On a match the question stops in the browser, the reader is told why, and the value is not kept. See [Pasted keys](/features/credentials).

## A fully local setup

With Ollama for both chat and embeddings there is no key at all, and nothing to proxy: the browser calls the local server directly. With `chat: false` and `embed: false` the panel is a search box over the static index and makes no outbound request after the page loads.

## What this does not protect

Say these out loud to whoever owns the budget:

- **The `/ai/*` routes are public.** Anyone who can open your site can send questions through them. The rate limit and the body cap bound the cost; they do not make the route private.
- **A key you write into the page yourself is published.** DocPilot never puts one there, but a hand-written `window.__DOCPILOT__` or `themeConfig` with an `apiKey` would be sent from the browser. Do not do that.
- **This is not a defence against the reader.** The corpus is your public website and the panel runs in the reader's browser. The guarantees are about the answers — [What it guarantees](/concepts/guarantees) lists them.
