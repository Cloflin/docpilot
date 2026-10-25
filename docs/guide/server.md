---
description: Run the turn on your own server — the prompt, the thresholds, the keys and the corpus stay there, and the panel receives a stream.
---

# The server runtime

By default a turn runs in the reader's browser: it downloads the index, retrieves, scores the gate, runs the tool loop and builds the prompt, and your server only attaches the API key on the way out. Set `runtime: 'server'` and all of that runs on your machine instead.

```
runtime: 'browser'                         runtime: 'server'
──────────────────────────────────         ──────────────────────────────────
browser: index, gate, loop, prompt         browser: question → stream
server:  /ai/v1/* adds the key             server:  index, gate, loop, prompt,
                                                    keys, turn log
```

## What changes for the reader

Nothing they can see. The panel draws the same states — answers, citations, refusals, the hybrid rows when no model answers — from the stream instead of from local work. Two things are different:

- **No follow-up chips.** `suggestions.followUps` reads the corpus, and the browser no longer has it.
- **The first question waits for the server, not the index.** There is no index download, so the panel opens faster on a slow connection and the answer depends on your server's latency instead.

A pasted key and a greeting are still caught in the browser, before anything is sent.

## What stays on your server

- the instruction — `prompt.override` and `prompt.extend` are not in the page any more;
- the gate thresholds and the retrieval levers;
- every API key, for chat and for embeddings;
- the corpus — the browser receives the page list and the text of the chunks an answer cites, nothing else;
- the turn log — see [Improving answers](/guide/improving).

## Setting it up

```js
// docs/.vitepress/config.mjs (or docpilot.config.mjs)
export const docPilot = {
  runtime: 'server',
  server: { endpoint: '/ai/turn' },
}
```

In `docs:dev` nothing else is needed: the plugin mounts the endpoint into Vite's own server.

For a built site, run the server and route the endpoint to it:

```bash
npx docpilot serve --log=docpilot/turns --retention-days=30
```

```nginx
location = /ai/turn          { proxy_pass http://127.0.0.1:8787; proxy_buffering off; }
location = /ai/turn/manifest { proxy_pass http://127.0.0.1:8787; }
```

`proxy_buffering off` matters: the answer is a stream, and a buffering proxy delivers it as one block at the end.

**Do not publish the index.** A site built from `public/` copies `public/rag/` into its output, and anything served from there hands the corpus to whoever asks. `serve --dir` answers 404 for every file under a directory that holds an index `manifest.json`, wherever it sits in `--dir`. It checks the real path on each request, so another letter case on macOS or Windows, a symlink or an index added after start-up does not get past it. Behind your own static server, exclude the index there, or keep `indexDir` outside `public/`.

### Docker

The repository's `docker/` directory runs this site under the server runtime against local models:

```bash
docker compose -f docker/compose.yaml up --build
# another chat model, same image:
DOCPILOT_CHAT_MODEL=gemma3:4b docker compose -f docker/compose.yaml up -d
```

One container runs `docpilot serve --dir`, which serves the built site and `/ai/turn` from one origin, and writes the turn log to the `turns` volume. Ollama runs on the host (on a Mac that is where the GPU is) and is reached at `host.docker.internal`; `--profile ollama` runs it in a container instead; its API is published on `127.0.0.1:11434` only, because Ollama has no authentication. For LAN access, change the mapping on purpose and put authentication in front of it. No key and no `.env*` file enters a layer — `docker/Dockerfile.dockerignore` excludes them.

### In your own server

`docpilot serve` is a convenience. The handler is a plain Web-standard function, so it mounts anywhere:

```js
import { createDocPilotServer } from '@cloflin/docpilot/server'
import { docPilot } from './docs/.vitepress/config.mjs'

const dp = await createDocPilotServer({
  settings: docPilot,
  index: './docs/public/rag',
  log: { dir: './docpilot/turns', retentionDays: 30 },
  authorize: (request) => (rateLimited(request) ? new Response('slow down', { status: 429 }) : null),
})

export default { fetch: dp.handle }          // Workers, Bun, Deno, edge functions
app.use(dp.node)                             // Express, Connect, node:http
```

`authorize` runs before any work and is where authentication and rate limits go. The package ships neither: the reader's identity is your proxy's to know.

## The contract

| method | path | answer |
|---|---|---|
| `GET` | `{endpoint}/manifest` | the page list and sections; no thresholds, levers or file names |
| `POST` | `{endpoint}` | `text/event-stream`: `phase`, `model`, `member`, `stream`, then one `settle` or `error` |

The request body is clamped on the server to what the panel could have sent: the question to 2000 characters, the history to 12 turns, the reader's instruction to 500. Nothing in it is trusted — the scope is rebuilt from page paths against your index, and the question is redacted again before anything is logged.

Any other method on the endpoint gets 405 with `allow: GET, HEAD, POST`, before `authorize` runs. A request whose `Host` header does not parse gets 400. A failed request never stops the process.

No response carries a CORS header. The endpoint spends your model allowance, so it stays same-origin; `server.endpoint` must be a path.

**Each half sends its own key.** The embedding request carries only the embed provider's key, and the chat request only the chat provider's. A keyless embedder (Ollama, `custom`, `llamacpp`) gets no `Authorization` header. A hosted embedder whose key variable is not set fails, and the turn runs lexical-only with `embedder unreachable: …` in the log — export its variable. A Gemini embedder has no host the server can reach, so under the server runtime its turns run lexical-only.

**History is the reader's, not yours.** The panel sends the earlier questions and answers of the conversation with each turn, and the model reads those answers as its own. A client can send answers your server never wrote. This is an accepted limit of a stateless endpoint. `dataset` never trains on them — see [Fine-tuning](/guide/fine-tuning#datasets).

## The turn log

With `log`, every turn writes one line of `docpilot.turn/1` to `turns-YYYY-MM-DD.jsonl`: the redacted question, the scope, the gate's scores, what was retrieved and cited, the answer, the model, tokens, latency, and the index and prompt hashes. No IP address, user agent or cookie is ever written.

`log.prompts: true` (or `serve --log-prompts`) also keeps the final prompt of each turn — the exact messages the answer was written from. It is what [`dataset sft`](/guide/fine-tuning#datasets) trains on, and it is the largest part of a record, so it is off by default.

Set a retention period. A day per file is what makes `retentionDays` a deletion rather than a rewrite.
