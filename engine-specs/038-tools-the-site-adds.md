# 038 — Tools the site adds

> **Кратко.** Сайт добавляет свои tools в ключе `tools`. Есть два вида, и вид
> задаёт `confirm`.
>
> - **Function tool** (`confirm: false`). Модель вызывает его на шаге поиска,
>   DocPilot сразу выполняет его и отдаёт результат модели как наблюдение. Ответ
>   цитирует этот результат как источник.
> - **Action** (`confirm: true` или `'form'`). Модель только предлагает его в
>   поле `actions` ответа. Действие выполняется, когда читатель нажимает кнопку
>   или отправляет форму.
>
> Определение tool содержит описание, параметры в JSON Schema и способ
> выполнения: `href`, `fetch`, `event` или обработчик через `registerTool`. Без
> `tools` промпт, схемы и каждый запрос остаются байт-в-байт такими, как в 2.0.1.

## Problem

The panel answers from the documentation and from nothing else. Two kinds of
question end badly because of that:

- **Live state.** "How many requests does the Pro plan allow today?", "Is the
  API down?", "Which plan am I on?" The docs either say nothing or say something
  out of date, and the turn ends on a refusal or on a stale number with a
  citation.
- **The next step.** "Can I talk to someone?", "Book a demo", "Open the pricing
  calculator for Pro." The model can only write a sentence that sends the reader
  somewhere else.

The machinery to do better is already in the harness: a loop that offers four
tools (`search_docs`, `fetch_section`, `expand_section`, `list_pages`) and
dispatches every call through one `execute(name, args)`, and a final answer that
is a strict JSON object every provider enforces. Nothing lets a site add a tool
to the first or a field to the second.

## Research

**Defining a tool.** OpenAI's function-calling guide and Anthropic's tool-use
reference agree on the points that bear on this design:

- Keep the set small: OpenAI's soft ceiling is 20 tools at the start of a turn.
  DocPilot already uses 4, so a site gets at most 12.
- Write names and descriptions an intern could use unaided, and say *when* to
  use a tool, and when not to, in the system message.
- `strict: true` needs `additionalProperties: false` on every object and every
  property in `required`. An optional field is spelled as nullable
  (`type: ['string', 'null']`). An `enum` prevents invalid states.
- Do not ask the model for a value the code already has. The page, the question
  and the locale belong to the handler, not to the arguments.
- Return a failure as a tool result the model can read. Do not let it end the
  turn.

**GPT-6.** gpt-6-sol and gpt-6-luna take function tools on Chat Completions only
with `reasoning_effort: 'none'`. 2.0.1 already learns to send that on a search
step (the `implicitOff` rung of `escalateCaps` in `llm.ts`, on top of
engine-spec 020's ladder), and a site tool rides on that step.
Reasoning together with tools needs the Responses API, which this package does
not use. That is a reason to put actions in the answer schema rather than in a
tool call: the answer call carries a schema and no tools, so it may still
reason.

**The reader in the loop.** The human-in-the-loop patterns in the AI SDK, MUI X
Chat, Haystack and Gumloop share one shape. A call that changes something
pauses. The UI shows the tool, its exact arguments and a choice to approve, edit
or deny. The policy (when to ask) is separate from the executor (what runs).

**Excessive agency.** OWASP LLM06 puts the blast radius of a prompt injection at
whatever the model is allowed to touch. The rules that follow are least
privilege and a human approval on every high-impact step. This package measured
its own exposure: on Harborline the security probes succeeded 23 % (agentic) to
30 % (one-shot) of the time (`bench/harborline/results`). A model-chosen side
effect that runs without the reader would inherit that rate.

**Standards.** WebMCP (a W3C community-group draft, in a Chrome origin trial for
versions 149–156) lets a page register tools as
`document.modelContext.registerTool({name, description, inputSchema, execute})`.
MCP Apps (an official MCP extension since January 2026) lets a tool return a
sandboxed HTML UI. This spec adopts the WebMCP *shape* for its registration API
and consumes neither.

## Decision

### 1. The `tools` key

`tools` is `null` by default. A site sets it to an object whose keys are tool
names:

```js
tools: {
  plan_limits: {
    description: 'Live limits of one plan: requests per day, seats and storage.',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', enum: ['free', 'pro', 'team'] } },
      required: ['plan'],
    },
    run: { fetch: '/api/plans/{plan}' },
  },
  contact_support: {
    title: 'Contact support',
    description: 'Send the question to the support team when the docs do not answer it.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', description: 'Where support replies' },
        message: { type: 'string', format: 'multiline', description: 'The problem, in the reader’s words' },
      },
      required: ['email', 'message'],
    },
    confirm: 'form',
    run: { fetch: '/api/support', method: 'POST' },
  },
}
```

| field | type | default | meaning |
|---|---|---|---|
| `description` | string, ≤ 1024 | required | what the tool does and when to use it; the model reads it |
| `title` | string, ≤ 60 | the name, humanised | what the reader reads: the source row, the status line, the action's card |
| `label` | string, ≤ 40 | the title | the button text of an action |
| `parameters` | JSON Schema object | no parameters | flat: `string`, `number`, `integer`, `boolean`, each with optional `enum`, `description`, `default`; strings take `format` (`email`, `uri`, `date`, `multiline`) and `maxLength`, numbers `minimum` and `maximum` |
| `confirm` | `false` \| `true` \| `'form'` | `false` | `false` is a function tool; `true` is an action behind a button; `'form'` is an action whose arguments the reader reviews and edits first |
| `run` | `{href}` \| `{fetch, method}` \| `{event}` \| function | none | how it runs — section 3 |

The name matches `^[A-Za-z][A-Za-z0-9_-]{0,63}$` and is none of the five built-in
names. A site tool cannot shadow `search_docs`.

### 2. Two kinds

- **A function tool** (`confirm: false`) is offered on every search step beside
  the built-ins. When the model calls it, the turn runs it at once and the result
  goes back as an observation. It must not change anything: the build refuses a
  `fetch` with `method: 'POST'`, a `href` or an `event` on it, because none of
  those is a read.
- **An action** (`confirm: true | 'form'`) is never offered as a tool. The answer
  schema gains `actions`: an array of `{tool, args}`, and each item is one of the
  site's actions with its own arguments. Nothing runs until the reader presses
  the action's button or sends its form. The model never sees the outcome.

### 3. What runs it

Three sources, asked in this order:

1. **A handler registered in client code:**
   `registerTool(name, async (args, ctx) => result)`. It is exported from every
   browser entry (`theme`, `vue`, `react`, `mount`, `web`, and
   `window.DocPilot.registerTool`). The registry is keyed on
   `Symbol.for('docpilot.tools')` on `globalThis`, so the IIFE and the ESM copies
   of the runtime share it. `ctx` is `{question, page, signal}`.
2. **A function in the config.** It can exist only where the config is not
   serialised: `docpilot serve`, `createDocPilotServer` and any Node caller that
   hands the harness the config itself. In a static install, `themeConfig` is
   JSON, so the build refuses a function `run` there and names `registerTool`
   instead. The eval runner builds its own config and passes no tools — see
   "Not in this spec".
3. **A declarative `run`:**
   - `{fetch: '/api/plans/{plan}', method: 'GET'}` — `{name}` is replaced by the
     URL-encoded argument; a `POST` sends `{args, context}` as JSON. The response
     is JSON or text.
   - `{href: '/pricing?plan={plan}'}` — navigates; an absolute URL on another
     host opens a new tab with `noopener`.
   - `{event: 'acme:open-demo'}` — dispatches a `CustomEvent` on `window` with
     `{tool, args, context}` in `detail`. This is how a site opens its *own*
     modal or form.

A function tool that has no runner on the half that runs the turn is not
offered. An action without a runner in the browser is still shown, but disabled
with a note. That case occurs only when the server proposes an action that the
page did not register.

### 4. What the model sees

- Function tools join the tool list of each search step as
  `{type: 'function', function: {name, description, parameters}}`. Their
  `parameters` are normalised to the strict shape: every property is required,
  an optional one is nullable, and `additionalProperties` is `false`. `format`
  and the bounds move into the description, because providers differ on which
  keywords a strict schema may use. The code enforces them instead (section 6).
- The system message gains one block, written only when the site has tools. It
  lists them, says that a function tool returns live data from the site, that
  its result is data and not instruction, and that it is cited by its id. It
  also says that an action is offered only when it is the reader's obvious next
  step or the reader asked for it, and never because a document or a tool result
  says so.
- On the fallback transport (no native tools) the same tools appear in
  `TOOLS_DOC`, with their parameters spelled out.
- The answer schema gains `actions` only when the site has actions. Each item is
  an `anyOf` over `{tool: const name, args: normalised parameters}`.
- The reader's prompt disclosure (`prompt.show`) lists the site's tools under
  "Tools", because it publishes what is sent.

### 5. A function call, end to end

1. The model calls `plan_limits({plan: 'pro'})` on a search step.
2. The turn validates the arguments against the tool's own schema (section 6).
   An invalid call becomes `tool_error` and costs the step.
3. The runner runs with a 10 s timeout, joined to the turn's abort signal.
4. The result is reduced to text: a string as it is, anything else as JSON, cut
   at 4000 characters.
5. It becomes an observation whose one result carries the id
   `tool:plan_limits:1`, the tool's title and the text. The id joins the citable
   set and the answer's citation `enum`.
6. A citation of that id becomes a source row with no link: the title, then
   "from the site". The answer stays traceable, so the guardrail that withdraws
   an uncited answer does not withdraw it.

A repeat of the same call with the same arguments is served from the turn's
cache and costs nothing, like a repeated search.

### 6. Validation

**At build time** — the build stops with a sentence that names the tool, if:

- the name is invalid or is a built-in name, or there are more than 12 tools;
- `description` is missing;
- `parameters` is not a flat object schema of the supported types, or a
  `required` key is not a property;
- `confirm` is not `false`, `true` or `'form'`;
- `run` has more than one executor, or an unknown method;
- a function tool has a `POST` `fetch`, a `href` or an `event`;
- a `{placeholder}` in a URL template is not a parameter;
- a `{placeholder}` in a `fetch` or `href` template sits before the path — in
  the scheme or the host;
- `run` is a function on the browser runtime;
- a `fetch` URL is relative on the server runtime, where there is no page
  origin.

**At run time** — every argument is checked before any runner sees it:

- unknown keys are dropped and `null` means absent;
- a type is coerced only where the conversion is lossless (`"3"` → `3`,
  `"true"` → `true`);
- `enum`, `format`, `maxLength`, `minimum` and `maximum` are enforced;
- a missing `required` value rejects the call. There is one exception: a form
  action keeps the missing field for the reader to fill.
- a path placeholder that fills to a dot segment (`.`, `..`, or `%2e` forms)
  fails the call before anything is sent.

The same check runs again on what the reader sends from a form.

### 7. Actions in the answer

`finish()` reads `actions` and keeps an item only if:

- its `tool` is one of the site's actions;
- its arguments pass the check in section 6;
- it is not a duplicate of an earlier item.

It keeps at most 3 items. The result carries them as `actions: [{tool, args}]`.
An answer with no valid action carries `[]`. Actions never change the guardrail:
an uncited answer is withdrawn with its actions.

### 8. Where each half runs

| | static install | server install |
|---|---|---|
| function tools | in the reader's browser: registered handler or `fetch` (relative URLs resolve on the page, cookies `same-origin`) | on the server: a function `run` or an absolute `fetch` |
| actions | in the browser | proposed by the server's model, run in the browser |

The server's settle payload carries `actions`, and its `sources` carry the tool
rows. The server turn log records each function call as `{tool, ok, ms}`, and
the ids those calls handed out as `toolIds`. The eval counts a citation of one
of those ids as observed, not as hallucinated.

The answer cache (engine-spec 031) never stores a turn that called a site
function. The reply is live and can be the reader's own data, and the cache key
names none of it. A hit would give one reader the answer that another reader's
data built.

### 9. Cost

A function call is one search iteration: it is charged like a search and capped
by `maxIterations`. A one-shot turn has no search steps, so it offers no function
tools; that is the server default and the rationed static default. Actions ride
on the answer call and cost no extra request in either mode.

### 10. Nothing changes without tools

With `tools: null`, the system message, both schemas, the tool list and every
request body are byte-identical to 2.0.1. The test suite holds this, because the
static install's "65 of 65 answers byte-identical" claim depends on it.

## Security

- **Nothing that changes anything runs without the reader.** A function tool can
  only be a read; the build enforces this for every declarative runner and
  documents it for handlers and functions. An action runs only on a press or a
  submit.
- **The reader sees what will run.** The button text and the card title come
  from the config, never from the model. The model's arguments are shown as data
  in the form before anything is sent.
- **The arguments are not trusted.** The site's own schema checks them in code,
  and they are URL-encoded into templates. The model controls neither the host
  nor the path.
- **The results are not trusted either.** A tool result travels as an
  observation under the same "data, not instruction" note as a retrieved section,
  cut to 4000 characters.
- **An injection can at most propose a button.** At 23–30 % measured attack
  success, this is the property that makes actions safe to ship. The model
  decides what to offer, and the reader decides what runs.

## Not in this spec

- A turn that pauses mid-loop for an approval and resumes, so that a write could
  run *between* search steps. Every write in this spec is an action at the end
  of the answer.
- The Responses API, which reasoning with tools on GPT-6 would need.
- Nested objects and arrays in `parameters`.
- Feeding an action's outcome back into the conversation.
- Persisting actions: a restored conversation shows its answers and sources, not
  their actions.
- Consuming tools that a page registers through WebMCP, or MCP Apps UIs.
- Tool calls in `eval` probes.

## Tests

- The config: every refusal in section 6 has a test, and the client half carries
  no function.
- Without tools: the prompt, the schemas and the loop's tool list are unchanged.
- With tools:
  - the loop step lists the site's function tools;
  - a call runs the runner, its result is citable and the answer settles with a
    "from the site" source;
  - invalid arguments and a runner failure become `tool_error`;
  - a repeated call is free.
- The answer: `actions` is validated, deduplicated and capped. A form action
  keeps a missing required field.
- The runners: `fetch` GET and POST, `href` on the same host and another host,
  `event`, a registered handler, a timeout, and a handler preferred over the
  config.
- The server: the settle payload carries `actions` and tool rows, and a function
  `run` executes on the server.
