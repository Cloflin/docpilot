---
description: Give the panel your own tools — live data the answer cites, and next steps the reader runs with one press. Off by default.
---

# Tools and actions

Your documentation answers what is written down. Tools answer what is *live* — a plan's limits, an API's status, the reader's own account — and actions take the *next step*: open the pricing calculator, write to support, book a demo. Both are off until you add a `tools` key, and without one every request is the one DocPilot always sent.

<Demo>
  <ToolsDemo />
  <template #code>

```ts
docPilot: {
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
      label: 'Write to support',
      description: 'Send the question to the support team when the docs do not answer it.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email', description: 'Where support replies' },
          message: { type: 'string', format: 'multiline', description: 'The problem' },
        },
        required: ['email', 'message'],
      },
      confirm: 'form',
      run: { fetch: '/api/support', method: 'POST' },
    },
  },
}
```

  </template>
</Demo>

## Two kinds

`confirm` decides which one a tool is.

| `confirm` | kind | who runs it | what the reader sees |
|---|---|---|---|
| `false` (default) | **function tool** | the model calls it while it searches, and DocPilot runs it at once | "Checking Plan limits", then a source row **from the site** under the answer |
| `true` | **action** | the reader, with one press | a button under the answer, with your `label` |
| `'form'` | **action** | the reader, after reviewing the arguments | a button that opens a form with the model's suggestions filled in |

A function tool must only *read*. The build stops on a function tool that would `POST`, navigate or fire an event, because none of those can answer the model and each of them changes something without the reader. Make it an action instead.

## A function tool

```ts
plan_limits: {
  description: 'Live limits of one plan: requests per day, seats and storage.',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', enum: ['free', 'pro', 'team'] } },
    required: ['plan'],
  },
  run: { fetch: '/api/plans/{plan}' },
}
```

On a question that needs it:

1. The model calls `plan_limits({plan: 'pro'})` on a search step, next to the built-in `search_docs`.
2. DocPilot checks the arguments against your schema. A call that fails the check never runs, and the model is told why.
3. The tool runs, with a 10-second limit: here, a `GET` to `/api/plans/pro`.
4. The model receives the reply as data, with an id it can cite. The model sees up to 4,000 characters of it.
5. The answer cites the reply like a page, and the source row reads **Plan limits · from the site**. A cited answer stays on screen. An answer with no citation is withdrawn, as before.

The same call with the same arguments a second time in a turn is answered from the first and costs nothing.

## An action

```ts
open_pricing: {
  description: 'Open the pricing page for one plan.',
  label: 'Open pricing',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', enum: ['free', 'pro', 'team'] } },
    required: ['plan'],
  },
  confirm: true,
  run: { href: '/pricing?plan={plan}' },
}
```

The model never runs an action. It may offer up to three with its answer, each with arguments it took from the conversation, and the reader decides:

- **A button** (`confirm: true`) shows your `label`, and on a second line the model's arguments, such as "With plan: pro", because "Open pricing" for the wrong plan is a different action. The arguments are part of the button's name, so a screen reader reads them too.
- **A form** (`confirm: 'form'`) opens under the answer. It has one field per parameter, labelled with the parameter's `description`, and the model's suggestions are filled in. The reader can change any value. DocPilot checks what the reader sends against your schema before anything is sent.
- **The outcome** appears where the button was. It is your endpoint's own words when the reply is a string or has a `message` field, and **Done.** otherwise. If the action fails, the button comes back so the reader can try again.

The model offers an action only when it is the obvious next step for the question, or when the reader asked for it. A document or a tool result that tells the model to offer one is ignored. A restored conversation shows its answers without their actions, so yesterday's "Contact support" cannot be sent twice by accident.

## What runs a tool

DocPilot asks three places, in this order:

1. **A handler you register in the page.** It wins over the config, so you can replace a `fetch` with code without touching the definition.
2. **A function in the config.** This works only on a [server install](#on-a-server-install), where the config is never sent to a browser.
3. **The declarative `run`:**
   - `{fetch: '/api/plans/{plan}'}`. Each `{name}` is replaced by that argument, URL-encoded. A placeholder goes in the path or the query, never in the scheme or the host, and an argument that would make a `.` or `..` path segment fails the call before anything is sent. A `GET` sends nothing else. A `POST` sends `{tool, args, context: {question, page}}` as JSON. A JSON reply is parsed, and any other reply is read as text.
   - `{href: '/pricing?plan={plan}'}`. A link to your own host opens in place. A link to another host opens in a new tab without `window.opener`.
   - `{event: 'acme:open-demo'}`. DocPilot dispatches a `CustomEvent` on `window` with `{tool, args, context}` in `detail`. This is the way to open **your own** modal or form.

```js [docs/.vitepress/theme/index.js]
import DefaultTheme from 'vitepress/theme'
import { withDocPilot, registerTool } from '@cloflin/docpilot/theme'

if (typeof window !== 'undefined') {
  registerTool('plan_limits', async ({ plan }, { signal }) => {
    const res = await fetch(`/api/plans/${plan}`, { signal })
    return res.json()
  })
  window.addEventListener('acme:open-demo', (e) => openDemoModal(e.detail.args))
}

export default withDocPilot(DefaultTheme)
```

`registerTool` is exported from `@cloflin/docpilot/theme`, `/vue`, `/react`, `/mount` and `/web`. A `<script>`-tag install has it as `window.DocPilot.registerTool`. It returns a function that removes the handler again. A handler receives the checked arguments and `{question, page, signal}`, and whatever it returns is the tool's result.

A function `run` cannot reach a static page, because `themeConfig` is JSON. The build stops on one, and the message names `registerTool` instead.

## Writing a tool the model uses well

The model chooses a tool by its `description` and fills it by its `parameters`. The rules that make it choose well are the ones OpenAI and Anthropic publish for function calling:

- **Say when to use it, and when not to.** "Live limits of one plan. Use it for a question about current limits; the pricing page covers what each plan includes." A description that says only "Gets plan limits" leaves the model to guess when it applies.
- **Use `enum` for every closed set.** `plan: {enum: ['free', 'pro', 'team']}` cannot be called with `'premium'`.
- **Do not ask for what your code already knows.** The page and the question reach your handler, and a same-origin `fetch` carries the reader's cookies. A parameter for any of them is a value the model can get wrong.
- **One tool per question it answers.** If two tools are always called one after the other, make them one.
- **Keep the set small.** Twelve is the ceiling. A handful the model can tell apart works better than twelve it confuses.
- **Return what the answer needs.** The reply goes to the model and to your model provider. A short JSON object with the numbers the answer will quote is better than a whole account record.

## Parameters

`parameters` is a flat JSON Schema object. Each property is a `string`, `number`, `integer` or `boolean`, with these optional keys:

| key | for | what it does |
|---|---|---|
| `description` | every type | tells the model what the value is, and labels the form field |
| `enum` | every type | the allowed values; a form shows them as buttons |
| `default` | every type | the value an empty field takes; the model is told it, and a form starts from it. The build refuses a default that the parameter itself would refuse |
| `format` | `string` | `email`, `uri` or `date` set the input type; `multiline` asks for a text area |
| `maxLength` | `string` | the longest allowed value |
| `minimum`, `maximum` | `number`, `integer` | the allowed range |

`required` lists the values a call must have. A form action is the one exception: the reader can supply a missing required value in the form. DocPilot sends the model a strict version of the schema, in which every property is required and an optional one may be `null`. DocPilot enforces `enum`, `format` and the bounds in code, because providers disagree on which of those keywords a strict schema may carry. Nested objects and arrays are not supported yet.

## On a server install

| | static install | server install |
|---|---|---|
| function tools | run in the reader's browser: a registered handler, or a `fetch` that resolves on your page and carries its cookies | run on your server: a function `run`, or a `fetch` to an absolute URL |
| actions | run in the browser | proposed by the server, run in the browser |

The page receives only the actions, without their descriptions, because the descriptions are written for the model. The server's turn log records each function call as `{tool, ok, ms}`, never its arguments or its reply. The server's default turn is one-shot and has no search step, so a function tool needs `server.turn.loop: 'agentic'` there.

## What it costs

- A function call is one search step. It is charged like a search and capped by [`maxIterations`](/reference/config#maxiterations). A turn that runs one-shot, which is the default on a server and on a nearly spent free tier, offers no function tools.
- Actions ride on the answer call and cost no extra request in either mode.
- Models without native tool calling get the tools as text, in the same protocol as the built-in ones. gpt-6-luna takes function tools only with reasoning off, and DocPilot sends that on search steps by itself.

## Not yet

- **An approval in the middle of a search.** Every write is an action at the end of an answer. A turn does not pause for the reader and then continue.
- **Nested parameters.** A parameter is a string, a number, an integer or a boolean.
- **Reasoning together with tools on GPT-6.** That needs the Responses API, which DocPilot does not use yet. Search steps run with reasoning off.
- **Measuring your tools.** `docpilot eval` runs its probes without them.
- **Keeping actions.** A restored conversation shows its answers and sources, not their actions.

## Safety

- **Nothing that changes anything runs without the reader.** A function tool can only read, and an action needs a press or a sent form.
- **Every word on a button is yours.** The model chooses which action to offer and with which values. The text on the button is your `label`.
- **The arguments are checked in code** against your schema, and they are URL-encoded into a template. The build refuses a placeholder in the scheme or the host, and an argument that makes a `.` or `..` segment fails the call, so the model controls neither the host nor the path.
- **A tool's reply is data, not instruction.** It reaches the model under the same rule as a documentation section, cut to 4,000 characters.
- **A page that tries to steer the model can at most propose a button.** DocPilot's own [security bench](/guide/benchmarks) measured 23–30 % success for planted instructions. That is why a model never decides alone what runs.

The design and its research are in [engine-spec 038](https://github.com/Cloflin/docpilot/blob/main/engine-specs/038-tools-the-site-adds.md) and [ui-spec 018](https://github.com/Cloflin/docpilot/blob/main/ui-specs/018-actions-the-answer-offers.md). Every key is in the [configuration reference](/reference/config#tools).
