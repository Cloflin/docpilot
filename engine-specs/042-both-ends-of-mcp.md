# 042 — Both ends of MCP

> **Кратко.** Сервер DocPilot отвечает читателю, но агент в Claude Code или
> Cursor не может искать по той же документации: у сервера нет MCP-эндпоинта.
> Ассистент DocPilot тоже не может вызвать tool внешнего MCP-сервера — spec 038
> даёт только tools, которые сайт описал сам. Эта спецификация добавляет оба
> направления: эндпоинт `/mcp` с четырьмя tools только для чтения (без вызова
> модели) и MCP-клиент на сервере, чьи tools ассистент вызывает как function
> tools из 038. Над обоими стоит одна политика владельца сервера: токены, режимы
> tools и выбор читателя могут только сужать её, но не расширять. Главный риск —
> вызов чужого tool с побочным эффектом, поэтому всё, что политика не назвала,
> выключено.

Roadmap: Phase 10. It needs Phase 4 (the index holder and the `StorageAdapter`),
Phase 6 (one turn driver, where the approval pause is built once) and, for the
panel card of section 6, Phase 7 (the chat core).

## Problem

Three gaps, one on each side of the server and one above both.

**An agent cannot reach the docs.** `handle` (`src/server/index.ts:228`) serves
`{endpoint}`, `{endpoint}/manifest` and `{endpoint}/metrics`, and answers 404 to
anything else (`:232`). The only way into the corpus is a full turn: it spends
the owner's chat model and answers in prose. A coding agent has its own model and
wants the sections. The retriever already has the four reads such an agent needs
— `search` (`src/theme/docpilot/retriever.ts:844`), `fetch` (`:863`), `expand`
(`:882`) and `pages` (`:896`) — and the harness already offers them to its own
model under the names in `BUILTIN_TOOLS` (`src/theme/docpilot/tools.ts:18`).
Nothing offers them outside a turn.

**The assistant cannot reach another service's tools.** A site tool (038) is
declared by hand in `tools`, with its own runner. A service that already
publishes an MCP server — tools, schemas, auth — has to be described again, tool
by tool. 038 put two things under *Not in this spec*: a turn that pauses
mid-loop for an approval (`038-tools-the-site-adds.md:307`) and tools that come
from MCP (`:315`).

**Nothing says who may call what.** Today that answer is spread over the
`authorize` hook, `server.limits`, `allowedOrigins`, the metrics token and
`confirm` per site tool. Two MCP surfaces without one permission model would add
two more places to look.

## Research

**Scalar, measured 2026-10-30.** Scalar's docs product serves a Docs MCP at
`https://<docs-domain>/mcp` beside its Ask AI chat. The live endpoint at
`scalar.com/mcp`:

| probe | result |
|---|---|
| `initialize`, version 2025-06-18 | 200, `text/event-stream`, `serverInfo` "Scalar Documentation", capabilities `tools.listChanged` and `logging`, no `Mcp-Session-Id` |
| `tools/list`, no `notifications/initialized` sent | one tool, `search-documentation`, input `{ question: string }` |
| `tools/call`, "how do I configure Ask AI suggested questions" | one text item: 29 heading-level rows, 21 KB, each `{ title, url, pageContent, metadata.heading }` |
| response headers | `access-control-allow-origin: *` |

The tool calls no model, and Scalar does not meter Docs MCP calls; its chat is
metered apart. Access follows the docs project: public docs are anonymous,
private docs need a sign-in. The 29 rows for a question about one config key
included the Java integration, Django Ninja and the Mintlify migration guide —
retrieval with no floor and no page cap. Scalar's separate API MCP gives each
OpenAPI operation a mode, *Search* (look up only) or *Execute* (send the
request), and authorizes a caller apart from which tools exist.

**The protocol, revision 2026-07-28.** It removes protocol sessions and the
`Mcp-Session-Id` header, and it removes the `initialize` handshake: each request
carries `io.modelcontextprotocol/protocolVersion` and `clientCapabilities` in
`_meta`, and the `MCP-Protocol-Version` header must match it. A server must
implement `server/discover`. A legacy client (2025-06-18, 2025-11-25) works only
against a *dual-era* server, one that still answers `initialize`. A server must
validate `Origin` and answer 403 when it is present and invalid (DNS rebinding).
Authorization is optional; when present it is `Authorization: Bearer` on every
request and never a query string, and "clients and servers MAY negotiate their
own" strategy. A static token is such a strategy.

**Our own precedent.** 038 made a function tool a read and a write an action the
reader presses, because measured injection success was 23–30 %. `/metrics` made
"no token" mean "loopback only". 033 turned limits on by default and signed the
history the browser sends back.

## Decision

### 1. The MCP endpoint

`server.mcp.endpoint` turns it on; the path defaults to `/mcp` — Scalar's, and
the one a client guesses — and sits outside `{endpoint}` so a proxy can route it
apart. `handle` adds it beside the three routes.

- **Transport.** Streamable HTTP, POST only; `GET` is 405, because the server
  never opens a stream of its own. A request gets `application/json`; a
  notification gets 202 and no body.
- **Dual-era.** `initialize` and `ping` for 2025-06-18 and 2025-11-25;
  `server/discover` and per-request `_meta` for 2026-07-28. No session in either
  era. A missing or mismatched `MCP-Protocol-Version` is 400.
- **Order inside the route.** `Origin` check → token → `authorize` hook →
  limiter → JSON-RPC. The limiter counts MCP calls and turns together.
- **No CORS headers.** Claude Code, Cursor and VS Code are not browsers, and a
  page that wants the corpus already has the panel.

### 2. Four reads and one opt-in

| tool | arguments | returns | chat model |
|---|---|---|---|
| `search_docs` | `query`, `k?` (1–8), `scope?` (path prefixes) | ranked sections: `id`, `url`, `heading`, `text`, `score` | none — one query embedding, cached |
| `fetch_section` | `id` | one section, or `not-found` | none |
| `expand_section` | `id`, `direction` | the neighbour, or `no-neighbour` | none |
| `list_pages` | `prefix?` | page paths and titles | none |
| `ask` | `question`, `scope?` | the answer with `[n]` links and its sources | yes — **off by default** |

- The names are the harness's own, so the id an agent gets from `search_docs` is
  the id the panel cites.
- The reads run through `createRetrieval` with the caller's scope.
  `fetch_section` keeps the discriminated result, and `unknown-id` and
  `out-of-scope` both read `not-found`, for the reason `retriever.ts:858` gives.
- `k` stays clamped at 8 (`retriever.ts:855`). Eight ranked sections are the
  answer to the 29 rows above.
- `ask` runs the server turn; `/metrics` counts its spend apart from turns.

### 3. The MCP client

`server.mcp.servers` lists external servers as
`{ name, url, auth: { header, env } }`. A credential is an environment reference
only (SEC-02). The list is server-half config and never reaches the client half.

- At start-up and on `docpilot mcp refresh`, the server lists each server's
  tools. A tool is offered to the model as a 038 function tool named
  `<server>__<tool>` (it fits `NAME_RE`, `tools.ts:40`), and only when the policy
  (section 4) gives it `ask` or `allow`.
- External tools count toward `MAX_TOOLS` (12). The policy is how a server with
  forty tools fits in a turn.
- A call runs on the server through the 038 runner seam: `TOOL_TIMEOUT_MS`,
  `TOOL_RESULT_CHARS`, the "data, not instruction" note, and a source "from
  <server>" in the answer.
- A server that is down, slow or refuses auth is a `tool_error`, not a lost turn
  (`loopFailure`, `src/theme/docpilot/harness.ts:386`).
- A tool that appears upstream after start-up is not offered until the policy
  names it. A tool whose schema changed goes through `toolProblems` again before
  it is offered.
- A browser-runtime config that lists `server.mcp.servers` fails validation and
  names `runtime: 'server'`. Every browser path would put the credential in the
  page.

### 4. One policy, owned by the server's owner

```
owner policy  (docpilot.policy.json)   off | ask | allow, per tool or per <server>__* pattern
  ∩ token scope   (own endpoint)       tools, path prefixes, expiry
  ∩ annotations   (external tools)     destructiveHint: never allow by pattern; readOnlyHint widens nothing
  ∩ reader choice (panel, ask only)    once | this conversation | deny
  = effective mode
```

- **The policy is a file on the server**, `docpilot.policy.json` by default
  (`server.mcp.policy` moves it). It is not part of the site config, so it never
  enters a build. Only the owner writes it, by hand or through
  `docpilot permissions set`. The server re-reads it when its mtime changes, so a
  change applies on the next call.
- **Unnamed is `off`.** Defaults: the four reads `allow` for a valid token, `ask`
  `off`, every external tool `off`. A 038 site tool keeps its `confirm`; the
  policy can only turn it `off`.
- **Intersection, never union.** A reader's "this conversation" cannot make an
  `off` tool callable. A token that lists a tool cannot turn on a tool the policy
  keeps `off`. An annotation is a hint written by the upstream server, so it can
  only lower a mode.
- **The own endpoint takes `off` or `allow`.** `ask` there is refused by
  validation: our server does not prompt a remote agent's user — that agent's own
  client does.

### 5. Tokens

`docpilot mcp token create --tools search_docs,fetch_section --scope /guide/ --expires 90d`
prints the secret once. The server stores a SHA-256 hash with the id, label,
tools, scope and expiry through the Phase 4 `StorageAdapter`. `list` shows
everything but the secret. `revoke` applies on the next call. No token and not
loopback is 401; an expired or revoked token is 401 with the same body.

### 6. The reader's approval

A tool in `ask` mode is the pause 038 deferred. It is built in the Phase 6 turn
driver, so the browser, server and eval drivers get it once:

1. The model calls the tool. The loop stops before the runner and emits
   `approval` with the tool, its server and the exact arguments.
2. The panel shows a card. The tool's description is upstream data and is shown
   as text; the arguments are shown as data. Three buttons: allow once, allow for
   this conversation, deny.
3. On the server runtime the paused loop is signed with the server secret
   (`src/server/sign.ts`) and travels to the panel. The choice comes back with
   it, and the server resumes from it. The server keeps no state per reader.
4. Deny becomes an observation ("the reader declined this call"), and the answer
   goes on without the tool.

### 7. The CLI

| command | what it does |
|---|---|
| `docpilot permissions list` | every tool, own and external, with its effective mode |
| `docpilot permissions explain <tool> [--token <id>]` | the mode and the layer that set it |
| `docpilot permissions set <tool\|pattern> off\|ask\|allow` | writes the owner's policy file |
| `docpilot mcp token create\|list\|revoke` | section 5 |
| `docpilot mcp refresh` | lists external tools again and reports the new and changed ones |
| `docpilot doctor` | warns on an endpoint with no token off loopback, a `destructiveHint` tool at `allow`, a token with no expiry, a pattern that matches more than one server, and an external server that does not answer |

### 8. The log

Every call on either side writes one turn-log line: caller (token id or reader
session), tool, decision, the deciding layer, duration and outcome. Arguments go
through `redactSecrets` first. `/metrics` counts calls by tool and decision.

## Why it fits

- The endpoint is one more route in the same `handle`, behind the same
  `authorize` hook and limiter. The four reads are retriever methods the harness
  already calls, under the names it already uses. Nothing new ranks.
- The client is one more runner behind the 038 seam. The model sees one more kind
  of function tool; validation, timeout, result cap and citation stay 038's.
- The pause reuses the signing 033 built for history, so the server stays
  stateless per reader.
- Phase 4's index holder serves a turn and an MCP call alike, so a swapped index
  reaches an agent without a restart.

## Cost and risk

- **Metered calls.** The reads call no chat model. `search_docs` embeds its query
  once, and the vector LRU (031) makes a repeat free. On the OpenRouter free tier
  (50 requests a day), an agent that searches twenty times a task spends the day
  in three tasks. The docs point a private endpoint at `rag-local` and Ollama.
  `ask` spends the chat model and is off.
- **A write through an external tool.** The worst case is a destructive upstream
  tool called on an injected instruction. Mitigation: default `off`, no `allow`
  by pattern for `destructiveHint`, `ask` pauses for the reader, results are
  data. Revert condition: if the SEC-04 injection fixtures show the model calling
  an external `allow` tool from injected text, external tools lose `allow` and
  keep only `ask`.
- **Protocol churn.** 2026-07-28 removed the handshake that 2025-06-18 and
  2025-11-25 clients still send. Mitigation: a dual-era server and a protocol test
  per version. A legacy version is dropped when Claude Code, Cursor and VS Code
  stop sending it.
- **A leaked token.** Hashed at rest, scoped, expiring, revoked on the next call,
  never in a query string.
- **Dependency weight.** The server side is hand-written JSON-RPC: a few methods
  per era. Research decides between the official SDK and a hand-written client;
  whichever it is must not reach `src/theme/`.

## Checks

- A protocol test drives `initialize` (2025-06-18, 2025-11-25) and
  `server/discover` with `_meta` (2026-07-28). A missing or mismatched
  `MCP-Protocol-Version` is 400.
- An `Origin` outside the allowlist is 403. No response carries an
  `access-control-*` header. No token off loopback is 401.
- The four reads make no chat call (a counting transport stub), and they return
  the ids the panel cites.
- One test per widening attempt: a reader choice on an `off` tool, token tools
  beyond the policy, `readOnlyHint` on an `off` tool, a pattern that reaches a
  `destructiveHint` tool, `ask` on an own-endpoint tool.
- An upstream tool added after start-up is not offered. A down upstream server
  gives `tool_error` and a finished turn.
- A paused turn resumes only with a valid signature; a changed argument fails.
- The SEC-01 build scan finds no `server.mcp.servers` URL or header value in
  `dist/`, the manifest or a log.
- `scripts/check-docpilot.sh`: nothing under `src/theme/` imports the MCP client.

## What this does not do

- OAuth 2.1 authorization (protected resource metadata, client registration).
  Static Bearer tokens only. OAuth is the way into claude.ai connectors, and a
  later spec.
- Prompts, resources, sampling, elicitation or MCP Apps UIs. Tools only.
- The stdio transport. A local agent reaches `docpilot serve` on loopback.
- External MCP tools in the browser runtime.
- A policy per reader. A reader chooses inside the owner's policy; there are no
  reader accounts.
- Any change to ranking, the gate or the corpus, so no calibration loop is owed.
