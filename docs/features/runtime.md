---
description: The same chat, run in one of two places — in the reader's browser against a static index, or on your server — what travels on each wire, what each install makes public, and how to choose.
---

# Static or server

A turn runs in one of two places. In the **static** install the reader's browser downloads the index and does the work; your server only attaches the model key. In the **server** install the browser sends the question and draws the stream; the index, the prompt and the key stay with you. The reader sees the same chat in both. Press an install to see what travels on each wire.

<Demo>
  <RuntimeDemo />
  <template #code>

```ts
// static — the default: the index ships with the site
docPilot: { runtime: 'browser' }

// server — the turn runs on your server
docPilot: {
  runtime: 'server',
  server: { endpoint: '/ai/turn' },
}
```

  </template>
</Demo>

## How to choose {#choose}

Ask three questions. One "yes" is enough for the server install.

| question | if yes |
|---|---|
| Must the corpus, the prompt or the thresholds stay off the page? | server |
| Do you need rate limits, a daily cap or metrics without writing proxy rules? | server |
| Do you want a turn log to feed `traffic` and `dataset`? | server |

Three "no" answers mean the static install: public pages, nothing extra to run and keep. `npx docpilot init` asks the same thing as *Where should a question be answered?* and prints the block to paste for either answer.

## What changes between them

| | static | server |
|---|---|---|
| the turn runs in | the reader's browser | `@cloflin/docpilot/server` |
| the page downloads | the index, the prompt, the thresholds | the page list, cited passages, the stream |
| you run | nothing new — the `/ai` proxy forwards model calls | `npx docpilot serve` or `createDocPilotServer` |
| limits and metrics | yours, in the proxy | built in, on by default |
| follow-up chips | yes | no |

The server install keeps the index from being downloaded in bulk. It does not make the content secret: a reader can still read every passage an answer cites.

## Change later

Both installs read the same index, built by the same `npx docpilot index`, so the switch is one setting. Score the same golden set through each before you switch:

```bash
npx docpilot eval --runtime=browser --quiet
npx docpilot eval --runtime=server --quiet
```

Moving to the server install also means: stop publishing the index, put the server behind the proxy that serves the site, and set `DOCPILOT_SERVER_SECRET` and `DOCPILOT_METRICS_TOKEN`.

More: [Choose your install](/install/choose) for the full comparison, [The server runtime](/guide/server) to set it up, and [Server operations](/guide/server-operations) for limits and metrics.
