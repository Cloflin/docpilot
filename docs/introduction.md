---
title: Introduction
description: An AI chat assistant you embed on any website. It answers from your own pages, cites every claim, and runs either in the reader's browser or on your server.
---

<script setup>
const features = [
  { title: 'Triggers and layout', body: 'A question bar, a navbar icon, ⌘I, or a link under each article.', link: '/features/triggers' },
  { title: 'Search scope', body: 'All docs, this page, this section, or hand-picked pages.', link: '/features/scope' },
  { title: 'Sources and passages', body: 'Every claim is numbered. Open a source to read the exact passage.', link: '/features/sources' },
  { title: 'Ask about a selection', body: 'Select text on the page or in an answer, press Ask AI.', link: '/features/quote' },
  { title: 'Copy, retry, edit', body: 'Copy an answer with its sources, ask again, or edit the question.', link: '/features/actions' },
  { title: 'Conversation history', body: 'Past threads stay in localStorage, on the reader’s device.', link: '/features/history' },
  { title: 'Conversation memory', body: 'The last answer goes to the model whole, older ones as summaries.', link: '/features/memory' },
  { title: 'Model fallback', body: 'A 429 or an outage moves the question to the next model.', link: '/features/fallback' },
  { title: 'Tools and actions', body: 'Live data the answer cites, and next steps the reader runs with one press.', link: '/features/tools' },
  { title: 'Every language', body: 'The panel follows the page language; the model answers in the reader’s.', link: '/features/i18n' },
]
</script>

# Introduction

**DocPilot is an AI chat assistant you embed on a website.** Put it on a documentation site, a landing page, a help centre or an app you already ship. It answers from your own pages, numbers every claim with a link to its source, and says so when your pages do not cover the question.

**Choose first where a turn runs.** In the **static install**, the default, the reader's browser downloads the index and runs the search, the gate and the prompt, and your server only attaches the model key. In the **server install** (`runtime: 'server'`), the turn runs on your server: the index, the prompt, the thresholds and the keys stay there, and the page receives a stream. The reader sees the same chat in both.

Use static if your pages are public and you want nothing extra to run. Use server if the corpus or the prompt must stay private, or you need rate limits and metrics. [Choose your install](/install/choose) has the comparison.

It mounts on any platform: [VitePress](/install/vitepress), [Docusaurus](/install/docusaurus), [Vue](/install/vue), [React](/install/react), plain [JavaScript or TypeScript](/install/javascript), or one [`<script>` tag](/install/web) on any HTML page. The config, the index and the commands are the same on all of them.

```sh
npm i @cloflin/docpilot
npx docpilot init
```

## Built on current technology

- **Hybrid search in the browser.** BM25 word matching and embedding similarity, fused by reciprocal rank. No vector database, no search service.
- **1-bit vectors.** One sign bit per dimension: the index is small enough to download on the first question.
- **An agent, not a template.** The model calls tools — search, read a section, list pages — then answers through a typed `answer` call that the browser validates.
- **Streaming everywhere.** Answers type in as server-sent events; reasoning models show their thinking.
- **Any model.** 15 providers — OpenAI, Anthropic, Gemini, Mistral, DeepSeek, OpenRouter and others — or a local model through Ollama.
- **Modern packaging.** ESM-only TypeScript, a Vite plugin, Node 20 or newer, MIT licence.

## From your pages to answers

The index is built once, at deploy time, by a CLI. Then you measure it and improve it with the same CLI. Press a step to see what it reads and writes.

<Pipeline3D />

The first three steps are enough to ship. The rest is how the assistant gets better: `eval` tells you which questions it gets wrong, `improve` names the edit for each, `tune` and new pages fix them, and `feedback pull` turns your readers' thumbs-down into the next set of test questions. [Measure](/guide/measure) explains the numbers, and [Improve answers](/guide/improving) the loop. Every command is in the [CLI reference](/reference/cli).

## RAG, in plain words

RAG — *retrieval-augmented generation* — means the model does not answer from memory. It answers from passages that a search found in your content a second earlier.

1. **At build time**, every page is cut into chunks of 350–500 tokens, split at its headings. Each chunk becomes a vector: a list of numbers that places its meaning in space.
2. **When a reader asks**, the question becomes a vector too. The browser finds the chunks closest to it, and the chunks that share its words, and merges both lists.
3. **The model gets the question plus those passages**, and an instruction to use nothing else and to cite each claim.
4. **The browser checks the answer.** A citation that points at a passage nobody retrieved is removed, and so is a link to a page that does not exist.

In the static install, steps 1 and 2 run without a server, so the only thing your server does is forward the model call. In the server install, your server runs all four. See [Security](/guide/security) for what each install makes public.

## How small the index is

An embedding model returns 4,096 numbers per chunk, each a 32-bit float. DocPilot keeps one bit of each: its sign. This site's own index is 418 KB for 835 chunks at 4096 dimensions — the whole documentation you are reading.

<Compression />

The bit costs almost nothing in quality. Measured on this corpus, the average error in similarity is under 0.01, and the build refuses to write an index whose error passes 0.03. If your embedder does not survive the bit, `--quantize=auto` falls back to one byte per dimension. The details are in [Building the index](/guide/indexing#vectors-are-quantised).

## What it costs

DocPilot is MIT-licensed: no plan, no seat, no per-answer fee. You pay your model provider for tokens, and nothing else.

A question on this site uses about 5.9k input and 0.7k output tokens. With the model this site runs, **1,000 questions cost about $0.66**. Building the index costs a fraction of a cent, and a rebuild only re-embeds the chunks that changed.

<CostCalc />

Prices are OpenRouter list prices from October 2026. The measurement behind the token counts, and what makes them grow, is in [What it costs](/guide/what-it-costs).

## What the reader gets

Each feature has its own page with a live mock-up and the config that turns it on.

<Cards :items="features" />

## Where to go next

- [Choose your install](/install/choose) — static or server, and what each makes public.
- [Quick start](/guide/) — running on VitePress in ten minutes.
- [Install](/install/) — the entry point for every other platform.
- [Measure](/guide/measure) and [Improve answers](/guide/improving) — score the assistant, then fix what it gets wrong.
- [Security](/guide/security) — the threat model of each install.
- [Configuration](/reference/config) — every option, with its default.
